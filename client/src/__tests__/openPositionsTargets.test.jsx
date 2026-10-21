/* Dashboard open positions (Oct 2026): target price and amount, days in the trade,
   banked including a roll; and the upcoming-expiries box from the app's own tickets. */
import React from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ticketExpiry } from '../utils/ticketExpiry';
import { expiryRow } from '../components/UpcomingExpiries';
import { marketClock } from '../engine/marketClock';

const T54 = { _rowIndex: 54, Timestamp: '2026-10-08T03:14:12.659Z', Engine: '45DTE', Underlying: 'QQQ', Strategy: 'QQQ - Iron Condor - Normal - 5 contracts',
  Contracts: '5', 'Wing Strikes': '699 / 709 / 805 / 815', Notes: 'Legs: +1 699P 20261120 / -1 709P 20261120 / -1 805C 20261120 / +1 815C 20261120' };
const T57 = { _rowIndex: 57, Timestamp: '2026-10-15T16:10:39.966Z', Engine: '45DTE', Underlying: 'QQQ', Strategy: 'QQQ - Iron Condor - Normal - 5 contracts',
  Contracts: '5', 'Wing Strikes': '699 / 709 / 755 / 765', Notes: 'Rolled from TICKET-54 (699 / 709 / 805 / 815, entry 2.44 cr). Net roll 2.27 cr; cumulative basis 4.72 cr.' };
const T60 = { _rowIndex: 60, Timestamp: '2026-10-21T14:00:00.000Z', Engine: '0DTE', Underlying: 'SPX', Strategy: 'SPX - Iron Butterfly - 1 contract',
  Contracts: '1', 'Wing Strikes': '6700 / 6740 / 6780', Notes: '' };
const OPEN = [
  { ticketRef: 57, timestamp: T57.Timestamp, entryDate: '2026-10-15', engine: '45DTE', underlying: 'QQQ', strategy: 'QQQ - Iron Condor - Normal - 5 contracts',
    legs: '699 / 709 / 755 / 765', qty: 5, qtyOpen: 5, qtyFilled: 5, entryPrice: 3.77, maxRisk: 3115, maxProfit: 1885, status: 'Open', realisedPnl: '', closes: [] },
  { ticketRef: 60, timestamp: T60.Timestamp, entryDate: '2026-10-21', engine: '0DTE', underlying: 'SPX', strategy: 'SPX - Iron Butterfly - 1 contract',
    legs: '6700 / 6740 / 6780', qty: 1, qtyOpen: 1, qtyFilled: 1, entryPrice: 24.5, maxRisk: 1550, maxProfit: 2450, status: 'Open', realisedPnl: '', closes: [] },
];
vi.mock('../utils/api', () => ({ api: {
  getOpenPositions: () => Promise.resolve(OPEN),
  getDecisions: () => Promise.resolve([T54, T57, T60]),
  getCloses: () => Promise.resolve([{ 'Ticket Ref': '54', 'Close Date': '2026-10-15', 'P&L ($)': '446.5' }]),
  getStats: () => Promise.resolve({ config: { maxOpenRisk: 10000 } }),
} }));
import OpenPositions from '../components/OpenPositions';
import UpcomingExpiries from '../components/UpcomingExpiries';

describe('ticket expiry', () => {
  it('from the Legs line, the roll parent, a roll note, TWS, or the 0DTE session', () => {
    expect(ticketExpiry(T54, [])).toEqual({ expiry: '20261120', source: 'legs' });
    expect(ticketExpiry(T57, [T54, T57])).toEqual({ expiry: '20261120', source: 'roll' });
    expect(ticketExpiry({ ...T57, Notes: T57.Notes + ' Opened new @ 2.49 cr, exp 2026-12-18.' }, [T54])).toEqual({ expiry: '20261218', source: 'roll' });
    expect(ticketExpiry(T60, [])).toEqual({ expiry: '20261021', source: 'session' });
    const raw = [[699, 'P', 5], [709, 'P', -5], [755, 'C', -5], [765, 'C', 5]].map(([strike, right, qty]) => ({ underlying: 'QQQ', expiry: '20261120', strike, right, qty }));
    expect(ticketExpiry({ ...T57, Notes: '' }, [], { raw, todayYmd: '20261021', qtyOpen: 5 })).toEqual({ expiry: '20261120', source: 'tws' });
    expect(ticketExpiry({ ...T57, Notes: '' }, [])).toBe(null);
  });
  it('rows: 45DTE close-by date, 0DTE time to the exit, expired, unknown', () => {
    expect(expiryRow({ expiry: '20261120', engine: '45DTE', strategy: 'Iron Condor - Normal', todayYmd: '20261021' }))
      .toMatchObject({ dte: 30, badge: '30d', tone: 'blue', note: 'close by 30 Oct (21 DTE) — in 9d' });
    expect(expiryRow({ expiry: '20261120', engine: '45DTE', strategy: 'Iron Condor - Normal', todayYmd: '20261027' }).tone).toBe('amber');
    expect(expiryRow({ expiry: '20261021', engine: '0DTE', todayYmd: '20261021', clock: marketClock(new Date('2026-10-21T14:38:00Z')) }))
      .toMatchObject({ badge: 'today', note: '4h 22m to the 15:00 exit' });
    expect(expiryRow({ expiry: '20261020', engine: '0DTE', todayYmd: '20261021' }).badge).toBe('expired');
    expect(expiryRow({ expiry: null }).badge).toBe('?');
  });
});

describe('dashboard', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-21T14:38:00Z')); localStorage.clear(); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('open positions show the target, days in the trade and banked with the roll', async () => {
    render(<OpenPositions authenticated account="all" compact maxOpenRisk={10000} />);
    await waitFor(() => expect(screen.getAllByTestId('op-target').length).toBe(2));
    const [qqqT, spxT] = screen.getAllByTestId('op-target').map(e => e.textContent);
    expect(qqqT).toMatch(/buy back @1\.8[89] \+\$94[23]/);         // 50% of max profit on 5 lots
    expect(spxT).toMatch(/buy back @/);
    await waitFor(() => expect(screen.getAllByTestId('op-days')[0].textContent).toMatch(/13d30 DTE/));   // since 8 Oct, expires 20 Nov
    expect(screen.getAllByTestId('op-days')[1].textContent).toMatch(/0dexpires today/);
    expect(screen.getByTestId('op-roll-banked').textContent).toBe('from the roll');
    expect(document.body.textContent).toMatch(/Banked \+\$447/);
  });

  it('upcoming expiries lists every open ticket, nearest first', async () => {
    render(<UpcomingExpiries authenticated account="all" />);
    await waitFor(() => expect(screen.getAllByTestId('expiry-row').length).toBe(2));
    const rows = screen.getAllByTestId('expiry-row').map(e => e.textContent);
    expect(rows[0]).toMatch(/todaySPX Iron Butterfly.*4h 22m to the 15:00 exit/);
    expect(rows[1]).toMatch(/30dQQQ Iron Condor - Normal20 Nov · close by 30 Oct \(21 DTE\) — in 9d/);
  });
});
