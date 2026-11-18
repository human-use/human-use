import * as z from "zod/v4";
import { HumanUseError, RECEIPT_WANT, RECHARGE_VARIANTS, type DispatchArgs, type InboxItem, type JobView, type Runtime } from "./runtime.js";
import { parseDuration } from "./time.js";

/**
 * Input schemas and routing for every tool the brain can call. Shared by the MCP server (schemas) and the daemon
 * (execution), so the two can't drift.
 *
 * The brain hands over parameters, never prose for a person (docs/DESIGN.md §五). Each human tool declares short
 * fields and a template that turns them into the task line on the card.
 */

type Args = Record<string, any>;  // eslint-disable-line @typescript-eslint/no-explicit-any

/** Longest one tool call may block. Below undici's 300 s header timeout and typical host tool limits. */
const waitCapMs = () => Number(process.env.HUMAN_USE_WAIT_CAP_S ?? 240) * 1000;

const text = (description: string) => z.string().min(1).describe(description);

const want = z.record(z.string(), z.string()).optional();
const nonce = z.boolean().optional().describe("Require a one-time gesture in frame, proving the photo is live.");

const unit = z.string().min(1).optional().describe("Unit name or id. Required when more than one unit is paired.");

const common = {
  unit,
  goal: z.string().optional().describe("Goal id this call serves. Omit for a single call."),
  priority: z.enum(["opportunistic", "standard", "preempt"]).optional().describe("Opportunistic waits for the unit to pick up the phone, standard shows now, preempt interrupts."),
  at: z.string().optional().describe("Send at an ISO time or after a duration such as 2h."),
  due: z.string().optional().describe("Expire this long after the card is shown, e.g. 30m."),
  wait: z.string().optional().describe(`Block for the result: a duration ("90s", "10m") or "done". Omit when the next step does not need the answer. If "done" reaches the host's call limit it returns the open job: call the wait tool with the same job to keep waiting. In a background pass nothing blocks: the call returns at once and the runtime wakes the goal when the job settles.`),
  label: z.string().optional().describe("Tag for since() counting, e.g. sat-drill."),
  sudo: z.boolean().optional().describe(`The unit's word does not settle this call: "done" needs evidence, "cannot" gets checked. Slower, and the unit dislikes it. Use it when a decision rides on the result.`)
};

interface HumanTool {
  schema: z.ZodObject;
  /** The task line on the card, built from the parameters. */
  line(args: Args): string;
  extra?(args: Args): Partial<DispatchArgs>;
}

const def = (shape: Record<string, z.ZodType>, line: (args: Args) => string, extra?: (args: Args) => Partial<DispatchArgs>): HumanTool =>
  ({ schema: z.object({ ...shape, ...common }), line, ...(extra ? { extra } : {}) });

export const BENCH_VARIANTS = ["assets", "hours", "screen_time"] as const;

