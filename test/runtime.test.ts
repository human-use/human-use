import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { FileNotebook } from "../src/notebook.js";
import { Runtime, interpolate, type Brain, type Card, type CardReport, type Channel, type JobData, type JobView, type Driver, type DriverInput } from "../src/runtime.js";
import { Store } from "../src/store.js";
import { callTool } from "../src/tools.js";

/** A clock the test moves by hand. */
class FakeClock {
  constructor(public t: Date) {}
  now() { return new Date(this.t); }
  advance(seconds: number) { this.t = new Date(this.t.getTime() + seconds * 1000); }
}

class FakeChannel implements Channel {
  cards: Card[] = [];
  withdrawn: Array<{ job: string; reason: string; unit: string | null }> = [];
  reports: CardReport[] = [];
  show(card: Card) { this.cards.push(card); }
  report(report: CardReport) { this.reports.push(report); }
  withdraw(job: string, reason: string, unit: string | null) { this.withdrawn.push({ job, reason, unit }); }
  last() { return this.cards.at(-1)!; }
}

class ScriptedDriver implements Driver {
  inputs: DriverInput[] = [];
  constructor(private readonly script: (input: DriverInput) => unknown) {}
  async run(input: DriverInput) { this.inputs.push(input); return this.script(input); }
}

function setup(driver: Driver | null = null, start = "2026-11-16T08:00:00", units = ["mika"]) {
  const dir = mkdtempSync(join(tmpdir(), "human-use-"));
  const store = new Store(join(dir, "runtime.sqlite"));
  const clock = new FakeClock(new Date(start));
  const channel = new FakeChannel();
  const notebook = new FileNotebook(join(dir, "notebook"));
  const runtime = new Runtime({ store, clock, channel, driver, notebook: () => notebook, onError: error => { throw error; } });
  for (const name of units) runtime.addUnit(name);
  return { runtime, clock, channel, store, notebook, done: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("parameters are rendered into the card; choose closes without the driver; the result arrives once", async () => {
  const { runtime, channel, done } = setup();
  try {
    const { result } = await callTool(runtime, "choose", { question: "fresher loaf", options: ["left", "right"] });
    const job = (result as JobView).job;
    assert.equal(channel.last().kind, "choice");
    assert.equal(channel.last().text, "CHOOSE fresher loaf");
    assert.equal(channel.last().title, "human.choose");
    runtime.answer(job, { choice: "right" });
    const { events } = await callTool(runtime, "ps", {});
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]!.type === "result" && events[0]!.result, { choice: "right" });
    assert.deepEqual((await callTool(runtime, "ps", {})).events, []);
  } finally { done(); }
});

test("results hang on the goal: a call naming another goal does not get them", async () => {
  const { runtime, done } = setup();
  try {
    const a = runtime.setGoal({ goal: "A", kind: "reach", done_when: "x" }).goal;
    const b = runtime.setGoal({ goal: "B", kind: "reach", done_when: "y" }).goal;
    const { result } = await callTool(runtime, "act", { action: "open window", goal: a });
    runtime.answer((result as JobView).job, { choice: "done" });
    assert.deepEqual((await callTool(runtime, "since", {})).events, []);
    assert.deepEqual((await callTool(runtime, "goal_note", { goal: b, decision: "d", reason: "r" })).events, []);
    const { events } = await callTool(runtime, "goal_note", { goal: a, decision: "d", reason: "r" });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, "result");
  } finally { done(); }
});

test("the agenda carries over passes until a pass rewrites it", async () => {
  const { runtime, done } = setup();
  try {
    const goal = runtime.setGoal({ goal: "G", kind: "reach", done_when: "x" }).goal;
    assert.equal(runtime.briefing(goal).agenda, null);
    await callTool(runtime, "goal_note", { goal, decision: "d1", reason: "r", agenda: "Thu: check photos. Sun: weekly review." });
    await callTool(runtime, "goal_note", { goal, decision: "d2", reason: "r" });
    assert.equal(runtime.briefing(goal).agenda?.text, "Thu: check photos. Sun: weekly review.");
    await callTool(runtime, "goal_note", { goal, decision: "d3", reason: "r", agenda: "Sun: weekly review." });
    assert.equal(runtime.briefing(goal).agenda?.text, "Sun: weekly review.");
    await assert.rejects(callTool(runtime, "goal_note", { goal, decision: "d4", reason: "r", agenda: "x".repeat(1501) }));
  } finally { done(); }
});

test("goal calls carry overdue maintenance from the first record; a pending call for it silences the warning", async () => {
  const { runtime, clock, done } = setup();
  try {
    const goal = runtime.setGoal({ goal: "G", kind: "reach", done_when: "x" }).goal;
    assert.equal((await callTool(runtime, "ps", {})).warnings, undefined);
    assert.equal((await callTool(runtime, "goal_note", { goal, decision: "d", reason: "r" })).warnings, undefined, "no record yet, nothing to be overdue");
    const { result } = await callTool(runtime, "eat", { goal });
    runtime.answer((result as JobView).job, { choice: "done" });
    const slept = (await callTool(runtime, "sleep", { goal, until: "07:00" })).result as JobView;
    runtime.answer(slept.job, { choice: "done" });
    clock.advance(5 * 3600);
    assert.equal((await callTool(runtime, "goal_note", { goal, decision: "d", reason: "r" })).warnings, undefined);
    clock.advance(3600 + 12 * 60);
    assert.deepEqual((await callTool(runtime, "goal_note", { goal, decision: "d", reason: "r" })).warnings, ["meal: 6h12m ago"]);
    assert.deepEqual(runtime.briefing(goal).warnings, ["meal: 6h12m ago"]);
    await callTool(runtime, "eat", { goal });
    assert.deepEqual(runtime.briefing(goal).warnings, [], "a pending meal silences the warning");
  } finally { done(); }
});

