import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BackendSpec } from "./backends.js";
import { home } from "./paths.js";

/**
 * Settings in <home>/config.json. Every key is optional and each has an environment override
 * (HUMAN_USE_DRIVER, HUMAN_USE_BRAIN, HUMAN_USE_LANG), so one run can differ without editing the file.
 */
export interface Config {
  /** Which model runs the driver. See backends.ts for the forms. Default claude:haiku. */
  driver?: BackendSpec;
  /** Existing pre-release installations can still load a saved setting. */
  overseer?: BackendSpec;
  /** What starts the brain for a pass when no agent window is open: claude, codex or none. Install sets the host it registers; unset means none. */
  brain?: BackendSpec;
  /** Language the unit reads. Default: the system locale. */
  lang?: string;
  /** HTTPS origin for the blind relay, or "none" for LAN only. */
  relay?: string;
}

export const DEFAULT_RELAY = "https://unit.humanuse.dev";

export function config(): Config {
  try {
    return JSON.parse(readFileSync(join(home(), "config.json"), "utf8")) as Config;
  } catch {
    return {};
  }
}

export async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Replace a settings file atomically and check for edits since the caller read it. */
export async function replaceConfig(path: string, expected: string | null, content: string): Promise<void> {
  const temp = join(dirname(path), `.config-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, content, { flag: "wx", mode: 0o600 });
    if (await readOptional(path) !== expected) throw new Error(`${path} changed while saving. Try again.`);
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

export async function saveRuntimeConfig(dir: string, update: Partial<Config>): Promise<void> {
  const path = join(dir, "config.json");
  const previous = await readOptional(path);
  const existing: unknown = JSON.parse(previous ?? "{}");
  if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  await replaceConfig(path, previous, `${JSON.stringify({ ...existing, ...update }, null, 2)}\n`);
}
