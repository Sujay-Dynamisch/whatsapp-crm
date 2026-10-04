import { describe, expect, it } from 'vitest';

import { cloudTaskId, schedulerJobId, shortName } from './ids';

const ID = '3f1c2b9e-7a44-4d0e-9a51-2c6b8d0e1f23';

describe('deterministic trigger ids', () => {
  it('is stable for the same broadcast + version (dedupes retries)', () => {
    expect(schedulerJobId(ID, 3)).toBe(schedulerJobId(ID, 3));
    expect(cloudTaskId(ID, 3, 0)).toBe(cloudTaskId(ID, 3, 0));
  });

  it('changes with version, pass and suffix (reschedules never collide with tombstones)', () => {
    const ids = new Set([
      cloudTaskId(ID, 1, 0),
      cloudTaskId(ID, 2, 0),
      cloudTaskId(ID, 2, 1),
      cloudTaskId(ID, 2, 1, 'rc123'),
    ]);
    expect(ids.size).toBe(4);
    expect(schedulerJobId(ID, 1)).not.toBe(schedulerJobId(ID, 2));
  });

  it('only uses characters Cloud Scheduler / Cloud Tasks accept', () => {
    for (const id of [schedulerJobId(ID, 7), cloudTaskId(ID, 7, 12, 'rc/9!')]) {
      expect(id).toMatch(/^[A-Za-z0-9_-]{1,500}$/);
    }
  });

  it('prefixes task ids with a hash so names do not share a sequential prefix', () => {
    expect(cloudTaskId(ID, 1, 0)).toMatch(/^[0-9a-f]{8}-bc-/);
  });

  it('shortName strips the resource path', () => {
    expect(shortName('projects/p/locations/l/queues/q/tasks/abc')).toBe('abc');
    expect(shortName('abc')).toBe('abc');
  });
});
