#!/usr/bin/env node
import { dbPath, port } from "./paths.js";
import { parseArgs } from "node:util";
import { VERSION } from "./version.js";

// node:sqlite is stable enough for us but still prints an ExperimentalWarning on Node 22; keep stderr clean.
process.removeAllListeners("warning");
process.on("warning", warning => {
  if (warning.name === "ExperimentalWarning" && /SQLite/.test(warning.message)) return;
  console.error(`${warning.name}: ${warning.message}`);
});

const HELP = `human-use ${VERSION}

  human-use install [--host <codex|claude|manual>] [--driver <backend>] [--brain <codex|claude|none>] [--relay <origin|none>]
                    [--project] [--no-open]
                         configure the agent software and show the phone pairing; --relay none keeps the phone on Wi-Fi
  human-use open <codex|claude> [session args...]      launch a host with human-use for this invocation
  human-use serve        run the resident runtime (state, clock, phone page)
  human-use stop         stop the resident runtime; the next tool call starts it again
  human-use mcp          run the MCP server on stdio (what agent software launches)
  human-use pair [--unit <name>] [--new]
                         print a unit's phone link and/or LAN code; a new name adds that unit; --new retires that
                         unit's old link (other units keep theirs)
  human-use goal add <text> [--done-when <text>] [--deadline <date>] [--budget <amount> --currency <ISO>]
  human-use goal cancel <id> [--reason <text>]
  human-use goal status [id]
  human-use config [<key> [<value>]]
                         show or change a setting: driver, brain (background passes: codex, claude or none), lang, relay
  human-use wait <job>   block until a job settles, then print it
  human-use version      print the version

Install registers human-use with every agent software it finds, for your user account. --project limits it to the
current folder. Repeat --host to choose. It also adds the human-use-handoff skill: invoke it at the start of a session
to hand the request over as a goal and keep the chat to one line. Install then opens the lead page, where the lead adds
each unit by name and gets that unit's pairing QR code.

Environment:
  HUMAN_USE_HOME        state directory (default ~/.human-use)
  HUMAN_USE_PORT        runtime port on 127.0.0.1 (default 7337)
  HUMAN_USE_WEB_PORT    phone page port on the local network (default 7338); HUMAN_USE_WEB=0 turns it off
  HUMAN_USE_RELAY       HTTPS relay origin (or none for LAN only)
  HUMAN_USE_DRIVER      claude[:model] | codex[:model[:effort]] | ollama:<model> | openai:<model>@<base-url> | none
                        (default claude:haiku)
  HUMAN_USE_BRAIN       what starts the brain when no agent window is open: claude[:model] | codex[:model[:effort]] | none
                        (install sets the agent software it registers; otherwise none)
                        both can also be set in <home>/config.json as driver, brain, lang
  HUMAN_USE_LANG        language the unit reads (default: system locale)`;

const [command, ...rest] = process.argv.slice(2);
const base = () => `http://127.0.0.1:${port()}`;

