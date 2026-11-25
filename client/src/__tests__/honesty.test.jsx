/* Are the engine's numbers honest? (Analytics › Engine verdicts): reliability of the win
   chance and the max-loss chance, the Brier skill score, the EV ranking, ranges from a
   bootstrap over whole sessions, and plain-words reads that never claim a finding on a
   thin sample. */
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, within, fireEvent, cleanup } from '@testing-library/react';
import { pairsFor, reliability, evCheck, spearman, equalGroups, sessionBootstrap, honesty, rng } from '../engine/reliability';
import HonestyPanel from '../components/HonestyPanel';

// A 0DTE bull put spread 7000/6980 for 4.00 credit: max loss $1,600 a contract.
const legs = [{ strike: 7000, right: 'P', qty: -1 }, { strike: 6980, right: 'P', qty: 1 }];
let id = 0;
const row = (o) => ({
  id: ++id, engine: '0DTE', session_date: o.s, legs, entry_net: 4,
  pop: o.pop, p_max_loss: o.pml, ev: o.ev,
  pnl_per_ct: o.pnl, settled_at: '2026-11-01T21:00:00Z',
  pnl_managed: o.pnl, managed_at: '2026-11-01T21:00:00Z',
  ...o.extra,
});

// Honest engine: says 80% and wins 8 of 10 every session; says 30% and wins 3 of 10.
function honestRows(sessions = 8) {
  const out = [];
  for (let s = 0; s < sessions; s++) {
    const d = `2026-10-${String(s + 1).padStart(2, '0')}`;
    for (let i = 0; i < 10; i++) out.push(row({ s: d, pop: 80, pml: 0.05, ev: 120, pnl: i < 8 ? 300 : -200 }));
    for (let i = 0; i < 10; i++) out.push(row({ s: d, pop: 30, pml: 0.4, ev: -90, pnl: i < 3 ? 300 : (i < 7 ? -1600 : -200) }));
  }
  return out;
}

afterEach(cleanup);

describe('pairs', () => {
  it('reads POP as a percent, P(max loss) as a fraction, and max loss from the legs', () => {
    const rows = [row({ s: 'a', pop: 62, pml: 0.2, ev: 50, pnl: -1600.65 }), row({ s: 'a', pop: 55, pml: 0.1, ev: 10, pnl: 400 })];
    const win = pairsFor(rows, 'win', '0DTE');
    expect(win.map(q => q.p)).toEqual([0.62, 0.55]);
    expect(win.map(q => q.y)).toEqual([0, 1]);
    const ml = pairsFor(rows, 'maxLoss', '0DTE');
    expect(ml.map(q => q.y)).toEqual([1, 0]);        // −$1,600.65 on a $1,600 max loss counts
    expect(pairsFor(rows, 'ev', '0DTE').map(q => q.x)).toEqual([50, 10]);
  });
  it('skips unsettled rows and rows without the number', () => {
    const rows = [row({ s: 'a', pop: null, pml: 0.1, ev: 5, pnl: 10 }), row({ s: 'a', pop: 60, pml: 0.1, ev: 5, pnl: 10, extra: { settled_at: null, managed_at: null } })];
    expect(pairsFor(rows, 'win', '0DTE')).toHaveLength(0);
    expect(pairsFor(rows, 'maxLoss', '0DTE')).toHaveLength(1);
  });
  it('scores 45DTE on the managed exit, 0DTE held', () => {
    const r = row({ s: 'a', pop: 70, pml: 0.1, ev: 5, pnl: -100, extra: { engine: '45DTE', pnl_managed: 150, managed_at: '2026-11-02', settled_at: null, pnl_per_ct: null } });
    expect(pairsFor([r], 'win', '45DTE')[0].y).toBe(1);
    expect(pairsFor([r], 'maxLoss', '45DTE')).toHaveLength(0);    // not at expiry yet
  });
});

describe('helpers', () => {
  it('spearman: perfect, reversed, ties', () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1);
    expect(spearman([1, 1, 2, 2], [1, 1, 2, 2])).toBeCloseTo(1);
    expect(spearman([1, 2], [1, 2])).toBeNull();
  });
  it('equal-count groups: about 15 a group, at most 6', () => {
    const p = Array.from({ length: 92 }, (_, i) => ({ p: i / 92 }));
    const g = equalGroups(p, 'p');
    expect(g).toHaveLength(6);
    expect(g.reduce((a, x) => a + x.length, 0)).toBe(92);
    expect(equalGroups(p.slice(0, 20), 'p')).toHaveLength(1);
  });
  it('the session bootstrap is repeatable and needs two sessions', () => {
    const pairs = honestRows(4).map(r => ({ p: r.pop / 100, y: r.pnl > 0 ? 1 : 0, s: r.session_date }));
    const stat = xs => ({ m: xs.reduce((a, q) => a + q.y, 0) / xs.length });
    expect(sessionBootstrap(pairs, stat, ['m'])).toEqual(sessionBootstrap(pairs, stat, ['m']));
    expect(sessionBootstrap(pairs.slice(0, 5), stat, ['m'])).toBeNull();
    const r1 = rng(3), r2 = rng(3);
    expect([r1(), r1()]).toEqual([r2(), r2()]);
  });
});

