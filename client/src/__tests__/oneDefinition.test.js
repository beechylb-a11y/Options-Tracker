/* Stage 1 of the design sweep (Oct 2026): one definition per number. */
import { describe, it, expect } from 'vitest';
import { wlOf, rowWl, battingAverage, computeStats, mergeClosedTrades, todayPnlOf, nyISODate, directionBadge } from '../utils/stats';

describe('one win/loss rule and one batting average', () => {
  it('a $0 result is a scratch, not a win or a loss', () => {
    expect(wlOf(12)).toBe('Win'); expect(wlOf(-3)).toBe('Loss'); expect(wlOf(0)).toBe('Scratch'); expect(wlOf('')).toBe('Scratch');
    expect(rowWl({ 'W / L': '', 'Total P&L ($)': '5' })).toBe('Win');
  });
  it('batting average is wins over all closed trades, scratches included', () => {
    const s = computeStats([{ 'W / L': 'Win', 'Total P&L ($)': '10' }, { 'W / L': 'Loss', 'Total P&L ($)': '-5' }, { 'W / L': '', 'Total P&L ($)': '0' }, { 'W / L': 'Win', 'Total P&L ($)': '1' }]);
    expect(s.wins).toBe(2); expect(s.losses).toBe(1); expect(s.scratches).toBe(1);
    expect(s.battingAvg).toBe(battingAverage(2, 4));
  });
});

describe('closed trades in close-date order, tickets once, NY today', () => {
  const tracker = [
    { 'Entry Date': '2026-10-01', 'Close Date': '2026-10-20', 'Total P&L ($)': '50', 'W / L': 'Win', Status: 'Closed', Account: 'a' },
    { 'Entry Date': '2026-10-10', 'Close Date': '2026-10-11', 'Total P&L ($)': '-20', 'W / L': 'Loss', Status: 'Closed', Account: 'a' },
    { 'Order #': 'TICKET-7', 'Entry Date': '2026-10-15', 'Close Date': '2026-10-16', 'Total P&L ($)': '30', 'W / L': 'Win', Status: 'Closed', Account: 'a' },
  ];
  const decisions = [{ _rowIndex: 7, Timestamp: '2026-10-15T18:30:00Z', Status: 'Closed', 'Actual P&L': '0', 'Close Date': '2026-10-16', Strategy: 'SPX - Iron Fly - 1 contract', Underlying: 'SPX', Contracts: '1', 'Net Debit/Credit': '2.5', Account: 'a' }];
  it('sorts by close date, so the equity curve never runs backwards', () => {
    const m = mergeClosedTrades(tracker, decisions, 'a');
    expect(m.map(t => t['Close Date'])).toEqual(['2026-10-11', '2026-10-16', '2026-10-20']);
    const tk = m.find(t => t._source === 'ticket');
    expect(tk['W / L']).toBe('Scratch');
    expect(tk['Entry Date']).toBe('2026-10-15');          // NY session, not the UTC day
    expect(tk['Net Credit ($)']).toBe('250');
    expect(m.filter(t => t['Order #'] === 'TICKET-7').length).toBe(0);   // the tranche row is not counted twice
  });
  it('"today" is the New York trading day', () => {
    // 09:00 in Jakarta on 28 Oct is 22:00 ET on 27 Oct
    const at = new Date('2026-10-28T02:00:00Z');
    expect(nyISODate(at)).toBe('2026-10-27');
    expect(todayPnlOf([{ 'Close Date': '2026-10-27', 'Total P&L ($)': '40' }, { 'Close Date': '2026-10-28', 'Total P&L ($)': '9' }], at)).toBe(40);
  });
});

describe('ticket verdict labels', () => {
  it('reads what tickets actually log', () => {
    expect(directionBadge('Strong setup').text).toBe('Go');
    expect(directionBadge('Marginal setup').text).toBe('Caution');
    expect(directionBadge('Roll').text).toBe('Roll');
    expect(directionBadge('Weak setup').text).toBe('No');
    expect(directionBadge('Trade').text).toBe('Go');
    expect(directionBadge('Trade with caution').text).toBe('Caution');
  });
});
