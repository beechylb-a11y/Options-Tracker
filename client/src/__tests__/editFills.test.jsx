/* Correcting a recorded fill (Oct 2026): the QQQ condor's hand fill went in at 2.50
   instead of 5.50 and set the average entry; the Edit form now lists the fills. */
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

const calls = [];
let FILLS = [];
vi.mock('../utils/api', () => ({ api: {
  getFills: () => Promise.resolve(FILLS),
  editFill: (id, patch) => { calls.push(['edit', id, patch]); return Promise.resolve({ ok: true, changed: ['x'] }); },
  deleteFill: id => { calls.push(['delete', id]); FILLS = []; return Promise.resolve({ ok: true }); },
  editTicket: () => Promise.resolve({ ok: true }),
} }));
import EditTicketModal from '../components/EditTicketModal';

const pos = { ticketRef: 54, account: 'paper', underlying: 'QQQ', strategy: 'QQQ - Iron Condor - Normal - 5 contracts', qty: 5,
  legs: '699 / 709 / 805 / 815', entryPrice: 5.81, limitPrice: 5.81, maxProfit: 3015, maxRisk: 5000, status: 'Open', qtyFilled: 5, avgEntry: 2.5 };

describe('edit fills', () => {
  afterEach(() => { cleanup(); calls.length = 0; });
  it('corrects a fill price, keeping it a credit', async () => {
    FILLS = [{ 'Fill ID': 'MANUAL-54-1', 'Ticket Ref': 54, 'Fill Date': '2026-10-08', 'Qty Filled': '5', 'Fill Price': '2.5' }];
    const done = vi.fn();
    render(<EditTicketModal position={pos} onClose={() => {}} onDone={done} />);
    await screen.findByTestId('edit-fills');
    expect(screen.getByLabelText('Fill price').value).toBe('2.5');
    expect(screen.getByTestId('fill-save').disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Fill price'), { target: { value: '5.50' } });
    fireEvent.click(screen.getByTestId('fill-save'));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]).toEqual(['edit', 'MANUAL-54-1', { qtyFilled: 5, fillPrice: 5.5, fillDate: '2026-10-08' }]);
    fireEvent.click(await screen.findByText('Done'));
    expect(done).toHaveBeenCalled();
  });
  it('removes a fill entered by mistake', async () => {
    FILLS = [{ 'Fill ID': 'MANUAL-54-1', 'Ticket Ref': 54, 'Fill Date': '2026-10-08', 'Qty Filled': '5', 'Fill Price': '2.5' }];
    render(<EditTicketModal position={pos} onClose={() => {}} onDone={() => {}} />);
    await screen.findByTestId('edit-fills');
    fireEvent.click(screen.getByTestId('fill-remove'));
    await waitFor(() => expect(calls[0]).toEqual(['delete', 'MANUAL-54-1']));
    await waitFor(() => expect(screen.queryByTestId('edit-fills')).toBeNull());
  });
});