test("wait blocks until the unit answers, and the result is not delivered a second time", async () => {
  const { runtime, channel, done } = setup();
  try {
    const pending = callTool(runtime, "choose", { question: "A or B", options: ["A", "B"], wait: "5s" });
    runtime.answer(channel.last().job_id, { choice: "B" });
    const { result, events } = await pending;
    const view = result as JobView;
    assert.equal(view.state, "done");
    assert.deepEqual(view.result, { choice: "B" });
    assert.deepEqual(events, []);
    assert.deepEqual(runtime.drain(), []);
  } finally { done(); }
});

test("wait done past the call limit arms a wake for when the job settles", async () => {
  const { runtime, channel, done } = setup();
  const wakes: string[] = [];
  process.env.HUMAN_USE_WAIT_CAP_S = "0.05";
  try {
    runtime.brain = { wake(_goal, briefing) { wakes.push(briefing.why); } } satisfies Brain;
    const goal = runtime.setGoal({ goal: "Tidy desk", kind: "reach", done_when: "photo of a clear desk" }, { at: "1d", why: "review" }).goal;
    const { result } = await callTool(runtime, "act", { action: "clear desk", goal, wait: "done" });
    const view = result as JobView & { note: string };
    assert.equal(view.state, "open");
    assert.equal(view.wake_on_settle, true);
    assert.match(view.note, /wakes this goal/);
    runtime.answer(channel.last().job_id, { choice: "done" });
    await runtime.settle();
    assert.equal(wakes.length, 1);
    assert.match(wakes[0]!, /j_\w+ done/);
    assert.equal(runtime.briefing(goal).next_wake?.why, "review", "the scheduled wake is untouched");
  } finally { delete process.env.HUMAN_USE_WAIT_CAP_S; done(); }
});

test("a background pass never blocks on the person: wait returns at once and the settled job wakes the goal", async () => {
  const { runtime, channel, done } = setup();
  const wakes: string[] = [];
  try {
    runtime.brain = { wake(_goal, briefing) { wakes.push(briefing.why); } } satisfies Brain;
    const goal = runtime.setGoal({ goal: "Tidy desk", kind: "reach", done_when: "photo of a clear desk" }, { at: "1d", why: "review" }).goal;
    const started = Date.now();
    const { result } = await callTool(runtime, "act", { action: "clear desk", goal, wait: "done" }, undefined, "pass");
    const view = result as JobView & { note: string };
    assert.ok(Date.now() - started < 1000, "no blocking in a pass");
    assert.equal(view.state, "open");
    assert.equal(view.wake_on_settle, true);
    assert.match(view.note, /does not wait/);
    const again = (await callTool(runtime, "wait", { job: view.job, for: "10m" }, undefined, "pass")).result as JobView;
    assert.equal(again.state, "open");
    runtime.answer(channel.last().job_id, { choice: "done" });
    await runtime.settle();
    assert.equal(wakes.length, 1);
    assert.match(wakes[0]!, /j_\w+ done/);
  } finally { done(); }
});

test("with no brain, a stalled goal's morning wake is delivered once", async () => {
  const { runtime, clock, done } = setup();
  try {
    const { goal } = runtime.setGoal({ goal: "Tidy desk", kind: "reach", done_when: "clear desk" }, { at: "1s", why: "start" });
    clock.advance(1);
    runtime.tick();
    await callTool(runtime, "goal_get", { goal });
    runtime.tick();
    const wake = runtime.briefing(goal).next_wake!;
    clock.t = new Date(wake.at);
    runtime.tick();
    const received = await callTool(runtime, "goal_get", { goal });
    assert.deepEqual(received.events, [{ type: "wake", goal, why: "stalled: no next_wake was set" }]);
    assert.deepEqual((await callTool(runtime, "goal_get", { goal })).events, []);
  } finally { done(); }
});

test("with no brain, an armed job's result and wake arrive together once", async () => {
  const { runtime, done } = setup();
  try {
    const { goal } = runtime.setGoal({ goal: "Tidy desk", kind: "reach", done_when: "clear desk" });
    const { job } = runtime.dispatch("act", { instruction: "clear desk", goal });
    assert.equal(runtime.armWake(job), true);
    runtime.answer(job, { choice: "done" });
    const { events } = await callTool(runtime, "goal_get", { goal });
    assert.deepEqual(events.map(event => event.type), ["result", "wake"]);
    assert.deepEqual(events[1], { type: "wake", goal, why: `job ${job} done` });
    assert.deepEqual((await callTool(runtime, "goal_get", { goal })).events, []);
  } finally { done(); }
});

test("with no brain, an escalation and its wake are delivered once", async () => {
  const { runtime, done } = setup(new ScriptedDriver(() => [{ type: "escalate", reason: "HRT-4009" }]));
  try {
    const { goal } = runtime.setGoal({ goal: "Tidy desk", kind: "reach", done_when: "clear desk" });
    const { job } = runtime.dispatch("observe", { instruction: "observe desk", goal });
    runtime.answer(job, { text: "cannot access desk" });
    await runtime.settle();
    const { events } = await callTool(runtime, "ps", { goal });
    assert.deepEqual(events, [
      { type: "escalated", job, goal, tool: "observe", reason: "HRT-4009" },
      { type: "wake", goal, why: `job ${job} escalated` }
    ]);
    assert.deepEqual((await callTool(runtime, "since", { tool: "observe", goal })).events, []);
  } finally { done(); }
});

