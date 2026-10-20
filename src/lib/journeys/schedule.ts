// ============================================================
// Schedule trigger timing (migration 054). Pure.
//
//   interval  every N minutes / hours (at least MIN_SCHEDULE_MINUTES)
//   daily     at HH:MM local time
//   weekly    at HH:MM local time on the chosen weekdays
//
// Local time is evaluated in the trigger's IANA timezone with Intl, so
// DST changes land on the right wall-clock time.
// ============================================================

import { isValidTimezone, MIN_SCHEDULE_MINUTES, type ScheduleConfig } from './graph';

interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function localParts(date: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    weekday: WEEKDAYS.indexOf(get('weekday')),
  };
}

/** Milliseconds the zone is ahead of UTC at `date`. */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const p = localParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return asUtc - Math.floor(date.getTime() / 60_000) * 60_000;
}

/** The UTC instant of a local wall-clock time in `timeZone`. */
function zonedTime(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let utc = guess - zoneOffsetMs(new Date(guess), timeZone);
  // Second pass corrects a guess that fell on the other side of a DST change.
  utc = guess - zoneOffsetMs(new Date(utc), timeZone);
  return new Date(utc);
}

/** Next run strictly after `after`, or null for an unusable config. */
export function nextScheduleTime(cfg: Partial<ScheduleConfig>, after: Date): Date | null {
  if (cfg.mode === 'interval') {
    const every = Number(cfg.every);
    if (!Number.isInteger(every) || every < 1) return null;
    const minutes = Math.max(MIN_SCHEDULE_MINUTES, cfg.unit === 'hours' ? every * 60 : every);
    return new Date(after.getTime() + minutes * 60_000);
  }
  if (cfg.mode !== 'daily' && cfg.mode !== 'weekly') return null;

  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(cfg.time ?? '');
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  const tz = cfg.timezone && isValidTimezone(cfg.timezone) ? cfg.timezone : 'UTC';
  const days = cfg.mode === 'weekly' ? new Set((cfg.days ?? []).filter((d) => d >= 0 && d <= 6)) : null;
  if (days && days.size === 0) return null;

  const today = localParts(after, tz);
  for (let offset = 0; offset <= 8; offset++) {
    // Calendar arithmetic on a UTC date — only y/m/d are used from it.
    const d = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    if (days && !days.has(d.getUTCDay())) continue;
    const at = zonedTime(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hour, minute, tz);
    if (at.getTime() > after.getTime()) return at;
  }
  return null;
}
