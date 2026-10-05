/* The 45DTE Vol Surface panel filling from /api/vol-surface (bridge mocked):
   every field fills, term bias becomes a readout, a typed value survives. */
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import EnginePanel from '../components/EnginePanel';

const surface = { underlying: 'SPX', spot: 6700, iv: 15.8, ivFront: 14.9, ivBack: 16.9, termBias: 'contango',
  termRatio: 0.882, skew: 6.4, ivr: 31.5, ivPctl: 44, iv30: 15.1, iv52wLow: 11.2, iv52wHigh: 32.6, hv: 12.3,
  hvSource: 'ib-30d', dataType: 'realtime', asOf: '2026-10-06T14:00:00Z', missing: [], notes: [],
  expiries: { trade: '20261120', tradeDte: 45, front: '20261106', frontDte: 31, back: '20270115', backDte: 101 },
  atm: { strike: 6700 }, skewDetail: { put: { strike: 6430, delta: 0.25, iv: 19.9, interpolated: true },
    call: { strike: 6960, delta: 0.25, iv: 13.5, interpolated: true } } };

const val = f => document.querySelector(`input[data-field="${f}"]`).value;
const mount = (i45 = {}, extra = {}) => render(
  <EnginePanel mode="45dte" onLogTrade={() => true} accountConfig={{ id: 'acct', bankroll: 50000 }}
    strategyHistory={{}} toast={() => {}}
    initialState={{ i45: { underlying: 'SPX', price: '6700', dte: '45', ...i45 }, ...extra }} />);

describe('vol surface panel', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('bridgeUrl', 'http://bridge.test');
    global.fetch = vi.fn(async (url) => ({ json: async () => (String(url).includes('/api/vol-surface') ? surface : {}) }));
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('fills every field and derives the term bias', async () => {
    mount();
    expect(screen.getByText('Term bias — manual (no Front/Back)')).toBeTruthy();
    fireEvent.click(screen.getByText('🔄 Fetch vol'));
    await waitFor(() => expect(val('iv')).toBe('15.8'));
    expect(String(global.fetch.mock.calls[0][0])).toContain('/api/vol-surface?underlying=SPX&expiry=');
    expect(val('ivr')).toBe('31.5'); expect(val('hv')).toBe('12.3');
    expect(val('ivFront')).toBe('14.9'); expect(val('ivBack')).toBe('16.9'); expect(val('skew')).toBe('6.4');
    expect(screen.getByText('Term bias — from Front/Back')).toBeTruthy();
    expect(screen.getByText('contango')).toBeTruthy();
    expect(screen.getByText(/IV pctl 44%/)).toBeTruthy();
  });

  it('leaves a typed value alone', async () => {
    mount({}, { held: { '45:hv': true } });
    fireEvent.change(document.querySelector('input[data-field="hv"]'), { target: { value: '18' } });
    fireEvent.click(screen.getByText('🔄 Fetch vol'));
    await waitFor(() => expect(val('iv')).toBe('15.8'));
    expect(val('hv')).toBe('18');
  });
});
