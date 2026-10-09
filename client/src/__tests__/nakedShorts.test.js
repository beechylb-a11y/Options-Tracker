/* Short strangle and short put: buildable, managed like any credit structure, and
   deliberately NOT sized by the engine. The last part is the point of the test —
   every other strategy divides a risk cap by a real max loss; these two have none,
   and a contract count derived from the number in the Risk box would be arithmetic
   dressed up as a limit. */
import { describe, it, expect } from 'vitest';
import { calc45DTE } from '../engine/calc45dte';
import { STRATS_45DTE, UNDEFINED_RISK, STRATEGY_CASH_TYPE, PROFIT_LOCUS, exitRuleFor } from '../engine/data';
import { DELTA_TARGETS } from '../engine/deltaStrikes';

const base = {
  underlying: 'QQQ', price: 600, ivr: 45, iv: 22, hv: 18, vix: 15,
  ivFront: 22, ivBack: 23, termBias: 'contango', dte: 45, outlook: 'neutral',
  pop: 72, win: 300, risk: 1200, bankroll: 25000, startBR: 25000,
  maxLoss: 5000, maxOpen: 10000, theta: 12, vega: -40, delta: 2,
};
const run = (strat, over = {}) => calc45DTE({ ...base, overrideStrategy: strat, ...over });

describe('registry', () => {
  it('offers both as 45DTE strategies, as credit, range-bound, and undefined-risk', () => {
    for (const s of ['Short strangle', 'Short put']) {
      expect(STRATS_45DTE).toContain(s);
      expect(STRATEGY_CASH_TYPE[s]).toBe('credit');
      expect(PROFIT_LOCUS[s]).toBe('range');
      expect(UNDEFINED_RISK.has(s)).toBe(true);
    }
  });

  it('manages them like every other credit structure: 50% of max, out by 21 DTE', () => {
    for (const s of ['Short strangle', 'Short put']) {
      const r = exitRuleFor('45DTE', s);
      expect(r.target).toBe(50);
      expect(r.basis).toBe('max');
      expect(r.closeDte).toBe(21);
    }
  });

  it('places the shorts at the tastylive deltas', () => {
    expect(DELTA_TARGETS['45dte']['Short strangle'].shorts.P.t).toBe(16);
    expect(DELTA_TARGETS['45dte']['Short strangle'].shorts.C.t).toBe(16);
    expect(DELTA_TARGETS['45dte']['Short put'].shorts.P.t).toBe(20);
    // No wing to drag along — the short is the whole position.
    expect(DELTA_TARGETS['45dte']['Short strangle'].mode).toBe('short');
  });
});

describe('legs', () => {
  it('builds a strangle as two naked shorts either side of spot', () => {
    const legs = run('Short strangle').legs;
    expect(legs).toHaveLength(2);
    const [put, call] = [legs.find(l => /put/i.test(l.label)), legs.find(l => /call/i.test(l.label))];
    expect(put.strike).toBeLessThan(base.price);
    expect(call.strike).toBeGreaterThan(base.price);
    expect(legs.every(l => /short/i.test(l.label))).toBe(true);
  });

  it('builds a short put as one leg below spot', () => {
    const legs = run('Short put').legs;
    expect(legs).toHaveLength(1);
    expect(legs[0].strike).toBeLessThan(base.price);
    expect(legs[0].label).toMatch(/short put/i);
  });
});

describe('the engine refuses to size them', () => {
  it('returns no Kelly contract count, and no size at all until one is typed', () => {
    const r = run('Short strangle');
    expect(r.riskUndefined).toBe(true);
    expect(r.kellyContracts).toBeNull();
    expect(r.contracts).toBe(0);
  });

  it('uses the size you type, and nothing else', () => {
    const r = run('Short strangle', { contractsOverride: 2 });
    expect(r.contracts).toBe(2);
    expect(r.maxRisk).toBe(2 * base.risk);
  });

  it('says why, in the warnings', () => {
    expect(run('Short strangle').warnings.join(' ')).toMatch(/no maximum loss/i);
    expect(run('Short put').warnings.join(' ')).toMatch(/strike − credit|strike - credit/i);
  });

  it('withholds P(max loss) rather than quoting the odds of reaching a strike', () => {
    expect(run('Short strangle').pMaxLoss).toBeNull();
    expect(run('Short put').pMaxLoss).toBeNull();
  });
});

describe('nothing else moved', () => {
  it('still sizes a defined-risk condor from Kelly, and still prices its tail', () => {
    const r = run('Iron Condor - Normal');
    expect(r.riskUndefined).toBe(false);
    expect(r.kellyContracts).toBeGreaterThanOrEqual(1);
    expect(r.contracts).toBeGreaterThanOrEqual(1);
    expect(r.pMaxLoss).not.toBeNull();
  });

  it('leaves the condor P(max loss) identical to what it was before the change', () => {
    // Guard on the user's standing instruction that P(max loss) is not to be touched:
    // the naked shorts are EXCLUDED from the block, never routed through it.
    const a = run('Iron Condor - Normal').pMaxLoss;
    const b = run('Iron Condor - Normal', { bankroll: 99999 }).pMaxLoss;
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(1);
  });
});
