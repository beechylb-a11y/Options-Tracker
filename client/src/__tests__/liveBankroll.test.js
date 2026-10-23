/* Live bankroll (Oct 2026): starting bankroll + realised P&L since the account's
   start date, each closed piece counted once. */
import { describe, it, expect } from 'vitest';
import { realisedItems, withLiveBankroll, stripLive } from '../../../server/bankroll.js';

const DEC_H = ['Timestamp', 'Engine', 'Underlying', 'Strategy', 'Status', 'Close Date', 'Actual P&L', 'Account'];
const decRows = [DEC_H,
  ['2026-06-20T14:00:00Z', '0DTE', 'SPX', 'SPX - Fly - 1 contract', 'Closed', '2026-06-20', '-80', 'paper'],      // row 2: before the start date
  ['2026-08-05T14:00:00Z', '0DTE', 'SPX', 'SPX - Fly - 1 contract', 'Closed', '2026-08-05', '$1,200.50', 'paper'], // row 3: legacy close on the row
  ['2026-10-08T03:14:00Z', '45DTE', 'QQQ', 'QQQ - IC - 5 contracts', 'Closed', '2026-10-15', '446.5', 'paper'],   // row 4: has Closes rows
  ['2026-10-15T16:10:00Z', '45DTE', 'QQQ', 'QQQ - IC - 5 contracts', 'Open', '', '', 'paper'],                     // row 5: open, one tranche sold
  ['2026-09-01T14:00:00Z', '0DTE', 'SPX', 'SPX - Fly - 1 contract', 'Closed', '2026-09-01', '75', 'ibkr'],
];
const closeRows = [['Close ID', 'Ticket Ref', 'Close Date', 'P&L ($)', 'Account'],
  ['C1', '4', '2026-10-15', '446.5', 'paper'],
  ['C2', '5', '2026-10-20', '-120', 'paper'],
];
const trackerRows = [['Order #', 'Entry Date', 'Close Date', 'Total P&L ($)', 'Status', 'Account'],
  ['TICKET-4', '2026-10-08', '2026-10-15', '446.5', 'Closed', 'paper'],      // the engine close again: not counted twice
  ['A123', '2026-07-10', '2026-07-12', '300', 'Closed', 'paper'],             // an imported trade
  ['A124', '2026-07-20', '', '', 'Open', 'paper'],
];
const accounts = [
  { id: 'paper', name: 'PaperTrade', bankroll: 25000, startingBankroll: 25000, journalSince: '2026-07-01' },
  { id: 'ibkr', name: 'IBKR', bankroll: 3000, startingBankroll: 3000, bankrollSince: '2026-10-01' },
  { id: 'new', name: 'New', bankroll: 1000 },
];

describe('live bankroll', () => {
  const items = realisedItems({ decRows, closeRows, trackerRows });
  it('counts each closed piece once: tranches, legacy closes, imported trades', () => {
    expect(items.filter(i => i.account === 'paper').map(i => `${i.source} ${i.date} ${i.pnl}`).sort()).toEqual([
      'close 2026-10-15 446.5', 'close 2026-10-20 -120', 'import 2026-07-12 300', 'ticket 2026-06-20 -80', 'ticket 2026-08-05 1200.5',
    ]);
  });
  it('bankroll = starting + realised since the start date', () => {
    const [paper, ibkr, fresh] = withLiveBankroll(accounts, items);
    expect(paper.realisedPnl).toBe(1827);                // 1200.50 + 446.50 − 120 + 300; June's −80 is before 1 Jul
    expect(paper.bankroll).toBe(26827);
    expect(paper.realisedCount).toBe(4);
    expect(paper.lastTradeDate).toBe('2026-10-20');
    expect(ibkr.bankroll).toBe(3000);                     // its 1 Sep trade is before its own start date
    expect(fresh).toMatchObject({ startingBankroll: 1000, bankroll: 1000, realisedPnl: 0 });
    expect(stripLive([paper])[0]).not.toHaveProperty('realisedPnl');
  });
});
