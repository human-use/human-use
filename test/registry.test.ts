import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

test("server.json lists the npm package this repository publishes", () => {
  const pkg = read("../package.json");
  const server = read("../server.json");
  assert.equal(server.name, pkg.mcpName);
  assert.equal(server.version, pkg.version);
  assert.ok(server.description.length <= 100);
  assert.deepEqual(server.packages.map((entry: { identifier: string; version: string }) => [entry.identifier, entry.version]), [[pkg.name, pkg.version]]);
});
