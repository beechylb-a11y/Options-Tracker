/* The accrual table exists to answer one question before a trade rather than after
   it: does the holding plan collect the value, or a tenth of it. These tests pin the
   arithmetic to the SPY 759/763/768 fly of 29 Sep, where the answer was a tenth. */
import { describe, it, expect } from 'vitest';
import {
  accrualTable, windowShare, sessionsToExpiry, sigmaFromEM,
  structureValue, intrinsicValue, ceiling, bsPrice,
} from '../engine/accrual';

const FLY = [
  { strike: 759, right: 'C', ratio: 1 },
  { strike: 763, right: 'C', ratio: -2 },
  { strike: 768, right: 'C', ratio: 1 },
];
const EM = 5.0, SPOT = 765;

describe('accrual', () => {
  it('prices a call the textbook way', () => {
    // ATM, 1 year, 20% vol → ~7.97% of spot.
    expect(bsPrice(100, 100, 1, 0.2, 'C')).toBeCloseTo(7.97, 1);
    // Put-call parity at zero rates: C - P = S - K.
    const c = bsPrice(105, 100, 0.5, 0.25, 'C'), p = bsPrice(105, 100, 0.5, 0.25, 'P');
    expect(c - p).toBeCloseTo(5, 6);
  });

  it('finds the body and the ceiling from the strikes alone', () => {
    expect(ceiling(FLY)).toEqual({ strike: 763, value: 4 });
    // Broken wing: 4 points up, 5 down at equal quantities is short a point above 768.
    expect(intrinsicValue(FLY, 775)).toBe(-1);
  });

  it('converges to intrinsic at expiry', () => {
    expect(structureValue(FLY, 763, 0, 0.1)).toBeCloseTo(4, 6);
    expect(structureValue(FLY, 775, 0, 0.1)).toBeCloseTo(-1, 6);
  });

  it('derives sigma from the session expected move', () => {
    // 5.0 pts on 765 over one session, annualised over 252.
    expect(sigmaFromEM(EM, SPOT)).toBeCloseTo(0.1038, 3);
    expect(sigmaFromEM(0, SPOT)).toBeNaN();
  });

  it('counts sessions to expiry across the bell', () => {
    expect(sessionsToExpiry(6.5, 0)).toBeCloseTo(1, 6);
    expect(sessionsToExpiry(4.42, 1)).toBeCloseTo(1.68, 2);   // 11:35 ET, expiring tomorrow
    expect(sessionsToExpiry(0, 0)).toBe(0);
  });

  it('back-loads the value onto expiry day', () => {
    const t = accrualTable({ legs: FLY, spot: SPOT, em: EM, sessionsLeft: sessionsToExpiry(4.42, 1) });
    expect(t.bodyStrike).toBe(763);
    expect(t.maxValue).toBe(4);
    // Worth a fraction of the ceiling with a day to run — the whole point.
    expect(t.now.pctOfMax).toBeLessThan(25);
    // Monotonically rising toward expiry when spot sits on the body.
    const vals = t.rows.map(r => r.atBody);
    for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeGreaterThan(vals[i - 1]);
    expect(vals[vals.length - 1]).toBeCloseTo(4, 6);
    // Shares of the remaining move sum to 100.
    const shares = t.rows.slice(1).reduce((a, r) => a + r.shareOfRemaining, 0);
    expect(shares).toBeCloseTo(100, 6);
    // The last two checkpoints carry more than the first half of the life.
    const tail = t.rows.slice(-2).reduce((a, r) => a + r.shareOfRemaining, 0);
    expect(tail).toBeGreaterThan(30);
  });

  it('prices the plan that was actually run at under a tenth', () => {
    const entry = sessionsToExpiry(4.42, 1);      // 11:35 on the 29th
    const exit = sessionsToExpiry(0.42, 1);       // 15:35 on the 29th, still a day out
    const w = windowShare({ legs: FLY, spot: SPOT, em: EM, sessionsLeft: entry, exitSessionsLeft: exit });
    expect(w.pct).toBeLessThan(12);
    expect(w.verdict).toMatch(/leaves most of the value/);
  });

  it('rates holding into the final hour as capturing most of it', () => {
    const entry = sessionsToExpiry(4.42, 1);
    const late = windowShare({ legs: FLY, spot: SPOT, em: EM, sessionsLeft: entry,
      exitSessionsLeft: sessionsToExpiry(0.08, 0) });
    expect(late.pct).toBeGreaterThan(80);
    expect(late.verdict).toMatch(/most of the move/);
    const mid = windowShare({ legs: FLY, spot: SPOT, em: EM, sessionsLeft: entry,
      exitSessionsLeft: sessionsToExpiry(2, 0) });
    expect(mid.pct).toBeGreaterThan(late.pct - 100);
    expect(mid.pct).toBeLessThan(late.pct);
  });

  it('returns null rather than a guess when an input is missing', () => {
    expect(accrualTable({ legs: [], spot: SPOT, em: EM, sessionsLeft: 1 })).toBeNull();
    expect(accrualTable({ legs: FLY, spot: SPOT, em: EM, sessionsLeft: 0 })).toBeNull();
    expect(accrualTable({ legs: FLY, spot: SPOT, em: 0, sessionsLeft: 1 })).toBeNull();
    expect(accrualTable({ legs: FLY, spot: 0, em: EM, sessionsLeft: 1 })).toBeNull();
  });

  it('handles a put structure the same way', () => {
    const putFly = [
      { strike: 737, right: 'P', ratio: 1 },
      { strike: 734, right: 'P', ratio: -2 },
      { strike: 729, right: 'P', ratio: 1 },
    ];
    const t = accrualTable({ legs: putFly, spot: 736, em: 4, sessionsLeft: 0.5 });
    expect(t.bodyStrike).toBe(734);
    expect(t.maxValue).toBe(3);
    expect(t.rows[t.rows.length - 1].atBody).toBeCloseTo(3, 6);
  });
});
