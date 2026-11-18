import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openPhoneRelay } from "../assets/relay-client.mjs";
import { RELAY_PROTOCOL, FRAME_CHUNK_BYTES, relayKeys, relayUrl, relayWire } from "../assets/relay-wire.mjs";
import { startDaemon } from "../dist/daemon.js";
import { callTool } from "../dist/tools.js";

const address = process.argv[2] ?? "http://127.0.0.1:7390";
const base = new URL(address);
if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) throw new Error("Use a local Wrangler relay for this check");
const root = mkdtempSync(join(tmpdir(), "human-use-relay-check-"));
const db = join(root, "runtime.sqlite");
const driver = {
  async run({ event }) {
    return event === "start" ? [{ type: "card", text: "[DISPENSING MOOD BOOST... 1.0s]", variant: "flower", seconds: 1 }]
      : [{ type: "complete", result: { done: true } }];
  }
};
const pushes = [];
const launch = () => startDaemon({ port: 0, web: false, db, relay: base.href, telegramToken: "", brain: null, driver, lang: "en",
  pushSend: async (subscription, payload, options) => { pushes.push({ subscription, payload, options }); } });
const onceReady = async runtime => {
  for (let i = 0; i < 60; i++) {
    const pair = runtime.units.pairing(runtime.runtime.unit().id);
    if (pair.relay_connected && pair.relay_url) return pair.relay_url;
    await delay(100);
  }
  throw new Error("Runtime did not connect to the local relay");
};

