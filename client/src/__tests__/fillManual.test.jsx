/* Fills by hand (Oct 2026): TWS only reports today's executions, so an order that
   filled another day — or with no bridge at all — is typed on the reconcile screen. */
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { manualFillPayload, ticketSide } from '../utils/fillMatch';

const added = [];
vi.mock('../utils/api', () => ({
  api: {
    getFills: () => Promise.resolve([]),
    addFill: f => { added.push(f); return Promise.resolve({ ok: true, qtyFilledTotal: f.qtyFilled, qtyRemaining: 0 }); },
  },
}));
import FillReconcile from '../components/FillReconcile';

const condor = { ticketRef: 54, underlying: 'QQQ', strategy: 'QQQ - Iron Condor - Normal - 5 contracts', engine: '45DTE',
  legs: '699 / 709 / 805 / 815', qty: 5, qtyFilled: 0, qtyOpen: 0, maxRisk: 5000, limitPrice: 5.81, status: 'Working', account: 'paper' };

describe('manual fill payload', () => {
  it('signs by side and keeps a unique id', () => {
    expect(ticketSide(condor)).toBe('cr');
    expect(ticketSide({ limitPrice: -1.07 })).toBe('db');
    const p = manualFillPayload(condor, { qty: 5, price: 5.75, date: '2026-10-09' }, 123);
    expect(p).toMatchObject({ fillId: 'MANUAL-54-123', ticketRef: 54, qtyFilled: 5, qtyOrdered: 5, fillPrice: 5.75, fillDate: '2026-10-09', notes: 'Entered by hand' });
    expect(manualFillPayload(condor, { qty: 2, price: 1.1, side: 'db' }).fillPrice).toBe(-1.1);
    expect(manualFillPayload(condor, { qty: 0, price: 5 })).toBeNull();
  });
});

describe('reconcile screen, by hand', () => {
  beforeEach(() => {
    added.length = 0;
    localStorage.setItem('bridgeUrl', 'http://bridge');
    global.fetch = vi.fn(() => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ fills: [] })) }));
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('records a typed fill when TWS has nothing', async () => {
    render(<FillReconcile positions={[condor]} account="paper" onClose={() => {}} onDone={() => {}} />);
    await screen.findByText(/Nothing in today's executions/);
    expect(screen.getByTestId('record-fills').disabled).toBe(true);
    fireEvent.click(screen.getByTestId('manual-open'));
    expect(screen.getByLabelText('Contracts filled (by hand)').value).toBe('5');
    expect(screen.getByLabelText('Fill price per contract (by hand)').value).toBe('5.81');
    fireEvent.change(screen.getByLabelText('Fill price per contract (by hand)'), { target: { value: '5.75' } });
    fireEvent.change(screen.getByLabelText('Contracts filled (by hand)'), { target: { value: '7' } });
    expect(screen.getByTestId('manual-row').textContent).toMatch(/Only 5 still resting/);
    expect(screen.getByTestId('record-fills').disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Contracts filled (by hand)'), { target: { value: '3' } });
    fireEvent.click(screen.getByTestId('record-fills'));
    await waitFor(() => expect(added.length).toBe(1));
    expect(added[0]).toMatchObject({ ticketRef: 54, qtyFilled: 3, fillPrice: 5.75, notes: 'Entered by hand' });
    expect(added[0].fillId).toMatch(/^MANUAL-54-/);
    await screen.findByText(/\(by hand\)/);
  });

  it('works with no bridge set', async () => {
    localStorage.removeItem('bridgeUrl');
    render(<FillReconcile positions={[condor]} account="paper" onClose={() => {}} onDone={() => {}} />);
    await screen.findByText(/Set the IBKR Bridge URL/);
    fireEvent.click(screen.getByTestId('manual-open'));
    fireEvent.click(screen.getByTestId('record-fills'));
    await waitFor(() => expect(added.length).toBe(1));
    expect(added[0]).toMatchObject({ qtyFilled: 5, fillPrice: 5.81 });
  });
});
