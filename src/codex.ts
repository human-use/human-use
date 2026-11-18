import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { runProcess } from "./exec.js";
import { buildContent, extractActions, logCall } from "./driver.js";
import { home, logsDir, port, promptPath, sandboxDir, withBrainPrompt } from "./paths.js";
import type { Brain, Briefing, Driver, DriverInput } from "./runtime.js";

/**
 * Codex backends. The driver gets no tools. The brain gets the human-use MCP tools and web search.
 */

const toml = (value: unknown) => JSON.stringify(value);                    // JSON strings and arrays are valid TOML
const slashes = (path: string) => path.replace(/\\/g, "/");

/** Everything codex would otherwise hand the model. Listed, because disabling by omission is not possible. */
const NO_TOOLS = ["shell_tool", "unified_exec", "view_image", "apps", "plugins", "memories", "image_generation", "browser_use", "computer_use",
  "hooks", "multi_agent", "goals", "skill_search", "tool_suggest", "sleep_tool"].flatMap(feature => ["--disable", feature]);

/**
 * The model and effort the lead's own Codex runs. A background pass is the same agent as the window, so it uses these
 * unless the brain setting names a model. Read here because passes run with --ignore-user-config.
 */
export function codexUserDefaults(dir = process.env.CODEX_HOME || join(homedir(), ".codex")): { model?: string; effort?: string } {
  try {
    const parsed = parseToml(readFileSync(join(dir, "config.toml"), "utf8").replace(/^\uFEFF/, ""));
    return {
      ...(typeof parsed.model === "string" ? { model: parsed.model } : {}),
      ...(typeof parsed.model_reasoning_effort === "string" ? { effort: parsed.model_reasoning_effort } : {})
    };
  } catch {
    return {};
  }
}

function base(model: string | undefined, effort: string, prompt: string): string[] {
  return ["exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "-s", "read-only", ...(model ? ["-m", model] : []),
    "-c", `model_reasoning_effort=${toml(effort)}`, "-c", "project_doc_max_bytes=0", "-c", `model_instructions_file=${toml(slashes(prompt))}`,
    ...NO_TOOLS, "--json"];
}

/** The last agent message and the token usage, from codex's JSONL event stream. */
function parse(stdout: string): { text: string; usage: Record<string, number> | null; calls: number; tools: string[] } {
  let text = "";
  let usage: Record<string, number> | null = null;
  const tools: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string; tool?: string }; usage?: Record<string, number> };
      if (event.type === "item.completed" && event.item?.type === "agent_message") text = event.item.text ?? "";
      if (event.type === "item.completed" && event.item?.type === "mcp_tool_call") tools.push(event.item.tool ?? "?");
      if (event.type === "turn.completed" && event.usage) usage = event.usage;
    } catch { /* not JSON: ignore */ }
  }
  return { text, usage, calls: tools.length, tools };
}

export class CodexDriver implements Driver {
  constructor(private readonly options: { model?: string; effort?: string; timeoutMs?: number } = {}) {}

  async run(input: DriverInput): Promise<unknown> {
    const model = this.options.model ?? "gpt-6-luna";
    const effort = this.options.effort ?? "medium";           // with no reasoning the small model skips the follow-up rule
    const blocks = buildContent(input);
    const images = blocks.flatMap(block => block.type === "image" ? [block.path] : []);
    let seen = 0;
    const prompt = blocks.map(block => block.type === "text" ? block.text : `[attached image ${++seen}: the photo the unit sent with the input above]`).join("\n\n");
    const scratch = mkdtempSync(join(tmpdir(), "human-use-driver-"));
    try {
      const run = await runProcess({
        command: "codex",
        args: [...base(model, effort, promptPath("driver")), "-c", 'web_search="disabled"', "-o", join(scratch, "out.txt"), ...images.map(path => `--image=${path}`)],
        stdin: prompt, cwd: sandboxDir(), timeoutMs: this.options.timeoutMs ?? 120_000
      });
      const { text, usage } = parse(run.stdout);
      let output = text;
      try { output = readFileSync(join(scratch, "out.txt"), "utf8") || text; } catch { /* no file: use the stream */ }
      if (!output) throw new Error(`codex exited ${run.code} without output: ${run.stderr.slice(0, 300)}`);
      logCall(`codex:${model}:${effort}`, input, run.ms, output, { usage });
      return extractActions(output);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

export class CodexBrain implements Brain {
  private readonly running = new Set<string>();
  private readonly queued = new Map<string, Briefing>();

  constructor(private readonly options: { model?: string; effort?: string; timeoutMs?: number; onExit?: (goalId: string, info: Record<string, unknown>) => void } = {}) {}

  /** One pass per goal at a time. A wake that arrives mid-pass runs afterwards, newest briefing only. */
  wake(goalId: string, briefing: Briefing): void {
    if (this.running.has(goalId)) { this.queued.set(goalId, briefing); return; }
    this.running.add(goalId);
    void this.pass(goalId, briefing).finally(() => {
      this.running.delete(goalId);
      const next = this.queued.get(goalId);
      if (next) { this.queued.delete(goalId); this.wake(goalId, next); }
    });
  }

  private async pass(goalId: string, briefing: Briefing): Promise<void> {
    try {
      const script = process.argv[1];
      if (!script) throw new Error("cannot locate the human-use entry point for the MCP server");
      const own = codexUserDefaults();
      const model = this.options.model ?? own.model;
      const effort = this.options.effort ?? own.effort ?? "medium";
      const server = "mcp_servers.human-use";
      const run = await withBrainPrompt(prompt => runProcess({
        command: "codex",
        args: [...base(model, effort, prompt), "-c", 'approval_policy="never"', "-c", 'web_search="live"',
          "-c", `${server}.command=${toml(slashes(process.execPath))}`,
          "-c", `${server}.args=${toml([...process.execArgv, script, "mcp"].map(slashes))}`,
          "-c", `${server}.env={HUMAN_USE_HOME=${toml(slashes(home()))},HUMAN_USE_PORT=${toml(String(port()))},HUMAN_USE_SEAT="pass"}`,
          "-c", `${server}.startup_timeout_sec=30`, "-c", `${server}.tool_timeout_sec=600`,
          "-c", `${server}.default_tools_approval_mode="approve"`],   // headless: nobody is there to approve each call
        stdin: `WAKE goal=${goalId} why=${JSON.stringify(briefing.why)}\n\n${JSON.stringify(briefing, null, 1)}`,
        cwd: sandboxDir(), timeoutMs: this.options.timeoutMs ?? 15 * 60_000,
        logFile: join(logsDir(), `brain-${goalId}-${briefing.now.replace(/[:.]/g, "-")}.jsonl`)
      }));
      const { usage, calls, tools } = parse(run.stdout);
      this.options.onExit?.(goalId, { ok: run.code === 0, woke_at: briefing.now, backend: `codex:${model ?? "default"}:${effort}`, calls, tools, usage, ms: run.ms, ...(run.code === 0 ? {} : { error: run.stderr.slice(-300) }) });
    } catch (error) {
      this.options.onExit?.(goalId, { ok: false, woke_at: briefing.now, error: String(error) });
    }
  }
}
