/* Working orders, entry fills, and exposure. Built around the QQQ 695/705/805/815
   condor of 7 Oct, which was sent at a mid limit of 2.60 credit and never filled. */
import { describe, it, expect } from 'vitest';
import { STATUS, statusOf, fillQuality, blendFills, exposure, fillStats } from '../engine/fills';

describe('status', () => {
  it('names all five states, reading the entry side first', () => {
    expect(statusOf({ qty: 5, qtyFilled: 0, qtyClosed: 0 })).toBe(STATUS.WORKING);
    expect(statusOf({ qty: 5, qtyFilled: 2, qtyClosed: 0 })).toBe(STATUS.PART_FILLED);
    expect(statusOf({ qty: 5, qtyFilled: 5, qtyClosed: 0 })).toBe(STATUS.OPEN);
    expect(statusOf({ qty: 5, qtyFilled: 5, qtyClosed: 2 })).toBe(STATUS.PART_CLOSED);
    expect(statusOf({ qty: 5, qtyFilled: 5, qtyClosed: 5 })).toBe(STATUS.CLOSED);
  });

  it('separates a cancelled order from a closed trade', () => {
    // Pulling an unfilled order is a decision, not a losing trade, and must never
    // reach the batting average as one.
    expect(statusOf({ qty: 5, qtyFilled: 0, qtyClosed: 0, cancelled: true })).toBe(STATUS.CANCELLED);
    // But a cancel after a partial fill leaves a real position behind.
    expect(statusOf({ qty: 5, qtyFilled: 2, qtyClosed: 0, cancelled: true })).toBe(STATUS.PART_FILLED);
  });

  it('calls a part-filled ticket closed out, not Closed, when its fills are flat', () => {
    // 2 of 5 filled and both sold: the position is gone but the order never was.
    expect(statusOf({ qty: 5, qtyFilled: 2, qtyClosed: 2 })).toBe(STATUS.PART_FILLED);
  });
});

describe('fill quality', () => {
  it('reads slippage the same way on a credit and a debit', () => {
    // Credit: asked 2.60, got 2.50 — 0.10 worse.
    expect(fillQuality({ fillPrice: 2.50, limitPrice: 2.60, qtyFilled: 1 }).vsLimit).toBeCloseTo(0.10, 4);
    // Debit: asked to pay 1.00 (−1.00), paid 1.11 (−1.11) — also 0.11 worse.
    expect(fillQuality({ fillPrice: -1.11, limitPrice: -1.00, qtyFilled: 1 }).vsLimit).toBeCloseTo(0.11, 4);
  });

  it('flags price improvement rather than calling it slippage', () => {
    const q = fillQuality({ fillPrice: 2.70, limitPrice: 2.60, qtyFilled: 1 });
    expect(q.vsLimit).toBeCloseTo(-0.10, 4);
    expect(q.improved).toBe(true);
  });

  it('measures against the mid, in dollars and in spreads', () => {
    const q = fillQuality({ fillPrice: 2.45, limitPrice: 2.60, midAtSend: 2.66,
      spreadAtSend: 0.20, qtyFilled: 5 });
    expect(q.vsMid).toBeCloseTo(0.21, 4);
    expect(q.vsMidDollars).toBeCloseTo(105, 2);     // 0.21 x 100 x 5
    expect(q.inSpreads).toBeCloseTo(1.05, 2);       // a full spread through the mid
  });

  it('returns nulls rather than zeros when the baseline is unknown', () => {
    const q = fillQuality({ fillPrice: 2.5, qtyFilled: 1 });
    expect(q.vsLimit).toBeNull();
    expect(q.vsMid).toBeNull();
    expect(q.inSpreads).toBeNull();
    expect(fillQuality({ fillPrice: null })).toBeNull();
  });
});

