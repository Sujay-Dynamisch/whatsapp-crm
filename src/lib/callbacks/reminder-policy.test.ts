import { describe, expect, it } from 'vitest';

import { DEFAULT_POLICY, afterReminder, inReminderWindow } from './followups';

describe('inReminderWindow (Asia/Kolkata)', () => {
  it('Mon 10:00 IST is inside; 22:00 and Sunday are outside', () => {
    expect(inReminderWindow(new Date('2026-11-09T04:30:00Z'), DEFAULT_POLICY)).toBe(true); // Mon 10:00 IST
    expect(inReminderWindow(new Date('2026-11-09T16:30:00Z'), DEFAULT_POLICY)).toBe(false); // Mon 22:00 IST
    expect(inReminderWindow(new Date('2026-11-15T04:30:00Z'), DEFAULT_POLICY)).toBe(false); // Sun
  });
});

describe('afterReminder', () => {
  const now = new Date('2026-11-09T05:00:00Z');
  it('repeats until the max, escalates once at the max, then stops', () => {
    expect(afterReminder(1, 'high', DEFAULT_POLICY, now)).toEqual({ next: new Date(now.getTime() + 30 * 60_000), escalate: false });
    expect(afterReminder(3, 'high', DEFAULT_POLICY, now)).toEqual({ next: null, escalate: true });
  });
  it('repeat-until-handled keeps going after the max', () => {
    const p = { ...DEFAULT_POLICY, repeat_until_handled: true };
    expect(afterReminder(4, 'high', p, now)).toEqual({ next: new Date(now.getTime() + 30 * 60_000), escalate: false });
  });
  it('no escalation when switched off', () => {
    expect(afterReminder(1, 'normal', { ...DEFAULT_POLICY, escalate_to: 'none' }, now).escalate).toBe(false);
  });
});
