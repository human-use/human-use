import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { qr } from "../site/qr.js";

const jsQR = createRequire(import.meta.url)("../assets/jsqr.js") as (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;

function scan(text: string): string | undefined {
  const grid = qr(text);
  const scale = 4, quiet = 4, size = (grid.length + quiet * 2) * scale;
  const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
  grid.forEach((row, y) => row.forEach((dark, x) => {
    if (!dark) return;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const at = (((y + quiet) * scale + dy) * size + (x + quiet) * scale + dx) * 4;
      pixels[at] = pixels[at + 1] = pixels[at + 2] = 0;
    }
  }));
  return jsQR(pixels, size, size)?.data;
}

test("the site's QR codes scan back to their text", () => {
  const link = "https://unit.humanuse.dev/#AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB.try";
  for (const text of ["hi", "https://humanuse.dev", link, link + "x".repeat(80), "y".repeat(213)]) assert.equal(scan(text), text);
  assert.throws(() => qr("z".repeat(214)));
});

test("the site carries the relay's wire module unchanged", () => {
  assert.equal(readFileSync(new URL("../site/relay-wire.mjs", import.meta.url), "utf8"), readFileSync(new URL("../assets/relay-wire.mjs", import.meta.url), "utf8"));
});
