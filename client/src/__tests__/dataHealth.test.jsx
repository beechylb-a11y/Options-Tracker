/* Data health (Settings › Data health and the data banner): streamed lines by state with
   entitlement notes, the latest session's 5-minute bars (78 from 09:30 New York, a
   shifted first bar named as a time-zone fault), settle coverage, and one headline that
   names the worst failure first. */
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { quoteHealth, barHealth, settleHealth, healthHeadline, bannerIssues, etNow } from '../utils/dataHealth';
import { heldIssues, HOLD_MS } from '../components/DataHealthBanner';
import DataHealthBanner from '../components/DataHealthBanner';
import DataHealthPanel from '../components/DataHealthPanel';
import { liveStore } from '../live/liveStore';

afterEach(cleanup);

// Wed 25 Nov 2026 11:00 New York = 16:00 UTC (market open); 20:00 New York closed.
const OPEN = new Date('2026-11-25T16:00:00Z').getTime();
const CLOSED = new Date('2026-11-26T01:00:00Z').getTime();

const st = (quotes, extra = {}) => ({ connection: 'open', status: { connected: true, farmOk: true }, quotes, ...extra });

describe('quoteHealth', () => {
  it('names each line: live, stale past 5 min, delayed, not entitled, blocked, not listed', () => {
    const q = quoteHealth(st({
      SPX: { ts: OPEN - 2000, last: 6800 },
      XSP: { ts: OPEN - 8 * 60000, last: 717 },
      QQQ: { ts: OPEN - 3000, delayed: true },
      VIX3M: { ts: OPEN - 3000, notEntitled: true, entCode: 10167 },
      IWM: { ts: OPEN - 3000, notEntitled: true, entCode: 10197 },
      'META 20270108 545 P': { ts: null, noContract: true },
      'SPX 20261125 6800 P': { ts: OPEN - 1000 },
    }), { now: OPEN, rth: true });
    const by = Object.fromEntries(q.rows.map(r => [r.key, r]));
    expect(by.SPX.tone).toBe('ok');
    expect(by.XSP).toMatchObject({ state: 'stale', tone: 'bad' });
    expect(by.XSP.note).toMatch(/no tick for 8 min/);
    expect(by.QQQ).toMatchObject({ state: 'delayed', tone: 'warn' });
    expect(by.VIX3M).toMatchObject({ state: 'notEntitled', tone: 'warn' });
    expect(by.VIX3M.note).toMatch(/prior close only/);
    expect(by.IWM).toMatchObject({ state: 'blocked', tone: 'bad' });
    expect(by.IWM.note).toMatch(/another login/);
    expect(q.legs.n).toBe(2);
    expect(q.legs.bad).toEqual(['META 20270108 545 P']);
  });
  it('market closed: last values are fine; bridge states come through', () => {
    const q = quoteHealth(st({ SPX: { ts: OPEN - 3600000 } }), { now: CLOSED, rth: false });
    expect(q.rows[0]).toMatchObject({ state: 'frozen', tone: 'ok' });
    expect(quoteHealth(st({}, { status: { connected: false } })).bridge).toBe('noTws');
    expect(quoteHealth({ connection: 'down', quotes: {} }).bridge).toBe('down');
    expect(quoteHealth({ connection: 'off', quotes: {} }).bridge).toBe('off');
  });
});

// A day of 5-minute bars starting at `startMin` (minutes after midnight, in the stamp's zone).
const day = (ymd, n, zone = 'US/Eastern', startMin = 570, skip = []) => Array.from({ length: n }, (_, i) => startMin + i * 5)
  .filter(m => !skip.includes(m))
  .map(m => ({ date: `${ymd} ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00 ${zone}` }));

describe('barHealth', () => {
  it('a full day: 78 from 09:30, Chicago stamps read right', () => {
    const b = barHealth([...day('20261123', 78), ...day('20261124', 78, 'US/Central', 510)], { now: new Date(CLOSED) });
    expect(b).toMatchObject({ ymd: '20261124', count: 78, expected: 78, first: 570, tone: 'ok', zone: 'US/Central' });
  });
  it('an unknown zone on Chicago stamps: an hour early, named as a zone fault', () => {
    const b = barHealth(day('20261124', 78, 'CT', 510), { now: new Date(CLOSED) });
    expect(b.shift).toBe(-60);
    expect(b.tone).toBe('bad');
    expect(b.text).toMatch(/start at 08:30 New York, 1 h early: the time zone \(none\)/);
  });
  it('missing bars are listed; today counts only the bars so far', () => {
    const gap = barHealth(day('20261124', 78, 'US/Eastern', 570, [600, 605, 610, 615]), { now: new Date(CLOSED) });
    expect(gap).toMatchObject({ count: 74, tone: 'warn' });
    expect(gap.text).toMatch(/74 of 78 bars: missing 10:00, 10:05, 10:10 and 1 more/);
    const today = barHealth(day('20261125', 18), { now: new Date(OPEN) });     // 09:30–10:55 at 11:00
    expect(today).toMatchObject({ expected: 18, count: 18, tone: 'ok' });
    expect(today.text).toMatch(/18 of 18 bars so far/);
  });
  it('a half day ending 12:55 expects 42', () => {
    expect(barHealth(day('20261127', 42), { now: new Date('2026-11-28T15:00:00Z') })).toMatchObject({ expected: 42, tone: 'ok' });
  });
  it('epoch-second bars and no bars', () => {
    const t0 = Date.UTC(2026, 10, 24, 14, 30) / 1000;    // 09:30 New York
    const b = barHealth(Array.from({ length: 78 }, (_, i) => ({ date: String(t0 + i * 300) })), { now: new Date(CLOSED) });
    expect(b).toMatchObject({ count: 78, zone: 'epoch', tone: 'ok' });
    expect(barHealth([])).toBeNull();
  });
});

