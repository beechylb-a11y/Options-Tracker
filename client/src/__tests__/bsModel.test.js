/* Bridge: greeks from the quote when TWS sends none (Nov 2026). */
import { describe, it, expect } from 'vitest';
import { bsPrice, impliedVol, yearsToClose, greeksFromQuote, parityspot } from '../../../bridge/bsModel.js';

const NOW = new Date('2026-11-18T20:18:00Z');   // 15:18 New York (EST)

describe('bridge Black–Scholes', () => {
  it('times to the 16:00 New York close in winter and summer', () => {
    expect(yearsToClose('20261118', NOW) * 365 * 24 * 60).toBeCloseTo(42, 3);
    expect(yearsToClose('20260715', new Date('2026-07-15T19:00:00Z')) * 365 * 24).toBeCloseTo(1, 6);   // EDT: 16:00 = 20:00Z
    expect(yearsToClose('20261117', NOW)).toBeNull();
    expect(yearsToClose('bad', NOW)).toBeNull();
  });
  it('implied vol inverts the price', () => {
    const T = 30 / 365, p = bsPrice(732, 720, T, 0.21, 'P');
    expect(impliedVol(p, 732, 720, T, 'P')).toBeCloseTo(0.21, 4);
    expect(impliedVol(5, 732, 740, T, 'P')).toBeNull();          // below intrinsic
  });
  it('greeks from the XSP 732P quote 42 min before the bell', () => {
    const g = greeksFromQuote({ bid: 0.38, ask: 0.40, und: 732.3, strike: 732, right: 'P', expiry: '20261118', now: NOW });
    expect(g.tickType).toBe('bs');
    expect(g.optPrice).toBe(0.39);
    expect(g.delta).toBeLessThan(-0.3); expect(g.delta).toBeGreaterThan(-0.6);
    expect(g.gamma).toBeGreaterThan(0);
    expect(g.theta).toBeLessThan(0);
    expect(g.iv).toBeGreaterThan(5); expect(g.iv).toBeLessThan(60);
    // round trip: the price at the computed IV is the mid
    expect(bsPrice(732.3, 732, yearsToClose('20261118', NOW), g.iv / 100, 'P')).toBeCloseTo(0.39, 2);
  });
  it('a deep in-the-money leg at intrinsic has delta −1 and no vol; a 0.01 wing has delta near 0', () => {
    expect(greeksFromQuote({ bid: 7.6, ask: 7.7, und: 732.3, strike: 740, right: 'P', expiry: '20261118', now: NOW }))
      .toMatchObject({ iv: null, delta: -1 });
    expect(Math.abs(greeksFromQuote({ bid: 0, ask: 0.01, und: 732.3, strike: 719, right: 'P', expiry: '20261118', now: NOW }).delta)).toBeLessThan(0.01);
    const wing = greeksFromQuote({ bid: null, ask: 0.01, und: 731.8, strike: 719, right: 'P', expiry: '20261118', now: NOW });
    expect(wing.optPrice).toBe(0.01); expect(Math.abs(wing.delta)).toBeLessThan(0.01);   // no bid on the wing = bid 0
    expect(greeksFromQuote({ bid: 1, ask: 1.1, und: 0, strike: 719, right: 'P', expiry: '20261118', now: NOW })).toBeNull();
  });
  it('put–call parity gives the spot the options are pricing', () => {
    const T = yearsToClose('20261118', NOW), S = 732.62, K = 732;
    const C = bsPrice(S, K, T, 0.12, 'C', 0.04, 0.013), P = bsPrice(S, K, T, 0.12, 'P', 0.04, 0.013);
    const s = parityspot({ call: { bid: C - 0.01, ask: C + 0.01 }, put: { bid: P - 0.01, ask: P + 0.01 }, strike: K, expiry: '20261118', now: NOW, q: 0.013 });
    expect(s).toBeCloseTo(S, 2);
    expect(parityspot({ call: { bid: 1 }, put: { bid: 1, ask: 1.1 }, strike: K, expiry: '20261118', now: NOW })).toBeNull();
  });
});
