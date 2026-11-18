import { spawn } from "node:child_process";
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

type Health = { version?: string; pid?: number };

async function health(): Promise<Health | null> {
  try {
    const res = await fetch(`${base()}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok ? await res.json().catch(() => ({})) as Health : null;
  } catch {
    return null;
  }
}
const healthy = async () => (await health()) !== null;

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
        .find(cols => cols[1] === `127.0.0.1:${p}` && cols[3] === "LISTENING");
      return row ? Number(row[4]) || null : null;
    }
    const { stdout } = await runProcess({ command: "lsof", args: ["-nP", `-iTCP@127.0.0.1:${p}`, "-sTCP:LISTEN", "-t"], stdin: "", cwd: tmpdir(), timeoutMs: 10_000 });
    return Number(stdout.trim().split(/\s+/)[0]) || null;
  } catch {
    return null;
  }
}

/** Stop the resident runtime: ask it, and end a runtime that has no stop route by its pid. */
export async function stopDaemon(): Promise<string> {
  const running = await health();
  if (!running) return "The runtime is not running.";
  const asked = await fetch(`${base()}/stop`, { method: "POST", signal: AbortSignal.timeout(2000) }).then(res => res.ok, () => false);
  if (!asked) {
    const pid = running.pid ?? await listener();
    if (!pid || pid === process.pid) return `Could not stop the runtime on ${base()}: end its node process.`;
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
    const running = await health();
    if (running && !older(running.version, VERSION)) return;
    if (running) await stopDaemon();
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
