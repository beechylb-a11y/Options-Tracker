/* Phase 5 (Nov 2026): strike blocks drag along the price axis (snapping to listed
   strikes, previewing the curve, re-running the engine once on release), arrow keys
   step them, and another structure can be ghosted on the same chart. */
import React from 'react';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import PayoffChart, { snapStrike, stepStrike, movedLegs, INTRADAY_DAYS_PER_HOUR as K } from '../components/PayoffChart';
import { withLegIdx } from '../components/EnginePanel';
import { liveStore } from '../live/liveStore';
import { positionValue } from '../engine/payoffCurve';

const T = 4.3 * K;
const cl = [
  { strike: 7580, right: 'P', sign: 1, qty: 1, dte: T, iv: 0.112, r: 0.04, q: 0.013, legIdx: 1 },
  { strike: 7600, right: 'P', sign: -1, qty: 1, dte: T, iv: 0.112, r: 0.04, q: 0.013, legIdx: 0 },
];
const props = { cl, net: 1.85, netSource: 'ticket', spot: 7648.2, lo: 7540, hi: 7700, sigmaNear: 0.112,
  nearDte: T, closeDay: 3.3 * K, closeEt: '15:00', todayYmd: '20261118', underlying: 'SPX', divYield: 0.013, intraday: true };
const snap = { P: [7570, 7575, 7580, 7585, 7590, 7595, 7600, 7605, 7610, 7620], C: [], step: 5 };
// The chart's x: 60 px left pad, 684 px plot, 7540–7700 → price p sits at 60 + (p − 7540) / 160 × 684.
const xOf = p => 60 + (p - 7540) / 160 * 684;

describe('strike snapping and the moved structure', () => {
  it('snaps to the listed strikes for that side, else the grid', () => {
    expect(snapStrike(7592.4, 'P', snap)).toBe(7590);
    expect(snapStrike(7618, 'P', snap)).toBe(7620);          // 7615 is not listed
    expect(snapStrike(7612, 'C', { step: 5 })).toBe(7610);
    expect(stepStrike(7600, 'P', 1, snap)).toBe(7605);
    expect(stepStrike(7610, 'P', 1, snap)).toBe(7620);
    expect(stepStrike(7570, 'P', -1, snap)).toBe(7570);       // nothing lower listed
    expect(stepStrike(450, 'C', -1, { step: 2.5 })).toBe(447.5);
  });
  it('re-prices the entry by the model difference, so the edge over fair carries over', () => {
    const m = movedLegs(cl, 1.85, 7600, 'P', 7590, 7648.2);
    expect(m.cl.map(l => l.strike)).toEqual([7580, 7590]);
    const fair0 = -positionValue(cl, 7648.2, 0), fair1 = -positionValue(m.cl, 7648.2, 0);
    expect(m.net - fair1).toBeCloseTo(1.85 - fair0, 10);
    expect(m.net).toBeLessThan(1.85);                          // a narrower spread takes in less
  });
  it('maps chart legs back to the ticket legs they came from', () => {
    const legs = [{ label: 'Short put', strike: 7600 }, { label: 'Long put', strike: 7580 }];
    const out = withLegIdx(cl.map(({ legIdx, ...l }) => l), legs);
    expect(out.map(l => l.legIdx)).toEqual([1, 0]);
  });
});

describe('dragging on the chart', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-18T16:42:00Z'));
    liveStore.setConnection('off');
    liveStore.applySnapshot({ seq: 0, status: {}, quotes: {}, positions: [], orders: [] });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 760, height: 400, right: 760, bottom: 400, x: 0, y: 0 });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('previews while dragging, ghosts the old curve, and commits once on release', () => {
    const onStrikeChange = vi.fn();
    render(<PayoffChart {...props} onStrikeChange={onStrikeChange} strikeSnap={snap} />);
    const c = within(screen.getByTestId('payoff-time-chart'));
    const short = c.getAllByTestId('strike-block').find(b => b.getAttribute('data-side') === 'short');
    const svg = screen.getByTestId('payoff-time-chart').querySelector('svg');
    fireEvent.pointerDown(short, { pointerId: 1, clientX: xOf(7600) });
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: xOf(7591) });
    expect(c.getByTestId('drag-preview').textContent).toMatch(/7600P → 7590P/);
    expect(c.getByTestId('ghost-curve')).toBeTruthy();
    expect(c.getByTestId('ghost-legend').textContent).toMatch(/before \(7600P\)/);
    expect(c.getAllByTestId('strike-block').map(b => b.textContent)).toEqual(['+7580P', '−7590P']);
    expect(onStrikeChange).not.toHaveBeenCalled();             // nothing re-runs mid-drag
    fireEvent.pointerUp(svg, { pointerId: 1, clientX: xOf(7591) });
    expect(onStrikeChange).toHaveBeenCalledTimes(1);
    expect(onStrikeChange).toHaveBeenCalledWith(0, 7590);      // legIdx of the short put
    expect(c.queryByTestId('drag-preview')).toBeNull();
  });

  it('Escape cancels; a drop on the same strike changes nothing', () => {
    const onStrikeChange = vi.fn();
    render(<PayoffChart {...props} onStrikeChange={onStrikeChange} strikeSnap={snap} />);
    const svg = screen.getByTestId('payoff-time-chart').querySelector('svg');
    const long = screen.getAllByTestId('strike-block').find(b => b.getAttribute('data-side') === 'long');
    fireEvent.pointerDown(long, { pointerId: 1, clientX: xOf(7580) });
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: xOf(7570) });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('drag-preview')).toBeNull();
    fireEvent.pointerDown(long, { pointerId: 1, clientX: xOf(7580) });
    fireEvent.pointerUp(svg, { pointerId: 1, clientX: xOf(7581) });
    expect(onStrikeChange).not.toHaveBeenCalled();
  });

  it('arrow keys step a block to the next listed strike', () => {
    const onStrikeChange = vi.fn();
    render(<PayoffChart {...props} onStrikeChange={onStrikeChange} strikeSnap={snap} />);
    const short = screen.getAllByRole('slider', { hidden: true }).find(b => /Short 7600 put/.test(b.getAttribute('aria-label')));
    fireEvent.keyDown(short, { key: 'ArrowRight' });
    expect(onStrikeChange).toHaveBeenCalledWith(0, 7605);
  });

  it('without onStrikeChange the blocks are not draggable', () => {
    render(<PayoffChart {...props} />);
    expect(screen.getAllByTestId('strike-block').every(b => !b.getAttribute('role') && b.getAttribute('tabindex') == null)).toBe(true);
  });

  it('ghosts another structure passed in', () => {
    const wide = cl.map(l => (l.sign > 0 ? { ...l, strike: 7570 } : l));
    render(<PayoffChart {...props} ghost={{ cl: wide, net: 2.4, label: 'Wider put spread · fair 2.40 cr' }} />);
    expect(screen.getByTestId('ghost-curve')).toBeTruthy();
    expect(screen.getByTestId('ghost-legend').textContent).toMatch(/Wider put spread/);
  });
});