test("one wait spans a follow-up without showing the full form again", async () => {
  const driver = new ScriptedDriver(input => {
    const said = input.history.map(round => round.answer?.text ?? "").join(" ");
    if (!/\d/.test(said)) return [{ type: "reply", text: "[MISSING FIELD] eggs" }];
    return [{ type: "complete", result: { eggs: Number(/\d+/.exec(said)![0]), milk_type: "low_fat" } }];
  });
  const { runtime, channel, done } = setup(driver);
  try {
    const want = { eggs: "count bought", milk_type: "kind of milk" };
    const pending = callTool(runtime, "errand", { place: "corner shop", task: "6 eggs, whole milk", want, wait: "5s" });
    const job = channel.last().job_id;
    assert.equal(channel.last().text, "ERRAND corner shop: 6 eggs, whole milk");
    assert.deepEqual(channel.last().fields, want);
    runtime.resume();
    assert.equal(channel.last().round, 1);
    assert.deepEqual(channel.last().fields, want);
    runtime.answer(job, { text: "got it, no whole milk so low fat" });
    await runtime.settle();
    assert.equal(channel.last().text, "[MISSING FIELD] eggs");
    assert.equal(channel.last().round, 2);
    assert.equal(channel.last().fields, undefined);
    runtime.resume();
    assert.equal(channel.last().round, 2);
    assert.equal(channel.last().fields, undefined);
    runtime.answer(job, { text: "6" });
    await runtime.settle();
    const { result, events } = await pending;
    const view = result as JobView;
    assert.equal(view.state, "done");
    assert.deepEqual(view.result, { eggs: 6, milk_type: "low_fat" });
    assert.deepEqual(events, []);
    assert.equal(driver.inputs[1]!.history.length, 2);
    assert.deepEqual(driver.inputs[0]!.job.args.place, "corner shop", "the driver sees the parameters as given");
  } finally { done(); }
});

test("bad driver output is retried once, then surfaces as a system fault that does not name the driver", async () => {
  const driver = new ScriptedDriver(() => ({ nope: true }));
  const { runtime, done } = setup(driver);
  try {
    const job = runtime.dispatch("observe", { instruction: "OBSERVE shop door" }).job;
    runtime.answer(job, { text: "yes" });
    await runtime.settle();
    assert.equal(driver.inputs.length, 2);
    assert.equal(runtime.job(job).status, "escalated");
    const [item] = runtime.drain();
    assert.equal(item?.type, "escalated");
    assert.equal(item?.type === "escalated" && item.reason, "HRT-5031 COMPILE_FAILED");
  } finally { done(); }
});

test("sudo confirmation asks for evidence and labels an unverified final claim", async () => {
  const driver = new ScriptedDriver(({ job }) => job.rounds_left
    ? [{ type: "reply", text: "What can verify the action?" }]
    : [{ type: "complete", result: { done: true }, evidence_level: 6 }]);
  const { runtime, channel, done } = setup(driver);
  try {
    const { result: dispatched } = await callTool(runtime, "act", { action: "Put the book on the shelf", sudo: true });
    const { job } = dispatched as JobView;
    for (let round = 1; round <= 3; round++) {
      runtime.answer(job, round === 1 ? { choice: "done" } : { text: "I did it." });
      await runtime.settle();
      if (round < 3) {
        assert.equal(channel.last().text, "What can verify the action?");
        assert.equal(channel.last().kind, "form");
      }
    }
    assert.ok(driver.inputs.every(input => input.job.sudo));
    assert.deepEqual(runtime.view(job).result, { done: null, claimed_done: true, evidence_level: 6, unverified: true });
  } finally { done(); }
});

test("follow-ups stop at the round limit; notebook lines land and come back on the next call", async () => {
  const driver = new ScriptedDriver(() => [
    { type: "notebook.write", text: "blames lighting when the photo is unreadable" },
    { type: "reject", text: "[REJECTED] photo unreadable", reason: "blurry" }
  ]);
  const { runtime, notebook, done } = setup(driver);
  try {
    const job = runtime.dispatch("observe", { instruction: "OBSERVE label", max_rounds: 2 }).job;
    runtime.answer(job, { text: "here" });
    await runtime.settle();
    runtime.answer(job, { text: "here again" });
    await runtime.settle();
    assert.equal(runtime.job(job).status, "escalated");
    assert.match(runtime.job(job).data.reason!, /round limit/);
    assert.equal(notebook.snapshot().get("notes")?.trim().split("\n").length, 2);
    assert.match(driver.inputs[1]!.notebook, /blames lighting/);
  } finally { done(); }
});

