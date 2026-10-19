// ============================================================
// Contact engagement model (migration 048, feature 'smart_sending').
//
// The database keeps raw signals per contact (trigger-maintained);
// this module turns them into a score, a tier, a "resting" decision
// and a best hour to send. Pure functions — used by the broadcast
// wizard (browser), the contacts UI and the workers alike, so every
// surface agrees.
//
// Score (0–100), explainable on purpose:
//   start                              50   (unknown ≈ warm)
//   replied / clicked / messaged us    +45 ≤7d · +35 ≤30d · +20 ≤90d
//   read a broadcast                   +25 ≤14d · +15 ≤60d
//   unread broadcasts in a row         −8 each (max −40)
//   Meta-limited (131049)              −30 ≤7d · −15 ≤30d
// Tiers: engaged ≥ 60 · warm 30–59 · cold < 30
// ============================================================

export interface EngagementSignals {
  last_engaged_at?: string | null;
  last_read_at?: string | null;
  unread_streak?: number | null;
  last_meta_limited_at?: string | null;
  activity_hours?: number[] | null;
}

export interface RestPolicy {
  /** Rest a contact this many days after Meta limited them. */
  restDays: number;
  /** Rest a contact after this many unread broadcasts in a row. */
  restAfterUnread: number;
}

export const DEFAULT_REST_POLICY: RestPolicy = { restDays: 7, restAfterUnread: 5 };

export type EngagementTier = 'engaged' | 'warm' | 'cold';

export interface Engagement {
  score: number;
  tier: EngagementTier;
  resting: boolean;
  restReason: 'meta_limited' | 'unread_streak' | null;
  /** UTC hour (0–23) this contact is most active, or null without enough data. */
  bestHourUtc: number | null;
}

const DAY = 24 * 60 * 60 * 1000;

function ageDays(iso: string | null | undefined, now: Date): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : (now.getTime() - t) / DAY;
}

export function engagementScore(s: EngagementSignals, now: Date = new Date()): number {
  let score = 50;

  const engaged = ageDays(s.last_engaged_at, now);
  if (engaged !== null) score += engaged <= 7 ? 45 : engaged <= 30 ? 35 : engaged <= 90 ? 20 : 0;

  const read = ageDays(s.last_read_at, now);
  if (read !== null) score += read <= 14 ? 25 : read <= 60 ? 15 : 0;

  score -= Math.min(40, 8 * Math.max(0, s.unread_streak ?? 0));

  const limited = ageDays(s.last_meta_limited_at, now);
  if (limited !== null) score -= limited <= 7 ? 30 : limited <= 30 ? 15 : 0;

  return Math.max(0, Math.min(100, Math.round(score)));
}

export function engagementTier(score: number): EngagementTier {
  return score >= 60 ? 'engaged' : score >= 30 ? 'warm' : 'cold';
}

/** Minimum reads + inbound messages before we trust an hour pattern. */
export const MIN_ACTIVITY_SAMPLES = 3;

export function bestHourUtc(hours: number[] | null | undefined): number | null {
  if (!Array.isArray(hours) || hours.length !== 24) return null;
  const total = hours.reduce((a, b) => a + (b > 0 ? b : 0), 0);
  if (total < MIN_ACTIVITY_SAMPLES) return null;
  let best = 0;
  for (let h = 1; h < 24; h++) if (hours[h] > hours[best]) best = h;
  return best;
}

export function computeEngagement(
  s: EngagementSignals,
  policy: RestPolicy = DEFAULT_REST_POLICY,
  now: Date = new Date()
): Engagement {
  const score = engagementScore(s, now);
  const limited = ageDays(s.last_meta_limited_at, now);
  const restReason =
    limited !== null && limited <= policy.restDays
      ? 'meta_limited'
      : (s.unread_streak ?? 0) >= policy.restAfterUnread
        ? 'unread_streak'
        : null;
  return {
    score,
    tier: engagementTier(score),
    resting: restReason !== null,
    restReason,
    bestHourUtc: bestHourUtc(s.activity_hours),
  };
}

// ------------------------------------------------------------------
// Audience filtering
// ------------------------------------------------------------------

export type EngagementFilter =
  /** Everyone (no filtering). */
  | 'all'
  /** Everyone except contacts currently resting. */
  | 'skip_resting'
  /** Engaged + warm, not resting. */
  | 'warm_and_engaged'
  /** Engaged only, not resting. */
  | 'engaged';

export const ENGAGEMENT_FILTERS: EngagementFilter[] = [
  'all',
  'skip_resting',
  'warm_and_engaged',
  'engaged',
];

export function passesEngagementFilter(
  e: Engagement,
  filter: EngagementFilter
): boolean {
  if (filter === 'all') return true;
  if (e.resting) return false;
  if (filter === 'skip_resting') return true;
  if (filter === 'engaged') return e.tier === 'engaged';
  return e.tier !== 'cold';
}

// ------------------------------------------------------------------
// Smart timing
// ------------------------------------------------------------------

/**
 * The first moment at or after `base` (and within 24h of it) that falls
 * in the contact's best UTC hour, or `base` itself when there's no
 * pattern. Minutes are spread deterministically across the hour so a
 * thousand contacts with the same best hour don't all fire at :00.
 */
export function personalSendTime(base: Date, bestHour: number | null, spreadKey = ''): Date {
  if (bestHour === null) return base;
  const start = new Date(base);
  start.setUTCMinutes(0, 0, 0);
  start.setUTCHours(bestHour);
  if (start.getTime() < base.getTime() - 60 * 60 * 1000 + 1) {
    // That hour has fully passed today → tomorrow.
    start.setUTCDate(start.getUTCDate() + 1);
  }
  let hash = 0;
  for (let i = 0; i < spreadKey.length; i++) hash = (hash * 31 + spreadKey.charCodeAt(i)) >>> 0;
  const t = new Date(start.getTime() + (hash % 55) * 60_000);
  return t < base ? base : t;
}

/** Default audience filter when smart sending is on and nothing was chosen. */
export const DEFAULT_ENGAGEMENT_FILTER: EngagementFilter = 'skip_resting';
