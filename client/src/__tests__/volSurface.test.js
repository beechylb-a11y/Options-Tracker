/* Vol surface (Oct 2026): the bridge helpers that turn TWS data into the 45DTE
   panel's numbers, and the engine's term-bias derivation that replaced the
   contango-by-default dropdown. */
import { describe, it, expect } from 'vitest';
import { nearestExpiry, fridayNear, strikeForDelta, interpAtDelta, termBiasFromIV as bridgeTerm,
  ivRankStats, realisedVol, daysBetween, TERM_FLAT_LO, TERM_FLAT_HI } from '../../../bridge/volSurface.js';
import { calc45DTE, termBiasFromIV, TERM_FLAT_LO as ENG_LO, TERM_FLAT_HI as ENG_HI } from '../engine/calc45dte.js';

const base = { underlying: 'SPX', price: 6700, ivr: 40, iv: 16, hv: 13, vix: 16, dte: 45,
  outlook: 'neutral', pop: 70, win: 300, risk: 700, bankroll: 50000, startBR: 50000,
  maxLoss: 2, maxOpen: 5, bpr: 700, theta: 20, vega: -30, delta: 1 };

describe('bridge vol helpers', () => {
  it('picks the listed expiry nearest each target, honouring the minimum DTE', () => {
    const today = '20261006';
    const exps = ['20261009', '20261016', '20261106', '20261120', '20261218', '20270115'];
    expect(nearestExpiry(exps, '20261120', today, 1)).toBe('20261120');
    expect(nearestExpiry(exps, '20261012', today, 14)).toBe('20261106'); // too-short expiries skipped
    expect(daysBetween(today, '20270115')).toBe(101);
  });

  it('snaps to the nearest Friday when the chain is unavailable', () => {
    expect(fridayNear('20261122')).toBe('20261120'); // Sun → back
    expect(fridayNear('20261117')).toBe('20261120'); // Tue → forward
    expect(fridayNear('20261120')).toBe('20261120');
  });

  it('places flat-vol 25Δ strikes either side of spot', () => {
    const kp = strikeForDelta(6700, 0.16, 45 / 365, 'P'), kc = strikeForDelta(6700, 0.16, 45 / 365, 'C');
    expect(kp).toBeLessThan(6700); expect(kc).toBeGreaterThan(6700);
    expect(6700 - kp).toBeGreaterThan(200); expect(kc - 6700).toBeGreaterThan(200);
  });

  it('interpolates IV at exactly 25Δ, and uses the nearer point when not bracketed', () => {
    const a = interpAtDelta([{ strike: 6300, iv: 20, delta: -0.30 }, { strike: 6200, iv: 22, delta: -0.20 }]);
    expect(a.interpolated).toBe(true); expect(a.iv).toBeCloseTo(21, 6); expect(a.strike).toBeCloseTo(6250, 6);
    const b = interpAtDelta([{ strike: 6300, iv: 20, delta: -0.31 }, { strike: 6280, iv: 20.4, delta: -0.29 }]);
    expect(b.interpolated).toBe(false); expect(b.delta).toBeCloseTo(0.29, 6);
  });

  it('ranks IV against its 52-week range and reports the percentile alongside', () => {
    const s = [...Array(251).fill(15), 25]; s[0] = 10;
    const r = ivRankStats(s);
    expect(r.rank).toBe(100); expect(r.low).toBe(10); expect(r.high).toBe(25);
    expect(ivRankStats([12, 13])).toBeNull(); // too short to rank
  });

  it('computes close-to-close realised vol', () => {
    expect(realisedVol(Array(31).fill(100), 30)).toBe(0);
    expect(realisedVol([100, 101], 30)).toBeNull();
  });
});

describe('term bias', () => {
  it('uses the same thresholds in the bridge and the engine', () => {
    expect(ENG_LO).toBe(TERM_FLAT_LO); expect(ENG_HI).toBe(TERM_FLAT_HI);
    for (const [f, b] of [[14, 16.5], [16, 16.5], [17, 16.5], [22, 18]]) {
      expect(termBiasFromIV(f, b)).toBe(bridgeTerm(f, b).bias);
    }
  });

  it('derives contango / flat / backwardation from front over back', () => {
    expect(termBiasFromIV(14.2, 16.5)).toBe('contango');
    expect(termBiasFromIV(16.4, 16.5)).toBe('flat');
    expect(termBiasFromIV(19, 16.5)).toBe('backwardation');
    expect(termBiasFromIV(0, 16.5)).toBe('');
  });

  it('ignores the dropdown when Front/Back are present', () => {
    const r = calc45DTE({ ...base, termBias: 'contango', ivFront: 22, ivBack: 18 });
    expect(r.termBias).toBe('backwardation');
    expect(r.termDerived).toBe(true);
    expect(r.termDiff).toBeCloseTo(-4, 6); // back − front: negative = backwardation
    expect(r.decision === 'NO TRADE' || /Backwardation/.test(JSON.stringify(r))).toBe(true);
  });

  it('scores an unknown term structure zero instead of free contango points', () => {
    const unknown = calc45DTE({ ...base, termBias: '', ivFront: 0, ivBack: 0 });
    const contango = calc45DTE({ ...base, termBias: '', ivFront: 14, ivBack: 17 });
    const pts = r => r.criteria.find(c => /^Term structure/.test(c.label)).pts;
    expect(pts(unknown)).toBe(0); expect(pts(contango)).toBe(15);
    expect(unknown.warnings.some(w => /Term structure unknown/.test(w))).toBe(true);
  });

  it('still honours a manual dropdown when Front/Back are missing', () => {
    const r = calc45DTE({ ...base, termBias: 'flat', ivFront: 0, ivBack: 0 });
    expect(r.termBias).toBe('flat'); expect(r.termDerived).toBe(false);
  });
});
