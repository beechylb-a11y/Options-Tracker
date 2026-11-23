/* Completed orders as the backstop for a close whose fills TWS no longer hands out
   (23 Nov 2026): the META 670/695 put spread's 3.05 target filled Fri 20 Nov; by Monday
   reqExecutions had nothing, but reqCompletedOrders still lists the filled order. */
import { describe, it, expect } from 'vitest';
import { completedRecord, completedYmd, isFilled, withLegs } from '../../../bridge/completedOrders.js';
import { closingFromCompleted } from '../utils/fillMatch';

const bag = (action, lmt, time, permId, status = 'Filled') => withLegs(completedRecord(
  { symbol: 'META', secType: 'BAG', comboLegs: [{ conId: 1, ratio: 1, action: 'BUY' }, { conId: 2, ratio: 1, action: 'SELL' }] },
  { permId, orderId: 0, action, totalQuantity: 1, filledQuantity: status === 'Filled' ? 1 : 0, orderType: 'LMT', lmtPrice: lmt, orderRef: 'papertrade-mqr9v3pt' },
  { status, completedTime: time, completedStatus: status === 'Filled' ? 'Filled Size: 1' : 'Cancelled by Trader' }),
  { 1: { strike: 695, right: 'P', lastTradeDateOrContractMonth: '20261231' }, 2: { strike: 670, right: 'P', lastTradeDateOrContractMonth: '20261231' } });

const entry = bag('SELL', 6.10, '20261117 13:53:29 America/New_York', 501);
const close = bag('BUY', 3.05, '20261120 11:03:33 America/New_York', 777);
const cancelled = bag('BUY', 2.50, '20261119 10:00:00 America/New_York', 600, 'Cancelled');
const pos = { underlying: 'META', strikes: [670, 695], isCredit: true, entryDate: '2026-11-17' };

describe('completed orders', () => {
  it('a combo comes back with its legs resolved', () => {
    expect(close.legs.map(l => `${l.action} ${l.strike}${l.right}`)).toEqual(['BUY 695P', 'SELL 670P']);
    expect(close.resolved).toBe(true);
    expect(completedYmd(close)).toBe('20261120');
    expect(isFilled(close)).toBe(true);
    expect(isFilled(cancelled)).toBe(false);
  });

  it('finds the closing order: same strikes, filled, after entry, paying a debit on a credit spread', () => {
    const c = closingFromCompleted([entry, cancelled, close], pos);
    expect(c).toMatchObject({ qty: 1, avgPrice: 3.05, fromCompleted: true, date: '2026-11-20', time: '11:03', action: 'BUY', keys: ['co:777'] });
  });

  it('the opening order alone is not a close; other strikes and earlier dates are ignored', () => {
    expect(closingFromCompleted([entry], pos)).toBe(null);
    expect(closingFromCompleted([close], { ...pos, strikes: [660, 685] })).toBe(null);
    expect(closingFromCompleted([close], { ...pos, entryDate: '2026-11-21' })).toBe(null);
    const unresolved = { ...close, resolved: false };
    expect(closingFromCompleted([unresolved], pos)).toBe(null);
  });
});
