// The try-it panel: this page acts as a runtime with one unit for one visit. It pairs a phone through the real relay,
// sends three calls whose cards close without a model (choice, slider, checklist, the same as in the runtime), and
// shows what each call returns. The link lives in this tab only; the relay forwards encrypted frames and deletes the
// trial channel within the hour.
import { RELAY_PROTOCOL, base64url, randomId, relayKeys, relayUrl, useRelaySocket } from "./relay-wire.mjs";
import { qrSvg } from "./qr.js";

const RELAY = /^(127\.0\.0\.1|localhost)$/.test(location.hostname) ? "http://127.0.0.1:7390" : "https://unit.humanuse.dev";
const UNIT = "trial";
const CALLS = [
  { tool: "choose", kind: "choice", args: { question: "Is it light or dark outside right now?", options: ["Light", "Dark", "Can't tell from here"] },
    line: a => `CHOOSE ${a.question}` },
  { tool: "mood", kind: "slider", args: {}, line: () => "MOOD 1–5" },
  { tool: "checklist", kind: "checklist", args: { title: "Desk", steps: ["Water within reach", "Phone charging", "Next break in the calendar"] },
    line: a => `CHECKLIST ${a.title}` }
];

const $ = id => document.getElementById(id);
const panel = $("try");
const jobId = () => "j_" + [...crypto.getRandomValues(new Uint8Array(5))].map(byte => byte.toString(16).padStart(2, "0")).join("");
const secret = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

function status(text, hot) {
  $("ty-st").textContent = text;
  $("ty-st").classList.toggle("sig", !!hot);
}

/** A return line: the whole job view, with its result picked out. */
function logLine(className, mark, text, time, result) {
  const item = document.createElement("li");
  item.className = className;
  const dir = document.createElement("span");
  dir.className = "d";
  dir.textContent = mark;
  item.append(dir);
  if (time) {
    const at = document.createElement("span");
    at.className = "t";
    at.textContent = time;
    item.append(at);
  }
  const code = document.createElement("code");
  code.textContent = text;
  if (result) {
    const at = text.lastIndexOf(result);
    const bold = document.createElement("b");
    bold.textContent = result;
    code.replaceChildren(text.slice(0, at), bold, text.slice(at + result.length));
  }
  item.append(code);
  $("ty-log").append(item);
  $("ty-log").scrollTop = $("ty-log").scrollHeight;
}

/** What the structured kinds close with in the runtime (Runtime.structured). */
function result(call, answer) {
  if (call.kind === "choice") return typeof answer.choice === "string" && call.args.options.includes(answer.choice) ? { choice: answer.choice } : null;
  if (call.kind === "slider") return typeof answer.value === "number" ? { value: answer.value } : null;
  const checked = Array.isArray(answer.checked) ? answer.checked : [];
  const steps = call.args.steps;
  return { done: checked.length === steps.length, checked: steps.filter((_, i) => checked.includes(i)), missed: steps.filter((_, i) => !checked.includes(i)) };
}

let session = null;

