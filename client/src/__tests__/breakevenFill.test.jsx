/* Break-even fill (Oct 2026): the entry price where EV = 0, and model Win/Risk
   for time spreads. */
import React from 'react';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { solveBreakevenNet, winRiskAtNet } from '../engine/breakeven';
import EnginePanel from '../components/EnginePanel';

describe('solver', () => {
  it('finds the zero of a rising EV', () => {
    const r = solveBreakevenNet(n => 100 * (n - 1.37), 0, 5);
    expect(r.status).toBe('ok'); expect(r.net).toBeCloseTo(1.37, 4);
    expect(solveBreakevenNet(n => -1, 0, 5).status).toBe('none');
    expect(solveBreakevenNet(n => 1, 0, 5).status).toBe('any');
  });
  it('shifts win and risk one-for-one with the fill', () => {
    // 5-wide condor: intrinsic payoff 0 .. −500
    expect(winRiskAtNet(0, -500, 1.5)).toEqual({ win: 150, risk: 350 });
    // 5-wide long fly: 0 .. +500
    expect(winRiskAtNet(500, 0, -0.64)).toEqual({ win: 436, risk: 64 });
  });
});

describe('panel', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-06T15:00:00Z'));
    localStorage.clear();
    global.fetch = vi.fn(async () => ({ json: async () => ({}) }));
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('fills a calendar win and risk from the curve and solves its break-even debit', async () => {
    render(<EnginePanel mode="45dte" onLogTrade={() => true} accountConfig={{ id: 'a', bankroll: 100000 }} strategyHistory={{}} toast={() => {}}
      initialState={{ i45: { underlying: 'SPX', price: '7774', iv: '13.1', hv: '11', ivr: '20', vix: '15', dte: '45',
        ivFront: '12.9', ivBack: '13.9', netCreditDebit: '52.24', win: '', risk: '', pop: '' }, overrideStrat: 'Calendar spread' }} />);
    await waitFor(() => expect(document.querySelector('input[data-field="risk"]').value).toBe('5224'));
    expect(Number(document.querySelector('input[data-field="win"]').value)).toBeGreaterThan(3000);
    expect(screen.getByTestId('risk-model-note')).toBeTruthy();
    await waitFor(() => expect(screen.getAllByTestId('breakeven-fill').length).toBeGreaterThan(0));
    expect(screen.getAllByTestId('breakeven-fill')[0].textContent).toMatch(/pay ≤ \d+\.\d\d debit|No fill gives EV/);
    // the vol view is flagged wherever the break-even shows
    expect(screen.getAllByTestId('vol-view-flag')[0].textContent).toMatch(/Vol view not priced/);
    // typing a risk replaces the model value
    fireEvent.change(document.querySelector('input[data-field="risk"]'), { target: { value: '5300' } });
    await waitFor(() => expect(document.querySelector('input[data-field="risk"]').value).toBe('5300'));
  });

  it('solves a 0DTE condor break-even credit and puts it in the net field', async () => {
    render(<EnginePanel mode="0dte" onLogTrade={() => true} accountConfig={{ id: 'a', bankroll: 25000 }} strategyHistory={{}} toast={() => {}}
      initialState={{ i0: { underlying: 'SPX', price: '6700', high: '6710', low: '6690', vwap5: '6700', vwap5_30: '6700', vwapRoll30: '6700',
        vwapRoll30Prior: '6700', vwapAccept: '0.5', em: '40', atr: '60', atr5: '6', atr2h: '20', vix: '15', vix1d: '12', hours: '4',
        bankroll: 25000, startBR: 25000, maxLoss: 600, maxOpen: 900, pop: '80', netCreditDebit: '0.50', win: '50', risk: '450' },
        overrideStrat: 'Iron Condor - Normal' }} />);
    await waitFor(() => expect(screen.getAllByTestId('breakeven-fill').length).toBeGreaterThan(0));
    const line = screen.getAllByTestId('breakeven-fill')[0];
    // the 25%-target break-even is information, not the scored number
    expect(within(line).getByTestId('breakeven-target-info').textContent).toMatch(/If winners bank your 25% target/);
    if (/receive ≥/.test(line.textContent)) {
      const m = line.textContent.match(/receive ≥ (\d+\.\d\d)/);
      fireEvent.click(within(line).getByText('use'));
      await waitFor(() => expect(Number(document.querySelector('input[data-field="netCreditDebit"]').value)).toBeGreaterThanOrEqual(Number(m[1])));
    } else {
      expect(line.textContent).toMatch(/No fill gives EV|EV ≥ 0 at any fill/);
    }
  });
});
