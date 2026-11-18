import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { SendPush } from "./channels/push.js";
import { TelegramBot } from "./channels/telegram.js";
import { WebChannel } from "./channels/web.js";
import { config, DEFAULT_RELAY } from "./config.js";
import { FileNotebook } from "./notebook.js";
import { makeBrain, makeDriver, readerOf, type BackendSpec } from "./backends.js";
import { localOwner, ownerRequest } from "./owner.js";
import { dbPath, filesDir, home, port, webPort } from "./paths.js";
import { HumanUseError, Runtime, type Brain, type Driver } from "./runtime.js";
import { Store } from "./store.js";
import { callTool } from "./tools.js";
import { migrateLegacyUnit, unitDir, UnitLinks } from "./units.js";
import { VERSION } from "./version.js";

/**
 * The resident process. Owns the database, the clock and the channels; the MCP server is a thin client of it,
 * so goals keep waking up while no agent window is open.
 */
export interface Daemon {
  server: Server;
  store: Store;
  runtime: Runtime;
  web: WebChannel | null;
  /** Each unit's phone link. */
  units: UnitLinks;
  bot: TelegramBot | null;
  stop(): Promise<void>;
}

export interface DaemonOptions {
  port?: number;
  db?: string;
  telegramToken?: string;
  tickMs?: number;
  /** Omit to build from HUMAN_USE_DRIVER (default claude:haiku). null runs without one. */
  driver?: Driver | null;
  /** Omit to build from HUMAN_USE_BRAIN (default none). With none, a wake waits in the goal until agent software next calls. */
  brain?: Brain | null;
  /** Port of the phone page. Omit for HUMAN_USE_WEB_PORT (default 7338). false turns the page off. */
  web?: number | false;
  /** Omit for HUMAN_USE_RELAY and config.json. "none" turns the relay off. */
  relay?: string;
  /** Replaces notification delivery in offline integration tests. */
  pushSend?: SendPush;
  lang?: string;
  /** Called on POST /stop from the lead's own machine: `human-use stop`, or a newer version taking over. Omit to refuse it. */
  onStopRequest?: () => void;
}

const TICK_MS = 5000;

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) as unknown : {};
}

