/* Dashboard open-positions board (Oct 2026): one row per position with the check-up's
   verdict, position P&L incl. what the rolls banked, stop→target, the strike strip and
   time; rows sorted by urgency; the same figures as the check-up card under it; one
   risk number shared with the Dashboard tile. */
import React from 'react';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { liveRiskTotal } from '../utils/positionLines';
import { boardRow, needsAction } from '../components/PositionBoard';

const T54 = { _rowIndex: 54, Timestamp: '2026-10-08T03:14:12Z', Engine: '45DTE', Underlying: 'QQQ', Strategy: 'QQQ - Iron Condor - Normal - 5 contracts', Contracts: '5', 'Wing Strikes': '699 / 709 / 805 / 815', 'Net Debit/Credit': '2.445', Notes: '' };
const T57 = { _rowIndex: 57, Timestamp: '2026-10-15T16:10:39Z', Engine: '45DTE', Underlying: 'QQQ', Strategy: 'QQQ - Iron Condor - Normal - 5 contracts', Contracts: '5', 'Wing Strikes': '699 / 709 / 755 / 765', 'Net Debit/Credit': '3.77',
  Notes: 'Rolled from TICKET-54 (699 / 709 / 805 / 815, entry 2.44 cr). Net roll 2.27 cr; cumulative basis 4.72 cr.' };
const T62 = { _rowIndex: 62, Timestamp: '2026-10-23T16:14:00Z', Engine: '45DTE', Underlying: 'QQQ', Strategy: 'QQQ - Iron Condor - Normal - 5 contracts', Contracts: '5', 'Wing Strikes': '699 / 709 / 735 / 745', 'Net Debit/Credit': '4.07', Price: '718.2', IV: '21',
  Notes: 'Rolled from TICKET-57 (699 / 709 / 755 / 765, entry 3.77 cr). Net roll 1.54 cr; cumulative basis 6.26 cr.' };
const T60 = { _rowIndex: 60, Timestamp: '2026-10-21T15:54:00Z', Engine: '45DTE', Underlying: 'TSLA', Strategy: 'TSLA - Iron Condor - Normal - 1 contract', Contracts: '1', 'Wing Strikes': '380 / 390 / 480 / 490', 'Net Debit/Credit': '2.20', Price: '436', IV: '48', Notes: '' };
const CLOSES = [{ 'Ticket Ref': '54', 'Close Date': '2026-10-15', 'P&L ($)': '446.5' }, { 'Ticket Ref': '57', 'Close Date': '2026-10-23', 'P&L ($)': '634' }];
// QQQ filled at 3.99 against the 4.07 logged: everything should read the fill.
const OPEN = [
  { ticketRef: 60, timestamp: T60.Timestamp, engine: '45DTE', underlying: 'TSLA', strategy: T60.Strategy, legs: T60['Wing Strikes'], qty: 1, qtyOpen: 1, qtyFilled: 1, avgEntry: 2.20, entryPrice: 2.20, maxRisk: 780, maxProfit: 220, status: 'Open', entryDate: '2026-10-21', realisedPnl: '', closes: [] },
  { ticketRef: 62, timestamp: T62.Timestamp, engine: '45DTE', underlying: 'QQQ', strategy: T62.Strategy, legs: T62['Wing Strikes'], qty: 5, qtyOpen: 5, qtyFilled: 5, avgEntry: 3.99, entryPrice: 4.07, maxRisk: 2965, maxProfit: 2035, status: 'Open', entryDate: '2026-10-23', realisedPnl: '', closes: [] },
];
const Q = { QQQ: { '699P': [6.0, 26, -0.31], '709P': [9.8, 24.5, -0.45], '735C': [4.6, 18, 0.31], '745C': [2.0, 17, 0.16] },
  TSLA: { '380P': [0.9, 55, -0.08], '390P': [1.7, 53, -0.15], '480C': [1.9, 47, 0.19], '490C': [1.0, 46, 0.12] } };
const SPOT = { QQQ: 714.5, TSLA: 438.2 };

vi.mock('../utils/api', () => ({ api: {
  getOpenPositions: () => Promise.resolve(OPEN),
  getDecisions: () => Promise.resolve([T54, T57, T60, T62]),
  getCloses: () => Promise.resolve(CLOSES),
  getStats: () => Promise.resolve({ config: { maxOpenRisk: 12313 } }),
} }));
import OpenPositions from '../components/OpenPositions';
import { clearCheckupCache } from '../components/Checkup45';