describe('reliability', () => {
  it('an honest engine has skill above zero and sits on the line', () => {
    const r = reliability(pairsFor(honestRows(), 'win', '0DTE'), 'win');
    expect(r.n).toBe(160);
    expect(r.sessions).toBe(8);
    expect(r.said).toBeCloseTo(0.55);
    expect(r.rate).toBeCloseTo(0.55);
    expect(r.skill).toBeGreaterThan(0.2);
    expect(r.ci.skill.lo).toBeGreaterThan(0);
    expect(r.groups.some(g => g.off)).toBe(false);
    expect(r.read.tone).toBe('good');
    expect(r.read.text).toMatch(/sorts tickets better than quoting 55%/);
  });
  it('an engine that says 90% on everything and wins half is called too high', () => {
    const rows = honestRows().map(x => ({ ...x, pop: 90 }));
    const r = reliability(pairsFor(rows, 'win', '0DTE'), 'win');
    expect(r.bias).toBeCloseTo(0.35);
    expect(r.ci.bias.lo).toBeGreaterThan(0);
    expect(r.skill).toBeLessThan(0);
    expect(r.read.tone).toBe('bad');
    expect(r.read.text).toMatch(/35 pts too high/);
  });
  it('names the group that misses: said under 1%, happened 4 of 30', () => {
    const rows = honestRows();
    for (let i = 0; i < 30; i++) rows.push(row({ s: `2026-10-0${(i % 8) + 1}`, pop: 50, pml: 0.001, ev: 0, pnl: i < 4 ? -1600 : 100 }));
    const r = reliability(pairsFor(rows, 'maxLoss', '0DTE'), 'maxLoss');
    expect(r.groups.some(g => g.off)).toBe(true);
    expect(r.read.text).toMatch(/Where it said under 1%, it happened 4 of \d+ times/);
  });
  it('too few: no verdict on 20 tickets over 2 sessions', () => {
    const r = reliability(pairsFor(honestRows(1), 'win', '0DTE'), 'win');
    expect(r.enough).toBe(false);
    expect(r.read.text).toMatch(/^Too few to read: 20 settled over 1 session/);
  });
});

describe('EV', () => {
  it('higher EV made more, but the level reads high', () => {
    // Said +$120 / −$90, made +$200 / −$870: ranked right, level too high.
    const e = evCheck(pairsFor(honestRows(), 'ev', '0DTE'));
    expect(e.rho).toBeGreaterThan(0.3);
    expect(e.ci.rho.lo).toBeGreaterThan(0);
    expect(e.read.tone).toBe('warn');
    expect(e.read.text).toMatch(/higher EV went on to make more.*reads high: said \+\$15, made −\$205/);
    expect(e.groups.length).toBeGreaterThan(1);
  });
  it('EV backwards → bad', () => {
    const rows = honestRows().map(x => ({ ...x, ev: -x.ev }));
    const e = evCheck(pairsFor(rows, 'ev', '0DTE'));
    expect(e.read.tone).toBe('bad');
    expect(e.read.text).toMatch(/backwards/);
  });
});

describe('HonestyPanel', () => {
  it('draws three blocks with plots, stats and reads for 0DTE', () => {
    render(<HonestyPanel rows={honestRows()} />);
    const win = screen.getByTestId('honesty-win');
    expect(within(win).getAllByText('55%', { selector: '.num' })).toHaveLength(2);
    expect(within(win).getAllByTestId('rel-group').length).toBeGreaterThan(1);
    expect(within(win).getByTestId('honesty-stat').textContent).toMatch(/Skill vs quoting 55% every time: \+\d+%/);
    expect(within(screen.getByTestId('honesty-maxloss')).getByTestId('rel-maxloss')).toBeTruthy();
    expect(within(screen.getByTestId('honesty-ev')).getAllByTestId('ev-group').length).toBeGreaterThan(1);
  });
  it('switches engine; 45DTE with nothing at expiry says so', () => {
    const rows = [...honestRows(), row({ s: '2026-11-20', pop: 70, pml: 0.2, ev: 80, pnl: 0, extra: { engine: '45DTE', settled_at: null, pnl_per_ct: null, pnl_managed: 120, managed_at: '2026-11-21' } })];
    render(<HonestyPanel rows={rows} />);
    fireEvent.click(within(screen.getByTestId('honesty-engine')).getByText('45DTE'));
    expect(screen.getByTestId('honesty-maxloss').textContent).toMatch(/No 45DTE ticket has reached expiry yet/);
    expect(within(screen.getByTestId('honesty-win')).getByTestId('honesty-read').textContent).toMatch(/Too few to read: 1 settled/);
  });
  it('renders nothing with no rows', () => {
    const { container } = render(<HonestyPanel rows={[]} />);
    expect(container.innerHTML).toBe('');
  });
});
