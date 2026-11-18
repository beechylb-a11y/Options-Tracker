/* The cockpit (Nov 2026): payoff and the trade's live TWS market side by side under the
   verdict — combo market, each leg live, and TWS's own what-if for margin and commission. */
import React from 'react';
import { render, screen, cleanup, within, act, waitFor } from '@testing-library/react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import MarketCard, { limitVsMid } from '../components/MarketCard';
import EnginePanel from '../components/EnginePanel';
import { liveStore } from '../live/liveStore';

const legs = [{ strike: 7580, right: 'P', qty: 1, expiry: '20261118' }, { strike: 7600, right: 'P', qty: -1, expiry: '20261118' }];
const quotes = () => ({
  'SPX 20261118 7580 P': { key: 'SPX 20261118 7580 P', bid: 1.05, ask: 1.10, mark: 1.08, delta: -0.06, theta: -1.92, iv: 11.0, ts: Date.now() },
  'SPX 20261118 7600 P': { key: 'SPX 20261118 7600 P', bid: 2.85, ask: 3.00, mark: 2.92, delta: -0.13, theta: -3.84, iv: 11.4, ts: Date.now() },
});

describe('MarketCard', () => {
  let calls;
  beforeEach(() => {
    calls = [];
    localStorage.setItem('bridgeUrl', 'https://bridge.test');
    global.fetch = vi.fn(async (url, init) => {
      calls.push([String(url), init && init.body ? JSON.parse(init.body) : null]);
      if (/what-if/.test(url)) return { ok: true, status: 200, json: async () => ({ ok: true, excessAfter: 41880,
        whatIf: { initMarginChange: 3630, commission: 5.4, warning: '' } }) };
      return { ok: true, status: 200, json: async () => ({ held: [], refused: [] }) };
    });
    liveStore.setConnection('open');
    liveStore.applySnapshot({ seq: 1, status: { connected: true, farmOk: true }, quotes: quotes(), positions: [], orders: [] });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); liveStore.setConnection('off'); });

  it('shows the combo market, each leg live with the per-lot greeks, and asks TWS what the entry costs', async () => {
    const go = vi.fn();
    render(<MarketCard underlying="SPX" legs={legs} lots={2} entry={1.85} isCredit onGoToOrder={go} />);
    const card = within(screen.getByTestId('market-card'));
    expect(card.getByTestId('live-combo').textContent).toContain('Mid1.85 cr');
    const rows = card.getByTestId('live-legs').querySelectorAll('tbody tr');
    expect(rows[0].textContent).toContain('Long 7580P');
    expect(rows[1].textContent).toContain('Short 7600P');
    // per lot: long −0.06 minus short −0.13 → +0.07 delta; −1.92 + 3.84 → +1.92 theta
    expect(rows[2].textContent).toContain('+0.07');
    expect(rows[2].textContent).toContain('+1.92');
    await waitFor(() => expect(card.getByTestId('what-if').textContent).toContain('$3,630'), { timeout: 3000 });
    expect(card.getByTestId('what-if').textContent).toContain('$5.40');
    expect(card.getByTestId('what-if').textContent).toContain('$41,880');
    const wi = calls.find(c => /what-if/.test(c[0]));
    expect(wi[1]).toMatchObject({ underlying: 'SPX', lots: 2, side: 'credit', entry: 1.85, legs });
    card.getByTestId('go-to-order').click();
    expect(go).toHaveBeenCalled();
  });

  it('does not ask for a what-if without a price, and says when the bridge has old code', async () => {
    const { rerender } = render(<MarketCard underlying="SPX" legs={legs} lots={2} entry={NaN} isCredit />);
    await new Promise(r => setTimeout(r, 1400));
    expect(calls.some(c => /what-if/.test(c[0]))).toBe(false);
    global.fetch = vi.fn(async (url) => (/what-if/.test(url) ? { ok: false, status: 404, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({}) }));
    rerender(<MarketCard underlying="SPX" legs={legs} lots={2} entry={1.85} isCredit />);
    await waitFor(() => expect(screen.getByTestId('what-if').textContent).toContain('bridge is on old code'), { timeout: 3000 });
  });
});

describe('cockpit on the ticket', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-06T15:00:00Z'));
    localStorage.clear();
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('puts the payoff chart and the market card side by side under the verdict', async () => {
    render(<EnginePanel mode="0dte" onLogTrade={() => true} accountConfig={{ id: 'a', bankroll: 25000 }} strategyHistory={{}} toast={() => {}}
      initialState={{ i0: { underlying: 'SPX', price: '6700', high: '6710', low: '6690', vwap5: '6700', vwap5_30: '6700', vwapRoll30: '6700',
        vwapRoll30Prior: '6700', vwapAccept: '0.5', em: '40', atr: '60', atr5: '6', atr2h: '20', vix: '15', vix1d: '12', hours: '4',
        bankroll: 25000, startBR: 25000, maxLoss: 600, maxOpen: 900, pop: '80', netCreditDebit: '0.50', win: '50', risk: '450' },
        overrideStrat: 'Iron Condor - Normal' }} />);
    const cockpit = within(await screen.findByTestId('cockpit'));
    expect(cockpit.getByTestId('payoff-time-chart')).toBeTruthy();
    expect(cockpit.getByTestId('market-card')).toBeTruthy();
    // the verdict comes first, then the cockpit
    const band = screen.getByTestId('verdict-band');
    expect(band.compareDocumentPosition(screen.getByTestId('cockpit')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('limitVsMid', () => {
  it('says which way the limit leans and what it costs', () => {
    expect(limitVsMid(1.85, 0, true)).toBe('your limit 1.85 is at the mid');
    expect(limitVsMid(1.90, 0.05, true)).toBe('your limit 1.90 is 0.05 above the mid — may not fill');
    expect(limitVsMid(1.80, -0.05, true)).toBe('your limit 1.80 is 0.05 below the mid — fills easily, gives up 0.05');
    expect(limitVsMid(0.65, 0.03, false)).toBe('your limit 0.65 is 0.03 above the mid — fills easily, gives up 0.03');
    expect(limitVsMid(0.60, -0.02, false)).toBe('your limit 0.60 is 0.02 below the mid — may not fill');
  });
});
