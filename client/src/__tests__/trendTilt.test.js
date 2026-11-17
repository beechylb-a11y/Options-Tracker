// Nov 2026: the 5-minute EMA replaces the VWAP 30m windows as the short-term trend input,
// and intraday evidence alone stops at a lean (|dirScore| ≤ 1). 877 SPY sessions showed no
// intraday trend read predicting the move to 15:00.
import { describe, it, expect } from 'vitest';
import { calc0DTE } from '../engine/calc0dte';

const bull = {
  underlying: 'SPX', price: 6712, high: 6714, low: 6690, cashOpen: 6692,
  vwap5: 6703, vwap5_30: 6698, vwapRoll30: 6704, vwapRoll30Prior: 6694, vwapAccept: 0.9,
  atr: 60, em: 45, atr5: 4, atr2h: 4.2, gamStrike: 6700,
  vix: 15, vix1d: 17, bankroll: 3000, startBR: 3000,
  maxLoss: 300, maxOpen: 450, pop: 75, hours: 4, win: 120, risk: 380,
};
const onUp = { esClose: 6700, priorDayClose: 6680, esOvernightHigh: 6702, esOvernightLow: 6684, esEM: 45 };
const onDown = { esClose: 6670, priorDayClose: 6690, esOvernightHigh: 6694, esOvernightLow: 6668, esEM: 45 };

describe('short-term trend: tilt, not a switch', () => {
  it('caps a strong intraday read at a lean when there is no overnight read', () => {
    const r = calc0DTE(bull);
    expect(r.dirScore).toBe(1);
    expect(r.dirCapped).toBe(true);
  });
  it('keeps strong when the overnight move and the trend agree', () => {
    const r = calc0DTE({ ...bull, ...onUp, emaTrend: 'up' });
    expect(r.dirScore).toBe(2);
    expect(r.dirCapped).toBe(false);
  });
  it('caps when the overnight move disagrees', () => {
    const r = calc0DTE({ ...bull, ...onDown, emaTrend: 'up' });
    expect(Math.abs(r.dirScore)).toBeLessThanOrEqual(1);
  });
  it('uses the EMA as the trend input when the bridge sends it, VWAP windows otherwise', () => {
    expect(calc0DTE({ ...bull, emaTrend: 'up' }).slope5.source).toBe('ema');
    expect(calc0DTE({ ...bull, emaTrend: 'up' }).slopeDirection).toBe('rising');
    expect(calc0DTE({ ...bull, emaTrend: 'mixed' }).slope).toBe('flat');
    expect(calc0DTE(bull).slope5.source).toBe('vwap');
  });
  it('an EMA stack never counts as a strong slope', () => {
    expect(calc0DTE({ ...bull, emaTrend: 'down' }).slope).toBe('mild');
  });
});
