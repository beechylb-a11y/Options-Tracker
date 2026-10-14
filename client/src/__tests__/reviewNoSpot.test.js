/* A missing underlying price must stop the check-up, not quietly invert it.

   The QQQ 699/709/805/815 condor of 14 Oct read "the 709P is tested (23Δ)" when the
   tested mark is 30Δ, and recommended rolling the call side. Both came from a spot
   of zero: `toward` for a put is (spot − strike), so with no price that is −709,
   `itm` fires, and every short put in the book reads in the money. The strike strip
   required a real spot and so drew nothing, which is why the card looked unchanged
   after the patch — the bug and the missing diagram were the same fault. */
import { describe, it, expect } from 'vitest';
import { reviewOpen45 } from '../engine/review45';

const CONDOR = [
  { strike: 699, right: 'P', qty: 1, expiry: '20261120', delta: -0.09, iv: 20 },
  { strike: 709, right: 'P', qty: -1, expiry: '20261120', delta: -0.23, iv: 20 },
  { strike: 805, right: 'C', qty: -1, expiry: '20261120', delta: 0.07, iv: 20 },
  { strike: 815, right: 'C', qty: 1, expiry: '20261120', delta: 0.04, iv: 20 },
];
const base = {
  strategy: 'QQQ - Iron Condor - Normal - 5 contracts', legs: CONDOR, qtyOpen: 5,
  entry: { dateYmd: '20261008', ncd: 2.445, spot: 742, iv: 20 },
  underlying: 'QQQ',
};
const at = spot => reviewOpen45({ ...base, now: { todayYmd: '20261014', spot, iv: 20, mark: -2.04 } });

describe('no underlying price', () => {
  it('refuses to review instead of inventing a tested side', () => {
    for (const spot of [0, null, undefined, NaN]) {
      const r = at(spot);
      expect(r.action).toBe('unknown');
      expect(r.headline).toMatch(/no underlying price/i);
    }
  });

  it('says what is wrong and names the underlying', () => {
    const r = at(0);
    expect(r.warnings.join(' ')).toMatch(/QQQ/);
    expect(r.warnings.join(' ')).toMatch(/in the money/i);
  });

  it('does NOT recommend a roll off a price it does not have', () => {
    expect(at(0).action).not.toBe('roll-untested');
  });

  it('with a real price, a 23Δ short is not tested — 30Δ is the mark', () => {
    const r = at(742);
    const short709 = r.metrics.shorts.find(s => s.strike === 709);
    expect(short709.absDelta).toBeCloseTo(0.23, 2);
    expect(short709.itm).toBe(false);
    expect(short709.tested).toBe(false);
    expect(r.action).not.toBe('roll-untested');
  });

  it('and reviews normally — the guard only catches a missing price', () => {
    const r = at(742);
    expect(r.action).toBeTruthy();
    expect(r.action).not.toBe('unknown');
    expect(r.metrics.ncd).toBeCloseTo(2.445, 3);
  });

  it('still fires the roll when a short really is tested', () => {
    // Price down at 715: the 709 put is genuinely close, at 34Δ.
    const tested = CONDOR.map(l => l.strike === 709 ? { ...l, delta: -0.34 } : l);
    const r = reviewOpen45({ ...base, legs: tested, now: { todayYmd: '20261014', spot: 715, iv: 20, mark: -3.1 } });
    expect(r.metrics.shorts.find(s => s.strike === 709).tested).toBe(true);
    expect(r.action).toBe('roll-untested');
  });
});
