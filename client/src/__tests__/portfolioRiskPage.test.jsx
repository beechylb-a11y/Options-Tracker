/* Portfolio Risk page (Oct 2026): the book from the app's own tickets, without the
   bridge — valued with a model at the entry price and IV, and saying so. */
import React from 'react';
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const OPEN = [
  { ticketRef: 10, timestamp: '2026-10-05T14:00:00.000Z', entryDate: '2026-10-05', engine: '45DTE', underlying: 'QQQ',
    strategy: 'QQQ - Iron Condor - 2 contracts', legs: '595 / 600 / 650 / 655', qty: 2, qtyOpen: 2, qtyFilled: 2,
    entryPrice: 1.5, maxRisk: 700, maxProfit: 300, status: 'Open', closes: [] },
  { ticketRef: 11, timestamp: '2026-10-07T15:00:00.000Z', entryDate: '2026-10-07', engine: '0DTE', underlying: 'SPX',
    strategy: 'SPX - Butterfly - 1 contract', legs: '6700 / 6720 / 6740', qty: 1, qtyOpen: 1, qtyFilled: 1,
    entryPrice: -4.2, maxRisk: 420, maxProfit: 1580, status: 'Open', closes: [] },
  { ticketRef: 12, timestamp: '2026-10-09T14:30:00.000Z', entryDate: '2026-10-09', engine: '45DTE', underlying: 'IWM',
    strategy: 'IWM - Put Spread - 3 contracts', legs: '230 / 235', qty: 3, qtyOpen: 0, qtyFilled: 0,
    entryPrice: 1.2, limitPrice: 1.2, maxRisk: 1140, maxProfit: 360, status: 'Working', closes: [] },
];
const DEC = [
  { _rowIndex: 10, Timestamp: '2026-10-05T14:00:00.000Z', Price: '625', IV: '22',
    Notes: 'Legs: +1 595P 20261120 / -1 600P 20261120 / -1 650C 20261120 / +1 655C 20261120\n' },
  { _rowIndex: 11, Timestamp: '2026-10-07T15:00:00.000Z', Price: '6720', VIX1D: '14',
    Notes: 'Legs: +1 6700C 20261007 / -2 6720C 20261007 / +1 6740C 20261007\n' },
  { _rowIndex: 12, Timestamp: '2026-10-09T14:30:00.000Z', Price: '240', IV: '24', Notes: '' },
];

vi.mock('../utils/api', () => ({ api: {
  getOpenPositions: () => Promise.resolve(OPEN),
  getDecisions: () => Promise.resolve(DEC),
  getStats: () => Promise.resolve({ config: { maxOpenRisk: 2000 } }),
  getFills: () => Promise.resolve([]),
} }));
import PortfolioRisk from '../pages/PortfolioRisk';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-09T15:00:00Z'));
  try { localStorage.removeItem('bridgeUrl'); } catch (e) { /* none */ }
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('Portfolio Risk page', () => {
  it('builds the book from tickets with the model, and lists what needs doing', async () => {
    render(<PortfolioRisk authenticated account="all" />);
    await waitFor(() => expect(screen.getByTestId('risk-now')).toBeTruthy());
    expect(screen.getByText(/No IBKR bridge set/)).toBeTruthy();
    expect(screen.getAllByTestId('risk-row')).toHaveLength(3);

    const items = screen.getAllByTestId('attention-item');
    const text = items.map(i => i.textContent).join(' | ');
    expect(text).toMatch(/Expired, still open in the log/);
    expect(text).toMatch(/Order not filled yet/);
    expect(items[0].getAttribute('data-tone')).toBe('red');

    // stress: the condor is the only live position with legs, short gamma → a worst case
    expect(screen.getByTestId('stress-worst').textContent).toMatch(/QQQ Iron Condor/);
    // risk budget: 1,120 open + 1,140 working against a 2,000 cap
    expect(screen.getByTestId('risk-budget').textContent).toMatch(/Over the cap if the working orders fill/);
    expect(screen.getByTestId('risk-reconcile').textContent).toMatch(/Needs the IBKR bridge/);
  });

  it('switches the stress horizon', async () => {
    render(<PortfolioRisk authenticated account="all" />);
    await waitFor(() => expect(screen.getByTestId('risk-stress')).toBeTruthy());
    fireEvent.click(screen.getByText('By tomorrow'));
    expect(screen.getByTestId('risk-stress').textContent).toMatch(/by tomorrow/);
  });
});
