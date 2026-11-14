// Live price → Net, Win, Risk, POP (Nov 2026): the Strategy Builder numbers from the
// quotes Fetch from TWS returns.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { livePrice, comboQuote, expiryPayoff, popAtExpiry, yearsToExpiry } from '../engine/livePrice';
import EnginePanel from '../components/EnginePanel';

const PUTS = [
  { strike: 7385, right: 'P', qty: -1, bid: 3.1, ask: 3.3, iv: 15.5 },
  { strike: 7365, right: 'P', qty: 1, bid: 1.9, ask: 2.1, iv: 17.2 },
];
const T0 = 4.9 / 8760;

describe('livePrice', () => {
  it('combo quote: buys the longs at the ask and sells the shorts at the bid', () => {
    expect(comboQuote(PUTS)).toEqual({ bid: -1.4, ask: -1, mid: -1.2, spread: 0.4 });
    expect(comboQuote([{ ...PUTS[0], ask: null }, PUTS[1]])).toBeNull();
  });

  it('a put credit spread at the mid: win, risk and breakeven are exact', () => {
    const lp = livePrice(PUTS, { spot: 7410, T: T0, underlying: 'SPX' });
    expect(lp).toMatchObject({ net: 1.2, cashType: 'credit', exact: true, win: 120, risk: 1880, breakevens: [7383.8] });
    expect(lp.pop).toBeGreaterThan(75);
    expect(lp.pop).toBeLessThan(95);
  });

  it('prices at your net when given one', () => {
    const lp = livePrice(PUTS, { net: 1.3, spot: 7410, T: T0, underlying: 'SPX' });
    expect(lp).toMatchObject({ win: 130, risk: 1870, breakevens: [7383.7] });
  });

  it('a long fly: debit, two breakevens, POP between them', () => {
    const fly = [{ strike: 7400, right: 'C', qty: 1, bid: 30, ask: 31, iv: 13 }, { strike: 7450, right: 'C', qty: -2, bid: 10, ask: 10.6, iv: 12 },
      { strike: 7500, right: 'C', qty: 1, bid: 2.5, ask: 2.9, iv: 11.8 }];
    const lp = livePrice(fly, { spot: 7410, T: T0, underlying: 'SPX' });
    expect(lp).toMatchObject({ net: -12.6, cashType: 'debit', win: 3740, risk: 1260, breakevens: [7412.6, 7487.4] });
    expect(lp.pop).toBeGreaterThan(20); expect(lp.pop).toBeLessThan(70);
  });

  it('unlimited risk and two expiries are said, not guessed', () => {
    const naked = [{ strike: 7450, right: 'C', qty: -2, bid: 5, ask: 5.2, iv: 12 }, { strike: 7400, right: 'C', qty: 1, bid: 20, ask: 20.5, iv: 13 }];
    expect(expiryPayoff(naked.map(l => ({ ...l })), -9.75).risk).toBeNull();
    const cal = [{ strike: 7400, right: 'C', qty: -1, expiry: '20261120', bid: 20, ask: 20.5, iv: 13 }, { strike: 7400, right: 'C', qty: 1, expiry: '20261218', bid: 60, ask: 61, iv: 14 }];
    const lp = livePrice(cal, { spot: 7410, T: 0.1, underlying: 'SPX' });
    expect(lp.exact).toBe(false);
    expect(lp.win).toBeNull();
    expect(lp.net).toBeCloseTo(-40.25, 5);
  });

  it('POP with put skew sits near flat vol for a near-the-money breakeven, and is a probability', () => {
    const skewed = popAtExpiry(PUTS, 1.2, 7410, T0);
    const flat = popAtExpiry(PUTS.map(l => ({ ...l, iv: 16.4 })), 1.2, 7410, T0);
    expect(Math.abs(skewed - flat)).toBeLessThan(0.08);
    expect(skewed).toBeGreaterThan(0); expect(skewed).toBeLessThan(1);
  });

  it('years to the 16:00 New York close', () => {
    // Sat 14 Nov 11:00 UTC = 06:00 NY → Mon 16 Nov 16:00 NY is 2 days 10 hours
    expect(yearsToExpiry('20261116', new Date('2026-11-14T11:00:00Z')) * 365).toBeCloseTo(2 + 10 / 24, 3);
    expect(yearsToExpiry('20261113', new Date('2026-11-14T11:00:00Z'))).toBe(0);
  });
});

