// Entry time-in-force on "Stage in TWS" (17 Nov 2026): 0DTE entry GTD 12:30 ET, 45DTE GTC.
import { describe, it, expect } from 'vitest';
import { buildStage, gtdFor } from '../../../bridge/stageOrder.js';

const legs = exp => [{ strike: 6700, right: 'P', qty: 1, expiry: exp }, { strike: 6720, right: 'P', qty: -2, expiry: exp }, { strike: 6730, right: 'P', qty: 1, expiry: exp }];
const base = { underlying: 'SPX', legs: legs('20261117'), lots: 2, side: 'debit', entry: 1.2, targets: [{ qty: 2, price: 2.4 }], tif: 'DAY' };
const at = s => Date.parse(s);

describe('stage entry TIF', () => {
  it('0DTE entry is GTD 12:30 ET the same day; the profit target stays DAY', () => {
    const r = buildStage({ ...base, entryTif: 'GTD', now: at('2026-11-17T15:30:00Z') });   // 10:30 ET
    expect(r.parent).toMatchObject({ tif: 'GTD', goodTillDate: '20261117 12:30:00 US/Eastern', transmit: false });
    expect(r.children[0].tif).toBe('DAY');
    expect(r.children[0].goodTillDate).toBeUndefined();
  });
  it('staged from Melbourne the evening before → the coming session', () => {
    expect(gtdFor('20261117', at('2026-11-17T03:51:00Z')).goodTillDate).toBe('20261117 12:30:00 US/Eastern');
    expect(gtdFor('20261123', at('2026-11-21T01:00:00Z')).ymd).toBe('20261123');          // Fri night → Mon
  });
  it('refuses a 0DTE entry after the cut-off', () => {
    expect(buildStage({ ...base, entryTif: 'GTD', now: at('2026-11-17T17:31:00Z') }).error).toMatch(/12:30 ET/);
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
