/* Vertical strike choices (Oct 2026): one row of tiles, one spread on the ticket.
   Picking a tile replaces the strikes (hand edits included) and clears the old fill. */
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import EnginePanel from '../components/EnginePanel';

const base = {
  underlying: 'SPX', price: '7410', high: '7421', low: '7398', vwap5: '7409', vwap5_30: '7409',
  vwapRoll30: '7410', vwapRoll30Prior: '7409', vwapAccept: '0.5', em: '38', atr5: '6.5', atr2h: '22', atr: '61',
  vix: '15.8', vix1d: '12.9', esOvernightHigh: '7430', esOvernightLow: '7388', esClose: '7415',
  priorDayClose: '7398', cashOpen: '7400', esEM: '40', hours: '3.5',
  theta: '250', delta: '-4', gamma: '-0.2', emSource: 'straddle', straddleCall: '21.5', straddlePut: '20.8', straddleHaircut: '1.2533',
  bankroll: 25000, startBR: 25000, maxLoss: 600, maxOpen: 900,
  netCreditDebit: '1.20', win: '120', risk: '880', pop: '80',
};
const mount = extra => render(<EnginePanel mode="0dte" onLogTrade={() => true} accountConfig={{ id: 'acct', bankroll: 25000 }}
  strategyHistory={{}} toast={() => {}} initialState={{ i0: { ...base }, overrideStrat: 'Bull put spread', ...extra }} />);
const line = () => screen.getByTestId('strike-line').textContent.replace(/[≡ⓘ\s]/g, '');

describe('vertical strike choices', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-02T15:30:00Z')); localStorage.clear(); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('puts ONE spread on the ticket and offers the choices in one row', () => {
    mount();
    ['engine', 'em1d', 'v1d', 'vix', 'delta'].forEach(id => expect(screen.getByTestId('strike-choice-' + id)).toBeTruthy());
    expect(screen.getByTestId('strike-choice-engine').dataset.on).toBe('1');
    expect(line().match(/Put/g).length).toBe(2);                  // two legs, not four
    expect(screen.queryByText('EM(1D):')).toBeNull();
  });

  it('picking a choice changes the strikes and clears the fill priced for the old ones', () => {
    mount();
    const before = line();
    const want = screen.getByTestId('strike-choice-em1d').textContent;
    fireEvent.click(screen.getByTestId('strike-choice-em1d'));
    expect(screen.getByTestId('strike-choice-em1d').dataset.on).toBe('1');
    const k = want.match(/(\d+) \/ (\d+)/);
    expect(line()).toContain(k[1]);
    if (k[1] !== before.match(/\d+/)[0]) expect(line()).not.toBe(before);
    expect(screen.getByTestId('verdict').textContent).toBe('Waiting on sizing');
  });

  it('says when hand edits mean no choice is on the ticket, and a pick replaces them', () => {
    mount({ overrideStrikes: { '0': { strat: 'Bull put spread', map: { 0: 7300 } } } });
    expect(screen.getByTestId('strike-choices').textContent).toMatch(/edited by hand/);
    fireEvent.click(screen.getByTestId('strike-choice-engine'));
    expect(screen.getByTestId('strike-choice-engine').dataset.on).toBe('1');
    expect(line()).not.toContain('7300');
  });
});
