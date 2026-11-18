import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { MAX_PHONE_BODY, type PhoneChannel } from "./phone.js";

/**
 * The first phone channel: one page served on the local network (docs/DESIGN.md §七). Each unit's phone pairs once
 * with that unit's six-digit code and then long-polls for its open card; the cookie it gets back says which unit it is.
 * Plain http on a LAN address is not a secure context, so there is no push and no GPS here; photos go through the
 * system camera via a file input.
 */
export interface WebChannelOptions {
  port: number;
}

interface WebUnit {
  phone: PhoneChannel;
  /** Persisted device token: the cookie value of a paired phone. */
  tokenFile: string;
  token: string;
  code: string;
}

const PAGE = fileURLToPath(new URL("../../assets/unit.html", import.meta.url));

const PAIR_TRIES = 5, PAIR_WINDOW_MS = 60_000;
const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

function newToken(file: string): string {
  const token = randomBytes(24).toString("hex");
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export class WebChannel {
  server: Server | null = null;
  private readonly units = new Map<string, WebUnit>();
  /** When the recent wrong pairing codes came in. */
  private failures: number[] = [];
  constructor(private readonly options: WebChannelOptions) {}

  /** Serve this unit's phone. Its token survives restarts, so a paired phone stays paired. */
  attach(unit: string, phone: PhoneChannel, tokenFile: string): void {
    const token = existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : newToken(tokenFile);
    this.units.set(unit, { phone, tokenFile, token, code: newCode() });
  }

  /** Unpair this unit's phone: its cookie stops matching, and it needs the new code. Other units keep theirs. */
  renew(unit: string): void {
    const entry = this.units.get(unit);
    if (!entry) return;
    entry.token = newToken(entry.tokenFile);
    entry.code = newCode();
  }

  // ------------------------------------------------------------ pairing

  /** What `human-use pair` prints: where to point the phone and this unit's current code. */
  pairing(unit: string): { urls: string[]; code: string } | null {
    const entry = this.units.get(unit);
    if (!entry) return null;
    const address = this.server?.address();
    const port = address && typeof address === "object" ? address.port : this.options.port;
    const urls = Object.values(networkInterfaces()).flat()
      .filter(net => net && net.family === "IPv4" && !net.internal)
      .map(net => `http://${net!.address}:${port}`);
    return { urls, code: entry.code };
  }

  /** The unit whose token the phone's cookie carries. */
  private paired(req: IncomingMessage): WebUnit | null {
    const cookies = (req.headers.cookie ?? "").split(/;\s*/).filter(part => part.startsWith("hu=")).map(part => part.slice(3));
    for (const entry of this.units.values()) if (cookies.some(value => same(value, entry.token))) return entry;
    return null;
  }

  // ------------------------------------------------------------ http

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      this.route(req, res).catch(error => this.send(res, 500, { error: "HRT-5000", message: error instanceof Error ? error.message : String(error) }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port, "0.0.0.0", () => resolve());
    });
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    this.server = null;
  }

  private send(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
    if (res.headersSent) return;
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
    res.end(JSON.stringify(value));
  }

  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_PHONE_BODY) throw new Error("body too large");
      chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    return text ? JSON.parse(text) as Record<string, unknown> : {};
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://unit");
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(readFileSync(PAGE));
      return;
    }
    if (req.method === "GET" && url.pathname === "/ui.css") {
      res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-cache" });
      res.end(readFileSync(new URL("../../assets/ui.css", import.meta.url)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/pair") {
      // Anyone on the network can try codes, so wrong ones are limited in time: five a minute for the whole page.
      // That puts a six-digit code months away. The fifth also changes every unit's code.
      const now = Date.now();
      this.failures = this.failures.filter(at => at > now - PAIR_WINDOW_MS);
      if (this.failures.length >= PAIR_TRIES) {
        this.send(res, 429, { error: "TOO_MANY_TRIES" }, { "retry-after": String(Math.ceil((this.failures[0]! + PAIR_WINDOW_MS - now) / 1000)) });
        return;
      }
      const { code } = await this.body(req);
      const entry = typeof code === "string" ? [...this.units.values()].find(unit => unit.code === code) : undefined;
      if (entry) {
        entry.code = newCode();
        this.send(res, 200, { ok: true }, { "set-cookie": `hu=${entry.token}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax` });
      } else {
        this.failures.push(now);
        if (this.failures.length >= PAIR_TRIES) for (const unit of this.units.values()) unit.code = newCode();
        this.send(res, 403, { error: "REJECTED" });
      }
      return;
    }
    if (!url.pathname.startsWith("/api/")) { this.send(res, 404, { error: "not_found" }); return; }
    const unit = this.paired(req);
    if (!unit) { this.send(res, 401, { error: "UNPAIRED" }); return; }
    const { phone } = unit;

    if (req.method === "GET" && url.pathname === "/api/state") {
      const disconnected = new AbortController();
      res.once("close", () => disconnected.abort());
      const state = await phone.state(Number(url.searchParams.get("v")), disconnected.signal);
      if (!disconnected.signal.aborted) this.send(res, 200, state);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/unpair") {
      this.send(res, 200, phone.unpair(), { "set-cookie": "hu=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax" });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/route") {
      const result = phone.route(await this.body(req) as Record<string, unknown>);
      this.send(res, "ok" in result ? 200 : 409, result);
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/answer") {
      const result = phone.submit(await this.body(req));
      this.send(res, "ok" in result ? 200 : 409, result);
      return;
    }
    this.send(res, 404, { error: "not_found" });
  }
}
