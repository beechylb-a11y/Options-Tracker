/* R-49 on the ticket: the strike-method strip, the delta check, and applying delta
   strikes through a live-greeks bracket (bridge mocked). */
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import EnginePanel from '../components/EnginePanel';
import { bsAbsDelta } from '../engine/deltaStrikes';

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
// A put-skewed surface: puts carry more vol than calls.
const S = 7410, vP = 0.0110, vC = 0.0075;
const greek = (strike, right) => ({ strike, right,
  greeks: { delta: (right === 'P' ? -1 : 1) * bsAbsDelta(S, strike, right === 'P' ? vP : vC, right), iv: 14,
    theta: -1, gamma: 0.01, vega: 0.1, bid: 1, ask: 1.1 } });
const legGreeks = { bag: '0', asOf: '2026-10-02T15:29:00Z',
  rows: [7345, 7305].map(k => ({ strike: k, right: 'P', delta: greek(k, 'P').greeks.delta, iv: 14 }))
    .concat([7450, 7495].map(k => ({ strike: k, right: 'C', delta: greek(k, 'C').greeks.delta, iv: 14 }))) };

const mount = (extra = {}, onLog = () => true) => render(
  <EnginePanel mode="0dte" onLogTrade={onLog} accountConfig={{ id: 'acct', bankroll: 25000 }}
    strategyHistory={{}} toast={() => {}}
    initialState={{ i0: { ...base }, ...extra }} />);

describe('delta strip', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-02T15:30:00Z'));
    localStorage.clear();
    localStorage.setItem('bridgeUrl', 'http://bridge.test');
    global.fetch = vi.fn(async (url) => {
      const legs = JSON.parse(decodeURIComponent(String(url).split('&legs=')[1]));
      return { json: async () => ({ legs: legs.map(l => ({ ...greek(l.strike, l.right), qty: l.qty })),
        net: { delta: 1, theta: 5, gamma: 0.1, vega: 1, bid: 6.2, ask: 6.5 },
        asOf: new Date().toISOString(), dataType: 'realtime', greekSource: 'model' }) };
    });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); delete global.fetch; });

  it('defaults 0DTE to EM and asks for greeks before it can check', () => {
    mount();
    expect(screen.getByTestId('method-em').style.color).toBe('rgb(88, 166, 255)');
    expect(screen.getByTestId('delta-strip').textContent).toMatch(/No live deltas yet/);
  });

  it('shows each short against its band, and the delta-implied POP gap', () => {
    mount({ legGreeks });
    const t = screen.getByTestId('delta-strip').textContent;
    expect(t).toMatch(/7345P \d+Δ/);
    expect(t).toMatch(/7450C \d+Δ/);
    expect(t).toMatch(/POP by delta ~\d+% · entered 92%/);
    // EM mode: no delta-strike card
    expect(screen.queryByTestId('delta-plan')).toBeNull();
  });

  it('Both: offers delta strikes, confirms them on a bracket, applies and logs the method', async () => {
    const onLog = vi.fn(() => Promise.resolve(true));
    mount({ legGreeks, strikeMethod: { '0': 'both', '45': 'delta' } }, onLog);
    expect(screen.getByTestId('delta-plan')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Use delta strikes' }));
    await waitFor(() => expect(screen.getByTestId('delta-strip').textContent).toMatch(/on ticket: Delta ✓ confirmed/));
    // bracket call + the refetch for the new legs
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
    // New strikes, old net: the price check may block — Log anyway is the same write.
    const btn = screen.getByTestId('log-trade');
    fireEvent.click(btn.disabled ? screen.getByTestId('log-anyway') : btn);
    fireEvent.click(screen.getByRole('button', { name: 'Log' }));
    expect(onLog).toHaveBeenCalledTimes(1);
    const payload = onLog.mock.calls[0][0];
    expect(payload.strikeMethod).toBe('Delta');
    expect(payload.engineStrikes).toBe('7305 / 7345 / 7450 / 7495');
    expect(payload.wingStrikes).not.toBe(payload.engineStrikes);
  });

  it('Delta: Fetch Greeks places the shorts by delta in one click', async () => {
    mount({ strikeMethod: { '0': 'delta', '45': 'delta' } });
    fireEvent.click(screen.getByText('fetch greeks'));
    await waitFor(() => expect(screen.getByTestId('delta-strip').textContent).toMatch(/on ticket: Delta ✓ confirmed/));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(3));   // greeks, bracket, refresh
    // after the refresh the check reads the new legs, all inside their bands
    await waitFor(() => expect(screen.getByTestId('delta-strip').textContent).toMatch(/POP by delta/));
  });

  it('switching back to EM restores the engine strikes', async () => {
    mount({ legGreeks, strikeMethod: { '0': 'both', '45': 'delta' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use delta strikes' }));
    await waitFor(() => expect(screen.getByTestId('delta-strip').textContent).toMatch(/on ticket: Delta/));
    fireEvent.click(screen.getByTestId('method-em'));
    await waitFor(() => expect(screen.getByTestId('delta-strip').textContent).toMatch(/on ticket: EM/));
  });

  it('stays visible on a butterfly and says the check does not apply', () => {
    mount({ legGreeks, overrideStrat: 'Asymmetric butterfly' });
    expect(screen.getByTestId('delta-strip').textContent).toMatch(/doesn't apply to Asymmetric butterfly/);
  });
});
