/* F1 fly band, V3 credit floor, V1 delta-by-default on verticals (Oct 2026). */
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flyBand } from '../engine/flyBand';
import { calc0DTE } from '../engine/calc0dte';
import { bsAbsDelta } from '../engine/deltaStrikes';
import EnginePanel from '../components/EnginePanel';

describe('fly band', () => {
  const fly = [{ label: 'Long call (lower)', strike: 99 }, { label: 'Short call x2 (mid)', strike: 100 }, { label: 'Long call (upper)', strike: 101 }];
  it('matches the normal model: wings = 1 SD → band ≈ 1.26 SD, ~47% inside', () => {
    const b = flyBand({ legs: fly, price: 100, sdLeft: 1, sdDay: 4 });
    expect(b.typed).toBe(false);
    expect(b.width).toBeCloseTo(1.26, 1);
    expect(b.pInside).toBeCloseTo(0.47, 1);
    expect(b.pctOfDay).toBeCloseTo(1.26 / 8, 2);
  });
  it('uses the typed fill when there is one', () => {
    const b = flyBand({ legs: fly, price: 100, sdLeft: 1, sdDay: 4, net: -0.2 });
    expect(b.typed).toBe(true);
    expect(b.lo).toBeCloseTo(99.2, 1);
    expect(b.hi).toBeCloseTo(100.8, 1);
  });
});

const base = { price: 7410, high: 7421, low: 7398, vwap5: 7409, vwap5_30: 7409, vwapRoll30: 7410, vwapRoll30Prior: 7409,
  vwapAccept: 0.5, atr: 61, em: 38, atr5: 6.5, atr2h: 22, gamStrike: 0, vix: 15.8, vix1d: 12.9, esOvernightHigh: 7430,
  esOvernightLow: 7388, esClose: 7415, priorDayClose: 7398, cashOpen: 7400, esEM: 40, overnightStale: false,
  bankroll: 25000, startBR: 25000, maxLoss: 600, maxOpen: 900, theta: 0, delta: 0, gamma: 0, hours: 3.5,
  underlying: 'SPX', overrideStrikes: null, vertVariant: 'engine', historyByStrategy: null,
  emSource: 'straddle', straddleCall: 21.5, straddlePut: 20.8, straddleHaircut: 1.2533,
  win: 0, risk: 0, pop: 0, comboBid: null, comboAsk: null };

describe('credit vertical floors', () => {
  it('warns under 10% of width', () => {
    const r = calc0DTE({ ...base, overrideStrategy: 'Bull put spread', netCreditDebit: 0.15 });
    expect(r.legs).toHaveLength(2);
    expect(r.warnings.join(' | ')).toMatch(/under the 10% floor/);
  });
  it('warns when the short is closer than 0.8 × the move left', () => {
    const r0 = calc0DTE({ ...base, overrideStrategy: 'Bull put spread', netCreditDebit: 0 });
    const shortIdx = r0.legs.findIndex(l => /short/i.test(l.label));
    const r = calc0DTE({ ...base, overrideStrategy: 'Bull put spread', netCreditDebit: 0,
      overrideStrikes: { [shortIdx]: 7405 }, overrideStrikesStrat: 'Bull put spread' });
    expect(r.warnings.join(' | ')).toMatch(/closer than 0.8×/);
  });
  it('fly result carries its band', () => {
    const r = calc0DTE({ ...base, overrideStrategy: 'Standard butterfly', netCreditDebit: 0 });
    expect(r.flyBand).toBeTruthy();
    expect(r.flyBand.pInside).toBeGreaterThan(0);
  });
});

describe('verticals take delta strikes by default once greeks are in', () => {
  const S = 7410;
  const greek = (strike, right) => ({ strike, right,
    greeks: { delta: (right === 'P' ? -1 : 1) * bsAbsDelta(S, strike, right === 'P' ? 0.011 : 0.0075, right), iv: 14,
      theta: -1, gamma: 0.01, vega: 0.1, bid: 1, ask: 1.1 } });
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-02T15:30:00Z'));
    localStorage.clear(); localStorage.setItem('bridgeUrl', 'http://bridge.test');
    global.fetch = vi.fn(async url => {
      const legs = JSON.parse(decodeURIComponent(String(url).split('&legs=')[1]));
      return { json: async () => ({ legs: legs.map(l => ({ ...greek(l.strike, l.right), qty: l.qty })),
        net: { delta: 1, theta: 5, gamma: 0.1, vega: 1, bid: 1, ask: 1.2 }, asOf: new Date().toISOString(), dataType: 'realtime', greekSource: 'model' }) };
    });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); delete global.fetch; });
  const i0 = { underlying: 'SPX', price: '7410', high: '7421', low: '7398', vwap5: '7409', vwap5_30: '7409', vwapRoll30: '7410',
    vwapRoll30Prior: '7409', vwapAccept: '0.5', em: '38', atr5: '6.5', atr2h: '22', atr: '61', vix: '15.8', vix1d: '12.9',
    esOvernightHigh: '7430', esOvernightLow: '7388', esClose: '7415', priorDayClose: '7398', cashOpen: '7400', esEM: '40', hours: '3.5',
    emSource: 'straddle', straddleCall: '21.5', straddlePut: '20.8', straddleHaircut: '1.2533', bankroll: 25000, startBR: 25000, maxLoss: 600, maxOpen: 900 };
  const mount = extra => render(<EnginePanel mode="0dte" onLogTrade={() => true} accountConfig={{ id: 'a', bankroll: 25000 }}
    strategyHistory={{}} toast={() => {}} initialState={{ i0, overrideStrat: 'Bull put spread', ...extra }} />);

  it('Fetch Greeks puts the 20Δ short on the ticket', async () => {
    mount();
    expect(screen.getByTestId('strike-choice-delta').textContent).toMatch(/default/);
    fireEvent.click(within(screen.getByTestId('delta-strip')).getByText('fetch greeks'));
    await waitFor(() => expect(screen.getByTestId('strike-choice-delta').dataset.on).toBe('1'));
  });
  it('an EM tile chosen by hand stays when greeks are fetched', async () => {
    mount();
    fireEvent.click(screen.getByTestId('strike-choice-em1d'));
    fireEvent.click(within(screen.getByTestId('delta-strip')).getByText('fetch greeks'));
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    await new Promise(r => setTimeout(r, 50));
    expect(screen.getByTestId('strike-choice-em1d').dataset.on).toBe('1');
  });
});
