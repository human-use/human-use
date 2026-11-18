import { readFileSync } from "node:fs";
import { buildContent, extractActions, logCall } from "./driver.js";
import { promptPath } from "./paths.js";
import type { Driver, DriverInput } from "./runtime.js";

/**
 * Driver on any OpenAI-compatible chat endpoint: Ollama, LM Studio, llama.cpp, vLLM, or a hosted API with a key.
 * This is the path for local models. A bare endpoint has no tools by construction, which is exactly what the
 * driver is allowed. Photos need a model that reads images.
 */
export class ChatDriver implements Driver {
  constructor(private readonly options: { baseUrl: string; model: string; keyEnv?: string; label?: string; timeoutMs?: number }) {}

  async run(input: DriverInput): Promise<unknown> {
    const blocks = buildContent(input);
    const hasImage = blocks.some(block => block.type === "image");
    // Text-only local models often accept only a string here, so parts are used only when a photo is attached.
    const content = hasImage
      ? blocks.map(block => block.type === "text" ? { type: "text", text: block.text }
        : { type: "image_url", image_url: { url: `data:${block.media};base64,${readFileSync(block.path).toString("base64")}` } })
      : blocks.map(block => block.type === "text" ? block.text : "").join("\n\n");
    const key = this.options.keyEnv ? process.env[this.options.keyEnv] : undefined;
    const started = Date.now();
    const response = await fetch(`${this.options.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        model: this.options.model, stream: false, temperature: 0,
        messages: [{ role: "system", content: readFileSync(promptPath("driver"), "utf8") }, { role: "user", content }]
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 180_000)
    });
    if (!response.ok) throw new Error(`${this.options.label ?? this.options.model} answered HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: Record<string, number> };
    // Reasoning models that think out loud put it in <think> tags ahead of the answer.
    const text = (data.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    logCall(this.options.label ?? `openai:${this.options.model}`, input, Date.now() - started, text, { usage: data.usage ?? null });
    return extractActions(text);
  }
}
