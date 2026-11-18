import { readFile, realpath, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, isAbsolute, relative } from "node:path";
import QRCode from "qrcode";
import * as z from "zod/v4";
import { saveRuntimeConfig } from "./config.js";
import { makeBrain, makeDriver, parseBackend, type BackendSpec } from "./backends.js";
import { codexUserDefaults } from "./codex.js";
import type { Store } from "./store.js";
import { resolveTime, systemClock } from "./time.js";
import { HumanUseError, type Answer, type JobData, type JobStatus, type Runtime, type Unit } from "./runtime.js";
import type { UnitLinks, UnitPairing } from "./units.js";
import { VERSION } from "./version.js";

const page = new URL("../assets/owner.html", import.meta.url);
const goalInput = z.object({
  goal: z.string().trim().min(1),
  done_when: z.string().trim().optional(),
  deadline: z.string().trim().min(1).optional(),
  budget: z.object({ monthly: z.number().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/) }).optional()
});
const cancellation = z.object({ goal: z.string().min(1), reason: z.string().min(1).default("lead cancelled") });
const unitInput = z.object({ name: z.string().trim().min(1) });
const unitRef = z.object({ unit: z.string().trim().min(1).optional() });
const settingsInput = z.object({ driver: z.string().trim().min(1).optional(), brain: z.string().trim().min(1).optional() });
const types: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif",
  ".webm": "audio/webm", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".m4a": "audio/mp4"
};

/** What the lead page is served with. The routes keep their /owner/ prefix. */
interface LeadOptions {
  runtime: Runtime;
  units: UnitLinks;
  stateDir: string;
  filesDir: string;
  addUnit(name: string): Unit;
  driver: BackendSpec;
  brain: BackendSpec;
  /** Put saved settings into effect without a restart. */
  apply?(update: { driver?: string | undefined; brain?: string | undefined }): void;
}

function backendLabel(value: BackendSpec): string {
  const { backend, model, effort } = parseBackend(value);
  return [backend, model, effort].filter(Boolean).join(":");
}

/** A Codex brain with no model named runs the lead's own Codex model; show which. */
function brainLabel(value: BackendSpec): string {
  const spec = parseBackend(value);
  if (spec.backend !== "codex" || spec.model) return backendLabel(value);
  const own = codexUserDefaults();
  return ["codex", own.model ?? "default", spec.effort ?? own.effort].filter(Boolean).join(":");
}

export interface Pass { at: string; why: string; state: "running" | "waiting" | "done" | "failed" | "lost"; calls?: number; tools?: string[]; ms?: number; error?: string }

/**
 * The brain's background passes for one goal, newest first: when it woke, why, and what came of it. A wake that came
 * while a pass was running waits; only the newest waiting one runs, so the others are left out. A wake handed to the
 * window (no brain configured) is not a pass; neither is an unmatched wake recorded before passes were marked.
 */
export function goalPasses(store: Store, goalId: string, now = Date.now()): Pass[] {
  const rows = store.all<{ at: string; kind: string; data: string }>(
    "SELECT at, kind, data FROM events WHERE goal_id = ? AND kind IN ('woken','brain_exit') ORDER BY seq DESC LIMIT 40", goalId).reverse();
  const passes: Array<Pass & { ended?: number; unmarked?: boolean }> = [];
  for (const row of rows) {
    const data = JSON.parse(row.data) as { why?: string; pass?: boolean; woke_at?: string; ok?: boolean; calls?: number; tools?: string[]; ms?: number; error?: string };
    if (row.kind === "woken") { passes.push({ at: row.at, why: data.why ?? "", state: "running", ...(data.pass ? {} : { unmarked: true }) }); continue; }
    const pass = data.woke_at ? passes.find(candidate => candidate.at === data.woke_at) : passes.findLast(candidate => candidate.state === "running");
    if (!pass) continue;
    pass.state = data.ok ? "done" : "failed";
    pass.ended = Date.parse(row.at);
    for (const key of ["calls", "tools", "ms", "error"] as const) if (data[key] !== undefined) Object.assign(pass, { [key]: data[key] });
  }
  const shown: Pass[] = [];
  let open = false;                                                          // an earlier pass may still be running
  const marked = passes.filter(pass => pass.state !== "running" || !pass.unmarked);
  marked.forEach((pass, index) => {
    if (pass.state === "running") {
      const at = Date.parse(pass.at);
      const later = marked[index + 1];
      const aheadEnd = marked.find(other => other.ended !== undefined && Date.parse(other.at) < at && at < other.ended)?.ended;
      if (aheadEnd !== undefined && later && Date.parse(later.at) < aheadEnd) return;   // waited, then a newer wake replaced it
      if (now - Math.max(at, aheadEnd ?? 0) > 16 * 60_000) pass.state = "lost";          // a pass is cut off after 15 minutes
      else if (!open) open = true;
      else if (later) return;
      else pass.state = "waiting";
    }
    const { ended: _ended, unmarked: _unmarked, ...plain } = pass;
    shown.push(plain);
  });
  return shown.reverse().slice(0, 5);
}

