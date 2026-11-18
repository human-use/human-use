// Pure parts of the report bot: input rules, Markdown escaping, GitHub App JWT. No Cloudflare imports, so Node can test them.

export const OWNER = "human-use";
export const REPO = "human-use";
export const LIMITS = { text: 280, perIp: 10, perDay: 300 };

const CODE = /^HRT-[45]\d{3}$/;
const TOOL = /^[a-z][a-z0-9_]{0,31}$/;
const VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[0-9A-Za-z.]{1,20})?$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}$/;

/** What GET /report answers: the format, for an agent that reads it before sending. */
export const FORMAT = {
  post: "https://bot.humanuse.dev/report",
  body: {
    kind: "code or wish",
    code: "HRT-NNNN. Required for kind code; a wish may cite one.",
    tool: "A tool name, optional. For HRT-4000, the tool that was called.",
    text: `One sentence about the system, at most ${LIMITS.text} characters. No names, places or task contents.`,
    version: "The runtime version, e.g. 0.1.0.",
    host: "The agent, e.g. Claude Code. Optional."
  },
  consent: "Send only after the lead has seen the exact text and agreed.",
  own_account: "A lead who prefers their own GitHub account can comment on the same issue with gh. GET /report?code=HRT-NNNN or ?kind=wish returns that issue.",
  lists: `https://github.com/${OWNER}/${REPO}/issues?q=is%3Aissue+author%3Aapp%2Fhuman-use-reports`
};

/** Checks a report body. Returns { report } or { error }. Text is folded to one line. */
export function parseReport(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "body must be a JSON object" };
  const { kind } = body;
  if (kind !== "code" && kind !== "wish") return { error: 'kind must be "code" or "wish"' };
  const text = typeof body.text === "string" ? body.text.replace(/\s+/g, " ").trim() : "";
  if (!text) return { error: "text is required: one sentence about the system" };
  if (text.length > LIMITS.text) return { error: `text is longer than ${LIMITS.text} characters` };
  const report = { kind, text };
  if (kind === "code" || body.code !== undefined) {
    if (typeof body.code !== "string" || !CODE.test(body.code)) return { error: "code must look like HRT-4000" };
    report.code = body.code;
  }
  if (body.tool !== undefined) {
    if (typeof body.tool !== "string" || !TOOL.test(body.tool)) return { error: "tool must be a tool name, e.g. photo" };
    report.tool = body.tool;
  }
  if (typeof body.version !== "string" || !VERSION.test(body.version)) return { error: "version must be the runtime version, e.g. 0.1.0" };
  report.version = body.version;
  if (body.host !== undefined) {
    if (typeof body.host !== "string" || !HOST.test(body.host)) return { error: "host must be the agent's name, e.g. Claude Code" };
    report.host = body.host;
  }
  return { report };
}

/** One line of untrusted text, safe inside Markdown: no markup, no mentions, no links, no issue references. */
export function inline(text) {
  return text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/[\\`*_{}[\]()#+!|~]/g, "\\$&")
    .replace(/@/g, "@\u200b")
    .replace(/:\/\//g, ":\u200b//")
    .replace(/\bwww\./gi, m => `${m.slice(0, 3)}\u200b.`);
}

/** The comment for one report. */
export function comment(report, codeName) {
  const head = [
    report.code && `**${report.code}**${codeName ? ` \`${codeName}\`` : ""}`,
    report.tool && `tool \`${report.tool}\``,
    `human-use ${report.version}`,
    report.host && inline(report.host)
  ].filter(Boolean).join(" · ");
  return `${head}\n\n> ${inline(report.text)}`;
}

export function issueFor(report, codeName, now = new Date()) {
  if (report.kind === "code") return {
    key: `issue:${report.code}`,
    title: `${report.code}${codeName ? ` ${codeName}` : ""}`,
    body: `Reports of \`${report.code}\` from the field. Each comment is one report an agent sent with its lead's consent: the code, the runtime version and one sentence about the system. Nothing else is sent.\n\nRegistry: https://humanuse.dev/codes/#${report.code}`
  };
  const week = isoWeek(now);
  return {
    key: `issue:wish:${week}`,
    title: `Wishes, ${week}`,
    body: `What agents asked for in ${week}. Each comment is one wish an agent sent with its lead's consent: one sentence, and the tool it concerns if any.`
  };
}

/** "2026-W47" */
export function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d - start) / 864e5 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** The GitHub App the setup page asks GitHub to create. */
export function manifest(origin) {
  return {
    name: "human-use-reports",
    url: "https://humanuse.dev",
    description: "Posts the error codes and wishes that agents send with their lead's consent.",
    hook_attributes: { url: `${origin}/hook`, active: false },
    redirect_url: `${origin}/setup/done`,
    setup_url: `${origin}/setup/installed`,
    public: false,
    default_permissions: { issues: "write", metadata: "read" },
    default_events: []
  };
}

// ---------------------------------------------------------------- GitHub App JWT (RS256)

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};

function der(tag, body) {
  const n = body.length;
  const len = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : n < 0x10000 ? [0x82, n >> 8, n & 255] : [0x83, n >> 16, (n >> 8) & 255, n & 255];
  return concat(Uint8Array.from([tag, ...len]), body);
}

/** GitHub hands out PKCS#1 keys; WebCrypto imports PKCS#8. Wrap one in the other. */
export function pkcs1ToPkcs8(pkcs1) {
  const version = Uint8Array.from([0x02, 0x01, 0x00]);
  const rsaEncryption = Uint8Array.from([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  return der(0x30, concat(version, rsaEncryption, der(0x04, pkcs1)));
}

export function pemBytes(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

const b64url = bytes => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export async function appJwt(appId, pem, now = Date.now()) {
  let der8 = pemBytes(pem);
  if (pem.includes("BEGIN RSA PRIVATE KEY")) der8 = pkcs1ToPkcs8(der8);
  const key = await crypto.subtle.importKey("pkcs8", der8, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const part = obj => b64url(new TextEncoder().encode(JSON.stringify(obj)));
  const s = Math.floor(now / 1000);
  const data = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat: s - 60, exp: s + 540, iss: Number(appId) })}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(data));
  return `${data}.${b64url(new Uint8Array(sig))}`;
}

export async function sha256hex(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}
