/* The Sell ticket prices off what was GOT (Oct 2026). The QQQ 699/709/805/815 condor
   was logged at 5.81 credit and filled at 2.50; the ticket showed Entry 5.81 cr,
   max profit $603/ct and a 50% buy-back at 2.79 — a loss shown as +52%. */
import React from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { withEntryFill, avgOfFills, normalisePosition, targetToPrice } from '../utils/ticketMath';

vi.mock('../utils/api', () => ({ api: {
  getAccounts: () => Promise.resolve([]),
  getFills: () => Promise.resolve([
    { 'Ticket Ref': 54, 'Qty Filled': 3, 'Fill Price': 2.5 },
    { 'Ticket Ref': 54, 'Qty Filled': 2, 'Fill Price': 2.5 },
    { 'Ticket Ref': 99, 'Qty Filled': 1, 'Fill Price': 9 },
  ]),
} }));
import OrderTicket from '../components/OrderTicket';

const DEC = { _rowIndex: 54, Timestamp: '2026-10-08T03:14:12.659Z', Engine: '45DTE', Underlying: 'QQQ',
  Strategy: 'QQQ - Iron Condor - Normal - 5 contracts', Contracts: '5', 'Wing Strikes': '699 / 709 / 805 / 815',
  'Net Debit/Credit': '5.81', 'Max Profit': '3015', 'Max Risk': '5000', Account: 'papertrade-x' };

describe('withEntryFill', () => {
  it('takes the fill as the entry and restates a condor\'s max profit and risk', () => {
    const r = withEntryFill({ qty: 5, qtyFilled: 5, avgEntry: 2.5, entryPrice: 5.81, legs: '699 / 709 / 805 / 815',
      strategy: 'QQQ - Iron Condor - Normal - 5 contracts', maxProfit: 3015, maxRisk: 5000 });
    expect(r.entryPrice).toBe(2.5);
    expect(r.askedEntry).toBe(5.81);
    expect(r.maxProfit).toBe(1250);           // 2.50 × 100 × 5
    expect(r.maxRisk).toBe(3750);             // (10 − 2.50) × 100 × 5
    expect(withEntryFill(r)).toBe(r);         // idempotent
    const p = normalisePosition(r);
    expect(p.ncd).toBe(2.5);
    expect(targetToPrice(p, 50)).toBeCloseTo(1.25, 2);   // 50% of max profit: buy back at 1.25
  });
  it('shifts other structures one-for-one with the net', () => {
    const r = withEntryFill({ qty: 2, qtyFilled: 2, avgEntry: -1.2, entryPrice: -1.0, legs: '740 / 742 / 745',
      strategy: 'SPY - Asymmetric butterfly - 2 contracts', maxProfit: 200, maxRisk: 200 });
    expect(r.maxProfit).toBe(160);            // paid 0.20 more on 2 lots
    expect(r.maxRisk).toBe(240);
  });
  it('leaves a ticket with no fills alone', () => {
    const row = { qty: 5, qtyFilled: 0, avgEntry: '', entryPrice: 5.81 };
    expect(withEntryFill(row)).toBe(row);
  });
  it('averages fill rows by quantity', () => {
    expect(avgOfFills([{ 'Qty Filled': 3, 'Fill Price': 2.4 }, { 'Qty Filled': 2, 'Fill Price': 2.65 }]))
      .toEqual({ avgEntry: 2.5, qtyFilled: 5 });
    expect(avgOfFills([])).toBeNull();
  });
});

describe('Sell ticket from a decision row', () => {
  afterEach(() => cleanup());
  it('looks up the fills and shows the entry that was got', async () => {
    render(<OrderTicket position={DEC} onClose={() => {}} onDone={() => {}} />);
    await waitFor(() => expect(screen.getByText('2.50 cr')).toBeTruthy());
    expect(screen.queryByText('5.81 cr')).toBeNull();
    expect(screen.getAllByText(/^\$250(\.00)?$/).length).toBeGreaterThan(0);   // max profit per contract
  });
});
