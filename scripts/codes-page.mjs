// Renders site/codes.json into site/codes/index.html, between the map, codes and log markers.
// Run after editing codes.json: node scripts/codes-page.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
export const JSON_PATH = `${root}site/codes.json`;
export const PAGE_PATH = `${root}site/codes/index.html`;

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = code => Number(code.slice(4));
/** Prose in codes.json marks code with backticks. */
const prose = s => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");

export function renderMap(data) {
  const byNum = new Map(data.codes.map(c => [num(c.code), c]));
  const rangeOf = n => data.ranges.find(r => n >= r.from && n <= r.to);
  const out = [];

  // map: one strip of 40 slots per thousand
  out.push(`<div class="map" id="map" aria-label="Code space: ${data.codes.length} of ${data.ranges.reduce((a, r) => a + r.to - r.from + 1, 0)} numbers assigned">`);
  for (const base of [...new Set(data.ranges.map(r => Math.floor(r.from / 1000) * 1000))]) {
    const ranges = data.ranges.filter(r => Math.floor(r.from / 1000) * 1000 === base);
    const top = Math.max(...ranges.map(r => r.to));
    out.push(`  <div class="strip">`, `    <div class="sh"><b>${base}</b><span>${base}–${top}</span></div>`, `    <div class="slots">`);
    for (let n = base; n <= top; n++) {
      const c = byNum.get(n), r = rangeOf(n);
      const cls = ["sl", c ? "on" : "", c && c.arrives === "card" ? "s" : "", r && n === r.from && n !== base ? "edge" : ""].filter(Boolean).join(" ");
      out.push(c
        ? `      <a class="${cls}" href="#${c.code}" title="${c.code} ${esc(c.names.join(" / ") || "internal")}"><span>${String(n % 100).padStart(2, "0")}</span></a>`
        : `      <i class="${cls}" title="HRT-${n} free"></i>`);
    }
    out.push(`    </div>`, `    <div class="bands">`);
    for (const r of ranges) {
      const used = data.codes.filter(c => num(c.code) >= r.from && num(c.code) <= r.to).length;
      out.push(`      <div class="band" style="grid-column:${r.from - base + 1} / ${r.to - base + 2}"><b>${esc(r.name)}</b><span>${r.from}–${r.to} · ${used} of ${r.to - r.from + 1}</span><p>${esc(r.about)}</p></div>`);
    }
    out.push(`    </div>`, `  </div>`);
  }
  out.push(`</div>`);
  return out.join("\n");
}

export function renderCodes(data) {
  const out = [`<div class="codes">`];
  for (const r of data.ranges) {
    const list = data.codes.filter(c => num(c.code) >= r.from && num(c.code) <= r.to);
    if (!list.length) continue;
    out.push(`  <h3 class="rh"><span>${r.from}–${r.to}</span>${esc(r.name)}</h3>`);
    for (const c of list) {
      out.push(`  <article class="code${c.arrives === "card" ? " s" : ""}" id="${c.code}">`,
        `    <div class="cid"><a href="#${c.code}"><small>HRT-</small>${c.code.slice(4)}</a>${c.names.length ? c.names.map(n => `<code>${n}</code>`).join("") : `<code class="dim">no name</code>`}<span class="arr">${c.arrives.split(", ").map(a => `<em>${a}</em>`).join("")}</span></div>`,
        `    <dl>`,
        `      <dt>When</dt><dd>${prose(c.when)}</dd>`,
        `      <dt>Agent</dt><dd>${prose(c.agent)}</dd>`,
        `      <dt>${c.arrives === "card" ? "Unit sees" : "Looks like"}</dt><dd><pre>${esc(c.example)}</pre></dd>`);
      if (c.limits) out.push(`      <dt>Limits</dt><dd><table class="lim"><tbody>${c.limits.map(([f, v]) => `<tr><td><code>${esc(f)}</code></td><td>${esc(v)}</td></tr>`).join("")}</tbody></table></dd>`);
      out.push(`      <dt>Since</dt><dd class="mono">${esc(c.since)}</dd>`, `    </dl>`, `  </article>`);
    }
  }
  out.push(`</div>`);
  return out.join("\n");
}

export function renderLog(data) {
  return data.log.map(l => `<tr><td class="mono">${esc(l.rev)}</td><td class="mono">${esc(l.date)}</td><td>${esc(l.note)}</td></tr>`).join("\n");
}

/** The page with both generated regions replaced. */
export function build(page, data) {
  const swap = (html, begin, end, body) => {
    const a = html.indexOf(begin), b = html.indexOf(end);
    if (a < 0 || b < a) throw new Error(`markers ${begin} … ${end} not found`);
    return html.slice(0, a + begin.length) + "\n" + body + "\n" + html.slice(b);
  };
  let html = swap(page, "<!-- map:begin -->", "<!-- map:end -->", renderMap(data));
  html = swap(html, "<!-- codes:begin -->", "<!-- codes:end -->", renderCodes(data));
  html = swap(html, "<!-- log:begin -->", "<!-- log:end -->", renderLog(data));
  return html.replace(/data-n="codes">[^<]*</, `data-n="codes">${data.codes.length}<`)
    .replace(/data-n="rev">[^<]*</, `data-n="rev">${data.rev}<`)
    .replace(/data-n="updated">[^<]*</, `data-n="updated">${data.updated}<`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const data = JSON.parse(readFileSync(JSON_PATH, "utf8"));
  const page = readFileSync(PAGE_PATH, "utf8");
  writeFileSync(PAGE_PATH, build(page, data));
  console.log(`codes page: ${data.codes.length} codes, rev ${data.rev}`);
}
