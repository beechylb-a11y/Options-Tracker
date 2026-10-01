/* The quote-line arithmetic, kept as pure functions so the decision it supports can
   be tested without a browser: how far is the price I am about to send from the mid,
   measured in spreads, and what does crossing cost. */
import { describe, it, expect } from 'vitest';
import { comboQuote, computeFrictions } from '../engine/data';

const spreadsFromMid = (price, bid, ask) => (ask > bid) ? (price - (bid + ask) / 2) / (ask - bid) : null;

describe('quote line', () => {
  // The 30 Sep SPY fly: 1 x 767 long, 2 x 770 short, 1 x 775 long.
  const legs = [
    { qty: 1, bid: 3.95, ask: 4.10 },
    { qty: -2, bid: 1.80, ask: 1.92 },
    { qty: 1, bid: 0.40, ask: 0.48 },
  ];

  it('builds the combo quote by paying the ask on longs and hitting the bid on shorts', () => {
    const q = comboQuote(legs);
    // ask side: 4.10 - 2(1.80) + 0.48 = 0.98 ; bid side: 3.95 - 2(1.92) + 0.40 = 0.51
    expect(q.ask).toBeCloseTo(0.98, 2);
    expect(q.bid).toBeCloseTo(0.51, 2);
    expect((q.ask + q.bid) / 2).toBeCloseTo(0.745, 2);
  });

  it('refuses to invent a quote when any leg is missing one', () => {
    expect(comboQuote([{ qty: 1, bid: 1, ask: null }, { qty: -2, bid: 1, ask: 2 }])).toBeNull();
    // Number(null) is 0, so a missing quote must be rejected rather than summed as zero.
    expect(comboQuote([{ qty: 1, bid: 1, ask: '' }])).toBeNull();
    expect(comboQuote([])).toBeNull();
  });

  it('measures the typed price against the mid in spreads', () => {
    const q = comboQuote(legs);
    const mid = (q.bid + q.ask) / 2;
    expect(spreadsFromMid(mid, q.bid, q.ask)).toBeCloseTo(0, 6);
    // Paying the ask is exactly half a spread above mid, by construction.
    expect(spreadsFromMid(q.ask, q.bid, q.ask)).toBeCloseTo(0.5, 6);
    // 1.11 on this quote is well through the offer — which is what happened.
    expect(spreadsFromMid(1.11, q.bid, q.ask)).toBeGreaterThan(0.75);
  });

  it('prices the round trip against what can be won', () => {
    const q = comboQuote(legs);
    const f = computeFrictions({ comboBid: q.bid, comboAsk: q.ask, win: 189, legCount: 3, contracts: 1 });
    expect(f).toBeTruthy();
    expect(f.pct).toBeGreaterThan(0);
    // Against a $189 max profit a ~0.47 spread is not a rounding error.
    expect(f.pct).toBeGreaterThan(0.2);
  });

  it('says nothing rather than guessing with no quote', () => {
    expect(computeFrictions({ comboBid: null, comboAsk: null, win: 189, legCount: 3 })).toBeNull();
    expect(spreadsFromMid(1.0, 0.8, 0.8)).toBeNull();
  });
});
