/* Engine closes are stored twice — the closed ticket and a TICKET-<row> tracker row
   per tranche. The Dashboard / header-strip merge must count each trade once, like
   Journal and the monthly benchmark do. (Oct 2026, from the 15 Oct paper closes.) */
import { describe, it, expect } from 'vitest';
import { mergeClosedTrades, todayPnlOf } from '../utils/stats';

const acct = 'papertrade-mqr9v3pt';
const tracker = [
  // CSV-imported trade: no ticket behind it, always kept
  { 'Order #': '123456', 'Entry Date': '2026-10-01', 'Close Date': '2026-10-01', 'Strategy (OIC)': 'Iron Condor - Normal',
    Underlying: 'SPX', 'Total P&L ($)': '120', 'W / L': 'Win', Status: 'Closed', Account: acct },
  // the close ticket's tracker rows: one full close, one ticket closed in two tranches
  { 'Order #': 'TICKET-56', 'Entry Date': '2026-10-15', 'Close Date': '2026-10-15', 'Strategy (OIC)': 'Asymmetric butterfly',
    Underlying: 'SPX', 'Total P&L ($)': '334.8', 'W / L': 'Win', Status: 'Closed', Account: acct },
  { 'Order #': 'TICKET-53', 'Entry Date': '2026-10-06', 'Close Date': '2026-10-06', 'Strategy (OIC)': 'Bull put spread',
    Underlying: 'QQQ', 'Total P&L ($)': '3.6', 'W / L': 'Win', Status: 'Closed', Account: acct },
  { 'Order #': 'TICKET-53', 'Entry Date': '2026-10-06', 'Close Date': '2026-10-06', 'Strategy (OIC)': 'Bull put spread',
    Underlying: 'QQQ', 'Total P&L ($)': '3.6', 'W / L': 'Win', Status: 'Closed', Account: acct },
  // a tranche whose ticket is still Partial — must not vanish
  { 'Order #': 'TICKET-60', 'Entry Date': '2026-10-16', 'Close Date': '2026-10-16', 'Strategy (OIC)': 'Iron Condor - Normal',
    Underlying: 'QQQ', 'Total P&L ($)': '50', 'W / L': 'Win', Status: 'Closed', Account: acct },
];
const decisions = [
  { _rowIndex: 56, Timestamp: '2026-10-15T14:00:00Z', Strategy: 'SPX - Asymmetric butterfly - 1 contract', Underlying: 'SPX',
    Contracts: '1', Status: 'Closed', 'Close Date': '2026-10-15', 'Actual P&L': '334.8', Account: acct },
  { _rowIndex: 53, Timestamp: '2026-10-06T14:00:00Z', Strategy: 'QQQ - Bull put spread - 4 contracts', Underlying: 'QQQ',
    Contracts: '4', Status: 'Closed', 'Close Date': '2026-10-06', 'Actual P&L': '7.2', Account: acct },
  { _rowIndex: 60, Timestamp: '2026-10-16T14:00:00Z', Strategy: 'QQQ - Iron Condor - Normal - 4 contracts', Underlying: 'QQQ',
    Contracts: '4', Status: 'Partial', 'Close Date': '', 'Actual P&L': '', Account: acct },
];
const accounts = [{ id: acct, name: 'PaperTrade' }];

describe('mergeClosedTrades', () => {
  const merged = mergeClosedTrades(tracker, decisions, acct, accounts);
  const pnl = t => parseFloat(t['Total P&L ($)']);

  it('counts each engine trade once', () => {
    expect(merged.filter(t => t.Underlying === 'SPX' && /butterfly/i.test(t['Strategy (OIC)']))).toHaveLength(1);
    expect(merged.filter(t => /Bull put/.test(t['Strategy (OIC)'])).map(pnl)).toEqual([7.2]);
  });

  it('keeps CSV trades and tranches whose ticket is not closed', () => {
    expect(merged.some(t => t['Order #'] === '123456')).toBe(true);
    expect(merged.some(t => t['Order #'] === 'TICKET-60')).toBe(true);
  });

  it('totals match the stored trades', () => {
    const total = merged.reduce((s, t) => s + pnl(t), 0);
    expect(total).toBeCloseTo(120 + 334.8 + 7.2 + 50, 6);
    expect(merged).toHaveLength(4);
  });

  it('today P&L is not doubled', () => {
    const day = merged.filter(t => t['Close Date'] === '2026-10-15');
    expect(day.reduce((s, t) => s + pnl(t), 0)).toBeCloseTo(334.8, 6);
    expect(typeof todayPnlOf).toBe('function');
  });
});
