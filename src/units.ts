import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { PhoneChannel, type PhoneOptions } from "./channels/phone.js";
import { PhonePush, type SendPush } from "./channels/push.js";
import { RelayChannel } from "./channels/relay.js";
import type { WebChannel } from "./channels/web.js";
import { HumanUseError, type Card, type CardReport, type Channel, type JobData, type Runtime, type Unit } from "./runtime.js";
import type { Store } from "./store.js";

/** What the lead page and `human-use pair` show for one unit. */
export interface UnitPairing {
  unit: string;
  urls: string[];
  code?: string;
  relay_url?: string | null;
  relay_connected?: boolean;
}

/** One unit's phone, reachable on the LAN page, through the relay, or both. */
interface UnitLink {
  unit: Unit;
  dir: string;
  phone: PhoneChannel;
  push: PhonePush | null;
  relay: RelayChannel | null;
}

export interface UnitLinksOptions {
  runtime: Runtime;
  store: Store;
  /** The runtime's state directory; each unit keeps its files under units/<id>/. */
  stateDir: string;
  filesDir: string;
  web: WebChannel | null;
  /** HTTPS relay origin, or null for LAN only. */
  relay: string | null;
  pushSend?: SendPush | undefined;
  /** Who reads the unit's answers and photos: the current driver, told to the phone before its first photo. */
  routing?: (() => { reader: string; local: boolean }) | undefined;
}

export const unitDir = (stateDir: string, unit: string) => join(stateDir, "units", unit);

/**
 * Every unit's phone link, and the channel the runtime shows cards on: each card goes to the phone of the unit its
 * job belongs to. Renewing one unit's pairing retires only that unit's link and push subscription.
 */
export class UnitLinks implements Channel {
  private readonly links = new Map<string, UnitLink>();
  private started = false;

  constructor(private readonly options: UnitLinksOptions) {}

  /** Whether units' phones can reach this runtime through the relay. */
  get remote(): boolean { return this.options.relay !== null; }

  /** Whether any phone can reach this runtime at all. */
  get enabled(): boolean { return this.options.web !== null || this.options.relay !== null; }

