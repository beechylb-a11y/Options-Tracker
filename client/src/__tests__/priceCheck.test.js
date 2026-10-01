/* The entry-price check against the two tickets that motivated it.

   SPY 767/770/775 on 30 Sep was bought for 1.11 when the model said roughly 0.5, and
   the old tolerance — 20% of the 8-point STRIKE SPAN, i.e. 1.60 — waved it through.
   Against a 1.89 max profit that band accepted anything from -0.49 to 2.71. */
import { describe, it, expect } from 'vitest';
import { calc0DTE } from '../engine/calc0dte';

const base = {
  underlying: 'SPY', price: 769.6, high: 771.2, low: 766.4,
  vwap5: 769.4, vwap5_30: 769.2, vwapRoll30: 769.5, vwapRoll30Prior: 769.3, vwapAccept: 0.4,
  atr: 7.0, em: 5.0, atr5: 0.6, atr2h: 2.3, gamStrike: 770,
  vix: 16, vix1d: 9.0, bankroll: 1500, startBR: 3000,
  maxLoss: 300, maxOpen: 675, pop: 55, hours: 4.2,
  theta: 30, delta: -3, gamma: -8,
  overrideStrategy: 'Broken wing butterfly',
  overrideStrikes: { 0: 767, 1: 770, 2: 775 },
};
const run = (netCreditDebit, risk, win) =>
  calc0DTE({ ...base, netCreditDebit, risk, win });

describe('entry price check', () => {
  it('bands the gap on max profit, not on the strike span', () => {
    const r = run(-1.11, 311, 189);
    expect(r.priceCheck).toBeTruthy();
    // The old ruler: 20% of the 8-point span = 1.60, which accepted almost anything.
    expect(0.20 * r.priceCheck.width).toBeGreaterThan(1.5);
    // The new one is tied to what can actually be won.
    expect(r.priceCheck.tol).toBeLessThan(0.20 * r.priceCheck.width);
    expect(r.priceCheck.tol).toBeCloseTo(0.35 * r.priceCheck.maxProfitBare, 2);
  });

  it('reports the multiple of fair value being paid', () => {
    const r = run(-1.11, 311, 189);
    expect(r.priceCheck.fair).toBeGreaterThan(0);
    expect(r.priceCheck.ratio).toBeCloseTo(r.priceCheck.cost / r.priceCheck.fair, 6);
    // This ticket was a substantial overpay and must now say so. 1.48x is beyond
    // what crossing a 4-leg spread can explain, which is where the threshold sits.
    expect(r.priceCheck.ratio).toBeGreaterThan(1.30);
    expect(r.warnings.some(w => /fair value/.test(w))).toBe(true);
  });

  it('stays quiet on a fairly priced structure', () => {
    const r = run(-1.11, 311, 189);
    const fair = r.priceCheck.fair;
    const ok = run(-Number(fair.toFixed(2)), 311, 189);
    expect(ok.priceCheck.ratio).toBeLessThan(1.1);
    expect(ok.warnings.some(w => /fair value/.test(w))).toBe(false);
    expect(ok.priceCheck.mismatch).toBe(false);
  });

  it('still blocks a price the strikes cannot produce', () => {
    // Above the upper strike this structure is worth -2; it can never cost 9.
    const r = run(-9, 311, 189);
    expect(r.priceCheck.arb).toBe(true);
    expect(r.blockers.some(b => /impossible at any volatility/.test(b))).toBe(true);
    // An impossible price is not ALSO reported as a mere overpay.
    expect(r.warnings.some(w => /fair value/.test(w))).toBe(false);
  });

  it('exposes the bounds a quote can be sanity-checked against', () => {
    const r = run(-1.11, 311, 189);
    // 1/-2/+1 with wings 3 and 5 pays at most 3.00 and at worst -2.00.
    expect(r.priceCheck.bareMax).toBeCloseTo(3, 1);
    expect(r.priceCheck.bareMin).toBeCloseTo(-2, 1);
  });
});
