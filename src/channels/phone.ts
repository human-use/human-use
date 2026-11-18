import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Answer, Card, CardReport, Channel } from "../runtime.js";

export const MAX_PHONE_BODY = 12 * 1024 * 1024;
const EXT: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "audio/webm": ".webm", "audio/mp4": ".m4a", "audio/wav": ".wav", "audio/mpeg": ".mp3", "audio/ogg": ".ogg" };

export interface PhoneOptions {
  /** The unit this phone belongs to, shown in the page header. */
  name?: string;
  filesDir: string;
  answer(jobId: string, answer: Answer): void;
  counts(): { queued: number; review: number };
  onCard?(card: Card): void;
  /** The person unpaired this phone. */
  unpair?(): Promise<void>;
}

/** One unit's phone: the same cards and submission rules for the LAN page and the relay. */
export class PhoneChannel implements Channel {
  private cards: Card[] = [];
  private theater: Array<{ card: Card; at: number }> = [];
  private reports: CardReport[] = [];
  private notice: { text: string; at: number } | null = null;
  private version = 1;
  private readonly polls = new Set<() => void>();
  lastSeenAt: number | null = null;

  constructor(private readonly options: PhoneOptions) {}

  show(card: Card, restored = false): void {
    if (card.kind === "theater") this.theater.push({ card, at: Date.now() });
    else this.cards = [...this.cards.filter(open => open.job_id !== card.job_id), card];
    this.bump();
    if (!restored) this.options.onCard?.(card);
  }

  withdraw(jobId: string, reason: string): void {
    this.cards = this.cards.filter(card => card.job_id !== jobId);
    this.notice = { text: reason, at: Date.now() };
    this.bump();
  }

  report(report: CardReport): void {
    this.reports = [...this.reports.slice(-11), report];
    this.bump();
  }

  private bump(): void {
    this.version++;
    for (const wake of [...this.polls]) wake();
  }

  async state(version = 0, signal?: AbortSignal) {
    this.lastSeenAt = Date.now();
    if (version === this.version && !signal?.aborted) {
      await new Promise<void>(resolve => {
        const wake = () => {
          clearTimeout(timer);
          this.polls.delete(wake);
          signal?.removeEventListener("abort", wake);
          resolve();
        };
        const timer = setTimeout(wake, 25_000);
        this.polls.add(wake);
        signal?.addEventListener("abort", wake, { once: true });
      });
    }
    const now = Date.now();
    this.theater = this.theater.filter(entry => now - entry.at < 60_000);
    return {
      v: this.version,
      unit: this.options.name ?? null,
      card: this.cards.at(-1) ?? null,
      stacked: Math.max(0, this.cards.length - 1),
      theater: this.theater.map(entry => ({ id: entry.card.job_id, title: entry.card.title, text: entry.card.text, seconds: entry.card.seconds ?? 4 })),
      reports: this.reports,
      notice: this.notice && now - this.notice.at < 15_000 ? this.notice.text : null,
      ...this.options.counts()
    };
  }

  /** The person asked to unpair. Answer first: renewing the pairing closes the relay socket this request came on. */
  unpair(): { ok: true } {
    setTimeout(() => void this.options.unpair?.().catch(error => console.error("[human-use] unpair failed:", error)), 200);
    return { ok: true };
  }

  submit(payload: { job_id?: unknown; round?: unknown; answer?: unknown }): { ok: true } | { error: string } {
    this.lastSeenAt = Date.now();
    const card = this.cards.find(open => open.job_id === payload.job_id);
    if (!card || (payload.round !== undefined && payload.round !== card.round)) return { error: "NOT_OPEN" };
    if (!payload.answer || typeof payload.answer !== "object" || Array.isArray(payload.answer)) return { error: "REJECTED" };
    const out = this.clean(card, payload.answer as Record<string, unknown>);
    // The card leaves the phone only once the runtime has the answer, so a failed write can be sent again.
    try {
      this.options.answer(card.job_id, out);
    } catch (error) {
      return { error: error instanceof Error ? error.message.split(" ")[0]! : "REJECTED" };
    }
    this.cards = this.cards.filter(open => open !== card);
    this.bump();
    return { ok: true };
  }

  /** Keep only the shapes an Answer may have, and move any file out of the request onto disk. */
  private clean(card: Card, raw: Record<string, unknown>): Answer {
    const out: Answer = {};
    if (typeof raw.choice === "string") out.choice = raw.choice.slice(0, 500);
    if (typeof raw.value === "number" && Number.isFinite(raw.value)) out.value = raw.value;
    if (Array.isArray(raw.checked)) out.checked = raw.checked.filter((index): index is number => Number.isInteger(index));
    if (typeof raw.text === "string" && raw.text.trim()) out.text = raw.text.slice(0, 4000);
    const where = raw.location as { lat?: unknown; lon?: unknown } | undefined;
    if (where && typeof where.lat === "number" && typeof where.lon === "number") out.location = { lat: where.lat, lon: where.lon };
    if (typeof raw.file === "string") {
      const match = /^data:((image|audio)\/[a-z0-9.+-]+)(?:;[^,]*)?;base64,(.+)$/s.exec(raw.file);
      const ext = match ? EXT[match[1]!] : undefined;
      if (match && ext) {
        const path = join(this.options.filesDir, `${card.job_id}-${card.round}-${randomUUID()}${ext}`);
        writeFileSync(path, Buffer.from(match[3]!, "base64"), { flag: "wx" });
        out.file = { path, kind: match[2] === "image" ? "photo" : "audio", captured: raw.fresh === true ? "live" : "upload" };
      }
    }
    return out;
  }
}
