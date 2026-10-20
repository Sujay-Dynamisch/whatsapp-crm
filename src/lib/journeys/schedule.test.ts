import { describe, expect, it } from 'vitest';

import { nextScheduleTime } from './schedule';

describe('nextScheduleTime', () => {
  const at = new Date('2026-10-20T06:00:00Z'); // Tue 11:30 in Kolkata

  it('intervals, with a 5-minute floor', () => {
    expect(nextScheduleTime({ mode: 'interval', every: 2, unit: 'hours' }, at)?.toISOString()).toBe('2026-10-20T08:00:00.000Z');
    expect(nextScheduleTime({ mode: 'interval', every: 1, unit: 'minutes' }, at)?.toISOString()).toBe('2026-10-20T06:05:00.000Z');
    expect(nextScheduleTime({ mode: 'interval', every: 0, unit: 'minutes' }, at)).toBeNull();
  });

  it('daily in the trigger timezone', () => {
    // 10:00 IST already passed today → tomorrow 04:30Z.
    expect(nextScheduleTime({ mode: 'daily', time: '10:00', timezone: 'Asia/Kolkata' }, at)?.toISOString()).toBe(
      '2026-10-21T04:30:00.000Z'
    );
    expect(nextScheduleTime({ mode: 'daily', time: '18:00', timezone: 'Asia/Kolkata' }, at)?.toISOString()).toBe(
      '2026-10-20T12:30:00.000Z'
    );
  });

  it('weekly on chosen days', () => {
    // Next Friday (5) at 09:00 IST.
    expect(nextScheduleTime({ mode: 'weekly', time: '09:00', days: [5], timezone: 'Asia/Kolkata' }, at)?.toISOString()).toBe(
      '2026-10-23T03:30:00.000Z'
    );
    expect(nextScheduleTime({ mode: 'weekly', time: '09:00', days: [], timezone: 'UTC' }, at)).toBeNull();
  });

  it('keeps wall-clock time across a DST change', () => {
    // New York leaves DST on 2026-11-01: 09:00 is 13:00Z before, 14:00Z after.
    const before = new Date('2026-10-31T15:00:00Z');
    expect(nextScheduleTime({ mode: 'daily', time: '09:00', timezone: 'America/New_York' }, before)?.toISOString()).toBe(
      '2026-11-01T14:00:00.000Z'
    );
  });

  it('rejects a bad time', () => {
    expect(nextScheduleTime({ mode: 'daily', time: '25:00' }, at)).toBeNull();
  });
});
