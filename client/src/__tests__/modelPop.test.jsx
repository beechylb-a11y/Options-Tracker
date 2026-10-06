/* POP for trades TWS shows none for (Oct 2026): the managed trade simulated from
   the payoff curve — target or time stop — fills POP and, for time spreads, the
   engine's average win and loss. */
import React from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { curveLegs, positionValue, priceRange, curveAt, curveOutcome, simulateExit, closeDay } from '../engine/payoffCurve';
import { calc45DTE } from '../engine/calc45dte';
import EnginePanel from '../components/EnginePanel';

const ic = () => curveLegs([{ label: 'Long put', strike: 7400 }, { label: 'Short put', strike: 7450 },
  { label: 'Short call', strike: 8100 }, { label: 'Long call', strike: 8150 }], { dteOf: () => 45, baseIV: 13.1 });

describe('outcome models', () => {
  it('a trade entered at model fair has EV near zero when held to the close', () => {
    const cl = ic(), spot = 7774, fair = -positionValue(cl, spot, 0);
    const [lo, hi] = priceRange(cl, spot, 13.1);
    const o = curveOutcome(curveAt(cl, { net: fair, lo, hi, days: 24, n: 400 }), spot, 0.131, 24, Infinity, 0.027);
    expect(Math.abs(o.ev)).toBeLessThan(25);
    expect(o.pop).toBeGreaterThan(0.5); expect(o.pop).toBeLessThan(0.8);
  });

  it('simulates target-or-time exits deterministically', () => {
    const cl = ic(), spot = 7774, fair = -positionValue(cl, spot, 0);
    const a = simulateExit(cl, { net: fair, spot, sigma: 0.131, mu: 0.027, closeDay: 24, target: fair * 50 });
    const b = simulateExit(cl, { net: fair, spot, sigma: 0.131, mu: 0.027, closeDay: 24, target: fair * 50 });
    expect(a).toEqual(b);
    expect(a.paths).toBe(1000);
    expect(a.pTarget).toBeGreaterThan(0); expect(a.avgWin).toBeLessThanOrEqual(fair * 50 + 1e-9);
    expect(simulateExit(cl, { net: fair, spot, sigma: 0.131, closeDay: 0 })).toBeNull();
  });

  it('prices a calendar at its 7-DTE front-leg close', () => {
    const cl = curveLegs([{ label: 'Long call (back month)', strike: 7775 }, { label: 'Short call (front month)', strike: 7775 }],
      { dteOf: l => /back/.test(l.label) ? 73 : 45, ivOf: l => /back/.test(l.label) ? 13.6 : 13.1, baseIV: 13.1, divYield: 0.013 });
    const s = simulateExit(cl, { net: -55, spot: 7774, sigma: 0.131, mu: 0.027, closeDay: closeDay(cl, 7), target: 1375 });
    expect(s.pop).toBeGreaterThan(0.3); expect(s.pop).toBeLessThan(0.8);
    expect(s.pTarget).toBeGreaterThan(0.2);
    expect(s.avgLoss).toBeLessThanOrEqual(5500 + 1);
  });
});

describe('engine', () => {
  it('takes avg win / loss from the curve model for a calendar only', () => {
    const base = { underlying: 'SPX', price: 7774, ivr: 20, iv: 13, hv: 11, vix: 15, dte: 45, outlook: 'neutral',
      pop: 57, win: 7000, risk: 5500, bankroll: 100000, startBR: 100000, maxLoss: 6000, maxOpen: 20000, bpr: 5500 };
    const cm = { pop: 0.57, avgWin: 1287, avgLoss: 2918, pTarget: 0.51, paths: 1000, closeDte: 7, netSource: 'ticket' };
    const cal = calc45DTE({ ...base, overrideStrategy: 'Calendar spread', curveModel: cm });
    expect(cal.evBasis.avgWin).toBe(1287); expect(cal.evBasis.avgLoss).toBe(2918);
    expect(cal.evBasis.curve.pTarget).toBe(0.51);
    expect(cal.ev).toBeLessThan(0);
    const icr = calc45DTE({ ...base, overrideStrategy: 'Iron Condor - Normal', curveModel: cm });
    expect(icr.evBasis.curve).toBeNull();
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

  it('fills a calendar POP from the model and prices EV from the curve', async () => {
    render(<EnginePanel mode="45dte" onLogTrade={() => true} accountConfig={{ id: 'a', bankroll: 100000 }} strategyHistory={{}} toast={() => {}}
      initialState={{ i45: { underlying: 'SPX', price: '7774', iv: '13.1', hv: '11', ivr: '20', vix: '15', dte: '45',
        ivFront: '12.9', ivBack: '13.9', netCreditDebit: '55', win: '7000', risk: '5500', pop: '' }, overrideStrat: 'Calendar spread' }} />);
    await waitFor(() => expect(document.querySelector('input[data-field="pop"]').value).not.toBe(''));
    expect(screen.getByTestId('pop-model-note').textContent).toMatch(/simulated paths, closing at the target or at 7 DTE/);
    await waitFor(() => expect(screen.getAllByText(/EV from the payoff curve/).length).toBeGreaterThan(0));
    expect(screen.getByTestId('exit-sim').textContent).toMatch(/Managed trade/);
  });
});
