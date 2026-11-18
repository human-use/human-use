import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import * as z from "zod/v4";
import { find } from "./catalog.js";
import { Store } from "./store.js";
import { addSeconds, monthStart, nextMorning, parseDuration, resolveTime, systemClock, type Clock } from "./time.js";

/**
 * The runtime core: jobs, goals, wakes, ledger, evidence, inbox. Everything here is engineering-layer work in the
 * sense of docs/DESIGN.md §一.11 — isolation, persistence, time, exact counting. Judgment is delegated to the
 * Driver (human input) and the Brain (goals); both are injected so tests can script them.
 */

// ---------------------------------------------------------------- types

export type Priority = "opportunistic" | "standard" | "preempt";
export type JobStatus = "scheduled" | "queued" | "open" | "review" | "done" | "escalated" | "expired" | "cancelled";
export type CardKind = "choice" | "slider" | "checklist" | "form" | "camera" | "audio" | "location" | "confirm" | "theater";

export interface Card {
  job_id: string;
  /** The unit whose phone shows this card. */
  unit: string | null;
  tool: string;
  /** Shown at the top of the card: human.<tool>[.<variant>]. */
  title: string;
  kind: CardKind;
  text: string;
  task?: string | undefined;
  /** Theater cards close themselves after this many seconds. */
  seconds?: number | undefined;
  round: number;
  priority: Priority;
  shown_at?: string | undefined;
  due_at?: string | null | undefined;
  rejected?: string | undefined;
  options?: string[] | undefined;
  steps?: string[] | undefined;
  fields?: Record<string, string> | undefined;
  nonce?: string | undefined;
  /** The unit's word does not settle this call; the phone marks it. */
  sudo?: true | undefined;
}

/** What the human sends back. Channels fill whichever parts their card kind produces. */
export interface Answer {
  choice?: string | undefined;
  value?: number | undefined;
  checked?: number[] | undefined;
  text?: string | undefined;
  file?: { path: string; kind: "photo" | "audio" | "document"; captured?: "live" | "upload" | undefined } | undefined;
  location?: { lat: number; lon: number } | undefined;
}

export interface Round {
  at: string;
  card: string;
  kind?: CardKind | undefined;
  options?: string[] | undefined;
  /** The one-time gesture this card demanded in frame. The driver checks the photo against it. */
  nonce?: string | undefined;
  rejected?: string | undefined;
  answer?: Answer | undefined;
  answered_at?: string | undefined;
}

export interface JobData {
  /** The task line on the card. Rendered from the brain's parameters by a template; the brain never writes card prose. */
  instruction: string;
  /** The brain's parameters, as given. */
  args: Record<string, unknown>;
  variant?: string | undefined;
  recharge_card?: { minutes: number; max: number } | undefined;
  want?: Record<string, string> | undefined;
  label?: string | undefined;
  sudo?: boolean | undefined;
  /** The brain asked to be woken when this settles (wait: "done" outlived the host's call limit). */
  wake_on_settle?: boolean | undefined;
  max_rounds: number;
  rounds: Round[];
  internal?: boolean | undefined;       // driver-made helper card; its result never reaches the brain
  parent?: string | undefined;
  result?: Record<string, unknown> | undefined;
  reason?: string | undefined;
  evidence?: string[] | undefined;
}

export interface Job {
  id: string;
  goal_id: string | null;
  unit_id: string | null;
  tool: string;
  status: JobStatus;
  priority: Priority;
  created_at: string;
  updated_at: string;
  send_at: string | null;
  due_at: string | null;
  data: JobData;
}

export interface GoalData {
  goal: string;
  kind: "reach" | "hold";
  done_when: string;
  deadline?: string | undefined;
  metric?: { name: string; unit?: string | undefined; plan: Array<[string, number]> } | undefined;
  milestones?: Array<{ what: string; evidence: string }> | undefined;
  budget?: { monthly: number; currency: string } | undefined;
  last_wake_at?: string | undefined;
}

export interface Goal {
  id: string;
  created_at: string;
  status: "active" | "done" | "cancelled";
  data: GoalData;
}

export type InboxItem =
  | { type: "result"; job: string; tool: string; goal: string | null; result: Record<string, unknown>; evidence: string[] }
  | { type: "escalated"; job: string; tool: string; goal: string | null; reason: string }
  | { type: "expired"; job: string; tool: string; goal: string | null }
  | { type: "reminder"; goal: string | null; text: string }
  | { type: "wake"; goal: string; why: string }
  | { type: "goal_closed"; goal: string; outcome: "done" | "cancelled" }
  | { type: "goal_check_failed"; goal: string; reason: string };

// ---------------------------------------------------------------- driver contract

const NotebookPage = z.string().regex(/^[a-z0-9_-]{1,40}$/);

export const ActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("complete"), result: z.record(z.string(), z.unknown()), evidence_level: z.number().int().min(1).max(6).optional() }),
  z.object({ type: z.literal("reply"), text: z.string().min(1), kind: z.enum(["choice", "slider", "checklist", "form", "camera", "audio", "location", "confirm"]).optional(), options: z.array(z.string()).optional() }),
  z.object({ type: z.literal("reject"), text: z.string().min(1), reason: z.string() }),
  z.object({ type: z.literal("escalate"), reason: z.string() }),
  /** Content the driver writes fresh for a procedural tool (a joke, a praise line, the next audit question). */
  z.object({ type: z.literal("card"), text: z.string().min(1), seconds: z.number().positive().max(60).optional(), variant: z.string().regex(/^[a-z_.]{1,30}$/).optional(),
    minutes: z.number().int().positive().optional(), max: z.number().nonnegative().optional() }),
  z.object({ type: z.literal("dispatch"), tool: z.string(), instruction: z.string(), at: z.string().optional() }),
  /** Append one line of judgment to the driver's own notebook. The runtime only stores it. */
  z.object({ type: z.literal("notebook.write"), text: z.string().min(1).max(500), page: NotebookPage.optional() }),
  z.object({ type: z.literal("lookup"), pages: z.array(NotebookPage).min(1).max(10) }),
  z.object({ type: z.literal("notebook.rewrite"), page: NotebookPage, text: z.string() })
]);
export type Action = z.infer<typeof ActionSchema>;
const ActionsSchema = z.array(ActionSchema);

type JobEvent = "start" | "answer" | "goal_check";

export interface DriverInput {
  event: JobEvent | "notebook_review";
  job: { id: string; tool: string; variant: string | null; instruction: string; want: Record<string, string> | null; args: Record<string, unknown>; sudo: boolean; round: number; rounds_left: number };
  answer: Answer | null;                 // untrusted human input; drivers must fence it
  history: Round[];
  /** The driver's own notes about the unit this job went to, as it wrote them. */
  notebook: string;
  notebook_pages?: string[];
  unit: { lang: string };
  goal: { goal: string; done_when: string } | null;
  evidence: Array<{ id: string; level: number; kind: string; at: string; data: unknown }>;
  now: string;
}

export interface Driver {
  run(input: DriverInput): Promise<unknown>;
}

/** Where the driver's notes live. Facts stay in the store; interpretation is the model's and has no schema. */
export interface Notebook {
  read(pages?: readonly string[]): string;
  pages(): string[];
  snapshot(): ReadonlyMap<string, string>;
  append(page: string, text: string, ref: string, at: string): void;
  rewrite(page: string, previous: string, text: string): boolean;
}

/** A job as the brain sees it: telemetry and compiled fields, never the unit's words. */
export interface JobView {
  job: string;
  tool: string;
  state: JobStatus;
  goal: string | null;
  /** Name of the unit the card went to. */
  unit: string | null;
  task: string;
  send_at: string | null;
  shown_ago_s: number | null;
  rounds: number;
  result?: Record<string, unknown> | undefined;
  evidence?: string[] | undefined;
  /** Local paths of the photos taken for this job. The driver reads them into result; the brain opens one only when it wants to look itself. */
  files?: string[] | undefined;
  reason?: string | undefined;
  wake_on_settle?: true | undefined;
}

export interface Channel {
  show(card: Card, restored?: boolean): void | Promise<void>;
  withdraw(jobId: string, reason: string, unit: string | null): void | Promise<void>;
  report?(report: CardReport): void;
  /** When this unit's phone last asked for cards, in epoch ms. */
  seen?(unit: string): number | null;
}

export interface CardReport {
  job_id: string;
  unit: string | null;
  round: number;
  at: string;
  result?: Record<string, unknown> | undefined;
  reason?: string | undefined;
}

