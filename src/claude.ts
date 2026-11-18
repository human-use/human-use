import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

/**
 * One headless `claude -p` run. Shared by the driver driver (no tools, one event in, JSON out) and the brain
 * waker (MCP tools, a briefing in). Input goes over stdin so nothing large or untrusted ends up on a command line.
 */
export interface ClaudeRun {
  text: string;
  cost_usd: number | null;
  duration_ms: number;
  turns: number | null;
  ok: boolean;
}

export function runClaude(options: { args: string[]; stdin: string; cwd: string; timeoutMs: number; logFile?: string; env?: Record<string, string> }): Promise<ClaudeRun> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
    delete env.CLAUDECODE;                         // the daemon may itself have been started from inside an agent session
    delete env.CLAUDE_CODE_ENTRYPOINT;
    const started = Date.now();
    const child = spawn(process.env.HUMAN_USE_CLAUDE_BIN ?? "claude", options.args, { cwd: options.cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const log = options.logFile ? createWriteStream(options.logFile, { flags: "a" }) : null;
    let buffer = "";
    let stderr = "";
    let result: ClaudeRun | null = null;
    const timer = setTimeout(() => child.kill(), options.timeoutMs);

    const line = (raw: string) => {
      if (!raw.trim()) return;
      log?.write(`${raw}\n`);
      try {
        const event = JSON.parse(raw) as { type?: string; result?: string; total_cost_usd?: number; num_turns?: number; is_error?: boolean };
        if (event.type === "result") {
          result = { text: event.result ?? "", cost_usd: event.total_cost_usd ?? null, duration_ms: Date.now() - started, turns: event.num_turns ?? null, ok: !event.is_error };
        }
      } catch { /* not JSON: ignore */ }
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) { line(buffer.slice(0, index)); buffer = buffer.slice(index + 1); }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", error => { clearTimeout(timer); log?.end(); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      line(buffer);
      log?.end();
      if (result) resolve(result);
      else reject(new Error(`claude exited ${code} without a result: ${stderr.slice(0, 400)}`));
    });
    child.stdin.end(options.stdin);
  });
}
