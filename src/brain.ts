import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runClaude, type ClaudeRun } from "./claude.js";
import { home, logsDir, port, sandboxDir, withBrainPrompt } from "./paths.js";
import type { Brain, Briefing } from "./runtime.js";

/**
 * Wakes the brain as a headless `claude -p` session whose only input is the briefing (docs/DESIGN.md §四).
 * The goal sits where a user would; the unit is reachable only through the human-use MCP tools.
 */
export class ClaudeBrain implements Brain {
  private readonly running = new Set<string>();
  private readonly queued = new Map<string, Briefing>();

  constructor(private readonly options: { model?: string; tools?: string; timeoutMs?: number; onExit?: (goalId: string, run: ClaudeRun | null, error: unknown, wokeAt: string) => void } = {}) {}

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
      const config = join(home(), "brain-mcp.json");
      writeFileSync(config, JSON.stringify({
        mcpServers: { "human-use": { command: process.execPath, args: [...process.execArgv, script, "mcp"], env: { HUMAN_USE_HOME: home(), HUMAN_USE_PORT: String(port()), HUMAN_USE_SEAT: "pass" } } }
      }));
      const builtins = this.options.tools ?? "WebSearch,WebFetch";
      const args = ["-p", "--mcp-config", config, "--strict-mcp-config",
        "--tools", builtins, "--allowedTools", ["mcp__human-use", ...builtins.split(",").filter(Boolean)].join(","),
        "--output-format", "stream-json", "--verbose"];
      if (this.options.model) args.push("--model", this.options.model);
      const run = await withBrainPrompt(prompt => runClaude({
        args: [...args, "--system-prompt-file", prompt],
        stdin: `WAKE goal=${goalId} why=${JSON.stringify(briefing.why)}\n\n${JSON.stringify(briefing, null, 1)}`,
        cwd: sandboxDir(),
        timeoutMs: this.options.timeoutMs ?? 15 * 60_000,
        logFile: join(logsDir(), `brain-${goalId}-${briefing.now.replace(/[:.]/g, "-")}.jsonl`),
        env: { MCP_TOOL_TIMEOUT: "600000" }
      }));
      this.options.onExit?.(goalId, run, null, briefing.now);
    } catch (error) {
      this.options.onExit?.(goalId, null, error, briefing.now);
    }
  }
}
