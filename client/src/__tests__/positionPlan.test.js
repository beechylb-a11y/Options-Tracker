/* The QQQ 699/709/805/815 condor of the 14 Oct check-up, as a worked example.
   Taken for 2.445 credit; by the check-up the 709P was the side under pressure and
   the 805C had decayed to 7Δ, and the card said "roll the untested call side toward
   price — short to roughly 25–30Δ" without saying what that would cost. */
import { describe, it, expect } from 'vitest';
import { payoffShape, positionStrip, rollCandidates, planRoll, valueAt } from '../engine/positionPlan';

const CONDOR = [
  { strike: 699, right: 'P', qty: 1 }, { strike: 709, right: 'P', qty: -1 },
  { strike: 805, right: 'C', qty: -1 }, { strike: 815, right: 'C', qty: 1 },
];
const CREDIT = 2.445;

describe('payoffShape', () => {
  it('finds both break-evens on a condor without being told it is one', () => {
    const s = payoffShape(CONDOR, CREDIT);
    expect(s.breakevens).toHaveLength(2);
    expect(s.breakevens[0]).toBeCloseTo(709 - CREDIT, 1);   // 706.56
    expect(s.breakevens[1]).toBeCloseTo(805 + CREDIT, 1);   // 807.45
  });

  it('gets max profit and max loss right', () => {
    const s = payoffShape(CONDOR, CREDIT);
    expect(s.maxProfit).toBeCloseTo(2.445, 2);              // the credit, between the shorts
    expect(s.maxLoss).toBeCloseTo(-(10 - 2.445), 2);        // width less the credit
  });

  it('handles a broken wing with the same code', () => {
    // +1 7785 / −2 7810 / +1 7845 calls for a 9.90 debit: 25 up, 35 down.
    const bwb = [
      { strike: 7785, right: 'C', qty: 1 }, { strike: 7810, right: 'C', qty: -2 },
      { strike: 7845, right: 'C', qty: 1 },
    ];
    const s = payoffShape(bwb, -9.90);
    expect(s.maxProfit).toBeCloseTo(25 - 9.90, 1);
    expect(s.maxLoss).toBeCloseTo(-(10 + 9.90), 1);
    expect(valueAt(bwb, 7900)).toBeCloseTo(-10, 6);          // flat beyond the far wing
  });
});

describe('positionStrip', () => {
  const strip = positionStrip({ legs: CONDOR, spot: 740, ncd: CREDIT, testedStrike: 709 });

  it('places price and every strike on one 0..1 axis, in order', () => {
    expect(strip.spot.x).toBeGreaterThan(0);
    expect(strip.spot.x).toBeLessThan(1);
    const xs = strip.strikes.map(s => s.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  });

  it('knows the position is currently in the profit band', () => {
    expect(strip.spot.inProfit).toBe(true);
    expect(strip.zone.from).toBeCloseTo(706.56, 1);
    expect(strip.zone.to).toBeCloseTo(807.45, 1);
    expect(strip.zone.x0).toBeLessThan(strip.spot.x);
    expect(strip.zone.x1).toBeGreaterThan(strip.spot.x);
  });

  it('marks which short is the tested one, and which legs are short', () => {
    const tested = strip.strikes.filter(s => s.tested);
    expect(tested).toHaveLength(1);
    expect(tested[0].strike).toBe(709);
    expect(strip.strikes.filter(s => s.short).map(s => s.strike)).toEqual([709, 805]);
  });

  it('says so when price has left the band', () => {
    expect(positionStrip({ legs: CONDOR, spot: 690, ncd: CREDIT }).spot.inProfit).toBe(false);
  });
});

describe('rollCandidates', () => {
  const listed = Array.from({ length: 60 }, (_, i) => 700 + i * 5);   // 700..995 in 5s

  it('only offers listed strikes between price and the old short', () => {
    const c = rollCandidates({ listed, spot: 740, right: 'C', keepWidth: 10, oldShort: 805 });
    expect(c.every(k => k > 740 && k < 805)).toBe(true);
    expect(c.every(k => listed.includes(k + 10))).toBe(true);
  });

  it('refuses to move a short away from price', () => {
    const c = rollCandidates({ listed, spot: 740, right: 'C', keepWidth: 10, oldShort: 745 });
    expect(c.every(k => k < 745)).toBe(true);
  });

  it('drops a strike whose wing is not listed', () => {
    const gappy = [745, 750, 755, 760];     // 755+10 and 760+10 do not exist
    const c = rollCandidates({ listed: gappy, spot: 740, right: 'C', keepWidth: 10, oldShort: 805 });
    expect(c).toEqual([745, 750]);
  });
});

describe('planRoll — what the roll actually costs', () => {
  // Candidate calls around 770 on a ~740 spot, with the 805/815 pair nearly worthless.
  const quoted = [
    { strike: 765, right: 'C', delta: 0.32, bid: 8.0, ask: 8.4 },
    { strike: 770, right: 'C', delta: 0.27, bid: 6.3, ask: 6.7 },
    { strike: 775, right: 'C', delta: 0.22, bid: 4.9, ask: 5.3 },
    { strike: 780, right: 'C', delta: 0.18, bid: 3.7, ask: 4.1 },
    { strike: 785, right: 'C', delta: 0.14, bid: 2.7, ask: 3.1 },
  ];
  const plan = planRoll({ quoted, keepWidth: 10, right: 'C', spot: 740, ncd: CREDIT,
    oldShort: 805, oldLong: 815, testedShort: 709, closeOld: 0.20 });

  it('picks the listed short nearest 25-30 delta and keeps the width', () => {
    expect(plan.shortStrike).toBe(770);
    expect(plan.longStrike).toBe(780);
    expect(plan.delta).toBeCloseTo(0.27, 2);
  });

  it('prices the roll net of buying the old pair back', () => {
    expect(plan.newCredit).toBeCloseTo(6.5 - 3.9, 2);   // 2.60
    expect(plan.net).toBeCloseTo(2.40, 2);              // less the 0.20 to close
    expect(plan.creditTotalAfter).toBeCloseTo(4.845, 2);
  });

  it('states both halves: cushion bought and room given up', () => {
    // Put-side break-even improves by the extra credit.
    expect(plan.cushionGained).toBeCloseTo(2.40, 2);
    // Call-side break-even falls from 807.45 to 774.85 — a 32.6 point give-up.
    expect(plan.breakevenAfter).toBeCloseTo(774.85, 1);
    expect(plan.roomGiven).toBeCloseTo(32.60, 1);
    expect(plan.worthIt).toBe(false);   // it buys 2.4 and costs 32.6 — a trade, not free credit
  });

  it('returns nothing rather than a guess when the wing is not quoted', () => {
    expect(planRoll({ quoted: [quoted[1]], keepWidth: 10, right: 'C', spot: 740, ncd: CREDIT })).toBeNull();
    expect(planRoll({ quoted: [], keepWidth: 10, right: 'C', spot: 740, ncd: CREDIT })).toBeNull();
  });
});
