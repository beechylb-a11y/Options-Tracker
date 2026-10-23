/* An expiry is not a target fill.

   The SPX 7620/7660/7700 fly of 22 Oct ran to the bell and settled at 36.57 against a
   16.05 debit. Logged through the exit ticket as an ordinary tranche it was written as

       "T1 128% target @ 36.57 cr"   fees 5.20

   on a trade whose T1 was +25% and which hit no target at all, and it was charged a
   round-trip commission on a cash settlement that had no closing leg. The $2.60 is the
   small half. The label is the real damage: an exit-reason review reading the log counts
   a target as having fired when none did, in the one direction that flatters the rule.

   The IWM 272/275/279 of the same day went in the same way, as "T1 -13% target". */
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

// The real ticket: 1 contract, 16.05 debit, 40-wide fly, max profit $2,395.
const SPX = { _rowIndex: 59, Timestamp: '2026-10-22T15:36:54.510Z', Engine: '0DTE', Underlying: 'SPX',
  Strategy: 'SPX - Standard butterfly - 1 contract', Contracts: '1', 'Wing Strikes': '7620 / 7660 / 7700',
  'Net Debit/Credit': '-16.05', 'Max Profit': '2400', 'Max Risk': '1600', Account: 'papertrade-mqr9v3pt' };

const open = async (dec = SPX) => {
  render(<OrderTicket position={dec} onClose={() => {}} onDone={() => {}} />);
  await waitFor(() => expect(screen.getByText('Expired')).toBeTruthy());
};
const settleAt = v => {
  fireEvent.click(screen.getByText('Expired'));
  fireEvent.change(screen.getByTestId('settle-value'), { target: { value: String(v) } });
};

describe('recording an expiry', () => {
  afterEach(() => { closed.length = 0; cleanup(); });

  it('offers the toggle on an open ticket', async () => {
    await open();
    expect(screen.getByText('Expired')).toBeTruthy();
  });

  it('writes a settlement note, not a target that never fired', async () => {
    await open();
    settleAt(36.57);
    fireEvent.click(screen.getByText(/Record expiry/));
    await waitFor(() => expect(closed.length).toBe(1));
    expect(closed[0].notes).toMatch(/Expired — settlement value 36\.57/);
    expect(closed[0].notes).not.toMatch(/target/i);
    expect(closed[0].notes).not.toMatch(/^T1/);
  });

  it('charges the entry commission only — a cash settlement has no closing leg', async () => {
    await open();
    settleAt(36.57);
    fireEvent.click(screen.getByText(/Record expiry/));
    await waitFor(() => expect(closed.length).toBe(1));
    expect(closed[0].fees).toBeCloseTo(2.60, 2);    // 4 leg-units x $0.65, one side
    expect(closed[0].grossPnl).toBeCloseTo(2052, 0);
    expect(closed[0].closePrice).toBeCloseTo(36.57, 2);
  });

  it('takes every open contract — there is no partial expiry', async () => {
    await open({ ...SPX, Contracts: '5', 'Strategy': 'SPX - Standard butterfly - 5 contracts' });
    settleAt(36.57);
    fireEvent.click(screen.getByText(/Record expiry/));
    await waitFor(() => expect(closed.length).toBe(1));
    expect(closed[0].qtyClosed).toBe(5);
  });

  it('will not record until a settlement value is entered', async () => {
    await open();
    fireEvent.click(screen.getByText('Expired'));
    expect(screen.getByText(/Enter the settlement value/)).toBeTruthy();
  });

  it('says cash settled for SPX and warns about shares for IWM', async () => {
    await open();
    fireEvent.click(screen.getByText('Expired'));
    expect(screen.getByText(/cash settled/)).toBeTruthy();
    cleanup();
    await open({ ...SPX, Underlying: 'IWM', 'Wing Strikes': '272 / 275 / 279',
      Strategy: 'IWM - Asymmetric butterfly - 1 contract', 'Net Debit/Credit': '-1.52' });
    fireEvent.click(screen.getByText('Expired'));
    expect(screen.getByText(/settles into shares/)).toBeTruthy();
  });

  it('still records a real target fill the old way when the toggle is off', async () => {
    await open();
    // Default ladder, first tranche marked Filled at its limit.
    fireEvent.click(screen.getAllByText('Working')[0]);
    fireEvent.click(screen.getByText(/Record 1 filled/));
    await waitFor(() => expect(closed.length).toBe(1));
    expect(closed[0].notes).toMatch(/target @/);
    expect(closed[0].fees).toBeCloseTo(5.20, 2);    // round trip — this one traded out
  });
});
