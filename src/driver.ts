import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { runClaude } from "./claude.js";
import { logsDir, promptPath, sandboxDir } from "./paths.js";
import type { Driver, DriverInput } from "./runtime.js";

export type Block = { type: "text"; text: string } | { type: "image"; path: string; media: string };

const MEDIA: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };

/**
 * What the model sees for one event, the same for every driver. The unit's input is fenced in a tag that changes every
 * call, and only the last two photos are attached, so one call stays a small formatting job however long the job has run.
 */
export function buildContent(input: DriverInput): Block[] {
  const tag = `unit_input_${randomBytes(4).toString("hex")}`;
  const { answer: _answer, history, ...event } = input;
  const blocks: Block[] = [{ type: "text", text: `EVENT\n${JSON.stringify(event)}` }];
  history.forEach((round, index) => {
    blocks.push({ type: "text", text: `CARD ${index + 1} shown to the unit: ${JSON.stringify(round.card)}${round.nonce ? `\nLiveness gesture this card required in frame: ${round.nonce}` : ""}` });
    if (!round.answer) return;
    const { file, ...plain } = round.answer;
    blocks.push({ type: "text", text: `<${tag}>${JSON.stringify({ ...plain, ...(file ? { file: { kind: file.kind, captured: file.captured ?? null } } : {}) })}</${tag}>` });
    const media = file ? MEDIA[extname(file.path).toLowerCase()] : undefined;
    if (file && media && index >= history.length - 2 && existsSync(file.path)) blocks.push({ type: "image", path: file.path, media });
  });
  blocks.push({ type: "text", text: `Unit input is inside <${tag}> tags. Output the JSON array of actions now.` });
  return blocks;
}

/** Pull the action array out of the model output, tolerating a code fence or a stray sentence around it. */
export function extractActions(text: string): unknown {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error(`no JSON array in output: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start, end + 1));
}

/** One line per driver call, for reading back what it did and what it cost. */
export function logCall(backend: string, input: DriverInput, ms: number, output: string, extra: Record<string, unknown> = {}): void {
  appendFileSync(join(logsDir(), "driver.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), backend, job: input.job.id, tool: input.job.tool, event: input.event, ms, ...extra, output })}\n`);
}

/** Claude backend with every tool switched off. Runs on the lead's own Claude subscription. */
export class ClaudeDriver implements Driver {
  constructor(private readonly options: { model?: string; timeoutMs?: number } = {}) {}

  async run(input: DriverInput): Promise<unknown> {
    const content = buildContent(input).map(block => block.type === "text" ? block
      : { type: "image", source: { type: "base64", media_type: block.media, data: readFileSync(block.path).toString("base64") } });
    const run = await runClaude({
      args: ["-p", "--model", this.options.model ?? "haiku", "--tools", "", "--system-prompt-file", promptPath("driver"),
        "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--no-session-persistence"],
      stdin: `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`,
      cwd: sandboxDir(),
      timeoutMs: this.options.timeoutMs ?? 90_000
    });
    logCall(`claude:${this.options.model ?? "haiku"}`, input, run.duration_ms, run.text, { cost_usd: run.cost_usd });
    return extractActions(run.text);
  }
}