export interface Briefing {
  now: string;
  why: string;
  goal: { id: string; status: string; created_at: string } & GoalData;
  metric: { name: string; unit: string | null; expected_now: number | null; actual: Array<{ at: string; value: number }> } | null;
  since: string | null;
  events: Array<{ at: string; kind: string; ref: string | null; data: unknown }>;
  /** Language the units read. */
  lang: string;
  units: Array<UnitState & { stats: Record<string, ToolStats> }>;
  open_jobs: Array<{ id: string; tool: string; status: JobStatus; task: string; created_at: string; send_at: string | null }>;
  schedules: Array<{ id: string; every_s: number; next_at: string; tool: string }>;
  /** The latest hand-off a pass left for the passes after it. */
  agenda: { at: string; text: string } | null;
  decisions: Array<{ at: string; decision: string; reason: string }>;
  budget: { currency: string; monthly: number; spent_this_month: number; remaining: number } | null;
  next_wake: { at: string; why: string } | null;
  warnings: string[];
  write_back: string;
}

export interface Brain {
  wake(goalId: string, briefing: Briefing): void | Promise<void>;
}

/** One person under this runtime, with their own phone. The lead names it at pairing. */
export interface Unit {
  id: string;
  name: string;
  created_at: string;
}

/** What `ps` and the briefing say about a unit. Ages are seconds before now; null when it never happened. */
export interface UnitState {
  name: string;
  online: boolean;
  /** Since the unit last answered a card. */
  last_touch_s: number | null;
  since_eat_s: number | null;
  since_sleep_s: number | null;
  /** The latest mood poll. */
  mood: { value: number; at: string } | null;
  open_jobs: number;
}

