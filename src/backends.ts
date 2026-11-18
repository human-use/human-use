import { ClaudeBrain } from "./brain.js";
import { ChatDriver } from "./chat.js";
import { CodexBrain, CodexDriver } from "./codex.js";
import { ClaudeDriver } from "./driver.js";
import type { Brain, Driver } from "./runtime.js";

/**
 * Which model runs the driver, and what wakes the brain. Written in config.json or an environment variable:
 *
 *   "claude:haiku"                         the lead's Claude subscription, through `claude -p`
 *   "codex:gpt-6-luna:medium"              the lead's ChatGPT subscription, through `codex exec`; third part is reasoning effort
 *   "ollama:qwen3-vl:8b"                   a local model served by Ollama (OLLAMA_HOST, default 127.0.0.1:11434)
 *   "openai:<model>@http://host:port/v1"   any OpenAI-compatible endpoint; the key, if any, is read from HUMAN_USE_API_KEY
 *   "none"
 *
 * config.json may also give an object: { "backend": "openai", "base_url": "...", "model": "...", "key_env": "MY_KEY" }.
 */
interface BackendOptions { model?: string; effort?: string; base_url?: string; key_env?: string }
type Parsed = BackendOptions & { backend: string };
export type BackendSpec = string | Parsed | (BackendOptions & { driver: string });

export function parseBackend(spec: BackendSpec): Parsed {
  if (typeof spec !== "string") {
    if ("backend" in spec) return spec;
    const { driver, ...options } = spec;
    return { backend: driver, ...options };
  }
  const [backend = "", ...rest] = spec.split(":");
  const tail = rest.join(":");
  if (backend === "ollama") return { backend, ...(tail ? { model: tail } : {}) };                 // Ollama model names contain colons
  if (backend === "openai") {
    const at = tail.lastIndexOf("@");
    return at < 0 ? { backend, model: tail } : { backend, model: tail.slice(0, at), base_url: tail.slice(at + 1) };
  }
  const [model, effort] = rest;
  return { backend, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

function ollamaBase(): string {
  const host = process.env.OLLAMA_HOST || "127.0.0.1:11434";
  return `${(/^https?:\/\//.test(host) ? host : `http://${host}`).replace(/\/+$/, "")}/v1`;
}

export function makeDriver(spec: BackendSpec): Driver | null {
  const parsed = parseBackend(spec);
  const choice = { ...(parsed.model ? { model: parsed.model } : {}), ...(parsed.effort ? { effort: parsed.effort } : {}) };
  switch (parsed.backend) {
    case "none": return null;
    case "claude": return new ClaudeDriver(choice);
    case "codex": return new CodexDriver(choice);
    case "ollama":
      if (!parsed.model) throw new Error('backend "ollama" needs a model, e.g. ollama:qwen3-vl:8b');
      return new ChatDriver({ baseUrl: parsed.base_url ?? ollamaBase(), model: parsed.model, label: `ollama:${parsed.model}` });
    case "openai":
      if (!parsed.model || !parsed.base_url) throw new Error('backend "openai" needs a model and a base URL, e.g. openai:my-model@http://127.0.0.1:1234/v1');
      return new ChatDriver({ baseUrl: parsed.base_url, model: parsed.model, keyEnv: parsed.key_env ?? "HUMAN_USE_API_KEY", label: `openai:${parsed.model}` });
    default: throw new Error(`unknown backend "${parsed.backend}": use claude, codex, ollama, openai or none`);
  }
}

/**
 * The brain is agent software that loads the human-use tools; the runtime does not contain one. What is configured
 * here is only how to start that software for a pass when no window is open. A bare model endpoint cannot be woken
 * this way: it has no tool loop. Local models reach the brain seat through agent software that can host them.
 */
export function makeBrain(spec: BackendSpec, exited: (goalId: string, info: Record<string, unknown>) => void): Brain | null {
  const parsed = parseBackend(spec);
  const choice = { ...(parsed.model ? { model: parsed.model } : {}), ...(parsed.effort ? { effort: parsed.effort } : {}) };
  switch (parsed.backend) {
    case "none": return null;
    case "codex": return new CodexBrain({ ...choice, onExit: exited });
    case "claude": return new ClaudeBrain({
      ...choice,
      onExit: (goalId, run, error, wokeAt) => exited(goalId, run
        ? { ok: run.ok, woke_at: wokeAt, backend: "claude", turns: run.turns, cost_usd: run.cost_usd, ms: run.duration_ms }
        : { ok: false, woke_at: wokeAt, error: String(error) })
    });
    default: throw new Error(`unknown brain backend "${parsed.backend}": use claude, codex or none. A model endpoint alone has no tool loop; run it inside agent software.`);
  }
}