let runtime;
try {
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<html[^>]+data-relay/);
  const policy = page.headers.get("content-security-policy") ?? "";
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /script-src 'self' 'sha256-[A-Za-z0-9+/=]{44}'/);
  assert.match(policy, /style-src 'self' 'sha256-[A-Za-z0-9+/=]{44}'/);
  for (const path of ["/owner.html", "/owner/status"]) {
    assert.equal((await fetch(new URL(path, base))).status, 404, path);
  }
  for (const path of ["/ui.css", "/relay-client.mjs", "/relay-wire.mjs", "/manifest.webmanifest", "/relay-sw.js", "/icon-192.png", "/icon-512.png", "/jsqr.js"]) {
    assert.equal((await fetch(new URL(path, base))).status, 200, path);
  }
  runtime = await launch();
  const lead = "http://127.0.0.1:" + runtime.server.address().port;
  const added = await fetch(lead + "/owner/units", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "mika" }) });
  assert.equal(added.status, 200);
  const link = await onceReady(runtime);
  const pair = await (await fetch(lead + "/owner/pair")).json();
  assert.equal(pair.unit, "mika");
  assert.equal(pair.relay_url, link);
  assert.match(pair.qr, /^data:image\/png;base64,/);
  const [channel, secret] = new URL(link).hash.slice(1).split(".");
  const location = new URL(link);
  const memory = new Map();
  Object.defineProperty(globalThis, "location", { value: location });
  Object.defineProperty(globalThis, "history", { value: { replaceState() { location.hash = ""; } } });
  Object.defineProperty(globalThis, "localStorage", { value: {
    getItem: key => memory.get(key), setItem: (key, value) => memory.set(key, value), removeItem: key => memory.delete(key)
  } });
  const phone = await openPhoneRelay();
  const state = () => phone.request("/api/state?v=0");
  const submit = (card, answer) => phone.request("/api/answer", { job_id: card.job_id, round: card.round, answer });
  const status = async () => (await fetch(lead + "/owner/status")).json();
  const invoke = (tool, args) => fetch(lead + "/call", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool, args })
  }).then(async response => {
    assert.equal(response.status, 200);
    return response.json();
  });
  assert.equal(location.hash, "");
  assert.ok([...memory.values()].includes(`${channel}.${secret}`));
  const { public_key } = await phone.request("/api/push/key");
  assert.match(public_key, /^[A-Za-z0-9_-]{87}$/);
  const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/offline-test", keys: { auth: "y".repeat(22), p256dh: public_key } };
  assert.deepEqual(await phone.request("/api/push/subscription", { ...subscription, endpoint: "https://127.0.0.1/invalid" }), { error: "INVALID_SUBSCRIPTION" });
  assert.deepEqual(await phone.request("/api/push/subscription", subscription), { ok: true });

  const phoneKeys = await relayKeys(channel, secret, "phone");
  const runtimeKeys = await relayKeys(channel, secret, "runtime", randomBytes(32).toString("base64url"));
  const wrongRuntimeKey = await relayKeys(channel, secret, "runtime", secret);
  for (const [role, token] of [["phone", "x".repeat(43)], ["runtime", phoneKeys.token], ["runtime", wrongRuntimeKey.token]]) {
    const denied = new WebSocket(relayUrl(base, channel, role), [RELAY_PROTOCOL, "auth." + token]);
    assert.equal(await new Promise(resolve => {
      denied.addEventListener("open", () => { denied.close(); resolve(false); }, { once: true });
      denied.addEventListener("error", () => resolve(true), { once: true });
    }), true);
  }
  const phoneWire = relayWire(phoneKeys);
  const runtimeWire = relayWire(runtimeKeys);
  const sample = { secretMessage: "SENSITIVE_CARD_MARKER".repeat(4000) };
  const frames = [];
  for await (const packet of phoneWire.pack(sample)) frames.push(packet);
  assert.ok(frames.length > 1);
  for (const frame of frames) assert.ok(!Buffer.from(frame).includes("SENSITIVE_CARD_MARKER"));
  const broken = frames[0].slice(0);
  new Uint8Array(broken)[broken.byteLength - 1] ^= 1;
  await assert.rejects(runtimeWire.unpack(broken));
  let unpacked;
  for (const frame of frames) unpacked = await runtimeWire.unpack(frame);
  assert.deepEqual(unpacked, sample);

  const media = Buffer.alloc(FRAME_CHUNK_BYTES * 3, 0x29);
  const cards = [
    ["choose", { question: "mark a choice", options: ["left", "right"] }, "choice", { choice: "left" }],
    ["mood", {}, "slider", { value: 4 }],
    ["checklist", { steps: ["first", "second"] }, "checklist", { checked: [0, 1] }],
    ["observe", { target: "the tabletop", want: { done: "whether it was seen" } }, "form", { text: "seen" }],
    ["photo", { target: "a sample object" }, "camera", { file: "data:image/png;base64," + media.toString("base64"), fresh: true }],
    ["record", { topic: "a sample sound" }, "audio", { file: "data:audio/wav;base64," + media.toString("base64") }],
    ["go", { place: "front door" }, "location", { location: { lat: 45.5, lon: -73.5 } }],
    ["act", { action: "open the window" }, "confirm", { choice: "done" }],
    ["recharge", {}, "theater", null]
  ];
  for (const [tool, args, kind, response] of cards) {
    const { result } = await invoke(tool, args);
    await runtime.runtime.settle();
    const view = await state();
    if (response === null) {
      assert.ok(view.theater.some(event => event.id === result.job));
    } else {
      assert.equal(view.card.kind, kind);
      assert.equal(view.card.job_id, result.job);
      assert.deepEqual(await submit(view.card, response), { ok: true });
      await runtime.runtime.settle();
      const report = (await state()).reports.find(report => report.job_id === result.job && report.round === view.card.round);
      assert.deepEqual(report.result, runtime.runtime.view(result.job).result);
      assert.deepEqual(await submit(view.card, response), { error: "NOT_OPEN" });
      if (response.file) {
        const attached = runtime.runtime.job(result.job).data.rounds[0].answer.file.path;
        assert.deepEqual(readFileSync(attached), media);
      }
    }
    assert.equal(runtime.runtime.job(result.job).status, "done", tool);
  }

  assert.equal(pushes.length, cards.length);
  const snapshot = await status();
  assert.equal(snapshot.units[0].online, true);
  const photo = snapshot.calls.find(call => call.tool === "photo");
  assert.equal(photo.state, "done");
  assert.equal(photo.response.result.job, photo.job);
  const evidence = await fetch(lead + "/owner/evidence/" + photo.evidence[0]);
  assert.equal(evidence.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await evidence.arrayBuffer()), media);
  assert.ok(pushes.every(({ payload, options }) => payload === "A card is ready." && options.urgency === "normal"));
  const interrupt = (await callTool(runtime.runtime, "act", { action: "preempt a card", priority: "preempt" })).result.job;
  assert.equal(pushes.at(-1).options.urgency, "high");
  assert.equal(pushes.at(-1).subscription.endpoint, subscription.endpoint);
  assert.deepEqual(await submit((await state()).card, { choice: "done" }), { ok: true });
  assert.equal(runtime.runtime.job(interrupt).status, "done");
  const opportunistic = (await callTool(runtime.runtime, "act", { action: "hold this card", priority: "opportunistic" })).result.job;
  runtime.runtime.pump(1, runtime.runtime.unit().id);
  assert.equal(pushes.length, cards.length + 1);
  assert.deepEqual(await submit((await state()).card, { choice: "done" }), { ok: true });
  assert.equal(runtime.runtime.job(opportunistic).status, "done");

  const waiting = invoke("choose", { question: "wait until answered", options: ["go", "stop"], wait: "done" });
  let pending;
  for (let i = 0; i < 30 && !pending; i++) {
    pending = (await status()).calls.find(call => call.call_state === "running");
    if (!pending) await delay(50);
  }
  assert.equal(pending?.state, "open");
  assert.equal(pending.args.wait, "done");
  assert.equal((await state()).card.job_id, pending.job);
  assert.deepEqual(await submit((await state()).card, { choice: "go" }), { ok: true });
  const actual = await waiting;
  const logged = (await status()).calls.find(call => call.id === pending.id);
  assert.equal(logged.call_state, "returned");
  assert.deepEqual(logged.response, actual);
  assert.deepEqual((await invoke("ps", {})), (await status()).calls.find(call => call.tool === "ps").response);

  const beforeResume = pushes.length;
  const active = (await callTool(runtime.runtime, "act", { action: "leave one card open" })).result.job;
  assert.equal((await state()).card.job_id, active);
  await runtime.stop();
  runtime = await launch();
  assert.equal(pushes.length, beforeResume + 1);
  assert.equal(await onceReady(runtime), link);
  let restored;
  for (let attempt = 0; attempt < 12 && !restored; attempt++) {
    try { restored = (await state()).card; } catch { await delay(250); }
  }
  assert.equal(restored?.job_id, active);
  assert.equal((await phone.request("/api/push/key")).public_key, public_key);
  assert.deepEqual(await submit(restored, { choice: "done" }), { ok: true });
  assert.equal(runtime.runtime.job(active).status, "done");

  // A new link retires the old one everywhere: the open page, its saved copy, its push registration, the channel itself.
  const restarted = "http://127.0.0.1:" + runtime.server.address().port;
  const crossSite = await fetch(restarted + "/owner/pair/new", { method: "POST", headers: { origin: "https://example.com", "content-type": "application/json" }, body: "{}" });
  assert.equal(crossSite.status, 403);
  const renewed = await (await fetch(restarted + "/owner/pair/new", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
  assert.equal(renewed.retired, true);
  assert.notEqual(renewed.relay_url, link);
  assert.match(renewed.qr, /^data:image\/png;base64,/);
  await assert.rejects(state(), error => error.relayRetired === true);
  assert.ok(![...memory.values()].includes(`${channel}.${secret}`));
  const reregister = await fetch(new URL(`/channel/${channel}/register`, base), {
    method: "POST", headers: { Authorization: "Bearer " + runtimeKeys.token, "X-Human-Use-Phone": runtimeKeys.phoneTokenHash }
  });
  assert.equal(reregister.status, 410);
  const beforeRenewedCard = pushes.length;
  const afterRenew = (await callTool(runtime.runtime, "act", { action: "answer on the new link" })).result.job;
  assert.equal(pushes.length, beforeRenewedCard);
  assert.equal(await onceReady(runtime), renewed.relay_url);
  location.hash = new URL(renewed.relay_url).hash;
  const renewedPhone = await openPhoneRelay();
  const renewedCard = (await renewedPhone.request("/api/state?v=0")).card;
  assert.equal(renewedCard.job_id, afterRenew);
  assert.deepEqual(await renewedPhone.request("/api/answer", { job_id: renewedCard.job_id, round: renewedCard.round, answer: { choice: "done" } }), { ok: true });
  assert.equal(runtime.runtime.job(afterRenew).status, "done");
  console.log("PASS nine relay card kinds, media integrity, role auth, duplicate answers, restart reconnect, push urgency, live lead call/result/evidence, page CSP, and link renewal.");
} finally {
  await runtime?.stop();
  rmSync(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}