export class HumanUseError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code} ${message}`);
  }
}

// ---------------------------------------------------------------- tool → card

const CARD_KIND: Record<string, CardKind> = {
  choose: "choice", decode: "form", checklist: "checklist", photo: "camera", verify: "camera", record: "audio",
  go: "location", mood: "slider", status: "form", eat: "confirm", sleep: "confirm", rest: "confirm", act: "confirm",
  remind: "confirm", recharge: "theater", observe: "form", errand: "form", patch: "form", spend: "camera", bench: "form"
};

/** Kinds whose answer is already structured: the runtime closes them without the driver. */
const DETERMINISTIC: ReadonlySet<CardKind> = new Set(["choice", "slider", "checklist", "confirm", "location", "theater"]);

/** Procedural tools: the driver writes the card content, starting with the first card. */
const PROCEDURAL: ReadonlySet<string> = new Set(["recharge", "bench"]);

const ACTIVITIES = ["snack", "drink", "play"] as const;
export const RECHARGE_VARIANTS = ["flower", "joke", "praise", ...ACTIVITIES] as const;
export const RECEIPT_WANT = { amount: "amount paid, from the receipt", currency: "ISO code" };
const rechargeActivity = (variant: string | null | undefined) => ACTIVITIES.some(activity => activity === variant);
const RECHARGE_DEFAULT_MINUTES = 5;

/** What a theater card shows when no driver is configured. */
const THEATER_FALLBACK = "[DISPENSING MOOD BOOST... 4.0s]";

const TERMINAL: ReadonlySet<JobStatus> = new Set(["done", "escalated", "expired", "cancelled"]);

export interface ToolStats { calls: number; done: number; expired: number; escalated: number; median_s: number | null }

const PRIORITY_ORDER: Record<Priority, number> = { preempt: 0, standard: 1, opportunistic: 2 };
const PIGGYBACK = 2;

const id = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
const requiresEvidence = (job: Job) => job.data.sudo === true || find(job.tool)?.category === "identity";
const fileEvidenceLevel = (file: NonNullable<Answer["file"]>) => file.kind === "document" ? 3 : file.captured === "upload" ? 6 : 4;
const minorDigits = (currency: string) => new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
const toMinor = (amount: number, currency: string) => Math.round(amount * 10 ** minorDigits(currency));
const fromMinor = (minor: number, currency: string) => minor / 10 ** minorDigits(currency);

interface JobRow { id: string; goal_id: string | null; unit_id: string | null; tool: string; status: JobStatus; priority: Priority; created_at: string; updated_at: string; send_at: string | null; due_at: string | null; data: string }
interface GoalRow { id: string; created_at: string; status: Goal["status"]; data: string }

export interface DispatchArgs {
  instruction: string;
  goal?: string | undefined;
  /** Unit name or id. May be left out while only one unit is paired. */
  unit?: string | undefined;
  priority?: Priority | undefined;
  at?: string | undefined;
  due?: string | undefined;
  want?: Record<string, string> | undefined;
  label?: string | undefined;
  sudo?: boolean | undefined;
  max_rounds?: number | undefined;
  options?: string[] | undefined;
  steps?: string[] | undefined;
  nonce?: boolean | undefined;
  max?: number | undefined;
  currency?: string | undefined;
  minutes?: number | undefined;
  variant?: string | undefined;
  /** The brain's parameters as given, kept for the driver and the record. */
  params?: Record<string, unknown> | undefined;
}

export interface RuntimeOptions {
  store: Store;
  clock?: Clock | undefined;
  driver?: Driver | null | undefined;
  channel?: Channel | null | undefined;
  brain?: Brain | null | undefined;
  /** Each unit's driver notebook, by unit id. */
  notebook?: ((unit: string) => Notebook | null) | null | undefined;
  /** Language the units read. Card content the driver writes uses it. */
  lang?: string | undefined;
  onError?: ((error: unknown, where: string) => void) | undefined;
}

/** Maintenance reported as overdue in goal calls: tool, label, hours after the last completed call. */
const MAINTENANCE: ReadonlyArray<readonly [tool: string, label: string, hours: number]> = [["eat", "meal", 6], ["sleep", "sleep", 20]];
const ago = (seconds: number) => {
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
};
const NOTEBOOK_WEEK_SECONDS = 7 * 24 * 60 * 60;
const NOTEBOOK_LOOKUPS = 2;
/** A phone that asked for cards within this many seconds is online. */
const ONLINE_S = 60;
const UNIT_NAME = /^[a-z0-9][a-z0-9_-]{0,23}$/;
const UNIT_ID = /^u_[0-9a-f]{6}$/;
const OPEN_STATES = "('scheduled','queued','open','review')";

// ---------------------------------------------------------------- runtime

export class Runtime {
  readonly store: Store;
  readonly clock: Clock;
  driver: Driver | null;
  channel: Channel | null;
  brain: Brain | null;
  private readonly notebooks: ((unit: string) => Notebook | null) | null;
  readonly lang: string;
  private readonly onError: (error: unknown, where: string) => void;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(options: RuntimeOptions) {
    this.store = options.store;
    this.clock = options.clock ?? systemClock;
    this.driver = options.driver ?? null;
    this.channel = options.channel ?? null;
    this.brain = options.brain ?? null;
    this.notebooks = options.notebook ?? null;
    this.lang = options.lang ?? "en";
    this.onError = options.onError ?? ((error, where) => console.error(`[human-use] ${where}:`, error));
  }

  private now(): string {
    return this.clock.now().toISOString();
  }

  /** Wait for every driver call, channel send and brain wake started so far. Tests and shutdown use it. */
  async settle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private track(promise: Promise<unknown>, where: string): void {
    const tracked = promise.catch(error => this.onError(error, where)).finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  // ------------------------------------------------------------ units

  units(): Unit[] {
    return this.store.all<Unit>("SELECT id, name, created_at FROM units ORDER BY created_at, name");
  }

  /** A new unit under this runtime. Pairing its phone is the daemon's part. */
  addUnit(raw: string): Unit {
    const name = raw.trim().toLowerCase();
    if (!UNIT_NAME.test(name) || UNIT_ID.test(name)) throw new HumanUseError("HRT-4001", "BAD_ARGS a unit name is 1 to 24 letters, digits, - or _");
    if (this.store.get("SELECT 1 FROM units WHERE name = ?", name)) throw new HumanUseError("HRT-4001", `BAD_ARGS unit ${name} already exists`);
    let unitId = id("u").slice(0, 8);
    while (this.store.get("SELECT 1 FROM units WHERE id = ?", unitId)) unitId = id("u").slice(0, 8);
    const unit: Unit = { id: unitId, name, created_at: this.now() };
    this.store.insert("units", { ...unit, data: "{}" });
    this.store.event(unit.created_at, "unit_added", unit.id, null, { name });
    return unit;
  }

  /** A unit by name or id. Leaving it out is allowed while only one unit is paired. */
  unit(ref?: string | null): Unit {
    const units = this.units();
    if (!ref) {
      if (units.length === 1) return units[0]!;
      if (!units.length) throw new HumanUseError("HRT-4004", "NO_SUCH_UNIT no unit is paired yet. The lead adds one on the lead page.");
      throw new HumanUseError("HRT-4001", `BAD_ARGS unit is required: ${units.map(unit => unit.name).join(", ")}`);
    }
    const key = ref.trim().toLowerCase();
    const found = units.find(unit => unit.id === key || unit.name === key);
    if (!found) throw new HumanUseError("HRT-4004", `NO_SUCH_UNIT ${ref}${units.length ? `. Units: ${units.map(unit => unit.name).join(", ")}` : ""}`);
    return found;
  }

  private unitName(unitId: string | null): string | null {
    return unitId ? this.store.get<{ name: string }>("SELECT name FROM units WHERE id = ?", unitId)?.name ?? null : null;
  }

  private notebook(unitId: string | null): Notebook | null {
    return unitId && this.notebooks ? this.notebooks(unitId) : null;
  }

  private unitState(unit: Unit): UnitState {
    const now = this.clock.now().getTime();
    const age = (at: string | number | null | undefined) => at === null || at === undefined ? null : Math.max(0, Math.round((now - (typeof at === "number" ? at : Date.parse(at))) / 1000));
    const seen = this.channel?.seen?.(unit.id) ?? null;
    const touched = this.store.get<{ at: string | null }>(
      "SELECT MAX(events.at) AS at FROM events JOIN jobs ON jobs.id = events.ref WHERE events.kind = 'answer' AND jobs.unit_id = ?", unit.id)?.at;
    const mood = this.store.get<{ updated_at: string; data: string }>(
      "SELECT updated_at, data FROM jobs WHERE unit_id = ? AND tool = 'mood' AND status = 'done' ORDER BY updated_at DESC LIMIT 1", unit.id);
    const value = mood ? (JSON.parse(mood.data) as JobData).result?.value : undefined;
    return {
      name: unit.name,
      online: seen !== null && now - seen < ONLINE_S * 1000,
      last_touch_s: age(touched),
      since_eat_s: this.since({ tool: "eat", unit: unit.id }).seconds,
      since_sleep_s: this.since({ tool: "sleep", unit: unit.id }).seconds,
      mood: mood && typeof value === "number" ? { value, at: mood.updated_at } : null,
      open_jobs: this.store.get<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs WHERE unit_id = ? AND status IN ${OPEN_STATES}`, unit.id)!.n
    };
  }

  /** Every unit: online, last touch, upkeep, mood, open jobs. */
  unitStates(): UnitState[] {
    return this.units().map(unit => this.unitState(unit));
  }

  // ------------------------------------------------------------ jobs

  job(jobId: string): Job {
    const row = this.store.get<JobRow>("SELECT * FROM jobs WHERE id = ?", jobId);
    if (!row) throw new HumanUseError("HRT-4004", `NO_SUCH_JOB ${jobId}`);
    return { ...row, data: JSON.parse(row.data) as JobData };
  }

  private saveJob(job: Job, patch: Partial<Omit<Job, "id" | "data">> & { data?: JobData }): Job {
    const next: Job = { ...job, ...patch, updated_at: this.now() };
    this.store.update("jobs", job.id, {
      status: next.status, priority: next.priority, updated_at: next.updated_at,
      send_at: next.send_at, due_at: next.due_at, data: JSON.stringify(next.data)
    });
    return next;
  }

  dispatch(tool: string, args: DispatchArgs, internal?: { parent: string }): { job: string; status: JobStatus; send_at: string | null } {
    const kind = CARD_KIND[tool];
    if (!kind) throw new HumanUseError("HRT-4000", `NOT_A_HUMAN_TOOL ${tool}`);
    // A helper card goes to whoever got the card it helps with.
    const parentUnit = internal ? this.job(internal.parent).unit_id : null;
    const unit = parentUnit ?? this.unit(args.unit).id;
    if (args.goal) this.goal(args.goal);
    if (kind === "choice" && !(args.options && args.options.length >= 2)) throw new HumanUseError("HRT-4001", "choose needs at least two options");
    if (kind === "checklist" && !(args.steps && args.steps.length)) throw new HumanUseError("HRT-4001", "checklist needs steps");
    if (tool === "spend" || (tool === "recharge" && (args.max ?? 0) > 0)) this.checkBudget(args);

    const now = this.now();
    const sendAt = args.at ? resolveTime(args.at, this.clock) : null;
    const scheduled = sendAt !== null && sendAt > now;
    const job: Job = {
      id: id("j"),
      goal_id: args.goal ?? null,
      unit_id: unit,
      tool,
      status: scheduled ? "scheduled" : "queued",
      priority: args.priority ?? "standard",
      created_at: now,
      updated_at: now,
      send_at: sendAt,
      due_at: null,
      data: {
        instruction: args.instruction,
        args: Object.fromEntries(Object.entries({ ...args.params, options: args.options, steps: args.steps, nonce: args.nonce,
          max: tool === "recharge" ? args.max ?? 0 : args.max, currency: args.currency, due: args.due,
          ...(tool === "recharge" ? { minutes: args.minutes ?? RECHARGE_DEFAULT_MINUTES } : {}) })
          .filter(([, value]) => value !== undefined)),
        variant: args.variant,
        want: args.want,
        label: args.label,
        sudo: args.sudo === true || find(tool)?.category === "identity" ? true : undefined,
        max_rounds: args.max_rounds ?? (tool === "bench" ? 12 : 3),
        rounds: [],
        internal: internal ? true : undefined,
        parent: internal?.parent
      }
    };
    this.store.insert("jobs", {
      id: job.id, goal_id: job.goal_id, unit_id: unit, tool, status: job.status, priority: job.priority, created_at: now, updated_at: now,
      send_at: job.send_at, due_at: null, data: JSON.stringify(job.data)
    });
    this.store.event(now, "job_created", job.id, job.goal_id, { tool, unit, priority: job.priority, send_at: sendAt });
    if (!scheduled) this.pump();
    return { job: job.id, status: this.job(job.id).status, send_at: sendAt };
  }

  cancel(jobId: string, reason = "cancelled by agent"): void {
    const job = this.job(jobId);
    if (TERMINAL.has(job.status)) return;
    const wasOpen = job.status === "open";
    this.saveJob(job, { status: "cancelled", data: { ...job.data, reason } });
    this.store.event(this.now(), "job_cancelled", job.id, job.goal_id, { reason });
    if (wasOpen && this.channel) this.track(Promise.resolve(this.channel.withdraw(job.id, "ABORTED BY UPSTREAM", job.unit_id)), "channel.withdraw");
    if (job.status === "review") this.report(job, { reason });
    this.release(job.id);
    this.pump();
  }

  // ------------------------------------------------------------ waiting

  /** The job as the brain may see it. */
  view(jobId: string): JobView {
    const job = this.job(jobId);
    const shown = job.data.rounds[0]?.at;
    // A recording is the unit's own voice, so it stays with the driver like the rest of their words.
    const files = job.data.rounds.flatMap(round => round.answer?.file && round.answer.file.kind !== "audio" ? [resolve(round.answer.file.path)] : []);
    return {
      job: job.id, tool: job.tool, state: job.status, goal: job.goal_id, unit: this.unitName(job.unit_id), task: job.data.instruction, send_at: job.send_at,
      shown_ago_s: shown && !TERMINAL.has(job.status) ? Math.round((this.clock.now().getTime() - new Date(shown).getTime()) / 1000) : null,
      rounds: job.data.rounds.length,
      ...(job.data.result ? { result: job.data.result } : {}),
      ...(job.data.evidence?.length ? { evidence: job.data.evidence } : {}),
      ...(files.length ? { files } : {}),
      ...(job.data.reason ? { reason: job.data.reason } : {}),
      ...(job.data.wake_on_settle && !TERMINAL.has(job.status) ? { wake_on_settle: true as const } : {})
    };
  }

  /** Block until the job settles or `ms` passes. A result handed to a waiter is not delivered a second time. */
  async waitFor(jobId: string, ms: number): Promise<JobView> {
    if (!TERMINAL.has(this.job(jobId).status) && ms > 0) {
      await new Promise<void>(resolve => {
        const set = this.waiters.get(jobId) ?? new Set<() => void>();
        this.waiters.set(jobId, set);
        const done = () => { clearTimeout(timer); set.delete(done); if (!set.size) this.waiters.delete(jobId); resolve(); };
        const timer = setTimeout(done, ms);
        set.add(done);
      });
    }
    const view = this.view(jobId);
    if (TERMINAL.has(view.state)) this.store.run("UPDATE inbox SET delivered_at = ? WHERE delivered_at IS NULL AND json_extract(data, '$.job') = ?", this.now(), jobId);
    return view;
  }

  /** Ask for a wake when this job settles. Used when the brain wants to wait longer than one tool call can block. */
  armWake(jobId: string): boolean {
    const job = this.job(jobId);
    if (TERMINAL.has(job.status) || !job.goal_id) return false;
    this.saveJob(job, { data: { ...job.data, wake_on_settle: true } });
    return true;
  }

  private release(jobId: string): boolean {
    const set = this.waiters.get(jobId);
    if (!set?.size) return false;
    for (const done of [...set]) done();
    return true;
  }

  /** A job reached a final state. Whoever is waiting gets it now; otherwise the brain is woken if it asked, or if the job needs a decision. */
  private settled(job: Job): void {
    if (this.release(job.id)) return;
    if (job.data.internal || !job.goal_id) return;
    if (job.data.wake_on_settle || job.status === "escalated") this.fire(job.goal_id, `job ${job.id} ${job.status}`);
  }

  reschedule(jobId: string, at: string): { job: string; send_at: string } {
    const job = this.job(jobId);
    if (!["scheduled", "queued", "open"].includes(job.status)) throw new HumanUseError("HRT-4009", `JOB_NOT_PENDING ${job.status}`);
    const sendAt = resolveTime(at, this.clock);
    if (job.status === "open" && this.channel) this.track(Promise.resolve(this.channel.withdraw(job.id, "RESCHEDULED", job.unit_id)), "channel.withdraw");
    this.saveJob(job, { status: "scheduled", send_at: sendAt, due_at: null });
    this.store.event(this.now(), "job_rescheduled", job.id, job.goal_id, { send_at: sendAt });
    this.pump();
    return { job: job.id, send_at: sendAt };
  }

  private cardFor(job: Job, text?: string, kind?: CardKind, options?: string[], seconds?: number, round = job.data.rounds.length + 1): Card {
    const args = job.data.args as { options?: string[]; steps?: string[]; nonce?: boolean };
    const activity = job.data.recharge_card;
    const activityKind = activity && (activity.max > 0 ? "camera" : "confirm");
    const cardKind = kind ?? activityKind ?? CARD_KIND[job.tool] ?? "form";
    const fingers = 1 + Math.floor(Math.random() * 5);
    const nonce = cardKind === "camera" && args.nonce ? `hold up ${fingers} finger${fingers === 1 ? "" : "s"}, lower left` : undefined;
    return {
      job_id: job.id,
      unit: job.unit_id,
      tool: job.tool,
      title: `human.${job.tool}${job.data.variant ? `.${job.data.variant}` : ""}`,
      kind: cardKind,
      text: text ?? job.data.instruction,
      task: job.data.instruction,
      seconds: cardKind === "theater" ? seconds ?? 4 : undefined,
      round,
      priority: job.priority,
      options: options ?? (cardKind === "choice" ? args.options : undefined),
      steps: cardKind === "checklist" ? args.steps : undefined,
      fields: cardKind === "form" && round === 1 ? job.data.want : undefined,
      nonce,
      sudo: job.data.sudo === true ? true : undefined
    };
  }

  private show(job: Job, card: Card): void {
    const round: Round = { at: this.now(), card: card.text, kind: card.kind, options: card.options, nonce: card.nonce, rejected: card.rejected };
    const due = job.data.args.due as string | undefined;
    const activity = job.data.recharge_card;
    const deadlines = [
      due ? resolveTime(due, this.clock) : null,
      activity ? addSeconds(this.clock.now(), activity.minutes * 60).toISOString() : null
    ].filter(value => value !== null).sort();
    const saved = this.saveJob(job, {
      status: "open",
      due_at: job.due_at ?? deadlines[0] ?? null,
      data: { ...job.data, rounds: [...job.data.rounds, round] }
    });
    this.store.event(this.now(), "card_shown", job.id, job.goal_id, { kind: card.kind, round: card.round });
    if (this.channel) this.track(Promise.resolve(this.channel.show({ ...card, shown_at: saved.data.rounds[0]?.at, due_at: saved.due_at })), "channel.show");
    if (card.kind === "theater") { this.finish(saved, { recharged: true, variant: job.data.variant ?? null }, 1); this.pump(); }
  }

  /** After a restart: put open cards back on the channel and re-run compiles that were cut off. */
  resume(): void {
    for (const row of this.store.all<JobRow>("SELECT * FROM jobs WHERE status IN ('open','review') ORDER BY updated_at")) {
      const job: Job = { ...row, data: JSON.parse(row.data) as JobData };
      const last = job.data.rounds.at(-1);
      if (job.status === "open" && last && this.channel) {
        const card = { ...this.cardFor(job, last.card, last.kind, last.options, undefined, job.data.rounds.length),
          nonce: last.nonce, rejected: last.rejected, shown_at: job.data.rounds[0]?.at, due_at: job.due_at };
        this.track(Promise.resolve(this.channel.show(card, true)), "channel.show");
      } else if (job.status === "review" && this.driver) {
        const event = job.tool === "goal_check" ? "goal_check" : last?.answer ? "answer" : "start";
        this.track(this.consult(job.id, event, last?.answer ?? null), "driver.resume");
      }
    }
  }

  /**
   * Put queued cards in front of each unit. One open card per unit; PREEMPT cuts in; OPPORTUNISTIC rides along after
   * an answer from `answered`, the unit that just picked up its phone.
   */
  pump(piggyback = 0, answered: string | null = null): void {
    const queued = this.store.all<JobRow>("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at")
      .map(row => ({ ...row, data: JSON.parse(row.data) as JobData }))
      .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
    const openCount = (unit: string | null) => this.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status = 'open' AND unit_id IS ?", unit)!.n;
    let rides = piggyback;
    for (const job of queued) {
      if (job.priority === "preempt") this.open(job);
      else if (job.priority === "standard" && openCount(job.unit_id) === 0) this.open(job);
      else if (job.priority === "opportunistic" && job.unit_id === answered && rides > 0 && openCount(job.unit_id) === 0) { this.open(job); rides--; }
    }
  }

  private open(job: Job): void {
    if (PROCEDURAL.has(job.tool) && this.driver) {
      this.saveJob(job, { status: "review" });
      this.track(this.consult(job.id, "start", null), "driver.start");
      return;
    }
    if (job.tool === "recharge" && rechargeActivity(job.data.variant)) {
      this.escalate(job, "HRT-5031 COMPILE_FAILED");
      return;
    }
    this.show(job, this.cardFor(job, CARD_KIND[job.tool] === "theater" ? THEATER_FALLBACK : undefined));
  }

  /** The human answered the open card of `jobId`. Channels call this. */
  answer(jobId: string, answer: Answer): void {
    const job = this.job(jobId);
    if (job.status !== "open") throw new HumanUseError("HRT-4009", `JOB_NOT_OPEN ${job.status}`);
    const rounds = [...job.data.rounds];
    const last = rounds.at(-1);
    if (last) rounds[rounds.length - 1] = { ...last, answer, answered_at: this.now() };
    const saved = this.saveJob(job, { data: { ...job.data, rounds } });
    this.store.event(this.now(), "answer", job.id, job.goal_id, { round: rounds.length });

    const kind = CARD_KIND[job.tool] ?? "form";
    const followUp = rounds.length > 1;
    if (!followUp && !requiresEvidence(job) && job.data.recharge_card?.max === 0 && answer.choice === "done") {
      this.finish(saved, { recharged: true, variant: job.data.variant }, 6);
      this.pump(PIGGYBACK, job.unit_id);
      return;
    }
    if (!followUp && !requiresEvidence(job) && DETERMINISTIC.has(kind)) {
      const result = this.structured(saved, answer);
      if (result) { this.finish(saved, result, 6); this.pump(PIGGYBACK, job.unit_id); return; }
    }
    this.saveJob(saved, { status: "review" });
    if (!this.driver) {
      this.store.event(this.now(), "driver_missing", job.id, job.goal_id);
      this.pump(PIGGYBACK, job.unit_id);
      return;
    }
    this.track(this.consult(job.id, "answer", answer), "driver.answer");
    this.pump(PIGGYBACK, job.unit_id);
  }

  private structured(job: Job, answer: Answer): Record<string, unknown> | null {
    switch (CARD_KIND[job.tool]) {
      case "choice": {
        const options = (job.data.args.options as string[] | undefined) ?? [];
        return answer.choice !== undefined && options.includes(answer.choice) ? { choice: answer.choice } : null;
      }
      case "slider": return answer.value !== undefined ? { value: answer.value } : null;
      case "checklist": {
        const steps = (job.data.args.steps as string[] | undefined) ?? [];
        const checked = answer.checked ?? [];
        return { done: checked.length === steps.length, checked: steps.filter((_, index) => checked.includes(index)), missed: steps.filter((_, index) => !checked.includes(index)) };
      }
      case "confirm": return answer.choice === undefined || answer.choice === "done" ? { done: true, at: this.now() } : null;
      case "location": return answer.location ? { arrived: true, location: answer.location, at: this.now() } : null;
      default: return null;
    }
  }

  // ------------------------------------------------------------ driver

  private async consult(jobId: string, event: JobEvent, answer: Answer | null): Promise<void> {
    const job = this.job(jobId);
    if (!this.driver) return;
    const goal = event === "goal_check" && job.goal_id ? this.goal(job.goal_id) : null;
    const notebook = this.notebook(job.unit_id);
    const input: DriverInput = {
      event,
      job: {
        id: job.id, tool: job.tool, variant: job.data.variant ?? null, instruction: job.data.instruction, want: job.data.want ?? null, args: job.data.args,
        sudo: requiresEvidence(job), round: job.data.rounds.length, rounds_left: Math.max(0, job.data.max_rounds - job.data.rounds.length)
      },
      answer,
      history: job.data.rounds,
      notebook: notebook?.read() ?? "",
      notebook_pages: notebook?.pages() ?? [],
      unit: { lang: this.lang },
      goal: goal ? { goal: goal.data.goal, done_when: goal.data.done_when } : null,
      evidence: event === "goal_check" && job.goal_id ? this.evidenceFor(job.goal_id) : [],
      now: this.now()
    };

    const requestedPages = new Set<string>();
    for (let round = 0; ; round++) {
      const { actions, failure } = await this.compile(input, actions =>
        actions.length > 0 && actions.every(action =>
          action.type !== "notebook.rewrite" && (action.type !== "lookup" || actions.length === 1)
          && (job.tool !== "recharge" || this.rechargeActionFits(job, event, action))));
      const current = this.job(jobId);
      if (current.status !== "review") return;
      const lookup = actions?.[0];
      if (lookup?.type === "lookup" && round < NOTEBOOK_LOOKUPS) {
        lookup.pages.forEach(page => requestedPages.add(page));
        input.notebook = notebook?.read([...requestedPages]) ?? "";
        continue;
      }
      if (!actions || lookup?.type === "lookup") {
        const error = lookup?.type === "lookup" ? "notebook lookup limit reached" : failure;
        this.store.event(this.now(), "compile_failed", job.id, job.goal_id, { failure: error.slice(0, 500) });
        this.escalate(current, "HRT-5031 COMPILE_FAILED");
        return;
      }
      this.apply(current, actions);
      return;
    }
  }

  private rechargeActionFits(job: Job, event: JobEvent, action: Action): boolean {
    if (action.type === "card") {
      if (event !== "start") return false;
      const variant = job.data.variant ?? action.variant;
      if (variant && !RECHARGE_VARIANTS.some(value => value === variant)) return false;
      if (job.data.variant && action.variant && job.data.variant !== action.variant) return false;
      const cap = Number(job.data.args.max ?? 0);
      const minutes = Number(job.data.args.minutes ?? RECHARGE_DEFAULT_MINUTES);
      if (rechargeActivity(variant) && !job.data.variant && action.max === undefined) return false;
      const max = action.max ?? (job.data.variant && rechargeActivity(variant) ? cap : 0);
      if ((action.minutes ?? minutes) > minutes || (action.seconds ?? 0) > minutes * 60 || max > cap) return false;
      if (max === 0) return true;
      if (!rechargeActivity(variant)) return false;
      this.checkBudget({ instruction: job.data.instruction, goal: job.goal_id ?? undefined, max, currency: job.data.args.currency as string | undefined });
      return true;
    }
    if (action.type !== "complete") return true;
    if (event === "start") return false;
    if (!job.data.recharge_card?.max) return true;
    const { amount, currency, done, recharged } = action.result;
    if (amount === undefined && (done === false || recharged === false)) return true;
    return typeof amount === "number" && amount >= 0
      && Number.isSafeInteger(toMinor(amount, String(job.data.args.currency)))
      && (currency === undefined || currency === job.data.args.currency)
      && job.data.rounds.some(round => round.answer?.file);
  }

  private async compile(input: DriverInput, accepts: (actions: Action[]) => boolean): Promise<{ actions: Action[] | null; failure: string }> {
    const driver = this.driver;
    if (!driver) return { actions: null, failure: "driver unavailable" };
    let failure = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const parsed = ActionsSchema.safeParse(await driver.run({ ...input }));
        if (parsed.success && accepts(parsed.data)) return { actions: parsed.data, failure: "" };
        failure = parsed.success ? "actions do not match the event" : parsed.error.message;
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
    }
    return { actions: null, failure };
  }

  /** Kept for the weekly review once the driver prompt supports its event. Each unit's notebook has its own week. */
  tickNotebook(now = this.now()): void {
    if (!this.driver) return;
    for (const unit of this.units()) {
      const notebook = this.notebook(unit.id);
      if (!notebook) continue;
      const ref = `notebook:${unit.id}`;
      const next = this.store.get<{ at: string }>(
        "SELECT at FROM events WHERE ref = ? AND kind = 'notebook_review_due' ORDER BY seq DESC LIMIT 1", ref
      );
      if (next && next.at > now) continue;
      this.store.event(addSeconds(this.clock.now(), NOTEBOOK_WEEK_SECONDS).toISOString(), "notebook_review_due", ref, null);
      if (next) this.track(this.reviewNotebook(notebook, ref, now), "notebook.review");
    }
  }

  private async reviewNotebook(notebook: Notebook, ref: string, now: string): Promise<void> {
    const snapshot = notebook.snapshot();
    if (!snapshot.size) return;
    const book = [...snapshot].map(([page, text]) => `# ${page}\n${text}`).join("\n\n");
    const { actions, failure } = await this.compile({
      event: "notebook_review",
      job: { id: "notebook", tool: "notebook", variant: null, instruction: "", want: null, args: {}, sudo: false, round: 0, rounds_left: 0 },
      answer: null, history: [], notebook: book, notebook_pages: [...snapshot.keys()],
      unit: { lang: this.lang }, goal: null, evidence: [], now
    }, actions => actions.every(action => action.type === "notebook.rewrite" && snapshot.has(action.page)));
    if (!actions) {
      this.store.event(this.now(), "notebook_review_failed", ref, null, { failure: failure.slice(0, 500) });
      return;
    }
    const rewritten: string[] = [];
    for (const action of actions) {
      if (action.type === "notebook.rewrite" && notebook.rewrite(action.page, snapshot.get(action.page)!, action.text)) rewritten.push(action.page);
    }
    this.store.event(this.now(), "notebook_reviewed", ref, null, { rewritten });
  }

  private apply(job: Job, actions: Action[]): void {
    const current = job;
    const notebook = this.notebook(job.unit_id);
    // Notes first: they must land even though a terminal action below ends the pass.
    for (const action of actions) {
      if (action.type === "notebook.write") {
        notebook?.append(action.page ?? "notes", action.text, job.id, this.now());
        this.store.event(this.now(), "notebook_write", job.id, null, { page: action.page ?? "notes" });
      }
    }
    for (const action of actions) {
      switch (action.type) {
        case "notebook.write":
          break;
        case "dispatch":
          try {
            this.dispatch(action.tool, { instruction: action.instruction, goal: job.goal_id ?? undefined, at: action.at }, { parent: job.id });
          } catch (error) {
            this.store.event(this.now(), "dispatch_failed", job.id, job.goal_id, { tool: action.tool, error: String(error) });
          }
          break;
        case "complete":
          if (job.tool === "goal_check") this.closeChecked(job, action.result);
          else this.finish(current, action.result, action.evidence_level);
          return;
        case "escalate":
          this.escalate(current, action.reason);
          return;
        case "card":
          if (job.tool === "goal_check") { this.escalate(current, "HRT-5031 COMPILE_FAILED"); return; }
          {
            // The brain named no variant, so the system picked one within the tool's contract.
            const variant = current.data.variant ?? action.variant;
            const recharge_card = job.tool === "recharge" && rechargeActivity(variant) ? {
              minutes: action.minutes ?? Number(job.data.args.minutes ?? RECHARGE_DEFAULT_MINUTES),
              max: action.max ?? (job.data.variant ? Number(job.data.args.max ?? 0) : 0)
            } : undefined;
            const max = recharge_card?.max ?? 0;
            const want = max > 0 ? RECEIPT_WANT : current.data.want;
            const chosen = this.saveJob(current, { data: { ...current.data, variant, recharge_card, want } });
            const text = max > 0 ? `${action.text}\n≤ ${max} ${job.data.args.currency}` : action.text;
            this.show(chosen, this.cardFor(chosen, text, undefined, undefined, action.seconds));
          }
          return;
        case "reply":
        case "reject": {
          if (action.type === "reject") this.store.event(this.now(), "rejected", job.id, job.goal_id, { reason: action.reason });
          if (job.tool === "goal_check") { this.escalate(current, action.type === "reject" ? action.reason : action.text); return; }
          if (current.data.rounds.length >= current.data.max_rounds) { this.escalate(current, `round limit ${current.data.max_rounds} reached`); return; }
          const kind = action.type === "reply" ? action.kind ?? "form" : undefined;
          const options = action.type === "reply" ? action.options : undefined;
          this.show(current, { ...this.cardFor(current, action.text, kind ?? (CARD_KIND[job.tool] === "theater" && !current.data.recharge_card ? "form" : undefined), options),
            ...(action.type === "reject" ? { rejected: action.reason } : {}) });
          return;
        }
      }
    }
    // Only notes or helper dispatches came back: nothing decided this job.
    this.store.event(this.now(), "compile_failed", job.id, job.goal_id, { failure: "no terminal action" });
    this.escalate(current, "HRT-5031 COMPILE_FAILED");
  }

  private finish(job: Job, result: Record<string, unknown>, level?: number): void {
    const now = this.now();
    const evidence: string[] = [];
    let compiled: Record<string, unknown> = job.data.recharge_card
      ? { recharged: result.recharged !== false && result.done !== false, variant: job.data.variant }
      : result;
    const files = job.data.rounds.flatMap(round => round.answer?.file ? [round.answer.file] : []);
    if (requiresEvidence(job)) {
      const evidence_level = level ?? Math.min(6, ...files.map(fileEvidenceLevel));
      const { unverified: _unverified, ...fields } = compiled;
      compiled = { ...fields, evidence_level, ...(evidence_level === 6 ? { unverified: true } : {}) };
    }
    this.store.tx(() => {
      for (const file of files) {
        const fileLevel = level ?? fileEvidenceLevel(file);
        const evidenceId = id("e");
        this.store.insert("evidence", { id: evidenceId, at: now, goal_id: job.goal_id, job_id: job.id, level: fileLevel, kind: file.kind, path: file.path, data: JSON.stringify(result) });
        evidence.push(evidenceId);
      }
      if (!files.length && (CARD_KIND[job.tool] !== "theater" || job.data.recharge_card)) {
        const evidenceId = id("e");
        this.store.insert("evidence", { id: evidenceId, at: now, goal_id: job.goal_id, job_id: job.id, level: level ?? 6, kind: "answer", path: null, data: JSON.stringify(result) });
        evidence.push(evidenceId);
      }
      if (job.tool === "spend" || (job.data.recharge_card?.max && typeof result.amount === "number")) {
        this.record(job, result, evidence[0] ?? null);
      }
      const saved = this.saveJob(job, { status: "done", data: { ...job.data, result: compiled, evidence } });
      this.store.event(now, "job_done", job.id, job.goal_id, { tool: job.tool, result: compiled });
      if (!job.data.internal) this.deliver({ type: "result", job: job.id, tool: job.tool, goal: job.goal_id, result: compiled, evidence }, job.goal_id);
      this.settled(saved);
    });
    this.report(job, { result: compiled });
  }

  private report(job: Job, outcome: Pick<CardReport, "result" | "reason">): void {
    if (job.data.rounds.at(-1)?.answer) this.channel?.report?.({
      job_id: job.id, unit: job.unit_id, round: job.data.rounds.length, at: this.now(), ...outcome
    });
  }

  private escalate(job: Job, reason: string): void {
    this.store.tx(() => {
      const saved = this.saveJob(job, { status: "escalated", data: { ...job.data, reason } });
      this.store.event(this.now(), "job_escalated", job.id, job.goal_id, { tool: job.tool, reason });
      if (job.tool === "goal_check" && job.goal_id) this.deliver({ type: "goal_check_failed", goal: job.goal_id, reason }, job.goal_id);
      else if (!job.data.internal) this.deliver({ type: "escalated", job: job.id, tool: job.tool, goal: job.goal_id, reason }, job.goal_id);
      if (job.tool === "goal_check") this.release(job.id);
      else this.settled(saved);
    });
    this.report(job, { reason });
    this.pump();
  }

  // ------------------------------------------------------------ money

  private checkBudget(args: DispatchArgs): void {
    if (args.max === undefined || !args.currency) throw new HumanUseError("HRT-4001", "spend needs max and currency");
    if (!args.goal) return;
    const budget = this.budget(args.goal);
    if (!budget) return;
    if (budget.currency !== args.currency) throw new HumanUseError("HRT-4021", `CURRENCY_MISMATCH budget is ${budget.currency}`);
    if (args.max > budget.remaining) throw new HumanUseError("HRT-4020", `BUDGET_EXCEEDED remaining ${budget.remaining} ${budget.currency}`);
  }

  private record(job: Job, result: Record<string, unknown>, evidenceId: string | null): void {
    const amount = Number(result.amount);
    const currency = String(result.currency ?? job.data.args.currency ?? "USD");
    if (!Number.isFinite(amount)) return;
    this.store.run("INSERT INTO ledger (at, goal_id, job_id, amount_minor, currency, memo, evidence_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      this.now(), job.goal_id, job.id, toMinor(amount, currency), currency, job.data.instruction, evidenceId);
    const max = Number(job.data.recharge_card?.max ?? job.data.args.max);
    if (Number.isFinite(max) && amount > max) this.store.event(this.now(), "overspend", job.id, job.goal_id, { amount, max });
  }

  budget(goalId: string): Briefing["budget"] {
    const goal = this.goal(goalId);
    if (!goal.data.budget) return null;
    const { monthly, currency } = goal.data.budget;
    const spentMinor = this.store.get<{ s: number | null }>("SELECT SUM(amount_minor) AS s FROM ledger WHERE goal_id = ? AND currency = ? AND at >= ?",
      goalId, currency, monthStart(this.clock.now()))!.s ?? 0;
    const spent = fromMinor(spentMinor, currency);
    return { currency, monthly, spent_this_month: spent, remaining: fromMinor(toMinor(monthly, currency) - spentMinor, currency) };
  }

  // ------------------------------------------------------------ inbox

  private deliver(item: InboxItem, goalId: string | null, at?: string): void {
    this.store.run("INSERT INTO inbox (deliver_at, goal_id, data) VALUES (?, ?, ?)", at ?? this.now(), goalId, JSON.stringify(item));
  }

  /**
   * Settled results and reminders the brain has not seen yet. They hang on the goal, not on a caller: a tool call that
   * names a goal gets that goal's, a call that names none gets the goal-less ones. Omit the argument for everything.
   */
  drain(goal?: string | null): InboxItem[] {
    const now = this.now();
    const filter = goal === undefined ? "" : goal === null ? " AND goal_id IS NULL" : " AND goal_id = ?";
    const rows = this.store.all<{ seq: number; data: string }>(
      `UPDATE inbox SET delivered_at = ? WHERE delivered_at IS NULL AND deliver_at <= ?${filter} RETURNING seq, data`,
      now, now, ...(typeof goal === "string" ? [goal] : [])
    );
    return rows.sort((a, b) => a.seq - b.seq).map(row => JSON.parse(row.data) as InboxItem);
  }

  remind(args: { to: "human" | "agent"; at: string; text: string; goal?: string | undefined; unit?: string | undefined }): { job?: string; inbox_at?: string } {
    if (args.to === "human") return { job: this.dispatch("remind", { instruction: args.text, at: args.at, goal: args.goal, unit: args.unit }).job };
    const at = resolveTime(args.at, this.clock);
    this.deliver({ type: "reminder", goal: args.goal ?? null, text: args.text }, args.goal ?? null, at);
    return { inbox_at: at };
  }

  // ------------------------------------------------------------ schedules

  every(args: { every: string; at?: string | undefined; tool: string; call: DispatchArgs }): { schedule: string; next_at: string } {
    if (!CARD_KIND[args.tool]) throw new HumanUseError("HRT-4000", `NOT_A_HUMAN_TOOL ${args.tool}`);
    const everyS = parseDuration(args.every);
    if (everyS < 60) throw new HumanUseError("HRT-4001", "every must be at least 1m");
    // Settle the unit now, so adding another unit later does not leave this schedule ambiguous.
    const call = { ...args.call, unit: this.unit(args.call.unit).id };
    if (call.goal) this.goal(call.goal);
    const nextAt = args.at ? resolveTime(args.at, this.clock) : addSeconds(this.clock.now(), everyS).toISOString();
    const scheduleId = id("s");
    this.store.insert("schedules", { id: scheduleId, goal_id: call.goal ?? null, next_at: nextAt, every_s: everyS, active: 1, data: JSON.stringify({ tool: args.tool, call }) });
    this.store.event(this.now(), "schedule_created", scheduleId, args.call.goal ?? null, { every_s: everyS, tool: args.tool });
    return { schedule: scheduleId, next_at: nextAt };
  }

  stopSchedule(scheduleId: string): void {
    const changed = this.store.run("UPDATE schedules SET active = 0 WHERE id = ?", scheduleId).changes;
    if (!changed) throw new HumanUseError("HRT-4004", `NO_SUCH_SCHEDULE ${scheduleId}`);
  }

  /**
   * Time since a tool (or label) last completed, plus exact counts. Counting is the runtime's job, not the model's.
   * Counts every unit unless `unit` names one.
   */
  since(args: { tool?: string | undefined; label?: string | undefined; unit?: string | undefined }): { last: string | null; seconds: number | null; count_7d: number; streak_days: number } {
    const unit = args.unit ? this.unit(args.unit).id : null;
    const rows = this.store.all<{ updated_at: string; data: string }>("SELECT updated_at, data FROM jobs WHERE status = 'done' AND (? IS NULL OR tool = ?) AND (? IS NULL OR unit_id = ?) ORDER BY updated_at DESC",
      args.tool ?? null, args.tool ?? null, unit, unit)
      .filter(row => !args.label || (JSON.parse(row.data) as JobData).label === args.label);
    const now = this.clock.now();
    const last = rows[0]?.updated_at ?? null;
    const weekAgo = addSeconds(now, -7 * 86400).toISOString();
    const days = new Set(rows.map(row => new Date(row.updated_at).toDateString()));
    let streak = 0;
    const cursor = new Date(now);
    if (!days.has(cursor.toDateString())) cursor.setDate(cursor.getDate() - 1);   // today not done yet doesn't break the streak
    while (days.has(cursor.toDateString())) { streak++; cursor.setDate(cursor.getDate() - 1); }
    return {
      last,
      seconds: last ? Math.round((now.getTime() - new Date(last).getTime()) / 1000) : null,
      count_7d: rows.filter(row => row.updated_at >= weekAgo).length,
      streak_days: streak
    };
  }

  /**
   * Overdue maintenance as plain facts, e.g. "meal: 6h12m ago", per unit; with several units each line starts with
   * the unit's name: "mika meal: 6h12m ago". Quiet while a call for it is pending for that unit.
   */
  warnings(): string[] {
    const units = this.units();
    return units.flatMap(unit => MAINTENANCE.flatMap(([tool, label, hours]) => {
      if (this.store.get(`SELECT 1 FROM jobs WHERE tool = ? AND unit_id = ? AND status IN ${OPEN_STATES}`, tool, unit.id)) return [];
      const who = units.length > 1 ? `${unit.name} ` : "";
      const { seconds } = this.since({ tool, unit: unit.id });
      if (seconds === null) return [`${who}${label}: none recorded`];
      return seconds >= hours * 3600 ? [`${who}${label}: ${ago(seconds)} ago`] : [];
    }));
  }

  // ------------------------------------------------------------ goals

  goal(goalId: string): Goal {
    const row = this.store.get<GoalRow>("SELECT * FROM goals WHERE id = ?", goalId);
    if (!row) throw new HumanUseError("HRT-4004", `NO_SUCH_GOAL ${goalId}`);
    return { ...row, data: JSON.parse(row.data) as GoalData };
  }

  goals(status: Goal["status"] | "all" = "active"): Goal[] {
    return this.store.all<GoalRow>("SELECT * FROM goals WHERE ? = 'all' OR status = ? ORDER BY created_at", status, status)
      .map(row => ({ ...row, data: JSON.parse(row.data) as GoalData }));
  }

  setGoal(data: GoalData, wake?: { at: string; why: string }): { goal: string; next_wake: { at: string; why: string } } {
    const goalId = id("g");
    const now = this.now();
    this.store.insert("goals", { id: goalId, created_at: now, status: "active", data: JSON.stringify(data) });
    this.store.event(now, "goal_set", goalId, goalId, { goal: data.goal });
    const next = wake ?? { at: nextMorning(this.clock.now()).toISOString(), why: "first review" };
    this.wake(goalId, next.at, next.why);
    return { goal: goalId, next_wake: { at: resolveTime(next.at, this.clock), why: next.why } };
  }

  note(goalId: string, decision: string, reason: string, metric?: number, agenda?: string): void {
    this.goal(goalId);
    this.store.event(this.now(), "note", goalId, goalId, { decision, reason, ...(metric !== undefined ? { metric } : {}), ...(agenda ? { agenda } : {}) });
  }

  /** Set the goal's single next wake, replacing any pending one. */
  wake(goalId: string, at: string, why: string): { goal: string; at: string; why: string } {
    const goal = this.goal(goalId);
    if (goal.status !== "active") throw new HumanUseError("HRT-4009", `GOAL_NOT_ACTIVE ${goal.status}`);
    const when = resolveTime(at, this.clock);
    this.store.tx(() => {
      this.store.run("UPDATE wakes SET replaced = 1 WHERE goal_id = ? AND fired_at IS NULL AND replaced = 0", goalId);
      this.store.insert("wakes", { id: id("w"), goal_id: goalId, at: when, why, fired_at: null, replaced: 0 });
    });
    return { goal: goalId, at: when, why };
  }

  private nextWake(goalId: string): { at: string; why: string } | null {
    return this.store.get<{ at: string; why: string }>("SELECT at, why FROM wakes WHERE goal_id = ? AND fired_at IS NULL AND replaced = 0 ORDER BY at LIMIT 1", goalId) ?? null;
  }

  /** Close a goal. Cancelling is immediate (lead only: cards have no entry for it). "done" goes to the driver with the evidence. */
  closeGoal(goalId: string, outcome: "done" | "cancelled", reason: string): { goal: string; status: string; check_job?: string } {
    const goal = this.goal(goalId);
    if (goal.status !== "active") throw new HumanUseError("HRT-4009", `GOAL_NOT_ACTIVE ${goal.status}`);
    if (outcome === "cancelled") {
      this.endGoal(goal, "cancelled", reason);
      return { goal: goalId, status: "cancelled" };
    }
    if (!this.driver) throw new HumanUseError("HRT-5030", "VERIFIER_UNAVAILABLE a goal closes as done only after its evidence is checked against done_when");
    const now = this.now();
    const jobId = id("j");
    const data: JobData = { instruction: `Check done_when against the evidence. Agent says: ${reason}`, args: {}, max_rounds: 1, rounds: [], internal: true };
    this.store.insert("jobs", { id: jobId, goal_id: goalId, tool: "goal_check", status: "review", priority: "standard", created_at: now, updated_at: now, send_at: null, due_at: null, data: JSON.stringify(data) });
    this.track(this.consult(jobId, "goal_check", null), "driver.goal_check");
    return { goal: goalId, status: "checking", check_job: jobId };
  }

  private closeChecked(job: Job, result: Record<string, unknown>): void {
    this.saveJob(job, { status: "done", data: { ...job.data, result } });
    if (job.goal_id) this.endGoal(this.goal(job.goal_id), "done", String(result.reason ?? "evidence accepted"));
    this.release(job.id);
  }

  private endGoal(goal: Goal, status: "done" | "cancelled", reason: string): void {
    this.store.tx(() => {
      this.store.update("goals", goal.id, { status });
      this.store.run("UPDATE wakes SET replaced = 1 WHERE goal_id = ? AND fired_at IS NULL", goal.id);
      this.store.run("UPDATE schedules SET active = 0 WHERE goal_id = ?", goal.id);
      for (const row of this.store.all<{ id: string }>("SELECT id FROM jobs WHERE goal_id = ? AND status IN ('scheduled','queued','open')", goal.id)) this.cancel(row.id, `goal ${status}`);
      this.store.event(this.now(), "goal_closed", goal.id, goal.id, { status, reason });
      this.deliver({ type: "goal_closed", goal: goal.id, outcome: status }, goal.id);
    });
  }

  private evidenceFor(goalId: string): DriverInput["evidence"] {
    return this.store.all<{ id: string; level: number; kind: string; at: string; data: string }>("SELECT id, level, kind, at, data FROM evidence WHERE goal_id = ? ORDER BY level, at DESC LIMIT 50", goalId)
      .map(row => ({ ...row, data: JSON.parse(row.data) as unknown }));
  }

  briefing(goalId: string, why = "requested"): Briefing {
    const goal = this.goal(goalId);
    const since = goal.data.last_wake_at ?? null;
    const events = this.store.all<{ at: string; kind: string; ref: string | null; data: string }>(
      `SELECT at, kind, ref, data FROM events WHERE goal_id = ? AND (? IS NULL OR at > ?)
       AND kind NOT IN ('card_shown','answer','job_created','compile_failed','driver_missing','overseer_missing','note','woken','brain_exit') ORDER BY seq DESC LIMIT 100`,
      goalId, since, since).reverse().map(row => ({ ...row, data: JSON.parse(row.data) as unknown }));
    const notes = this.store.all<{ at: string; data: string }>("SELECT at, data FROM events WHERE goal_id = ? AND kind = 'note' ORDER BY seq", goalId)
      .map(row => ({ at: row.at, ...(JSON.parse(row.data) as { decision: string; reason: string; metric?: number; agenda?: string }) }));
    const agendaNote = notes.findLast(note => note.agenda);
    const open = this.store.all<JobRow>("SELECT * FROM jobs WHERE goal_id = ? AND status IN ('scheduled','queued','open','review') ORDER BY created_at", goalId)
      .map(row => ({ id: row.id, tool: row.tool, status: row.status, task: (JSON.parse(row.data) as JobData).instruction, created_at: row.created_at, send_at: row.send_at }));
    const schedules = this.store.all<{ id: string; every_s: number; next_at: string; data: string }>("SELECT * FROM schedules WHERE goal_id = ? AND active = 1", goalId)
      .map(row => ({ id: row.id, every_s: row.every_s, next_at: row.next_at, tool: (JSON.parse(row.data) as { tool: string }).tool }));

    let metric: Briefing["metric"] = null;
    if (goal.data.metric) {
      metric = {
        name: goal.data.metric.name,
        unit: goal.data.metric.unit ?? null,
        expected_now: interpolate(goal.data.metric.plan, this.clock.now()),
        actual: notes.filter(note => note.metric !== undefined).map(note => ({ at: note.at, value: note.metric! }))
      };
    }
    return {
      now: this.now(),
      why,
      goal: { id: goal.id, status: goal.status, created_at: goal.created_at, ...goal.data },
      metric,
      since,
      events,
      lang: this.lang,
      units: this.units().map(unit => ({ ...this.unitState(unit), stats: this.stats(unit.id) })),
      open_jobs: open,
      schedules,
      agenda: agendaNote ? { at: agendaNote.at, text: agendaNote.agenda! } : null,
      decisions: notes.slice(-10).map(({ at, decision, reason }) => ({ at, decision, reason })),
      budget: this.budget(goalId),
      next_wake: this.nextWake(goalId),
      warnings: this.warnings(),
      write_back: "Before this pass ends: goal_note(decision, reason[, metric][, agenda]) and wake(at, why). Rewrite agenda whenever this pass changed it. A goal with no pending wake is treated as stalled."
    };
  }

  /** Wake the brain for a goal now, with a full briefing. */
  private fire(goalId: string, why: string): void {
    const goal = this.goal(goalId);
    if (goal.status !== "active") return;
    const now = this.now();
    if (!this.brain) {
      this.store.tx(() => {
        this.deliver({ type: "wake", goal: goal.id, why }, goal.id);
        this.store.event(now, "woken", goal.id, goal.id, { why });
      });
      return;
    }
    const briefing = this.briefing(goalId, why);
    this.drain(goalId);                                             // the briefing's event list already carries these
    this.store.update("goals", goal.id, { data: JSON.stringify({ ...goal.data, last_wake_at: now }) });
    this.store.event(briefing.now, "woken", goal.id, goal.id, { why, pass: true });   // the brain's exit names this time
    this.track(Promise.resolve(this.brain.wake(goal.id, briefing)), "brain.wake");
  }

  /** Per-tool counts for one unit. Exact, from the job table. */
  stats(unitId: string): Record<string, ToolStats> {
    const rows = this.store.all<JobRow>("SELECT * FROM jobs WHERE status IN ('done','expired','escalated') AND tool NOT IN ('goal_check','remind') AND unit_id = ?", unitId);
    const byTool = new Map<string, { done: number; expired: number; escalated: number; took: number[] }>();
    for (const row of rows) {
      const data = JSON.parse(row.data) as JobData;
      if (data.internal) continue;
      const entry = byTool.get(row.tool) ?? { done: 0, expired: 0, escalated: 0, took: [] };
      entry[row.status as "done" | "expired" | "escalated"]++;
      const shown = data.rounds[0]?.at;
      if (row.status === "done" && shown && CARD_KIND[row.tool] !== "theater") entry.took.push((new Date(row.updated_at).getTime() - new Date(shown).getTime()) / 1000);
      byTool.set(row.tool, entry);
    }
    return Object.fromEntries([...byTool].map(([tool, entry]) => {
      const sorted = entry.took.sort((a, b) => a - b);
      return [tool, { calls: entry.done + entry.expired + entry.escalated, done: entry.done, expired: entry.expired, escalated: entry.escalated, median_s: sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]!) : null }];
    }));
  }

  /** Settled calls, newest first, as structured rows. Every unit unless `unit` names one. */
  history(args: { goal?: string | undefined; tool?: string | undefined; unit?: string | undefined; limit?: number | undefined }): Array<{ job: string; tool: string; state: JobStatus; goal: string | null; unit: string | null; task: string; created_at: string; settled_at: string; took_s: number | null; result: Record<string, unknown> | null; reason: string | null }> {
    const unit = args.unit ? this.unit(args.unit).id : null;
    const names = new Map(this.units().map(entry => [entry.id, entry.name]));
    return this.store.all<JobRow>(
      "SELECT * FROM jobs WHERE status IN ('done','expired','escalated','cancelled') AND tool <> 'goal_check' AND (? IS NULL OR goal_id = ?) AND (? IS NULL OR tool = ?) AND (? IS NULL OR unit_id = ?) ORDER BY updated_at DESC LIMIT ?",
      args.goal ?? null, args.goal ?? null, args.tool ?? null, args.tool ?? null, unit, unit, Math.min(args.limit ?? 30, 200))
      .map(row => ({ row, data: JSON.parse(row.data) as JobData }))
      .filter(({ data }) => !data.internal)
      .map(({ row, data }) => {
        const shown = data.rounds[0]?.at;
        return {
          job: row.id, tool: row.tool, state: row.status, goal: row.goal_id, unit: row.unit_id ? names.get(row.unit_id) ?? null : null,
          task: data.instruction, created_at: row.created_at, settled_at: row.updated_at,
          took_s: shown ? Math.round((new Date(row.updated_at).getTime() - new Date(shown).getTime()) / 1000) : null,
          result: data.result ?? null, reason: data.reason ?? null
        };
      });
  }

  // ------------------------------------------------------------ clock

  /** One pass of the clock. The daemon calls this every few seconds; simulations call it with an accelerated clock. */
  tick(): { released: number; repeated: number; expired: number; woken: number; stalled: number } {
    const now = this.now();
    const counts = { released: 0, repeated: 0, expired: 0, woken: 0, stalled: 0 };

    for (const row of this.store.all<{ id: string; goal_id: string | null }>("SELECT id, goal_id FROM jobs WHERE status = 'scheduled' AND send_at <= ?", now)) {
      this.store.run("UPDATE jobs SET status = 'queued', updated_at = ? WHERE id = ?", now, row.id);
      counts.released++;
    }

    for (const row of this.store.all<{ id: string; next_at: string; every_s: number; data: string }>("SELECT * FROM schedules WHERE active = 1 AND next_at <= ?", now)) {
      const { tool, call } = JSON.parse(row.data) as { tool: string; call: DispatchArgs };
      let next = new Date(row.next_at);
      while (next.toISOString() <= now) next = addSeconds(next, row.every_s);  // missed runs are skipped, not stacked
      this.store.run("UPDATE schedules SET next_at = ? WHERE id = ?", next.toISOString(), row.id);
      try {
        this.dispatch(tool, { ...call, at: undefined, label: call.label ?? row.id });
        counts.repeated++;
      } catch (error) {
        this.store.event(now, "schedule_failed", row.id, call.goal ?? null, { error: String(error) });
      }
    }

    for (const row of this.store.all<JobRow>("SELECT * FROM jobs WHERE status = 'open' AND due_at IS NOT NULL AND due_at <= ?", now)) {
      const job = { ...row, data: JSON.parse(row.data) as JobData };
      const saved = this.saveJob(job, { status: "expired" });
      this.store.event(now, "job_expired", job.id, job.goal_id, { tool: job.tool });
      if (this.channel) this.track(Promise.resolve(this.channel.withdraw(job.id, "EXPIRED", job.unit_id)), "channel.withdraw");
      if (!job.data.internal) this.deliver({ type: "expired", job: job.id, tool: job.tool, goal: job.goal_id }, job.goal_id);
      this.settled(saved);
      counts.expired++;
    }

    for (const goal of this.goals("active")) {
      if (!this.nextWake(goal.id)) {
        const at = nextMorning(this.clock.now()).toISOString();
        this.wake(goal.id, at, "stalled: no next_wake was set");
        this.store.event(now, "stalled", goal.id, goal.id, { wake_at: at });
        counts.stalled++;
      }
    }

    this.store.tx(() => {
      for (const row of this.store.all<{ id: string; goal_id: string; why: string }>("SELECT id, goal_id, why FROM wakes WHERE fired_at IS NULL AND replaced = 0 AND at <= ? ORDER BY at", now)) {
        this.store.run("UPDATE wakes SET fired_at = ? WHERE id = ?", now, row.id);
        this.fire(row.goal_id, row.why);
        counts.woken++;
      }
    });

    this.pump();
    return counts;
  }

  /** Open and queued work, newest first. */
  ps(): Array<JobView & { priority: Priority }> {
    return this.store.all<JobRow>("SELECT * FROM jobs WHERE status IN ('scheduled','queued','open','review') ORDER BY created_at DESC LIMIT 100")
      .filter(row => row.tool !== "goal_check" && !(JSON.parse(row.data) as JobData).internal)
      .map(row => ({ ...this.view(row.id), priority: row.priority }));
  }
}

/** Linear interpolation of a plan curve at `date`. Null before the first point. */
export function interpolate(plan: Array<[string, number]>, date: Date): number | null {
  const points = plan.map(([at, value]) => [new Date(at).getTime(), value] as const).sort((a, b) => a[0] - b[0]);
  const t = date.getTime();
  if (!points.length || t < points[0]![0]) return null;
  for (let index = 1; index < points.length; index++) {
    const [t0, v0] = points[index - 1]!;
    const [t1, v1] = points[index]!;
    if (t <= t1) return Math.round((v0 + (v1 - v0) * (t - t0) / (t1 - t0)) * 100) / 100;
  }
  return points.at(-1)![1];
}
