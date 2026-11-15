/* A plan target is not a fill.

   QQQ 62, 11 Nov 2026: the 699/709/735/745 condor (5 × 3.99 cr) was closed from the
   exit ticket by marking its two ladder rungs Filled. The fill boxes still held the
   targets, so the log got 3 @ 2.00 and 2 @ 1.00 — "T1 50% target", "T2 75% target",
   +$1,169 — while QQQ sat ~20 pt under the short put. IBKR's statement: -$1,588.
   The ticket now refuses an untouched target unless it is confirmed against TWS, and
   says in the note where the price came from and whether it won or lost. */
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';

const closed = [];
vi.mock('../utils/api', () => ({ api: {
  getAccounts: () => Promise.resolve([]),
  getFills: () => Promise.resolve([]),
  closeTicket: (ref, body) => { closed.push({ ref, ...body }); return Promise.resolve({ ok: true }); },
} }));
vi.mock('../utils/volSnapshot', () => ({ startCloseVolSnapshot: () => ({}) }));
import OrderTicket from '../components/OrderTicket';

const QQQ = { _rowIndex: 62, Timestamp: '2026-10-23T15:26:11.000Z', Engine: '45DTE', Underlying: 'QQQ',
  Strategy: 'QQQ - Iron Condor - Normal - 5 contracts', Contracts: '5', 'Wing Strikes': '699 / 709 / 735 / 745',
  'Net Debit/Credit': '3.99', 'Max Profit': '1995', 'Max Risk': '3005', Account: 'papertrade-mqr9v3pt' };

const open = async () => {
  render(<OrderTicket position={QQQ} onClose={() => {}} onDone={() => {}} />);
  await waitFor(() => expect(screen.getAllByText('Working').length).toBeGreaterThan(0));
};

describe('closing needs a real fill', () => {
  afterEach(() => { closed.length = 0; cleanup(); });

  it('will not record a rung still at its target', async () => {
    await open();
    fireEvent.click(screen.getAllByText('Working')[0]);
    expect(screen.getByTestId('confirm-fills').textContent).toMatch(/still at its plan target/);
    const btn = screen.getByText(/Enter the real fill price/);
    expect(btn.closest('button').disabled).toBe(true);
    fireEvent.click(btn);
    await new Promise(r => setTimeout(r, 20));
    expect(closed.length).toBe(0);
  });

  it('records a typed fill without asking, and calls a loss a loss', async () => {
    await open();
    fireEvent.click(screen.getAllByText('Working')[0]);
    fireEvent.change(screen.getByTestId('fill-0'), { target: { value: '7.12' } });
    expect(screen.queryByTestId('confirm-fills')).toBeNull();
    fireEvent.click(screen.getByText(/Record \d+ filled/));
    await waitFor(() => expect(closed.length).toBe(1));
    expect(closed[0].closePrice).toBeCloseTo(7.12, 2);
    expect(closed[0].grossPnl).toBeLessThan(0);
    expect(closed[0].notes).toMatch(/^T1 manual fill @ 7\.12 db \(plan 50% @ [\d.]+ db\) · loss/);
    expect(closed[0].notes).not.toMatch(/target @/);
  });

  it('records a target fill once it is confirmed, and says so', async () => {
    await open();
    fireEvent.click(screen.getAllByText('Working')[0]);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByText(/Record \d+ filled/));
    await waitFor(() => expect(closed.length).toBe(1));
    expect(closed[0].notes).toMatch(/target @ [\d.]+ db · win — manual, confirmed at the target price; no TWS fill matched/);
  });
});