export async function startDaemon(options: DaemonOptions = {}): Promise<Daemon> {
  const store = new Store(options.db ?? dbPath());
  const settings = options.db ? {} : config();
  const started = Date.now();
  let closed = false;

  const driverSpec = process.env.HUMAN_USE_DRIVER ?? process.env.HUMAN_USE_OVERSEER ?? settings.driver ?? settings.overseer ?? "claude:haiku";
  const brainSpec = process.env.HUMAN_USE_BRAIN ?? settings.brain ?? "none";
  const driver = options.driver === undefined ? makeDriver(driverSpec) : options.driver;
  const brainExit = (goalId: string, info: Record<string, unknown>) => {
    if (!closed) store.event(new Date().toISOString(), "brain_exit", goalId, goalId, info);
  };
  // No default: starting agent software unattended spends the lead's quota, so it is switched on explicitly.
  const brain = options.brain === undefined ? makeBrain(brainSpec, brainExit) : options.brain;

  const stateDir = options.db ? join(options.db, "..") : home();
  const runtime = new Runtime({
    store, driver, brain,
    notebook: unit => new FileNotebook(join(unitDir(stateDir, unit), "notebook")),
    lang: options.lang ?? process.env.HUMAN_USE_LANG ?? settings.lang ?? Intl.DateTimeFormat().resolvedOptions().locale,
    reader: (): string => readerOf(lead.driver).reader
  });
  migrateLegacyUnit(runtime, store, stateDir);

  const relayAddress = options.relay ?? process.env.HUMAN_USE_RELAY ?? settings.relay ?? (options.db ? "none" : DEFAULT_RELAY);
  let web: WebChannel | null = null;
  if (options.web !== false && process.env.HUMAN_USE_WEB !== "0") {
    web = new WebChannel({ port: options.web ?? webPort() });
    await web.start();
  }
  const units = new UnitLinks({
    runtime, store, stateDir, web, filesDir: options.db ? stateDir : filesDir(),
    relay: relayAddress && relayAddress !== "none" ? relayAddress : null, pushSend: options.pushSend,
    routing: (): { reader: string; local: boolean } => readerOf(lead.driver)
  });
  for (const unit of runtime.units()) units.attach(unit);
  runtime.channel = units.enabled ? units : null;
  const lead = {
    runtime, units, stateDir, filesDir: options.db ? stateDir : filesDir(),
    /** A unit the lead names, with its own phone link. */
    addUnit(name: string) {
      if (!units.enabled) throw new HumanUseError("HRT-4001", "BAD_ARGS no phone channel: the LAN page and the relay are both off");
      const unit = runtime.addUnit(name);
      units.attach(unit);
      return unit;
    },
    driver: (options.driver === undefined ? driverSpec : options.driver === null ? "none" : "custom") as BackendSpec,
    brain: (options.brain === undefined ? brainSpec : options.brain === null ? "none" : "custom") as BackendSpec,
    /** A saved setting takes effect now: the next card uses the new driver, the next wake the new brain. */
    apply(update: { driver?: string | undefined; brain?: string | undefined }) {
      if (update.driver !== undefined) {
        // The new reader is named before the runtime re-reads held answers, so a photo agreed for the old one waits.
        const driver = makeDriver(update.driver);
        lead.driver = update.driver;
        runtime.driver = driver;
      }
      if (update.brain !== undefined) { runtime.brain = makeBrain(update.brain, brainExit); lead.brain = update.brain; }
    }
  };

  const server = createServer((req, res) => {
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(value));
    };
    if (!localOwner(req)) {
      send(403, { error: "loopback_required" });
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      send(200, { ok: true, name: "human-use", version: VERSION, pid: process.pid, uptime_s: Math.round((Date.now() - started) / 1000) });
      return;
    }
    if (req.method === "POST" && req.url === "/stop" && options.onStopRequest) {
      send(200, { ok: true, pid: process.pid });
      setTimeout(options.onStopRequest, 50);
      return;
    }
    const path = new URL(req.url ?? "/", "http://127.0.0.1");
    if ((req.method === "GET" && path.pathname === "/pair") || (req.method === "POST" && path.pathname === "/pair/new")) {
      if (!units.enabled) { send(404, { error: "no_phone_channel" }); return; }
      const pair = async () => {
        const ref = req.method === "POST" ? (await body(req) as { unit?: string }).unit : path.searchParams.get("unit");
        const unit = runtime.unit(ref);
        return req.method === "POST" ? units.renew(unit.id) : units.pairing(unit.id);
      };
      pair().then(value => send(200, value), error => {
        if (error instanceof HumanUseError) send(400, { error: error.code, message: error.message });
        else send(500, { error: "HRT-5000", message: String(error) });
      });
      return;
    }
    if (req.method === "POST" && req.url === "/call") {
      let callId: string | undefined;
      const finish = (status: number, value: unknown) => {
        if (closed) return;
        if (callId) store.update("calls", callId, { ended_at: Date.now(), outcome: status === 200 ? "returned" : "error", response: JSON.stringify(value) });
        send(status, value);
      };
      body(req).then(payload => {
        const { tool, args, seat } = payload as { tool: string; args: unknown; seat?: unknown };
        if (typeof tool !== "string") throw new HumanUseError("HRT-4001", "tool must be a string");
        const id = randomUUID();
        store.insert("calls", { id, tool, args: JSON.stringify(args ?? {}), started_at: Date.now() });
        callId = id;
        return callTool(runtime, tool, args, job => store.update("calls", id, { job_id: job }), seat === "pass" ? "pass" : "window");
      }).then(result => finish(200, result)).catch(error => {
        if (error instanceof HumanUseError) finish(400, { error: error.code, message: error.message });
        else finish(500, { error: "HRT-5000", message: error instanceof Error ? error.message : String(error) });
      });
      return;
    }
    if (req.url === "/" || req.url === "/ui.css" || req.url?.startsWith("/owner/")) {
      void ownerRequest(req, res, lead).catch(error => {
        if (res.headersSent) { res.destroy(); return; }
        if (error instanceof HumanUseError) send(400, { error: error.code, message: error.message });
        else send(500, { error: "HRT-5000", message: error instanceof Error ? error.message : String(error) });
      });
      return;
    }
    send(404, { error: "not_found" });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? port(), "127.0.0.1", () => resolve());
  });
  store.run("UPDATE calls SET ended_at = ?, outcome = 'interrupted' WHERE ended_at IS NULL", started);

  const token = options.telegramToken ?? process.env.HUMAN_USE_TELEGRAM_TOKEN;
  let bot: TelegramBot | null = null;
  if (token) {
    bot = new TelegramBot({ token });
    await bot.start({
      message: async message => {
        await bot!.send(String(message.chat.id), `human-use ${VERSION}. Not paired yet.`);
      }
    });
  }

  runtime.resume();
  units.start();
  const timer = setInterval(() => {
    try { runtime.tick(); } catch (error) { console.error("[human-use] tick:", error); }
  }, options.tickMs ?? TICK_MS);
  timer.unref();

  store.event(new Date().toISOString(), "daemon_started", null, null, { version: VERSION });
  return {
    server, store, runtime, web, units, bot,
    async stop() {
      clearInterval(timer);
      bot?.stop();
      units.stop();
      await web?.stop();
      await runtime.settle();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      closed = true;
      store.close();
    }
  };
}
