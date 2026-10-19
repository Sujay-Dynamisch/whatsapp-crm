import { describe, expect, it } from 'vitest';

import {
  bestHourUtc,
  computeEngagement,
  engagementScore,
  engagementTier,
  passesEngagementFilter,
  personalSendTime,
} from './engagement';

const NOW = new Date('2026-10-11T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const hours = (counts: Record<number, number>) =>
  Array.from({ length: 24 }, (_, h) => counts[h] ?? 0);

describe('engagementScore', () => {
  it('starts an unknown contact at 50 (warm)', () => {
    expect(engagementScore({}, NOW)).toBe(50);
    expect(engagementTier(50)).toBe('warm');
  });

  it('rewards recent replies/clicks most, then reads', () => {
    expect(engagementScore({ last_engaged_at: daysAgo(2) }, NOW)).toBe(95);
    expect(engagementScore({ last_engaged_at: daysAgo(20) }, NOW)).toBe(85);
    expect(engagementScore({ last_engaged_at: daysAgo(60) }, NOW)).toBe(70);
    expect(engagementScore({ last_engaged_at: daysAgo(200) }, NOW)).toBe(50);
    expect(engagementScore({ last_read_at: daysAgo(3) }, NOW)).toBe(75);
    expect(engagementScore({ last_read_at: daysAgo(40) }, NOW)).toBe(65);
  });

  it('caps at 100', () => {
    expect(engagementScore({ last_engaged_at: daysAgo(1), last_read_at: daysAgo(1) }, NOW)).toBe(100);
  });

  it('penalises unread streaks (max −40) and Meta limits', () => {
    expect(engagementScore({ unread_streak: 2 }, NOW)).toBe(34);
    expect(engagementScore({ unread_streak: 50 }, NOW)).toBe(10);
    expect(engagementScore({ last_meta_limited_at: daysAgo(3) }, NOW)).toBe(20);
    expect(engagementScore({ last_meta_limited_at: daysAgo(20) }, NOW)).toBe(35);
    expect(engagementScore({ last_meta_limited_at: daysAgo(90) }, NOW)).toBe(50);
  });

  it('never goes below 0', () => {
    expect(engagementScore({ unread_streak: 9, last_meta_limited_at: daysAgo(1) }, NOW)).toBe(0);
  });
});

describe('computeEngagement — resting', () => {
  it('rests a contact Meta limited within the rest window', () => {
    const e = computeEngagement({ last_meta_limited_at: daysAgo(3) }, { restDays: 7, restAfterUnread: 5 }, NOW);
    expect(e).toMatchObject({ resting: true, restReason: 'meta_limited' });
    expect(
      computeEngagement({ last_meta_limited_at: daysAgo(10) }, { restDays: 7, restAfterUnread: 5 }, NOW).resting
    ).toBe(false);
  });

  it('rests a contact after N unread broadcasts in a row', () => {
    expect(computeEngagement({ unread_streak: 5 }, { restDays: 7, restAfterUnread: 5 }, NOW)).toMatchObject({
      resting: true,
      restReason: 'unread_streak',
    });
    expect(computeEngagement({ unread_streak: 4 }, { restDays: 7, restAfterUnread: 5 }, NOW).resting).toBe(false);
  });
});

describe('passesEngagementFilter', () => {
  const engaged = computeEngagement({ last_engaged_at: daysAgo(1) }, undefined, NOW);
  const warm = computeEngagement({}, undefined, NOW);
  const cold = computeEngagement({ unread_streak: 4 }, undefined, NOW);
  const resting = computeEngagement({ last_engaged_at: daysAgo(1), last_meta_limited_at: daysAgo(1) }, undefined, NOW);

  it.each([
    ['all', [true, true, true, true]],
    ['skip_resting', [true, true, true, false]],
    ['warm_and_engaged', [true, true, false, false]],
    ['engaged', [true, false, false, false]],
  ] as const)('%s', (filter, expected) => {
    expect([engaged, warm, cold, resting].map((e) => passesEngagementFilter(e, filter))).toEqual(expected);
  });
});

describe('bestHourUtc', () => {
  it('needs a few samples before trusting a pattern', () => {
    expect(bestHourUtc(hours({ 9: 2 }))).toBeNull();
    expect(bestHourUtc(hours({ 9: 2, 14: 1 }))).toBe(9);
  });

  it('rejects malformed histograms', () => {
    expect(bestHourUtc(null)).toBeNull();
    expect(bestHourUtc([1, 2, 3])).toBeNull();
  });
});

describe('personalSendTime', () => {
  const base = new Date('2026-10-11T10:30:00Z');

  it('falls back to the base time without a pattern', () => {
    expect(personalSendTime(base, null)).toEqual(base);
  });

  it('uses the best hour later today', () => {
    const t = personalSendTime(base, 15, 'c1');
    expect(t.getUTCDate()).toBe(11);
    expect(t.getUTCHours()).toBe(15);
  });

  it('rolls an already-passed hour to tomorrow (always within 24h)', () => {
    const t = personalSendTime(base, 8, 'c1');
    expect(t.getUTCDate()).toBe(12);
    expect(t.getUTCHours()).toBe(8);
    expect(t.getTime() - base.getTime()).toBeLessThan(24 * 3600_000);
  });

  it('never returns a time before the base', () => {
    for (const key of ['a', 'b', 'c', 'd', 'e']) {
      expect(personalSendTime(base, 10, key).getTime()).toBeGreaterThanOrEqual(base.getTime());
    }
  });

  it('spreads contacts sharing a best hour across the hour, deterministically', () => {
    const times = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map((k) => personalSendTime(base, 15, k).getTime()));
    expect(times.size).toBeGreaterThan(1);
    expect(personalSendTime(base, 15, 'a')).toEqual(personalSendTime(base, 15, 'a'));
  });
});
