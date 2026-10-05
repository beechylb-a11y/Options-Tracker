/* R-49 delta cross-check and delta strikes (Oct 2026). */
import { describe, it, expect } from 'vitest';
import {
  normCdf, normInv, bsAbsDelta, strikeForDelta, calibrateV,
  deltaCrossCheck, deltaStrikePlan, pickByDelta, bracketStrikes, shortDeltaSummary,
} from '../engine/deltaStrikes';

// A skewed 0DTE SPX surface: 0.6% total vol on calls, more on puts.
const S = 6700;
const vCall = 0.006, vPut = 0.009;
const quote = (K, right) => ({ strike: K, right,
  delta: (right === 'P' ? -1 : 1) * bsAbsDelta(S, K, right === 'P' ? vPut : vCall, right), iv: 12 });

describe('normal helpers', () => {
  it('inverts the CDF', () => {
    [0.01, 0.16, 0.5, 0.84, 0.99].forEach(p => expect(normCdf(normInv(p))).toBeCloseTo(p, 6));
  });
  it('round-trips strike and delta', () => {
    const K = strikeForDelta(S, 0.16, vPut, 'P');
    expect(K).toBeLessThan(S);
    expect(bsAbsDelta(S, K, vPut, 'P')).toBeCloseTo(0.16, 6);
    const Kc = strikeForDelta(S, 0.16, vCall, 'C');
    expect(Kc).toBeGreaterThan(S);
  });
  it('recovers total vol from an observed delta', () => {
    const K = 6640;
    expect(calibrateV(S, K, bsAbsDelta(S, K, vPut, 'P'), 'P', 0.01)).toBeCloseTo(vPut, 6);
    const Kc = 6750;
    expect(calibrateV(S, Kc, bsAbsDelta(S, Kc, vCall, 'C'), 'C', 0.005)).toBeCloseTo(vCall, 6);
  });
});

const ic = [
  { label: 'Long put', strike: 6600 }, { label: 'Short put', strike: 6660 },
  { label: 'Short call', strike: 6740 }, { label: 'Long call', strike: 6800 },
];

describe('cross-check', () => {
  it('flags a put short whose delta is above band, from a skewed surface', () => {
    const g = [quote(6660, 'P'), quote(6740, 'C')];
    const c = deltaCrossCheck({ legs: ic, strat: 'Iron Condor - Normal', horizon: '0dte', legGreeks: g, pop: 0, hoursLeft: 4, price: S });
    expect(c.applicable).toBe(true);
    expect(c.haveGreeks).toBe(true);
    const put = c.rows.find(r => r.right === 'P');
    expect(put.delta).toBeGreaterThan(25);
    expect(c.warnings.some(w => /Short put 6660/.test(w) && /above/.test(w))).toBe(true);
  });

  it('warns when typed POP is more than 10 points from the delta-implied POP', () => {
    const g = [quote(6660, 'P'), quote(6740, 'C')];
    const c = deltaCrossCheck({ legs: ic, strat: 'Iron Condor - Normal', horizon: '0dte', legGreeks: g, pop: 85, hoursLeft: 4, price: S });
    expect(c.impliedPop).toBeGreaterThan(0.3);
    expect(c.impliedPop).toBeLessThan(0.75);
    expect(c.warnings.some(w => /POP 85% entered/.test(w))).toBe(true);
  });

  it('stays silent in the final hour of a 0DTE', () => {
    const g = [quote(6660, 'P'), quote(6740, 'C')];
    const c = deltaCrossCheck({ legs: ic, strat: 'Iron Condor - Normal', horizon: '0dte', legGreeks: g, pop: 85, hoursLeft: 0.8, price: S });
    expect(c.suspended).toBe(true);
    expect(c.warnings).toHaveLength(0);
    expect(c.notices[0]).toMatch(/final hour/);
  });

  it('marks greeks stale when they priced other strikes', () => {
    const c = deltaCrossCheck({ legs: ic, strat: 'Iron Condor - Normal', horizon: '0dte', legGreeks: [quote(6650, 'P')], pop: 0, hoursLeft: 4, price: S });
    expect(c.stale).toBe(true);
    expect(c.warnings).toHaveLength(0);
  });

  it('does not apply to pin structures', () => {
    const c = deltaCrossCheck({ legs: ic, strat: 'Standard butterfly', horizon: '0dte', legGreeks: [], pop: 0, hoursLeft: 4, price: S });
    expect(c.applicable).toBe(false);
  });

  it('summarises short deltas for the log', () => {
    const g = [quote(6660, 'P'), quote(6740, 'C')];
    const c = deltaCrossCheck({ legs: ic, strat: 'Iron Condor - Normal', horizon: '0dte', legGreeks: g, pop: 0, hoursLeft: 4, price: S });
    expect(shortDeltaSummary(c)).toMatch(/^6660P \d+Δ \/ 6740C \d+Δ$/);
  });
});

