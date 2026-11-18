import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { makeDriver } from "../src/backends.js";
import { buildContent, extractActions, logCall } from "../src/driver.js";
import { runProcess } from "../src/exec.js";
import { promptPath, sandboxDir } from "../src/paths.js";
import { ActionSchema, type Action, type Answer, type DriverInput } from "../src/runtime.js";

type Outcome = Extract<Action, { type: "complete" | "reply" | "reject" | "escalate" | "card" }>;

interface Fixture {
  id: string;
  smoke?: boolean;
  tool: string;
  instruction: string;
  args?: Record<string, unknown>;
  want?: Record<string, string>;
  answer?: Omit<Answer, "file"> & { file?: string; captured?: "live" | "upload" };
  nonce?: string;
  sudo?: boolean;
  rounds_left?: number;
  notebook?: string;
  expected: { type: Outcome["type"] | Outcome["type"][]; reason?: string; text_pattern?: string; result?: Record<string, unknown>; keys?: string[]; evidence_level?: number };
}

/** Test only, for wording checks on cheap models. opencode's free models accept requests from its own agents only, so the
 * driver rules travel in the message to the built-in read-only plan agent, and any tool call fails the case. Never a product
 * backend: a real driver has no tools at all. Spec `opencode-plan:<model>[+<vision model>]`; `OPENCODE` names the binary. */
class OpencodePlanDriver {
  constructor(private readonly model: string, private readonly vision: string) {}
  async run(input: DriverInput): Promise<unknown> {
    const blocks = buildContent(input);
    const images = blocks.flatMap(block => block.type === "image" ? [block.path] : []);
    let seen = 0;
    const body = blocks.map(block => block.type === "text" ? block.text : `[attached image ${++seen}: the photo the unit sent with the input above]`).join("\n\n");
    const message = `${readFileSync(promptPath("driver"), "utf8")}\n\n---\n\n${body}`;
    const model = images.length ? this.vision : this.model;
    // The free gateway answers "overloaded" in bursts and opencode then hangs without output: retry, do not count it.
    for (let attempt = 1; ; attempt++) {
      const text = await this.once(model, images, message, input);
      if (text) return extractActions(text);
      if (attempt === 3) throw new Error("no text after 3 attempts (gateway overloaded?)");
      await new Promise(resolve => setTimeout(resolve, 20_000));
    }
  }

  private async once(model: string, images: string[], message: string, input: DriverInput): Promise<string> {
    const run = await runProcess({
      command: process.env.OPENCODE ?? "opencode",
      args: ["run", "--agent", "plan", "--format", "json", "-m", model, ...images.flatMap(path => ["-f", path]), "--", message],
      stdin: "", cwd: sandboxDir(), timeoutMs: 90_000
    });
    let text = "";
    let tools = 0;
    let tokens: unknown = null;
    for (const line of run.stdout.split("\n")) {
      try {
        const event = JSON.parse(line) as { type?: string; part?: { type?: string; text?: string; tokens?: unknown } };
        if (event.type === "text" && event.part?.text) text = event.part.text;
        if (event.type === "tool_use" || event.part?.type === "tool") tools++;
        if (event.type === "step_finish") tokens = event.part?.tokens ?? tokens;
      } catch { /* not JSON */ }
    }
    logCall(`opencode-plan:${model}`, input, run.ms, text, { tools, tokens, stderr: text ? undefined : run.stderr.slice(-400) });
    if (tools) throw new Error(`used ${tools} tool call(s)`);
    return text;
  }
}

function testDriver(spec: string): { run(input: DriverInput): Promise<unknown> } | null {
  if (!spec.startsWith("opencode-plan:")) return makeDriver(spec);
  const [text, vision = text] = spec.slice("opencode-plan:".length).split("+");
  if (!text) throw new Error("opencode-plan needs a model");
  return new OpencodePlanDriver(text, vision!);
}

const dir = fileURLToPath(new URL("../test/fixtures/driver/", import.meta.url));
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { all: { type: "boolean" }, list: { type: "boolean" }, only: { type: "string", multiple: true } }
});
const fixtures = readdirSync(dir).filter(name => name.endsWith(".json")).sort()
  .flatMap(name => JSON.parse(readFileSync(join(dir, name), "utf8")) as Fixture[]);
if (new Set(fixtures.map(fixture => fixture.id)).size !== fixtures.length) throw new Error("duplicate fixture IDs");
const only = values.only?.flatMap(ids => ids.split(/[\s;]+/)).filter(Boolean);
for (const id of only ?? []) if (!fixtures.some(fixture => fixture.id === id)) throw new Error(`unknown fixture ${id}`);
const selected = fixtures.filter(fixture => only ? only.includes(fixture.id) : values.all || fixture.smoke);

