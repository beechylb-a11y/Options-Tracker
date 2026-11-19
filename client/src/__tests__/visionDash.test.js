/* Vision Dashboard numbers (Nov 2026): the cards read the shared closed-trade set. */
import { describe, it, expect } from 'vitest';
import { periodSeries, weekCounts, realisedBars, winRateWindow, monthActivity, needsYou, paceForMonth, mondayOfISO } from '../utils/visionDash';

const t = (d, p, u = 'SPX') => ({ 'Close Date': d, 'Total P&L ($)': String(p), Underlying: u });
const trades = [t('2026-11-02', 100), t('2026-11-11', -2062), t('2026-11-16', 869, 'QQQ'), t('2026-11-17', 2324), t('2026-11-19', 50, 'SPY'), t('2026-11-19', -20, 'IWM'), t('2026-10-20', 300)];
const TODAY = '2026-11-19';   // a Thursday

describe('periodSeries', () => {
  it('runs today close by close', () => {
    const s = periodSeries(trades, 'today', TODAY);
    expect(s.points.map(p => p.cum)).toEqual([0, 50, 30]);
    expect(s).toMatchObject({ total: 30, count: 2 });
    expect(s.steps.map(x => x.label)).toEqual(['SPY', 'IWM']);
  });
  it('runs the week by trading day from Monday', () => {
    const s = periodSeries(trades, 'week', TODAY);
    expect(mondayOfISO(TODAY)).toBe('2026-11-16');
    expect(s.points.slice(1).map(p => p.label)).toEqual(['Mon', 'Tue', 'Wed', 'Thu']);
    expect(s.total).toBe(3223);
    expect(s.count).toBe(4);
  });
  it('runs the month by trading day', () => {
    const s = periodSeries(trades, 'month', TODAY);
    expect(s.total).toBe(1261);
    expect(s.points.length).toBe(1 + 14);     // 14 weekdays 2–19 Nov
  });
});

describe('weekCounts and bars', () => {
  it('counts trades per week and the change on last week', () => {
    const w = weekCounts(trades, TODAY, 4);
    expect(w.counts).toEqual([0, 1, 1, 4]);   // weeks of 26 Oct, 2, 9 and 16 Nov
    expect(w.change).toBe(300);
  });
  it('builds week, month and year bars with the current one flagged', () => {
    const wk = realisedBars(trades, 'week', TODAY);
    expect(wk.map(b => b.pnl)).toEqual([869, 2324, 0, 30, 0]);
    expect(wk[3].now).toBe(true);
    expect(wk[4].future).toBe(true);
    const mo = realisedBars(trades, 'month', TODAY);
    expect(mo[0]).toMatchObject({ label: '1–1', pnl: 0 });
    expect(mo.find(b => b.now).pnl).toBe(3223);
    const yr = realisedBars(trades, 'year', TODAY);
    expect(yr.length).toBe(12);
    expect(yr[11]).toMatchObject({ label: 'Nov', pnl: 1261, now: true });
    expect(yr[10]).toMatchObject({ label: 'Oct', pnl: 300 });
  });
});

describe('tiles', () => {
  it('win rate over 90 days and the change on the 90 before', () => {
    const w = winRateWindow([...trades, t('2026-07-01', -5), t('2026-07-02', 5)], TODAY, 90);
    expect(w.n).toBe(7);
    expect(Math.round(w.rate)).toBe(71);
    expect(w.prev).toBe(50);
    expect(w.change).toBeCloseTo(21.4, 1);
  });
  it('counts this month opened, closed, won and lost', () => {
    const decs = [{ Timestamp: '2026-11-17T15:00:00Z', Status: 'Open' }, { Timestamp: '2026-11-17T16:00:00Z', Status: 'Cancelled' }, { Timestamp: '2026-10-30T15:00:00Z', Status: 'Closed' }];
    expect(monthActivity(trades, decs, TODAY)).toEqual({ opened: 1, closed: 6, won: 4, lost: 2 });
  });
  it('flags a 45DTE position inside 21 DTE and a 0DTE one past 13:30', () => {
    const rows = [{ ticketRef: '72', engine: '45DTE', qtyOpen: 1 }, { ticketRef: '80', engine: '0DTE', qtyOpen: 2 }, { ticketRef: '81', engine: '45DTE', qtyOpen: 0 }];
    const ex = { 72: { expiry: '20261210' }, 81: { expiry: '20261120' } };
    expect(needsYou(rows, ex, { todayYmd: '20261119', nyMinutes: 12 * 60 }).map(x => [x.row.ticketRef, x.badge])).toEqual([['72', '21 DTE']]);
    expect(needsYou(rows, ex, { todayYmd: '20261119', nyMinutes: 14 * 60 }).map(x => x.kind)).toEqual(['roll', 'exit']);
    expect(needsYou(rows, { 72: { expiry: '20261231' } }, { todayYmd: '20261119', nyMinutes: 600 })).toEqual([]);
  });
  it('projects the month return at today\'s pace', () => {
    expect(paceForMonth(1131, 30872, TODAY)).toBe(5.8);
    expect(paceForMonth(100, 0, TODAY)).toBe(null);
  });
});
