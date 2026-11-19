/* Every account at a glance (20 Nov 2026): account colours, the Open tab grouped by
   account with a cushion line and a timeline, the Dashboard position tile's day bars
   from a local mark log, and the monthly target — compact for one account, a ring per
   account for several, editable in place. */
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const saveAccounts = vi.fn(() => Promise.resolve({ ok: true }));
vi.mock('../utils/api', () => ({ api: { saveAccounts: (...a) => saveAccounts(...a) } }));

import { accountColor, ACCOUNT_PALETTE, setAccountsList } from '../utils/accountColors';
import PositionBoard, { groupByAccount, cushionOf, exitProgress, timelineOf } from '../components/PositionBoard';
import { recordMarks, marksFor } from '../live/markLog';
import { dayBars, tradingDays, MonthlyTargetCard, TargetEditor } from '../components/VisionDashboard';

const ACCTS = [
  { id: 'live1', name: 'Live', startingBankroll: 40000, bankroll: 40000, maxOpenRisk: 10000, journalTargetPct: 10 },
  { id: 'acct3', name: 'Account 3', startingBankroll: 15000, bankroll: 15000, color: '#ff8fb8' },
];

afterEach(() => { cleanup(); localStorage.clear(); setAccountsList([]); saveAccounts.mockClear(); });