export const HUMAN: Record<string, HumanTool> = {
  observe: def({ target: text("Physical target to inspect."), want }, a => `OBSERVE ${a.target}`),
  photo: def({ target: text("What must be in frame. Noun phrase."), nonce, want }, a => `PHOTO ${a.target}`),
  record: def({ topic: text("What to say or capture."), seconds: z.number().int().positive().max(600).optional(), want }, a => `RECORD ${a.topic}${a.seconds ? ` ≤${a.seconds}s` : ""}`),
  verify: def({ claim: text("A statement to check on site, e.g. 'stove is off'."), nonce, want }, a => `VERIFY ${a.claim}`,
    a => ({ want: a.want ?? { holds: "true if the claim holds, false if it does not" } })),
  status: def({}, () => "STATUS", () => ({ want: { location: "where the unit is", energy: "1 to 5", busy_until: "a time, or null" } })),
  go: def({ place: text("Destination.") }, a => `GO ${a.place}`),
  act: def({ action: text("One action. Imperative, a few words.") }, a => `ACT ${a.action}`),
  checklist: def({ title: z.string().optional(), steps: z.array(z.string().min(1)).min(1).describe("Each step imperative, a few words.") }, a => `CHECKLIST${a.title ? ` ${a.title}` : ""}`),
  errand: def({ place: text("Where."), task: text("What to do or get there. Imperative."), want }, a => `ERRAND ${a.place}: ${a.task}`),
  choose: def({ question: text("What is being decided. One line."), options: z.array(z.string().min(1)).min(2).max(6) }, a => `CHOOSE ${a.question}`),
  decode: def({ material: text("The text to read, verbatim."), question: text("What to judge about it."), options: z.array(z.string().min(1)).min(2).optional(), want },
    a => `DECODE ${a.question}\n---\n${a.material}`),
  spend: def({ item: text("What to buy."), max: z.number().positive().describe("Ceiling in major units, e.g. 12.50."), currency: z.string().length(3) },
    a => `SPEND ${a.item} ≤ ${a.max} ${a.currency}`, () => ({ want: RECEIPT_WANT })),
  eat: def({ meal: z.string().optional().describe("What to eat, if it matters.") }, a => `EAT${a.meal ? ` ${a.meal}` : ""}`),
  sleep: def({ until: text("Wake time, e.g. 07:00.") }, a => `SLEEP until ${a.until}`),
  rest: def({ minutes: z.number().int().positive().max(240) }, a => `REST ${a.minutes}m`),
  recharge: def({ variant: z.enum(RECHARGE_VARIANTS).optional().describe("Omit to let the system pick what works on this unit."),
    minutes: z.number().int().positive().max(240).optional(), max: z.number().nonnegative().optional(),
    currency: z.string().regex(/^[A-Za-z]{3}$/).transform(value => value.toUpperCase()).optional() },
    a => `RECHARGE${a.variant ? ` ${a.variant}` : ""}`, a => ({ variant: a.variant, minutes: a.minutes })),
  mood: def({}, () => "MOOD 1–5"),
  patch: def({ skill: text("The skill being trained."), drill: text("One drill with a measurable result."), want }, a => `PATCH ${a.skill}: ${a.drill}`),
  bench: def({ variant: z.enum(BENCH_VARIANTS).optional() }, a => `BENCH${a.variant ? ` ${a.variant}` : ""}`, a => ({ variant: a.variant }))
};

const HUMAN_INPUTS: Record<string, z.ZodObject> = Object.fromEntries(Object.entries(HUMAN).map(([name, tool]) => [name, tool.schema]));

const goalData = {
  goal: z.string().min(1).describe("The goal in the lead's words."),
  kind: z.enum(["reach", "hold"]).describe("reach: done once achieved. hold: keep a metric in range indefinitely."),
  done_when: z.string().min(1).describe("What evidence closes the goal. Prefer evidence high on the ladder: runtime-held, public URL, third-party issued."),
  deadline: z.string().optional(),
  metric: z.object({ name: z.string(), unit: z.string().optional(), plan: z.array(z.tuple([z.string(), z.number()])) }).optional()
    .describe("Planned curve: [[date, value], ...]. The briefing shows expected against actual."),
  milestones: z.array(z.object({ what: z.string(), evidence: z.string() })).optional(),
  budget: z.object({ monthly: z.number().nonnegative(), currency: z.string().length(3) }).optional()
};

/** A human tool call nested inside at/every. Validated against that tool's own schema at execution. */
const nested = z.record(z.string(), z.unknown());

export const OTHER_INPUTS = {
  ps: z.object({ goal: z.string().optional() }),
  spec: z.object({ goal: z.string().optional(), unit: unit.describe("Only this unit. Omit for every unit.") }),
  history: z.object({ goal: z.string().optional(), tool: z.string().optional(), unit: unit.describe("Only this unit's calls. Omit for every unit."), limit: z.number().int().positive().max(200).optional() }),
  at: z.object({ at: z.string(), tool: z.string(), args: nested }),
  every: z.object({ every: z.string().describe("30m, 1d, 1w"), at: z.string().optional().describe("First run. Default: one interval from now."), tool: z.string(), args: nested }),
  since: z.object({ tool: z.string().optional(), label: z.string().optional(), goal: z.string().optional(), unit: unit.describe("Only this unit. Omit to count every unit.") }),
  remind: z.object({ to: z.enum(["unit", "agent"]), at: z.string(), text: z.string().min(1), goal: z.string().optional(), unit }),
  wake: z.object({ goal: z.string(), at: z.string().describe("ISO time, or a duration such as 1d."), why: z.string().min(1) }),
  wait: z.object({ job: z.string(), for: z.string().optional().describe("A duration, or done (default).") }),
  cancel: z.object({ job: z.string().optional(), schedule: z.string().optional() }),
  reschedule: z.object({ job: z.string(), at: z.string() }),
  goal_set: z.object({ ...goalData, wake: z.object({ at: z.string(), why: z.string() }).optional() }),
  goal_get: z.object({ goal: z.string().optional().describe("Omit to list active goals.") }),
  goal_note: z.object({ goal: z.string(), decision: z.string().min(1), reason: z.string().min(1), metric: z.number().optional().describe("Measured value of the goal's metric, if there is one now."), agenda: z.string().min(1).max(1500).optional().describe("Hand-off to the passes after this one: what each of the next few passes does, what you expect to see by then, what you do if it does not show. Replaces the previous agenda; leave it out to keep that one. At most 1500 characters: shorten, do not split.") }),
  goal_close: z.object({ goal: z.string(), outcome: z.enum(["done", "cancelled"]), reason: z.string().min(1) })
} satisfies Record<string, z.ZodObject>;