describe('open-positions board', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-27T15:00:00Z'));
    localStorage.clear();
    localStorage.setItem('bridgeUrl', 'http://bridge');
    clearCheckupCache();
    global.fetch = vi.fn(url => {
      const u = String(url);
      let body = {};
      if (u.includes('/api/positions')) body = { raw: [
        ...[[699, 'P', 5], [709, 'P', -5], [735, 'C', -5], [745, 'C', 5]].map(([strike, right, qty]) => ({ underlying: 'QQQ', expiry: '20261120', strike, right, qty })),
        ...[[380, 'P', 1], [390, 'P', -1], [480, 'C', -1], [490, 'C', 1]].map(([strike, right, qty]) => ({ underlying: 'TSLA', expiry: '20261127', strike, right, qty }))] };
      else if (u.includes('/api/vol-surface')) { const und = /underlying=(\w+)/.exec(u)[1]; body = { spot: SPOT[und], iv: 30, daily: [] }; }
      else if (u.includes('/api/option-greeks')) {
        const und = /underlying=(\w+)/.exec(u)[1];
        const legs = JSON.parse(decodeURIComponent(u.split('legs=')[1].split('&')[0]));
        body = { undPrice: SPOT[und], legs: legs.map(l => { const z = Q[und][l.strike + l.right] || [1, 20, 0.1]; return { ...l, greeks: { bid: z[0] - 0.03, ask: z[0] + 0.03, iv: z[1], delta: z[2] } }; }) };
      }
      return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify(body)) });
    });
  });
  afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); });

  it('one row per position: verdict, title, position P&L, stop→target, strip and time; urgent first', async () => {
    render(<OpenPositions authenticated account="acct" compact maxOpenRisk={12313} />);
    await waitFor(() => expect(screen.getAllByTestId('board-strip').length).toBe(2), { timeout: 4000 });
    const rows = screen.getAllByTestId('board-row');
    expect(rows.map(r => r.getAttribute('data-action'))).toEqual(['watch', 'hold']);   // QQQ needs a look → first
    const titles = screen.getAllByTestId('board-title').map(e => e.textContent);
    expect(titles[0]).toBe('QQQ 699/709/735/745Iron Condor5 ct20 Nov');
    // QQQ: (3.99 fill − 6.40 to close) × 500 = −$1,205 on the ticket, + $1,080.50 banked
    const pnl = screen.getAllByTestId('board-pnl').map(e => e.textContent);
    expect(pnl[0]).toMatch(/^−\$124banked \+\$1,081/);
    expect(pnl[1]).toMatch(/^\+\$50risk \$780/);
    // stop: 100% of the 3.99 credit on 5 lots = −$1,995, + banked; target off the fill-restated max profit
    expect(screen.getAllByTestId('board-meter')[0].textContent).toBe('−$914+$2,079');
    expect(screen.getAllByTestId('board-time')[0].textContent).toMatch(/^3d30 Oct/);
    expect(screen.getByTestId('board-total-risk').textContent).toMatch(/\$3,785 of \$12,313 · 31%/);
    expect(screen.getByTestId('board-attention').textContent).toMatch(/1 needs a look/);
  });

  it('the row opens the same check-up card, with the same stop and target', async () => {
    render(<OpenPositions authenticated account="acct" compact maxOpenRisk={12313} />);
    await waitFor(() => expect(screen.getAllByTestId('board-primary').length).toBe(2), { timeout: 4000 });
    await waitFor(() => expect(screen.getAllByTestId('board-strip').length).toBe(2), { timeout: 4000 });
    fireEvent.click(screen.getAllByTestId('board-primary')[0]);
    const card = screen.getByTestId('board-checkup');
    expect(card.textContent).toMatch(/stop −\$914/);
    expect(card.textContent).toMatch(/target \+\$2,079/);
    expect(card.textContent).toMatch(/Narrow condor/);
  });

  it('the ⋯ menu holds the other actions', async () => {
    render(<OpenPositions authenticated account="acct" compact maxOpenRisk={12313} />);
    await waitFor(() => expect(screen.getAllByTestId('board-menu').length).toBe(2), { timeout: 4000 });
    fireEvent.click(screen.getAllByTestId('board-menu')[0]);
    expect(screen.getByTestId('board-menu-details')).toBeTruthy();
    expect(screen.getByTestId('board-menu-sell')).toBeTruthy();
    expect(screen.getByTestId('board-menu-roll')).toBeTruthy();
  });
});

describe('shared numbers', () => {
  it('live risk reads the fills, the same for the board and the Dashboard tile', () => {
    // QQQ 699/709/735/745 filled 3.99 → max loss (10 − 3.99) × 500 = 3,005; TSLA 780
    expect(Math.round(liveRiskTotal(OPEN))).toBe(3785);
  });
  it('a working order says Working and is not counted as needing action', () => {
    const r = boardRow({ ...OPEN[0], status: 'Working', qtyFilled: 0, qtyOpen: 0 });
    expect(r.action).toBe('working');
    expect(needsAction(r.action)).toBe(false);
  });
});
