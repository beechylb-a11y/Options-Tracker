/* Grouping TWS legs into a ticket (Oct 2026): per-share price per leg from the right
   source, net per ONE unit, calendars kept whole. */
import { describe, it, expect } from 'vitest';
import { groupIntoStructures, legPerShare } from '../../../bridge/structures.js';

const pos = (o) => ({ underlying: 'SPX', expiry: '20261106', right: 'C', multiplier: 100, ...o,
  perShare: legPerShare(o.avgCost, 100, 'contract') });

describe('TWS structures', () => {
  it('reads position avgCost per contract, order prices per share', () => {
    expect(legPerShare(40, 100, 'contract')).toBe(0.4);      // a 0.40 leg — used to read as 40.00
    expect(legPerShare(165.6, 100, 'share')).toBe(165.6);
  });

  it('nets a 10-lot fly to its per-unit debit', () => {
    const r = groupIntoStructures([
      pos({ strike: 6700, qty: 10, avgCost: 220 }),   // 2.20
      pos({ strike: 6710, qty: -20, avgCost: 100 }),  // 1.00
      pos({ strike: 6720, qty: 10, avgCost: 44 }),    // 0.44
    ]);
    expect(r.structures).toHaveLength(1);
    const s = r.structures[0];
    expect(s.contracts).toBe(10);
    expect(s.netCreditDebit).toBeCloseTo(-0.64, 6);   // 2.20 − 2×1.00 + 0.44 = 0.64 debit
    expect(s.shape).toBe('Broken wing / Butterfly');
  });

  it('keeps a calendar as one structure across its two expiries', () => {
    const r = groupIntoStructures([
      pos({ strike: 7775, expiry: '20261120', qty: -1, avgCost: 16500 }),
      pos({ strike: 7775, expiry: '20261218', qty: 1, avgCost: 21724 }),
    ]);
    expect(r.structures).toHaveLength(1);
    expect(r.structures[0].shape).toBe('Calendar');
    expect(r.structures[0].expiries).toEqual(['20261120', '20261218']);
    expect(r.structures[0].netCreditDebit).toBeCloseTo(-52.24, 6);
  });

  it('still splits unrelated expiries', () => {
    const r = groupIntoStructures([
      pos({ strike: 7000, expiry: '20261106', qty: 1, avgCost: 100 }),
      pos({ strike: 7010, expiry: '20261106', qty: -1, avgCost: 50 }),
      pos({ strike: 7500, expiry: '20261218', qty: 1, avgCost: 300 }),
    ]);
    expect(r.structures).toHaveLength(2);
  });
});
