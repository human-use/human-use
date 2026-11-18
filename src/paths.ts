import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const closed = new Set<string>();

/**
 * Everything the runtime keeps lives under one directory. Override with HUMAN_USE_HOME.
 * It holds answers, photos and pairing keys, so on POSIX only its owner may enter it, an older install's folder included.
 */
export function home(): string {
  const dir = process.env.HUMAN_USE_HOME || join(homedir(), ".human-use");
  if (!closed.has(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") try { chmodSync(dir, 0o700); } catch { /* not ours to change */ }
    closed.add(dir);
  }
  return dir;
}

const sub = (...parts: string[]) => {
  const dir = join(home(), ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
};

export const dbPath = () => join(home(), "runtime.sqlite");
export const port = () => Number(process.env.HUMAN_USE_PORT ?? 7337);
export const webPort = () => Number(process.env.HUMAN_USE_WEB_PORT ?? 7338);

/** Photos and recordings the unit hands in. */
export const filesDir = () => sub("files");
export const logsDir = () => sub("logs");
/** Working directory for headless model processes, so they pick up no project files. */
export const sandboxDir = () => sub("sandbox");

/** Prompt files ship next to the code: ../prompts from both src/ and dist/. */
export const promptPath = (name: string) => fileURLToPath(new URL(`../prompts/${name}.md`, import.meta.url));

export const callerInstructions = () => readFileSync(promptPath("caller"), "utf8").trim();

export async function withBrainPrompt<T>(run: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "human-use-brain-"));
  const path = join(dir, "system.md");
  try {
    writeFileSync(path, `${callerInstructions()}\n\n${readFileSync(promptPath("brain"), "utf8")}`);
    return await run(path);
  } finally {
    rmSync(path, { force: true });
    rmdirSync(dir);
  }
}
