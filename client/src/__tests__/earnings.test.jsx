/* Earnings on a ticket (Oct 2026): a single stock's report — or an index's biggest
   names — checked against the 0DTE reaction day and the 45DTE hold. */
import { describe, it, expect, vi } from 'vitest';
import { earningsRisk0DTE, earningsRisk45DTE, earningsSymbols, earningsWindow, prevWeekday, isSingleStock } from '../engine/earnings';
import { parseDay, timeOf, weekdays, earningsBetween, _cacheForTests } from '../../../bridge/earnings.js';

const ok = events => ({ status: 'ok', events, failed: [] });

describe('which symbols', () => {
  it('a stock checks itself; an index checks its biggest names; a sector ETF nothing', () => {
    expect(earningsSymbols('tsla')).toEqual(['TSLA']);
    expect(earningsSymbols('QQQ')).toContain('NVDA');
    expect(earningsSymbols('SPX')).toContain('AAPL');
    expect(earningsSymbols('GLD')).toEqual([]);
    expect(isSingleStock('XSP')).toBe(false);
    expect(prevWeekday('2026-10-26')).toBe('2026-10-23');      // Monday looks back to Friday
    expect(earningsWindow('2026-10-26', 45)).toEqual({ from: '2026-10-23', to: '2026-12-10' });
  });
});

describe('0DTE', () => {
  const today = '2026-10-22';
  it('warns on the reaction day: before today’s open, or after the previous close', () => {
    const bmo = earningsRisk0DTE({ underlying: 'TSLA', todayISO: today, earnings: ok([{ symbol: 'TSLA', date: today, time: 'bmo' }]) });
    expect(bmo.warnings[0]).toMatch(/TSLA reported before today’s open/);
    const amcYday = earningsRisk0DTE({ underlying: 'TSLA', todayISO: today, earnings: ok([{ symbol: 'TSLA', date: '2026-10-21', time: 'amc' }]) });
    expect(amcYday.warnings[0]).toMatch(/after yesterday’s close/);
  });
  it('a report after today’s close is only a notice; unknown time today is a warning', () => {
    const amc = earningsRisk0DTE({ underlying: 'TSLA', todayISO: today, earnings: ok([{ symbol: 'TSLA', date: today, time: 'amc' }]) });
    expect(amc.warnings).toEqual([]);
    expect(amc.notices[0]).toMatch(/after a 0DTE expires/);
    const unk = earningsRisk0DTE({ underlying: 'TSLA', todayISO: today, earnings: ok([{ symbol: 'TSLA', date: today, time: 'unknown' }]) });
    expect(unk.warnings[0]).toMatch(/check the time/);
  });
  it('an index warns for a big name reacting today, notices a small one', () => {
    const r = earningsRisk0DTE({ underlying: 'QQQ', todayISO: today, earnings: ok([
      { symbol: 'NVDA', date: '2026-10-21', time: 'amc' }, { symbol: 'NFLX', date: today, time: 'bmo' }, { symbol: 'IBM', date: today, time: 'bmo' }]) });
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toMatch(/NVDA \(≈9% of QQQ\)/);
    expect(r.notices.some(n => /NFLX/.test(n))).toBe(true);
    expect(r.events.map(e => e.symbol)).toEqual(['NVDA', 'NFLX']);
  });
  it('says when it could not check a stock, and stays quiet for an index', () => {
    expect(earningsRisk0DTE({ underlying: 'TSLA', todayISO: today, earnings: null }).notices[0]).toMatch(/Earnings not checked/);
    expect(earningsRisk0DTE({ underlying: 'SPX', todayISO: today, earnings: null }).notices).toEqual([]);
  });
});

describe('45DTE', () => {
  const today = '2026-10-22';
  it('warns when the report falls before the planned close, notices it after', () => {
    const inHold = earningsRisk45DTE({ underlying: 'NVDA', todayISO: today, dte: 45, earnings: ok([{ symbol: 'NVDA', date: '2026-11-19', time: 'amc' }]) });
    expect(inHold.closeISO).toBe('2026-11-15');
    expect(inHold.warnings).toEqual([]);                      // 19 Nov is after the 15 Nov close
    expect(inHold.notices[0]).toMatch(/after your planned 21-DTE close/);
    const early = earningsRisk45DTE({ underlying: 'TSLA', todayISO: today, dte: 45, earnings: ok([{ symbol: 'TSLA', date: '2026-10-28', time: 'amc' }]) });
    expect(early.warnings[0]).toMatch(/TSLA earnings 28 Oct, after the close — inside the hold/);
  });
  it('an index’s big names are notices only, so earnings season does not pin every ticket at caution', () => {
    const r = earningsRisk45DTE({ underlying: 'QQQ', todayISO: today, dte: 45, earnings: ok([{ symbol: 'MSFT', date: '2026-10-28', time: 'amc' }]) });
    expect(r.warnings).toEqual([]);
    expect(r.notices[0]).toMatch(/MSFT \(≈8% of QQQ\) reports 28 Oct, after the close, inside the hold/);
  });
  it('flags unreadable days', () => {
    const r = earningsRisk45DTE({ underlying: 'TSLA', todayISO: today, dte: 45, earnings: { status: 'partial', events: [], failed: ['2026-10-28'] } });
    expect(r.notices[0]).toMatch(/unreadable for 1 day/);
  });
});

