import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
import JournalBenchmark from '../components/JournalBenchmark';
import { runningTotal } from '../utils/benchmark';

const accounts = [{ id: 'a', name: 'IBKR', startingBankroll: 5000 }];

describe('JournalBenchmark card', () => {
  it('shows running total, lost slice and the benchmark editor', () => {
    const rt = runningTotal({ invested: 5000, events: [{ date: '2026-10-02', pnl: -400, account: 'a' }] }, 2026, 9);
    render(<JournalBenchmark rt={rt} members={accounts} accounts={accounts} monthLabel="October" isCurrentMonth />);
    expect(screen.getAllByText('$4,600').length).toBe(2);
    expect(screen.getByText('Lost')).toBeTruthy();
    expect(screen.getByText('(starting bankroll)')).toBeTruthy();
    fireEvent.click(screen.getByText('Benchmark'));
    expect(screen.getByText('Save benchmarks')).toBeTruthy();
    expect(screen.getByText('IBKR')).toBeTruthy();
  });
});