function inputFor(fixture: Fixture): DriverInput {
  const now = "2026-11-14T18:00:10Z";
  const roundsLeft = fixture.rounds_left ?? 2;
  const rounds = fixture.answer ? 3 - roundsLeft : 0;
  const { file, captured, ...unit } = fixture.answer ?? {};
  const path = file ? join(dir, file) : undefined;
  if (path && !existsSync(path)) throw new Error(`missing fixture image: ${file}`);
  const answer: Answer | null = fixture.answer ? {
    ...unit,
    ...(path ? { file: { path, kind: "photo", captured } } : {})
  } : null;
  return {
    event: answer ? "answer" : "start",
    job: {
      id: `j_${fixture.id}`, tool: fixture.tool, variant: null, instruction: fixture.instruction,
      args: { ...fixture.args, ...(fixture.nonce ? { nonce: true } : {}) },
      want: fixture.want ?? null, sudo: fixture.sudo ?? false, round: rounds, rounds_left: answer ? roundsLeft : 3
    },
    answer,
    history: Array.from({ length: rounds }, (_, index) => ({
      at: "2026-11-14T18:00:00Z", card: fixture.instruction, nonce: fixture.nonce,
      answer: index === rounds - 1 ? answer! : { text: "没有补充" }
    })),
    notebook: fixture.notebook ?? "",
    unit: { lang: "zh-CN" }, goal: null, evidence: [], now
  };
}

function check(raw: unknown, expected: Fixture["expected"]): void {
  if (!Array.isArray(raw)) throw new Error("output must be an action array");
  const actions = raw.map(value => ActionSchema.parse(value));
  const outcomes = actions.filter((action): action is Outcome =>
    action.type === "complete" || action.type === "reply" || action.type === "reject" || action.type === "escalate" || action.type === "card");
  const actual = outcomes[0];
  const expectedTypes = [expected.type].flat();
  if (outcomes.length !== 1 || !actual || !expectedTypes.includes(actual.type)) {
    throw new Error(`expected ${expectedTypes.join(" or ")}; received ${outcomes.map(action => action.type).join(", ") || "no outcome"}`);
  }
  if (expected.reason && (!("reason" in actual) || actual.reason !== expected.reason)) {
    throw new Error(`expected reason ${expected.reason}`);
  }
  if (expected.text_pattern && (!("text" in actual) || !new RegExp(expected.text_pattern, "iu").test(actual.text))) {
    throw new Error(`card text did not match ${expected.text_pattern}`);
  }
  for (const [field, value] of Object.entries(expected.result ?? {})) {
    if (actual.type === "complete" && !Object.is(actual.result[field], value)) throw new Error(`unexpected result field ${field}`);
  }
  for (const key of expected.keys ?? []) {
    if (actual.type === "complete" && !(key in actual.result)) throw new Error(`result has no ${key}`);
  }
  if (expected.evidence_level !== undefined && (actual.type !== "complete" || actual.evidence_level !== expected.evidence_level)) {
    throw new Error(`expected evidence_level ${expected.evidence_level}`);
  }
}

const cases = selected.map(fixture => ({ fixture, input: inputFor(fixture) }));
if (values.list && !positionals.length) {
  for (const { fixture } of cases) console.log(`${fixture.id}\t${[fixture.expected.type].flat().join("|")}`);
} else {
  const [spec] = positionals;
  if (!spec || positionals.length !== 1 || values.list) {
    throw new Error("usage: tsx scripts/driver-check.mts <backend> [--all | --only <id>...] | --list [--all]");
  }
  const driver = testDriver(spec);
  if (!driver) throw new Error("select an active driver");
  const runHome = mkdtempSync(join(tmpdir(), "human-use-driver-check-"));
  process.env.HUMAN_USE_HOME = runHome;
  let passed = 0;
  try {
    for (const { fixture, input } of cases) {
      const start = performance.now();
      try {
        check(await driver.run(input), fixture.expected);
        console.log(`PASS ${fixture.id} ${Math.round(performance.now() - start)} ms`);
        passed++;
      } catch (error) {
        console.log(`FAIL ${fixture.id} ${Math.round(performance.now() - start)} ms · ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    // Keep what the model actually wrote for every case: a failure names only the action type.
    const log = join(runHome, "logs", "driver.jsonl");
    if (existsSync(log)) {
      const runs = fileURLToPath(new URL("../runs/", import.meta.url));
      mkdirSync(runs, { recursive: true });
      const saved = join(runs, `driver-check-${spec.replace(/[^A-Za-z0-9.-]+/g, "_")}-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
      copyFileSync(log, saved);
      console.log(`raw outputs: ${saved}`);
    }
    rmSync(runHome, { recursive: true, force: true });
  }
  console.log(`${passed}/${cases.length} passed`);
  if (passed < cases.length) process.exitCode = 1;
}
