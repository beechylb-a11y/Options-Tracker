/* Contracts on the ticket (Oct 2026): Kelly's size was display-only. You can now type
   your own; Kelly's stays beside it with a reset, and logging uses the box. Also:
   45DTE sizing showed Raw/Adjusted Kelly as NaN% — it never set them. */
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import EnginePanel from '../components/EnginePanel';
import { calc45DTE } from '../engine/calc45dte';
import { calc0DTE } from '../engine/calc0dte';

const base = {
  underlying: 'SPX', price: '7410', high: '7421', low: '7398', vwap5: '7409', vwap5_30: '7409',
  vwapRoll30: '7410', vwapRoll30Prior: '7409', vwapAccept: '0.5', em: '38', atr5: '6.5', atr2h: '22', atr: '61',
  vix: '15.8', vix1d: '12.9', esOvernightHigh: '7430', esOvernightLow: '7388', esClose: '7415',
  priorDayClose: '7398', cashOpen: '7400', esEM: '40', hours: '3.5',
  theta: '38', delta: '-4', lowerWingDelta: '0.08', upperWingDelta: '0.07',
  emSource: 'straddle', straddleCall: '21.5', straddlePut: '20.8', straddleHaircut: '1.2533',
  bankroll: 25000, startBR: 25000, maxLoss: 3000, maxOpen: 9000,
  netCreditDebit: '6.36', gamma: '-0.2', win: '636', risk: '3364', pop: '92',
};
const in45 = { price: 762, ivr: 45, iv: 20, hv: 16, vix: 18, ivFront: 19, ivBack: 21, skew: 4, termBias: 'contango',
  dte: 44, pop: 65, win: 555, risk: 445, netCreditDebit: 5.55, bankroll: 25000, startBR: 25000, maxLoss: 2500, maxOpen: 5000,
  bpr: 0, theta: 0, vega: 0, delta: 0, underlying: 'QQQ', outlook: 'neutral', overrideStrategy: 'Iron Condor - Normal' };

describe('engine', () => {
  it('45DTE sizes on Sharpe × strategy adjusted Kelly, no VIX factor (no NaN)', () => {
    const r = calc45DTE(in45);
    expect(Number.isFinite(r.rawKelly) && r.rawKelly > 0).toBe(true);
    expect(r.sizingModel).toBe('noVix');
    expect(r.volFactor).toBe(1);
    expect(r.stratModifier).toBe(0.95);                       // iron condor
    expect(r.sharpeFactor).toBe(0.35);                        // EV ~$19 on $445: weak edge
    expect(r.adjustedKelly).toBeCloseTo(r.rawKelly * 0.35 * 0.95, 10);
    expect(r.kellyDollar).toBeCloseTo(r.adjustedKelly * 25000, 6);
    // VIX does not move it
    expect(calc45DTE({ ...in45, vix: 32 }).adjustedKelly).toBeCloseTo(r.adjustedKelly, 10);
  });
  it('takes your contracts and keeps Kelly’s', () => {
    const k = calc45DTE(in45);
    const r = calc45DTE({ ...in45, contractsOverride: 7 });
    expect(r.contracts).toBe(7);
    expect(r.kellyContracts).toBe(k.contracts);
    expect(r.maxRisk).toBe(7 * 445);
    const z = calc0DTE({ ...Object.fromEntries(Object.entries(base).map(([a, b]) => [a, isNaN(+b) ? b : +b])), contractsOverride: 3 });
    expect(z.contracts).toBe(3);
  });
});

describe('ticket size box', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-02T15:30:00Z')); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('edits contracts, shows Kelly beside it, and resets', () => {
    render(<EnginePanel mode="0dte" onLogTrade={() => true} accountConfig={{ id: 'acct', bankroll: 25000 }}
      strategyHistory={{}} initialState={{ i0: base }} toast={() => {}} />);
    const box = screen.getByTestId('size-input');
    const kellyC = box.value;
    expect(screen.getByTestId('size-kelly').textContent).toMatch(new RegExp(`Kelly ${kellyC} ct`));
    fireEvent.change(box, { target: { value: String(+kellyC + 2) } });
    fireEvent.blur(box);
    expect(screen.getByTestId('size-input').value).toBe(String(+kellyC + 2));
    expect(screen.getByTestId('size-kelly').textContent).toMatch(new RegExp(`Kelly ${kellyC} ct`));
    fireEvent.click(screen.getByLabelText('One fewer contract'));
    expect(screen.getByTestId('size-input').value).toBe(String(+kellyC + 1));
    fireEvent.click(screen.getByTestId('size-reset'));
    expect(screen.getByTestId('size-input').value).toBe(kellyC);
    expect(screen.queryByTestId('size-reset')).toBeNull();
  });
});
