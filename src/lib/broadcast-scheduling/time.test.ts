import { describe, expect, it } from 'vitest';

import {
  computeArmTime,
  isValidTimeZone,
  schedulerCron,
  utcToZonedLocal,
  zonedLocalToUtc,
} from './time';

describe('zonedLocalToUtc', () => {
  it('reads wall-clock time in Asia/Kolkata (UTC+05:30)', () => {
    expect(zonedLocalToUtc('2026-10-05T09:30', 'Asia/Kolkata').toISOString()).toBe(
      '2026-10-05T04:00:00.000Z'
    );
  });

  it('honours DST in the target zone, not the server zone', () => {
    // New York is EDT (UTC-4) in July and EST (UTC-5) in January.
    expect(zonedLocalToUtc('2026-07-01T09:00', 'America/New_York').toISOString()).toBe(
      '2026-07-01T13:00:00.000Z'
    );
    expect(zonedLocalToUtc('2026-01-15T09:00', 'America/New_York').toISOString()).toBe(
      '2026-01-15T14:00:00.000Z'
    );
  });

  it('moves a non-existent spring-forward time forward by the gap', () => {
    // 2026-03-08 02:30 does not exist in New York; 03:30 EDT does.
    expect(zonedLocalToUtc('2026-03-08T02:30', 'America/New_York').toISOString()).toBe(
      '2026-03-08T07:30:00.000Z'
    );
  });

  it('round-trips with utcToZonedLocal', () => {
    for (const tz of ['Asia/Kolkata', 'Europe/London', 'America/Sao_Paulo', 'UTC']) {
      const local = '2026-11-20T18:45';
      expect(utcToZonedLocal(zonedLocalToUtc(local, tz), tz)).toBe(local);
    }
  });

  it('rejects malformed input and unknown zones', () => {
    expect(() => zonedLocalToUtc('05/10/2026 09:30', 'Asia/Kolkata')).toThrow(RangeError);
    expect(() => zonedLocalToUtc('2026-10-05T09:30', 'Mars/Olympus')).toThrow(RangeError);
  });
});

describe('isValidTimeZone', () => {
  it('accepts IANA names and rejects garbage', () => {
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });
});

describe('computeArmTime + schedulerCron', () => {
  it('fires two minutes early, floored to the minute', () => {
    const at = new Date('2026-10-05T04:00:45.000Z'); // 09:30:45 IST
    const arm = computeArmTime(at, 120_000);
    expect(arm.toISOString()).toBe('2026-10-05T03:58:00.000Z');
    expect(schedulerCron(arm, 'Asia/Kolkata')).toBe('28 9 5 10 *');
  });

  it('writes the cron in the job time zone', () => {
    const arm = new Date('2026-12-31T23:58:00.000Z');
    expect(schedulerCron(arm, 'UTC')).toBe('58 23 31 12 *');
    // Already New Year's Day in Kolkata.
    expect(schedulerCron(arm, 'Asia/Kolkata')).toBe('28 5 1 1 *');
  });
});
