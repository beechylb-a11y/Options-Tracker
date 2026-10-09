/* Calibration over shadow verdicts (Oct 2026, learning loop step 2). */
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { maxLossPerCt, outcomeOf, wilson, meanCI, blockerKey, calibrate, readOf, headlines, MIN_N } from '../engine/calibration';

const condor = [{ strike: 699, right: 'P', qty: 1 }, { strike: 709, right: 'P', qty: -1 }, { strike: 805, right: 'C', qty: -1 }, { strike: 815, right: 'C', qty: 1 }];
const ratio = [{ strike: 750, right: 'C', qty: 1 }, { strike: 760, right: 'C', qty: -2 }];
const row = (over) => ({ legs: condor, entry_net: 5, settled_at: 'x', engine: '0DTE', entry_source: 'ticket', ...over });

describe('risk and outcome', () => {
  it('max loss per contract from legs and entry; none for an uncovered short', () => {
    expect(maxLossPerCt(condor, 5)).toBeCloseTo(500, 6);          // 10 wide − 5 credit
    expect(maxLossPerCt(condor, -1)).toBeCloseTo(1100, 6);
    expect(maxLossPerCt(ratio, 1)).toBeNull();
    const o = outcomeOf(row({ pnl_per_ct: 250 }));
    expect(o.R).toBeCloseTo(0.5, 6);
    expect(outcomeOf(row({ settled_at: null, pnl_per_ct: 250 }))).toBeNull();
  });
  it('intervals', () => {
    const w = wilson(7, 10);
    expect(w.p).toBe(0.7); expect(w.lo).toBeGreaterThan(0.39); expect(w.hi).toBeLessThan(0.92);
    const m = meanCI([1, 1, 1, 1]);
    expect(m).toMatchObject({ m: 1, lo: 1, hi: 1, n: 4 });
  });
  it('one blocker is one group whatever its numbers', () => {
    expect(blockerKey('Net credit 1.45 is outside what these strikes can pay (0.10 to 9.90) — impossible'))
      .toBe(blockerKey('Net credit 2.10 is outside what these strikes can pay (0.20 to 8.00) — impossible'));
    expect(blockerKey('Gamma risk too high')).toBe('Gamma risk too high');
  });
});

describe('grouping and reads', () => {
  const blockedLosers = Array.from({ length: 12 }, (_, i) => row({ id: i, category: 'blocked', blockers: 'Gamma risk too high', pnl_per_ct: -200 - i, edge_score: 45, move_cost: 2.6, ev: -5 }));
  const allowedWinners = Array.from({ length: 12 }, (_, i) => row({ id: 100 + i, category: 'trade', pnl_per_ct: 100 + i * 5, edge_score: 75, move_cost: 0.6, ev: 40 }));
  const rows = [...blockedLosers, ...allowedWinners, row({ id: 999, category: 'blocked', blockers: 'Gamma risk too high', settled_at: null })];
  it('a blocker that stops losers reads as doing its job', () => {
    const g = calibrate(rows, 'blocker')[0];
    expect(g).toMatchObject({ key: 'Gamma risk too high', n: 12, recorded: 13 });
    expect(g.R.m).toBeLessThan(0);
    expect(g.read).toMatchObject({ tone: 'good' });
    expect(g.read.text).toMatch(/doing its job.*early/);
  });
  it('bands come back in order and the headline compares blocked with allowed', () => {
    expect(calibrate(rows, 'moveCost').map(g => g.key)).toEqual(['< 0.8', '2+']);
    const h = headlines(rows);
    expect(h.blocked.R).toBeLessThan(0);
    expect(h.allowed.R).toBeGreaterThan(0);
    expect(calibrate(rows, 'category', { engine: '45DTE' })).toEqual([]);
  });
  it('small groups are not read', () => {
    expect(readOf('blocker', MIN_N - 1, { m: -1, lo: -2, hi: -0.5 }).text).toMatch(/too few to tell/);
  });
});

describe('screen', () => {
  afterEach(() => cleanup());
  it('renders the calibration table and switches dimension', async () => {
    const rows = [
      ...Array.from({ length: 11 }, (_, i) => row({ id: i, category: 'blocked', blockers: 'Gamma risk too high', pnl_per_ct: -150, edge_score: 45, underlying: 'QQQ', session_date: '2026-10-09', strategy: 'Iron Condor - Normal' })),
      ...Array.from({ length: 11 }, (_, i) => row({ id: 50 + i, category: 'trade', pnl_per_ct: 120, edge_score: 75, underlying: 'QQQ', session_date: '2026-10-09', strategy: 'Iron Condor - Normal' })),
    ];
    vi.doMock('../utils/api', () => ({ api: { getTracker: () => Promise.resolve([]), getDecisions: () => Promise.resolve([]),
      getShadow: () => Promise.resolve(rows), getCaptureStats: () => Promise.resolve({}) } }));
    const { default: Analytics } = await import('../pages/Analytics');
    render(<Analytics authenticated account="acct" accounts={[]} />);
    fireEvent.click(await screen.findByText('Engine verdicts', { selector: 'button' }));
    fireEvent.click(await screen.findByText('Held to expiry', { selector: 'button' }));
    const table = await screen.findByTestId('calibration-table');
    expect(table.textContent).toMatch(/Gamma risk too high/);
    expect(table.textContent).toMatch(/doing its job/);
    expect(screen.getByTestId('calibration-headline').textContent).toMatch(/Blocked trades averaged −0\.30R over 11/);
    fireEvent.click(screen.getByText('Edge score', { selector: 'button' }));
    expect(screen.getByTestId('calibration-table').textContent).toMatch(/40–55.*70–85/);
  });
});