export function localOwner(req: IncomingMessage): boolean {
  const { host, origin } = req.headers;
  return /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(host ?? "") && (!origin || origin === `http://${host}`);
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

async function input<T>(req: IncomingMessage, schema: z.ZodType<T>): Promise<T> {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json") {
    throw new HumanUseError("HRT-4001", "Expected an application/json body");
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new HumanUseError("HRT-4001", "Request body too large");
    chunks.push(chunk as Buffer);
  }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HumanUseError("HRT-4001", "Invalid JSON"); }
  const result = schema.safeParse(body);
  if (!result.success) throw new HumanUseError("HRT-4001", z.prettifyError(result.error));
  return result.data;
}

function goals(runtime: Runtime, background: boolean) {
  return runtime.goals("all").map(goal => {
    const briefing = runtime.briefing(goal.id);
    return {
      id: goal.id, status: goal.status, text: goal.data.goal, done_when: goal.data.done_when, deadline: goal.data.deadline ?? null,
      metric: briefing.metric ? { name: briefing.metric.name, unit: briefing.metric.unit, expected_now: briefing.metric.expected_now, latest: briefing.metric.actual.at(-1) ?? null } : null,
      open_jobs: briefing.open_jobs.length, budget: briefing.budget, next_wake: briefing.next_wake,
      last_decision: briefing.decisions.at(-1) ?? null, agenda: briefing.agenda,
      passes: background ? goalPasses(runtime.store, goal.id) : []
    };
  });
}

/** The unit's reply as one line. Files show only their kind; the lead opens them from the evidence column. */
const answerLine = (answer: Answer) => [
  answer.text, answer.choice, answer.value === undefined ? undefined : String(answer.value),
  answer.checked && `checked ${answer.checked.join(",")}`,
  answer.file && `[${answer.file.kind}${answer.file.captured === "upload" ? ", uploaded" : ""}]`,
  answer.location && `${answer.location.lat.toFixed(5)}, ${answer.location.lon.toFixed(5)}`
].filter(Boolean).join(" · ");

function calls(runtime: Runtime) {
  const rows = runtime.store.all<{
    id: string; tool: string; job_id: string | null; goal_id: string | null; unit: string | null; state: string;
    started_at: number; ended_at: number | null; args: string | null; response: string | null;
    job_data: string | null; job_state: JobStatus | null
  }>(
    `SELECT calls.id AS id, calls.tool AS tool, jobs.id AS job_id, jobs.goal_id AS goal_id, units.name AS unit, COALESCE(calls.outcome, 'running') AS state,
            calls.started_at, calls.ended_at, calls.args, calls.response, jobs.data AS job_data, jobs.status AS job_state
     FROM calls LEFT JOIN jobs ON jobs.id = calls.job_id LEFT JOIN units ON units.id = jobs.unit_id
     UNION ALL
     SELECT jobs.id, jobs.tool, jobs.id, jobs.goal_id, units.name, 'job', unixepoch(jobs.created_at) * 1000,
            CASE WHEN jobs.status IN ('done','escalated','expired','cancelled') THEN unixepoch(jobs.updated_at) * 1000 END,
            NULL, NULL, jobs.data, jobs.status
     FROM jobs LEFT JOIN units ON units.id = jobs.unit_id
     WHERE jobs.tool <> 'goal_check' AND json_extract(jobs.data, '$.internal') IS NOT TRUE
       AND NOT EXISTS (SELECT 1 FROM calls WHERE calls.job_id = jobs.id AND calls.tool <> 'wait')
     ORDER BY started_at DESC, id DESC LIMIT 100`
  );
  return rows.map(row => {
    const job = row.job_data ? JSON.parse(row.job_data) as JobData : null;
    const response = row.response ? JSON.parse(row.response) : null;
    const result = job?.result ?? null;
    return {
      id: row.id, job: row.job_id, tool: row.tool, state: row.job_state ?? row.state, call_state: row.state,
      goal: row.goal_id, unit: row.unit, at: new Date(row.started_at).toISOString(),
      args: row.args ? JSON.parse(row.args) : job?.args, task: job?.instruction ?? null,
      took_s: Math.max(0, Math.round(((row.ended_at ?? Date.now()) - row.started_at) / 1000)),
      response, ...(result && response?.result?.state !== row.job_state ? { result } : {}),
      reason: job?.reason ?? null, evidence: job?.evidence ?? [],
      held: job?.held && row.job_state === "review" ? job.held : null,
      // What passed between the card, the unit and the driver. The agent never sees this part.
      rounds: (job?.rounds ?? []).map(round => ({
        at: round.at, card: round.card, rejected: round.rejected ?? null,
        answered_at: round.answered_at ?? null, answer: round.answer ? answerLine(round.answer) : null
      })),
      compiled: job?.result ?? null
    };
  });
}

