/* Strike distance × exit learned from our own sessions (Oct 2026, shadow step 4). */
import { describe, it, expect } from 'vitest';
import { learnFrom, gridTable, exitTable, learnSuggestions, gridSessions, creditWidthOf, regimeOf } from '../engine/learn';

// 5-min bars for 23 Oct 2026, 09:30–16:00 ET, price drifting from S0 by `drift` points.
const barsFor = (day, S0, drift, wobble = 0) => {
  const out = [];
  for (let m = 9 * 60 + 30; m <= 16 * 60; m += 5) {
    const f = (m - (9 * 60 + 30)) / 390;
    const S = S0 + drift * f + wobble * Math.sin(m / 7);
    out.push({ date: `${day}  ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`, close: S, high: S + 1, low: S - 1 });
  }
  return out;
};
const daily = (endDay, n, c) => Array.from({ length: n }, (_, i) => {
  const d = new Date(Date.UTC(2026, 8, 1) + i * 86400000);
  return { date: d.toISOString().slice(0, 10).replace(/-/g, ''), close: c };
}).filter(b => b.date < endDay);

const row = (over = {}) => ({
  id: 1, engine: '0DTE', underlying: 'SPX', strategy: 'Bull put spread', session_date: '2026-10-23', expiry: '20261023',
  first_seen: '2026-10-23T14:30:00Z',                                 // 10:30 ET
  spot: 6600, entry_net: 3.5, entry_half_spread: 0.1,
  legs: [{ strike: 6560, right: 'P', qty: -1 }, { strike: 6540, right: 'P', qty: 1 }],
  inputs: { sdLeft: 45, hours: 5.5, vix1d: 15, vix: 17, emSource: 'straddle' }, ...over,
});

describe('learnFrom', () => {
  it('own legs at 25% / 50% / hold, the anchor grid both sides, and the regime', () => {
    const L = learnFrom(row(), barsFor('20261023', 6600, 45), daily('20261023', 60, 6500));
    expect(L.exits.t25.at).toMatch(/^20261023 1\d:\d\d$/);
    expect(L.exits.t25.pnl).toBeGreaterThanOrEqual(Math.floor((0.25 * 3.5 - 0.1) * 100 - 2.6));  // at least the target, less half spread + both sides
    expect(L.exits.t50.pnl).toBeGreaterThanOrEqual(Math.floor((0.50 * 3.5 - 0.1) * 100 - 2.6));
    expect(L.exits.hold.pnl).toBe(Math.round(3.5 * 100 - 1.3));             // expired worthless: entry commission only
    expect(L.grid.length).toBe(6);
    const put = L.grid.find(g => g.side === 'put' && g.anchor === 'IVX');
    expect(put.width).toBe(20);
    expect(6600 - put.kS).toBeGreaterThanOrEqual(30);                          // IVX ≈ 0.68 × sdLeft = 30.5
    expect(put.hold).toBeGreaterThan(0);                                       // market rose: the put spread kept its credit
    const call = L.grid.find(g => g.side === 'call' && g.anchor === 'IVX');
    expect(call.hold).toBeLessThan(0);                                         // close 6645, through the 6635 short
    expect(L.regime).toMatchObject({ trend: 'up', v1dRatio: 0.882 });
  });
  it('waits for the bars, and skips 45DTE', () => {
    expect(learnFrom(row(), [], [])).toBeNull();
    expect(learnFrom(row({ engine: '45DTE' }), barsFor('20261023', 6600, 0), [])).toBeNull();
  });
  it('widths and regime helpers', () => {
    expect(creditWidthOf('SPX', 6600)).toBe(20);
    expect(creditWidthOf('QQQ', 708)).toBe(2);
    expect(creditWidthOf('IWM', 250)).toBe(1);
    expect(regimeOf(daily('20261023', 60, 6700), '20261023', 6600, 15, 17).trend).toBe('down');
  });
});

describe('reading it back', () => {
  const learned = (day, drift, over = {}) => {
    const r = row({ session_date: `2026-${day.slice(4, 6)}-${day.slice(6, 8)}`, expiry: day, first_seen: `2026-${day.slice(4, 6)}-${day.slice(6, 8)}T14:30:00Z`, ...over });
    r.learn = learnFrom(r, barsFor(day, 6600, drift, 4), daily(day, 60, 6550));
    r.managed_at = 'x'; r.pnl_managed = r.learn.exits.t25.pnl;
    return r;
  };
  it('one look per session and underlying; the grid table and the exits table', () => {
    const a = learned('20261020', 20), b = learned('20261020', 20, { id: 2, first_seen: '2026-10-20T16:00:00Z' }), c = learned('20261021', -40);
    expect(gridSessions([b, a, c]).map(r => r.id)).toEqual([1, 1]);       // earliest look of the 20th, then the 21st
    const g = gridTable([a, b, c]);
    expect(g.sessions).toBe(2);
    const ivxPut = g.rows.find(x => x.side === 'put' && x.anchor === 'IVX');
    expect(ivxPut.hold.n).toBe(2);
    expect(ivxPut.hold.read.text).toMatch(/too few/);
    const ex = exitTable([a, c]);
    expect(ex[0].group).toBe('Credit spreads');
    expect(ex[0].current.n).toBe(2);
  });
  it('proposes a different exit only when it wins out of sample', () => {
    // 36 quiet up-drift days: holding keeps the whole credit, 25% caps it.
    const rows = Array.from({ length: 36 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 6, 1) + i * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
      return learned(d, 15, { id: 100 + i });
    });
    const s = learnSuggestions(rows);
    const exit = s.suggestions.find(x => x.id === 'learn-exit');
    expect(exit.tone).toBe('change');
    expect(exit.title).toMatch(/hold to expiry instead of closing at 25%/);
    expect(s.suggestions.some(x => x.id === 'learn-grid-put')).toBe(true);
    expect(learnSuggestions(rows.slice(0, 10)).waiting.map(w => w.what)).toContain('Exit for 0DTE credit spreads');
  });
});
