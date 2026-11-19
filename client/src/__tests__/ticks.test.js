/* Combo price increments (20 Nov 2026): TWS rejected an SPX butterfly staged at 22.12
   ("110: price does not conform to the minimum price variation"). What-if tests on the
   paper login: SPX combos $0.05; XSP and SPY $0.01. Prices round in the trader's favour. */
import { describe, it, expect } from 'vitest';
import { COMBO_TICK, comboTick, roundToTick, tickEntry, tickTarget } from '../engine/ticks';
import * as bridge from '../../../bridge/stageOrder.js';
import { exitNumbers } from '../components/ExitPlanCard';

describe('tick grid', () => {
  it('SPX (and the other non-penny indices) $0.05; XSP, SPY, stocks $0.01', () => {
    expect(comboTick('SPX')).toBe(0.05);
    expect(comboTick('spx')).toBe(0.05);
    expect(comboTick('NDX')).toBe(0.05);
    expect([comboTick('XSP'), comboTick('SPY'), comboTick('QQQ'), comboTick('NVDA'), comboTick('')]).toEqual([0.01, 0.01, 0.01, 0.01, 0.01]);
  });
  it('rounds without float noise, in the asked direction', () => {
    expect(roundToTick(22.12, 0.05, 'down')).toBe(22.1);
    expect(roundToTick(22.12, 0.05, 'up')).toBe(22.15);
    expect(roundToTick(22.15, 0.05, 'down')).toBe(22.15);      // already on the grid stays put
    expect(roundToTick(33.18, 0.05, 'up')).toBe(33.2);
    expect(roundToTick(2.12, 0.01, 'down')).toBe(2.12);
    expect(roundToTick(0.07, 0.05, 'near')).toBe(0.05);
  });
  it('always in the trader’s favour: pay less, take in more, sell higher, buy back lower', () => {
    expect(tickEntry(22.12, false, 0.05)).toBe(22.1);    // debit BUY → down
    expect(tickEntry(3.42, true, 0.05)).toBe(3.45);      // credit SELL → up
    expect(tickTarget(33.18, false, 0.05)).toBe(33.2);   // debit target SELL → up
    expect(tickTarget(1.72, true, 0.05)).toBe(1.7);      // credit target BUY → down
  });
  it('the bridge keeps the same table and rounding', () => {
    expect(bridge.COMBO_TICK).toEqual(COMBO_TICK);
    for (const [x, t, d] of [[22.12, 0.05, 'down'], [33.18, 0.05, 'up'], [1.72, 0.05, 'down'], [2.13, 0.01, 'up']]) {
      expect(bridge.roundToTick(x, t, d)).toBe(roundToTick(x, t, d));
    }
  });
});

describe('on the ticket and in the order', () => {
  const legs = [{ strike: 7215, right: 'C', qty: 1, expiry: '20261119' }, { strike: 7290, right: 'C', qty: -2, expiry: '20261119' }, { strike: 7400, right: 'C', qty: 1, expiry: '20261119' }];
  it('the exit plan shows and sends SPX prices on the $0.05 grid, and says so', () => {
    const N = exitNumbers({ net: -22.12, win: 52.88, qty: 1, plan: { priced: [{ pct: 50, qty: 1, price: 33.18 }] }, tick: 0.05 });
    expect(N.entry).toBe(22.1);
    expect(N.rawEntry).toBe(22.12);
    expect(N.targets[0].price).toBe(33.2);
    expect(N.targets[0].gain).toBeCloseTo((33.2 - 22.1) * 100, 6);
    expect(N.ticked).toBe(true);
    const X = exitNumbers({ net: -22.12, win: 52.88, qty: 1, plan: { priced: [{ pct: 50, qty: 1, price: 33.18 }] }, tick: 0.01 });
    expect([X.entry, X.targets[0].price, X.ticked]).toEqual([22.12, 33.18, false]);
  });
  it('the bridge puts the order on the grid even if a caller sends cents', () => {
    const plan = bridge.buildStage({ underlying: 'SPX', legs, lots: 1, side: 'debit', entry: 22.12, targets: [{ qty: 1, price: 33.18 }], entryTif: 'DAY' });
    expect(plan.error).toBeUndefined();
    expect(plan.parent.lmtPrice).toBe(22.1);
    expect(plan.children[0].lmtPrice).toBe(33.2);
    expect(plan.summary[0]).toMatch(/@ 22\.10 db/);
    const xsp = bridge.buildStage({ underlying: 'XSP', legs: legs.map(l => ({ ...l, strike: l.strike / 10 })), lots: 1, side: 'debit', entry: 2.12, targets: [{ qty: 1, price: 3.18 }], entryTif: 'DAY' });
    expect([xsp.parent.lmtPrice, xsp.children[0].lmtPrice]).toEqual([2.12, 3.18]);
    const cr = bridge.buildStage({ underlying: 'SPX', legs, lots: 1, side: 'credit', entry: 3.42, targets: [{ qty: 1, price: 1.72 }], entryTif: 'DAY' });
    expect([cr.parent.lmtPrice, cr.children[0].lmtPrice]).toEqual([3.45, 1.7]);
  });
});
