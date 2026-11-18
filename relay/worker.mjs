import { DurableObject } from "cloudflare:workers";
import { CHANNEL_PATTERN, MAX_FRAME_BYTES, RELAY_PROTOCOL, SECRET_PATTERN, tokenHash } from "../assets/relay-wire.mjs";

const endpoint = /^\/channel\/([^/]+)\/(register|retire|phone|runtime)$/;
/** Close code the phone page reads as "this link was replaced". */
const RETIRED = 4003;
/** A trial link from the try-it panel lasts this long, then the channel forgets it. */
const TRIAL_MS = 60 * 60 * 1000;
const reply = (status, text) => new Response(text, { status, headers: { "Cache-Control": "no-store" } });
const otherRole = role => role === "runtime" ? "phone" : "runtime";
// The try-it panel on humanuse.dev registers and retires its own trial link from that page. Nothing here rides on
// cookies, and a client outside a browser never asks about CORS, so any origin may make these two calls.
const CORS = { "Access-Control-Allow-Origin": "*" };
const PREFLIGHT = { ...CORS, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Authorization, X-Human-Use-Phone, X-Human-Use-Trial", "Access-Control-Max-Age": "86400", "Cache-Control": "no-store" };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = endpoint.exec(url.pathname);
    if (match && CHANNEL_PATTERN.test(match[1])) {
      const open = match[2] === "register" || match[2] === "retire";
      if (open && request.method === "OPTIONS") return new Response(null, { status: 204, headers: PREFLIGHT });
      const response = await env.CHANNELS.getByName(match[1]).fetch(request);
      if (!open) return response;
      const headers = new Headers(response.headers);
      for (const [name, value] of Object.entries(CORS)) headers.set(name, value);
      return new Response(response.body, { status: response.status, headers });
    }
    if (request.method !== "GET" && request.method !== "HEAD") return reply(404, "Not found");
    // Every deploy has its own asset URLs (?v=<deploy id>). A phone that keeps an old copy of one module can then
    // never pair it with a new copy of another: one page loads one deploy, and that deploy's files can be cached.
    const version = env.VERSION?.id ?? "";
    if (url.pathname === "/" || url.pathname === "/unit.html") {
      url.pathname = "/unit.html";
      const asset = await env.ASSETS.fetch(new Request(url, request));
      const html = await asset.text();
      const headers = new Headers(asset.headers);
      headers.set("Cache-Control", "no-store");
      headers.set("Content-Type", "text/html; charset=utf-8");   // not whatever type the asset was uploaded with
      headers.set("Referrer-Policy", "no-referrer");
      headers.set("Content-Security-Policy", await pagePolicy(html, url));
      headers.set("X-Content-Type-Options", "nosniff");
      return new HTMLRewriter()
        .on("html", { element(element) { element.setAttribute("data-relay", version); } })
        .on('link[rel="stylesheet"]', { element(element) { if (version) element.setAttribute("href", `${element.getAttribute("href")}?v=${version}`); } })
        .transform(new Response(html, { status: asset.status, headers }));
    }
    if (url.pathname === "/relay-client.mjs" && version) {
      const asset = await env.ASSETS.fetch(new Request(url, { method: "GET" }));   // no conditional headers: the body is rewritten
      if (!asset.ok) return asset;
      const code = (await asset.text()).replaceAll('from "./relay-wire.mjs"', `from "./relay-wire.mjs?v=${version}"`);
      const headers = new Headers(asset.headers);
      headers.delete("ETag");
      return new Response(request.method === "HEAD" ? null : code, { status: 200, headers: cached(headers, url, version) });
    }
    const asset = await env.ASSETS.fetch(request);
    return version && url.searchParams.has("v") ? new Response(asset.body, { status: asset.status, headers: cached(new Headers(asset.headers), url, version) }) : asset;
  }
};

/** A URL that names this deploy never changes: cache it for good. One that names another deploy gets this deploy's file, so keep it out of caches. */
function cached(headers, url, version) {
  headers.set("Cache-Control", url.searchParams.get("v") === version ? "public, max-age=31536000, immutable" : "no-store");
  return headers;
}

/**
 * The page holds the link secret, so nothing but its own code may run in it: no script or style the page did not ship
 * (a CDN feature once injected an analytics script here), no connection to another host. The page's two inline blocks
 * are allowed by hash, computed from the file being served so a page change cannot fall out of step with the policy.
 * Line breaks are hashed as the browser parses them (CRLF becomes LF), so a page saved on Windows still runs.
 */
