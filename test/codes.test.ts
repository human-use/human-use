import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { build, JSON_PATH, PAGE_PATH } from "../scripts/codes-page.mjs";

type Registry = { rev: string; ranges: { from: number; to: number }[]; codes: { code: string; names: string[]; arrives: string }[]; log: { rev: string }[] };
const registry = JSON.parse(readFileSync(JSON_PATH, "utf8")) as Registry;

const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);

test("every HRT code the runtime raises is in the registry, and the registry lists no code it does not raise", () => {
  const raised = new Set(["src", "prompts"].flatMap(files).flatMap(file => readFileSync(file, "utf8").match(/HRT-\d{4}/g) ?? []));
  const listed = new Set(registry.codes.map(entry => entry.code));
  assert.deepEqual([...raised].filter(code => !listed.has(code)), [], "raised but not registered");
  assert.deepEqual([...listed].filter(code => !raised.has(code)), [], "registered but never raised");
});

test("registry entries are well formed and sit in their ranges", () => {
  const seen = new Set<string>();
  for (const entry of registry.codes) {
    assert.match(entry.code, /^HRT-\d{4}$/);
    assert.ok(!seen.has(entry.code), `${entry.code} listed twice`);
    seen.add(entry.code);
    const n = Number(entry.code.slice(4));
    assert.ok(registry.ranges.some(range => n >= range.from && n <= range.to), `${entry.code} is outside every range`);
  }
  assert.equal(registry.log.at(-1)?.rev, registry.rev);
});

test("the codes page is rendered from codes.json", () => {
  const page = readFileSync(PAGE_PATH, "utf8").replace(/\r\n/g, "\n");
  assert.equal(build(page, registry), page, "run node scripts/codes-page.mjs");
});
