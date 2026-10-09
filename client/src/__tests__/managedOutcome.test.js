/* Learning loop step 3 (Oct 2026): managed outcomes, spread and commission, and
   suggestions that must win out of sample. */
import { describe, it, expect } from 'vitest';
import { walkExit, managed0, managed45, value0, defaultHalfSpread, commissionPerCt, barTimeET, maxProfitPS } from '../engine/managed';
import { thresholdTest, suggestions, SUGGEST_N } from '../engine/suggest';
import { valueAtExpiry } from '../engine/shadow';

const condor = [{ strike: 7300, right: 'P', qty: 1 }, { strike: 7340, right: 'P', qty: -1 }, { strike: 7460, right: 'C', qty: -1 }, { strike: 7500, right: 'C', qty: 1 }];

describe('exit walk', () => {
  it('takes the target, the stop, or the last step', () => {
    const base = { entryNet: 4, target: 25, basis: 'entry', maxPS: 4 };
    expect(walkExit({ ...base, steps: [{ at: 'a', value: -3.5 }, { at: 'b', value: -2.9 }] })).toMatchObject({ reason: 'target', at: 'b' });
    expect(walkExit({ ...base, steps: [{ at: 'a', value: -8.2 }] })).toMatchObject({ reason: 'stop' });
    expect(walkExit({ ...base, steps: [{ at: 'a', value: -3.8 }] })).toMatchObject({ reason: 'time' });
    expect(walkExit({ ...base, target: 50, basis: 'max', maxPS: 10, steps: [{ at: 'a', value: 1.1 }] })).toMatchObject({ reason: 'target' });
  });
  it('models values that converge to expiry', () => {
    expect(value0(condor, 7400, 0)).toBe(valueAtExpiry(condor, 7400));
    expect(value0(condor, 7400, 20)).toBeLessThan(0);
    expect(maxProfitPS(condor, 4)).toBe(4);
  });
  it('spread and commission', () => {
    expect(defaultHalfSpread(condor, 'SPX', 7400)).toBeCloseTo(0.4, 1);
    expect(defaultHalfSpread(condor, 'TSLA', 430)).toBeCloseTo(0.10, 2);
    expect(commissionPerCt(condor, 2)).toBe(5.2);
  });
  it('reads bar times in New York', () => {
    expect(barTimeET('20261009  10:35:00')).toEqual({ ymd: '20261009', min: 635 });
    expect(barTimeET(String(Date.UTC(2026, 9, 9, 14, 35) / 1000))).toEqual({ ymd: '20261009', min: 635 });
  });
});

const bars = (day, from, to, S) => {
  const out = [];
  for (let m = from; m <= to; m += 5) out.push({ date: `${day}  ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`, close: typeof S === 'function' ? S(m) : S });
  return out;
};
describe('0DTE managed', () => {
  const row = { legs: condor, entry_net: 4, entry_half_spread: 0.3, expiry: '20261009', strategy: 'Iron Condor - Normal',
    first_seen: '2026-10-09T15:00:00Z' /* 11:00 ET */, inputs: { sdLeft: 30, hours: 5 } };
  it('a quiet day banks the 25% target', () => {
    const m = managed0(row, bars('20261009', 570, 960, 7400));
    expect(m.reason).toBe('target');
    expect(m.pnl).toBeGreaterThan(0);
    expect(m.commission).toBe(5.2);
  });
  it('a run through the short call hits the stop', () => {
    const fair = { ...row, entry_net: -value0(condor, 7400, 30) };   // entered at the model's fair credit
    const m = managed0(fair, bars('20261009', 570, 960, min => 7400 + Math.max(0, min - 660) * 0.6));
    expect(m.reason).toBe('stop');
    // a 100%-of-premium stop loses about the credit, plus the exit half-spread and commission
    const credit = fair.entry_net;
    expect(m.pnl).toBeLessThanOrEqual(Math.round((-credit - 0.3) * 100 - 5.2) + 1);
    expect(m.pnl).toBeGreaterThan((-credit - 0.3) * 100 - 5.2 - credit * 100);   // caught near the level, not at max loss
  });
  it('waits when the day has no bars', () => {
    expect(managed0(row, bars('20261008', 570, 960, 7400))).toBeNull();
  });
});

describe('45DTE managed', () => {
  const ic = [{ strike: 700, right: 'P', qty: 1 }, { strike: 710, right: 'P', qty: -1 }, { strike: 810, right: 'C', qty: -1 }, { strike: 820, right: 'C', qty: 1 }];
  const row = { legs: ic, entry_net: 2.2, entry_half_spread: 0.05, expiry: '20261120', session_date: '2026-10-06', strategy: 'Iron Condor - Normal', underlying: 'QQQ', inputs: { iv: 18 } };
  const days = (from, n, S) => Array.from({ length: n }, (_, i) => { const d = new Date(2026, 9, from + i); return { date: `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`, close: S }; });
  it('pending until the target triggers or the planned close passes', () => {
    expect(managed45(row, days(7, 3, 760), new Date(2026, 9, 10))).toBeNull();
  });
  it('takes 50% once decay gets there', () => {
    const m = managed45(row, days(7, 25, 760), new Date(2026, 9, 31));
    expect(m).toBeTruthy();
    expect(['target', 'time']).toContain(m.reason);
  });
});

describe('suggestions', () => {
  const mk = (i, over) => ({ id: i, session_date: `2026-10-${String(1 + (i % 28)).padStart(2, '0')}`, first_seen: String(i).padStart(4, '0'),
    engine: '0DTE', legs: condor, entry_net: 4, managed_at: 'x', settled_at: 'x', ...over });
  it('nothing below the sample size', () => {
    const r = suggestions([mk(1, { category: 'blocked', blockers: 'Gamma risk too high', pnl_managed: 100 })]);
    expect(r.suggestions).toEqual([]);
    expect(r.waiting.find(w => /Gamma risk too high/.test(w.what)).n).toBe(1);
  });
  it('flags a blocker that stops winners', () => {
    const rows = Array.from({ length: SUGGEST_N + 2 }, (_, i) => mk(i, { category: 'blocked', blockers: 'Gamma risk too high', pnl_managed: 80 + (i % 5) * 10 }));
    const r = suggestions(rows);
    expect(r.suggestions.find(x => x.id === 'blk:Gamma risk too high')).toMatchObject({ tone: 'change' });
  });
  it('a threshold must beat the current one on the latest third', () => {
    // move cost above 1.5 loses, below wins: 2.0 lets losers through, 1.5 does better
    const outs = Array.from({ length: 60 }, (_, i) => {
      const mc = 0.5 + (i % 6) * 0.4;               // 0.5 .. 2.5
      const R = mc > 1.5 ? -0.4 : 0.3;
      return { row: { ...mk(i), move_cost: mc }, R };
    });
    const t = thresholdTest(outs, { candidates: [1.0, 1.5, 2.0, 3.0], current: 2.0, allow: (r, th) => r.move_cost <= th });
    expect(t.best).toBe(1.5);
    expect(t.test.best.R).toBeGreaterThan(t.test.current.R);
  });
});
