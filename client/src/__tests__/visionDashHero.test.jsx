/* Vision Dashboard top row (Nov 2026): today's P&L with the last trading days, month
   vs target as a ring, and the watchlist with live prices. Every number comes from a
   helper another screen uses, so they can't disagree. */
import React from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('../utils/api', () => ({
  api: { getConfig: async () => ({ watchlist: JSON.stringify({ v: 1, scanN: 10, items: [{ sym: 'QQQ', on0: true, on45: true, pin: false }, { sym: 'SPX', on0: true, on45: true, pin: true }, { sym: 'TSLA', on0: false, on45: true, pin: false }] }) }) },
  clearApiCache: () => {},
}));
import VisionDashHero, { recentDays, monthRing, watchSymbols } from '../components/VisionDashHero';
import { todayPnlOf, nyISODate } from '../utils/stats';
import { liveStore } from '../live/liveStore';

afterEach(() => cleanup());
const now = new Date('2026-11-19T16:00:00Z');   // Thu 11:00 NY
const row = (d, p, acct = 'ibkr') => ({ 'Entry Date': d, 'Close Date': d, 'Total P&L ($)': String(p), Status: 'Closed', Account: acct });

describe('helpers', () => {
  it('recentDays: last trading days with closes, oldest first, today always included', () => {
    const rows = [row('2026-11-10', 50), row('2026-11-17', 100), row('2026-11-17', -40), row('2026-11-18', -25)];
    const d = recentDays(rows, 7, now);
    expect(d.map(x => x.date)).toEqual(['2026-11-10', '2026-11-17', '2026-11-18', '2026-11-19']);
    expect(d[1].pnl).toBe(60);
    expect(d[3]).toEqual({ date: '2026-11-19', pnl: 0, today: true });
    expect(recentDays(rows, 2, now).map(x => x.date)).toEqual(['2026-11-18', '2026-11-19']);
  });
  it('monthRing: share of the monthly target, clamped for the ring, the raw % kept', () => {
    expect(monthRing({ month: { pnl: 1650, targetAmt: 2000, targetPct: 8, trades: 9, wins: 7, losses: 2 } })).toMatchObject({ frac: 0.825, pct: 82.5, target: 2000 });
    expect(monthRing({ month: { pnl: 3000, targetAmt: 2000 } }).frac).toBe(1);
    expect(monthRing({ month: { pnl: -300, targetAmt: 2000 } })).toMatchObject({ frac: 0, pct: -15 });
    expect(monthRing({ month: { pnl: 100, targetAmt: 0 } })).toMatchObject({ frac: 0, pct: null });
  });
  it('watchSymbols: pinned first, then the 0DTE list; 45DTE-only symbols left out', () => {
    expect(watchSymbols({ items: [{ sym: 'QQQ', on0: true }, { sym: 'SPX', on0: true, pin: true }, { sym: 'TSLA', on0: false, on45: true }] })).toEqual(['SPX', 'QQQ']);
  });
});

describe('the cards', () => {
  it("today's number is the header's todayPnlOf; month and watch fill from the Journal helper and the stream", async () => {
    const today = nyISODate();
    const rows = [row(today, 185), row(today, -35), row('2026-11-01', 400)];
    liveStore.setConnection('open');
    liveStore.applySnapshot({ seq: 1, status: { connected: true }, quotes: { SPX: { last: 7342.18, close: 7318.4, ts: Date.now() }, QQQ: { last: 650, close: 655, ts: Date.now() } }, positions: [], orders: [] });
    render(<VisionDashHero closedTrades={rows} tracker={rows} decisions={[]} account="all"
      accounts={[{ id: 'ibkr', name: 'IBKR', startingBankroll: 25000, journalTargetPct: 8 }]} />);
    expect(todayPnlOf(rows)).toBe(150);
    expect(screen.getByTestId('vis-today-value').textContent).toMatch(/\$150/);
    expect(screen.getByTestId('vis-today').textContent).toMatch(/2 trades/);
    expect(screen.getByTestId('vis-day-bars').children.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId('vis-month').textContent).toMatch(/of \$2,000 \(8% a month\)/);
    await waitFor(() => expect(screen.getByTestId('vis-watch-SPX').textContent).toMatch(/7,342\.18.*\+0\.32%/));
    expect(screen.getByTestId('vis-watch-QQQ').textContent).toMatch(/650\.00.*-0\.76%/);
    expect(screen.queryByTestId('vis-watch-TSLA')).toBeNull();
  });
});
