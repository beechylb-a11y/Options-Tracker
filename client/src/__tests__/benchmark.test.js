import { describe, it, expect } from 'vitest';
import { closedPnlEvents, scopeFor, runningTotal, pieSlices, benchmarkOf, journalSummary, fyStartOf, fyLabel } from '../utils/benchmark';

const accounts = [
  { id: 'bank-1', name: 'TastyTrade', startingBankroll: 3000, journalInvested: 10000, journalSince: '2026-09-01' },
  { id: 'op-1', name: 'IBKR', startingBankroll: 5000 },
  { id: 'papertrade-1', name: 'PaperTrade', journalInvested: 100000 },
];

const tracker = [
  { Status: 'Closed', 'Close Date': '2026-08-20', 'Total P&L ($)': '500', Account: 'bank-1' },   // before since → ignored
  { Status: 'Closed', 'Close Date': '2026-09-10', 'Total P&L ($)': '200', Account: 'bank-1' },
  { Status: 'Closed', 'Close Date': '2026-10-02', 'Total P&L ($)': '-150', Account: 'bank-1' },
  { Status: 'Open', 'Entry Date': '2026-10-03', 'Total P&L ($)': '999', Account: 'bank-1' },     // open → ignored
  { Status: 'Closed', 'Close Date': '2026-10-02', 'Total P&L ($)': '50', Account: 'bank-1', 'Order #': 'TICKET-9' }, // dup → ignored
  { Status: 'Closed', 'Close Date': '2026-10-05', 'Total P&L ($)': '300', Account: 'op-1' },
];
const decisions = [
  { Status: 'Closed', 'Actual P&L': '120', 'Close Date': '2026-10-04', Account: 'bank-1' },
  { Status: 'Closed', 'Actual P&L': '5000', 'Close Date': '2026-10-04', Account: 'papertrade-1' },
];

describe('journal benchmark', () => {
  const events = closedPnlEvents(tracker, decisions);

  it('uses the calendar rules for events', () => {
    expect(events).toHaveLength(6);
  });

  it('falls back to starting bankroll when no benchmark is typed', () => {
    expect(benchmarkOf(accounts[1])).toMatchObject({ invested: 5000, since: '', fromStarting: true, targetPct: 10, targetDefault: true });
  });

  it('single account: offset + P&L since the benchmark date', () => {
    const rt = runningTotal(scopeFor('bank-1', accounts, events), 2026, 9); // October
    expect(rt.invested).toBe(10000);
    expect(rt.startValue).toBe(10200);          // Aug P&L excluded, Sep +200
    expect(rt.endValue).toBe(10170);            // Oct -150 +120
    expect(rt.monthPnl).toBe(-30);
    expect(rt.totalPnl).toBe(170);
    expect(rt.totalReturnPct).toBeCloseTo(1.7);
    expect(rt.series[3].value).toBe(10170);     // 4 Oct close
  });

  it('all accounts: sums real accounts, drops PaperTrade', () => {
    const scope = scopeFor('all', accounts, events);
    expect(scope.members.map(a => a.id)).toEqual(['bank-1', 'op-1']);
    const rt = runningTotal(scope, 2026, 9);
    expect(rt.invested).toBe(15000);
    expect(rt.endValue).toBe(15000 + 200 - 150 + 120 + 300);
  });

  it('pie: invested + returned when up, remaining + lost when down', () => {
    expect(pieSlices({ invested: 1000, totalPnl: 250 }).map(s => [s.key, s.value]))
      .toEqual([['invested', 1000], ['returned', 250]]);
    expect(pieSlices({ invested: 1000, totalPnl: -300 }).map(s => [s.key, s.value]))
      .toEqual([['remaining', 700], ['lost', 300]]);
    expect(pieSlices({ invested: 1000, totalPnl: -1500 }).map(s => s.key)).toEqual(['lost']);
  });

  it('financial year runs July to June', () => {
    expect(fyStartOf(2026, 9)).toEqual({ year: 2026, month: 6 });  // Oct 2026 → Jul 2026
    expect(fyStartOf(2027, 2)).toEqual({ year: 2026, month: 6 });  // Mar 2027 → Jul 2026
    expect(fyLabel(2026, 9)).toBe('FY27');
  });

  it('month: only that month\'s trades, return on month-start bank, vs target', () => {
    const accts = [{ ...accounts[0], journalTargetPct: 5 }];
    const s = journalSummary('bank-1', accts, events, 2026, 9);  // October
    expect(s.month.start).toBe(10200);
    expect(s.month.pnl).toBe(-30);            // -150 + 120, nothing from Sep
    expect(s.month.trades).toBe(2);
    expect(s.month.returnPct).toBeCloseTo(-30 / 10200 * 100);
    expect(s.month.targetPct).toBe(5);
    expect(s.month.targetAmt).toBeCloseTo(510);
    expect(s.month.vsTarget).toBeCloseTo(-540);
  });

  it('FY running total sums Jul → month on screen, benchmark summed the same way', () => {
    const accts = [{ ...accounts[0], journalTargetPct: 5 }];
    const s = journalSummary('bank-1', accts, events, 2026, 9);
    expect(s.fy.rows.map(r => r.label)).toEqual(['Jul', 'Aug', 'Sep', 'Oct']);
    expect(s.fy.pnl).toBe(170);               // Sep +200, Oct -30 (Aug is before the from date)
    expect(s.fy.target).toBeCloseTo(500 + 500 + 500 + 510);
    expect(s.since.returnPct).toBeCloseTo(1.7);
  });

  it('all accounts: target weighted by each account\'s starting bank', () => {
    const accts = [{ ...accounts[0], journalTargetPct: 10 }, { ...accounts[1], journalTargetPct: 4 }, accounts[2]];
    const s = journalSummary('all', accts, events, 2026, 9);
    expect(s.month.targetPct).toBeCloseTo((10 * 10000 + 4 * 5000) / 15000);
  });
});
