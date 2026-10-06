/* Finding a logged ticket's live legs in TWS positions (Oct 2026). */
import { describe, it, expect } from 'vitest';
import { matchTicketLegs, legsFromNotes, strategyName, parseStrikes } from '../utils/positionMatch';

const raw = [
  { underlying: 'SPX', expiry: '20261120', strike: 7000, right: 'P', qty: 2 },
  { underlying: 'SPX', expiry: '20261120', strike: 7050, right: 'P', qty: -2 },
  { underlying: 'SPX', expiry: '20261120', strike: 7750, right: 'C', qty: -2 },
  { underlying: 'SPX', expiry: '20261120', strike: 7800, right: 'C', qty: 2 },
  { underlying: 'QQQ', expiry: '20261113', strike: 760, right: 'C', qty: -1 },
  { underlying: 'QQQ', expiry: '20261211', strike: 760, right: 'C', qty: 1 },
  { underlying: 'SPY', expiry: '20261120', strike: 740, right: 'P', qty: 1 },
  { underlying: 'SPY', expiry: '20261120', strike: 745, right: 'P', qty: -2 },
  { underlying: 'SPY', expiry: '20261120', strike: 750, right: 'P', qty: 1 },
];

describe('matchTicketLegs', () => {
  it('finds a condor and gives per-lot quantities', () => {
    const m = matchTicketLegs({ underlying: 'SPX', strikes: '7000 / 7050 / 7750 / 7800', strategy: 'Iron Condor - Normal', qtyOpen: 2, todayYmd: '20261016' }, raw);
    expect(m.source).toBe('tws');
    expect(m.legs.map(l => l.qty)).toEqual([1, -1, -1, 1]);
    expect(m.note).toBe('');
  });
  it('finds both expiries of a calendar', () => {
    const m = matchTicketLegs({ underlying: 'QQQ', strikes: '760 / 760', strategy: 'Calendar spread', qtyOpen: 1, todayYmd: '20261016' }, raw);
    expect(m.legs.map(l => l.expiry)).toEqual(['20261113', '20261211']);
  });
  it('keeps a fly body at 2 per lot', () => {
    const m = matchTicketLegs({ underlying: 'SPY', strikes: '740 / 745 / 745 / 750', strategy: 'Standard butterfly', qtyOpen: 1, todayYmd: '20261016' }, raw);
    expect(m.legs.find(l => l.strike === 745).qty).toBe(-2);
  });
  it('says when TWS has nothing', () => {
    expect(matchTicketLegs({ underlying: 'IWM', strikes: '250 / 255', qtyOpen: 1, todayYmd: '20261016' }, raw).legs).toBeNull();
  });
  it('flags a lot mismatch', () => {
    const m = matchTicketLegs({ underlying: 'SPX', strikes: '7000 / 7050 / 7750 / 7800', strategy: 'Iron Condor - Normal', qtyOpen: 1, todayYmd: '20261016' }, raw);
    expect(m.note).toMatch(/TWS holds 2 lots/);
  });
});

describe('ticket text', () => {
  it('reads the Legs line logged in the notes', () => {
    expect(legsFromNotes('Expiries: …\nLegs: +1 7000P 20261120 / -1 7050P 20261120 / -2 7400C 20261120\nmore')).toEqual([
      { qty: 1, strike: 7000, right: 'P', expiry: '20261120' },
      { qty: -1, strike: 7050, right: 'P', expiry: '20261120' },
      { qty: -2, strike: 7400, right: 'C', expiry: '20261120' },
    ]);
    expect(legsFromNotes('no legs here')).toBeNull();
  });
  it('pulls the strategy name and strikes', () => {
    expect(strategyName('SPX - Iron Condor - Normal - 2 contracts')).toBe('Iron Condor - Normal');
    expect(parseStrikes('7000 / 7050 / 7750')).toEqual([7000, 7050, 7750]);
  });
});