describe('delta strikes', () => {
  it('moves each short to ~target and keeps wing widths', () => {
    const g = [quote(6660, 'P'), quote(6740, 'C')];
    const p = deltaStrikePlan({ legs: ic, strat: 'Iron Condor - Normal', horizon: '0dte', price: S, legGreeks: g, T: 4 / 8760, underlying: 'SPX' });
    expect(p.changed).toBe(true);
    const [lp, sp, sc, lc] = p.legs.map(l => l.strike);
    expect(sp).toBeLessThan(6660);               // put skew → put short goes further out
    expect(sp - lp).toBe(60);
    expect(lc - sc).toBe(60);
    p.moves.forEach(m => expect(Math.abs(m.estDelta - 16)).toBeLessThan(3));
    expect(sp % 5).toBe(0);
  });

  it('pairs dual-EM vertical wings by their tag', () => {
    const legs = [
      { label: 'Short put (VIX)', strike: 6650 }, { label: 'Long put (VIX)', strike: 6600 },
      { label: 'Short put (VIX1D)', strike: 6640 }, { label: 'Long put (VIX1D)', strike: 6580 },
    ];
    const g = [quote(6650, 'P'), quote(6640, 'P')];
    const p = deltaStrikePlan({ legs, strat: 'Bull put spread', horizon: '0dte', price: S, legGreeks: g, T: 4 / 8760, underlying: 'SPX' });
    const s = p.legs.map(l => l.strike);
    expect(s[0] - s[1]).toBe(50);
    expect(s[2] - s[3]).toBe(60);
    expect(s[0]).toBe(s[2]);                      // both shorts land on the same delta strike
  });

  it('moves only the short of a debit vertical and never crosses the long', () => {
    const legs = [{ label: 'Long call', strike: 6700 }, { label: 'Short call', strike: 6730 }];
    const g = [quote(6730, 'C')];
    const p = deltaStrikePlan({ legs, strat: 'Bull call spread', horizon: '0dte', price: S, legGreeks: g, T: 4 / 8760, underlying: 'SPX' });
    expect(p.legs[0].strike).toBe(6700);
    expect(p.legs[1].strike).toBeGreaterThan(6700);
  });

  it('uses confirmed short strikes as given', () => {
    const g = [quote(6660, 'P'), quote(6740, 'C')];
    const p = deltaStrikePlan({ legs: ic, strat: 'Iron Condor - Normal', horizon: '0dte', price: S, legGreeks: g,
      T: 4 / 8760, underlying: 'SPX', shortStrikes: { 1: 6625, 2: 6745 } });
    expect(p.legs.map(l => l.strike)).toEqual([6565, 6625, 6745, 6805]);
  });

  it('calibrates from a neighbouring listed strike when the leg itself is off-grid', () => {
    const legs = [{ label: 'Short put', strike: 6512.5 }, { label: 'Long put', strike: 6420 }];
    const g = [quote(6510, 'P')];
    const p = deltaStrikePlan({ legs, strat: 'Credit spread', horizon: '45dte', price: S, legGreeks: g, T: 45 / 365, underlying: 'SPX' });
    expect(p).not.toBeNull();
    expect(p.legs[0].strike % 5).toBe(0);
  });

  it('picks the bracket strike nearest the target delta', () => {
    expect(bracketStrikes(6650, 'SPX')).toEqual([6645, 6650, 6655]);
    const rows = [quote(6645, 'P'), quote(6650, 'P'), quote(6655, 'P')];
    const want = Math.abs(quote(6650, 'P').delta) * 100;
    expect(pickByDelta(rows, want).strike).toBe(6650);
  });
});

import { calc0DTE } from '../engine/calc0dte';
import { calc45DTE } from '../engine/calc45dte';

describe('engine wiring', () => {
  const bull = {
    underlying: 'SPX', price: 6712, high: 6714, low: 6690, cashOpen: 6692,
    vwap5: 6703, vwap5_30: 6698, vwapRoll30: 6704, vwapRoll30Prior: 6694, vwapAccept: 0.9,
    atr: 60, em: 45, atr5: 4, atr2h: 4.2, gamStrike: 6700,
    vix: 15, vix1d: 17, bankroll: 3000, startBR: 3000,
    maxLoss: 300, maxOpen: 450, pop: 95, hours: 4, win: 120, risk: 380,
    overrideStrategy: 'Bull put spread',
  };
  it('0DTE returns a delta check and plan once leg greeks are supplied', () => {
    const base = calc0DTE(bull);
    expect(base.deltaCheck.applicable).toBe(true);
    expect(base.deltaCheck.haveGreeks).toBe(false);
    expect(base.deltaPlan).toBeNull();
    // Put-skewed greeks for the engine's own short strikes.
    const legGreeks = base.legs.filter(l => /short/i.test(l.label)).map(l => ({
      strike: l.strike, right: 'P', delta: -bsAbsDelta(bull.price, l.strike, 0.008, 'P'), iv: 14 }));
    const r = calc0DTE({ ...bull, legGreeks, hoursToBell: 5 });
    expect(r.deltaCheck.haveGreeks).toBe(true);
    expect(r.deltaCheck.impliedPop).toBeGreaterThan(0);
    expect(r.warnings.some(w => /POP 95% entered/.test(w))).toBe(true);
    expect(r.deltaPlan && r.deltaPlan.legs).toHaveLength(4);
  });
  it('0DTE suspends the check in the final hour', () => {
    const base = calc0DTE({ ...bull, hours: 0.6 });
    const legGreeks = base.legs.filter(l => /short/i.test(l.label)).map(l => ({ strike: l.strike, right: 'P', delta: -0.01, iv: 14 }));
    const r = calc0DTE({ ...bull, hours: 0.6, legGreeks });
    expect(r.deltaCheck.suspended).toBe(true);
    expect(r.warnings.some(w => /Δ band|POP 95% entered/.test(w))).toBe(false);
  });
  it('45DTE carries the check too', () => {
    const r = calc45DTE({ underlying: 'SPY', price: 670, ivr: 50, iv: 18, hv: 14, vix: 17, termBias: 'contango',
      dte: 45, outlook: 'neutral', pop: 70, win: 100, risk: 400, bankroll: 3000, startBR: 3000, maxLoss: 300, maxOpen: 450,
      overrideStrategy: 'Iron Condor - Normal' });
    expect(r.deltaCheck.applicable).toBe(true);
  });
});
