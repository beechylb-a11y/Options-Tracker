/* The tab strip ranks by Trade Confidence, best on the left — but only once every
   ticket has one. These tests exist because the ordering is derived from state that
   the panels push UP, which is the kind of wiring that silently does nothing. */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// The real panel needs a bridge, a sheet and a market. Replace it with a stub that
// just reports whatever confidence the test wants.
let summaryPlan = {};
vi.mock('../components/EnginePanel', () => ({
  default: ({ onSummary, seed }) => {
    const key = (seed && seed.underlying) || 'x';
    React.useEffect(() => {
      const s = summaryPlan[key];
      if (s) onSummary(s);
    }, [onSummary]);
    return <div data-testid={'panel-' + key} />;
  },
}));
vi.mock('../utils/api', () => ({
  api: { getStrategyHistory: () => Promise.resolve([]), getDecisions: () => Promise.resolve([]),
         getTradeTracker: () => Promise.resolve([]), getConfig: () => Promise.resolve({}) },
  clearApiCache: () => {},
}));
vi.mock('../utils/volSnapshot', () => ({ startCloseVolSnapshot: () => {} }));

import DecisionEngine from '../pages/DecisionEngine';

const TABS_KEY = 'ot-engine-tabs-v1';
function seedTabs(list) {
  localStorage.setItem(TABS_KEY, JSON.stringify({
    savedAt: Date.now(), activeId: list[0].id,
    tabs: list.map(t => ({ id: t.id, mode: '0dte', label: t.label, createdAt: t.createdAt,
      seed: { underlying: t.u }, state: null })),
  }));
}
// Read the strip in DOM order — that order IS the ranking.
const stripLabels = () => Array.from(
  screen.getByTestId('tab-strip').querySelectorAll('[data-testid="tab"]'))
  .map(el => el.querySelector('.font-medium').textContent);
const stripRanks = () => Array.from(
  screen.getByTestId('tab-strip').querySelectorAll('[data-testid="tab"]'))
  .map(el => el.querySelector('.mono') ? el.querySelector('.mono').textContent : null);

describe('tab ranking', () => {
  beforeEach(() => { localStorage.clear(); summaryPlan = {}; });
  afterEach(() => cleanup());

  it('leaves insertion order alone until every ticket is priced', async () => {
    seedTabs([
      { id: 'a', u: 'SPX', label: 'SPX 29 Sep', createdAt: 1 },
      { id: 'b', u: 'QQQ', label: 'QQQ 29 Sep', createdAt: 2 },
    ]);
    // Only one of the two has a confidence.
    summaryPlan = { SPX: { confidence: 37, tier: 'Low', ready: true, blocked: false },
                    QQQ: { confidence: null, tier: '--', ready: false, blocked: false } };
    render(<DecisionEngine authenticated account="all" accounts={[]} />);
    expect(stripLabels()).toEqual(['SPX 29 Sep', 'QQQ 29 Sep']);
    expect(screen.getByText('ranking once all priced')).toBeTruthy();
  });

  it('puts the higher confidence on the left once both are priced', async () => {
    seedTabs([
      { id: 'a', u: 'SPX', label: 'SPX 29 Sep', createdAt: 1 },
      { id: 'b', u: 'QQQ', label: 'QQQ 29 Sep', createdAt: 2 },
    ]);
    summaryPlan = { SPX: { confidence: 37, tier: 'Low', ready: true, blocked: false },
                    QQQ: { confidence: 45, tier: 'Low', ready: true, blocked: false } };
    render(<DecisionEngine authenticated account="all" accounts={[]} />);
    // QQQ 45 outranks SPX 37 even though SPX was opened first.
    expect(stripLabels()).toEqual(['QQQ 29 Sep', 'SPX 29 Sep']);
    expect(screen.queryByText('ranking once all priced')).toBeNull();
    expect(screen.getByText('45')).toBeTruthy();
    expect(screen.getByText('37')).toBeTruthy();
  });

  it('sinks a blocked ticket below a lower-scoring tradeable one', async () => {
    seedTabs([
      { id: 'a', u: 'SPX', label: 'SPX 29 Sep', createdAt: 1 },
      { id: 'b', u: 'QQQ', label: 'QQQ 29 Sep', createdAt: 2 },
    ]);
    summaryPlan = { SPX: { confidence: 80, tier: 'High', ready: true, blocked: true },
                    QQQ: { confidence: 45, tier: 'Low', ready: true, blocked: false } };
    render(<DecisionEngine authenticated account="all" accounts={[]} />);
    expect(stripLabels()).toEqual(['QQQ 29 Sep', 'SPX 29 Sep']);
  });

  it('does not rank a single ticket', async () => {
    seedTabs([{ id: 'a', u: 'SPX', label: 'SPX 29 Sep', createdAt: 1 }]);
    summaryPlan = { SPX: { confidence: 37, tier: 'Low', ready: true, blocked: false } };
    render(<DecisionEngine authenticated account="all" accounts={[]} />);
    // No rank ordinal when there is nothing to compare against — the first .mono in
    // the tab is the confidence, not a position.
    expect(stripRanks()).toEqual(['37']);
  });
});
