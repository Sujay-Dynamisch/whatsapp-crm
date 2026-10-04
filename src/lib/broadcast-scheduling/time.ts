// ============================================================
// Time-zone helpers for scheduled broadcasts.
//
// `scheduled_at` is always stored as an absolute instant (timestamptz).
// The zone only matters at the edges: turning the user's wall-clock
// input into that instant, and writing the Cloud Scheduler cron, which
// is evaluated in a zone of its own.
//
// Pure Intl — no tz database dependency, so the same code runs in the
// Next.js server and inside the Cloud Function bundle.
// ============================================================

export const DEFAULT_BROADCAST_TIMEZONE = 'Asia/Kolkata';

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatterCache.set(tz, f);
  }
  return f;
}

/** Wall-clock fields of `date` as seen in `tz`. */
export function zonedParts(date: Date, tz: string): ZonedParts {
  const out: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour,
    minute: out.minute,
    second: out.second,
  };
}

/** Offset of `tz` from UTC at instant `date`, in ms (IST → +19 800 000). */
function offsetMs(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Interpret a `datetime-local` style string ("2026-10-05T09:30") as a
 * wall-clock time in `tz` and return the absolute instant.
 *
 * Two offset passes settle DST transitions. A wall time that doesn't
 * exist (inside a spring-forward gap) is moved forward by the gap —
 * 02:30 on the US spring-forward night becomes 03:30 — which is what
 * calendar apps do. An ambiguous fall-back time resolves to one of its
 * two instants.
 */
export function zonedLocalToUtc(local: string, tz: string): Date {
  const m = LOCAL_RE.exec(local.trim());
  if (!m) {
    throw new RangeError(`Expected YYYY-MM-DDTHH:mm, got "${local}"`);
  }
  if (!isValidTimeZone(tz)) {
    throw new RangeError(`Unknown time zone "${tz}"`);
  }
  const [, y, mo, d, h, mi, s] = m;
  const asUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, s ? +s : 0);
  const first = asUtc - offsetMs(new Date(asUtc), tz);
  const second = asUtc - offsetMs(new Date(first), tz);

  const matches = (t: number) => {
    const p = zonedParts(new Date(t), tz);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) === asUtc;
  };
  if (matches(second)) return new Date(second);
  if (matches(first)) return new Date(first);
  // Inside a gap: neither candidate round-trips. The later one is the
  // wall time shifted forward by the gap.
  return new Date(Math.max(first, second));
}

/** "2026-10-05T09:30" for `date` in `tz` — the inverse of zonedLocalToUtc. */
export function utcToZonedLocal(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * When the Cloud Scheduler job should fire: `leadMs` before the send,
 * floored to the minute (cron has minute resolution). Flooring means
 * the job is never late — the Cloud Task it creates carries the exact
 * second.
 */
export function computeArmTime(scheduledAt: Date, leadMs: number): Date {
  const t = scheduledAt.getTime() - leadMs;
  return new Date(Math.floor(t / 60_000) * 60_000);
}

/**
 * A cron expression matching exactly one minute a year — `armAt` as
 * seen in `tz`. Cloud Scheduler has no one-shot jobs; the arm function
 * deletes the job after it fires, and a job that somehow survives is a
 * no-op next year because its version is stale.
 */
export function schedulerCron(armAt: Date, tz: string): string {
  const p = zonedParts(armAt, tz);
  return `${p.minute} ${p.hour} ${p.day} ${p.month} *`;
}
