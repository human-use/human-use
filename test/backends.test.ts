import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChatDriver } from "../src/chat.js";
import { makeBrain, makeDriver, parseBackend } from "../src/backends.js";
import { codexUserDefaults } from "../src/codex.js";
import { HANDOFF_SKILL, installHandoffSkill } from "../src/install.js";
import { goalPasses } from "../src/owner.js";
import { Store } from "../src/store.js";
import type { DriverInput } from "../src/runtime.js";

test("backend specs parse model names with colons, effort, endpoint URLs, and earlier config", () => {
  assert.deepEqual(parseBackend("claude:haiku"), { backend: "claude", model: "haiku" });
  assert.deepEqual(parseBackend("codex:gpt-6-luna:medium"), { backend: "codex", model: "gpt-6-luna", effort: "medium" });
  assert.deepEqual(parseBackend("ollama:qwen3-vl:8b"), { backend: "ollama", model: "qwen3-vl:8b" });
  assert.deepEqual(parseBackend("openai:my-model@http://127.0.0.1:1234/v1"), { backend: "openai", model: "my-model", base_url: "http://127.0.0.1:1234/v1" });
  assert.deepEqual(parseBackend({ driver: "claude", model: "haiku" }), { backend: "claude", model: "haiku" });
  assert.equal(makeDriver("none"), null);
  assert.equal(makeBrain("none", () => {}), null);
  assert.throws(() => makeDriver("ollama"), /needs a model/);
  assert.throws(() => makeBrain("ollama:qwen3", () => {}), /no tool loop/);
});

