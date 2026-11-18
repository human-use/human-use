/**
 * The closed tool catalog. Source of truth for MCP registration.
 * `release` says when a tool ships: v0.1 is the first public release, "later" is designed but not scheduled.
 * See docs/DESIGN.md §三.
 */
export type Category = "sample" | "mutate" | "resolve" | "tunnel" | "identity" | "maintain" | "tune" | "clock" | "meta" | "goal";
export type Release = "v0.1" | "later";

export interface ToolEntry {
  name: string;
  category: Category;
  summary: string;
  release: Release;
}

export const CATEGORIES: Record<Category, string> = {
  sample: "read the physical world and the unit's current state",
  mutate: "change the physical world",
  resolve: "borrow judgment: high-context decoding, first-impression picks, accountable confirmation",
  tunnel: "borrow the unit's social channels",
  identity: "borrow legal identity and money",
  maintain: "upkeep",
  tune: "change the unit's own performance",
  clock: "time",
  meta: "the unit's record",
  goal: "long-running goals held by the runtime"
};

const t = (category: Category, release: Release, name: string, summary: string): ToolEntry => ({ name, category, summary, release });

export const CATALOG: readonly ToolEntry[] = [
  t("sample", "v0.1", "observe", "The unit looks at a target and reports the fields in want."),
  t("sample", "v0.1", "photo", "Live photo of a target. Fields in want are read from the image; files gives the image itself."),
  t("sample", "v0.1", "record", "Voice or ambient audio recording."),
  t("sample", "v0.1", "verify", "Check a claim on site, with a photo."),
  t("sample", "v0.1", "status", "Current location, energy and availability."),
  t("sample", "later", "feed", "Connect an external data source: health, fitness, sensors."),
  t("mutate", "v0.1", "go", "Move the unit to a place."),
  t("mutate", "v0.1", "act", "One physical or on-device action."),
  t("mutate", "v0.1", "checklist", "A sequence of steps, each checked off."),
  t("mutate", "v0.1", "errand", "Go somewhere, do something, come back with a result."),
  t("mutate", "later", "be", "Stay somewhere for a duration."),
  t("resolve", "v0.1", "choose", "First-impression pick among options."),
  t("resolve", "v0.1", "decode", "Read the subtext of a message."),
  t("resolve", "later", "label", "Label a batch of items."),
  t("tunnel", "later", "relay", "Pass a message to another person and bring back the answer."),
  t("tunnel", "later", "call", "Phone someone on the agent's behalf."),
  t("identity", "v0.1", "spend", "Purchase within the goal's monthly budget. Receipt required; booked to the ledger."),
  t("identity", "later", "sign", "Sign a document."),
  t("identity", "later", "approve", "An accountable yes from a person."),
  t("identity", "later", "appear", "Show up in person where a body or a face is required."),
  t("maintain", "v0.1", "eat", "Scheduled feeding."),
  t("maintain", "v0.1", "sleep", "Scheduled sleep window."),
  t("maintain", "v0.1", "rest", "Short downtime."),
  t("maintain", "v0.1", "recharge", "Lifts unit mood. Seconds, no cost. Variants: flower, joke, praise."),
  t("maintain", "v0.1", "mood", "Poll unit mood, 1 to 5."),
  t("tune", "v0.1", "patch", "Train one skill: a drill with a measurable result."),
  t("tune", "v0.1", "bench", "Multi-round spec audit. Variants: assets, hours, screen_time."),
  t("tune", "later", "align", "Change one habit or preference."),
  t("clock", "v0.1", "at", "Run one tool call at a set time."),
  t("clock", "v0.1", "every", "Run a tool call on a schedule."),
  t("clock", "v0.1", "since", "Time since a tool or label last completed, with exact counts and streak."),
  t("clock", "v0.1", "remind", "A reminder to the unit, or to the agent in a later briefing."),
  t("clock", "v0.1", "wake", "When this goal's next pass runs, and why."),
  t("clock", "v0.1", "wait", "Block on a job already dispatched."),
  t("clock", "v0.1", "cancel", "Cancel a job or a schedule."),
  t("clock", "v0.1", "reschedule", "Move a pending job."),
  t("meta", "v0.1", "ps", "Units (online, last touch, upkeep, mood, open jobs), pending jobs with their state, and active goals."),
  t("meta", "v0.1", "spec", "Each unit's numbers: language, per-tool completion counts and median time."),
  t("meta", "v0.1", "history", "Settled calls as structured rows."),
  t("meta", "later", "propose_tool", "Propose a new variant of an existing tool."),
  t("goal", "v0.1", "goal_set", "Create a goal: statement, kind, done_when, deadline, metric plan."),
  t("goal", "v0.1", "goal_get", "The full briefing for a goal."),
  t("goal", "v0.1", "goal_note", "Append a decision and its reason to the goal's log, optionally with a measured metric value and a new agenda for the passes after this one."),
  t("goal", "v0.1", "goal_close", "Close a goal: done once the evidence is checked against done_when; cancelled only on the lead's word.")
];

export function find(name: string): ToolEntry | undefined {
  return CATALOG.find(entry => entry.name === name);
}
