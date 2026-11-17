// Entry time-in-force on "Stage in TWS" (17 Nov 2026): 0DTE entry cancels at 12:30 ET, 45DTE GTC.
// 18 Nov: TWS rejected the GTD entry on SPX ("Inter exchange combo order should be DAY/GTC
// order"), so the entry is staged DAY and the bridge cancels it at cancelAt if unfilled.
import { describe, it, expect } from 'vitest';
import { buildStage, gtdFor } from '../../../bridge/stageOrder.js';

const legs = exp => [{ strike: 6700, right: 'P', qty: 1, expiry: exp }, { strike: 6720, right: 'P', qty: -2, expiry: exp }, { strike: 6730, right: 'P', qty: 1, expiry: exp }];
const base = { underlying: 'SPX', legs: legs('20261117'), lots: 2, side: 'debit', entry: 1.2, targets: [{ qty: 2, price: 2.4 }], tif: 'DAY' };
const at = s => Date.parse(s);

describe('stage entry TIF', () => {
  it('0DTE entry is DAY with a 12:30 ET cancelAt for the bridge — never GTD; the target stays DAY', () => {
    for (const t of ['CUTOFF', 'GTD']) {
      const r = buildStage({ ...base, entryTif: t, now: at('2026-11-17T15:30:00Z') });   // 10:30 ET
      expect(r.parent).toMatchObject({ tif: 'DAY', transmit: false });
      expect(r.parent.goodTillDate).toBeUndefined();
      expect(r.cancelAt).toBe(at('2026-11-17T17:30:00Z'));                                // 12:30 EST
      expect(r.entryTif).toMatch(/DAY · cancels 12:30 ET/);
      expect(r.children[0].tif).toBe('DAY');
    }
  });
  it('a plain DAY or GTC entry has no cut-off', () => {
    expect(buildStage({ ...base, entryTif: 'DAY' }).cancelAt).toBeNull();
    expect(buildStage({ ...base, legs: legs('20270101'), entryTif: 'GTC', tif: 'GTC' }).cancelAt).toBeNull();
  });
  it('staged from Melbourne the evening before → the coming session', () => {
    expect(gtdFor('20261117', at('2026-11-17T03:51:00Z')).goodTillDate).toBe('20261117 12:30:00 US/Eastern');
    expect(gtdFor('20261123', at('2026-11-21T01:00:00Z')).ymd).toBe('20261123');          // Fri night → Mon
  });
  it('refuses a 0DTE entry after the cut-off', () => {
    expect(buildStage({ ...base, entryTif: 'CUTOFF', now: at('2026-11-17T17:31:00Z') }).error).toMatch(/12:30 ET/);
  });
  it('handles daylight saving (EDT)', () => {
    expect(gtdFor('20260716', at('2026-07-16T16:29:00Z')).ymd).toBe('20260716');
    expect(gtdFor('20260716', at('2026-07-16T16:31:00Z')).error).toBeTruthy();
  });
  it('45DTE entry and target are GTC', () => {
    const r = buildStage({ ...base, legs: legs('20270101'), entryTif: 'GTC', tif: 'GTC' });
    expect(r.parent.tif).toBe('GTC');
    expect(r.children[0].tif).toBe('GTC');
  });
});
