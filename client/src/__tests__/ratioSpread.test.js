/* Ratio spread construction (R-54/R-56, Oct 2026).
   The ticket picks 1:2, 2:3 or 3:4 and, by default, adds S − L protective longs at the
   zero-risk strike: K_short + L/(S−L) × (K_short − K_long). Off, the trade is
   undefined risk — rated no better than MARGINAL and never sized by the engine. */
import { describe, it, expect } from 'vitest';
import { calc45DTE } from '../engine/calc45dte';
import { legQty, signedLegQty } from '../engine/legQty';
import { zeroRiskStrike, snapInward, buildRatioLegs, reprotect, ratioTailLoss, ratioChoice } from '../engine/ratioSpread';
import { deltaStrikePlan } from '../engine/deltaStrikes';
import { unitsFromLegs } from '../utils/commission';
import { shadowLegs } from '../engine/shadow';

const base = {
  underlying: 'QQQ', price: 600, ivr: 45, iv: 22, hv: 18, vix: 15,
  ivFront: 22, ivBack: 23, termBias: 'contango', dte: 45, outlook: 'neutral',
  pop: 72, win: 300, risk: 1200, bankroll: 25000, startBR: 25000,
  maxLoss: 5000, maxOpen: 10000, theta: 12, vega: -40, delta: 2,
};
const run = (spec, over = {}) => calc45DTE({ ...base, overrideStrategy: 'Ratio spread', ratioSpec: spec, ...over });
const byRole = legs => ({
  long: legs.find(l => /long/i.test(l.label) && !/protective/i.test(l.label)),
  short: legs.find(l => /short/i.test(l.label)),
  prot: legs.find(l => /protective/i.test(l.label)),
});

describe('legQty', () => {
  it('reads x<n> from the label, and an explicit qty first', () => {
    expect(legQty({ label: 'Short call x2' })).toBe(2);
    expect(legQty({ label: 'Short call x3' })).toBe(3);
    expect(legQty({ label: 'Short put x2 (body)' })).toBe(2);
    expect(legQty({ label: 'Long call x4 (protective)' })).toBe(4);
    expect(legQty({ label: 'Long call', qty: 3 })).toBe(3);
  });
  it('does not mistake other labels for quantities', () => {
    expect(legQty({ label: 'Long call (1.5x upper)' })).toBe(1);
    expect(legQty({ label: 'Short put (VIX1D)' })).toBe(1);
    expect(legQty({ label: 'Short put (body)' })).toBe(1);     // iron fly short: one contract
    expect(legQty({ label: 'Long put (broken 17.5pt)' })).toBe(1);
  });
  it('signs shorts negative', () => {
    expect(signedLegQty({ label: 'Short call x3' })).toBe(-3);
    expect(signedLegQty({ label: 'Long call x2' })).toBe(2);
  });
});

describe('zero-risk protective strike', () => {
  it('is K_short + L/(S−L) × spacing', () => {
    expect(zeroRiskStrike(600, 623, 1, 2)).toBe(646);
    expect(zeroRiskStrike(600, 623, 2, 3)).toBe(669);
    expect(zeroRiskStrike(600, 623, 3, 4)).toBe(692);
    // puts mirror below
    expect(zeroRiskStrike(600, 577, 1, 2)).toBe(554);
  });
  it('snaps inward, never past the zero-risk point', () => {
    expect(snapInward(647.5, 623, 5)).toBe(643);              // 623 + 4×5
    expect(snapInward(552.5, 577, 5)).toBe(557);              // puts: toward the short
    expect(snapInward(646, 623, 1, [640, 645, 650])).toBe(645);
    expect(snapInward(646, 623, 1, [650, 655])).toBe(650);    // nothing inside: nearest beyond
  });
});

