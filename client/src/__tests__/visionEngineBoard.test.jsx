/* The Decision Engine ticket in Vision (20 Nov, reordered 24 Nov 2026): decision bar, title
   and data in, numbers | payoff over the price map, legs | TWS, "Why this ticket" folded.
   Solid keeps the stacked layout. */
import React from 'react';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import EnginePanel from '../components/EnginePanel';
import { VisionChoices, choiceBars, NeedsCard } from '../components/VisionTicket';
import { setGlassPref } from '../utils/theme';

const i0 = {
  underlying: 'SPX', price: '7410', high: '7421', low: '7398', vwap5: '7409', vwap5_30: '7409',
  vwapRoll30: '7410', vwapRoll30Prior: '7409', vwapAccept: '0.5', em: '38', atr5: '6.5', atr2h: '22', atr: '61',
  vix: '15.8', vix1d: '12.9', esOvernightHigh: '7430', esOvernightLow: '7388', esClose: '7415',
  priorDayClose: '7398', cashOpen: '7400', esEM: '40', hours: '3.5',
  theta: '38', delta: '-4', lowerWingDelta: '0.08', upperWingDelta: '0.07',
  emSource: 'straddle', straddleCall: '21.5', straddlePut: '20.8', straddleHaircut: '1.2533',
  bankroll: 25000, startBR: 25000, maxLoss: 2500, maxOpen: 4000,
  netCreditDebit: '1.85', win: '185', risk: '1815', pop: '89',
};
const panel = () => render(<EnginePanel mode="0dte" onLogTrade={() => true} accountConfig={{ id: 'acct', bankroll: 25000 }}
  strategyHistory={{}} initialState={{ i0 }} toast={() => {}} />);

describe('Vision engine board', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-02T15:30:00Z')); });
  afterEach(() => { cleanup(); vi.useRealTimers(); act(() => setGlassPref('off')); });

  it('Vision: the ticket in decision order — decision bar, title + data in, numbers | payoff over the price map, legs | TWS', () => {
    act(() => setGlassPref('vision'));
    panel();
    const board = screen.getByTestId('vis-eng-grid');
    const kids = [...board.children];
    expect(kids[0].getAttribute('data-testid')).toBe('vis-decision');
    expect(screen.getByTestId('vis-decision-word').textContent).toMatch(/Blocked/);
    // the blocker's own fix sits on the bar
    expect(screen.getByTestId('vis-decision').textContent).toMatch(/Net credit 1\.85 vs/);
    expect(screen.getByTestId('data-in-chip').dataset.state).toBe('offline');
    const row2 = board.querySelector('.vis-eng-row2');
    expect(row2.querySelector('[data-testid="vis-numbers"]')).not.toBe(null);
    expect(row2.querySelector('[data-testid="vis-choices"]')).not.toBe(null);
    const payoff = row2.querySelector('[data-testid="vis-payoff"]');
    expect(payoff.querySelector('[data-testid="payoff-hero"]')).not.toBe(null);
    expect(payoff.querySelector('[data-testid="vis-price-map"] [data-testid="price-map"]')).not.toBe(null);
    expect(board.querySelector('.vis-eng-row3 [data-testid="vis-tws"]')).not.toBe(null);
    expect(screen.queryByTestId('cockpit')).toBe(null);
    expect(screen.queryByTestId('choices')).toBe(null);
    expect(screen.getByTestId('payoff-hero').textContent).toMatch(/^P&L at the .* close[+−]\$/);
    expect(screen.getAllByTestId('vis-choice').filter(b => b.dataset.current === '1')).toHaveLength(1);
    // six numbers, each with its source
    expect(screen.getByTestId('vis-numbers').querySelectorAll('.vis-num')).toHaveLength(6);
    expect(screen.getByTestId('vis-n-pop').querySelector('[data-testid="source-tag"]').dataset.kind).toBe('typed');
    expect(screen.getByTestId('vis-n-ev').querySelector('[data-testid="source-tag"]').dataset.kind).toBe('model');
    expect(screen.getByTestId('vis-net').querySelector('[data-testid="source-tag"]').dataset.kind).toBe('typed');
  });

  it('Vision: reasoning, warnings, every need and the credit-spread helper fold under "Why this ticket"', () => {
    act(() => setGlassPref('vision'));
    panel();
    expect(screen.queryByTestId('needs-you')).toBe(null);
    fireEvent.click(screen.getByTestId('vis-why-toggle'));
    const why = screen.getByTestId('vis-why');
    expect(why.querySelector('[data-testid="needs-you"]')).not.toBe(null);
    expect(why.textContent).toMatch(/Profits if/);
  });

  it('Vision: the data-in chip opens a row per feed', () => {
    act(() => setGlassPref('vision'));
    panel();
    fireEvent.click(screen.getByTestId('data-in-chip'));
    const p = screen.getByTestId('data-in-panel');
    expect(p.querySelector('[data-testid="data-in-market"]').dataset.state).toBe('off');
    expect(p.querySelector('[data-testid="data-in-greeks"]')).not.toBe(null);
  });

  it('Solid: the stacked layout as before', () => {
    act(() => setGlassPref('off'));
    panel();
    expect(screen.queryByTestId('vis-eng-grid')).toBe(null);
    expect(screen.getByTestId('cockpit')).toBeTruthy();
    expect(screen.queryByTestId('payoff-hero')).toBe(null);
  });
});

