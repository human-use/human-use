import { CHANNEL_PATTERN, RELAY_PROTOCOL, SECRET_PATTERN, randomId, relayKeys, relayUrl, useRelaySocket } from "./relay-wire.mjs";

const STORAGE_KEY = "human-use-relay-pairing-v1";

function identity() {
  const link = location.hash.slice(1);
  let saved = "";
  try { saved = localStorage.getItem(STORAGE_KEY) ?? ""; } catch { /* private mode */ }
  const found = link || saved;
  const [channel, secret, extra] = found.split(".");
  // A link ending in .try comes from the try-it panel on humanuse.dev: it lasts one visit, so it never replaces a saved pairing.
  const trial = extra === "try";
  if ((extra !== undefined && !trial) || !CHANNEL_PATTERN.test(channel ?? "") || !SECRET_PATTERN.test(secret ?? "")) return null;
  if (link && !trial) {
    try {
      localStorage.setItem(STORAGE_KEY, link);
      history.replaceState(null, "", location.pathname + location.search);
    } catch { /* the fragment still allows this tab to reconnect */ }
  }
  return { channel, secret, trial };
}

export async function openPhoneRelay() {
  const pair = identity();
  if (!pair) return null;
  const keys = await relayKeys(pair.channel, pair.secret, "phone");
  const url = relayUrl(location.origin, pair.channel, "phone");
  let opening;
  let replaced = false;
  let retired = false;
  const replacement = () => Object.assign(new Error("Another phone page is connected"), { relayReplaced: true });
  const retirement = () => Object.assign(new Error("This link was replaced"), { relayRetired: true });
  const forget = () => {
    // Only this link; another tab may already hold the new one.
    try { if (localStorage.getItem(STORAGE_KEY) === `${pair.channel}.${pair.secret}`) localStorage.removeItem(STORAGE_KEY); } catch { /* private mode */ }
  };

  function connect() {
    if (retired) return Promise.reject(retirement());
    if (replaced) return Promise.reject(replacement());
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      const socket = new WebSocket(url, [RELAY_PROTOCOL, `auth.${keys.token}`]);
      const pending = new Map();
      const connection = { socket, pending, firstState: true, send: useRelaySocket(socket, keys, packet => {
        if (!packet || typeof packet.id !== "string" || !Object.hasOwn(packet, "body")) return;
        pending.get(packet.id)?.resolve(packet.body);
      }) };
      const deadline = setTimeout(() => { socket.close(); reject(new Error("Relay connection timed out")); }, 8000);
      socket.addEventListener("open", () => { clearTimeout(deadline); resolve(connection); }, { once: true });
      socket.addEventListener("close", event => {
        clearTimeout(deadline);
        replaced = event.code === 4001;
        retired = event.code === 4003;
        if (retired) forget();
        opening = undefined;
        const error = retired ? retirement() : replaced ? replacement() : new Error("Relay disconnected");
        reject(error);
        for (const waiter of pending.values()) waiter.reject(error);
        pending.clear();
      }, { once: true });
    });
    return opening;
  }

  return {
    trial: pair.trial,
    forget,
    async request(path, body) {
      const connection = await connect();
      const id = randomId();
      let request;
      if (path.startsWith("/api/state?")) {
        const version = Number(new URL(path, location.origin).searchParams.get("v"));
        request = { id, method: "state", version: connection.firstState || !Number.isFinite(version) ? 0 : version };
        connection.firstState = false;
      } else if (path === "/api/answer") {
        request = { id, method: "answer", payload: body };
      } else if (path === "/api/route") {
        request = { id, method: "route", payload: body };
      } else if (path === "/api/unpair") {
        request = { id, method: "unpair" };
      } else if (path === "/api/push/key") {
        request = { id, method: "push_key" };
      } else if (path === "/api/push/subscription") {
        request = { id, method: "push_subscribe", payload: body };
      } else throw new Error("Unknown relay request");
      return new Promise((resolve, reject) => {
        const drop = () => {
          clearTimeout(timer);
          connection.pending.delete(id);
        };
        const timer = setTimeout(() => {
          drop();
          connection.socket.close();
          reject(new Error("Relay response timed out"));
        }, 35_000);
        const waiter = { resolve: value => { drop(); resolve(value); }, reject: error => { drop(); reject(error); } };
        connection.pending.set(id, waiter);
        connection.send(request).catch(waiter.reject);
      });
    }
  };
}