async function start() {
  const mine = {};
  session = mine;
  $("ty-log").replaceChildren();
  $("side").classList.remove("live");
  $("ty-again").hidden = true;
  status("connecting");
  const channel = randomId();
  const pairing = secret();
  const keys = await relayKeys(channel, pairing, "runtime", secret());
  const link = `${RELAY}/#${channel}.${pairing}.try`;
  try {
    const response = await fetch(new URL(`/channel/${channel}/register`, RELAY), {
      method: "POST",
      headers: { Authorization: `Bearer ${keys.token}`, "X-Human-Use-Phone": keys.phoneTokenHash, "X-Human-Use-Trial": "1" }
    });
    if (!response.ok) throw new Error(`register ${response.status}`);
  } catch {
    if (session === mine) { status("relay unreachable", true); $("ty-again").hidden = false; }
    return;
  }
  if (session !== mine) return;
  $("ty-qr").innerHTML = qrSvg(link);
  $("ty-open").href = link;
  $("ty-copy").dataset.link = link;

  let version = 1;
  let step = -1;
  let card = null;
  let sentAt = 0;
  const reports = [];
  const polls = new Set();
  let phoneSeen = false;
  let finished = false;
  const bump = () => { version++; for (const wake of [...polls]) wake(); };
  const state = () => ({ v: version, unit: UNIT, card, stacked: 0, theater: [], reports, notice: null, queued: 0, review: 0 });

  const call = () => {
    step++;
    const spec = CALLS[step];
    const job = jobId();
    const args = { ...spec.args, wait: "done" };
    logLine("c", "→", `${spec.tool} ${JSON.stringify(args)}`);
    const shownAt = new Date().toISOString();
    card = { job_id: job, unit: UNIT, tool: spec.tool, title: `human.${spec.tool}`, kind: spec.kind, text: spec.line(spec.args), task: spec.line(spec.args),
      round: 1, priority: "normal", shown_at: shownAt, due_at: null, options: spec.args.options, steps: spec.args.steps };
    sentAt = performance.now();
    bump();
  };

  const retire = async () => {
    finished = true;
    try {
      await fetch(new URL(`/channel/${channel}/retire`, RELAY), { method: "POST", headers: { Authorization: `Bearer ${keys.token}` } });
    } catch { /* the relay deletes trial channels on its own */ }
    socket.close(1000, "trial over");
  };

  const answer = payload => {
    if (!card || !payload || payload.job_id !== card.job_id || payload.round !== card.round) return { error: "NOT_OPEN" };
    if (!payload.answer || typeof payload.answer !== "object" || Array.isArray(payload.answer)) return { error: "REJECTED" };
    const spec = CALLS[step];
    const out = result(spec, payload.answer);
    if (!out) return { error: "REJECTED" };
    const seconds = ((performance.now() - sentAt) / 1000).toFixed(1) + " s";
    const view = { job: card.job_id, tool: spec.tool, state: "done", goal: null, unit: UNIT, task: card.text, send_at: null, shown_ago_s: null, rounds: 1, result: out };
    logLine("r", "←", JSON.stringify(view), seconds, `"result":${JSON.stringify(out)}`);
    reports.push({ job_id: card.job_id, unit: UNIT, round: 1, at: new Date().toISOString(), result: out });
    card = null;
    if (step + 1 < CALLS.length) call();
    else {
      bump();
      status("3 calls, 3 results");
      $("ty-again").hidden = false;
      // Long enough for the phone to show the last report before the link closes.
      setTimeout(() => { if (session === mine) void retire(); }, 6000);
    }
    return { ok: true };
  };

  const handle = async (packet, send) => {
    if (!packet || typeof packet !== "object" || typeof packet.id !== "string") return;
    let body = { error: "INVALID_REQUEST" };
    if (packet.method === "state") {
      if (!phoneSeen) {
        phoneSeen = true;
        status("phone connected");
        $("side").classList.add("live");
        if (step < 0) call();
      }
      const asked = typeof packet.version === "number" ? packet.version : 0;
      if (asked === version) {
        await new Promise(resolve => {
          const wake = () => { clearTimeout(timer); polls.delete(wake); resolve(); };
          const timer = setTimeout(wake, 25_000);
          polls.add(wake);
        });
      }
      body = state();
    } else if (packet.method === "answer") {
      body = answer(packet.payload);
    } else if (packet.method === "unpair") {
      body = { ok: true };
      setTimeout(() => void retire(), 200);
    } else if (packet.method === "push_key") {
      body = { error: "NO_PUSH" };
    }
    if (socket.readyState === 1) await send({ id: packet.id, body }).catch(() => {});
  };

  const socket = new WebSocket(relayUrl(RELAY, channel, "runtime"), [RELAY_PROTOCOL, `auth.${keys.token}`]);
  const send = useRelaySocket(socket, keys, packet => void handle(packet, send));
  socket.addEventListener("open", () => { if (session === mine) status("waiting for a phone"); });
  socket.addEventListener("close", () => {
    for (const wake of [...polls]) wake();
    if (session !== mine) return;
    status(finished ? "link closed" : "relay offline", !finished);
    $("ty-again").hidden = false;
  });
  mine.close = () => { finished = true; socket.close(1000, "restart"); };
}

// Already on a phone: the cards open in a new tab of this phone, and a second phone can still scan the code.
if (matchMedia("(pointer: coarse)").matches) {
  $("ty-how").textContent = "Open here prints three cards in a new tab. Each answer comes back to this page as JSON.";
}
/** Resolves true only when the text reached the clipboard. */
function copyText(text) {
  const legacy = () => {
    const area = Object.assign(document.createElement("textarea"), { value: text, readOnly: true });
    area.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { /* not supported */ }
    area.remove();
    return ok;
  };
  return navigator.clipboard ? navigator.clipboard.writeText(text).then(() => true, legacy) : Promise.resolve(legacy());
}
$("ty-again").addEventListener("click", () => { session?.close?.(); void start(); });
$("ty-copy").addEventListener("click", () => {
  const button = $("ty-copy");
  if (!button.dataset.link) return;
  const done = ok => { button.textContent = ok ? "Copied" : "Copy failed"; setTimeout(() => { button.textContent = "Copy link"; }, 1600); };
  copyText(button.dataset.link).then(done);
});
const seen = new IntersectionObserver(entries => {
  if (!entries.some(entry => entry.isIntersecting)) return;
  seen.disconnect();
  void start();
});
seen.observe(panel);
