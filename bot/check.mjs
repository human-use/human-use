// Checks the bot's pure parts with Node: node bot/check.mjs
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { appJwt, comment, inline, isoWeek, parseReport } from "./lib.mjs";

// input rules
assert.equal(parseReport({ kind: "code", code: "HRT-4000", tool: "hug", text: "  tried\n hug ", version: "0.1.0" }).report.text, "tried hug");
assert.match(parseReport({ kind: "code", text: "x", version: "0.1.0" }).error, /code/);
assert.match(parseReport({ kind: "wish", text: "x".repeat(281), version: "0.1.0" }).error, /longer/);
assert.match(parseReport({ kind: "wish", text: "x", version: "latest" }).error, /version/);
assert.match(parseReport({ kind: "wish", text: "x", version: "0.1.0", tool: "Rm -rf" }).error, /tool/);
assert.match(parseReport({ kind: "spam", text: "x", version: "0.1.0" }).error, /kind/);
assert.ok(parseReport({ kind: "wish", text: "A queue_photo tool.", version: "0.1.0-beta.1", host: "Claude Code" }).report);

// untrusted text cannot mention, link, reference or mark up
const t = inline("ping @octocat see https://x.y and www.z.com #12 [a](b) **b** <img>");
assert.ok(!/@[a-z]/i.test(t) && !t.includes("://") && !/www\./i.test(t) && !t.includes("<img"));
assert.ok(t.includes(String.raw`\#12`) && t.includes(String.raw`\[a\]\(b\)`) && t.includes(String.raw`\*\*b\*\*`));
assert.equal(comment({ code: "HRT-4000", tool: "hug", version: "0.1.0", host: "Codex", text: "No hug tool." }, "NO_SUCH_TOOL"),
  "**HRT-4000** `NO_SUCH_TOOL` · tool `hug` · human-use 0.1.0 · Codex\n\n> No hug tool.");

assert.equal(isoWeek(new Date("2026-11-18T12:00:00Z")), "2026-W47");
assert.equal(isoWeek(new Date("2027-01-01T00:00:00Z")), "2026-W53");

// a JWT signed from a PKCS#1 key, the format GitHub hands out, verifies with that key
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs1", format: "pem" });
assert.ok(pem.includes("BEGIN RSA PRIVATE KEY"));
const jwt = await appJwt(123456, pem, Date.UTC(2026, 10, 18));
const [h, p, s] = jwt.split(".");
assert.deepEqual(JSON.parse(Buffer.from(p, "base64url")), { iat: 1794960000 - 60, exp: 1794960000 + 540, iss: 123456 });
assert.ok(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s, "base64url")));
console.log("bot check ok");
