import { spawn } from "node:child_process";
import { accessSync, constants, createWriteStream, existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Find how to start a CLI without a shell. On Windows, npm installs a `.cmd` shim that Node refuses to spawn directly,
 * so the shim is read for the script it points at and that script is run with the current Node.
 */
export function commandOnPath(name: string): { command: string; prefix: string[] } | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    if (process.platform === "win32") {
      const exe = join(dir, `${name}.exe`);
      if (existsSync(exe)) return { command: exe, prefix: [] };
      const shim = join(dir, `${name}.cmd`);
      if (!existsSync(shim)) continue;
      const script = /%dp0%\\([^"\r\n]+?\.(?:js|mjs|cjs))/i.exec(readFileSync(shim, "utf8"));
      if (script) return { command: process.execPath, prefix: [join(dir, script[1]!)] };
    } else {
      const command = join(dir, name);
      try {
        accessSync(command, constants.X_OK);
        if (statSync(command).isFile()) return { command, prefix: [] };
      } catch { /* keep looking on PATH */ }
    }
  }
}

export function resolveCommand(name: string): { command: string; prefix: string[] } {
  const native = /[\\/]/.test(name) || process.platform !== "win32";
  return (native ? undefined : commandOnPath(name)) ?? { command: name, prefix: [] };
}

export interface ProcessRun {
  stdout: string;
  stderr: string;
  code: number | null;
  ms: number;
}

/** Run a command to completion. Input goes over stdin so nothing large or untrusted ends up on a command line. */
export function runProcess(options: { command: string; args: string[]; stdin: string; cwd: string; timeoutMs: number; logFile?: string; env?: Record<string, string> }): Promise<ProcessRun> {
  return new Promise((resolve, reject) => {
    const { command, prefix } = resolveCommand(options.command);
    const started = Date.now();
    const child = spawn(command, [...prefix, ...options.args], { cwd: options.cwd, env: { ...process.env, ...options.env }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const log = options.logFile ? createWriteStream(options.logFile, { flags: "a" }) : null;
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), options.timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; log?.write(chunk); });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", error => { clearTimeout(timer); log?.end(); reject(error); });
    child.once("close", code => { clearTimeout(timer); log?.end(); resolve({ stdout, stderr, code, ms: Date.now() - started }); });
    child.stdin.end(options.stdin);
  });
}
