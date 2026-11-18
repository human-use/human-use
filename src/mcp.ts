import { spawn } from "node:child_process";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { runProcess } from "./exec.js";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { ZodObject } from "zod/v4";
import { CATALOG } from "./catalog.js";
import { callerInstructions, port } from "./paths.js";
import { INPUTS } from "./tools.js";
import { VERSION } from "./version.js";

/** MCP uses Draft 2020-12 by default. Keep Zod validation and omit the repeated declaration. */
function mcpInput(schema: ZodObject) {
  const standard = schema["~standard"];
  return {
    "~standard": {
      ...standard,
      jsonSchema: {
        ...standard.jsonSchema,
        input: (options: Parameters<typeof standard.jsonSchema.input>[0]) => {
          const { $schema, ...input } = standard.jsonSchema.input(options);
          return input;
        }
      }
    }
  };
}

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const failure = (message: string) => ({ isError: true as const, content: [{ type: "text" as const, text: message }] });

const base = () => `http://127.0.0.1:${port()}`;

type Health = { name?: string; version?: string; pid?: number };

/**
 * What answers on the runtime port: a Human Use runtime, another program, or nothing.
 * A runtime names itself since 0.1.1; 0.1.0 answered with exactly ok, version and uptime_s.
 */
async function probe(): Promise<{ kind: "none" } | { kind: "other" } | { kind: "ours"; health: Health }> {
  try {
    const res = await fetch(`${base()}/health`, { signal: AbortSignal.timeout(1000) });
    const body = await res.json().catch(() => null) as Record<string, unknown> | null;
    const ours = res.ok && body !== null && (body.name === "human-use"
      || (body.ok === true && typeof body.version === "string" && typeof body.uptime_s === "number"));
    return ours ? { kind: "ours", health: body as Health } : { kind: "other" };
  } catch (error) {
    // Only a refused connection means the port is free; a timeout or a reset means something else holds it.
    const code = (error as { cause?: { code?: string } }).cause?.code;
    return code === "ECONNREFUSED" ? { kind: "none" } : { kind: "other" };
  }
}
const healthy = async () => (await probe()).kind === "ours";

const occupied = (pid: number | null) =>
  `Port ${port()} is held by another program${pid ? ` (pid ${pid})` : ""}. Human Use left it running. Free the port, or set HUMAN_USE_PORT in the agent software's entry for human-use.`;

/** a < b for x.y.z versions; a missing version is older than any. */
export function older(a: string | undefined, b: string): boolean {
  if (!a) return true;
  const pa = a.split(/[.-]/).map(Number), pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  return false;
}

/** The pid listening on the runtime port, for a runtime too old to say it (0.1.0) or to stop on request. */
async function listener(): Promise<number | null> {
  const p = port();
  try {
    if (process.platform === "win32") {
      const { stdout } = await runProcess({ command: "netstat", args: ["-ano", "-p", "tcp"], stdin: "", cwd: tmpdir(), timeoutMs: 10_000 });
      const row = stdout.split(/\r?\n/).map(line => line.trim().split(/\s+/))
        .find(cols => cols[1]?.endsWith(`:${p}`) && cols[3] === "LISTENING");
      return row ? Number(row[4]) || null : null;
    }
    const { stdout } = await runProcess({ command: "lsof", args: ["-nP", `-iTCP@127.0.0.1:${p}`, "-sTCP:LISTEN", "-t"], stdin: "", cwd: tmpdir(), timeoutMs: 10_000 });
    const pid = Number(stdout.trim().split(/\s+/)[0]) || null;
    if (pid || process.platform !== "linux") return pid;
  } catch {
    if (process.platform !== "linux") return null;
  }
  return procListener(p);
}

/** Linux without lsof: the listening socket's inode from /proc/net/tcp, then the process that holds it. */
function procListener(p: number): number | null {
  const hex = p.toString(16).toUpperCase().padStart(4, "0");
  let inode: string | undefined;
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try {
      inode ??= readFileSync(file, "utf8").split("\n").map(line => line.trim().split(/\s+/))
        .find(cols => cols[1]?.endsWith(`:${hex}`) && cols[3] === "0A")?.[9];
    } catch { /* not readable here */ }
  }
  if (!inode) return null;
  for (const pid of readdirSync("/proc").filter(name => /^\d+$/.test(name))) {
    try {
      if (readdirSync(`/proc/${pid}/fd`).some(fd => {
        try { return readlinkSync(`/proc/${pid}/fd/${fd}`) === `socket:[${inode}]`; } catch { return false; }
      })) return Number(pid);
    } catch { /* another user's process */ }
  }
  return null;
}