describe('account colours', () => {
  it('an account keeps its own pick, else takes its palette slot', () => {
    expect(accountColor('acct3', ACCTS)).toBe('#ff8fb8');
    expect(accountColor('live1', ACCTS)).toBe(ACCOUNT_PALETTE[0]);
    expect(accountColor({ id: 'x', color: 'red' }, ACCTS)).toMatch(/var\(/);   // not a hex, not listed
  });
});

describe('Open tab rows', () => {
  it('groups by account in Settings order, with each group’s P&L and risk', () => {
    const rows = [
      { key: 1, account: 'acct3', posPnl: -412, risk: 560 },
      { key: 2, account: 'live1', posPnl: 104, risk: 780 },
      { key: 3, account: 'live1', posPnl: null, risk: 1220 },
    ];
    const g = groupByAccount(rows, ACCTS);
    expect(g.map(x => x.id)).toEqual(['live1', 'acct3']);
    expect(g[0]).toMatchObject({ pnl: 104, priced: 1, risk: 2000 });
    expect(groupByAccount(rows.slice(1), ACCTS)).toEqual([{ id: null, rows: rows.slice(1) }]);
  });

  it('cushion: credit to the nearest short, debit to the nearest break-even', () => {
    const put = [{ strike: 670, right: 'P', qty: 1 }, { strike: 695, right: 'P', qty: -1 }];
    expect(cushionOf({ legs: put, spot: 712.4, credit: true }).text).toBe('17.40 above the 695P · 2.4%');
    const through = cushionOf({ legs: put, spot: 690, credit: true });
    expect(through).toEqual({ ok: false, text: '5.00 through the 695P · 0.7%' });
    const fly = cushionOf({ legs: [], spot: 236.2, credit: false, breakevens: [238.8, 244.6] });
    expect(fly).toEqual({ ok: false, text: '2.60 outside the 238.80 break-even · 1.1%' });
  });

  it('exit progress: each half to its own scale', () => {
    expect(exitProgress(122, -610, 305)).toEqual({ side: 'target', frac: 0.4 });
    expect(exitProgress(-305, -610, 305)).toEqual({ side: 'stop', frac: 0.5 });
    expect(exitProgress(999, -610, 305).frac).toBe(1);
    expect(exitProgress(null, -610, 305)).toBe(null);
  });

  it('timeline: today, the manage line and events placed open → expiry', () => {
    const tl = timelineOf({ startYmd: '20261117', expiry: '20261231', closeYmd: '20261210', events: [{ date: '2026-12-09', label: 'FOMC' }, { date: '2027-01-28', label: 'Earnings' }] }, '20261120');
    expect(tl.now).toBeCloseTo(3 / 44, 5);
    expect(tl.manage).toBeCloseTo(23 / 44, 5);
    expect(tl.managePassed).toBe(false);
    expect(tl.events).toHaveLength(1);   // earnings after expiry is not in the trade
    expect(tl.events[0].label).toMatch(/^FOMC 9 Dec/);
  });

  it('the board shows a head per account, rows under it', () => {
    act(() => setAccountsList(ACCTS));
    const base = { strikes: [670, 695], qtyOpen: 1, strategy: 'Credit spread', action: 'hold', tone: 'green', label: 'Hold', risk: 500, banked: 0, shorts: [], events: [], r: {} };
    const rows = [{ ...base, key: 1, underlying: 'META', account: 'live1', posPnl: 120, stop: -600, target: 300 },
      { ...base, key: 2, underlying: 'IWM', account: 'acct3', posPnl: -40, stop: -480, target: 240 }];
    render(<PositionBoard rows={rows} on={() => {}} />);
    const heads = screen.getAllByTestId('board-group-head').map(e => e.textContent);
    expect(heads[0]).toMatch(/^Live· 1 open\+\$120risk \$500 of \$10,000 cap · 1% of bank/);
    expect(heads[1]).toMatch(/^Account 3· 1 open−\$40/);
    expect(screen.getAllByTestId('board-account').map(e => e.textContent)).toEqual(['Live', 'Account 3']);
  });
});

describe('position tile day bars', () => {
  beforeEach(() => localStorage.clear());
  it('the mark log keeps one P&L per ticket per day and drops old days', () => {
    recordMarks([{ key: 7, posPnl: 40.4 }, { key: 8, posPnl: null }], '20261117');
    recordMarks([{ key: 7, posPnl: 22 }], '20261118');
    expect(marksFor(7)).toEqual({ 20261117: 40, 20261118: 22 });
    expect(marksFor(8)).toEqual({});
    recordMarks([{ key: 7, posPnl: 1 }], '20270401');   // 120 days on: November falls off
    expect(Object.keys(marksFor(7))).toEqual(['20270401']);
  });

  it('weekdays only; marked days green/red by sign, unmarked in the status colour, the manage day white', () => {
    expect(tradingDays('20261120', '20261124')).toEqual(['20261120', '20261123', '20261124']);
    const row = { startYmd: '20261117', expiry: '20261231', closeYmd: '20261210', tone: 'green', stop: -610, target: 305, posPnl: 122, events: [{ date: '2026-12-09' }] };
    const bars = dayBars(row, { 20261117: 40, 20261118: -18 }, '20261120');
    const by = Object.fromEntries(bars.map(b => [b.y, b]));
    expect(by['20261117'].color).toBe('#7ee2a0');
    expect(by['20261118'].color).toBe('#ffa39a');
    expect(by['20261119'].dim).toBe(true);            // no mark seen that day
    expect(by['20261120'].mark).toBe(122);            // today = the live P&L
    expect(by['20261210']).toMatchObject({ manage: true, color: '#ffffff', h: 44 });
    expect(by['20261209'].event).toBe(true);
    expect(by['20261231'].color).toMatch(/0\.30/);    // to come
  });
});

describe('monthly target', () => {
  it('one account: the compact row with an edit button', () => {
    render(<MonthlyTargetCard account="live1" accounts={ACCTS} tracker={[]} decisions={[]} />);
    expect(screen.getByTestId('vd-target').getAttribute('data-layout')).toBe('compact');
    expect(screen.getAllByTestId('vd-target-edit')).toHaveLength(1);
  });

  it('all accounts: a ring and a line per account, each with its own pencil', () => {
    render(<MonthlyTargetCard account="all" accounts={ACCTS} tracker={[]} decisions={[]} />);
    expect(screen.getByTestId('vd-target').getAttribute('data-layout')).toBe('rings');
    const lines = screen.getAllByTestId('vd-target-acct').map(e => e.textContent);
    expect(lines[0]).toMatch(/^Live/);
    expect(lines[1]).toMatch(/^Account 3/);
    expect(screen.getAllByTestId('vd-target-edit')).toHaveLength(2);
  });

  it('the editor saves the target % on the account; $ a month converts on the month’s start', async () => {
    const onSaved = vi.fn();
    render(<TargetEditor acct={ACCTS[0]} start={40000} accounts={ACCTS} onSaved={onSaved} onCancel={() => {}} />);
    fireEvent.click(screen.getByText('$ a month'));
    expect(screen.getByTestId('vd-target-input').value).toBe('4000');
    fireEvent.change(screen.getByTestId('vd-target-input'), { target: { value: '3000' } });
    fireEvent.click(screen.getByTestId('vd-target-save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const sent = saveAccounts.mock.calls[0][0];
    expect(sent.find(a => a.id === 'live1').journalTargetPct).toBe(7.5);
    expect(sent.find(a => a.id === 'acct3')).toEqual(ACCTS[1]);
  });
});
