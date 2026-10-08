/* Open positions rows (Oct 2026): a credit condor's stop read "@11.62 db −$581", which
   looked like a debit fill and priced one contract of five. The row now shows the entry,
   the stop as "buy back @", the loss on every contract, and clicking a row opens the
   fill screen (resting order) or the Sell ticket (filled). */
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

const ROWS = [
  { ticketRef: 'w1', timestamp: '2026-10-08T03:14:00Z', entryDate: '2026-10-08', entryTime: '23:14', engine: '45DTE',
    underlying: 'QQQ', strategy: 'QQQ - Iron Condor - Normal - 5 contracts', legs: '699 / 709 / 805 / 815',
    qty: 5, qtyOpen: 0, qtyFilled: 0, entryPrice: 5.81, limitPrice: 5.81, maxRisk: 5000, status: 'Working', closes: [], realisedPnl: '' },
  { ticketRef: 'o1', timestamp: '2026-10-06T15:00:00Z', entryDate: '2026-10-06', entryTime: '11:00', engine: '0DTE',
    underlying: 'SPY', strategy: 'SPY - Asymmetric butterfly - 2 contracts', legs: '740 / 742 / 745',
    qty: 2, qtyOpen: 2, qtyFilled: 2, entryPrice: -1.07, maxRisk: 214, status: 'Open', closes: [], realisedPnl: '' },
];
vi.mock('../utils/api', () => ({ api: { getOpenPositions: () => Promise.resolve(ROWS), getStats: () => Promise.resolve({ config: {} }) } }));
vi.mock('../components/FillReconcile', () => ({ default: ({ positions }) => <div data-testid="fill-screen">{positions.map(p => p.ticketRef).join(',')}</div> }));
vi.mock('../components/OrderTicket', () => ({ default: ({ position, initialTab }) => <div data-testid="sell-ticket">{position.ticketRef}:{initialTab}</div> }));
import OpenPositions from '../components/OpenPositions';

describe('open positions rows', () => {
  afterEach(() => cleanup());
  it('shows entry and an unambiguous stop on all contracts', async () => {
    render(<OpenPositions authenticated account="acct" compact maxOpenRisk={10000} />);
    await waitFor(() => expect(screen.getAllByTestId('op-row').length).toBe(2));
    const [w, o] = screen.getAllByTestId('op-entry').map(e => e.textContent);
    expect(w).toBe('lmt cr 5.81');
    expect(o).toBe('db 1.07');
    const st = screen.getAllByTestId('op-stop').map(e => e.textContent);
    expect(st[0]).toMatch(/^buy back @11\.62 −\$2905$/);        // 5 contracts, once filled
    expect(st[1]).toMatch(/^sell @0\.00 −\$214$/);
  });
  it('opens the fill screen for a resting order and the Sell ticket for a filled one', async () => {
    render(<OpenPositions authenticated account="acct" compact maxOpenRisk={10000} />);
    await waitFor(() => expect(screen.getAllByTestId('op-row').length).toBe(2));
    fireEvent.click(screen.getAllByTestId('op-row')[0]);
    expect(screen.getByTestId('fill-screen').textContent).toBe('w1');
    cleanup();
    render(<OpenPositions authenticated account="acct" compact maxOpenRisk={10000} />);
    await waitFor(() => expect(screen.getAllByTestId('op-row').length).toBe(2));
    fireEvent.click(screen.getAllByTestId('op-row')[1]);
    expect(screen.getByTestId('sell-ticket').textContent).toBe('o1:close');
  });
});
