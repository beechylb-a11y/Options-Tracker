import { describe, it, expect } from 'vitest';
import { createLiveBook, liveKey, parseLiveKey, markOf, comboQuote, sseFrame } from '../../../bridge/liveBook.js';

describe('liveKey', () => {
  it('builds the same key for an underlying and a leg however they are written', () => {
    expect(liveKey('spx')).toBe('SPX');
    expect(liveKey('SPX', '2026-11-18', '7600', 'Put')).toBe('SPX 20261118 7600 P');
    expect(liveKey('XSP', '20261119', 765.5, 'C')).toBe('XSP 20261119 765.5 C');
    expect(parseLiveKey('SPX 20261118 7600 P')).toEqual({ underlying: 'SPX', expiry: '20261118', strike: 7600, right: 'P' });
    expect(parseLiveKey('QQQ')).toEqual({ underlying: 'QQQ' });
    expect(parseLiveKey('bad key')).toBeNull();
  });
});

describe('createLiveBook', () => {
  const clock = () => { let t = 1000; return { now: () => t, add: ms => { t += ms; } }; };

  it('subscribes once per key and drops it when nothing holds it', () => {
    const b = createLiveBook({ now: () => 0 });
    expect(b.want('SPX', 'watch')).toBe('new');
    expect(b.want('SPX', 'ticket', 60000)).toBe('held');
    expect(b.release('SPX', 'ticket')).toBe(false);
    expect(b.release('SPX', 'watch')).toBe(true);
    expect(b.has('SPX')).toBe(false);
  });

  it('expires ticket legs nobody renewed, never positions or watched underlyings', () => {
    const c = clock();
    const b = createLiveBook({ now: c.now });
    b.want('SPX', 'watch');
    b.want('SPX 20261118 7600 P', 'position');
    b.want('SPX 20261118 7580 P', 'ticket', 120000);
    b.want('SPX 20261118 7600 P', 'ticket', 120000);
    c.add(119000);
    expect(b.expire()).toEqual([]);
    c.add(2000);
    expect(b.expire()).toEqual(['SPX 20261118 7580 P']);
    expect(b.has('SPX 20261118 7600 P')).toBe(true);   // still a position
    expect(b.has('SPX')).toBe(true);
  });

  it('refuses new ticket legs past the line budget but always takes positions', () => {
    const b = createLiveBook({ now: () => 0, maxLines: 2 });
    b.want('SPX', 'watch');
    b.want('A 20261118 1 P', 'ticket', 1000);
    expect(b.want('B 20261118 1 P', 'ticket', 1000)).toBe('refused');
    expect(b.want('C 20261118 1 P', 'position')).toBe('new');
    expect(b.snapshot().status.refused).toBe(1);
  });

  it('turns ticks into a quote with a mark, and flags delayed fields', () => {
    const c = clock();
    const b = createLiveBook({ now: c.now });
    b.want('SPX', 'watch');
    expect(b.applyTick('SPX', 1, 7648.0)).toBe(true);
    b.applyTick('SPX', 2, 7648.4);
    b.applyTick('SPX', 9, 7616.1);
    b.applyTick('SPX', 4, -1);               // placeholder, ignored
    const q = b.snapshot().quotes.SPX;
    expect(q.bid).toBe(7648);
    expect(q.mark).toBe(7648.2);
    expect(q.close).toBe(7616.1);
    expect(q.last).toBeUndefined();
    expect(q.ts).toBe(1000);
    b.applyTick('SPX', 66, 7647.9);
    expect(b.snapshot().quotes.SPX.delayed).toBe(true);
    expect(b.applyTick('NOPE', 1, 1)).toBe(false);
  });

  it('keeps a real zero bid on a far out-of-the-money leg', () => {
    const b = createLiveBook({ now: () => 0 });
    b.want('QQQ 20261120 685 P', 'position');
    b.applyTick('QQQ 20261120 685 P', 1, 0);
    b.applyTick('QQQ 20261120 685 P', 2, 0.01);
    expect(b.snapshot().quotes['QQQ 20261120 685 P'].mark).toBe(0.01);
  });

  it('sends only what changed since the seq a client has, and what left', () => {
    const b = createLiveBook({ now: () => 0 });
    b.want('SPX', 'watch'); b.want('QQQ', 'ticket', 1000);
    b.applyTick('SPX', 1, 1); b.applyTick('QQQ', 1, 2);
    const s0 = b.snapshot();
    b.applyTick('SPX', 2, 3);
    b.release('QQQ', 'ticket');
    const d = b.changesSince(s0.seq, new Set(Object.keys(s0.quotes)));
    expect(Object.keys(d.quotes)).toEqual(['SPX']);
    expect(d.removed).toEqual(['QQQ']);
    expect(d.positions).toBeNull();
  });

  it('reports positions and orders whenever the list changes, deletions included', () => {
    const b = createLiveBook({ now: () => 0 });
    b.setPosition('DU1', 'SPX 20261118 7600 P', -2, 292, 100);
    const s1 = b.seq;
    b.setPosition('DU1', 'SPX 20261118 7600 P', 0, 0);
    const d = b.changesSince(s1);
    expect(d.positions).toEqual([]);
    b.setOrder(7, { status: 'Submitted', lmtPrice: 1.85 });
    b.setOrder(7, { status: undefined, filled: 2 });     // an undefined field must not wipe the status
    expect(b.snapshot().orders[0]).toMatchObject({ orderId: 7, status: 'Submitted', filled: 2, lmtPrice: 1.85 });
  });
});

describe('markOf and comboQuote', () => {
  it('uses the mid when both sides are real, else last', () => {
    expect(markOf({ bid: 1, ask: 1.2 })).toBe(1.1);
    expect(markOf({ bid: 1.3, ask: 1.2, last: 1.25 })).toBe(1.25);
    expect(markOf(null)).toBeNull();
  });

  it('prices a put credit spread money-in positive: mid, crossing the spread, and the far side', () => {
    const quotes = {
      'SPX 20261118 7580 P': { bid: 1.05, ask: 1.10 },
      'SPX 20261118 7600 P': { bid: 2.85, ask: 3.00 },
    };
    const legs = [{ key: 'SPX 20261118 7580 P', qty: 1 }, { key: 'SPX 20261118 7600 P', qty: -1 }];
    expect(comboQuote(legs, quotes)).toEqual({ mid: 1.85, natural: 1.75, far: 1.95, complete: true });
    // The same spread as a debit (bought): signs flip.
    const debit = legs.map(l => ({ ...l, qty: -l.qty }));
    expect(comboQuote(debit, quotes)).toEqual({ mid: -1.85, natural: -1.95, far: -1.75, complete: true });
  });

  it('says incomplete rather than guessing when a leg has no quote', () => {
    expect(comboQuote([{ key: 'X', qty: 1 }], {})).toEqual({ mid: null, natural: null, far: null, complete: false });
  });
});

describe('sseFrame', () => {
  it('writes one event with an id and JSON data', () => {
    expect(sseFrame('delta', { a: 1 }, 5)).toBe('id: 5\nevent: delta\ndata: {"a":1}\n\n');
  });
});