  /** Open this unit's phone link. Called for every unit at start and for each unit the lead adds. */
  attach(unit: Unit): void {
    if (this.links.has(unit.id)) return;
    const { runtime, store, stateDir, web } = this.options;
    const dir = unitDir(stateDir, unit.id);
    mkdirSync(dir, { recursive: true });
    const push = this.options.relay ? new PhonePush(stateDir, dir, this.options.pushSend) : null;
    const phoneOptions: PhoneOptions = {
      name: unit.name,
      filesDir: this.options.filesDir,
      answer: (jobId, answer) => runtime.answer(jobId, answer),
      ...(this.options.routing ? { routing: this.options.routing } : {}),
      counts: () => ({
        queued: store.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued' AND unit_id = ?", unit.id)!.n,
        review: store.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE status = 'review' AND tool <> 'goal_check' AND unit_id = ?", unit.id)!.n,
        held: store.get<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'review' AND tool <> 'goal_check' AND unit_id = ?
          AND json_extract(data, '$.held') IS NOT NULL AND json_extract(data, '$.held.confirm') IS NULL`, unit.id)!.n
      }),
      photoChecks: () => {
        const reader = this.options.routing?.().reader;
        return store.all<{ id: string; data: string }>(`SELECT id, data FROM jobs WHERE status = 'review' AND unit_id = ?
          AND json_extract(data, '$.held.confirm') = ? ORDER BY updated_at`, unit.id, reader ?? "").map(row => {
          const data = JSON.parse(row.data) as JobData;
          const from = data.rounds.flatMap(round => round.answer?.file?.kind === "photo" ? [round.answer.file.reader ?? null] : []).at(-1) ?? null;
          return { job_id: row.id, task: runtime.view(row.id).task, from, to: data.held!.confirm! };
        });
      },
      confirmPhoto: (jobId, reader, send) => {
        if (store.get<{ unit_id: string | null }>("SELECT unit_id FROM jobs WHERE id = ?", jobId)?.unit_id !== unit.id) {
          throw new HumanUseError("HRT-4004", `NO_SUCH_JOB ${jobId}`);
        }
        runtime.confirmPhoto(jobId, reader, send);
      },
      ...(push ? { onCard: (card: Card) => {
        void push.notify(card).catch(() => console.error("[human-use] could not save expired push registration"));
      } } : {}),
      // The person unpaired on the phone. Every link that phone held stops working; the lead pairs it again with a new one.
      unpair: async () => {
        store.event(new Date().toISOString(), "unit_unpaired", unit.id, null, { name: unit.name });
        await this.renew(unit.id);
      }
    };
    const phone = new PhoneChannel(phoneOptions);
    web?.attach(unit.id, phone, join(dir, "web-token"));
    const relay = this.options.relay && push ? new RelayChannel(this.options.relay, join(dir, "relay-pairing.json"), phone, push) : null;
    this.links.set(unit.id, { unit, dir, phone, push, relay });
    if (this.started) relay?.start();
  }

  start(): void {
    this.started = true;
    for (const link of this.links.values()) link.relay?.start();
  }

  stop(): void {
    for (const link of this.links.values()) link.relay?.stop();
  }

  pairing(unit: string): UnitPairing {
    const link = this.link(unit);
    const remote = link.relay?.pairing();
    return {
      unit: link.unit.name,
      ...(this.options.web?.pairing(unit) ?? { urls: [] }),
      ...(remote ? { relay_url: remote.url, relay_connected: remote.connected } : {})
    };
  }

  /** A new phone link and LAN token for this unit. Its phone has to pair again; other units are untouched. */
  async renew(unit: string): Promise<UnitPairing & { retired: boolean }> {
    const link = this.link(unit);
    this.options.web?.renew(unit);
    link.push?.clear();
    const retired = link.relay ? await link.relay.renew() : true;
    return { ...this.pairing(unit), retired };
  }

  /** The phone that answers for this unit. */
  phone(unit: string): PhoneChannel {
    return this.link(unit).phone;
  }

  private link(unit: string): UnitLink {
    const link = this.links.get(unit);
    if (!link) throw new Error(`no phone link for unit ${unit}`);
    return link;
  }

  /** A job without a unit (one made before units existed) goes to the only unit there is. */
  private route(unit: string | null): UnitLink | undefined {
    if (unit) return this.links.get(unit);
    return this.links.size === 1 ? this.links.values().next().value : undefined;
  }

  // ------------------------------------------------------------ Channel

  show(card: Card, restored = false): void {
    this.route(card.unit)?.phone.show(card, restored);
  }

  withdraw(jobId: string, reason: string, unit: string | null): void {
    this.route(unit)?.phone.withdraw(jobId, reason);
  }

  report(report: CardReport): void {
    this.route(report.unit)?.phone.report(report);
  }

  seen(unit: string): number | null {
    return this.links.get(unit)?.phone.lastSeenAt ?? null;
  }
}

const LEGACY_FILES = ["relay-pairing.json", "web-token", "push-subscription.json"];

/**
 * A runtime from before units had one phone, its link files in the state directory and no unit on its jobs. It
 * becomes one unit named default, with those files moved under its directory, so the phone it had keeps working.
 */
export function migrateLegacyUnit(runtime: Runtime, store: Store, stateDir: string): Unit | null {
  if (runtime.units().length) return null;
  const legacyFiles = LEGACY_FILES.filter(file => existsSync(join(stateDir, file)));
  const legacyDir = unitDir(stateDir, "default");
  const legacyJobs = store.get("SELECT 1 FROM jobs WHERE unit_id IS NULL AND tool <> 'goal_check' LIMIT 1");
  if (!legacyFiles.length && !legacyJobs && !existsSync(legacyDir)) return null;
  const unit = runtime.addUnit("default");
  const dir = unitDir(stateDir, unit.id);
  if (existsSync(legacyDir)) renameSync(legacyDir, dir);
  mkdirSync(dir, { recursive: true });
  for (const file of legacyFiles) renameSync(join(stateDir, file), join(dir, file));
  store.run("UPDATE jobs SET unit_id = ? WHERE unit_id IS NULL AND tool <> 'goal_check'", unit.id);
  store.run("UPDATE schedules SET data = json_set(data, '$.call.unit', ?) WHERE json_extract(data, '$.call.unit') IS NULL", unit.id);
  return unit;
}
