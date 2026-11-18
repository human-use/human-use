import { spawn } from "node:child_process";
import { cp, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { parse as parseToml } from "smol-toml";
import { config, DEFAULT_RELAY, readOptional, replaceConfig, saveRuntimeConfig } from "./config.js";
import { makeDriver } from "./backends.js";
import { commandOnPath, runProcess } from "./exec.js";
import { home, promptPath } from "./paths.js";
import { VERSION } from "./version.js";

const HOSTS = ["codex", "claude"] as const;
type Host = typeof HOSTS[number];
type HostChoice = Host | "manual";
const HOST_LABELS = { codex: "Codex", claude: "Claude Code", manual: "Other MCP host (manual setup)" };
const CODEX_TOOL_TIMEOUT_SECONDS = 270;  // Leave headroom over the runtime's 240 second default wait cap.

/**
 * `npx human-use install` runs from npm's npx cache, which npm may clear at any time. Registering that path would leave
 * the host pointing at nothing, so copy the package and its dependencies to <home>/app/<version> and register that copy.
 * A global or source install is already at a stable path and is used where it is.
 */
export async function stableEntry(script: string, appDir = join(home(), "app")): Promise<string> {
  const real = await realpath(script);
  const modules = /^(.*[\\/]_npx[\\/][^\\/]+[\\/]node_modules)[\\/]human-use[\\/]/.exec(real)?.[1];
  if (!modules) return real;
  const target = join(appDir, VERSION);
  const entry = join(target, "node_modules", "human-use", relative(join(modules, "human-use"), real));
  if (await lstat(entry).then(() => true, () => false)) return entry;
  const staging = `${target}.${process.pid}.tmp`;
  await rm(staging, { recursive: true, force: true });
  await cp(modules, join(staging, "node_modules"), { recursive: true, dereference: true });
  await rename(staging, target).catch(async (error: NodeJS.ErrnoException) => {
    await rm(staging, { recursive: true, force: true });
    if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY" && error.code !== "EPERM") throw error;
  });
  return entry;
}

function mcpProcess(script = process.argv[1]) {
  if (!script) throw new Error("cannot locate the human-use entry point");
  const env: Record<string, string> = {};
  for (const key of ["HUMAN_USE_HOME", "HUMAN_USE_PORT", "HUMAN_USE_WEB_PORT", "HUMAN_USE_RELAY"]) {
    const value = process.env[key];
    if (value) env[key] = key === "HUMAN_USE_HOME" ? resolve(value) : value;
  }
  return { command: process.execPath, args: [...process.execArgv, script, "mcp"], env };
}

/** Launch the host with process-local configuration and pass through its interactive terminal. */
export async function openHost(name: string | undefined, args: string[]): Promise<number> {
  if (name !== "claude" && name !== "codex") throw new Error("usage: human-use open <codex|claude> [host args...]");
  const host = commandOnPath(name);
  if (!host) throw new Error(`${name} is not on PATH`);
  const mcp = mcpProcess();
  let flags: string[];
  if (name === "codex") {
    const env = Object.entries(mcp.env).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(", ");
    const server = `{ command=${JSON.stringify(mcp.command)}, args=${JSON.stringify(mcp.args)}, env={${env}}, enabled=true, tool_timeout_sec=${CODEX_TOOL_TIMEOUT_SECONDS} }`;
    flags = ["-c", `mcp_servers.human-use=${server}`, ...args];
  } else {
    const config = ["--mcp-config", JSON.stringify({ mcpServers: { "human-use": { type: "stdio", ...mcp } } })];
    const end = args.indexOf("--");
    flags = end < 0 ? [...args, ...config] : [...args.slice(0, end), ...config, ...args.slice(end)];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(host.command, [...host.prefix, ...flags], { stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 1)));
  });
}

/** Preserve the other settings and fail without overwriting an unreadable config. */
export async function writeDriverConfig(dir: string, driver: string): Promise<void> {
  await saveRuntimeConfig(dir, { driver });
}

const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

