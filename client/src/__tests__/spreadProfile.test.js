/* Spread by time of day. The point of measuring is to replace a rule of thumb, so
   these tests check the statistic recovers a shape it is given, and — more
   importantly — that it does not manufacture one out of noise. */
import { describe, it, expect } from 'vitest';
import { spreadProfile, etSlot, median } from '../../../bridge/replay.js';

// 09:30 ET on 2026-10-05 is 13:30 UTC (EDT).
const OPEN = Date.UTC(2026, 9, 5, 13, 30, 0) / 1000;
const build = (shape, dayCount = 3, step = 15) => {
  const bars = [];
  for (let d = 0; d < dayCount; d++)
    for (let m = 0; m < 390; m += step)
      bars.push({ t: OPEN + d * 86400 + m * 60, mid: -2.65, spread: shape(m, d) });
  return bars;
};

describe('spread profile', () => {
  it('buckets into ET half-hours across the DST-stable part of the year', () => {
    expect(etSlot(OPEN)).toMatchObject({ slot: '09:30', date: '2026-10-05' });
    expect(etSlot(OPEN + 15 * 60).slot).toBe('09:30');
    expect(etSlot(OPEN + 30 * 60).slot).toBe('10:00');
    expect(etSlot(OPEN + 380 * 60).slot).toBe('15:30');
  });

  it('takes the median so one stale print cannot move a window', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, NaN, 3, null])).toBe(2);
    expect(median([])).toBeNull();
    // A single 10.0 outlier among tight quotes must not become the answer — note
    // it has to be ONE print, on one day. A stale quote that recurs at the same
    // minute every session is not an outlier, it is the market, and the median is
    // right to report it.
    const bars = build((m, d) => (m === 60 && d === 0 ? 10 : 0.12));
    const p = spreadProfile(bars);
    expect(p.rows.every(r => r.medianSpread < 0.2)).toBe(true);
    // Whereas the same width every day does move it, correctly.
    const persistent = spreadProfile(build((m) => (m === 60 ? 10 : 0.12)));
    expect(persistent.widest.slot).toBe('10:30');
  });

  it('recovers a planted U and names the right windows', () => {
    const U = m => m < 30 ? 0.40 : m < 60 ? 0.26 : m < 210 ? 0.12 : m < 330 ? 0.18 : m < 375 ? 0.30 : 0.46;
    const p = spreadProfile(build(U), { refPrice: 2.60 });
    expect(p.sessions).toBe(3);
    expect(p.tightest.slot).toBe('10:30');
    expect(p.widest.slot).toBe('09:30');
    expect(p.saving).toBeCloseTo((0.40 - 0.12) / 2, 3);
    // Cost to cross is half the spread, and the percentage is against the trade.
    const t = p.tightest;
    expect(t.crossCost).toBeCloseTo(t.medianSpread / 2, 6);
    expect(t.pctOfTrade).toBeCloseTo(100 * (t.medianSpread / 2) / 2.60, 0);
  });

  it('reports a flat day as flat rather than inventing a best window', () => {
    const p = spreadProfile(build(() => 0.20), { refPrice: 2.60 });
    expect(p.spreadRatio).toBe(1);
    expect(p.saving).toBe(0);
  });

  it('ignores quotes outside the regular session', () => {
    const bars = build(() => 0.15);
    bars.push({ t: OPEN - 120 * 60, mid: -2.6, spread: 5 });   // 07:30 ET
    bars.push({ t: OPEN + 400 * 60, mid: -2.6, spread: 5 });   // 16:10 ET
    const p = spreadProfile(bars);
    expect(p.rows.every(r => Number(r.slot.slice(0, 2)) >= 9)).toBe(true);
    expect(p.widest.medianSpread).toBeLessThan(1);
  });

  it('drops impossible spreads and thin buckets instead of reporting them', () => {
    const bars = build(() => 0.15);
    bars.push({ t: OPEN + 5 * 60, mid: -2.6, spread: -1 });
    const p = spreadProfile(bars, { minBars: 2 });
    expect(p.rows.every(r => r.medianSpread >= 0)).toBe(true);
    // One lonely bar in a half-hour is not a measurement.
    const sparse = spreadProfile([{ t: OPEN, mid: -2.6, spread: 0.2 }], { minBars: 2 });
    expect(sparse).toBeNull();
  });

  it('says nothing rather than guessing with no input', () => {
    expect(spreadProfile([])).toBeNull();
    expect(spreadProfile(null)).toBeNull();
  });
});
