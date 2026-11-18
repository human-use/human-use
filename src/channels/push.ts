import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateVAPIDKeys, sendNotification, type PushSubscription, type RequestOptions } from "web-push";
import type { Card } from "../runtime.js";

const subject = "https://humanuse.dev";
const signal = "A card is ready.";
const keyPattern = /^[A-Za-z0-9_-]+$/;

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function writeJson(path: string, value: unknown): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function validatedSubscription(value: unknown): PushSubscription | null {
  if (!value || typeof value !== "object") return null;
  const { endpoint, keys } = value as Partial<PushSubscription>;
  if (typeof endpoint !== "string" || endpoint.length > 4096 || typeof keys?.auth !== "string" || typeof keys.p256dh !== "string") return null;
  if (keys.auth.length !== 22 || keys.p256dh.length !== 87 || !keyPattern.test(keys.auth) || !keyPattern.test(keys.p256dh)) return null;
  try {
    const url = new URL(endpoint);
    // The phone can only direct outbound notification requests to push services.
    const provider = url.hostname === "fcm.googleapis.com" || url.hostname.endsWith(".push.apple.com");
    if (url.protocol !== "https:" || !provider || url.username || url.password || url.port || url.hash) return null;
    return { endpoint: url.href, keys: { auth: keys.auth, p256dh: keys.p256dh } };
  } catch {
    return null;
  }
}

export type SendPush = (subscription: PushSubscription, payload: string, options: RequestOptions) => Promise<unknown>;

export class PhonePush {
  private readonly keys;
  private readonly subscriptionPath: string;
  private subscription: PushSubscription | null;

  /** The signing keys are the runtime's; the subscription is one unit's phone. */
  constructor(keysDir: string, subscriptionDir: string, private readonly send: SendPush = sendNotification) {
    const path = join(keysDir, "push-vapid.json");
    const saved = readJson(path) as ReturnType<typeof generateVAPIDKeys> | null;
    this.keys = saved ?? generateVAPIDKeys();
    if (!saved) writeJson(path, this.keys);
    this.subscriptionPath = join(subscriptionDir, "push-subscription.json");
    this.subscription = validatedSubscription(readJson(this.subscriptionPath));
  }

  get publicKey(): string { return this.keys.publicKey; }

  subscribe(raw: unknown): boolean {
    const subscription = validatedSubscription(raw);
    if (!subscription) return false;
    writeJson(this.subscriptionPath, subscription);
    this.subscription = subscription;
    return true;
  }

  /** Forget the phone that subscribed. It subscribes again once it pairs with the new link. */
  clear(): void {
    rmSync(this.subscriptionPath, { force: true });
    this.subscription = null;
  }

  async notify(card: Card): Promise<void> {
    const subscription = this.subscription;
    if (!subscription || card.priority === "opportunistic") return;
    try {
      await this.send(subscription, signal, {
        vapidDetails: { subject, ...this.keys },
        TTL: 120,
        urgency: card.priority === "preempt" ? "high" : "normal",
        topic: "human-use-card",
        timeout: 7000
      });
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if ((status === 404 || status === 410) && this.subscription === subscription) {
        rmSync(this.subscriptionPath, { force: true });
        this.subscription = null;
      }
      console.error(`[human-use] push delivery failed${status ? ` (HTTP ${status})` : ""}`);
    }
  }
}