switch (command) {
  case "serve": {
    const { startDaemon } = await import("./daemon.js");
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      void daemon.stop().then(() => process.exit(0), () => process.exit(1));
    };
    const daemon = await startDaemon({ onStopRequest: shutdown });
    console.error(`human-use ${VERSION} serving on 127.0.0.1:${port()} · db ${dbPath()}`);
    console.error(`lead page: ${base()}/`);
    const units = daemon.runtime.units();
    if (!units.length) console.error("no unit yet · add one on the lead page or with human-use pair --unit <name>");
    for (const unit of units) {
      const lan = daemon.web?.pairing(unit.id);
      if (lan) console.error(`${unit.name} phone page: ${lan.urls.join("  ") || "(no LAN address found)"} · pairing code ${lan.code}`);
    }
    if (daemon.units.remote) console.error("remote phone channel enabled · run human-use pair --unit <name> for a unit's link");
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    break;
  }
  case "mcp": {
    const { serveMcp } = await import("./mcp.js");
    serveMcp();
    break;
  }
  case "open": {
    const { openHost } = await import("./install.js");
    try {
      process.exitCode = await openHost(rest[0], rest.slice(1));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    break;
  }
  case "install":
  case "pair": {
    let registered = true;
    let open = false;
    let entry: string | undefined;
    let unitName: string | undefined;
    let renew = false;
    if (command === "install") {
      const { install } = await import("./install.js");
      try {
        ({ registered, open, entry } = await install(rest));
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
        break;
      }
    } else {
      try {
        const { values } = parseArgs({ args: rest, options: { unit: { type: "string" }, new: { type: "boolean" } } });
        unitName = values.unit;
        renew = values.new === true;
      } catch {
        console.error("usage: human-use pair [--unit <name>] [--new]");
        process.exitCode = 1;
        break;
      }
    }
    const { ensureDaemon } = await import("./mcp.js");
    await ensureDaemon(entry);
    type Pairing = { unit?: string; urls?: string[]; code?: string; relay_url?: string | null; relay_connected?: boolean; error?: string; message?: string };
    const post = (path: string, value: unknown) => fetch(`${base()}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
    const readPairing = async () => {
      const response = await fetch(`${base()}/pair${unitName ? `?unit=${encodeURIComponent(unitName)}` : ""}`);
      return { status: response.status, info: await response.json() as Pairing };
    };
    let { status, info } = await readPairing();
    if (status === 400 && unitName && info.error === "HRT-4004") {
      // A name the runtime does not know yet: that unit is added, with its own link.
      const added = await post("/owner/units", { name: unitName });
      const result = await added.json() as Pairing;
      if (!added.ok) { console.error(result.message ?? `HTTP ${added.status}`); process.exitCode = 1; break; }
      console.log(`Added unit ${result.unit}.`);
      ({ status, info } = await readPairing());
    } else if (status === 200 && renew) {
      const renewed = await post("/pair/new", { unit: info.unit });
      if (!renewed.ok) {
        console.error(`could not replace the phone link: HTTP ${renewed.status}`);
        process.exitCode = 1;
        break;
      }
      console.log(`The old links for ${info.unit} no longer work. Open the new one on its phone. Other units keep theirs.`);
      ({ status, info } = await readPairing());
    }
    for (let attempt = 0; status === 200 && info.relay_connected === false && !info.relay_url && attempt < 12; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      ({ status, info } = await readPairing());
    }
    if (status === 200) {
      console.log(`Unit ${info.unit}`);
      if (info.relay_url) {
        console.log(`Open on the phone (any network):\n  ${info.relay_url}`);
        if (process.stdout.isTTY) {
          const { default: QRCode } = await import("qrcode");
          console.log(await QRCode.toString(info.relay_url, { type: "terminal", small: true }));
        }
      }
      if (info.relay_connected === false) console.error("Relay is reconnecting. The page will reconnect when the runtime is online.");
      if (info.code) console.log(`Open on the phone (same Wi-Fi):\n${info.urls?.map(url => `  ${url}`).join("\n")}\nPairing code: ${info.code}`);
      if (!info.relay_url && !info.code) {
        console.error("no phone page available for this unit");
        process.exitCode = 1;
      }
    } else if (info.error === "no_phone_channel") {
      console.error("no phone page available: the LAN page and the relay are both off");
      process.exitCode = 1;
    } else {
      // No unit yet, or several and none named.
      console.error(info.message ?? `HTTP ${status}`);
      console.log(info.error === "HRT-4004" ? "Add a unit on the lead page, or run: human-use pair --unit <name>" : "Name one: human-use pair --unit <name>");
      if (command === "pair") process.exitCode = 1;
    }
    console.log(`Lead page, with each unit's pairing QR code: ${base()}/`);

    if (open) {
      const { openBrowser } = await import("./install.js");
      openBrowser(`${base()}/`);
    }
    if (!registered) process.exitCode = 1;
    break;
  }
  case "wait": {
    const job = rest[0];
    if (!job) { console.error("usage: human-use wait <job>"); process.exitCode = 1; break; }
    const { ensureDaemon } = await import("./mcp.js");
    await ensureDaemon();
    for (;;) {
      const response = await fetch(`${base()}/call`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool: "wait", args: { job, for: "200s" } }) });
      const payload = await response.json() as { result?: { state: string }; message?: string };
      if (!response.ok || !payload.result) { console.error(payload.message ?? `HTTP ${response.status}`); process.exitCode = 1; break; }
      if (["done", "escalated", "expired", "cancelled"].includes(payload.result.state)) { console.log(JSON.stringify(payload, null, 2)); break; }
    }
    break;
  }
  case "goal": {
    try {
      const [action, ...args] = rest;
      const { values, positionals: [target, ...extra] } = parseArgs({
        args, allowPositionals: true,
        options: { "done-when": { type: "string" }, deadline: { type: "string" }, budget: { type: "string" }, currency: { type: "string" }, reason: { type: "string" } }
      });
      const allowed = action === "add" ? ["done-when", "deadline", "budget", "currency"] : action === "cancel" ? ["reason"] : [];
      if (!action || !["add", "cancel", "status"].includes(action) || extra.length ||
          (!target && action !== "status") || Object.keys(values).some(key => !allowed.includes(key))) {
        throw new Error("usage: human-use goal add <text> | cancel <id> | status [id]");
      }
      if ((values.budget === undefined) !== (values.currency === undefined)) throw new Error("--budget and --currency go together");
      const budget = values.budget !== undefined ? { monthly: Number(values.budget), currency: values.currency?.toUpperCase() } : undefined;
      const payload = action === "add" ? { goal: target, done_when: values["done-when"], deadline: values.deadline, budget }
        : action === "cancel" ? { goal: target, reason: values.reason } : undefined;
      const { ensureDaemon } = await import("./mcp.js");
      await ensureDaemon();
      const response = await fetch(`${base()}/owner/goals${action === "cancel" ? "/cancel" : ""}`, payload
        ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) } : {});
      const result = await response.json() as { goals?: { id: string }[]; message?: string };
      if (!response.ok) throw new Error(result.message ?? `HTTP ${response.status}`);
      const selection = action === "status" && target ? result.goals?.find(goal => goal.id === target) : result;
      if (!selection) throw new Error(`No such goal: ${target}`);
      console.log(JSON.stringify(selection, null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    break;
  }
  case "config": {
    try {
      const [key, value, ...extra] = rest;
      const keys = ["driver", "brain", "lang", "relay"];
      if (extra.length || (key !== undefined && !keys.includes(key))) throw new Error(`usage: human-use config [${keys.join("|")} [value]]`);
      const { config, saveRuntimeConfig } = await import("./config.js");
      if (key === undefined || value === undefined) {
        const current = config() as Record<string, unknown>;
        console.log(key === undefined ? JSON.stringify(current, null, 2) : String(current[key] ?? "(unset)"));
        break;
      }
      if (key === "driver" || key === "brain") {
        // The runtime checks the value, saves it, and puts it into effect.
        const { ensureDaemon } = await import("./mcp.js");
        await ensureDaemon();
        const response = await fetch(`${base()}/owner/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ [key]: value }) });
        const result = await response.json() as { message?: string };
        if (!response.ok) throw new Error(result.message ?? `HTTP ${response.status}`);
        console.log(`${key}: ${value}. In effect now.`);
      } else {
        const { relaySetting } = await import("./install.js");
        const { home } = await import("./paths.js");
        await saveRuntimeConfig(home(), { [key]: key === "relay" ? relaySetting(value) : value });
        console.log(`${key}: ${value}. The runtime applies it when it next starts.`);
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    break;
  }
  case "stop": {
    const { stopDaemon } = await import("./mcp.js");
    console.log(await stopDaemon());
    break;
  }
  case "version":
  case "--version":
  case "-v":
    console.log(VERSION);
    break;
  default:
    console.log(HELP);
    if (command && command !== "help" && command !== "--help") process.exitCode = 1;
}
