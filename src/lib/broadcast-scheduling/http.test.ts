import { describe, expect, it } from 'vitest';

import { parseScheduleBody } from './http';
import { ScheduleError } from './schedule';

describe('parseScheduleBody', () => {
  it('defaults the zone to Asia/Kolkata for wall-clock input', () => {
    const r = parseScheduleBody({ local_datetime: '2026-10-05T09:30' });
    expect(r.timezone).toBe('Asia/Kolkata');
    expect(r.scheduledAt.toISOString()).toBe('2026-10-05T04:00:00.000Z');
  });

  it('uses a supplied zone', () => {
    const r = parseScheduleBody({ local_datetime: '2026-10-05T09:30', timezone: 'Europe/London' });
    expect(r.scheduledAt.toISOString()).toBe('2026-10-05T08:30:00.000Z');
  });

  it('accepts an absolute instant with an offset', () => {
    const r = parseScheduleBody({ scheduled_at: '2026-10-05T09:30:00+05:30' });
    expect(r.scheduledAt.toISOString()).toBe('2026-10-05T04:00:00.000Z');
  });

  it('rejects an instant without an offset (would be read in the server zone)', () => {
    expect(() => parseScheduleBody({ scheduled_at: '2026-10-05T09:30:00' })).toThrow(ScheduleError);
  });

  it('rejects unknown zones and empty bodies', () => {
    expect(() => parseScheduleBody({ local_datetime: '2026-10-05T09:30', timezone: 'X/Y' })).toThrow(
      ScheduleError
    );
    expect(() => parseScheduleBody({})).toThrow(ScheduleError);
  });
});