async function evidence(res: ServerResponse, manifest: LeadOptions, id: string): Promise<void> {
  const row = manifest.runtime.store.get<{ path: string | null; data: string }>("SELECT path, data FROM evidence WHERE id = ?", id);
  if (!row) { json(res, 404, { error: "not_found" }); return; }
  if (!row.path) { json(res, 200, JSON.parse(row.data)); return; }
  let path;
  try {
    path = await realpath(row.path);
    const local = relative(await realpath(manifest.filesDir), path);
    if (!local || local.startsWith("..") || isAbsolute(local) || !(await stat(path)).isFile()) throw new Error("invalid evidence path");
  } catch {
    json(res, 404, { error: "evidence_file_unavailable" });
    return;
  }
  const type = types[extname(path).toLowerCase()];
  res.writeHead(200, {
    "content-type": type ?? "application/octet-stream", "cache-control": "no-store",
    "x-content-type-options": "nosniff", "content-security-policy": "sandbox",
    ...(type ? {} : { "content-disposition": "attachment" })
  });
  const data = createReadStream(path);
  data.on("error", () => res.destroy());
  res.on("close", () => data.destroy());
  data.pipe(res);
}

/** Each unit as the lead page lists it: state, and how long since its phone last asked for cards. */
function unitRows(runtime: Runtime, links: UnitLinks) {
  const states = runtime.unitStates();
  return runtime.units().map((unit, index) => {
    const seen = links.seen(unit.id);
    return { id: unit.id, ...states[index]!, seen_s: seen === null ? null : Math.round((Date.now() - seen) / 1000) };
  });
}

async function withQr(pair: UnitPairing) {
  const link = pair.relay_url ?? pair.urls[0];
  return { ...pair, qr: link ? await QRCode.toDataURL(link, { width: 224, margin: 2 }) : null };
}

/** The lead page. All requests share the runtime but use the loopback listener rather than the phone server. */
export async function ownerRequest(req: IncomingMessage, res: ServerResponse, options: LeadOptions): Promise<void> {
  const { runtime, units } = options;
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  if (req.method === "GET" && path === "/ui.css") {
    const css = await readFile(new URL("../assets/ui.css", import.meta.url));
    res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-cache" });
    res.end(css);
  } else if (req.method === "GET" && path === "/") {
    const html = await readFile(page);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" });
    res.end(html);
  } else if (req.method === "GET" && path === "/owner/status") {
    const open = runtime.store.get<{ count: number }>("SELECT COUNT(*) AS count FROM jobs WHERE status = 'open'")?.count ?? 0;
    const held = runtime.store.get<{ count: number }>("SELECT COUNT(*) AS count FROM jobs WHERE status = 'review' AND json_extract(data, '$.held') IS NOT NULL")?.count ?? 0;
    json(res, 200, { version: VERSION, units: unitRows(runtime, units), driver: backendLabel(options.driver),
      brain: brainLabel(options.brain), open_jobs: open, held, calls: calls(runtime) });
  } else if (req.method === "GET" && path === "/owner/pair") {
    json(res, 200, await withQr(units.pairing(runtime.unit(url.searchParams.get("unit")).id)));
  } else if (req.method === "POST" && path === "/owner/pair/new") {
    // A JSON body, so a cross-site form cannot trigger it. Only the named unit's phone has to pair again.
    const { unit } = await input(req, unitRef);
    json(res, 200, await withQr(await units.renew(runtime.unit(unit).id)));
  } else if (req.method === "POST" && path === "/owner/units") {
    const { name } = await input(req, unitInput);
    const unit = options.addUnit(name);
    json(res, 200, await withQr(units.pairing(unit.id)));

  } else if (req.method === "GET" && path === "/owner/goals") {
    json(res, 200, { goals: goals(runtime, parseBackend(options.brain).backend !== "none") });
  } else if (req.method === "POST" && path === "/owner/goals") {
    const { goal, done_when, deadline, budget } = await input(req, goalInput);
    let due: string | undefined;
    try { if (deadline) due = resolveTime(deadline, systemClock); }
    catch (error) { throw new HumanUseError("HRT-4001", (error as Error).message); }
    json(res, 200, runtime.setGoal({
      goal, kind: "reach", done_when: done_when || goal, ...(due ? { deadline: due } : {}), ...(budget ? { budget } : {})
    }));
  } else if (req.method === "POST" && path === "/owner/goals/cancel") {
    const { goal, reason } = await input(req, cancellation);
    json(res, 200, runtime.closeGoal(goal, "cancelled", reason));
  } else if (req.method === "POST" && path === "/owner/settings") {
    const settings = await input(req, settingsInput);
    try {
      if (settings.driver !== undefined) makeDriver(settings.driver);
      if (settings.brain !== undefined) makeBrain(settings.brain, () => {});
    } catch (error) {
      throw new HumanUseError("HRT-4001", error instanceof Error ? error.message : "Invalid driver");
    }
    await saveRuntimeConfig(options.stateDir, {
      ...(settings.driver !== undefined ? { driver: settings.driver } : {}),
      ...(settings.brain !== undefined ? { brain: settings.brain } : {})
    });
    options.apply?.(settings);
    json(res, 200, { saved: true, applied: options.apply !== undefined });
  } else if (req.method === "GET" && /^\/owner\/evidence\/e_[a-f0-9]+$/.test(path)) {
    await evidence(res, options, path.slice("/owner/evidence/".length));
  } else {
    json(res, 404, { error: "not_found" });
  }
}
