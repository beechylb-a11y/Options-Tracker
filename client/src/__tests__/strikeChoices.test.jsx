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
    ['engine', 'half1d', 'em1d', 'vix', 'delta'].forEach(id => expect(screen.getByTestId('strike-choice-' + id)).toBeTruthy());
    expect(screen.getByTestId('strike-choice-engine').dataset.on).toBe('1');
    expect(line().match(/Put/g).length).toBe(2);                  // two legs, not four
    expect(screen.queryByText('EM(1D):')).toBeNull();
  });

  it('picking a choice changes the strikes and clears the fill priced for the old ones', () => {
    mount();
    const before = line();
    const want = screen.getByTestId('strike-choice-vix').textContent;
    fireEvent.click(screen.getByTestId('strike-choice-vix'));
    expect(screen.getByTestId('strike-choice-vix').dataset.on).toBe('1');
    const k = want.match(/(\d+) \/ (\d+)/);
    expect(line()).toContain(k[1]);
    expect(line()).not.toBe(before);
    expect(screen.getByTestId('verdict').textContent).toBe('Waiting on sizing');
  });

  it('credit spread: short at the IVX EM, a fixed $20 width, and a 25% target near the money (Oct 2026)', () => {
    mount();
    // straddle 21.5 + 20.8 = 42.3 → IVX EM 0.85 × 42.3 = 36 → short 7410 − 36 → 7375 (buffered to 7370)
    const k = screen.getByTestId('strike-choice-engine').textContent.match(/(\d+) \/ (\d+)/).slice(1).map(Number);
    expect(k[0] - k[1]).toBe(20);
    expect(7410 - k[0]).toBeGreaterThanOrEqual(35);
    expect(7410 - k[0]).toBeLessThanOrEqual(45);
    // the old default (full VIX EM, √252) is still offered and is further out
    const old = screen.getByTestId('strike-choice-vix').textContent.match(/(\d+) \/ (\d+)/).slice(1).map(Number);
    expect(old[0]).toBeLessThan(k[0]);
    expect(old[0] - old[1]).toBe(20);
    expect(document.body.textContent).toMatch(/IVX EM out — near the expected move: take 25%/);
    expect(screen.getByTestId('em-tasty').textContent).toMatch(/VIX ±61 · VIX1D ±50 · IVX ±36/);
  });

  it('says when hand edits mean no choice is on the ticket, and a pick replaces them', () => {
    mount({ overrideStrikes: { '0': { strat: 'Bull put spread', map: { 0: 7300 } } } });
    expect(screen.getByTestId('strike-choices').textContent).toMatch(/edited by hand/);
    fireEvent.click(screen.getByTestId('strike-choice-engine'));
    expect(screen.getByTestId('strike-choice-engine').dataset.on).toBe('1');
    expect(line()).not.toContain('7300');
  });
});

import { calc0DTE } from '../engine/calc0dte';

describe('credit vertical construction in the engine (Oct 2026)', () => {
  const base = { price: 7410, high: 7421, low: 7398, vwap5: 7409, vwap5_30: 7409, vwapRoll30: 7410, vwapRoll30Prior: 7409,
    vwapAccept: 0.5, atr: 61, em: 38, atr5: 6.5, atr2h: 22, gamStrike: 0, vix: 15.8, vix1d: 12.9, esOvernightHigh: 7430,
    esOvernightLow: 7388, esClose: 7415, priorDayClose: 7398, cashOpen: 7400, esEM: 40, overnightStale: false,
    bankroll: 25000, startBR: 25000, maxLoss: 600, maxOpen: 900, theta: 38, delta: -4, gamma: -0.2, hours: 5.5,
    underlying: 'SPX', overrideStrategy: 'Bull put spread', overrideStrikes: null, vertVariant: 'engine', historyByStrategy: null,
    emSource: 'vix', straddleCall: 0, straddlePut: 0, straddleHaircut: 1.2533, netCreditDebit: 3.5, win: 350, risk: 1650, pop: 85,
    commissionPerContract: 0 };
  const K = r => r.legs.map(l => l.strike);

  it('no straddle: IVX = 0.63 × the √365 VIX1D EM; $20 wide; tastytrade EMs exported', () => {
    const r = calc0DTE(base);
    const em1d = 7410 * 12.9 / 100 / Math.sqrt(365);                 // 50.0
    expect(r.em365V1D).toBeCloseTo(em1d, 6);
    expect(r.em365VIX).toBeCloseTo(7410 * 15.8 / 100 / Math.sqrt(365), 6);
    expect(r.ivxEM).toBeCloseTo(0.63 * em1d * Math.sqrt(5.5 / 6), 6);
    expect(r.creditW).toBe(20);
    const [sh, lo] = K(r);
    expect(sh - lo).toBe(20);
    expect(7410 - sh).toBeGreaterThanOrEqual(25);
    expect(7410 - sh).toBeLessThan(40);
    expect(r.exitTarget).toMatchObject({ target: 25 });
  });

  it('the far choices take a 50% target, and QQQ gets a $2 width', () => {
    const far = calc0DTE({ ...base, vertVariant: 'vix' });
    expect(far.exitTarget).toMatchObject({ target: 50 });
    const q = calc0DTE({ ...base, underlying: 'QQQ', price: 708, high: 709, low: 706, vwap5: 708, vwap5_30: 708, vwapRoll30: 708,
      vwapRoll30Prior: 708, cashOpen: 707, priorDayClose: 706, esClose: 7415, atr: 7, em: 5, atr5: 0.7, atr2h: 2.2,
      overrideStrategy: 'Bear call spread' });
    expect(q.creditW).toBe(2);
    const [sh, lo] = K(q);
    expect(lo - sh).toBe(2);
    expect(sh).toBeGreaterThan(708);
  });
});
