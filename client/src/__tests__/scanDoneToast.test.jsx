/* The "Scan done" card (20 Nov 2026): ✕, Show results and the 8-second timer each
   dismiss it for good — it used to reappear at once — and Show results asks the
   Engine to open the best result's group. */
import React from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { ScanDoneToast, requestShowResults } from '../components/ScanProgress';
import { scanStore } from '../utils/scanStatus';

const finished = (at, extra = {}) => ({ running: false, finishedAt: at, mode: '45dte', order: ['NVDA', 'GOOGL'], tickers: {}, stages: [],
  summary: { stopped: false, names: 6, secs: 45, best: 'GOOGL 60/100', needs: '', group: '45dte|stocks', ...extra } });
afterEach(() => { cleanup(); act(() => scanStore.set(null)); vi.useRealTimers(); });

describe('scan done card', () => {
  it('✕ dismisses it and it stays dismissed; the next scan shows a new card', () => {
    act(() => scanStore.set(finished(1000)));
    render(<ScanDoneToast onOpen={() => {}} />);
    expect(screen.getByTestId('scan-done').textContent).toMatch(/Scan done · 6 names in 45 s/);
    fireEvent.click(screen.getByTestId('scan-done-close'));
    expect(screen.queryByTestId('scan-done')).toBeNull();
    act(() => scanStore.update(p => ({ ...p })));          // any store change re-renders
    expect(screen.queryByTestId('scan-done')).toBeNull();
    act(() => scanStore.set(finished(2000, { best: 'XSP 71/100' })));
    expect(screen.getByTestId('scan-done').textContent).toMatch(/XSP 71\/100/);
  });
  it('goes by itself after 8 seconds and does not come back', () => {
    vi.useFakeTimers();
    act(() => scanStore.set(finished(3000)));
    render(<ScanDoneToast onOpen={() => {}} />);
    expect(screen.getByTestId('scan-done')).toBeTruthy();
    act(() => { vi.advanceTimersByTime(8100); });
    expect(screen.queryByTestId('scan-done')).toBeNull();
    act(() => scanStore.update(p => ({ ...p })));
    expect(screen.queryByTestId('scan-done')).toBeNull();
  });
  it('Show results closes it, hands over the summary, and leaves a request for the Engine', () => {
    const onOpen = vi.fn();
    act(() => scanStore.set(finished(4000)));
    render(<ScanDoneToast onOpen={onOpen} />);
    fireEvent.click(screen.getByTestId('scan-done-open'));
    expect(screen.queryByTestId('scan-done')).toBeNull();
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ group: '45dte|stocks', best: 'GOOGL 60/100' }));
    expect(scanStore.get().showReq).toBeGreaterThan(0);
    act(() => requestShowResults(123));
    expect(scanStore.get().showReq).toBe(123);
  });
});

// The Engine end: a Show results request opens the best result's group, even when the
// Engine mounts after the card was clicked (it waits in the scan store).
vi.mock('../components/EnginePanel', () => ({ default: () => <div data-testid="panel" /> }));
vi.mock('../utils/api', () => ({
  api: { getStrategyHistory: () => Promise.resolve([]), getDecisions: () => Promise.resolve([]),
         getTradeTracker: () => Promise.resolve([]), getConfig: () => Promise.resolve({}), updateConfig: () => Promise.resolve({}) },
  clearApiCache: () => {},
}));
vi.mock('../utils/volSnapshot', () => ({ startCloseVolSnapshot: () => {} }));
import DecisionEngine from '../pages/DecisionEngine';

describe('Show results on the Engine', () => {
  it('opens 45DTE · Stocks when that is where the best result came from', async () => {
    localStorage.clear();
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    act(() => scanStore.set({ ...finished(5000, { group: '45dte|stock' }), showReq: 777 }));
    render(<DecisionEngine authenticated account="all" accounts={[]} />);
    const panel = await screen.findByTestId('multiscan');
    expect(panel.getAttribute('data-mode')).toBe('45dte');
    expect(panel.getAttribute('data-cls')).toBe('stock');
  });
});
