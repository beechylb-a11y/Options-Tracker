/* 45DTE ticket (Oct 2026): a listed expiry for every structure — so Delta can fetch
   greeks and move the strikes — and condor wings of one width. */
import React from 'react';
import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import EnginePanel from '../components/EnginePanel';
import { bsAbsDelta } from '../engine/deltaStrikes';
import { calc45DTE } from '../engine/calc45dte';

const S = 762, v = 0.24 * Math.sqrt(45 / 365);
let seen = [];
const mount = () => render(<EnginePanel mode="45dte" onLogTrade={() => true} accountConfig={{ id: 'a', bankroll: 50000 }} strategyHistory={{}} toast={() => {}}
  initialState={{ i45: { underlying: 'QQQ', price: String(S), iv: '24', hv: '18', ivr: '40', vix: '17', dte: '45', ivFront: '23', ivBack: '25' },
    overrideStrat: 'Iron Condor - Normal' }} />);
const tiles = () => screen.getAllByTestId('strike-line')[0].textContent;
const strikesOf = () => (tiles().match(/[+−-]\d+ (Put|Call)/g) || []).map(x => Number(x.replace(/[^\d]/g, '')));

describe('45DTE strikes and expiry', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-06T15:00:00Z'));
    localStorage.clear(); localStorage.setItem('bridgeUrl', 'http://b'); seen = [];
    global.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/api/option-chain')) return { status: 200, text: async () => JSON.stringify({ expirations: ['20261116', '20261118', '20261120', '20261123', '20261127'] }) };
      if (u.includes('/api/option-greeks')) {
        seen.push(u.match(/expiry=(\d+)/)[1]);
        const legs = JSON.parse(decodeURIComponent(u.split('&legs=')[1]));
        return { json: async () => ({ legs: legs.map(l => ({ strike: l.strike, right: l.right, qty: l.qty,
          greeks: { delta: (l.right === 'P' ? -1 : 1) * bsAbsDelta(S, l.strike, v, l.right), iv: 24, theta: -0.1, gamma: 0.01, vega: 0.5, bid: 1, ask: 1.1 } })),
          net: { delta: 1, gamma: 0, theta: 5, vega: -3, bid: 1, ask: 1.2 }, dataType: 'realtime', asOf: 'x' }) };
      }
      return { json: async () => ({}), text: async () => '{}', status: 200 };
    });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('trades a listed expiry and shows it on every leg', async () => {
    mount();
    await waitFor(() => screen.getByTestId('expiry-single'));
    expect(tiles()).toMatch(/Put · 20 Nov/);
    // picking another expiry moves the ticket to it
    fireEvent.click(screen.getByText('27 Nov'));
    await waitFor(() => expect(tiles()).toMatch(/27 Nov/));
  });

  it('Delta fetches greeks on the listed expiry and moves the tiles; EM puts them back', async () => {
    mount();
    await waitFor(() => screen.getByTestId('expiry-single'));
    const em = strikesOf();
    await act(async () => { fireEvent.click(screen.getByTestId('method-delta')); });
    await waitFor(() => expect(strikesOf()).not.toEqual(em));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(e => e === '20261120')).toBe(true);
    await act(async () => { fireEvent.click(screen.getByTestId('method-em')); });
    await waitFor(() => expect(strikesOf()).toEqual(em));
  });
});

describe('condor wings', () => {
  it('builds one wing width on both sides', () => {
    for (const price of [762.4, 762.6, 6712.3, 488.7]) {
      const r = calc45DTE({ underlying: price > 2000 ? 'SPX' : 'QQQ', price, ivr: 40, iv: 24, hv: 18, vix: 17, dte: 45,
        outlook: 'neutral', overrideStrategy: 'Iron Condor - Normal' });
      const k = r.legs.map(l => l.strike);
      expect(k[1] - k[0]).toBe(k[3] - k[2]);
    }
  });
});
