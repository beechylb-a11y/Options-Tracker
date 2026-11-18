/* One payoff chart for every ticket (Nov 2026): close-time curve, zones, EM bands and
   probability, strike blocks, break-evens, the live price from the TWS stream and an
   IV what-if — on the 0DTE ticket as well as the 45DTE one. */
import React from 'react';
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import PayoffChart, { strikeBlocks, INTRADAY_DAYS_PER_HOUR as K } from '../components/PayoffChart';
import EnginePanel from '../components/EnginePanel';
import { liveStore } from '../live/liveStore';

// SPX 7580/7600 bull put spread, 4.3 h to the bell, VIX1D 11.2.
const T = 4.3 * K;
const cl = [
  { strike: 7580, right: 'P', sign: 1, qty: 1, dte: T, iv: 0.112, r: 0.04, q: 0.013 },
  { strike: 7600, right: 'P', sign: -1, qty: 1, dte: T, iv: 0.112, r: 0.04, q: 0.013 },
];
const props = { cl, net: 1.85, netSource: 'ticket', spot: 7648.2, lo: 7540, hi: 7700, sigmaNear: 0.112,
  nearDte: T, closeDay: 3.3 * K, closeEt: '15:00', todayYmd: '20261118', underlying: 'SPX', divYield: 0.013, intraday: true };

describe('PayoffChart', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-18T16:42:00Z'));   // 11:42 NY
    liveStore.setConnection('off');
    liveStore.applySnapshot({ seq: 0, status: {}, quotes: {}, positions: [], orders: [] });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('opens on the time exit with the bold curve, zones, bands, bell, strikes and the break-even', () => {
    render(<PayoffChart {...props} />);
    const c = within(screen.getByTestId('payoff-time-chart'));
    expect(c.getByRole('button', { name: '15:00 close', hidden: true }).style.color).toBe('var(--c-58a6ff)');
    expect(c.getByTestId('close-curve')).toBeTruthy();
    expect(c.getByTestId('em-band-1')).toBeTruthy();
    expect(c.getByTestId('em-band-2')).toBeTruthy();
    expect(c.getByTestId('prob-bell')).toBeTruthy();
    const blocks = c.getAllByTestId('strike-block');
    expect(blocks.map(b => [b.textContent, b.getAttribute('data-side')])).toEqual([['+7580P', 'long'], ['−7600P', 'short']]);
    // at the 15:00 exit there is still an hour of time value, so the break-even sits
    // above the 7,598.15 at expiry (and below the 7,648 spot)
    const be = Number(c.getAllByTestId('breakeven')[0].textContent.replace(/,/g, ''));
    expect(be).toBeGreaterThan(7598.15);
    expect(be).toBeLessThan(7648.2);
    expect(c.getByTestId('price-source').textContent).toBe('┃Spot 7,648.20');
    expect(c.getByLabelText('Time from now')).toBeTruthy();
  });

  it('moves to now and expiry; at "now" there is no band to draw', () => {
    render(<PayoffChart {...props} />);
    const c = within(screen.getByTestId('payoff-time-chart'));
    fireEvent.click(c.getByRole('button', { name: 'Now', hidden: true }));
    expect(c.queryByTestId('em-band-1')).toBeNull();
    expect(c.getByLabelText('Time from now').value).toBe('0');
    fireEvent.click(c.getByRole('button', { name: 'Expiry 16:00', hidden: true }));
    expect(Number(c.getByLabelText('Time from now').value)).toBeCloseTo(T, 6);
    // at expiry above 7600 the spread keeps the whole credit: +$185 a contract
    expect(c.getByTestId('payoff-facts').textContent).toContain('+$185');
  });

  it('uses the live price from the TWS stream when it is arriving', () => {
    liveStore.setConnection('open');
    liveStore.applySnapshot({ seq: 1, status: { connected: true }, quotes: {}, positions: [], orders: [] });
    render(<PayoffChart {...props} />);
    act(() => { liveStore.applyDelta({ seq: 2, quotes: { SPX: { key: 'SPX', bid: 7630, ask: 7630.4, mark: 7630.2, high: 7655, low: 7612, ts: Date.now() } } }); });
    const c = within(screen.getByTestId('payoff-time-chart'));
    expect(c.getByTestId('price-source').textContent).toBe('Live 7,630.20');
    expect(c.getByTestId('today-range')).toBeTruthy();
    expect(c.getByTestId('payoff-facts').textContent).toContain('at live 7,630.20');
  });

  it('an IV what-if moves the P&L and says so', () => {
    render(<PayoffChart {...props} />);
    const c = within(screen.getByTestId('payoff-time-chart'));
    fireEvent.click(c.getByRole('button', { name: 'Now', hidden: true }));
    const before = c.getByTestId('payoff-facts').textContent;
    fireEvent.click(within(c.getByTestId('iv-whatif')).getByRole('button', { name: '+2', hidden: true }));
    expect(c.getByTestId('payoff-facts').textContent).not.toBe(before);
    expect(c.getByText('IV +2 pts on every leg')).toBeTruthy();
  });

  it('draws a stop line marked info only when one is given', () => {
    render(<PayoffChart {...props} stop={{ dollars: -370 }} />);
    expect(screen.getByTestId('stop-line').textContent).toBe('stop −$370 · info only');
  });
});

describe('strikeBlocks', () => {
  it('merges a broken-wing body into one ×2 block and staggers strikes that sit close', () => {
    const legs = [
      { strike: 760, right: 'P', sign: 1, qty: 1 }, { strike: 765, right: 'P', sign: -1, qty: 2 }, { strike: 772, right: 'P', sign: 1, qty: 1 },
    ];
    const b = strikeBlocks(legs, k => (k - 750) * 8);   // 760 and 765 land 40 px apart
    expect(b.map(x => [x.strike, x.net, x.row])).toEqual([[760, 1, 0], [765, -2, 1], [772, 1, 0]]);
  });
});

describe('on the 0DTE ticket', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-06T15:00:00Z'));
    localStorage.clear();
    global.fetch = vi.fn(async () => ({ json: async () => ({}) }));
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('replaces the expiry-only diagram with the full chart', async () => {
    render(<EnginePanel mode="0dte" onLogTrade={() => true} accountConfig={{ id: 'a', bankroll: 25000 }} strategyHistory={{}} toast={() => {}}
      initialState={{ i0: { underlying: 'SPX', price: '6700', high: '6710', low: '6690', vwap5: '6700', vwap5_30: '6700', vwapRoll30: '6700',
        vwapRoll30Prior: '6700', vwapAccept: '0.5', em: '40', atr: '60', atr5: '6', atr2h: '20', vix: '15', vix1d: '12', hours: '4',
        bankroll: 25000, startBR: 25000, maxLoss: 600, maxOpen: 900, pop: '80', netCreditDebit: '0.50', win: '50', risk: '450' },
        overrideStrat: 'Iron Condor - Normal' }} />);
    const chart = await screen.findByTestId('payoff-time-chart');
    const c = within(chart);
    expect(c.getByLabelText('Time from now')).toBeTruthy();
    expect(c.getByRole('button', { name: 'Expiry 16:00', hidden: true })).toBeTruthy();
    expect(c.getAllByTestId('strike-block').length).toBe(4);
    expect(c.getByText(/ticket's net credit 0.50/)).toBeTruthy();
  });
});
