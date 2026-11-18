/** Time helpers. The runtime never calls Date.now() directly: a Clock is injected so simulations can run months in seconds. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

/** "90s", "30m", "2h", "1d", "1w", or a bare number of seconds. */
export function parseDuration(text: string | number): number {
  if (typeof text === "number") return text;
  const match = /^(\d+(?:\.\d+)?)\s*([smhdw])?$/.exec(text.trim());
  if (!match) throw new RangeError(`Bad duration "${text}". Use 30m, 2h, 1d, 1w.`);
  return Math.round(Number(match[1]) * UNITS[match[2] ?? "s"]!);
}

/** An ISO timestamp, or a duration counted from now ("2h"). */
export function resolveTime(text: string, clock: Clock): string {
  if (/^\d+(?:\.\d+)?\s*[smhdw]?$/.test(text.trim())) return addSeconds(clock.now(), parseDuration(text)).toISOString();
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new RangeError(`Bad time "${text}". Use ISO 8601 or a duration like 2h.`);
  return date.toISOString();
}

export const addSeconds = (date: Date, seconds: number) => new Date(date.getTime() + seconds * 1000);

/** Next local 09:00 strictly after `date`. Where stalled goals get woken. */
export function nextMorning(date: Date, hour = 9): Date {
  const next = new Date(date);
  next.setHours(hour, 0, 0, 0);
  if (next <= date) next.setDate(next.getDate() + 1);
  return next;
}

export const monthStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), 1).toISOString();