/** A stand-in for Ollama or any OpenAI-compatible server. No model is called. */
test("local-model driver: system prompt, fenced unit input and the photo go out; thinking is stripped from what comes back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "human-use-"));
  const previous = process.env.HUMAN_USE_HOME;
  process.env.HUMAN_USE_HOME = dir;
  const requests: Array<{ url: string; auth: string | undefined; body: { model: string; messages: Array<{ role: string; content: unknown }> } }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk as Buffer));
    req.on("end", () => {
      requests.push({ url: req.url ?? "", auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: '<think>maybe [1, 2] first</think>\n[{"type":"reject","text":"[REJECTED 1/3] not a photo","reason":"not_a_photo"}]' } }], usage: { prompt_tokens: 10 } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const photo = join(dir, "photo.jpg");
    writeFileSync(photo, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const input: DriverInput = {
      event: "answer",
      job: { id: "j_1", tool: "photo", variant: null, instruction: "PHOTO empty glass", want: { empty: "true or false" }, args: {}, sudo: false, round: 1, rounds_left: 2 },
      answer: { file: { path: photo, kind: "photo", captured: "live" } },
      history: [{ at: "2026-11-16T08:00:00Z", card: "PHOTO empty glass", nonce: "hold up 2 fingers, lower left", answer: { text: "here", file: { path: photo, kind: "photo", captured: "live" } } }],
      notebook: "", unit: { lang: "en" }, goal: null, evidence: [], now: "2026-11-16T08:00:05Z"
    };
    const driver = new ChatDriver({ baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "local-vision", label: "ollama:local-vision" });
    assert.deepEqual(await driver.run(input), [{ type: "reject", text: "[REJECTED 1/3] not a photo", reason: "not_a_photo" }]);

    const [request] = requests;
    assert.equal(request!.url, "/v1/chat/completions");
    assert.equal(request!.auth, undefined, "no key is sent to a local endpoint");
    assert.equal(request!.body.model, "local-vision");
    assert.equal(request!.body.messages[0]!.role, "system");
    assert.match(String(request!.body.messages[0]!.content), /compile stage/);
    const parts = request!.body.messages[1]!.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    const text = parts.map(part => part.text ?? "").join("\n");
    assert.match(text, /<unit_input_[0-9a-f]{8}>\{"text":"here","file":\{"kind":"photo","captured":"live"\}\}<\/unit_input_[0-9a-f]{8}>/);
    assert.match(text, /Liveness gesture this card required in frame: hold up 2 fingers, lower left/);
    assert.doesNotMatch(text, /photo\.jpg/, "file paths stay on this side");
    assert.equal(parts.filter(part => part.type === "image_url").length, 1);
    assert.match(parts.find(part => part.type === "image_url")!.image_url!.url, /^data:image\/jpeg;base64,/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previous === undefined) delete process.env.HUMAN_USE_HOME; else process.env.HUMAN_USE_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("handoff skill: the lead invokes it per session; neither host loads it on its own", async () => {
  const root = mkdtempSync(join(tmpdir(), "human-use-skill-"));
  try {
    await installHandoffSkill("codex", root);
    await installHandoffSkill("claude", root);
    const codex = readFileSync(join(root, ".agents", "skills", HANDOFF_SKILL, "SKILL.md"), "utf8");
    const claude = readFileSync(join(root, ".claude", "skills", HANDOFF_SKILL, "SKILL.md"), "utf8");
    for (const text of [codex, claude]) {
      assert.match(text, new RegExp(`^---\nname: ${HANDOFF_SKILL}\ndescription: "`));
      assert.match(text, /goal_set/);
      assert.match(text, /one line/);
    }
    assert.match(readFileSync(join(root, ".agents", "skills", HANDOFF_SKILL, "agents", "openai.yaml"), "utf8"), /allow_implicit_invocation: false/);
    assert.match(claude, /\ndisable-model-invocation: true\n---/);
    assert.doesNotMatch(codex, /disable-model-invocation/);
    assert.equal(existsSync(join(root, ".claude", "skills", HANDOFF_SKILL, "agents")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("background brain: runs the lead's own Codex model unless the brain setting names one", () => {
  const dir = mkdtempSync(join(tmpdir(), "human-use-codex-home-"));
  try {
    assert.deepEqual(codexUserDefaults(dir), {});
    writeFileSync(join(dir, "config.toml"), 'model = "gpt-6.1-terra"\nmodel_reasoning_effort = "low"\n\n[projects.x]\nmodel = "other"\n');
    assert.deepEqual(codexUserDefaults(dir), { model: "gpt-6.1-terra", effort: "low" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lead page passes: each exit pairs with the wake it ran on; replaced waits are left out", () => {
  const dir = mkdtempSync(join(tmpdir(), "human-use-passes-"));
  const store = new Store(join(dir, "runtime.sqlite"));
  try {
    const t = (minute: number) => new Date(Date.UTC(2026, 10, 17, 9, minute)).toISOString();
    const old = (minute: number) => new Date(Date.UTC(2026, 10, 15, 9, minute)).toISOString();
    store.event(old(0), "woken", "g", "g", { why: "handed to the window" });
    store.event(old(5), "woken", "g", "g", { why: "before marking, ran" });
    store.event(old(9), "brain_exit", "g", "g", { ok: true, calls: 1, ms: 60_000 });
    store.event(t(0), "woken", "g", "g", { why: "first", pass: true });
    store.event(t(1), "woken", "g", "g", { why: "queued, replaced", pass: true });
    store.event(t(2), "woken", "g", "g", { why: "queued, ran", pass: true });
    store.event(t(3), "brain_exit", "g", "g", { ok: true, woke_at: t(0), calls: 2, tools: ["ask", "wake"], ms: 170_000 });
    store.event(t(8), "brain_exit", "g", "g", { ok: false, woke_at: t(2), error: "boom" });
    store.event(t(20), "woken", "g", "g", { why: "lost on restart", pass: true });
    store.event(t(40), "woken", "g", "g", { why: "now", pass: true });
    store.event(t(40), "woken", "other", "other", { why: "another goal", pass: true });
    const passes = goalPasses(store, "g", Date.parse(t(41)));
    assert.deepEqual(passes.map(pass => [pass.why, pass.state]),
      [["now", "running"], ["lost on restart", "lost"], ["queued, ran", "failed"], ["first", "done"], ["before marking, ran", "done"]]);
    assert.deepEqual(passes[3], { at: t(0), why: "first", state: "done", calls: 2, tools: ["ask", "wake"], ms: 170_000 });
    assert.equal(passes[2]!.error, "boom");
    assert.equal(goalPasses(store, "g", Date.parse(t(58)))[0]!.state, "lost");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
