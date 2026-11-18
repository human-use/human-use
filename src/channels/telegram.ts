/**
 * Minimal Telegram Bot API client. Long polling only, so it works behind any NAT with no public address.
 * Each user runs their own bot (token from @BotFather); messages never pass through a Human Use server.
 * Knows nothing about the runtime: card rendering and pairing sit on top of this.
 */
export type Keyboard = Array<Array<{ text: string; callback_data: string }>>;

export interface TelegramHandlers {
  message?(message: any): Promise<void> | void;
  callback?(query: any): Promise<void> | void;
}

export interface TelegramOptions {
  token: string;
  /** Override for tests; defaults to the real Bot API. */
  apiBase?: string | undefined;
  pollTimeoutSeconds?: number | undefined;
}

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

export class TelegramBot {
  username: string | null = null;
  private offset = 0;
  private stopped = false;
  private readonly poller = new AbortController();

  constructor(private readonly options: TelegramOptions) {}

  async start(handlers: TelegramHandlers): Promise<void> {
    this.username = (await this.call("getMe")).username;
    void this.loop(handlers);
  }

  stop(): void {
    this.stopped = true;
    this.poller.abort();
  }

  link(payload: string): string {
    return `https://t.me/${this.username}?start=${encodeURIComponent(payload)}`;
  }

  send(chat: string, text: string, keyboard?: Keyboard): Promise<any> {
    return this.call("sendMessage", { chat_id: chat, text, ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}) });
  }

  answer(callbackId: string, text?: string): Promise<any> {
    return this.call("answerCallbackQuery", { callback_query_id: callbackId, ...(text ? { text } : {}) });
  }

  delete(chat: string, messageId: number): Promise<any> {
    return this.call("deleteMessage", { chat_id: chat, message_id: messageId });
  }

  async call(method: string, payload: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<any> {
    const base = (this.options.apiBase ?? "https://api.telegram.org").replace(/\/$/, "");
    const response = await fetch(`${base}/bot${this.options.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), this.poller.signal])
    });
    const data = await response.json() as { ok: boolean; result?: unknown; description?: string };
    if (!data.ok) throw new Error(`telegram ${method}: ${data.description ?? response.status}`);
    return data.result;
  }

  private async loop(handlers: TelegramHandlers): Promise<void> {
    const wait = this.options.pollTimeoutSeconds ?? 25;
    while (!this.stopped) {
      try {
        const updates = await this.call("getUpdates", {
          offset: this.offset, timeout: wait, allowed_updates: ["message", "callback_query"]
        }, (wait + 10) * 1000) as any[];
        for (const update of updates) {
          this.offset = update.update_id + 1;
          try {
            if (update.callback_query) await handlers.callback?.(update.callback_query);
            else if (update.message) await handlers.message?.(update.message);
          } catch (error) {
            console.error("telegram handler:", error instanceof Error ? error.message : error);
          }
        }
      } catch {
        if (!this.stopped) await sleep(3000);
      }
    }
  }
}