describe('builder', () => {
  it('builds 1:2, 2:3 and 3:4 with S − L protective longs at +1.0 / +1.5 / +2.0 SD', () => {
    const want = { '1:2': [1, 2, 1], '2:3': [2, 3, 1], '3:4': [3, 4, 1] };
    for (const id of Object.keys(want)) {
      const r = run({ ratio: id, protect: true });
      const { long, short, prot } = byRole(r.legs);
      expect([legQty(long), legQty(short), legQty(prot)]).toEqual(want[id]);
      const { L, S } = ratioChoice({ ratio: id });
      expect(prot.strike).toBe(zeroRiskStrike(long.strike, short.strike, L, S));
      expect(ratioTailLoss(r.legs)).toBe(0);
      expect(r.riskUndefined).toBe(false);
      expect(r.ratio).toMatchObject({ id, protect: true, tailLoss: 0 });
    }
  });

  it('defaults to 1:2 protected when no spec is given', () => {
    const r = calc45DTE({ ...base, overrideStrategy: 'Ratio spread' });
    expect(r.legs).toHaveLength(3);
    expect(r.ratio).toMatchObject({ id: '1:2', protect: true });
  });

  it('mirrors to puts below spot on a bearish outlook', () => {
    const r = run({ ratio: '2:3', protect: true }, { outlook: 'bearish' });
    const { long, short, prot } = byRole(r.legs);
    expect(r.legs.every(l => /put/i.test(l.label))).toBe(true);
    expect(short.strike).toBeLessThan(long.strike);
    expect(prot.strike).toBeLessThan(short.strike);
    expect(prot.strike).toBe(zeroRiskStrike(long.strike, short.strike, 2, 3));
  });

  it('counts every contract for commission and the shadow record', () => {
    const r = run({ ratio: '3:4', protect: true });
    expect(unitsFromLegs(r.legs)).toBe(8);                    // 3 + 4 + 1
    const q = shadowLegs(r.legs).map(l => l.qty).sort((a, b) => a - b);
    expect(q).toEqual([-4, 1, 3]);
  });
});

describe('unprotected = undefined risk (R-56)', () => {
  it('drops the protective leg, refuses to size, and warns', () => {
    const r = run({ ratio: '2:3', protect: false });
    expect(r.legs).toHaveLength(2);
    expect(r.riskUndefined).toBe(true);
    expect(r.kellyContracts).toBeNull();
    expect(r.pMaxLoss).toBeNull();
    expect(r.warnings.some(w => /without the protective long/.test(w))).toBe(true);
  });

  it('is never rated above MARGINAL, so the engine never picks it', () => {
    // Very rich regime rates the ratio EXCELLENT when protected.
    const rich = { ivr: 70, iv: 30, hv: 20 };
    const on = calc45DTE({ ...base, ...rich, ratioSpec: { ratio: '1:2', protect: true } });
    const off = calc45DTE({ ...base, ...rich, ratioSpec: { ratio: '1:2', protect: false } });
    const rate = (res) => res.ratings.find(s => s.name === 'Ratio spread').rating;
    expect(['EXCELLENT', 'GOOD']).toContain(rate(on));
    expect(rate(off)).toBe('MARGINAL');
    expect(off.bestStrat).not.toBe('Ratio spread');
  });
});

describe('the protective long follows the other legs', () => {
  it('re-places after a hand-edited short, but keeps a typed protective strike', () => {
    const r0 = run({ ratio: '1:2', protect: true });
    const si = r0.legs.findIndex(l => /short/i.test(l.label));
    const pi = r0.legs.findIndex(l => /protective/i.test(l.label));
    const moved = run({ ratio: '1:2', protect: true }, {
      overrideStrikes: { [si]: 630 }, overrideStrikesStrat: 'Ratio spread' });
    expect(moved.legs[pi].strike).toBe(660);                  // 630 + (630 − 600)
    const typed = run({ ratio: '1:2', protect: true }, {
      overrideStrikes: { [si]: 630, [pi]: 670 }, overrideStrikesStrat: 'Ratio spread' });
    expect(typed.legs[pi].strike).toBe(670);
    expect(typed.ratio.tailLoss).toBeGreaterThan(0);          // further out than zero-risk
    expect(typed.warnings.some(w => /past the zero-risk strike/.test(w))).toBe(true);
  });

  it('reprotect is a no-op on legs without a protective long', () => {
    const legs = [{ label: 'Long call', strike: 600 }, { label: 'Short call x2', strike: 620 }];
    expect(reprotect(legs, { step: 1 })).toBe(legs);
  });

  it('delta strikes move the short and re-place the protective long beyond it', () => {
    const legs = buildRatioLegs({ p: 600, sd50: 23, R: n => Math.round(n), step: 1, isBear: false, spec: { ratio: '2:3', protect: true } });
    // Short at 623 reads 35Δ — too close; the plan moves it out toward 25Δ.
    const plan = deltaStrikePlan({ legs, strat: 'Ratio spread', horizon: '45dte', price: 600,
      legGreeks: [{ strike: 623, right: 'C', delta: 0.35, iv: 22 }], T: 45 / 365, underlying: 'QQQ' });
    expect(plan).not.toBeNull();
    const { long, short, prot } = byRole(plan.legs);
    expect(short.strike).toBeGreaterThan(623);
    expect(long.strike).toBe(600);
    expect(prot.strike).toBe(zeroRiskStrike(long.strike, short.strike, 2, 3));
    expect(prot.strike).toBeGreaterThan(short.strike);
  });
});
