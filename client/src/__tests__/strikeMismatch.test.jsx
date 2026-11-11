import { describe, it, expect, vi } from 'vitest';
vi.mock('../utils/api', () => ({ api: { getOpenPositions: () => Promise.resolve([]), getDecisions: () => Promise.resolve([]), getCloses: () => Promise.resolve([]) } }));
import { matchTicketLegs, matchByShape } from '../utils/positionMatch';
import { runCheckup } from '../components/Checkup45';
import { boardRow } from '../components/PositionBoard';

// SPY 11 Nov 2026: logged 753/757/762 (Legs line still on 754), TWS filled 753/756/761.
const raw = [
  { underlying: 'SPY', expiry: '20261111', strike: 753, right: 'C', qty: 3 },
  { underlying: 'SPY', expiry: '20261111', strike: 761, right: 'C', qty: 3 },
  { underlying: 'SPY', expiry: '20261111', strike: 756, right: 'C', qty: -6 },
];
const notes = 'Legs: +1 754C 20261111 / -2 757C 20261111 / +1 762C 20261111\nSPY — Asymmetric butterfly';
const t = { underlying: 'SPY', strikes: '753 / 757 / 762', strategy: 'Asymmetric butterfly', qtyOpen: 3, todayYmd: '20261111', notes };

describe('ticket strikes vs TWS', () => {
  it('reads the one TWS position with the same shape, and says the strikes differ', () => {
    const m = matchTicketLegs(t, raw);
    expect(m.legs.map(l => `${l.qty}${l.strike}${l.right}`)).toEqual(['1753C', '-2756C', '1761C']);
    expect(m.mismatch).toEqual({ tws: '753/756/761', ticket: '753/757/762' });
  });
  it('an exact match is still exact, with no mismatch', () => {
    const m = matchTicketLegs({ ...t, strikes: '753 / 756 / 761' }, raw);
    expect(m.legs).toHaveLength(3);
    expect(m.mismatch).toBeUndefined();
  });
  it('never takes a position another open ticket owns', () => {
    expect(matchByShape({ ...t, claimed: ['753/756/761'] }, raw)).toBeNull();
  });
  it('no guess when two positions have the shape', () => {
    const two = [...raw, { underlying: 'SPY', expiry: '20261111', strike: 740, right: 'C', qty: 1 },
      { underlying: 'SPY', expiry: '20261111', strike: 745, right: 'C', qty: -2 }, { underlying: 'SPY', expiry: '20261111', strike: 750, right: 'C', qty: 1 }];
    // one expiry group now has 6 legs — no shape fits; and wrong shape (put) never matches
    expect(matchByShape(t, two)).toBeNull();
    expect(matchByShape({ ...t, notes: notes.replace(/C /g, 'P ') }, raw)).toBeNull();
  });
});

describe('check-up names the leg with no quote and carries the mismatch', () => {
  const run = async (quote) => {
    vi.setSystemTime(new Date('2026-11-11T16:07:00Z'));
    global.fetch = vi.fn(url => {
      let body = {};
      if (/\/api\/positions/.test(url)) body = { raw };
      else if (/vol-surface/.test(url)) body = { spot: 757.95, iv: 12 };
      else if (/option-greeks/.test(url)) {
        const legs = JSON.parse(decodeURIComponent(url.split('legs=')[1]));
        body = { undPrice: 757.95, legs: legs.map(l => ({ greeks: quote(l) })) };
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) });
    });
    const d = { Timestamp: '2026-11-11T15:51:55.310Z', Engine: '0DTE', Underlying: 'SPY', Strategy: 'SPY - Asymmetric butterfly - 3 contracts', Contracts: '3',
      'Wing Strikes': '753 / 757 / 762', Notes: notes, 'Net Debit/Credit': '-0.45', 'Max Profit': '765', 'Max Risk': '735', _rowIndex: 66 };
    const res = await runCheckup({ tickets: [d], openPositions: [{ timestamp: d.Timestamp, qtyOpen: 3, qty: 3 }], bridgeUrl: 'http://b', force: true });
    return res.list[0];
  };
  it('prices the TWS strikes and flags the ticket', async () => {
    const x = await run(() => ({ bid: 1, ask: 1.1, iv: 12, delta: 0.5 }));
    expect(x.legs.map(l => l.strike)).toEqual([753, 756, 761]);
    expect(x.mismatch.tws).toBe('753/756/761');
    expect(x.review.action).not.toBe('unknown');
    const row = boardRow({ ticketRef: 66, qty: 3, qtyOpen: 3, engine: '0DTE', underlying: 'SPY', strategy: 'Asymmetric butterfly', legs: '753 / 757 / 762', entryPrice: -0.45 }, { check: x });
    expect(row.mismatch.ticket).toBe('753/757/762');
  });
  it('says which leg had no quote', async () => {
    const x = await run(l => (l.strike === 761 ? null : { bid: 1, ask: 1.1 }));
    expect(x.quoteErr).toBe('no quote for 761C');
    expect(x.review.action).toBe('unknown');
  });
});