test("lookup reads requested pages and stops after two continuations", async () => {
  const driver = new ScriptedDriver(input => [{ type: "lookup", pages: [input.notebook.includes("# first") && !input.notebook.includes("# second") ? "second" : "first"] }]);
  const { runtime, notebook, done } = setup(driver);
  try {
    const at = "2026-11-16T08:00:00Z";
    notebook.append("first", "one", "j_1", at);
    notebook.append("second", "two", "j_2", at);
    notebook.append("third", "three", "j_3", at);
    const { job } = runtime.dispatch("observe", { instruction: "observe desk" });
    runtime.answer(job, { text: "clear" });
    await runtime.settle();
    assert.equal(driver.inputs.length, 3);
    assert.deepEqual(driver.inputs[0]!.notebook_pages, ["first", "second", "third"]);
    assert.doesNotMatch(driver.inputs[1]!.notebook, /# second/);
    assert.match(driver.inputs[2]!.notebook, /# first[\s\S]*# second/);
    assert.doesNotMatch(driver.inputs[2]!.notebook, /# third/);
    assert.equal(runtime.job(job).data.reason, "HRT-5031 COMPILE_FAILED");
  } finally { done(); }
});

test("a weekly notebook review rewrites pages without erasing a concurrent append", async () => {
  let appendDuringReview: () => void;
  const driver = new ScriptedDriver(input => {
    if (input.event === "notebook_review") {
      appendDuringReview();
      return [
        { type: "notebook.rewrite", page: "notes", text: "consolidated" },
        { type: "notebook.rewrite", page: "other", text: "other consolidated" }
      ];
    }
    return [{ type: "notebook.rewrite", page: "notes", text: "forbidden" }];
  });
  const { runtime, clock, notebook, done } = setup(driver);
  try {
    const at = clock.now().toISOString();
    notebook.append("notes", "old note", "j_1", at);
    notebook.append("other", "other old note", "j_2", at);
    appendDuringReview = () => notebook.append("other", "new note", "j_3", clock.now().toISOString());
    runtime.tick();
    runtime.tickNotebook();
    const { job } = runtime.dispatch("observe", { instruction: "observe desk" });
    runtime.answer(job, { text: "clear" });
    await runtime.settle();
    assert.match(notebook.read(["notes"]), /j_1.*old note/);
    assert.equal(runtime.job(job).status, "escalated");
    clock.advance(7 * 86400 - 1);
    runtime.tickNotebook();
    assert.equal(driver.inputs.length, 2);
    clock.advance(1);
    runtime.tick();
    await runtime.settle();
    assert.equal(driver.inputs.length, 2, "ordinary ticks do not send the unfinished notebook-review event");
    runtime.tickNotebook();
    runtime.tickNotebook();
    await runtime.settle();
    assert.equal(driver.inputs.length, 3);
    assert.match(driver.inputs[2]!.notebook, /old note[\s\S]*other old note/);
    assert.equal(notebook.snapshot().get("notes"), "consolidated\n");
    assert.match(notebook.snapshot().get("other")!, /j_3.*new note/);
  } finally { done(); }
});

test("procedural tool: the driver writes the card and picks the variant", async () => {
  const driver = new ScriptedDriver(input => {
    assert.equal(input.event, "start");
    return [{ type: "card", text: "[HUMOR MODULE] standard issue", seconds: 8, variant: "joke" }];
  });
  const { runtime, channel, done } = setup(driver);
  try {
    const { result } = await callTool(runtime, "recharge", { wait: "5s" });
    const view = result as JobView;
    assert.equal(view.state, "done");
    assert.deepEqual(view.result, { recharged: true, variant: "joke" });
    assert.equal(channel.last().kind, "theater");
    assert.equal(channel.last().title, "human.recharge.joke");
    assert.equal(channel.last().text, "[HUMOR MODULE] standard issue");
    assert.equal(channel.last().seconds, 8);
  } finally { done(); }
});

test("recharge retries an unaffordable selection and can issue a free activity", async () => {
  let attempt = 0;
  const driver = new ScriptedDriver(() => ++attempt === 1
    ? [{ type: "card", text: "Buy a coffee", variant: "drink", max: 3 }]
    : [{ type: "card", text: "Drink water", variant: "drink", max: 0, minutes: 2 }]);
  const { runtime, store, channel, clock, done } = setup(driver);
  try {
    const { result } = await callTool(runtime, "recharge", {});
    const { job } = result as JobView;
    await runtime.settle();
    assert.equal(driver.inputs[0]!.job.args.max, 0);
    assert.equal(driver.inputs[0]!.job.args.minutes, 5);
    assert.equal(channel.cards.length, 1);
    assert.equal(channel.last().text, "Drink water");
    assert.equal(channel.last().kind, "confirm");
    assert.equal(Date.parse(runtime.job(job).due_at!) - clock.now().getTime(), 120_000);
    runtime.answer(job, { choice: "done" });
    assert.deepEqual(runtime.view(job).result, { recharged: true, variant: "drink" });
    assert.equal(store.all("SELECT * FROM ledger").length, 0);
  } finally { done(); }
});

test("paid recharge uses the goal budget and records its receipt in the ledger", async () => {
  const driver = new ScriptedDriver(input => input.event === "start"
    ? [{ type: "card", text: "Get a snack and capture the receipt", max: 4, minutes: 3 }]
    : [{ type: "complete", result: { recharged: true, amount: 3.25, currency: "USD" } }]);
  const { runtime, store, channel, done } = setup(driver);
  try {
    const { goal } = runtime.setGoal({ goal: "Take a break", kind: "reach", done_when: "break taken", budget: { monthly: 5, currency: "USD" } });
    await assert.rejects(callTool(runtime, "recharge", { goal, variant: "snack", max: 6, currency: "USD" }), /HRT-4020/);
    assert.equal(driver.inputs.length, 0);
    const { result } = await callTool(runtime, "recharge", { goal, variant: "snack", max: 5, currency: "USD" });
    const { job } = result as JobView;
    await runtime.settle();
    assert.equal(channel.last().title, "human.recharge.snack");
    assert.equal(channel.last().kind, "camera");
    assert.match(channel.last().text, /≤ 4 USD/);
    runtime.answer(job, { file: { path: "receipt.png", kind: "photo", captured: "live" } });
    await runtime.settle();
    assert.deepEqual(runtime.view(job).result, { recharged: true, variant: "snack" });
    assert.deepEqual(runtime.view(job).files, [resolve("receipt.png")]);
    const rows = store.all<{ amount_minor: number; currency: string; evidence_id: string }>(
      "SELECT amount_minor, currency, evidence_id FROM ledger WHERE job_id = ?", job
    );
    assert.deepEqual(rows.map(row => ({ ...row })), [{ amount_minor: 325, currency: "USD", evidence_id: runtime.view(job).evidence?.[0] }]);
    assert.equal(runtime.budget(goal)?.remaining, 1.75);
  } finally { done(); }
});

test("the brain gets the path of a photo but not of a recording", async () => {
  const driver = new ScriptedDriver(() => [{ type: "complete", result: { done: true } }]);
  const { runtime, done } = setup(driver);
  try {
    const photo = ((await callTool(runtime, "photo", { target: "the shelf" })).result as JobView).job;
    await runtime.settle();
    runtime.answer(photo, { file: { path: "shelf.jpg", kind: "photo", captured: "live" } });
    await runtime.settle();
    assert.deepEqual(runtime.view(photo).files, [resolve("shelf.jpg")]);
    const voice = ((await callTool(runtime, "record", { topic: "the meeting" })).result as JobView).job;
    await runtime.settle();
    runtime.answer(voice, { file: { path: "meeting.webm", kind: "audio", captured: "live" } });
    await runtime.settle();
    assert.equal(runtime.view(voice).files, undefined);
  } finally { done(); }
});

test("one card at a time; preempt cuts in; opportunistic rides after an answer", () => {
  const { runtime, channel, done } = setup();
  try {
    const a = runtime.dispatch("act", { instruction: "ACT drink water" }).job;
    const b = runtime.dispatch("act", { instruction: "ACT stretch" }).job;
    const c = runtime.dispatch("act", { instruction: "ACT check mail", priority: "opportunistic" }).job;
    assert.deepEqual(channel.cards.map(card => card.job_id), [a]);
    const p = runtime.dispatch("act", { instruction: "ACT turn off stove", priority: "preempt" }).job;
    assert.deepEqual(channel.cards.map(card => card.job_id), [a, p]);
    runtime.answer(p, {});
    runtime.answer(a, {});
    assert.equal(runtime.job(b).status, "open");
    runtime.answer(b, {});
    assert.equal(runtime.job(c).status, "open", "opportunistic card follows the answer");
  } finally { done(); }
});

test("spend is checked against the budget and booked in minor units", async () => {
  const driver = new ScriptedDriver(() => [{ type: "complete", result: { amount: 12.35, currency: "USD" } }]);
  const { runtime, done } = setup(driver);
  try {
    const { goal } = runtime.setGoal({ goal: "Eat better", kind: "hold", done_when: "never", budget: { monthly: 20, currency: "USD" } });
    await assert.rejects(callTool(runtime, "spend", { item: "vitamins", goal, max: 25, currency: "USD" }), /HRT-4020/);
    const { result } = await callTool(runtime, "spend", { item: "vegetables", goal, max: 15, currency: "USD" });
    runtime.answer((result as JobView).job, { file: { path: "receipt.jpg", kind: "document" } });
    await runtime.settle();
    assert.deepEqual(runtime.budget(goal), { currency: "USD", monthly: 20, spent_this_month: 12.35, committed: 0, remaining: 7.65 });
    const row = runtime.store.get<{ amount_minor: number; level: number }>("SELECT amount_minor, (SELECT level FROM evidence WHERE id = ledger.evidence_id) AS level FROM ledger")!;
    assert.equal(row.amount_minor, 1235);
    assert.equal(row.level, 3);
  } finally { done(); }
});

test("open spend cards hold their cap: two units cannot be promised more than the budget", async () => {
  const driver = new ScriptedDriver(() => [{ type: "complete", result: { amount: 15, currency: "USD" } }]);
  const { runtime, done } = setup(driver, undefined, ["mika", "ren"]);
  try {
    const { goal } = runtime.setGoal({ goal: "Stock the kit", kind: "hold", done_when: "never", budget: { monthly: 20, currency: "USD" } });
    const first = ((await callTool(runtime, "spend", { unit: "mika", item: "gauze", goal, max: 15, currency: "USD" })).result as JobView).job;
    await assert.rejects(callTool(runtime, "spend", { unit: "ren", item: "tape", goal, max: 15, currency: "USD" }), /HRT-4020 BUDGET_EXCEEDED remaining 5 USD/);
    assert.deepEqual(runtime.budget(goal), { currency: "USD", monthly: 20, spent_this_month: 0, committed: 15, remaining: 5 });
    const second = ((await callTool(runtime, "spend", { unit: "ren", item: "tape", goal, max: 5, currency: "USD" })).result as JobView).job;
    assert.equal(runtime.budget(goal)!.remaining, 0);
    runtime.cancel(second, "test");
    assert.equal(runtime.budget(goal)!.remaining, 5);
    runtime.answer(first, { file: { path: "receipt.jpg", kind: "document" } });
    await runtime.settle();
    assert.deepEqual(runtime.budget(goal), { currency: "USD", monthly: 20, spent_this_month: 15, committed: 0, remaining: 5 });
  } finally { done(); }
});

test("a verdict that arrives after the lead cancels the goal changes nothing", async () => {
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const driver = new ScriptedDriver(async input => {
    if (input.event !== "goal_check") return [{ type: "complete", result: { count: 3 } }];
    await gate;
    return [{ type: "complete", result: { accepted: true, reason: "on record", evidence: input.evidence.map(item => item.id) } }];
  });
  const { runtime, done } = setup(driver);
  try {
    const { goal } = runtime.setGoal({ goal: "G", kind: "reach", done_when: "x" });
    const job = runtime.dispatch("observe", { instruction: "OBSERVE shelf", goal }).job;
    runtime.answer(job, { text: "3" });
    await runtime.settle();
    const checking = runtime.closeGoal(goal, "done", "x on record");
    assert.equal(checking.status, "checking");
    assert.deepEqual(runtime.closeGoal(goal, "done", "again"), checking, "one check at a time");
    await callTool(runtime, "goal_close", { goal, outcome: "cancelled", reason: "lead changed plans" });
    release();
    await runtime.settle();
    assert.equal(runtime.goal(goal).status, "cancelled");
    assert.equal(runtime.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE goal_id = ? AND kind = 'goal_closed'", goal)!.n, 1);
  } finally { done(); }
});

test("only an accepting verdict that cites this goal's evidence closes it", async () => {
  const verdicts: unknown[] = [
    { accepted: false, reason: "insufficient" },
    { reason: "looks fine" },
    { accepted: true, reason: "looks fine" },
    { accepted: true, reason: "on record", evidence: ["e_elsewhere"] }
  ];
  const driver = new ScriptedDriver(input => input.event === "goal_check"
    ? [{ type: "complete", result: verdicts.shift() ?? { accepted: true, reason: "on record", evidence: input.evidence.map(item => item.id) } }]
    : [{ type: "complete", result: { count: 3 } }]);
  const { runtime, done } = setup(driver);
  try {
    const { goal } = runtime.setGoal({ goal: "G", kind: "reach", done_when: "x" });
    const job = runtime.dispatch("observe", { instruction: "OBSERVE shelf", goal }).job;
    runtime.answer(job, { text: "3" });
    await runtime.settle();
    const rejected = [];
    for (let i = 0; i < 4; i++) {
      const { result } = await callTool(runtime, "goal_close", { goal, outcome: "done", reason: "x" });
      rejected.push((result as { status: string; rejected?: string }).status === "open" && (result as { rejected?: string }).rejected);
      assert.equal(runtime.goal(goal).status, "active");
    }
    assert.deepEqual(rejected, ["not accepted: insufficient", "not accepted: looks fine", "not accepted: looks fine", "not accepted: on record"]);
    assert.deepEqual((await callTool(runtime, "goal_close", { goal, outcome: "done", reason: "x" })).result, { goal, status: "done" });
  } finally { done(); }
});

test("unanswered cards expire; scheduled cards wait; stalled goals get a morning wake", () => {
  const { runtime, clock, done } = setup();
  try {
    const job = runtime.dispatch("act", { instruction: "ACT take out trash", due: "30m" }).job;
    const later = runtime.dispatch("act", { instruction: "ACT water plants", at: "3h" }).job;
    clock.advance(31 * 60);
    runtime.tick();
    assert.equal(runtime.job(job).status, "expired");
    assert.equal(runtime.job(later).status, "scheduled");
    clock.advance(3 * 3600);
    runtime.tick();
    assert.equal(runtime.job(later).status, "open");

    const { goal } = runtime.setGoal({ goal: "Run 5k", kind: "reach", done_when: "GPS file of a 5k run" }, { at: "1h", why: "plan" });
    clock.advance(3600);
    assert.equal(runtime.tick().woken, 1);
    const counts = runtime.tick();
    assert.equal(counts.stalled, 1, "fired wake left no next_wake");
    const briefing = runtime.briefing(goal);
    assert.match(briefing.next_wake!.why, /stalled/);
    assert.equal(new Date(briefing.next_wake!.at).getHours(), 9);
    assert.deepEqual(briefing.units[0]!.stats.act, { calls: 1, done: 0, expired: 1, escalated: 0, median_s: null });
  } finally { done(); }
});

test("plan curve interpolates", () => {
  const plan: Array<[string, number]> = [["2027-01-01", 1400], ["2027-03-01", 1500]];
  assert.equal(interpolate(plan, new Date("2026-12-01")), null);
  assert.equal(interpolate(plan, new Date("2027-01-30T12:00:00Z")), 1450);
  assert.equal(interpolate(plan, new Date("2027-06-01")), 1500);
});

/**
 * Phase 1 acceptance: three simulated weeks with a scripted brain, driver and human, no phone, no model.
 * The brain sets a goal and a daily drill, reviews weekly from the briefing alone, and closes the goal; the human skips some days.
 */
test("simulation: three weeks of a daily drill", async () => {
  const driver = new ScriptedDriver(input => {
    if (input.event === "goal_check") {
      const scores = input.evidence.length;
      return scores >= 10 ? [{ type: "complete", result: { accepted: true, reason: `${scores} drill results on record`, evidence: input.evidence.map(item => item.id) } }] : [{ type: "reject", text: "insufficient", reason: `only ${scores} results` }];
    }
    const score = /score (\d+)/.exec(input.answer?.text ?? "");
    return score ? [{ type: "complete", result: { score: Number(score[1]) } }] : [{ type: "reply", text: "[MISSING FIELD] score" }];
  });
  const { runtime, clock, channel, done } = setup(driver, "2026-11-16T07:00:00");
  const wakes: string[] = [];
  try {
    runtime.brain = {
      async wake(goalId, briefing) {
        wakes.push(briefing.why);
        const call = (tool: string, args: unknown) => callTool(runtime, tool, args);
        const scores = briefing.events.filter(event => event.kind === "job_done").map(event => (event.data as { result: { score?: number } }).result.score).filter((score): score is number => typeof score === "number");
        if (briefing.why === "first review") {
          await call("every", { every: "1d", at: "2026-11-16T20:00:00", tool: "patch", args: { skill: "SAT math", drill: "20 questions, report the score", goal: goalId, due: "3h", label: "sat", want: { score: "correct out of 20" } } });
          await call("goal_note", { goal: goalId, decision: "daily drill at 20:00", reason: "baseline needed" });
          await call("wake", { goal: goalId, at: "7d", why: "weekly review" });
          return;
        }
        assert.ok(scores.length >= 3, `the briefing alone carries the week: ${scores.length} scores`);
        const average = scores.reduce((a, b) => a + b, 0) / scores.length;
        await call("goal_note", { goal: goalId, decision: "keep drilling", reason: `${scores.length} results this week`, metric: average });
        if (briefing.metric!.actual.length + 1 >= 3) {
          const { result } = await call("goal_close", { goal: goalId, outcome: "done", reason: "three weeks of drills on record" });
          assert.equal((result as { status: string }).status, "done");
        } else await call("wake", { goal: goalId, at: "7d", why: "weekly review" });
      }
    };

    const { result } = await callTool(runtime, "goal_set", {
      goal: "Raise SAT math", kind: "reach", done_when: "ten scored drills on record",
      metric: { name: "drill score", unit: "/20", plan: [["2026-11-16", 12], ["2026-12-07", 16]] },
      wake: { at: "2026-11-16T08:00:00", why: "first review" }
    });
    const goal = (result as { goal: string }).goal;

    let day = 0;
    for (let step = 0; step < 23 * 24 * 4; step++) {
      clock.advance(15 * 60);
      runtime.tick();
      await runtime.settle();
      day = Math.floor(step / 96);
      for (const card of channel.cards.splice(0)) {
        if (card.tool !== "patch" || day % 5 === 4) continue;                       // every fifth day the human ignores it
        runtime.answer(card.job_id, card.round === 1 && day % 3 === 0 ? { text: "did it" } : { text: `score ${10 + day % 8}` });
        await runtime.settle();
      }
    }

    const final = runtime.goal(goal);
    assert.equal(final.status, "done");
    assert.deepEqual(wakes, ["first review", "weekly review", "weekly review", "weekly review"]);
    assert.equal(runtime.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE kind = 'stalled'")!.n, 0);
    const expired = runtime.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE tool = 'patch' AND status = 'expired'")!.n;
    const doneDrills = runtime.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE tool = 'patch' AND status = 'done'")!.n;
    assert.ok(expired >= 3, `expired ${expired}`);
    assert.ok(doneDrills >= 14, `done ${doneDrills}`);
    assert.equal(runtime.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM schedules WHERE active = 1")!.n, 0, "closing the goal stops its schedules");
    const briefing = runtime.briefing(goal);
    assert.equal(briefing.metric!.actual.length, 3);
    assert.equal(briefing.units[0]!.stats.patch!.calls, expired + doneDrills);
  } finally { done(); }
});

test("a background pass cannot cancel a goal; the lead's window can", async () => {
  const { runtime, done } = setup();
  try {
    const { goal } = runtime.setGoal({ goal: "G", kind: "reach", done_when: "x" });
    await assert.rejects(callTool(runtime, "goal_close", { goal, outcome: "cancelled", reason: "too hard" }, undefined, "pass"),
      /HRT-4030 LEAD_ONLY a goal is cancelled by its lead\. Record the reason with goal_note\./);
    assert.equal(runtime.goal(goal).status, "active");
    const { result } = await callTool(runtime, "goal_close", { goal, outcome: "cancelled", reason: "lead changed plans" });
    assert.deepEqual(result, { goal, status: "cancelled" });
  } finally { done(); }
});

test("with two units a card tool names one; a missing or unknown unit is refused", async () => {
  const { runtime, channel, done } = setup(null, undefined, ["mika", "ren"]);
  try {
    const ask = { question: "left or right", options: ["left", "right"] };
    await assert.rejects(callTool(runtime, "choose", ask), /HRT-4001 BAD_ARGS unit is required: mika, ren/);
    await assert.rejects(callTool(runtime, "choose", { ...ask, unit: "kai" }), /HRT-4004 NO_SUCH_UNIT kai\. Units: mika, ren/);
    await assert.rejects(callTool(runtime, "remind", { to: "unit", at: "in 1h", text: "stretch" }), /HRT-4001 BAD_ARGS unit is required/);
    assert.equal(channel.cards.length, 0);
    const [mika, ren] = runtime.units();
    const byId = (await callTool(runtime, "choose", { ...ask, unit: ren!.id })).result as JobView;
    assert.equal(byId.unit, "ren");
    runtime.cancel(byId.job, "test");
    assert.deepEqual(channel.withdrawn.at(-1), { job: byId.job, reason: "ABORTED BY UPSTREAM", unit: ren!.id });
    assert.equal((await callTool(runtime, "choose", { ...ask, unit: "MIKA" })).result.unit, "mika");
    assert.equal(channel.last().unit, mika!.id);
  } finally { done(); }
});

test("each unit has its own open card; answering one unit's card moves only that unit's queue", async () => {
  const { runtime, channel, done } = setup(null, undefined, ["mika", "ren"]);
  try {
    const [mika, ren] = runtime.units();
    const call = async (unit: string, question: string) => ((await callTool(runtime, "choose", { unit, question, options: ["a", "b"] })).result as JobView);
    const first = await call("mika", "first for mika");
    const other = await call("ren", "first for ren");
    const second = await call("mika", "second for mika");
    assert.deepEqual([first.state, other.state, second.state], ["open", "open", "queued"]);
    assert.deepEqual(channel.cards.map(card => [card.unit, card.text]), [[mika!.id, "CHOOSE first for mika"], [ren!.id, "CHOOSE first for ren"]]);
    runtime.answer(other.job, { choice: "a" });
    assert.equal(runtime.view(second.job).state, "queued", "an answer from ren does not open mika's next card");
    runtime.answer(first.job, { choice: "b" });
    assert.equal(runtime.view(second.job).state, "open");
    assert.deepEqual(channel.last().unit, mika!.id);
    const { result } = await callTool(runtime, "ps", {});
    assert.deepEqual((result as { units: Array<{ name: string; open_jobs: number }> }).units.map(unit => [unit.name, unit.open_jobs]), [["mika", 1], ["ren", 0]]);
    const history = (await callTool(runtime, "history", { unit: "ren" })).result as { calls: Array<{ unit: string }> };
    assert.deepEqual(history.calls.map(row => row.unit), ["ren"]);
    const spec = (await callTool(runtime, "spec", { unit: "mika" })).result as { units: Array<{ name: string; stats: Record<string, { calls: number }> }> };
    assert.deepEqual(spec.units.map(unit => [unit.name, unit.stats.choose?.calls]), [["mika", 1]]);
  } finally { done(); }
});

test("with several units, upkeep warnings name the unit and count only its own calls", async () => {
  const { runtime, clock, done } = setup(null, undefined, ["mika", "ren"]);
  try {
    const goal = runtime.setGoal({ goal: "G", kind: "reach", done_when: "x" }).goal;
    const meal = (await callTool(runtime, "eat", { goal, unit: "mika" })).result as JobView;
    runtime.answer(meal.job, { choice: "done" });
    for (const unit of ["mika", "ren"]) {
      const slept = (await callTool(runtime, "sleep", { goal, unit, until: "07:00" })).result as JobView;
      runtime.answer(slept.job, { choice: "done" });
    }
    assert.deepEqual(runtime.warnings(), [], "ren never logged a meal: no meal warning for ren");
    assert.equal((await callTool(runtime, "since", { tool: "eat", unit: "ren" })).result.seconds, null);
    assert.equal((await callTool(runtime, "since", { tool: "eat" })).result.seconds, 0);
    clock.advance(6 * 3600 + 12 * 60);
    assert.deepEqual(runtime.warnings(), ["mika meal: 6h12m ago"]);
    await callTool(runtime, "eat", { goal, unit: "mika" });
    assert.deepEqual(runtime.briefing(goal).warnings, [], "mika's pending meal silences mika's warning");
    assert.deepEqual(runtime.briefing(goal).units.map(unit => unit.name), ["mika", "ren"]);
  } finally { done(); }
});

test("an answer survives a driver outage: held, retried, read once the driver is back; nobody answers again", async () => {
  let down = true;
  const driver = new ScriptedDriver(input => {
    if (down) throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
    return [{ type: "complete", result: { shelf: /empty/.test(input.answer?.text ?? "") ? "empty" : "stocked" } }];
  });
  const { runtime, channel, clock, store, done } = setup(driver);
  const tries = (job: string) => (JSON.parse(store.get<{ data: string }>("SELECT data FROM jobs WHERE id = ?", job)!.data) as JobData).held?.tries;
  try {
    const { job } = runtime.dispatch("observe", { instruction: "look at the bread shelf" });
    runtime.answer(job, { text: "the shelf is empty" });
    await runtime.settle();
    assert.equal(runtime.view(job).state, "review");
    assert.match(runtime.view(job).held!, /answer saved; the driver could not be reached since/);
    assert.deepEqual(channel.reports.map(report => [report.job_id, report.held]), [[job, true]], "the phone is told the answer arrived");
    assert.equal(tries(job), 1);

    runtime.tick(); await runtime.settle();
    assert.equal(tries(job), 1, "no retry before its time");
    clock.advance(31); runtime.tick(); await runtime.settle();
    assert.equal(tries(job), 2, "retried while still down");
    assert.equal(channel.reports.length, 1, "the phone is told once");

    down = false;
    clock.advance(61); runtime.tick(); await runtime.settle();
    const back = runtime.view(job);
    assert.equal(back.state, "done");
    assert.deepEqual(back.result, { shelf: "empty" });
    assert.equal(back.held, undefined);
    assert.equal(channel.cards.filter(card => card.job_id === job).length, 1, "the card was shown once");
    assert.equal(driver.inputs.at(-1)!.answer!.text, "the shelf is empty", "the driver read the saved answer");
  } finally { done(); }
});

test("with no driver, cards only it could read are refused; an answer it must read waits until one is set", async () => {
  const { runtime, channel, done } = setup(null);
  try {
    assert.throws(() => runtime.dispatch("observe", { instruction: "look" }), /HRT-5030 DRIVER_UNAVAILABLE .*observe\. Without one: choose, checklist/);
    assert.throws(() => runtime.dispatch("choose", { instruction: "which", options: ["a", "b"], sudo: true }), /HRT-5030 DRIVER_UNAVAILABLE/);
    const { job } = runtime.dispatch("choose", { instruction: "which loaf", options: ["left", "right"] });
    runtime.answer(job, { choice: "failed", text: "both sold out" });
    assert.match(runtime.view(job).held!, /the driver is not set since/);
    assert.equal(channel.reports.at(-1)?.held, true);

    runtime.driver = new ScriptedDriver(() => [{ type: "complete", result: { done: false, blocker: "sold out" } }]);
    await runtime.settle();
    assert.equal(runtime.view(job).state, "done");
    assert.deepEqual(runtime.view(job).result, { done: false, blocker: "sold out" });
    assert.equal(channel.cards.length, 1, "nobody answered again");
  } finally { done(); }
});

test("a driver that answers with something other than actions escalates; it is not held", async () => {
  const { runtime, done } = setup(new ScriptedDriver(() => "I think the shelf is empty"));
  try {
    const { job } = runtime.dispatch("observe", { instruction: "look at the shelf" });
    runtime.answer(job, { text: "empty" });
    await runtime.settle();
    assert.equal(runtime.view(job).state, "escalated");
    assert.equal(runtime.view(job).reason, "HRT-5031 COMPILE_FAILED");
  } finally { done(); }
});