describe('settleHealth', () => {
  const r = (und, expiry, settled, extra = {}) => ({ underlying: und, expiry, engine: '0DTE', settled_at: settled ? 'x' : null, managed_at: settled ? 'x' : null, ...extra });
  it('counts what is past expiry and names what is left, by underlying', () => {
    const s = settleHealth([r('SPX', '20261120', true), r('XSP', '20261118', false), r('XSP', '20261119', false), r('QQQ', '20261124', false), r('SPY', '20261218', false)], { now: new Date(OPEN) });
    expect(s).toMatchObject({ due: 4, settled: 1, tone: 'bad' });
    expect(s.pending[0]).toMatchObject({ underlying: 'XSP', n: 2, oldest: '20261118' });
    expect(s.text).toMatch(/3 of 4 past expiry not settled: XSP 2, QQQ 1/);
  });
  it("today's verdicts aren't a fault before the next settle", () => {
    const s = settleHealth([r('SPX', '20261125', false)], { now: new Date('2026-11-25T22:00:00Z') });
    expect(s.due).toBe(1);
    expect(s.tone).toBe('ok');
  });
  it('all settled, with 0DTE still short of a managed exit', () => {
    const s = settleHealth([r('SPX', '20261120', true, { managed_at: null })], { now: new Date(OPEN) });
    expect(s.text).toMatch(/all 1 past expiry settled; 1 0DTE still need a managed exit/);
  });
});

describe('headline and banner', () => {
  it('bridge failures win; then lines, bars and settles in that order', () => {
    expect(healthHeadline(quoteHealth({ connection: 'down', quotes: {} })).text).toMatch(/Bridge stream down/);
    const q = quoteHealth(st({ XSP: { ts: OPEN - 9 * 60000 }, SPX: { ts: OPEN - 1000 } }), { now: OPEN, rth: true });
    const h = healthHeadline(q, { SPX: { tone: 'warn', text: '70 of 78 bars' } }, { tone: 'warn', text: '2 of 9 past expiry not settled' });
    expect(h.tone).toBe('bad');
    expect(h.text).toBe('XSP no tick for 9 min in the session · and 2 more');
    expect(h.items).toHaveLength(3);
    expect(healthHeadline(quoteHealth(st({ SPX: { ts: OPEN - 1000 } }), { now: OPEN, rth: true })).text).toBe('All data checks pass');
  });
  it('banner: session only, held two minutes, hidden until the set changes', () => {
    const q = quoteHealth(st({ XSP: { ts: OPEN - 9 * 60000 } }), { now: OPEN, rth: true });
    expect(bannerIssues(q)).toHaveLength(1);
    expect(bannerIssues({ ...q, marketOpen: false })).toHaveLength(0);
    const seen = {};
    expect(heldIssues(bannerIssues(q), seen, OPEN)).toHaveLength(0);
    expect(heldIssues(bannerIssues(q), seen, OPEN + HOLD_MS)).toHaveLength(1);
    expect(heldIssues([], seen, OPEN + HOLD_MS + 1)).toHaveLength(0);
    expect(seen).toEqual({});
  });
  it('the banner names the line and opens Data health', () => {
    liveStore.applySnapshot({ status: { connected: true, farmOk: true }, quotes: { XSP: { ts: OPEN - 9 * 60000 } } });
    liveStore.setConnection('open');
    let opened = 0;
    render(<DataHealthBanner authenticated now={OPEN} onOpen={() => { opened++; }} />);
    expect(screen.getByTestId('data-banner-head').textContent).toMatch(/XSP: no tick for 9 min/);
    fireEvent.click(screen.getByTestId('data-banner-open'));
    expect(opened).toBe(1);
  });
});

describe('DataHealthPanel', () => {
  it('lines, bars on request and settles', async () => {
    liveStore.applySnapshot({ status: { connected: true, farmOk: true }, quotes: { SPX: { ts: OPEN - 1000 }, VIX: { ts: OPEN - 1000 } } });
    liveStore.setConnection('open');
    const asked = [];
    render(<DataHealthPanel now={OPEN} shadowRows={[{ underlying: 'SPX', expiry: '20261120', engine: '0DTE', settled_at: 'x', managed_at: 'x' }]}
      fetchHistory={async s => { asked.push(s); return day('20261125', 18); }} />);
    expect(screen.getAllByTestId('health-quote')).toHaveLength(2);
    expect(screen.getByTestId('health-settle-text').textContent).toMatch(/all 1 past expiry settled/);
    fireEvent.click(screen.getByTestId('health-check-bars'));
    await waitFor(() => expect(screen.getAllByTestId('health-bar')).toHaveLength(1));
    expect(asked).toEqual(['SPX']);           // VIX family skipped
  });
});

it('etNow knows the session', () => {
  expect(etNow(new Date(OPEN))).toMatchObject({ ymd: '20261125', min: 660, rth: true });
  expect(etNow(new Date(CLOSED)).rth).toBe(false);
});