export const INPUTS: Record<string, z.ZodObject> = { ...HUMAN_INPUTS, ...OTHER_INPUTS };

export interface CallResult {
  result: unknown;
  /** Settled results and reminders for the goal this call names, not seen before. */
  events: InboxItem[];
  /** Overdue maintenance. Only on calls that name a goal, only when there is something to report. */
  warnings?: string[];
}

function parse(name: string, raw: unknown): Args {
  const schema = INPUTS[name];
  if (!schema) throw new HumanUseError("HRT-4000", `NO_SUCH_TOOL ${name}`);
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) throw new HumanUseError("HRT-4001", `BAD_ARGS ${z.prettifyError(parsed.error)}`);
  return parsed.data as Args;
}

/** Parameters → what the runtime stores and shows. */
function toDispatch(name: string, args: Args): DispatchArgs {
  const tool = HUMAN[name]!;
  const { goal, unit: who, priority, at, due, wait: _wait, label, sudo, want: wanted, options, steps, nonce: gesture, max, currency, ...rest } = args;
  return { instruction: tool.line(args), goal, unit: who, priority, at, due, label, sudo, want: wanted, options, steps, nonce: gesture, max, currency, params: rest, ...tool.extra?.(args) };
}

const SETTLED = new Set(["done", "escalated", "expired", "cancelled"]);

async function waitOn(runtime: Runtime, job: string, wait: string | undefined, seat: Seat): Promise<JobView & { note?: string }> {
  if (!wait) return runtime.view(job);
  // A pass has no one to report to, and the person takes minutes to hours. Holding the agent software open
  // for that spends the lead's quota on nothing; the settled job wakes a fresh pass instead.
  if (seat === "pass") {
    const view = runtime.view(job);
    if (SETTLED.has(view.state)) return view;
    return runtime.armWake(job)
      ? { ...runtime.view(job), note: "Open. A pass does not wait on the person: the runtime wakes this goal when the job settles. Put what to do with the result in the agenda, then end the pass." }
      : { ...view, note: "Open, and not on a goal, so nothing wakes on it. Calls in a pass go on the goal." };
  }
  const cap = waitCapMs();
  const wanted = wait === "done" ? Infinity : parseDuration(wait) * 1000;
  const view = await runtime.waitFor(job, Math.min(wanted, cap));
  if (SETTLED.has(view.state)) return view;
  if (wait === "done") {
    const armed = runtime.armWake(job);
    return { ...runtime.view(job), note: armed ? "Still open. The runtime wakes this goal when the job settles; this pass may end." : "Still open. The job has no goal, so nothing will wake you: call wait again." };
  }
  const status = wanted > cap ? `Still open after ${cap / 1000}s, the longest one call can block.` : "Still open.";
  return { ...view, note: `${status} If you need the result, call wait with for: "done" and this job ID.` };
}

/** Who is calling: an agent window the lead sits in, or a background pass the runtime started with no one present. */
export type Seat = "window" | "pass";

/** Execute one tool call against the runtime. */
export async function callTool(runtime: Runtime, name: string, raw: unknown, onJob?: (job: string) => void, seat: Seat = "window"): Promise<CallResult> {
  const args = parse(name, raw);
  const result = await execute(runtime, name, args, onJob, seat);
  const returnedGoal = (result as { goal?: unknown } | null)?.goal;
  const named = name === "goal_set" ? returnedGoal : args.goal ?? returnedGoal
    ?? (name === "every" ? args.args.goal : undefined)
    ?? (name === "cancel" && args.job ? runtime.job(args.job).goal_id : undefined);
  const goal = typeof named === "string" ? named : null;
  const warnings = goal ? runtime.warnings() : [];
  return { result, events: runtime.drain(goal), ...(warnings.length ? { warnings } : {}) };
}