/** Add one section without reserializing the user's comments or editing an existing server entry. */
export async function registerCodexProject(project: string, mcp: ReturnType<typeof mcpProcess>): Promise<string> {
  const dir = join(await realpath(project), ".codex");
  const profile = resolve(process.env.CODEX_HOME || join(homedir(), ".codex"));
  const physicalProfile = await realpath(profile).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return profile;
    throw error;
  });
  const defaultProfile = join(await realpath(homedir()), ".codex");
  if ([profile, physicalProfile, defaultProfile].some(global => samePath(dir, global))) {
    throw new Error("run install from the project folder to use project scope");
  }
  await mkdir(dir, { recursive: true });
  if ((await lstat(dir)).isSymbolicLink()) throw new Error(`${dir} is a symlink; configure the server manually`);
  return appendCodexServer(join(dir, "config.toml"), mcp, "Open the trusted project and check /mcp.");
}

/** User scope. `codex mcp add` cannot set tool_timeout_sec, and the default is shorter than one wait. */
export async function registerCodexUser(mcp: ReturnType<typeof mcpProcess>): Promise<string> {
  const dir = resolve(process.env.CODEX_HOME || join(homedir(), ".codex"));
  await mkdir(dir, { recursive: true });
  return appendCodexServer(join(dir, "config.toml"), mcp, "Start a new Codex session and check /mcp.");
}

async function appendCodexServer(path: string, mcp: ReturnType<typeof mcpProcess>, next: string): Promise<string> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (info && !info.isFile()) throw new Error(`${path} is not a regular file; configure the server manually`);
  const previous = await readOptional(path);
  const existing = previous ?? "";
  const config = parseToml(existing.replace(/^\uFEFF/, ""), { integersAsBigInt: "asNeeded" });
  const servers = config.mcp_servers;
  if (servers && typeof servers === "object" && Object.hasOwn(servers, "human-use")) {
    return `Codex already has a human-use entry in ${path}.`;
  }
  const lines = [
    "[mcp_servers.human-use]",
    `command = ${JSON.stringify(mcp.command)}`,
    `args = ${JSON.stringify(mcp.args)}`,
    `tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SECONDS}`
  ];
  if (Object.keys(mcp.env).length) {
    lines.push("", "[mcp_servers.human-use.env]");
    for (const [key, value] of Object.entries(mcp.env)) lines.push(`${key} = ${JSON.stringify(value)}`);
  }
  const newline = existing.includes("\r\n") ? "\r\n" : "\n";
  const separator = existing ? (existing.endsWith("\n") ? newline : newline + newline) : "";
  const updated = existing + separator + lines.join(newline) + newline;
  parseToml(updated.replace(/^\uFEFF/, ""), { integersAsBigInt: "asNeeded" });
  await replaceConfig(path, previous, updated);
  return `Codex: added human-use to ${path}. ${next}`;
}

async function chooseHosts(requested: string[] | undefined, detected: Host[], project: boolean): Promise<HostChoice[]> {
  if (requested?.length) {
    const selected: HostChoice[] = [];
    for (const host of requested) {
      if (host !== "codex" && host !== "claude" && host !== "manual") throw new Error("--host expects codex, claude, or manual");
      if (!selected.includes(host)) selected.push(host);
    }
    return selected;
  }
  if (!detected.length) return ["manual"];
  // An agent running the installer has no terminal to answer in: enable every host it can find.
  if (!process.stdin.isTTY) return detected;
  const choices: HostChoice[] = [...detected, "manual"];
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("Agent software that gets the human-use tools:");
    choices.forEach((host, index) => console.log(`  ${index + 1}. ${HOST_LABELS[host]}`));
    const answer = (await terminal.question(`Enable for ${project ? "this project" : "your user account"} (numbers such as 1,2; Enter for all found): `)).trim();
    if (!answer) return detected;
    const selected = answer.split(/[,\s]+/).map(number => choices[Number(number) - 1]);
    if (selected.some(host => !host)) throw new Error("choose host numbers from the list");
    return [...new Set(selected.filter(host => host !== undefined))];
  } finally {
    terminal.close();
  }
}

