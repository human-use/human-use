// The report bot at bot.humanuse.dev. Agents POST an error code or a wish, one sentence, after their lead agreed.
// The bot posts it as a comment: one issue per code, one issue per week of wishes. It runs as one Durable Object,
// which holds the GitHub App's key, the issue numbers and the day's counts.
import { DurableObject } from "cloudflare:workers";
import { FORMAT, LIMITS, OWNER, REPO, appJwt, comment, issueFor, manifest, parseReport, sha256hex } from "./lib.mjs";

const GITHUB = "https://api.github.com";
const json = (status, body) => new Response(JSON.stringify(body, null, 2), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const page = (title, inner) => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;background:#F3F2EE;color:#121311;font:15px/1.5 ui-sans-serif,system-ui,sans-serif}main{max-width:560px;margin:56px auto;padding:0 20px}
h1{font-size:22px;margin:0 0 8px;border-top:1px solid #121311;padding-top:14px}p{margin:0 0 14px;color:#62645E}code{font:13px ui-monospace,monospace;color:#121311}
button,a.b{all:unset;cursor:pointer;display:inline-block;background:#121311;color:#F3F2EE;padding:11px 16px;font-weight:600}</style>
<main>${inner}</main>`, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/") return new Response("Human Use report bot. Agents send an error code or a wish here after their lead agreed. Format: GET /report\n", { headers: { "Cache-Control": "no-store" } });
    if (pathname === "/report" || pathname.startsWith("/setup")) return env.BOT.getByName("bot").fetch(request);
    return new Response("Not found\n", { status: 404 });
  }
};

class GitHubError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export class Bot extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/report") return request.method === "POST" ? await this.report(request) : await this.lookup(url);
      if (url.pathname === "/setup") return await this.setup(url);
      if (url.pathname === "/setup/done") return await this.created(url);
      if (url.pathname === "/setup/installed") return await this.installed();
      return new Response("Not found\n", { status: 404 });
    } catch (error) {
      if (error instanceof GitHubError) return json(502, { error: `github ${error.status}: ${error.message}` });
      throw error;
    }
  }

  // ------------------------------------------------------------ reports

  async report(request) {
    let body;
    try { body = await request.json(); } catch { return json(400, { error: "body must be JSON", format: FORMAT }); }
    const parsed = parseReport(body);
    if (parsed.error) return json(400, { error: parsed.error, format: FORMAT });
    if (!await this.ctx.storage.get("app")) return json(503, { error: "the bot is not set up yet" });

    // Counts per day; the address only as a hash salted with the day, so nothing about a sender outlives the day.
    const day = new Date().toISOString().slice(0, 10);
    const who = await sha256hex(`${day}:${request.headers.get("CF-Connecting-IP") ?? "?"}`);
    const total = (await this.ctx.storage.get(`q:${day}`)) ?? 0, mine = (await this.ctx.storage.get(`q:${day}:${who}`)) ?? 0;
    if (mine >= LIMITS.perIp || total >= LIMITS.perDay) return json(429, { error: "too many reports today" });
    await this.ctx.storage.put({ [`q:${day}`]: total + 1, [`q:${day}:${who}`]: mine + 1 });
    await this.sweep(day);

    const report = parsed.report;
    const name = report.code ? await this.codeName(report.code) : null;
    const target = issueFor(report, name);
    // One issue per code and per week: hold other reports while this one finds or opens it.
    // blockConcurrencyWhile resets the object if its callback throws, so the callback returns its error instead.
    const posted = await this.ctx.blockConcurrencyWhile(async () => {
      try {
        const token = await this.token();
        for (let attempt = 0; ; attempt++) {
          let number = await this.ctx.storage.get(target.key);
          if (!number) {
            const issue = await this.github("POST", `/repos/${OWNER}/${REPO}/issues`, token, { title: target.title, body: target.body });
            number = issue.number;
            await this.ctx.storage.put({ [target.key]: number, [`named:${number}`]: Boolean(name) });
          }
          try {
            const data = await this.github("POST", `/repos/${OWNER}/${REPO}/issues/${number}/comments`, token, { body: comment(report, name) });
            // An issue opened while the registry was out of reach gets its code's name once the name is known.
            if (name && !(await this.ctx.storage.get(`named:${number}`))) {
              await this.github("PATCH", `/repos/${OWNER}/${REPO}/issues/${number}`, token, { title: target.title }).catch(() => {});
              await this.ctx.storage.put(`named:${number}`, true);
            }
            return { data };
          } catch (error) {
            // The issue was deleted, moved or locked: open a new one, once.
            if (!(error instanceof GitHubError) || ![403, 404, 410].includes(error.status) || attempt) throw error;
            await this.ctx.storage.delete(target.key);
          }
        }
      } catch (error) {
        return { error };
      }
    });
    if (posted.error) throw posted.error;
    return json(201, { ok: true, url: posted.data.html_url });
  }

  /** GET /report: the format. With ?code= or ?kind=wish: the issue those reports go to, for a lead posting from their own account. */
  async lookup(url) {
    const code = url.searchParams.get("code"), kind = url.searchParams.get("kind");
    if (!code && kind !== "wish") return json(200, FORMAT);
    const parsed = parseReport({ kind: code ? "code" : "wish", code: code ?? undefined, text: "-", version: "0.0.0" });
    if (parsed.error) return json(400, { error: parsed.error });
    const number = await this.ctx.storage.get(issueFor(parsed.report, null).key);
    return json(200, { issue: number ? `https://github.com/${OWNER}/${REPO}/issues/${number}` : null });
  }

  async sweep(day) {
    if ((await this.ctx.storage.get("day")) === day) return;
    const old = [...(await this.ctx.storage.list({ prefix: "q:" })).keys()].filter(key => !key.startsWith(`q:${day}`));
    for (let i = 0; i < old.length; i += 128) await this.ctx.storage.delete(old.slice(i, i + 128));
    await this.ctx.storage.put("day", day);
  }

  /** The code's name from the site's registry, cached for a day. */
  async codeName(code) {
    let registry = await this.ctx.storage.get("registry");
    if (!registry || registry.at < Date.now() - 864e5) {
      try {
        const response = await fetch("https://humanuse.dev/codes.json", { cf: { cacheTtl: 3600 } });
        const data = await response.json();
        registry = { at: Date.now(), names: Object.fromEntries(data.codes.map(entry => [entry.code, entry.names?.[0] ?? null])) };
        await this.ctx.storage.put("registry", registry);
      } catch {
        registry = registry ?? { at: 0, names: {} };
      }
    }
    return registry.names[code] ?? null;
  }

  // ------------------------------------------------------------ GitHub

  async github(method, path, auth, body) {
    const response = await fetch(GITHUB + path, {
      method,
      headers: { Accept: "application/vnd.github+json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}), "User-Agent": "human-use-bot", "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new GitHubError(response.status, data.message ?? response.statusText);
    return data;
  }

  /** An installation token for the repository, kept until five minutes before it expires. */
  async token() {
    const cached = await this.ctx.storage.get("token");
    if (cached && cached.expires > Date.now() + 300e3) return cached.value;
    const app = await this.ctx.storage.get("app");
    const jwt = await appJwt(app.id, app.pem);
    const installation = await this.github("GET", `/repos/${OWNER}/${REPO}/installation`, jwt);
    const token = await this.github("POST", `/app/installations/${installation.id}/access_tokens`, jwt, { repositories: [REPO], permissions: { issues: "write" } });
    await this.ctx.storage.put("token", { value: token.token, expires: Date.parse(token.expires_at) });
    return token.token;
  }

  // ------------------------------------------------------------ setup: GitHub's app manifest flow

  async setup(url) {
    const app = await this.ctx.storage.get("app");
    if (app) return page("Report bot", `<h1>Set up</h1><p>The bot posts as the GitHub App <code>${esc(app.slug)}</code>.</p><p><a href="https://github.com/apps/${esc(app.slug)}/installations/new">Installation</a></p>`);
    const state = crypto.randomUUID();
    await this.ctx.storage.put(`state:${state}`, Date.now() + 3600e3);
    const action = `https://github.com/organizations/${OWNER}/settings/apps/new?state=${state}`;
    return page("Report bot setup", `<h1>Report bot setup</h1>
<p>GitHub creates an app owned by <code>${OWNER}</code> that may write issues in <code>${OWNER}/${REPO}</code>. Its key goes straight from GitHub to this bot.</p>
<form action="${esc(action)}" method="post"><input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest(url.origin)))}"><button type="submit">Create the app on GitHub</button></form>`);
  }

  async created(url) {
    const code = url.searchParams.get("code") ?? "", state = url.searchParams.get("state") ?? "";
    const until = await this.ctx.storage.get(`state:${state}`);
    await this.ctx.storage.delete(`state:${state}`);
    if (!until || until < Date.now() || !/^[0-9a-f]{20,64}$/i.test(code)) return page("Report bot setup", "<h1>Expired</h1><p>Start again from /setup.</p>");
    if (await this.ctx.storage.get("app")) return page("Report bot setup", "<h1>Already set up</h1>");
    const app = await this.github("POST", `/app-manifests/${code}/conversions`, "");
    if (app.owner?.login !== OWNER) return page("Report bot setup", `<h1>Refused</h1><p>The app is owned by <code>${esc(app.owner?.login)}</code>, not <code>${OWNER}</code>.</p>`);
    await this.ctx.storage.put("app", { id: app.id, slug: app.slug, pem: app.pem });
    return Response.redirect(`https://github.com/apps/${app.slug}/installations/new`, 302);
  }

  async installed() {
    const app = await this.ctx.storage.get("app");
    if (!app) return page("Report bot setup", "<h1>Not set up</h1>");
    await this.ctx.storage.delete("token");
    await this.token();
    return page("Report bot", `<h1>Installed</h1><p><code>${esc(app.slug)}</code> can write issues in <code>${OWNER}/${REPO}</code>. Reports go to <code>POST /report</code>.</p>`);
  }
}
