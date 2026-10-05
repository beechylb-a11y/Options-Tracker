/* Per-strategy exit rules (Oct 2026): tastylive's targets and bases instead of one
   50% for every structure, and the calendar managed on its debit. */
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import { exitRuleFor, EXIT_RULES, CLOSE_DTE_45 } from '../engine/data';
import { ruleLadderPcts, normalisePosition, targetToPrice } from '../utils/ticketMath';
import { calc45DTE } from '../engine/calc45dte';
import ProfitTaker from '../components/ProfitTaker';

afterEach(cleanup);

describe('exit rules table', () => {
  it('carries tastylive targets and the 21-DTE close', () => {
    expect(CLOSE_DTE_45).toBe(21);
    expect(exitRuleFor('45DTE', 'Iron Condor - Normal')).toMatchObject({ target: 50, basis: 'max', closeDte: 21 });
    expect(exitRuleFor('45DTE', 'Iron butterfly').target).toBe(25);
    expect(exitRuleFor('45DTE', 'Calendar spread')).toMatchObject({ target: 25, basis: 'entry' });
    expect(exitRuleFor('0DTE', 'Iron Condor - Normal')).toMatchObject({ target: 25, basis: 'entry' });
    // unlisted keeps the historic default
    expect(exitRuleFor('0DTE', 'Standard butterfly')).toMatchObject({ target: 50, basis: 'entry', chips: null });
    expect(exitRuleFor('45DTE', 'Mystery')).toMatchObject({ target: 50, basis: 'max' });
    Object.values(EXIT_RULES['45DTE']).forEach(r => expect(r.chips).toContain(r.target));
  });

  it('builds a two-tranche ladder around the target', () => {
    expect(ruleLadderPcts(exitRuleFor('45DTE', 'Iron Condor - Normal'), [1])).toEqual([50, 75]);
    expect(ruleLadderPcts(exitRuleFor('45DTE', 'Calendar spread'), [1])).toEqual([15, 25]);
    expect(ruleLadderPcts(exitRuleFor('0DTE', 'Standard butterfly'), [50])).toEqual([50]);
  });

  it('prices a logged calendar target off its debit, not its max profit', () => {
    const pos = normalisePosition({ engine: '45DTE', strategy: 'SPX - Calendar spread - neutral', qty: 1,
      entryPrice: -61, maxProfit: 7000 });
    expect(pos.basis).toBe('entry');
    expect(targetToPrice(pos, 25)).toBeCloseTo(76.25, 2);
    const ic = normalisePosition({ engine: '45DTE', strategy: 'SPX - Iron Condor - Normal - neutral', qty: 1, entryPrice: 3.4 });
    expect(ic.basis).toBe('max');
  });
});

describe('profit taker', () => {
  it('defaults a calendar to 25% of the debit', () => {
    render(<ProfitTaker ncd={-61} win={7000} contracts={1} underlying="SPX" engine="45DTE" strategy="Calendar spread"
      legs={[{ label: 'Long call (back month)', strike: 7775 }, { label: 'Short call (front month)', strike: 7775 }]} commRate={0} />);
    expect(screen.getAllByText(/of the debit/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Sell @ 76\.25/)).toBeTruthy();
    expect(screen.getByTestId('exit-rule').textContent).toMatch(/10–25% of the DEBIT.*close by 21 DTE/);
  });

  it('defaults a 0DTE condor to 25% and a 45DTE condor to 50%', () => {
    const legs = [{ label: 'Short put', strike: 100 }, { label: 'Long put', strike: 95 }];
    const { unmount } = render(<ProfitTaker ncd={2} win={200} contracts={1} underlying="SPX" engine="0DTE" strategy="Iron Condor - Normal" legs={legs} commRate={0} />);
    expect(screen.getByText(/Buy back @ 1\.50/)).toBeTruthy();
    unmount();
    render(<ProfitTaker ncd={2} win={200} contracts={1} underlying="SPX" engine="45DTE" strategy="Iron Condor - Normal" legs={legs} commRate={0} />);
    expect(screen.getByText(/Buy back @ 1\.00/)).toBeTruthy();
  });
});

describe('engine', () => {
  it('estimates a calendar win at 25% of the debit', () => {
    const base = { underlying: 'SPX', price: 7774, ivr: 20, iv: 13, hv: 11, vix: 15, dte: 45, outlook: 'neutral',
      pop: 45, win: 7000, risk: 5400, bankroll: 100000, startBR: 100000, maxLoss: 6000, maxOpen: 20000,
      bpr: 5400, theta: 20, vega: 30, delta: 1 };
    const r = calc45DTE({ ...base, overrideStrategy: 'Calendar spread' });
    expect(r.legStrat).toBe('Calendar spread');
    expect(r.evBasis.mode).toBe('estimated');
    expect(r.evBasis.avgWin).toBeCloseTo(1350, 0);
    expect(r.evBasis.winBasis).toBe('25% of debit');
    const ic = calc45DTE({ ...base, overrideStrategy: 'Iron Condor - Normal' });
    expect(ic.evBasis.avgWin).toBeCloseTo(3500, 0);
  });
});