describe('choice bars', () => {
  const choices = [
    { name: 'Put credit spread', isCur: true, rr: 0.1, pml: 0.05, rating: 'GOOD' },
    { name: 'Iron condor', isCur: false, rr: 0.4, pml: 0.12, rating: 'GOOD' },
    { name: 'Call credit spread', isCur: false, rr: null, pml: 0.3, rating: 'POOR' },
  ];
  it('scales to the largest value; a missing value draws no bar', () => {
    const b = choiceBars(choices, 'rr');
    expect(b.map(x => x.txt)).toEqual(['0.10×', '0.40×', '—']);
    expect(b[1].h).toBe(1);
    expect(b[0].h).toBeCloseTo(0.25, 5);
    expect(b[2].h).toBe(0);
    expect(choiceBars(choices, 'pml').map(x => x.txt)).toEqual(['5.0%', '12.0%', '30.0%']);
  });
  it('hover ghosts an alternative, click switches to it; the ticket itself does neither', () => {
    const onHover = vi.fn(), onSwitch = vi.fn();
    render(<VisionChoices choices={choices} onHover={onHover} onSwitch={onSwitch} total={13} />);
    const [cur, alt] = screen.getAllByTestId('vis-choice-row');
    fireEvent.mouseEnter(cur); fireEvent.click(cur);
    expect(onHover).not.toHaveBeenCalledWith('Put credit spread');
    expect(onSwitch).not.toHaveBeenCalled();
    fireEvent.mouseEnter(alt); expect(onHover).toHaveBeenLastCalledWith('Iron condor');
    fireEvent.mouseLeave(alt); expect(onHover).toHaveBeenLastCalledWith(null);
    fireEvent.click(alt); expect(onSwitch).toHaveBeenCalledWith('Iron condor');
    fireEvent.click(screen.getByText('Max loss'));
    expect(screen.getAllByTestId('vis-choice')[2].textContent).toBe('30.0%');
  });
});

describe('needs card', () => {
  it('folds to one line and opens on click', () => {
    render(<NeedsCard count={1} first="VIX1D is 22% above its 5-day mean"><div data-testid="inside">list</div></NeedsCard>);
    expect(screen.getByTestId('vis-needs').textContent).toMatch(/1 thing needs you.*VIX1D/);
    expect(screen.queryByTestId('inside')).toBe(null);
    fireEvent.click(screen.getByTestId('vis-needs-toggle'));
    expect(screen.getByTestId('inside')).toBeTruthy();
  });
});
