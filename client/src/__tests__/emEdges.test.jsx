/* Expected-move edges on the price map (Oct 2026): a line and a price at each end. */
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import EnginePanel from '../components/EnginePanel';

const base = {
  underlying: 'SPX', price: '7410', high: '7421', low: '7398', vwap5: '7409', vwap5_30: '7409',
  vwapRoll30: '7410', vwapRoll30Prior: '7409', vwapAccept: '0.5', em: '38', atr5: '6.5', atr2h: '22', atr: '61',
  vix: '15.8', vix1d: '12.9', esOvernightHigh: '7430', esOvernightLow: '7388', esClose: '7415',
  priorDayClose: '7398', cashOpen: '7400', esEM: '40', hours: '3.5',
  theta: '38', delta: '-4', lowerWingDelta: '0.08', upperWingDelta: '0.07',
  emSource: 'straddle', straddleCall: '21.5', straddlePut: '20.8', straddleHaircut: '1.2533',
  bankroll: 25000, startBR: 25000, maxLoss: 600, maxOpen: 900,
  netCreditDebit: '6.36', gamma: '-0.2', win: '636', risk: '3364', pop: '92',
};

describe('price map EM edges', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-02T15:30:00Z')); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });
  it('draws a line and a price at each end of the expected move', () => {
    render(<EnginePanel mode="0dte" onLogTrade={() => true} accountConfig={{ id: 'acct', bankroll: 25000 }}
      strategyHistory={{}} initialState={{ i0: base }} toast={() => {}} />);
    const g = screen.getByTestId('em-edges');
    expect(g.querySelectorAll('line').length).toBe(2);
    const lo = +screen.getByTestId('em-low').textContent, hi = +screen.getByTestId('em-high').textContent;
    expect(hi).toBeGreaterThan(7410);
    expect(lo).toBeLessThan(7410);
    expect(Math.abs((hi - 7410) - (7410 - lo))).toBeLessThanOrEqual(1);   // symmetric about price
    expect(screen.getByTestId('price-map').getAttribute('aria-label')).toMatch(new RegExp(`${lo} to ${hi}`));
  });
});
