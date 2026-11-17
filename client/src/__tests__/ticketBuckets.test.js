// Cancelled orders are not open positions (18 Nov 2026).
import { describe, it, expect } from 'vitest';
import { bucketTickets, ticketBucket, dayPnl } from '../utils/ticketBuckets';

describe('ticket buckets', () => {
  const decs = [
    { _rowIndex: 73, Status: 'Closed' },
    { _rowIndex: 74, Status: 'Open', 'Limit Price': '0.66' },
    { _rowIndex: 75, Status: 'Cancelled', 'Limit Price': '1.20' },
    { _rowIndex: 76, Status: 'Open', 'Limit Price': '1.10' },
    { _rowIndex: 77, Status: 'Open' },
  ];
  const positions = [{ ticketRef: 74, status: 'Open', qtyOpen: 1 }, { ticketRef: 76, status: 'Working' }];
  it('sorts by what is true now', () => {
    const b = bucketTickets(decs, positions);
    expect(b.open.map(d => d._rowIndex)).toEqual([74, 77]);
    expect(b.working.map(d => d._rowIndex)).toEqual([76]);
    expect(b.cancelled.map(d => d._rowIndex)).toEqual([75]);
    expect(b.closed.map(d => d._rowIndex)).toEqual([73]);
  });
  it('without a trade-log row: a limit with no fill is working, a cancel is cancelled', () => {
    expect(ticketBucket({ Status: 'Open', 'Limit Price': '0.5' })).toBe('working');
    expect(ticketBucket({ Status: 'Cancelled' })).toBe('cancelled');
    expect(ticketBucket({ Status: 'Open' }, { status: 'Part filled' })).toBe('open');
  });
  it('day P&L sums the closes dated that session', () => {
    const c = [{ 'Close Date': '2026-11-17', 'P&L ($)': '2324.4', Account: 'A' }, { 'Close Date': '2026-11-16', 'P&L ($)': '80' }, { 'Close Date': '2026-11-17', 'P&L ($)': '-24.4', Account: 'B' }];
    expect(dayPnl(c, '2026-11-17')).toEqual({ pnl: 2300, count: 2 });
    expect(dayPnl(c, '2026-11-17', 'A')).toEqual({ pnl: 2324.4, count: 1 });
  });
});
