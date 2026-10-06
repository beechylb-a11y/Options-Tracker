/* Capture tracker (Oct 2026): realised share of max profit / max risk from closed
   tickets, the 0DTE premium-selling prior at the 25% target, and the blend. Plus the
   tastylive fly toggle on the Profit Taker. */
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import { captureStats, blendCapture, strategyOf, engineOf } from '../engine/capture';
import { calc0DTE, assumedCapture0 } from '../engine/calc0dte';
import { calc45DTE, assumedCapture45 } from '../engine/calc45dte';
import ProfitTaker from '../components/ProfitTaker';

afterEach(cleanup);

const row = (o) => ({ Engine: '0DTE', Strategy: 'SPX - Iron Condor - Normal - neutral', Qty: 2, 'Qty Closed': 2,
  'Max Profit': 400, 'Max Risk': 600, 'Realised P&L': 100, Account: 'a1', ...o });

describe('capture stats', () => {
  it('parses logged strategy and engine names', () => {
    expect(strategyOf('SPX - Iron Condor - Normal - neutral')).toBe('Iron Condor - Normal');
    expect(strategyOf('Standard butterfly')).toBe('Standard butterfly');
    expect(engineOf('45DTE')).toBe('45DTE'); expect(engineOf('0DTE')).toBe('0DTE');
  });

  it('measures winners against max profit and losers against max risk, per contract', () => {
    const st = captureStats([
      row({}),                                  // 50/ct of 200/ct max = 25%
      row({ 'Realised P&L': 160 }),             // 40%
      row({ 'Realised P&L': -300 }),            // -150/ct of 300/ct risk = 50%
      row({ 'Qty Closed': 0, 'Realised P&L': '' }),      // open: ignored
      row({ Account: 'a2', 'Realised P&L': 400 }),       // other account
    ], { account: 'a1' })['0DTE']['Iron Condor - Normal'];
    expect(st.closed).toBe(3); expect(st.wins).toBe(2); expect(st.losses).toBe(1);
    expect(st.winCap).toBeCloseTo(0.325, 6); expect(st.lossCap).toBeCloseTo(0.5, 6);
    expect(st.winSamples).toBe(2);
  });

  it('blends toward the measured number, halfway at 10 closes', () => {
    expect(blendCapture(0.25, null, 0)).toMatchObject({ value: 0.25, source: 'assumed' });
    expect(blendCapture(0.25, 0.15, 10).value).toBeCloseTo(0.20, 6);
    expect(blendCapture(0.25, 0.15, 90).value).toBeCloseTo(0.16, 6);
  });
});

describe('0DTE engine capture prior', () => {
  const base = { price: 6700, high: 6710, low: 6690, vwap5: 6700, vwap5_30: 6700, vwapRoll30: 6700, vwapRoll30Prior: 6700,
    vwapAccept: 0.5, em: 40, atr: 60, atr5: 6, atr2h: 20, vix: 15, vix1d: 12, hours: 4, bankroll: 25000, startBR: 25000,
    maxLoss: 600, maxOpen: 900, win: 200, risk: 300, pop: 75, netCreditDebit: 2, underlying: 'SPX' };
  it('uses the 25% target for premium-selling, not 0.50 of max', () => {
    expect(assumedCapture0('Iron Condor - Normal').winCap).toBe(0.5);
    const r = calc0DTE({ ...base, overrideStrategy: 'Iron Condor - Normal' });
    expect(r.evBasis.winCap).toBeCloseTo(0.25, 6);
    expect(r.evBasis.capture.win.source).toBe('assumed');
  });
  it('moves toward measured capture when closes exist', () => {
    const r = calc0DTE({ ...base, overrideStrategy: 'Iron Condor - Normal',
      captureByStrategy: { 'Iron Condor - Normal': { winCap: 0.15, winSamples: 10, lossCap: 0.7, lossSamples: 0, closed: 10 } } });
    expect(r.evBasis.winCap).toBeCloseTo(0.20, 6);
    expect(r.evBasis.capture.win.n).toBe(10);
  });
  it('leaves fly priors alone until measured', () => {
    const r = calc0DTE({ ...base, overrideStrategy: 'Standard butterfly', netCreditDebit: -0.64, win: 331, risk: 64 });
    expect(r.evBasis.winCap).toBeCloseTo(0.28, 6);
  });
});

describe('tastylive fly toggle', () => {
  it('switches a 0DTE fly from % on entry to % of max profit', () => {
    let on = false;
    const legs = [{ label: 'Long call', strike: 100 }, { label: 'Short call x2', strike: 105 }, { label: 'Long call', strike: 110 }];
    const { rerender } = render(<ProfitTaker ncd={-0.64} win={331} contracts={1} underlying="SPX" engine="0DTE"
      strategy="Standard butterfly" legs={legs} commRate={0} tastyFly={on} onTastyFly={v => { on = v; }} />);
    expect(screen.getByText(/Sell @ 0\.96/)).toBeTruthy();           // +50% on entry
    fireEvent.click(screen.getByTestId('tasty-fly-toggle-pt'));
    expect(on).toBe(true);
    rerender(<ProfitTaker ncd={-0.64} win={331} contracts={1} underlying="SPX" engine="0DTE"
      strategy="Standard butterfly" legs={legs} commRate={0} tastyFly={on} onTastyFly={v => { on = v; }} />);
    expect(screen.getByText(/Sell @ 1\.47/)).toBeTruthy();           // 0.64 + 25% × 3.31 = 1.4675
    expect(screen.getAllByText(/of max profit/).length).toBeGreaterThan(0);
  });
});

describe('45DTE iron fly and diagonal priors', () => {
  it('assume their 25% exit target', () => {
    expect(assumedCapture45('Iron butterfly').winCap).toBe(0.25);
    expect(assumedCapture45('Diagonal spread').winCap).toBe(0.25);
    const base = { underlying: 'SPX', price: 6700, ivr: 40, iv: 16, hv: 13, vix: 16, dte: 45, outlook: 'neutral',
      pop: 60, win: 800, risk: 1200, bankroll: 100000, startBR: 100000, maxLoss: 3000, maxOpen: 20000,
      bpr: 1200, theta: 20, vega: -30, delta: 1 };
    expect(calc45DTE({ ...base, overrideStrategy: 'Iron butterfly' }).evBasis.avgWin).toBeCloseTo(200, 6);
    expect(calc45DTE({ ...base, overrideStrategy: 'Diagonal spread' }).evBasis.avgWin).toBeCloseTo(200, 6);
  });
});
