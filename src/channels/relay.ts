import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  CHANNEL_PATTERN, RELAY_PROTOCOL, SECRET_PATTERN, randomId, relayKeys, relayUrl, useRelaySocket,
  type RelayKeys
} from "../../assets/relay-wire.mjs";
import type { PhoneChannel } from "./phone.js";
import type { PhonePush } from "./push.js";

interface Identity {
  channel: string;
  secret: string;
  runtimeSecret: string;
}

const newIdentity = (): Identity => ({
  channel: randomId(),
  secret: randomBytes(32).toString("base64url"),
  runtimeSecret: randomBytes(32).toString("base64url")
});

function loadIdentity(path: string): Identity {
  try {
    const created = newIdentity();
    writeFileSync(path, JSON.stringify(created), { mode: 0o600, flag: "wx" });
    return created;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const identity = JSON.parse(readFileSync(path, "utf8")) as Identity;
  if (!CHANNEL_PATTERN.test(identity.channel) || !SECRET_PATTERN.test(identity.secret) || !SECRET_PATTERN.test(identity.runtimeSecret)) {
    throw new Error("Invalid local relay pairing identity");
  }
  return identity;
}

function relayBase(address: string): URL {
  const url = new URL(address);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("HUMAN_USE_RELAY must be an HTTPS origin (HTTP is accepted for local tests)");
  }
  return url;
}

/** An outbound connection to a relay. Card state and answer files live in the local PhoneChannel. */
export class RelayChannel {
  private readonly base: URL;
  private identity: Identity;
  private keys: Promise<RelayKeys & { phoneTokenHash: string }>;
  private readonly lifetime = new AbortController();
  private socket: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private delayMs = 500;
  private registered = false;
  /** Bumped by renew() so a connection attempt still holding the old identity gives up. */
  private generation = 0;

  constructor(address: string, private readonly pairingFile: string, private readonly phone: PhoneChannel, private readonly push: PhonePush) {
    this.base = relayBase(address);
    this.identity = loadIdentity(pairingFile);
    this.keys = relayKeys(this.identity.channel, this.identity.secret, "runtime", this.identity.runtimeSecret);
  }

  /**
   * Replace the phone link. The relay keeps a tombstone for the old channel, so every page holding the old link is
   * told it was replaced and nobody can register that channel again. Returns false when the relay could not be told;
   * the old link is dead locally either way, since this runtime never answers on it again.
   */
  async renew(): Promise<boolean> {
    const old = this.identity;
    const oldKeys = this.keys;
    const fresh = newIdentity();
    writeFileSync(this.pairingFile, JSON.stringify(fresh), { mode: 0o600 });
    this.identity = fresh;
    this.keys = relayKeys(fresh.channel, fresh.secret, "runtime", fresh.runtimeSecret);
    this.generation++;
    this.registered = false;
    const socket = this.socket;
    this.socket = null;
    clearTimeout(this.retry);
    let told = false;
    try {
      const response = await fetch(new URL(`/channel/${old.channel}/retire`, this.base), {
        method: "POST",
        headers: { Authorization: `Bearer ${(await oldKeys).token}` },
        signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(4000)])
      });
      told = response.ok;
    } catch { /* offline: the old channel simply never sees this runtime again */ }
    socket?.close(1000, "link renewed");
    this.delayMs = 500;
    await this.connect();
    return told;
  }

  pairing(): { url: string | null; connected: boolean } {
    const link = new URL(this.base);
    link.hash = `${this.identity.channel}.${this.identity.secret}`;
    return { url: this.registered ? link.href : null, connected: this.socket?.readyState === WebSocket.OPEN };
  }

  start(): void {
    void this.connect();
  }

  stop(): void {
    this.lifetime.abort();
    clearTimeout(this.retry);
    this.socket?.close(1000, "runtime shutdown");
  }

  private async connect(): Promise<void> {
    if (this.lifetime.signal.aborted) return;
    const generation = this.generation;
    const { channel } = this.identity;
    try {
      const keys = await this.keys;
      const registration = await fetch(new URL(`/channel/${channel}/register`, this.base), {
        method: "POST",
        headers: { Authorization: `Bearer ${keys.token}`, "X-Human-Use-Phone": keys.phoneTokenHash },
        signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(4000)])
      });
      if (generation !== this.generation) return;
      if (!registration.ok) throw new Error(`relay registration HTTP ${registration.status}`);
      this.registered = true;
      if (this.lifetime.signal.aborted) return;
      const socket = new WebSocket(relayUrl(this.base, channel, "runtime"), [RELAY_PROTOCOL, `auth.${keys.token}`]);
      this.socket = socket;
      const disconnected = new AbortController();
      const send = useRelaySocket(socket, keys, packet => {
        void this.handle(packet, disconnected.signal, send).catch(() => socket.close(4002, "request failed"));
      });
      socket.addEventListener("open", () => { this.delayMs = 500; }, { once: true });
      socket.addEventListener("close", () => {
        disconnected.abort();
        if (this.socket !== socket) return;   // renew() already replaced this connection
        this.socket = null;
        this.reconnect();
      }, { once: true });
    } catch {
      if (generation === this.generation) this.reconnect();
    }
  }

  private reconnect(): void {
    if (this.lifetime.signal.aborted) return;
    this.retry = setTimeout(() => void this.connect(), this.delayMs);
    this.retry.unref();
    this.delayMs = Math.min(this.delayMs * 2, 15_000);
  }

  private async handle(packet: unknown, signal: AbortSignal, send: (packet: unknown) => Promise<void>): Promise<void> {
    if (!packet || typeof packet !== "object" || signal.aborted) return;
    const { id, method, version, payload } = packet as Record<string, unknown>;
    if (typeof id !== "string" || !CHANNEL_PATTERN.test(id)) return;
    let body: unknown = { error: "INVALID_REQUEST" };
    if (method === "state") {
      body = await this.phone.state(typeof version === "number" ? version : 0, signal);
    } else if (method === "push_key") {
      body = { public_key: this.push.publicKey };
    } else if (method === "unpair") {
      body = this.phone.unpair();
    } else if (method === "push_subscribe") {
      body = this.push.subscribe(payload) ? { ok: true } : { error: "INVALID_SUBSCRIPTION" };
    } else if (method === "route" && payload && typeof payload === "object") {
      body = this.phone.route(payload as Record<string, unknown>);
    } else if (method === "answer" && payload && typeof payload === "object") {
      const response = payload as { job_id?: unknown; round?: unknown; answer?: unknown };
      if (typeof response.round === "number" && Number.isSafeInteger(response.round) && response.round > 0) {
        body = this.phone.submit(response);
      }
    }
    if (!signal.aborted) await send({ id, body });
  }
}