// ── On the ticket ──
const base = {
  underlying: 'SPX', price: '7410', high: '7421', low: '7372', vwap5: '7398', vwap5_30: '7405',
  vwapRoll30: '7412', vwapRoll30Prior: '7400', vwapAccept: '0.75', em: '38', atr5: '6.5', atr2h: '22', atr: '61',
  vix: '15.8', vix1d: '12.9', esOvernightHigh: '7430', esOvernightLow: '7388', esClose: '7415',
  priorDayClose: '7398', cashOpen: '7380', esEM: '40', hours: '4.9',
  emSource: 'straddle', straddleCall: '13.1', straddlePut: '12.6', straddleHaircut: '1.2533',
  bankroll: 25000, startBR: 25000, maxLoss: 600, maxOpen: 900,
};
const quote = (strike, right) => {
  // a simple put-skewed quote: further OTM puts carry more vol
  const otm = right === 'P' ? Math.max(0, 7410 - strike) : Math.max(0, strike - 7410);
  const mid = Math.max(0.15, 9 * Math.exp(-otm / 14));
  return { bid: +(mid - 0.05).toFixed(2), ask: +(mid + 0.05).toFixed(2), iv: right === 'P' ? 14 + otm * 0.04 : 12, delta: 0.2, theta: -1, gamma: 0.01, vega: 0.1 };
};
const field = f => document.querySelector(`[data-field="${f}"]`);

describe('Fetch from TWS fills the Sizing fields', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-11T16:05:00Z'));
    localStorage.clear();
    localStorage.setItem('bridgeUrl', 'http://bridge.test');
    global.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (/listed-strikes|option-chain/.test(u)) return { status: 200, json: async () => ({ error: 'none' }), text: async () => JSON.stringify({ error: 'none' }) };
      if (/option-greeks/.test(u)) {
        const legs = JSON.parse(decodeURIComponent(u.split('&legs=')[1]));
        return { json: async () => ({ legs: legs.map(l => ({ ...l, greeks: quote(l.strike, l.right) })),
          net: { delta: 1, theta: 5, gamma: 0.1, vega: 1, bid: null, ask: null },
          asOf: new Date().toISOString(), dataType: 'realtime', dataTypeLabel: 'Real-time', undPrice: 7410, greekSource: 'model' }) };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
    });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); delete global.fetch; });

  const mount = () => render(<EnginePanel mode="0dte" onLogTrade={() => true} accountConfig={{ id: 'acct', bankroll: 25000 }}
    strategyHistory={{}} toast={() => {}} initialState={{ i0: { ...base }, overrideStrat: 'Bull put spread' }} />);

  it('fills Net (mid), Win, Risk and POP; your own net re-prices them; a typed POP is kept', async () => {
    mount();
    fireEvent.click(screen.getByTestId('live-fetch'));
    await waitFor(() => expect(screen.getByTestId('live-strip')).toBeTruthy());
    const net = parseFloat(field('netCreditDebit').value);
    expect(net).toBeGreaterThan(0);                       // a credit
    const win = parseFloat(field('win').value), risk = parseFloat(field('risk').value);
    expect(win).toBe(Math.round(net * 100));
    expect(win + risk).toBe(Math.round(win + risk));
    expect(parseFloat(field('pop').value)).toBeGreaterThan(50);
    expect(screen.getByTestId('live-tag-netCreditDebit')).toBeTruthy();
    expect(screen.getByTestId('live-tag-pop')).toBeTruthy();
    const width = (win + risk) / 100;

    // Your limit, 0.05 better than the mid: Win and Risk move with it.
    const mine = (net + 0.05).toFixed(2);
    fireEvent.change(field('netCreditDebit'), { target: { value: mine } });
    await waitFor(() => expect(field('win').value).toBe(String(Math.round(parseFloat(mine) * 100))));
    expect(field('risk').value).toBe(String(Math.round((width - parseFloat(mine)) * 100)));
    expect(screen.queryByTestId('live-tag-netCreditDebit')).toBeNull();
    expect(screen.getByTestId('live-strip').textContent).toMatch(/Priced at your credit/);

    // A POP typed from TWS stays through a refresh; the net you typed stays too.
    fireEvent.change(field('pop'), { target: { value: '81' } });
    fireEvent.click(screen.getByTestId('live-fetch'));
    await waitFor(() => expect(global.fetch.mock.calls.filter(c => /option-greeks/.test(String(c[0]))).length).toBe(2));
    await waitFor(() => expect(screen.getByTestId('live-strip').textContent).toMatch(/Kept as you typed: POP 81/));
    expect(field('pop').value).toBe('81');
    expect(field('netCreditDebit').value).toBe(mine);
  });
});