async function chooseBackend(hosts: string[]): Promise<string> {
  // The software being set up comes first, so a Codex install defaults to a Codex driver.
  const models: Record<string, string> = { claude: "claude:haiku", codex: "codex:gpt-6-luna:medium" };
  const choices = [...new Set([
    ...hosts.flatMap(host => models[host] ? [models[host]] : []),
    ...Object.keys(models).filter(name => commandOnPath(name)).map(name => models[name]!),
    ...(commandOnPath("ollama") ? ["ollama:<model>"] : []),
    "none"
  ])];
  if (!process.stdin.isTTY) return choices[0]!;
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("Driver: the model on this machine that writes the cards and reads the replies.");
    choices.forEach((choice, index) => console.log(`  ${index + 1}. ${choice === "none"
      ? "none (buttons and fields only; free-text replies and goals need a driver)" : choice}`));
    const choice = choices[Number((await terminal.question("Driver [1]: ")).trim() || 1) - 1];
    if (!choice) throw new Error("choose a listed backend");
    if (choice !== "ollama:<model>") return choice;
    const model = (await terminal.question("Name of an installed Ollama model: ")).trim();
    if (!model) throw new Error("Ollama requires a model name");
    return `ollama:${model}`;
  } finally {
    terminal.close();
  }
}

export const HANDOFF_SKILL = "human-use-handoff";

/**
 * How a session treats the chat is the lead's pick per session, so it is a skill, not a setting. Without it the agent
 * works in the chat and reports there; invoked, it turns the request into a goal and answers in one line.
 * Only the lead invokes it: Codex reads agents/openai.yaml, Claude Code reads disable-model-invocation.
 */
export async function installHandoffSkill(host: Host, root: string): Promise<string> {
  const body = (await readFile(promptPath("handoff"), "utf8")).replace(/\r\n/g, "\n").trim();
  const description = "Hand a request to the human-use runtime as a goal and keep this chat to one line. Without it, results come back in this chat.";
  const dir = join(root, host === "codex" ? ".agents" : ".claude", "skills", HANDOFF_SKILL);
  const front = ["---", `name: ${HANDOFF_SKILL}`, `description: ${JSON.stringify(description)}`,
    ...(host === "claude" ? ["disable-model-invocation: true"] : []), "---"];
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `${front.join("\n")}\n\n${body}\n`);
  if (host === "codex") {
    await mkdir(join(dir, "agents"), { recursive: true });
    await writeFile(join(dir, "agents", "openai.yaml"), ["interface:", '  display_name: "Hand off (human-use)"',
      '  short_description: "Hand work to the runtime; one line in this chat"', "policy:", "  allow_implicit_invocation: false", ""].join("\n"));
  }
  return host === "codex" ? `Codex: $${HANDOFF_SKILL} hands a request over to the runtime.` : `Claude Code: /${HANDOFF_SKILL} hands a request over to the runtime.`;
}