describe('blending entry fills', () => {
  const fills = [
    { qtyFilled: 2, fillPrice: 2.60, midAtSend: 2.66, feesUsd: 2.60, fillDate: '2026-10-07' },
    { qtyFilled: 3, fillPrice: 2.70, midAtSend: 2.72, feesUsd: 3.90, fillDate: '2026-10-08' },
  ];

  it('weights by quantity, not by row', () => {
    const b = blendFills(fills);
    expect(b.qtyFilled).toBe(5);
    // (2x2.60 + 3x2.70) / 5 = 2.66, not the 2.65 a simple mean would give.
    expect(b.avgPrice).toBeCloseTo(2.66, 4);
    expect(b.tranches).toBe(2);
    expect(b.fees).toBeCloseTo(6.5, 2);
    expect(b.firstFill).toBe('2026-10-07');
    expect(b.lastFill).toBe('2026-10-08');
  });

  it('compares like with like when only some fills recorded a mid', () => {
    const partial = [fills[0], { ...fills[1], midAtSend: null }];
    const b = blendFills(partial);
    // The mid average covers only the 2 contracts that had one.
    expect(b.avgMid).toBeCloseTo(2.66, 4);
    expect(b.avgPrice).toBeCloseTo(2.66, 4);
  });

  it('ignores rows that are not fills', () => {
    expect(blendFills([{ qtyFilled: 0, fillPrice: 2.6 }])).toBeNull();
    expect(blendFills([{ qtyFilled: 2, fillPrice: null }])).toBeNull();
    expect(blendFills([])).toBeNull();
  });
});

describe('exposure', () => {
  // Two condors, $740 risk each on 1 contract. One filled, one resting.
  const live = { qty: 1, maxRisk: 740, qtyFilled: 1, qtyOpen: 1 };
  const working = { qty: 1, maxRisk: 740, qtyFilled: 0, qtyOpen: 0 };

  it('counts a working order in full, but keeps it its own number', () => {
    const e = exposure([live, working], { maxOpenRisk: 675 });
    expect(e.live).toBeCloseTo(740, 2);
    expect(e.working).toBeCloseTo(740, 2);
    expect(e.committed).toBeCloseTo(1480, 2);
    expect(e.workingCount).toBe(1);
  });

  it('separates being over now from being over if everything fills', () => {
    const under = exposure([{ qty: 1, maxRisk: 400, qtyFilled: 1, qtyOpen: 1 },
                            { qty: 1, maxRisk: 400, qtyFilled: 0, qtyOpen: 0 }],
                           { maxOpenRisk: 675 });
    expect(under.overNow).toBe(false);      // $400 at risk, under the cap
    expect(under.overIfFilled).toBe(true);  // $800 if the resting one fills
    expect(under.headroom).toBeCloseTo(-125, 2);
  });

  it('prorates a part-filled order across risk and commitment', () => {
    // 5 contracts at $100 each; 2 filled, 3 still resting.
    const e = exposure([{ qty: 5, maxRisk: 500, qtyFilled: 2, qtyOpen: 2 }], { maxOpenRisk: 675 });
    expect(e.live).toBeCloseTo(200, 2);
    expect(e.working).toBeCloseTo(300, 2);
    expect(e.committed).toBeCloseTo(500, 2);
  });

  it('treats a ticket with no fill record as filled, not as working', () => {
    // Legacy rows were logged as done. Counting them as commitments would invent
    // exposure that was never pending.
    const e = exposure([{ qty: 1, maxRisk: 740, qtyOpen: 1 }], { maxOpenRisk: 675 });
    expect(e.live).toBeCloseTo(740, 2);
    expect(e.working).toBe(0);
  });

  it('says nothing useful rather than something wrong with no cap', () => {
    const e = exposure([live], {});
    expect(e.cap).toBeNull();
    expect(e.overNow).toBe(false);
    expect(e.headroom).toBeNull();
    expect(exposure([], { maxOpenRisk: 675 }).committed).toBe(0);
  });
});

describe('fill stats', () => {
  it('reports how often a worked order actually fills, and what it cost', () => {
    const s = fillStats([
      { qty: 1, limitPrice: 2.60, qtyFilled: 1, slippageVsMid: 0.06, slippageDollars: 6 },
      { qty: 1, limitPrice: 2.60, qtyFilled: 0 },                       // never filled
      { qty: 5, limitPrice: 1.10, qtyFilled: 2, slippageVsMid: 0.10, slippageDollars: 20 },
    ]);
    expect(s.tickets).toBe(3);
    expect(s.worked).toBe(3);
    expect(s.filled).toBe(2);
    expect(s.fullyFilled).toBe(1);
    expect(s.fillRate).toBeCloseTo(66.7, 1);
    expect(s.fullFillRate).toBeCloseTo(33.3, 1);
    expect(s.avgSlippage).toBeCloseTo(0.08, 4);
    expect(s.totalSlippageDollars).toBeCloseTo(26, 2);
  });

  it('returns null on nothing to measure', () => {
    expect(fillStats([])).toBeNull();
    expect(fillStats(null)).toBeNull();
  });
});
