/* Oct 2026: (1) the 0DTE engine knows when nothing expires today (TSLA on a Thursday);
   (2) single-stock strikes fall back to a grid that exists; (3) a logged ticket can be
   corrected. */
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { calc0DTE } from '../engine/calc0dte';
import { strikeGrid, typedStrikeStep } from '../engine/deltaStrikes';
import { computeScan } from '../utils/multiScan';

const edits = [];
vi.mock('../utils/api', () => ({ api: { editTicket: (ref, patch) => { edits.push({ ref, patch }); return Promise.resolve({ ok: true }); } } }));
import EditTicketModal, { strategyWithCount } from '../components/EditTicketModal';

const tsla = { price: 431.2, high: 436, low: 427, cashOpen: 430, vwap5: 431, vwap5_30: 430.6, vwapRoll30: 431, vwapRoll30Prior: 430.5,
  em: 9, vix: 16, vix1d: 12, atr: 14, atr5: 1.2, atr2h: 5, hours: 4, underlying: 'TSLA',
  bankroll: 25000, startBR: 25000, maxLoss: 600, maxOpen: 900, risk: 0, win: 0, pop: 0, theta: 0, delta: 0, gamma: 0, gamStrike: 0 };

describe('no expiry today', () => {
  it('blocks the 0DTE ticket and names the next expiry', () => {
    const r = calc0DTE({ ...tsla, noExpiryToday: { next: '20261009' } });
    expect(r.hardBlocker).toMatch(/No TSLA options expire today, so there is no 0DTE trade — next expiry Fri 9 Oct/);
  });
  it('does not block when today is listed or unknown', () => {
    expect(calc0DTE(tsla).hardBlocker).toBe('');
  });
  it('the scan shows the row as no expiry instead of ranking it', () => {
    const rows = computeScan('0dte', ['TSLA'], { TSLA: { price: '431.2', _noExpiryToday: true, _nextExpiry: '20261009' } });
    expect(rows[0].error).toMatch(/^No expiry today — next Fri 9 Oct/);
    expect(rows[0].result).toBeNull();
  });
});

describe('strike grid for single stocks', () => {
  it('engine guesses land on strikes that exist; typed strikes keep $0.50', () => {
    expect(strikeGrid('TSLA', 431)).toBe(5);
    expect(strikeGrid('AAPL', 255)).toBe(5);
    expect(strikeGrid('BRK', 1200)).toBe(10);
    expect(strikeGrid('SPX', 7400)).toBe(5);
    expect(strikeGrid('QQQ', 760)).toBe(1);
    expect(typedStrikeStep('TSLA', 431)).toBe(0.5);
    expect(typedStrikeStep('SPX', 7400)).toBe(5);
    const r = calc0DTE({ ...tsla, overrideStrategy: 'Iron Condor - Normal' });
    r.legs.forEach(l => expect(l.strike % 5).toBe(0));
    const r2 = calc0DTE({ ...tsla, overrideStrategy: 'Iron Condor - Normal', overrideStrikes: { 1: 422.5 }, overrideStrikesStrat: 'Iron Condor - Normal' });
    expect(r2.legs[1].strike).toBe(422.5);
  });
});

describe('edit a logged ticket', () => {
  afterEach(() => { cleanup(); edits.length = 0; });
  const pos = { ticketRef: 54, underlying: 'QQQ', strategy: 'QQQ - Iron Condor - Normal - 5 contracts', qty: 5, legs: '699 / 709 / 805 / 815',
    entryPrice: 5.81, limitPrice: 5.81, maxProfit: 2905, maxRisk: 5000, status: 'Working', qtyFilled: 0 };
  it('keeps the count in the strategy name', () => {
    expect(strategyWithCount('QQQ - Iron Condor - Normal - 5 contracts', 4)).toBe('QQQ - Iron Condor - Normal - 4 contracts');
    expect(strategyWithCount('QQQ - Iron Condor - Normal - 5 contracts', 1)).toBe('QQQ - Iron Condor - Normal - 1 contract');
  });
  it('sends only what changed, signed like the ticket', async () => {
    const done = vi.fn();
    render(<EditTicketModal position={pos} onClose={() => {}} onDone={done} />);
    expect(screen.getByTestId('edit-save').disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Contracts'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('Entry, per contract'), { target: { value: '5.75' } });
    fireEvent.change(screen.getByLabelText('Strikes (low → high)'), { target: { value: '700 / 710 / 805 / 815' } });
    expect(screen.getByTestId('edit-save').textContent).toBe('Save 4 changes');
    fireEvent.click(screen.getByTestId('edit-save'));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(edits[0]).toEqual({ ref: 54, patch: { contracts: 4, strategy: 'QQQ - Iron Condor - Normal - 4 contracts',
      wingStrikes: '700 / 710 / 805 / 815', netCreditDebit: 5.75 } });
  });
  it('a debit is stored negative', async () => {
    render(<EditTicketModal position={{ ...pos, entryPrice: -1.07, limitPrice: '', status: 'Open', qtyFilled: 5 }} onClose={() => {}} onDone={() => {}} />);
    fireEvent.change(screen.getByLabelText('Entry, per contract'), { target: { value: '1.10' } });
    fireEvent.click(screen.getByTestId('edit-save'));
    await waitFor(() => expect(edits.length).toBe(1));
    expect(edits[0].patch).toEqual({ netCreditDebit: -1.1 });
  });
});
