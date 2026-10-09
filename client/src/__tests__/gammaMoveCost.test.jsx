/* Gamma move cost (Oct 2026). The old |Γ|·ATR÷|Θ| had units of 1/points, so the same
   condor read 10x higher on XSP than on SPX and the block fired on cheaper underlyings
   only. The replacement — what a typical day's move costs in days of decay — is the
   same at any scale, and the block now explains what to do. */
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { gammaMoveCost, gammaFixFor, MOVE_COST_BANDS } from '../engine/calc0dte';
import EnginePanel from '../components/EnginePanel';

describe('gammaMoveCost', () => {
  it('is the same for SPX and XSP versions of one trade', () => {
    // XSP = SPX / 10: gamma per $1 is 10x larger per contract, theta 10x smaller, ATR 10x smaller
    const spx = gammaMoveCost(-3.0, 4340, 61).cost;
    const xsp = gammaMoveCost(-30.0, 434, 6.1).cost;
    expect(spx).toBeCloseTo(xsp, 6);
    expect(spx).toBeGreaterThan(0.5);
    expect(spx).toBeLessThan(MOVE_COST_BANDS.block);
  });
  it('explains the fix without claiming strikes or size help', () => {
    const f = gammaFixFor({ cost: 2.6, sd: 4.4, atr: 6.1, blocked: true, underlying: 'QQQ', legStrat: 'Iron Condor - Normal' });
    expect(f.headline).toMatch(/costs 2\.6 days of the decay this Iron Condor - Normal collects/);
    expect(f.why).toMatch(/about 61% more than the options are pricing/);
    expect(f.why).toMatch(/ATR 6.10 ÷ 1.6/);
    expect(f.notFixes).toMatch(/does not change this/);
    expect(f.steps.map(s => s.kind)).toEqual(['switch', 'wait', 'manage']);
  });
});

const base = {
  underlying: 'SPX', price: '7410', high: '7421', low: '7398', vwap5: '7409', vwap5_30: '7409',
  vwapRoll30: '7410', vwapRoll30Prior: '7409', vwapAccept: '0.5', em: '38', atr5: '6.5', atr2h: '22', atr: '61',
  vix: '15.8', vix1d: '12.9', esOvernightHigh: '7430', esOvernightLow: '7388', esClose: '7415',
  priorDayClose: '7398', cashOpen: '7400', esEM: '40', hours: '3.5',
  theta: '38', delta: '-4', lowerWingDelta: '0.08', upperWingDelta: '0.07',
  emSource: 'straddle', straddleCall: '21.5', straddlePut: '20.8', straddleHaircut: '1.2533',
  bankroll: 25000, startBR: 25000, maxLoss: 600, maxOpen: 900,
};
describe('the block shows what to do', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-02T15:30:00Z')); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });
  it('lists the steps under the blocker', () => {
    render(<EnginePanel mode="0dte" onLogTrade={() => true} accountConfig={{ id: 'acct', bankroll: 25000 }} strategyHistory={{}} toast={() => {}}
      initialState={{ i0: { ...base, netCreditDebit: '6.36', gamma: '-1.2', win: '636', risk: '3364', pop: '92' } }} />);
    const need = screen.getByTestId('need-gamma');
    expect(need.textContent).toMatch(/Gamma risk too high — a typical day's move costs/);
    expect(screen.getByTestId('gamma-fix').textContent).toMatch(/gains from movement/);
    expect(need.textContent).toMatch(/Fetch greeks again/);
  });
});
