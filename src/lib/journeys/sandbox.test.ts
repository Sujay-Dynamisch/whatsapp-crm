import { describe, expect, it } from 'vitest';

import { runUserCode } from './sandbox';

describe('runUserCode', () => {
  it('returns the value and captures logs', async () => {
    const r = await runUserCode(
      'console.log("hi", { a: 1 }); return { total: trigger.items.reduce((s, i) => s + i.price, 0), who: contact.name };',
      { contact: { name: 'Asha' }, trigger: { items: [{ price: 2 }, { price: 3 }] } }
    );
    expect(r).toEqual({ result: { total: 5, who: 'Asha' }, logs: ['hi {"a":1}'] });
  });

  it('returns null when nothing is returned', async () => {
    expect((await runUserCode('const x = 1;', {})).result).toBeNull();
  });

  it('has no access to the host', async () => {
    const r = await runUserCode(
      'return [typeof process, typeof require, typeof fetch, typeof setTimeout, typeof globalThis.Buffer];',
      {}
    );
    expect(r.result).toEqual(['undefined', 'undefined', 'undefined', 'undefined', 'undefined']);
  });

  it('stops infinite loops', async () => {
    await expect(runUserCode('while (true) {}', {}, { timeoutMs: 200 })).rejects.toThrow(/too long/);
  });

  it('stops memory bombs within the hard limit', async () => {
    const started = Date.now();
    await expect(
      runUserCode('const a = []; for (let i = 0; ; i++) a.push(new Array(1e5).fill(i));', {}, {
        memoryBytes: 8 * 1024 * 1024,
        timeoutMs: 500,
      })
    ).rejects.toThrow();
    // timeout + worker grace, with slack for a slow CI box.
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it('reports thrown errors', async () => {
    await expect(runUserCode('throw new TypeError("bad input")', {})).rejects.toThrow('TypeError: bad input');
  });
});
