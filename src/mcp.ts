import { spawn } from "node:child_process";
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

async function healthy(): Promise<boolean> {
  try {
    return (await fetch(`${base()}/health`, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

let starting: Promise<void> | null = null;

/** Start `human-use serve` detached if nothing answers on the port. It outlives this MCP process on purpose. */
export function ensureDaemon(script = process.argv[1]): Promise<void> {
  return starting ??= (async () => {
    if (await healthy()) return;
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