describe('bridge calendar reader', () => {
  it('parses a Nasdaq day and its times', () => {
    expect(timeOf('time-pre-market')).toBe('bmo');
    expect(timeOf('time-after-hours')).toBe('amc');
    expect(timeOf('time-not-supplied')).toBe('unknown');
    const rows = parseDay({ data: { rows: [{ symbol: 'TSLA ', name: 'Tesla', time: 'time-after-hours' }, { symbol: '' }] } }, '2026-10-22');
    expect(rows).toEqual([expect.objectContaining({ symbol: 'TSLA', date: '2026-10-22', time: 'amc' })]);
    expect(parseDay({ data: { rows: null } }, '2026-10-24')).toEqual([]);
    expect(weekdays('2026-10-23', '2026-10-27')).toEqual(['2026-10-23', '2026-10-26', '2026-10-27']);
  });
  it('filters to the symbols asked for and reports the days it could not read', async () => {
    _cacheForTests.clear();
    const fetchImpl = vi.fn(async url => {
      if (url.includes('2026-10-27')) return { ok: false, status: 403 };
      const date = url.split('date=')[1];
      return { ok: true, json: async () => ({ data: { rows: date === '2026-10-26'
        ? [{ symbol: 'TSLA', time: 'time-after-hours' }, { symbol: 'IBM', time: 'time-pre-market' }] : [] } }) };
    });
    const r = await earningsBetween(['tsla'], '2026-10-23', '2026-10-27', { fetchImpl });
    expect(r.events).toEqual([expect.objectContaining({ symbol: 'TSLA', date: '2026-10-26', time: 'amc' })]);
    expect(r.failed).toEqual(['2026-10-27']);
    expect(r.complete).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

import React from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { calc45DTE } from '../engine/calc45dte';
import EnginePanel from '../components/EnginePanel';

describe('in the engine and on the verdict', () => {
  it('a 45DTE ticket on a stock with earnings inside the hold trades with caution, and says why', () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-22T15:00:00Z'));
    const inp = { underlying: 'TSLA', price: 430, ivr: 50, iv: 55, hv: 45, vix: 17, termBias: 'contango',
      dte: 45, outlook: 'neutral', pop: 70, win: 300, risk: 700, bankroll: 30000, startBR: 30000, maxLoss: 1000, maxOpen: 3000,
      overrideStrategy: 'Iron Condor - Normal' };
    const without = calc45DTE({ ...inp, earnings: ok([]) });
    const withE = calc45DTE({ ...inp, earnings: ok([{ symbol: 'TSLA', date: '2026-10-28', time: 'amc' }]) });
    expect(withE.warnings.some(w => /TSLA earnings 28 Oct/.test(w))).toBe(true);
    expect(without.warnings.some(w => /earnings/i.test(w))).toBe(false);
    expect(withE.earningsRisk.events.length).toBe(1);
    vi.useRealTimers();
  });

  it('shows an EARNINGS pill beside the verdict, from the bridge', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-22T15:00:00Z'));
    localStorage.setItem('bridgeUrl', 'http://bridge');
    const calls = [];
    global.fetch = vi.fn(url => {
      const u = String(url); calls.push(u);
      const body = u.includes('/api/earnings') ? { events: [{ symbol: 'TSLA', date: '2026-10-28', time: 'amc' }], checked: 50, failed: [], complete: true } : {};
      return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify(body)), json: () => Promise.resolve(body) });
    });
    const i45 = { underlying: 'TSLA', price: '430', ivr: '50', iv: '55', hv: '45', vix: '17', ivFront: '50', ivBack: '52', skew: '3', dte: '45',
      pop: '70', win: '300', risk: '700', netCreditDebit: '3.00', bankroll: 30000, startBR: 30000, maxLoss: 1000, maxOpen: 3000 };
    render(<EnginePanel mode="45dte" onLogTrade={() => true} accountConfig={{ id: 'acct', bankroll: 30000 }}
      strategyHistory={{}} initialState={{ i45, overrideStrat: 'Iron Condor - Normal' }} toast={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('earnings-badge').textContent).toBe('EARNINGS 28 Oct AMC'));
    expect(calls.find(u => u.includes('/api/earnings'))).toMatch(/symbols=TSLA&from=2026-10-21&to=2027-01-05/);
    cleanup(); localStorage.clear(); vi.useRealTimers();
  });
});
