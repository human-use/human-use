import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CATALOG, CATEGORIES } from "../src/catalog.js";

test("the catalog on the site is the runtime's catalog", () => {
  const page = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
  const match = page.match(/var CATALOG = (\{.*\});/);
  assert.ok(match, "site/index.html has no var CATALOG line");
  const site = JSON.parse(match[1]) as { categories: Record<string, string>; tools: { category: string; release: string; name: string; summary: string }[] };
  assert.deepEqual(site.categories, CATEGORIES);
  assert.deepEqual(site.tools, CATALOG.map(({ category, release, name, summary }) => ({ category, release, name, summary })));
});
