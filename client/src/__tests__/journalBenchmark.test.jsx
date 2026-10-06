import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
import JournalBenchmark from '../components/JournalBenchmark';
import { journalSummary } from '../utils/benchmark';

const accounts = [{ id: 'a', name: 'IBKR', startingBankroll: 5000 }];

describe('JournalBenchmark card', () => {
  it('shows running total, lost slice and the benchmark editor', () => {
    const s = journalSummary('a', accounts, [{ date: '2026-10-02', pnl: -400, account: 'a' }], 2026, 9);
    render(<JournalBenchmark s={s} accounts={accounts} monthLabel="October" isCurrentMonth />);
    expect(screen.getByText('October return')).toBeTruthy();
    expect(screen.getByText('FY27 running total')).toBeTruthy();
    expect(screen.getByText('$4,600')).toBeTruthy();      // now worth
    expect(screen.getAllByText('Lost').length).toBe(2);   // month + since start
    expect(screen.getByText(/behind/)).toBeTruthy();
    fireEvent.click(screen.getByText('Benchmark'));
    expect(screen.getByText('Save benchmarks')).toBeTruthy();
    expect(screen.getByText('IBKR')).toBeTruthy();
  });
});
