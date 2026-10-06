/* 45DTE daily trend read (Oct 2026): SMA 20/50 stacking + slope + ADX(14) set the
   engine's outlook; stretch, acceptance and HV10/HV60 qualify it. */
import { describe, it, expect } from 'vitest';
import { computeTrend, adx, realisedVol, trendFit } from '../engine/trend';
import { calc45DTE } from '../engine/calc45dte';

// Bars from a close path; high/low a fixed fraction around the close.
function barsFrom(closes, wiggle = 0.004) {
  return closes.map((c, i) => {
    const prev = i ? closes[i - 1] : c;
    return [String(20250101 + i), prev, Math.max(c, prev) * (1 + wiggle), Math.min(c, prev) * (1 - wiggle), c];
  });
}
// deterministic noise
function lcg(seed) { let s = seed; return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648) - 0.5; }

describe('ADX', () => {
  it('is high in a steady trend and low in chop', () => {
    const up = barsFrom(Array.from({ length: 120 }, (_, i) => 500 * (1 + 0.004 * i)));
    const a = adx(up.map(b => b[2]), up.map(b => b[3]), up.map(b => b[4]));
    expect(a.adx).toBeGreaterThan(40);
    expect(a.plusDI).toBeGreaterThan(a.minusDI);
    const rnd = lcg(7);
    let p = 500;
    const chop = barsFrom(Array.from({ length: 120 }, (_, i) => (p = 500 + 6 * Math.sin(i / 2.3) + rnd() * 4)));
    expect(adx(chop.map(b => b[2]), chop.map(b => b[3]), chop.map(b => b[4])).adx).toBeLessThan(20);
  });
  it('needs 2n+1 bars', () => {
    expect(adx([1, 2], [1, 2], [1, 2])).toBeNull();
  });
});

describe('computeTrend', () => {
  it('calls a stacked, sloping, strong trend bullish', () => {
    const rnd = lcg(3);
    const t = computeTrend(barsFrom(Array.from({ length: 200 }, (_, i) => 600 * (1 + 0.0025 * i) * (1 + rnd() * 0.006))));
    expect(t.outlook).toBe('bullish');
    expect(t.strength).not.toBe('range');
    expect(t.pctVs50).toBeGreaterThan(0);
    expect(t.accept10).toBeGreaterThanOrEqual(0.7);
  });
  it('calls the mirror bearish', () => {
    const rnd = lcg(5);
    const t = computeTrend(barsFrom(Array.from({ length: 200 }, (_, i) => 600 * (1 - 0.0025 * i) * (1 + rnd() * 0.006))));
    expect(t.outlook).toBe('bearish');
  });
  it('stays neutral in a range, and says why', () => {
    const rnd = lcg(11);
    const t = computeTrend(barsFrom(Array.from({ length: 200 }, (_, i) => 600 + 8 * Math.sin(i / 3) + rnd() * 5)));
    expect(t.outlook).toBe('neutral');
    expect(t.why).toMatch(/range|not stacked/);
  });
  it('flags a stretch and a coiled realised vol', () => {
    const rnd = lcg(13);
    const flat = Array.from({ length: 180 }, (_, i) => 600 * (1 + rnd() * 0.03));      // noisy 60 days...
    const quiet = Array.from({ length: 19 }, () => 600 * (1 + rnd() * 0.002));        // ...then very quiet
    const t = computeTrend(barsFrom([...flat, ...quiet, 630]));                         // then a jump
    expect(t.stretch).toBe('stretched up');
    expect(t.z20).toBeGreaterThan(2);
    const t2 = computeTrend(barsFrom([...flat, ...quiet, 600.2]));
    expect(t2.hvRegime).toBe('coiled');
  });
  it('returns null on too little history', () => {
    expect(computeTrend(barsFrom([1, 2, 3]))).toBeNull();
    expect(computeTrend(null)).toBeNull();
  });
  it('annualises close-to-close vol', () => {
    const closes = [100]; for (let i = 0; i < 30; i++) closes.push(closes[i] * (i % 2 ? 1.01 : 0.99));
    expect(realisedVol(closes, 20)).toBeGreaterThan(14);
    expect(realisedVol(closes, 20)).toBeLessThan(18);
  });
  it('says whether a position delta fights the trend', () => {
    expect(trendFit({ outlook: 'bullish' }, -12)).toBe(-1);
    expect(trendFit({ outlook: 'bullish' }, 12)).toBe(1);
    expect(trendFit({ outlook: 'neutral' }, 12)).toBe(0);
  });
});

describe('45DTE engine reads the backdrop', () => {
  const base = { underlying: 'SPX', price: 7410, ivr: 45, iv: 18, hv: 14, vix: 17, ivFront: 17, ivBack: 18.5, skew: 4,
    termBias: '', dte: 45, pop: 0, win: 0, risk: 0, bankroll: 25000, startBR: 25000, maxLoss: 600, maxOpen: 900,
    bpr: 0, theta: 0, vega: 0, delta: 0, outlook: 'neutral', overrideStrategy: null };
  it('warns on coiled realised vol for a premium seller and on VIX above VIX3M', () => {
    const r = calc45DTE({ ...base, trend: { stretch: 'normal', z20: 0.3, hvRegime: 'coiled', hvRatio: 0.55 }, vixTermRatio: 1.04 });
    expect(r.warnings.join(' | ')).toMatch(/coiled/);
    expect(r.warnings.join(' | ')).toMatch(/VIX above VIX3M/);
  });
  it('warns a bullish entry when price is stretched up', () => {
    const r = calc45DTE({ ...base, outlook: 'bullish', trend: { stretch: 'stretched up', z20: 2.4, hvRegime: 'steady', hvRatio: 1 } });
    expect(r.warnings.join(' | ')).toMatch(/stretched 2.4σ above/);
  });
  it('is unchanged with no trend', () => {
    const a = calc45DTE(base), b = calc45DTE({ ...base, trend: null });
    expect(b.warnings).toEqual(a.warnings);
  });
});
