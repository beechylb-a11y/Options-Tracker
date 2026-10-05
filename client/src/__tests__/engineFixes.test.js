/* Two engine faults fixed in October 2026.

   1. Credit verticals were treated as containment structures in the Trade Confidence
      coherence gate and the tiebreak, so a bull put on a strong bullish read was
      multiplied by 0.50 (and 0.80 again on a continuation day) on exactly the days
      its rating ladder calls it EXCELLENT.
   2. Event checks used the ET calendar date. Run from Australia after the US close,
      that is the session that has just finished, so the next session's releases were
      never checked. */
import { describe, it, expect } from 'vitest';
import { calc0DTE, creditVerticalSide } from '../engine/calc0dte';
import { nowET, eventRisk0DTE } from '../engine/events';

// A strong bullish SPX tape: price well above a rising rolling VWAP, acceptance high.
const bull = {
  underlying: 'SPX', price: 6712, high: 6714, low: 6690, cashOpen: 6692,
  vwap5: 6703, vwap5_30: 6698, vwapRoll30: 6704, vwapRoll30Prior: 6694, vwapAccept: 0.9,
  atr: 60, em: 45, atr5: 4, atr2h: 4.2, gamStrike: 6700,
  vix: 15, vix1d: 17, bankroll: 3000, startBR: 3000,
  maxLoss: 300, maxOpen: 450, pop: 75, hours: 4, win: 120, risk: 380,
};
const run = (overrideStrategy) => calc0DTE({ ...bull, overrideStrategy });

describe('credit vertical coherence', () => {
  it('reads the side of each credit vertical', () => {
    expect(creditVerticalSide('Bull put spread')).toBe(1);
    expect(creditVerticalSide('Bear call spread')).toBe(-1);
    expect(creditVerticalSide('Iron Condor - Normal')).toBe(0);
  });

  it('sets up a strong bullish read', () => {
    expect(run('Bull put spread').dirScore).toBeGreaterThanOrEqual(2);
  });

  it('does not penalise a bull put on a strong bullish read', () => {
    const r = run('Bull put spread');
    const dirConflict = (r.confConflicts || []).find(c => c.tag === 'Direction↔Structure');
    expect(dirConflict).toBeUndefined();
    expect(r.coherenceGate).toBeGreaterThan(0.95);
  });

  it('still penalises a bear call against the same read', () => {
    const r = run('Bear call spread');
    expect(r.coherenceGate).toBeLessThanOrEqual(0.5);
    expect((r.confConflicts || []).some(c => /short strike/.test(c.label))).toBe(true);
  });

  it('leaves the containment penalty on an iron condor', () => {
    expect(run('Iron Condor - Normal').coherenceGate).toBeLessThanOrEqual(0.5);
  });
});

describe('event checks use the trading session', () => {
  // 08:00 Tuesday in Melbourne (AEDT) = 17:00 Monday in New York, after the close.
  const afterClose = new Date('2026-10-05T21:00:00Z');

  it('rolls to the next session after the US close', () => {
    const t = nowET(afterClose);
    expect(t.dateISO).toBe('2026-10-06');
    expect(t.minutes).toBeNull();
  });

  it('rolls a Friday evening to Monday', () => {
    expect(nowET(new Date('2026-10-09T21:00:00Z')).dateISO).toBe('2026-10-12');
  });

  it('keeps the live session and the clock during the day', () => {
    const t = nowET(new Date('2026-10-05T15:00:00Z')); // 11:00 ET
    expect(t.dateISO).toBe('2026-10-05');
    expect(t.minutes).toBe(11 * 60);
  });

  it("warns about the next session's release when run after the close", () => {
    const cal = {
      generatedAt: '2026-10-01', horizonEnd: '2026-12-31', blsLoaded: true,
      severity: { CPI: 'high', FOMC: 'high' },
      events: [
        { date: '2026-10-05', time: '08:30', kind: 'CPI', label: 'CPI (Sep)' },
        { date: '2026-10-06', time: '14:00', kind: 'FOMC', label: 'FOMC statement' },
      ],
    };
    const t = nowET(afterClose);
    const r = eventRisk0DTE(t.dateISO, t.minutes, cal);
    expect(r.warnings.some(w => /FOMC/.test(w))).toBe(true);
    expect(r.warnings.some(w => /CPI/.test(w))).toBe(false);
  });
});