export async function install(argv: string[]): Promise<{ registered: boolean; open: boolean; entry: string }> {
  const { values } = parseArgs({
    args: argv,
    options: {
      driver: { type: "string" }, overseer: { type: "string" }, brain: { type: "string" }, host: { type: "string", multiple: true },
      relay: { type: "string" }, project: { type: "boolean" }, global: { type: "boolean" }, "no-open": { type: "boolean" }
    }
  });
  const relay = values.relay === undefined ? undefined : relaySetting(values.relay);
  // User scope by default, so the tools are there in every folder. --global is the default and stays accepted.
  const project = values.project === true && values.global !== true;
  const selected = await chooseHosts(values.host, HOSTS.filter(name => commandOnPath(name)), project);
  const dir = resolve(home());
  // Running install again keeps the driver already set; only --driver changes it.
  const savedDriver = config().driver ?? config().overseer;
  const driver = values.driver ?? values.overseer ?? savedDriver ?? await chooseBackend(selected);
  if (typeof driver === "string") {
    // Accept CLI and Ollama backends here. An OpenAI endpoint belongs in config.json or the environment.
    if (!/^(?:none|claude(?::[^:\s]+)?|codex(?::[^:\s]+){0,2}|ollama:[^\s]+)$/.test(driver)) {
      throw new Error("use none, claude[:model], codex[:model[:effort]], or ollama:<model>");
    }
    makeDriver(driver);
    if (driver !== savedDriver) await writeDriverConfig(dir, driver);
  }
  const driverLabel = typeof driver === "string" ? driver : "the driver in config.json";
  if (relay !== undefined) await saveRuntimeConfig(dir, { relay });
  const entry = await stableEntry(process.argv[1] ?? "");
  const mcp = mcpProcess(entry);
  let manual = selected.includes("manual");
  let registered = true;
  const ready: Host[] = [];
  for (const host of selected) {
    if (host === "manual") continue;
    try {
      const message = host === "codex"
        ? await (project ? registerCodexProject(process.cwd(), mcp) : registerCodexUser(mcp))
        : await registerWithHost(host, !project, mcp);
      console.log(message);
      ready.push(host);
      try {
        console.log(await installHandoffSkill(host, project ? await realpath(process.cwd()) : homedir()));
      } catch (error) {
        console.error(`${HOST_LABELS[host]} skill: ${error instanceof Error ? error.message : String(error)}`);
      }
    } catch (error) {
      registered = false;
      manual = true;
      console.error(`${HOST_LABELS[host]}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (manual) {
    console.log("Copy this server into your host's local STDIO MCP settings:");
    console.log(JSON.stringify({ mcpServers: { "human-use": mcp } }, null, 2));
  }
  if (selected.some(host => host !== "manual")) console.log("Start a new agent session so it loads the human-use tools.");
  // The base install is an MCP server called on demand. A background pass starts the lead's agent software unattended
  // and spends its quota, so passes stay off until the lead turns them on.
  const saved = config().brain;
  const brain = values.brain ?? saved ?? "none";
  if (typeof brain === "string") {
    if (!/^(?:none|claude(?::[^:\s]+)?|codex(?::[^:\s]+){0,2})$/.test(brain)) throw new Error("--brain expects none, claude[:model], or codex[:model[:effort]]");
    if (brain !== saved) await saveRuntimeConfig(dir, { brain });
  }
  const brainLabel = typeof brain === "string" ? brain : "the brain in config.json";
  const phone = process.env.HUMAN_USE_RELAY ?? relay ?? config().relay ?? DEFAULT_RELAY;
  console.log(`Driver: ${driverLabel}. Phone: ${phone === "none" ? "same Wi-Fi only" : `any network through ${phone}, or the same Wi-Fi`}.`);
  console.log(brainLabel === "none"
    ? `Background passes: off. A goal moves when an agent window calls; scheduled cards still go out. To have the runtime start your agent software when a goal wakes: human-use config brain ${ready[0] ?? "codex"}`
    : `Background passes: ${brainLabel}. When a goal wakes and no agent window is open, the runtime starts it for one pass.`);
  console.log("Change settings any time with human-use config <key> <value>, or under Settings on the lead page.");
  return { registered, open: values["no-open"] !== true, entry };
}

/** "none" keeps the phone on the local network. Anything else is the origin of a relay, ours or self-hosted. */
export function relaySetting(value: string): string {
  if (value === "none") return value;
  const url = (() => { try { return new URL(value); } catch { return null; } })();
  const local = url?.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (!url || (url.protocol !== "https:" && !local) || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("--relay expects none or an https origin such as https://unit.humanuse.dev");
  }
  return url.origin;
}

/** Best effort: show the lead page, where each unit gets its pairing QR code. Prints the address either way. */
export function openBrowser(url: string): void {
  const [command, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.once("error", () => {});
    child.unref();
  } catch { /* no browser here; the address is printed */ }
}

async function registerWithHost(host: Host, global: boolean, { command, args, env }: ReturnType<typeof mcpProcess>): Promise<string> {
  if (!commandOnPath(host)) throw new Error(`${host} is not on PATH`);
  const settings = Object.entries(env).map(([key, value]) => `${key}=${value}`);
  const cwd = host === "codex" ? homedir() : process.cwd();
  const run = (args: string[]) => runProcess({ command: host, args, stdin: "", cwd, timeoutMs: 30_000 });
  if (host === "codex" && (await run(["mcp", "get", "human-use", "--json"])).code === 0) {
    return "Codex: human-use is already registered.";
  }
  const envFlags = settings.flatMap(value => [host === "codex" ? "--env" : "-e", value]);
  const scope = host === "claude" ? ["--scope", global ? "user" : "local"] : [];
  const result = await run(["mcp", "add", ...scope, "human-use", ...envFlags, "--", command, ...args]);
  if (host === "claude" && /MCP server human-use already exists in (user|local) config/.test(result.stdout + result.stderr)) {
    return "Claude Code: human-use is already registered.";
  }
  if (result.code !== 0) throw new Error(`could not register human-use: ${(result.stderr || result.stdout).trim()}`);
  return `${HOST_LABELS[host]}: registered human-use for ${global ? "your user account" : "this project"}.`;
}
