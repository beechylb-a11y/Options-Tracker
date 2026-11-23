/* Volatility watch (23 Nov 2026): VIX against the close and VIX3M, each trade's IV
   against entry (leg by leg when logged), the book's vega, and the banner text. */
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
vi.mock('../utils/api', () => ({ api: {} }));
import { marketVol, positionVol, bookVol, VOL_LIMITS } from '../engine/volWatch';
import { volHeadline, volDetail } from '../components/VolBanner';
import { IvChip } from '../components/PositionBoard';
import { legIvsFromNotes } from '../engine/portfolio';

afterEach(cleanup);

const pos = (o = {}) => ({ key: '9', underlying: 'QQQ', strategy: 'Iron condor', engine: '45DTE', live: 2, row: { account: 'live-1' },
  pos: { isCredit: true }, entry: { spot: 600, iv: 19, ymd: '20261110', legIvs: { '560P': 22, '570P': 21, '640C': 17, '650C': 16 }, ...o.entry }, ...o.p });
const risk = (o = {}) => ({ p: pos(o), spot: 602, pnl: -132,
  legs: [{ strike: 560, right: 'P', iv: 28 }, { strike: 570, right: 'P', iv: 27 }, { strike: 640, right: 'C', iv: 21 }, { strike: 650, right: 'C', iv: 20 }],
  greeks: { delta: 21, gamma: -1, theta: 31, vega: -196, ...o.g } });

describe('market', () => {
  it('VIX against the close, and VIX above VIX3M', () => {
    const m = marketVol({ vix: { last: 20.9, close: 17.6 }, vix1d: { last: 24.3, close: 20 }, vix3m: { last: 21.1 } });
    expect(m.pct).toBeCloseTo(18.75, 2);
    expect(m.tone).toBe('amber');
    expect(marketVol({ vix: { last: 22.5, close: 17.6 } }).tone).toBe('red');
    expect(marketVol({ vix: { last: 21, close: 20 }, vix3m: { last: 20.5 } }).tone).toBe('red');
    expect(marketVol({ vix: { last: 17.8, close: 17.6 }, vix3m: { last: 19 } }).tone).toBeNull();
    expect(VOL_LIMITS.vixPct).toEqual({ amber: 15, red: 25 });
  });
  it('without live CBOE index data VIX3M and VIX1D fall back to the last close', () => {
    // 23 Nov 2026 on the paper login: VIX 35.89, VIX3M close 30.94 (notEntitled, no mark)
    const m = marketVol({ vix: { last: 35.89, close: 35.89 }, vix3m: { close: 30.94, mark: null, notEntitled: true }, vix1d: { close: 51.34, mark: null } });
    expect(m.term).toBeCloseTo(1.16, 2);
    expect(m.vix3mFromClose).toBe(true);
    expect(m.tone).toBe('red');
    expect(m.reasons.join()).toMatch(/VIX3M at its last close/);
    expect(m.vix1d).toBe(51.34);
  });
});

describe('position', () => {
  it('IV since entry leg by leg; short vega flags a rise', () => {
    const v = positionVol(risk(), { todayMs: Date.UTC(2026, 10, 23) });
    expect(v.basis).toBe('legs');
    expect(v.dIv).toBeCloseTo(5, 6);
    expect(v.tone).toBe('amber');
    expect(v.vegaPnl).toBeCloseTo(-980, 6);
    expect(v.split.days).toBe(13);
    expect(v.thetaDays).toBeCloseTo(980 / 31, 6);
    expect(v.reasons.join()).toMatch(/cost 32 days of theta/);
    expect(v.split.price + v.split.time + v.split.iv + v.split.other).toBeCloseTo(-132, 6);
  });
  it('red at +10 pts; a long-vega trade flags a fall instead', () => {
    const r = risk(); r.legs = r.legs.map(l => ({ ...l, iv: l.iv + 6 }));
    expect(positionVol(r).tone).toBe('red');
    const long = risk({ g: { vega: 150, theta: -20 } });
    expect(positionVol(long).tone).toBeNull();
    long.legs = long.legs.map(l => ({ ...l, iv: l.iv - 15 }));
    expect(positionVol(long).tone).toBe('red');
  });
  it('near vega-neutral stays quiet; without leg IVs falls back to the expiry IV', () => {
    expect(positionVol(risk({ g: { vega: -5, theta: 31 } })).tone).toBeNull();
    const v = positionVol(risk({ entry: { legIvs: null, ivx: 20 } }));
    expect(v.basis).toBe('expiry IV');
    expect(v.dIv).toBeCloseTo(4, 6);
  });
  it('0DTE: VIX1D up 20% since entry', () => {
    const r = risk({ p: { engine: '0DTE' }, entry: { legIvs: null, iv: null, ivx: null, vix1d: 15 } });
    expect(positionVol(r, { market: { vix1d: 18.5 } }).reasons.join()).toMatch(/VIX1D up 23%/);
  });
  it('leg IVs come from the ticket notes', () => {
    expect(legIvsFromNotes('Leg IVs: 670P 38.20 / 695P 41.10')).toEqual({ '670P': 38.2, '695P': 41.1 });
  });
});

describe('book and banner', () => {
  it('sums vega, prices the VIX move, takes the worst tone', () => {
    const m = marketVol({ vix: { last: 20.9, close: 17.6 }, vix3m: { last: 21.1 } });
    const b = bookVol([positionVol(risk()), { vega: -216, tone: null, reasons: [] }], m, 41230);
    expect(b.vega).toBe(-412);
    expect(b.today).toBeCloseTo(-412 * 3.3, 6);
    expect(b.tone).toBe('red');   // ≈ −$1,360 is 3.3% of net liq
    const w = { market: m, book: b };
    expect(volHeadline(w)).toMatch(/VIX 17\.6 → 20\.9 \(\+19%\) since the close/);
    expect(volDetail(w)).toMatch(/book vega −\$412 per IV point/);
  });
  it('the chip says the IV move', () => {
    render(<IvChip v={{ tone: 'amber', dIv: 5, reasons: ['x'] }} />);
    expect(screen.getByTestId('iv-chip').textContent).toBe('IV +5.0');
  });
});
