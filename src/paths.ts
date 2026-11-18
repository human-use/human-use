import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Everything the runtime keeps lives under one directory. Override with HUMAN_USE_HOME. */
export function home(): string {
  const dir = process.env.HUMAN_USE_HOME || join(homedir(), ".human-use");
  mkdirSync(dir, { recursive: true });
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