async function pagePolicy(html, url) {
  const hashes = tag => Promise.all([...html.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map(async match =>
    `'sha256-${btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(match[1].replace(/\r\n?/g, "\n"))))))}'`));
  return [
    "default-src 'none'",
    `script-src 'self' ${(await hashes("script")).join(" ")}`,
    `style-src 'self' ${(await hashes("style")).join(" ")}`,
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    `connect-src 'self' ${url.protocol === "https:" ? "wss" : "ws"}://${url.host}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ].join("; ");
}

/**
 * Persists only the two authorization hashes, or a tombstone once the runtime retires the link.
 * Forwarding never opens or retains an application message.
 */
export class Channel extends DurableObject {
  async fetch(request) {
    const role = endpoint.exec(new URL(request.url).pathname)?.[2];
    if (role === "register" && request.method === "POST") {
      const token = request.headers.get("Authorization")?.match(/^Bearer (.+)$/)?.[1];
      const phone = request.headers.get("X-Human-Use-Phone");
      if (!SECRET_PATTERN.test(token ?? "") || !SECRET_PATTERN.test(phone ?? "")) return reply(401, "Unauthorized");
      const runtime = await tokenHash(token);
      const trial = request.headers.get("X-Human-Use-Trial") === "1";
      const matched = await this.ctx.storage.transaction(async state => {
        const previous = await state.get("auth");
        if (previous?.retired) return "retired";
        if (previous) return previous.runtime === runtime && previous.phone === phone;
        await state.put("auth", { runtime, phone });
        if (trial) await state.setAlarm(Date.now() + TRIAL_MS);
        return true;
      });
      return matched === "retired" ? reply(410, "Retired") : matched ? reply(204, null) : reply(401, "Unauthorized");
    }
    if (role === "retire" && request.method === "POST") {
      // The runtime replaced its link. Keep a tombstone so the old link can never be registered again.
      const token = request.headers.get("Authorization")?.match(/^Bearer (.+)$/)?.[1];
      if (!SECRET_PATTERN.test(token ?? "")) return reply(401, "Unauthorized");
      const runtime = await tokenHash(token);
      const retired = await this.ctx.storage.transaction(async state => {
        const auth = await state.get("auth");
        if (auth?.retired) return true;
        if (!auth || auth.runtime !== runtime) return false;
        await state.put("auth", { retired: true });
        return true;
      });
      if (!retired) return reply(401, "Unauthorized");
      for (const socket of this.ctx.getWebSockets()) socket.close(RETIRED, "link retired");
      return reply(204, null);
    }
    if (!["phone", "runtime"].includes(role) || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return reply(404, "Not found");
    }
    const offered = request.headers.get("Sec-WebSocket-Protocol")?.split(",").map(value => value.trim()) ?? [];
    const token = offered.find(value => value.startsWith("auth."))?.slice(5);
    if (!offered.includes(RELAY_PROTOCOL) || !SECRET_PATTERN.test(token ?? "")) return reply(401, "Unauthorized");
    const auth = await this.ctx.storage.get("auth");
    if (auth?.retired && role === "phone") {
      // A browser cannot read an HTTP status from a failed WebSocket, so say it with a close code.
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      server.close(RETIRED, "link retired");
      return new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": RELAY_PROTOCOL } });
    }
    if (!auth || auth.retired || auth[role] !== await tokenHash(token)) return reply(401, "Unauthorized");
    if (role === "phone" && !this.ctx.getWebSockets("runtime").some(socket => socket.readyState === 1)) {
      return reply(503, "Runtime offline");
    }
    const [client, server] = Object.values(new WebSocketPair());
    const prior = this.ctx.getWebSockets(role);
    this.ctx.acceptWebSocket(server, [role]);
    for (const old of prior) old.close(4001, "replaced");
    return new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": RELAY_PROTOCOL } });
  }

  /** Only trial channels set an alarm: close their sockets and keep nothing, not even a tombstone. */
  async alarm() {
    for (const socket of this.ctx.getWebSockets()) socket.close(RETIRED, "trial over");
    await this.ctx.storage.deleteAll();
  }

  webSocketMessage(socket, frame) {
    if (!(frame instanceof ArrayBuffer) || !frame.byteLength || frame.byteLength > MAX_FRAME_BYTES) {
      socket.close(4002, "invalid frame");
      return;
    }
    const [role] = this.ctx.getTags(socket);
    // Ignore anything queued from a socket that has since been replaced.
    if (socket.readyState !== 1 || this.ctx.getWebSockets(role).some(peer => peer !== socket && peer.readyState === 1)) return;
    for (const peer of this.ctx.getWebSockets(otherRole(role))) {
      if (peer.readyState === 1) peer.send(frame);
    }
  }

  webSocketClose(socket, code, reason) {
    // Ack the close handshake and reconnect the phone when its runtime is gone.
    socket.close(code === 1005 || code === 1006 || code === 1015 ? 1000 : code, reason);
    if (!this.ctx.getTags(socket).includes("runtime")) return;
    if (this.ctx.getWebSockets("runtime").some(peer => peer !== socket && peer.readyState === 1)) return;
    for (const phone of this.ctx.getWebSockets("phone")) phone.close(4000, "runtime offline");
  }

  webSocketError(socket) {
    this.webSocketClose(socket, 1011, "socket error");
  }
}
