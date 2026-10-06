/* Engine tabs split into 0DTE / 45DTE × Indices / Stocks & ETFs, 5 per group (Oct 2026). */
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
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
import DecisionEngine, { assetClassOf } from '../pages/DecisionEngine';

const TABS_KEY = 'ot-engine-tabs-v1';
const seed = list => localStorage.setItem(TABS_KEY, JSON.stringify({ savedAt: Date.now(), activeId: list[0].id,
  tabs: list.map((t, i) => ({ id: t.id, mode: t.mode, label: t.u + ' ' + i, createdAt: i + 1, seed: { underlying: t.u }, state: null })) }));

describe('tab groups', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => cleanup());

  it('classes indices and stocks', () => {
    ['SPX', 'XSP', 'NDX', 'RUT'].forEach(u => expect(assetClassOf(u)).toBe('index'));
    ['SPY', 'QQQ', 'IWM', 'AAPL'].forEach(u => expect(assetClassOf(u)).toBe('stock'));
  });

  it('shows only the active group, with counts on each group', () => {
    seed([{ id: 'a', mode: '0dte', u: 'SPX' }, { id: 'b', mode: '0dte', u: 'QQQ' }, { id: 'c', mode: '45dte', u: 'SPY' }, { id: 'd', mode: '0dte', u: 'XSP' }]);
    render(<DecisionEngine authenticated account="all" accounts={[]} />);
    expect(screen.getAllByTestId('tab').map(t => t.dataset.tabId)).toEqual(['a', 'd']);
    expect(screen.getByTestId('group-0dte-index').textContent).toMatch(/2\/5/);
    expect(screen.getByTestId('group-0dte-stock').textContent).toMatch(/1\/5/);
    expect(screen.getByTestId('group-45dte-stock').textContent).toMatch(/1\/5/);
    fireEvent.click(screen.getByTestId('group-0dte-stock'));
    expect(screen.getAllByTestId('tab').map(t => t.dataset.tabId)).toEqual(['b']);
  });

  it('opens an empty group with a stock ticket, and caps a group at five', () => {
    seed([{ id: 'a', mode: '0dte', u: 'SPX' }]);
    render(<DecisionEngine authenticated account="all" accounts={[]} />);
    fireEvent.click(screen.getByTestId('group-45dte-stock'));
    const p = screen.getAllByTestId('panel').find(x => x.parentElement.style.display !== 'none');
    expect(p.dataset.mode).toBe('45dte');
    expect(p.dataset.u).toBe('SPY');
    for (let i = 0; i < 6; i++) if (!screen.getByTestId('add-tab').disabled) fireEvent.click(screen.getByTestId('add-tab'));
    expect(screen.getAllByTestId('tab').length).toBe(5);
    expect(screen.getByTestId('add-tab').disabled).toBe(true);
    expect(screen.getByTestId('group-0dte-index').textContent).toMatch(/1\/5/);
  });
});
