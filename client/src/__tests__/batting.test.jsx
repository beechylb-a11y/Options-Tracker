/* Batting average dial (23 Nov 2026): a ring per real-money account, the overall in
   the centre, red under 65 / amber 65–75 / green 75+, paper listed but not counted. */
import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
vi.mock('../utils/api', () => ({ api: {} }));
import { battingByAccount, baZone } from '../utils/batting';
import { BA_GREEN, BA_RED } from '../utils/stats';
import { BattingTile } from '../components/VisionDashboard';

afterEach(cleanup);

const ACCTS = [{ id: 'papertrade-1', name: 'PaperTrade' }, { id: 'live-1', name: 'Live' }, { id: 'acct3', name: 'Account 3' }];
let n = 0;
const dec = (account, pnl, date) => ({ Status: 'Closed', 'Actual P&L': String(pnl), Account: account, Timestamp: date + 'T15:00:00Z', 'Close Date': date, _rowIndex: ++n, Strategy: 'X - Put spread - 1 contract' });
const decisions = [
  ...Array.from({ length: 17 }, () => dec('live-1', 100, '2026-11-10')), ...Array.from({ length: 7 }, () => dec('live-1', -200, '2026-11-11')),
  ...Array.from({ length: 7 }, () => dec('acct3', 80, '2026-11-12')), ...Array.from({ length: 5 }, () => dec('acct3', -90, '2026-11-12')),
  ...Array.from({ length: 31 }, () => dec('papertrade-1', 50, '2026-11-13')), ...Array.from({ length: 12 }, () => dec('papertrade-1', -60, '2026-11-13')),
  dec('live-1', -300, '2026-05-01'),
];

describe('bands', () => {
  it('red under 65, amber 65 to 75, green 75 and up', () => {
    expect([BA_RED, BA_GREEN]).toEqual([65, 75]);
    expect([baZone(64.9), baZone(65), baZone(74.9), baZone(75), baZone(null)]).toEqual(['red', 'amber', 'amber', 'green', null]);
  });
});

describe('batting by account', () => {
  it('per account, overall of the real ones, paper apart, in a window', () => {
    const b = battingByAccount({ tracker: [], decisions, accounts: ACCTS, todayISO: '2026-11-23', days: 90 });
    const by = Object.fromEntries(b.rows.map(r => [r.id, r]));
    expect(by['live-1']).toMatchObject({ wins: 17, total: 24, paper: false });
    expect(by.acct3).toMatchObject({ wins: 7, total: 12 });
    expect(by['papertrade-1']).toMatchObject({ wins: 31, total: 43, paper: true });
    expect(b.rows[b.rows.length - 1].id).toBe('papertrade-1');
    expect(b.overall).toMatchObject({ wins: 24, total: 36 });
    expect(Math.round(b.overall.ba)).toBe(67);
    // All time picks up the May loss
    expect(battingByAccount({ tracker: [], decisions, accounts: ACCTS, todayISO: '2026-11-23', days: null }).overall.total).toBe(37);
  });
});

describe('batting tile', () => {
  it('dial with the overall number, rows per account, paper not counted, window switch', () => {
    render(<BattingTile tracker={[]} decisions={decisions} accounts={ACCTS} account="all" />);
    expect(screen.getByTestId('batting-dial-number').textContent).toBe('67%');
    expect(screen.getByTestId('ba-row-papertrade-1').textContent).toMatch(/excluded/);
    expect(screen.getByTestId('ba-row-live-1').textContent).toMatch(/71%.*17\/24/);
    fireEvent.click(screen.getByTestId('ba-window-All'));
    expect(screen.getByTestId('batting-dial').textContent).toMatch(/37 closed/);
  });
  it('one account picked shows that account alone', () => {
    render(<BattingTile tracker={[]} decisions={decisions} accounts={ACCTS} account="acct3" />);
    expect(screen.getByTestId('batting-dial-number').textContent).toBe('58%');
    expect(screen.getAllByTestId(/^ba-row-/)).toHaveLength(1);
  });
});
