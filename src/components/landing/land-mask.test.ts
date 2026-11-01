import { describe, expect, it } from 'vitest';

import { isLand } from './land-mask';

describe('land mask', () => {
  it('knows land from sea', () => {
    for (const [name, lat, lon] of [
      ['Delhi', 28.6, 77.2],
      ['Sahara', 23, 10],
      ['Brazil', -10, -55],
      ['Central Australia', -25, 134],
      ['Kansas', 38.5, -98],
      ['Siberia', 62, 100],
      ['Antarctica', -80, 0],
    ] as const) {
      expect(isLand(lat, lon), name).toBe(true);
    }
    for (const [name, lat, lon] of [
      ['Pacific', 0, -150],
      ['Atlantic', 30, -40],
      ['Indian Ocean', -20, 80],
      ['Arabian Sea', 15, 65],
      ['Southern Ocean', -55, 100],
    ] as const) {
      expect(isLand(lat, lon), name).toBe(false);
    }
  });

  it('wraps longitudes and clamps latitudes', () => {
    expect(isLand(28.6, 77.2 + 360)).toBe(true);
    expect(isLand(0, 210)).toBe(isLand(0, -150));
    expect(() => isLand(95, 0)).not.toThrow();
    expect(() => isLand(-95, 0)).not.toThrow();
  });
});
