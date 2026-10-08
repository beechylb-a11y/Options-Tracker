/* The reconcile screen end to end against a mocked bridge: finds the combo in
   today's executions, offers it against the working ticket, and writes a Fills row
   only after the button is pressed. */
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const added = [];
vi.mock('../utils/api', () => ({
  api: {
    getFills: () => Promise.resolve([]),
    addFill: f => { added.push(f); return Promise.resolve({ ok: true, qtyFilledTotal: f.qtyFilled, qtyRemaining: 3 }); },
  },
}));
import FillReconcile from '../components/FillReconcile';

// QQQ 695/705 bull put spread, 5 ordered at a 1.60 credit, 2 came back at 1.55.
const positions = [{
  ticketRef: 12, underlying: 'QQQ', strategy: 'Bull put spread', engine: '45DTE',
  legs: '695 / 705', qty: 5, qtyFilled: 0, qtyOpen: 0, maxRisk: 2500,
  limitPrice: 1.6, status: 'Working', account: 'DU1',
}];

const execs = [
  { execId: 'a', orderId: 41, time: '20261008 15:40:00', symbol: 'QQQ', secType: 'OPT', side: 'SLD', qty: 2, price: 3.00, strike: 705, right: 'P', commission: 1.30 },
  { execId: 'b', orderId: 41, time: '20261008 15:40:00', symbol: 'QQQ', secType: 'OPT', side: 'BOT', qty: 2, price: 1.45, strike: 695, right: 'P', commission: 1.30 },
];

describe('reconcile entry fills', () => {
  beforeEach(() => {
    added.length = 0;
    localStorage.setItem('bridgeUrl', 'http://bridge');
    global.fetch = vi.fn(() => Promise.resolve({
      ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ fills: execs })),
    }));
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('offers the combo against the ticket and writes it only on confirm', async () => {
    render(<FillReconcile positions={positions} account="DU1" onClose={() => {}} onDone={() => {}} />);

    await waitFor(() => expect(screen.getByText(/ticket 12/)).toBeTruthy());
    // The combo net rebuilt from the legs: sold 3.00, bought 1.45 → 1.55 credit.
    expect(screen.getByText('1.55')).toBeTruthy();
    // Asked 1.60, got 1.55 — five cents worse, and worse reads as positive.
    expect(screen.getByText('+0.05')).toBeTruthy();

    // Nothing is written by looking at it.
    expect(added).toHaveLength(0);
    const btn = screen.getByRole('button', { name: /Record fills/ });
    expect(btn.disabled).toBe(true);

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Record 1 fill/ }));

    await waitFor(() => expect(added).toHaveLength(1));
    expect(added[0]).toMatchObject({
      ticketRef: 12, qtyFilled: 2, fillPrice: 1.55, limitPrice: 1.6,
      qtyOrdered: 5, fillDate: '2026-10-08', fillId: 'TWS-41@20261008154000',
    });
    await waitFor(() => expect(screen.getByText(/1 fill recorded/)).toBeTruthy());
  });

  it('says so plainly when the bridge URL is not set', async () => {
    localStorage.removeItem('bridgeUrl');
    render(<FillReconcile positions={positions} account="DU1" onClose={() => {}} onDone={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Set the IBKR Bridge URL/)).toBeTruthy());
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('has nothing to reconcile when no ticket is waiting on contracts', async () => {
    render(<FillReconcile positions={[{ ...positions[0], qtyFilled: 5, status: 'Open' }]}
      account="DU1" onClose={() => {}} onDone={() => {}} />);
    await waitFor(() => expect(screen.getByText(/No ticket is waiting on contracts/)).toBeTruthy());
    // The fills TWS reported are still shown, because an entry with no ticket is
    // worth knowing about.
    expect(screen.getByText(/no working ticket wanted them/)).toBeTruthy();
  });
});
