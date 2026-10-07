// 0DTE strikes onto today's listed chain (Oct 2026). AAPL's same-day chain lists
// every $2.50; the engine's $0.50 grid asked for strikes TWS does not have.
import { describe, it, expect } from 'vitest';
import { fitToListed } from '../engine/listedStrikes';
import { calc0DTE } from '../engine/calc0dte';

const grid = (lo, hi, step) => { const a = []; for (let k = lo; k <= hi + 1e-9; k += step) a.push(+k.toFixed(2)); return a; };
const AAPL = { C: grid(300, 370, 2.5), P: grid(300, 370, 2.5) };

describe('butterflies keep their shape on a coarse chain', () => {
  it('asymmetric call fly 334 / 2×335.5 / 338 → listed, upper wing still wider', () => {
    const legs = [{ label: 'Long call (lower)', strike: 334 }, { label: 'Short call x2 (body)', strike: 335.5 }, { label: 'Long call (1.5x upper)', strike: 338 }];
    const f = fitToListed(legs, AAPL);
    expect(f.changed).toBe(true);
    const [lo, b, hi] = f.legs.map(l => l.strike);
    [lo, b, hi].forEach(k => expect(AAPL.C).toContain(k));
    expect(hi - b).toBeGreaterThan(b - lo);
    expect(b).toBe(335);
  });
  it('standard fly keeps equal wings', () => {
    const legs = [{ label: 'Long put (upper)', strike: 337 }, { label: 'Short put x2 (mid)', strike: 335.5 }, { label: 'Long put (lower)', strike: 334 }];
    const f = fitToListed(legs, AAPL);
    const ks = f.legs.map(l => l.strike);
    expect(ks[0] - ks[1]).toBe(ks[1] - ks[2]);
    ks.forEach(k => expect(AAPL.P).toContain(k));
  });
});

describe('calc0DTE fits to listedStrikes', () => {
  const base = { price: 335.2, high: 337, low: 333, cashOpen: 334, vwap5: 335, vwap5_30: 334.8, vwapRoll30: 335, vwapRoll30Prior: 334.7,
    em: 4, vix: 15, vix1d: 9, atr: 6, atr5: 0.5, atr2h: 2.5, hours: 3, underlying: 'AAPL',
    bankroll: 3000, startBR: 3000, maxLoss: 300, maxOpen: 450, pop: 0, win: 0, risk: 0 };
  ['Asymmetric butterfly', 'Iron Condor - Normal', 'Bull put spread', 'Iron butterfly'].forEach(strat => {
    it(`${strat}: every leg on a listed strike`, () => {
      const r = calc0DTE({ ...base, overrideStrategy: strat, listedStrikes: AAPL });
      expect(r.legs.length).toBeGreaterThan(0);
      r.legs.forEach(l => expect(AAPL.C).toContain(l.strike));
      expect(r.listedOk).toBe(true);
      expect(r.engineLegs.map(l => l.strike)).toEqual(r.legs.map(l => l.strike));
    });
  });
  it('flags a hand-typed strike today\'s chain lacks', () => {
    const r0 = calc0DTE({ ...base, overrideStrategy: 'Bull put spread', listedStrikes: AAPL });
    const r = calc0DTE({ ...base, overrideStrategy: 'Bull put spread', listedStrikes: AAPL,
      overrideStrikes: { 0: r0.legs[0].strike - 1 }, overrideStrikesStrat: 'Bull put spread' });
    expect(r.warnings.some(w => /Not listed for today/.test(w))).toBe(true);
  });
  it('without a chain nothing changes', () => {
    const r = calc0DTE({ ...base, overrideStrategy: 'Asymmetric butterfly' });
    expect(r.listedOk).toBe(false);
    expect(r.listedFit).toBe(null);
  });
});
