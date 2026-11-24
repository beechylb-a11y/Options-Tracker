/* Data in from TWS (Nov 2026): one state for the ticket's chip, a row per feed. */
import { describe, it, expect } from 'vitest';
import { inboundStatus, sourceTag, LIVE_MS, STALE_MS } from '../utils/inbound';

const NOW = Date.parse('2026-11-24T16:00:00Z');
const base = { now: NOW, bridge: true, connection: 'open', marketOpen: true };

describe('inboundStatus', () => {
  it('receiving while any pull runs, naming what is being pulled', () => {
    const s = inboundStatus({ ...base, underlying: { ts: NOW - 500 }, pulls: [{ key: 'greeks', label: 'Greeks / IV', busy: true }] });
    expect(s.state).toBe('receiving');
    expect(s.sub).toBe('greeks / iv');
    expect(s.feeds.find(f => f.key === 'greeks')).toMatchObject({ state: 'pulling', when: 'now…' });
  });

  it('live when streamed quotes are fresh; the oldest leg sets the age', () => {
    const s = inboundStatus({ ...base, underlying: { ts: NOW - 200 }, legs: [{ ts: NOW - 400 }, { ts: NOW - 1200 }],
      pulls: [{ key: 'market', label: 'Market data', at: NOW - 30000 }] });
    expect(s.state).toBe('live');
    expect(s.feeds.find(f => f.key === 'legs')).toMatchObject({ state: 'live', when: '1.2 s ago', label: 'Quotes (2 legs)' });
    expect(s.sub).toMatch(/^quotes 1\.2 s ago · market data \d\d:\d\d:\d\d$/);
  });

  it('a leg with no tick yet waits; a quote past the live window is stale in session', () => {
    const s = inboundStatus({ ...base, underlying: { ts: NOW - LIVE_MS - 5000 }, legs: [] });
    expect(s.feeds[0].state).toBe('stale');
    expect(s.state).toBe('stale');
    expect(s.title).toBe('TWS 1 min old');
    const w = inboundStatus({ ...base, underlying: null });
    expect(w.feeds[0]).toMatchObject({ state: 'waiting' });
  });

  it('after the bell an old quote is just the last one, not stale', () => {
    const s = inboundStatus({ ...base, marketOpen: false, underlying: { ts: NOW - 3600e3 } });
    expect(s.feeds[0].state).toBe('done');
  });

  it('flags a pull that came back delayed or frozen', () => {
    const s = inboundStatus({ ...base, connection: 'off', pulls: [{ key: 'market', label: 'Market data', at: NOW - 5000, fallback: 'frozen' }] });
    expect(s.feeds.find(f => f.key === 'market').state).toBe('fallback');
    expect(s.state).toBe('stale');
    expect(s.title).toBe('TWS frozen');
  });

  it('a pull older than three minutes in session is stale', () => {
    const s = inboundStatus({ ...base, connection: 'off', pulls: [{ key: 'greeks', label: 'Greeks / IV', at: NOW - STALE_MS - 60000 }] });
    expect(s.feeds[0].state).toBe('off');
    expect(s.feeds[1].state).toBe('stale');
    expect(s.state).toBe('stale');
  });

  it('offline with no stream and nothing pulled', () => {
    const s = inboundStatus({ now: NOW, bridge: false, connection: 'off', marketOpen: true, pulls: [{ key: 'market', label: 'Market data' }] });
    expect(s.state).toBe('offline');
    expect(s.title).toBe('Typed / model only');
    expect(s.sub).toMatch(/no bridge set/);
    expect(s.feeds.find(f => f.key === 'market')).toMatchObject({ state: 'off', when: 'no bridge' });
  });

  it('bridge up but TWS not connected: says so, quotes are off, and the last pull is named — never "TWS connected"', () => {
    const s = inboundStatus({ ...base, tws: false, underlying: null, legs: [{}, {}],
      pulls: [{ key: 'market', label: 'Market data', at: Date.parse('2026-11-24T15:46:41Z') }, { key: 'greeks', label: 'Greeks / IV' }] });
    expect(s.state).toBe('stale');
    expect(s.title).toBe('Bridge up · TWS not connected');
    expect(s.sub).toMatch(/^nothing new can arrive — last pull \d\d:\d\d:\d\d$/);
    expect(s.feeds.find(f => f.key === 'underlying')).toMatchObject({ state: 'off', when: 'TWS not connected' });
    expect(s.feeds.find(f => f.key === 'legs')).toMatchObject({ state: 'off', when: 'TWS not connected' });
    expect(s.feeds.find(f => f.key === 'greeks')).toMatchObject({ state: 'waiting', when: 'not pulled yet' });
    const none = inboundStatus({ ...base, tws: false, pulls: [] });
    expect(none.sub).toMatch(/start TWS or IB Gateway/);
  });

  it('what-if has its own row', () => {
    const s = inboundStatus({ ...base, underlying: { ts: NOW }, whatIf: 'ok' });
    expect(s.feeds.find(f => f.key === 'whatif')).toMatchObject({ state: 'done', when: 'in' });
  });
});

describe('sourceTag', () => {
  it('names the source, with the time for TWS', () => {
    expect(sourceTag('tws', NOW).text).toMatch(/^TWS \d\d:\d\d:\d\d$/);
    expect(sourceTag('typed')).toEqual({ kind: 'typed', text: 'typed' });
    expect(sourceTag('target').text).toBe('target');
    expect(sourceTag('whatever')).toEqual({ kind: 'model', text: 'model' });
  });
});