/** The command line of a process, or null when it cannot be read. */
async function commandLine(pid: number): Promise<string | null> {
  if (process.platform === "linux") {
    try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ") || null; } catch { /* fall back to ps */ }
  }
  try {
    const { stdout } = process.platform === "win32"
      ? await runProcess({ command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`], stdin: "", cwd: tmpdir(), timeoutMs: 15_000 })
      : await runProcess({ command: "ps", args: ["-o", "command=", "-p", String(pid)], stdin: "", cwd: tmpdir(), timeoutMs: 10_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** A process is ended by pid only when its command line is a Human Use runtime: `… human-use … serve`. */
export const isRuntimeCommand = (line: string | null) => !!line && /human-use/i.test(line) && /\sserve(\s|$)/.test(line);

/** Stop the resident runtime: ask it, and end a runtime that has no stop route by its pid. Another program on the port is left alone. */
export async function stopDaemon(): Promise<string> {
  const found = await probe();
  if (found.kind === "none") return "The runtime is not running.";
  if (found.kind === "other") return occupied(await listener());
  const running = found.health;
  // 0.1.1 and later report their pid and take a stop request; 0.1.0 has neither.
  const asked = running.pid !== undefined
    && await fetch(`${base()}/stop`, { method: "POST", signal: AbortSignal.timeout(2000) }).then(res => res.ok, () => false);
  if (!asked) {
    const pid = running.pid ?? await listener();
    if (!pid || pid === process.pid) return `Could not stop the runtime on ${base()}: end its node process.`;
    if (!isRuntimeCommand(await commandLine(pid))) return occupied(pid);
    try { process.kill(pid); } catch { return `Could not stop the runtime (pid ${pid}) on ${base()}: end its node process.`; }
  }
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!await healthy()) return `Stopped the runtime ${running.version ?? ""}`.trim() + ".";
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return `The runtime on ${base()} is still answering.`;
}

let starting: Promise<void> | null = null;

/**
 * Start `human-use serve` detached if nothing answers on the port. It outlives this MCP process on purpose.
 * A runtime older than this package is stopped first, so an upgrade takes effect without a restart.
 */
export function ensureDaemon(script = process.argv[1]): Promise<void> {
  return starting ??= (async () => {
    const found = await probe();
    if (found.kind === "other") throw new Error(occupied(await listener()));
    if (found.kind === "ours" && !older(found.health.version, VERSION)) return;
    if (found.kind === "ours") {
      const stopped = await stopDaemon();
      if (await healthy()) throw new Error(stopped);
    }
    if (!script) throw new Error("cannot locate the human-use entry point to start the daemon");
    const child = spawn(process.execPath, [...process.execArgv, script, "serve"], { detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
    for (let attempt = 0; attempt < 50; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      if (await healthy()) return;
    }
    throw new Error(`human-use daemon did not come up on ${base()}`);
  })().finally(() => { starting = null; });
}

async function remote(tool: string, args: unknown): Promise<unknown> {
  await ensureDaemon();
  const res = await fetch(`${base()}/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool, args, seat: process.env.HUMAN_USE_SEAT === "pass" ? "pass" : "window" }) });
  const payload = await res.json() as { error?: string; message?: string };
  if (!res.ok) throw new Error(payload.message ?? payload.error ?? `HTTP ${res.status}`);
  return payload;
}

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "human-use", version: VERSION }, { instructions: callerInstructions() });
  for (const entry of CATALOG) {
    const inputSchema = INPUTS[entry.name];
    if (!inputSchema) continue;
    server.registerTool(entry.name, { description: `[${entry.category}] ${entry.summary}`, inputSchema: mcpInput(inputSchema) }, async (args: Record<string, unknown>) => {
      try {
        return text(await remote(entry.name, args));
      } catch (error) {
        return failure(error instanceof Error ? error.message : String(error));
      }
    });
  }
  return server;
}

export function serveMcp(): void {
  void serveStdio(createMcpServer);
  console.error(`human-use MCP ${VERSION} ready`);
}
