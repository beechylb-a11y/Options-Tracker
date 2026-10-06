/* Engine tabs: 0DTE / 45DTE × Indices / ETFs / Stocks, 5 per group, no blank tickets,
   a scan per group and "Scan everything" filing every group's results (Oct 2026). */
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../components/EnginePanel', () => ({
  default: ({ seed, mode }) => <div data-testid="panel" data-mode={mode} data-u={(seed && seed.underlying) || ''} />,
}));
vi.mock('../utils/api', () => ({
  api: { getStrategyHistory: () => Promise.resolve([]), getDecisions: () => Promise.resolve([]),
         getTradeTracker: () => Promise.resolve([]), getConfig: () => Promise.resolve({}) },
  clearApiCache: () => {},
}));
vi.mock('../utils/volSnapshot', () => ({ startCloseVolSnapshot: () => {} }));
import DecisionEngine, { assetClassOf, isBlankTab, SCAN_DEFAULTS } from '../pages/DecisionEngine';

const TABS_KEY = 'ot-engine-tabs-v1';
const seed = list => localStorage.setItem(TABS_KEY, JSON.stringify({ savedAt: Date.now(), activeId: list[0].id,
  tabs: list.map((t, i) => ({ id: t.id, mode: t.mode, label: t.u + ' ' + i, createdAt: i + 1,
    seed: t.blank ? null : { underlying: t.u, _scanMode: t.mode }, state: null })) }));
const mount = () => render(<DecisionEngine authenticated account="all" accounts={[]} />);

describe('tab groups', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => cleanup());

  it('classes indices, ETFs and stocks, with the default scan lists', () => {
    ['SPX', 'XSP', 'NDX', 'RUT'].forEach(u => expect(assetClassOf(u)).toBe('index'));
    ['SPY', 'QQQ', 'IWM'].forEach(u => expect(assetClassOf(u)).toBe('etf'));
    ['AAPL', 'NVDA', 'TSLA', 'AMD'].forEach(u => expect(assetClassOf(u)).toBe('stock'));
    expect(SCAN_DEFAULTS).toEqual({ index: ['SPX', 'XSP'], etf: ['SPY', 'QQQ', 'IWM'], stock: ['AAPL', 'NVDA', 'TSLA', 'AMD'] });
  });

  it('starts with no blank ticket, and drops blank ones saved earlier', () => {
    seed([{ id: 'b', mode: '0dte', u: 'SPX', blank: true }, { id: 'a', mode: '0dte', u: 'QQQ' }]);
    mount();
    expect(screen.getAllByTestId('panel')).toHaveLength(1);
    expect(isBlankTab({ id: 'x', seed: null, state: null })).toBe(true);
    expect(isBlankTab({ id: 'x', seed: null, state: { i0: { netCreditDebit: '1.2' } } })).toBe(false);
  });

  it('shows only the active group, with counts on all six', () => {
    seed([{ id: 'a', mode: '0dte', u: 'SPX' }, { id: 'b', mode: '0dte', u: 'QQQ' }, { id: 'c', mode: '45dte', u: 'NVDA' }, { id: 'd', mode: '0dte', u: 'XSP' }]);
    mount();
    expect(screen.getAllByTestId('tab').map(t => t.dataset.tabId)).toEqual(['a', 'd']);
    expect(screen.getByTestId('group-0dte-index').textContent).toMatch(/2\/5/);
    expect(screen.getByTestId('group-0dte-etf').textContent).toMatch(/1\/5/);
    expect(screen.getByTestId('group-45dte-stock').textContent).toMatch(/1\/5/);
    fireEvent.click(screen.getByTestId('group-0dte-etf'));
    expect(screen.getAllByTestId('tab').map(t => t.dataset.tabId)).toEqual(['b']);
  });

  it('an empty group stays empty until + Trade, and caps at five', () => {
    mount();
    fireEvent.click(screen.getByTestId('group-45dte-stock'));
    expect(screen.getByTestId('group-empty')).toBeTruthy();
    expect(screen.queryAllByTestId('panel')).toHaveLength(0);
    for (let i = 0; i < 6; i++) if (!screen.getByTestId('add-tab').disabled) fireEvent.click(screen.getByTestId('add-tab'));
    expect(screen.getAllByTestId('tab').length).toBe(5);
    const p = screen.getAllByTestId('panel').find(x => x.parentElement.style.display !== 'none');
    expect(p.dataset.mode).toBe('45dte');
    expect(p.dataset.u).toBe('AAPL');
    expect(screen.getByTestId('add-tab').disabled).toBe(true);
  });

  it('a scan pick replaces the untouched ticket in its group', async () => {
    seed([{ id: 'b', mode: '0dte', u: 'SPX', blank: true }]);
    // keep the blank one: it was made this session (not filtered on load) — simulate via + Trade
    localStorage.clear();
    mount();
    fireEvent.click(screen.getByTestId('add-tab'));            // a blank 0DTE SPX ticket
    expect(screen.getAllByTestId('tab')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('multiscan-toggle'));
    fireEvent.click(screen.getByText('Show inputs'));
    const row = Array.from(screen.getByTestId('multiscan').querySelectorAll('tr')).find(tr => tr.firstChild && tr.firstChild.textContent === 'Price');
    fireEvent.change(row.querySelectorAll('input')[0], { target: { value: '7410' } });
    fireEvent.click(screen.getByTestId('scan-all'));
    await screen.findByTestId('scan-results');
    fireEvent.click(screen.getAllByTestId('scan-open')[0]);
    const tabs = screen.getAllByTestId('tab');
    expect(tabs).toHaveLength(1);                              // blank one gone, scan ticket in its place
  });

  it('Scan everything fills every group, each with its own list', async () => {
    localStorage.setItem('bridgeUrl', 'http://bridge');
    const seen = [];
    global.fetch = vi.fn(async url => {
      const u = String(url); const und = (u.match(/underlying=([A-Z]+)/) || [])[1];
      seen.push(u.split('?')[0].split('/api/')[1] + ':' + und);
      const body = u.includes('/api/market-data') ? { price: 100 + und.length, vix: 16, isLive: true } : {};
      return { json: async () => body };
    });
    mount();
    fireEvent.click(screen.getByTestId('scan-everything'));
    await waitFor(() => expect(screen.getByTestId('scan-dot-45dte-stock')).toBeTruthy(), { timeout: 4000 });
    ['0dte-index', '0dte-etf', '0dte-stock', '45dte-index', '45dte-etf', '45dte-stock'].forEach(g =>
      expect(screen.getByTestId('scan-dot-' + g)).toBeTruthy());
    // market data fetched once per ticker across both modes
    expect(seen.filter(x => x === 'market-data:SPY')).toHaveLength(1);
    expect(seen.some(x => x === 'market-data:NVDA')).toBe(true);
    fireEvent.click(screen.getByTestId('group-45dte-stock'));
    const res = await screen.findByTestId('scan-results');
    expect(res.dataset.cls).toBe('stock');
    expect(res.textContent).toMatch(/AAPL/);
    delete global.fetch;
  });
});