async function execute(runtime: Runtime, name: string, args: Args, onJob: ((job: string) => void) | undefined, seat: Seat): Promise<unknown> {
  if (name in HUMAN) {
    const { job } = runtime.dispatch(name, toDispatch(name, args));
    onJob?.(job);
    return waitOn(runtime, job, args.wait as string | undefined, seat);
  }
  switch (name) {
    case "ps": return { units: runtime.unitStates(), jobs: runtime.ps(), goals: runtime.goals().map(goal => ({ id: goal.id, goal: goal.data.goal })) };
    case "spec": {
      const units = args.unit ? [runtime.unit(args.unit)] : runtime.units();
      return { lang: runtime.lang, units: units.map(unit => ({ name: unit.name, stats: runtime.stats(unit.id) })) };
    }
    case "history": return { calls: runtime.history(args) };
    case "at": {
      if (!(args.tool in HUMAN)) throw new HumanUseError("HRT-4000", `NOT_A_HUMAN_TOOL ${String(args.tool)}`);
      const { job } = runtime.dispatch(args.tool, { ...toDispatch(args.tool, parse(args.tool, args.args)), at: args.at });
      onJob?.(job);
      return runtime.view(job);
    }
    case "every": {
      if (!(args.tool in HUMAN)) throw new HumanUseError("HRT-4000", `NOT_A_HUMAN_TOOL ${String(args.tool)}`);
      return runtime.every({ every: args.every, at: args.at, tool: args.tool, call: toDispatch(args.tool, parse(args.tool, args.args)) });
    }
    case "since": return runtime.since(args);
    case "remind": return runtime.remind({ to: args.to === "unit" ? "human" : "agent", at: args.at, text: args.text, goal: args.goal, unit: args.unit });
    case "wake": return runtime.wake(args.goal, args.at, args.why);
    case "wait":
      onJob?.(args.job);
      return waitOn(runtime, args.job, args.for ?? "done", seat);
    case "cancel": {
      if (args.job) { runtime.cancel(args.job); return { cancelled: args.job }; }
      if (args.schedule) { runtime.stopSchedule(args.schedule); return { stopped: args.schedule }; }
      throw new HumanUseError("HRT-4001", "cancel needs job or schedule");
    }
    case "reschedule": return runtime.reschedule(args.job, args.at);
    case "goal_set": {
      const { wake, ...data } = args as { wake?: { at: string; why: string } } & Parameters<Runtime["setGoal"]>[0];
      const set = runtime.setGoal(data, wake);
      return runtime.brain ? set : { ...set, background: "off. No pass runs when this goal wakes: the wake comes back with the next tool call from an agent window. Scheduled calls (at, every) still go out on time. The lead turns passes on with `human-use config brain <codex|claude>` or under Settings on the lead page." };
    }
    case "goal_get": return args.goal ? runtime.briefing(args.goal) : { goals: runtime.goals().map(goal => ({ id: goal.id, goal: goal.data.goal, kind: goal.data.kind, deadline: goal.data.deadline ?? null })) };
    case "goal_note": {
      runtime.note(args.goal, args.decision, args.reason, args.metric, args.agenda);
      return { noted: true };
    }
    case "goal_close": {
      if (args.outcome === "cancelled" && seat === "pass") throw new HumanUseError("HRT-4030", "LEAD_ONLY a goal is cancelled by its lead. Record the reason with goal_note.");

      const closing = runtime.closeGoal(args.goal, args.outcome, args.reason);
      if (!closing.check_job) return closing;
      await runtime.waitFor(closing.check_job, waitCapMs());
      const check = runtime.job(closing.check_job);
      if (runtime.goal(args.goal).status === "done") return { goal: args.goal, status: "done" };
      if (check.status === "escalated") return { goal: args.goal, status: "open", rejected: check.data.reason ?? "evidence insufficient" };
      return { goal: args.goal, status: "checking" };
    }
  }
  throw new HumanUseError("HRT-4000", `NO_SUCH_TOOL ${name}`);
}
