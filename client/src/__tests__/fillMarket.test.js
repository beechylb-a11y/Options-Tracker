// The fill against the market (18 Nov 2026).
import { describe, it, expect } from 'vitest';
import { fillVsMarket, fillQualitySummary } from '../engine/fills';
import { comboTranches, fillPayload } from '../utils/fillMatch';

describe('fillVsMarket', () => {
  it('a credit filled inside the market is measured, not flagged', () => {
    const v = fillVsMarket(0.58, { mid: 0.60, spread: 0.20 });
    expect(v.vsMid).toBeCloseTo(0.02, 6);
    expect(v.suspect).toBeNull();
  });
  it('a credit filled far through the mid — better than the far side — is a paper-fill suspect', () => {
    const v = fillVsMarket(0.95, { mid: 0.60, spread: 0.20 });
    expect(v.suspect).toBe('better');
    expect(v.label).toMatch(/paper-fill/);
  });
  it('a debit paid beyond the natural price is flagged worse', () => {
    expect(fillVsMarket(-1.40, { mid: -1.10, spread: 0.30 }).suspect).toBe('worse');
  });
  it('no market, no verdict', () => {
    expect(fillVsMarket(0.5, { mid: '' })).toBeNull();
  });
});

describe('fills carry the market', () => {
  const ex = (execId, side, strike, price, q) => ({ execId, time: '20261118 10:31:05', orderId: 40, permId: 9, side, qty: 2, price, strike, right: 'P', expiry: '20261118', symbol: 'SPX', secType: 'OPT', quoteAtFill: q });
  it('the tranche keeps the bridge quote and the fill row records it, flagged in the notes', () => {
    const q = { mid: 1.0, spread: 0.3 };
    const tr = comboTranches([ex('0001.aa.01.01', 'SLD', 6700, 3.2, q), ex('0001.aa.02.01', 'BOT', 6680, 1.6, q)])[0];
    expect(tr.netPrice).toBeCloseTo(1.6, 6);
    expect(tr.quoteAtFill).toEqual(q);
    const f = fillPayload({ ticketRef: 7, qty: 2, midAtSend: 0.98, spreadAtSend: 0.3 }, tr);
    expect(f).toMatchObject({ midAtSend: 0.98, spreadAtSend: 0.3, midAtFill: 1.0, spreadAtFill: 0.3 });
    expect(f.notes).toMatch(/PAPER-FILL SUSPECT: better/);
  });
});

describe('fillQualitySummary', () => {
  it('averages slippage over fills inside the market and lists the ones outside it', () => {
    const rows = [
      { 'Fill ID': 'a', Engine: '0DTE', 'Fill Price': 0.58, 'Qty Filled': 2, 'Mid At Fill': 0.60, 'Spread At Fill': 0.2 },
      { 'Fill ID': 'b', Engine: '0DTE', 'Fill Price': 0.95, 'Qty Filled': 1, 'Mid At Fill': 0.60, 'Spread At Fill': 0.2 },
      { 'Fill ID': 'c', Engine: '45DTE', 'Fill Price': -1.12, 'Qty Filled': 1, 'Mid At Send': -1.10, 'Spread At Send': 0.2 },
      { 'Fill ID': 'd', Engine: '45DTE', 'Fill Price': 2.0, 'Qty Filled': 1 },
    ];
    const s = fillQualitySummary(rows);
    expect(s.fills).toBe(4);
    expect(s.measured).toBe(2);
    expect(s.atFill).toBe(1);
    expect(s.suspect).toBe(1);
    expect(s.suspectFills[0].fillId).toBe('b');
    expect(s.avgVsMid).toBeCloseTo(0.02, 6);
    expect(s.dollars).toBeCloseTo(4 + 2, 6);
    expect(s.byEngine['45DTE'].measured).toBe(1);
  });
});
