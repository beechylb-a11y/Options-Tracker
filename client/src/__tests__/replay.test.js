/* The replay composition is the one piece that decides whether a postmortem is
   built on real numbers, so it is tested against the failure that motivated it:
   a leg that stops quoting, and a crossed quote. */
import { describe, it, expect } from 'vitest';
import { parseLegs, composeCombo, summarise, geometry, intrinsic, legKey }
  from '../../../bridge/replay.js';

const legs = parseLegs('759C:1,763C:-2,768C:1');
const t0 = 1790000000;

function series({ stale = [], crossed = [] } = {}) {
  const out = {}; const und = [];
  for (const l of legs) out[legKey(l)] = { bid: [], ask: [] };
  for (let i = 0; i < 20; i++) {
    const t = String(t0 + i * 300);
    const S = 766 - 3 * (i / 19);
    und.push({ date: t, close: S, high: S + 0.2, low: S - 0.2 });
    for (const l of legs) {
      const v = Math.max(S - l.strike, 0) + 0.9 * (1 - i / 20) + 0.25;
      let bid = v - 0.02, ask = v + 0.02;
      if (crossed.includes(i) && l.strike === 759) ask = bid - 0.5;
      out[legKey(l)].bid.push({ date: t, close: bid });
      out[legKey(l)].ask.push({ date: t, close: ask });
    }
  }
  for (const i of stale) for (const side of ['bid', 'ask'])
    out['763C'][side] = out['763C'][side].filter(b => b.date !== String(t0 + i * 300));
  return { legBars: out, und };
}

describe('replay composition', () => {
  it('reads the geometry off the strikes', () => {
    expect(geometry(legs)).toMatchObject({ bodyStrike: 763, maxIntrinsic: 4 });
    // Broken wing: 4 up, 5 down at equal quantities is short a point above 768.
    expect(intrinsic(legs, 775)).toBe(-1);
    expect(intrinsic(legs, 763)).toBe(4);
  });

  it('rejects malformed legs rather than pricing the wrong structure', () => {
    expect(() => parseLegs('763C:0')).toThrow(/ratio 0/);
    expect(() => parseLegs('763X:1')).toThrow(/Bad leg/);
    expect(parseLegs('735P:-2')[0]).toMatchObject({ strike: 735, right: 'P', ratio: -2 });
  });

  it('drops a bar where any leg stopped quoting', () => {
    const { legBars, und } = series({ stale: [5, 6] });
    const { bars, dropped } = composeCombo(legs, legBars, und);
    expect(dropped).toBe(2);
    expect(bars.length).toBe(18);
    // A partial bar would have priced a two-leg structure and looked plausible.
    expect(bars.some(b => b.t === t0 + 5 * 300)).toBe(false);
  });

  it('drops crossed quotes and never reports a negative spread', () => {
    const { legBars, und } = series({ crossed: [3] });
    const { bars, dropped } = composeCombo(legs, legBars, und);
    expect(dropped).toBe(1);
    expect(bars.every(b => b.spread >= 0)).toBe(true);
  });

  it('sums the spread across every leg by magnitude, shorts included', () => {
    const { legBars, und } = series();
    const { bars } = composeCombo(legs, legBars, und);
    // 0.04 per leg x (1 + 2 + 1) = 0.16 — the real cost of the round trip, which
    // is the number the TWS combo chart cannot show.
    expect(bars[0].spread).toBeCloseTo(0.16, 3);
  });

  it('summarises the hold against the structure ceiling and the spread', () => {
    const { legBars, und } = series();
    const { bars } = composeCombo(legs, legBars, und);
    const s = summarise(legs, bars, { entryEpoch: t0 + 2 * 300, exitEpoch: t0 + 15 * 300 });
    expect(s.bodyStrike).toBe(763);
    expect(s.entry.spot).toBeGreaterThan(s.exit.spot);      // drifting toward the body
    expect(s.pctOfMaxAtExit).toBeGreaterThan(s.pctOfMaxAtEntry);
    expect(s.avgSpread).toBeCloseTo(0.16, 3);
    // The headline judgement: is the move worth more than getting in and out?
    expect(s.rangeInSpreads).toBeGreaterThan(1);
    expect(s.spotVsBodyEntry).toBeGreaterThan(s.spotVsBodyExit);
  });

  it('returns nothing rather than guessing when no bars align', () => {
    expect(summarise(legs, [])).toBeNull();
    const { bars, dropped } = composeCombo(legs, {}, []);
    expect(bars).toEqual([]); expect(dropped).toBe(0);
  });
});
