import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// The translated READMEs must keep every command, code span and link of README.md, so they cannot drift on what to type.
const files = ["README.md", "README.zh-CN.md", "README.ja.md", "README.ko.md"];
const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const fences = (text: string) => text.match(/```[\s\S]*?```/g) ?? [];
const spans = (text: string) => new Set(text.replace(/```[\s\S]*?```/g, "").match(/`[^`\n]+`/g) ?? []);
const links = (text: string) => new Set([...text.matchAll(/\]\(([^)]+)\)|(?:href|src)="([^"]+)"/g)].map(match => match[1] ?? match[2]));
const english = read("README.md");

for (const name of files.slice(1)) {
  test(`${name} keeps the commands, code and links of README.md`, () => {
    const text = read(name);
    assert.deepEqual(fences(text), fences(english));
    for (const span of spans(english)) assert.ok(text.includes(span), `${name} is missing ${span}`);
    for (const link of links(english)) if (!files.includes(link)) assert.ok(links(text).has(link), `${name} is missing the link ${link}`);
    assert.equal(text.match(/^## /gm)?.length, english.match(/^## /gm)?.length);
  });
}

test("every README links to the other languages", () => {
  for (const name of files) {
    const text = read(name);
    for (const other of files) if (other !== name) assert.ok(text.includes(`href="${other}"`), `${name} does not link ${other}`);
  }
});
