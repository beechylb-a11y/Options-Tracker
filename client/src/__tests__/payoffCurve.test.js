/* Payoff at any date (Oct 2026): Black-Scholes per leg at its own expiry, the
   21-DTE hard close, and calendars — which intrinsic-at-one-expiry could not draw. */
import { describe, it, expect } from 'vitest';
import { bsPrice, normCdf, curveLegs, positionValue, closeDay, nearDte, priceRange, entryNet,
  curveAt, probProfit, pnlAt, ivAtDte, HARD_CLOSE_DTE } from '../engine/payoffCurve.js';

const cal = [{ label: 'Long call (back month)', strike: 7775 }, { label: 'Short call (front month)', strike: 7775 }];
const calLegs = () => curveLegs(cal, { dteOf: l => /back/.test(l.label) ? 73 : 45,
  ivOf: l => /back/.test(l.label) ? 13.6 : 13.1, baseIV: 13.1, divYield: 0.013 });

describe('pricing', () => {
  it('normCdf and put-call parity hold', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 7); expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
    const S = 6700, K = 6650, T = 45 / 365, r = 0.04, q = 0.013;
    const c = bsPrice(S, K, T, 0.16, 'C', r, q), p = bsPrice(S, K, T, 0.16, 'P', r, q);
    expect(c - p).toBeCloseTo(S * Math.exp(-q * T) - K * Math.exp(-r * T), 6);
  });
  it('falls to intrinsic at expiry', () => {
    expect(bsPrice(100, 90, 0, 0.2, 'C')).toBe(10); expect(bsPrice(100, 90, 0, 0.2, 'P')).toBe(0);
  });
});

describe('curves', () => {
  it('reproduces the intrinsic payoff of a vertical at expiry', () => {
    const cl = curveLegs([{ label: 'Long call', strike: 100 }, { label: 'Short call', strike: 110 }],
      { dteOf: () => 45, baseIV: 20 });
    const c = curveAt(cl, { net: -4, days: 45, lo: 80, hi: 130, n: 50 });
    expect(c.maxProfit).toBeCloseTo(600, 6); expect(c.maxLoss).toBeCloseTo(-400, 6);
    expect(c.breakevens).toEqual([104]);
  });

  it('draws a calendar as a tent at the near expiry, losing no more than the debit', () => {
    const cl = calLegs(), S = 7774;
    const [lo, hi] = priceRange(cl, S, 13.1);
    const atExp = curveAt(cl, { net: -61, days: nearDte(cl), lo, hi });
    expect(atExp.breakevens.length).toBe(2);
    expect(atExp.breakevens[0]).toBeLessThan(7775); expect(atExp.breakevens[1]).toBeGreaterThan(7775);
    expect(pnlAt(cl, 7775, -61, 45)).toBeGreaterThan(4000);
    expect(atExp.maxLoss).toBeGreaterThan(-6100.01);
  });

  it('closes 21 DTE before the near expiry, and the calendar earns far less there', () => {
    const cl = calLegs();
    expect(HARD_CLOSE_DTE).toBe(21);
    expect(closeDay(cl)).toBe(24);
    const [lo, hi] = priceRange(cl, 7774, 13.1);
    const atClose = curveAt(cl, { net: -61, days: closeDay(cl), lo, hi });
    const atExp = curveAt(cl, { net: -61, days: 45, lo, hi });
    expect(atClose.maxProfit).toBeLessThan(atExp.maxProfit / 4);
    // already inside 21 DTE → close is today
    expect(closeDay(curveLegs(cal, { dteOf: () => 15, baseIV: 13 }))).toBe(0);
  });

  it('prices the entry at model fair when no net is typed, and flips a positive debit', () => {
    const cl = calLegs();
    const m = entryNet(cl, 7774, '', 'debit');
    expect(m.source).toBe('model'); expect(m.net).toBeLessThan(0);
    expect(entryNet(cl, 7774, '61', 'debit').net).toBe(-61);
    expect(entryNet(cl, 7774, '-2.5', 'varies').net).toBe(-2.5);
    // at T+0 and model entry, P&L at spot is zero
    expect(pnlAt(cl, 7774, m.net, 0)).toBeCloseTo(0, 6);
  });

  it('a long call vertical is profitable above its breakeven with sensible probability', () => {
    const cl = curveLegs([{ label: 'Long call', strike: 100 }, { label: 'Short call', strike: 110 }],
      { dteOf: () => 45, baseIV: 20, rate: 0, divYield: 0 });
    const c = curveAt(cl, { net: -5, days: 45, lo: 60, hi: 150, n: 400 });
    const p = probProfit(c, 100, 0.20, 45);
    // P(S_T > 105) under zero drift at 20% vol, 45 days
    const sT = 0.2 * Math.sqrt(45 / 365);
    expect(p).toBeCloseTo(1 - normCdf((Math.log(105 / 100) + 0.5 * sT * sT) / sT), 2);
    expect(probProfit(c, 100, 0.2, 0)).toBeNull();
  });

  it('interpolates a far leg IV in total variance', () => {
    expect(ivAtDte(45, 45, 15, 90, 17)).toBeCloseTo(15, 6);
    expect(ivAtDte(90, 45, 15, 90, 17)).toBeCloseTo(17, 6);
    const mid = ivAtDte(73, 45, 15, 90, 17);
    expect(mid).toBeGreaterThan(15); expect(mid).toBeLessThan(17);
    expect(ivAtDte(73, 45, 15, 0, null)).toBe(15);
  });

  it('values the position as the signed sum of its legs', () => {
    const cl = calLegs();
    const v = positionValue(cl, 7774, 0);
    expect(v).toBeCloseTo(bsPrice(7774, 7775, 73 / 365, 0.136, 'C', 0.04, 0.013) - bsPrice(7774, 7775, 45 / 365, 0.131, 'C', 0.04, 0.013), 6);
  });
});
