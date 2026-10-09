/* Risk now (Oct 2026): the book from the app's own tickets, checked against TWS,
   with greeks, a stress grid, the risk budget and what needs doing. */
import { describe, it, expect } from 'vitest';
import {
  buildBook, reconcile, positionRisk, totals, stressGrid, riskBudget, eventsAhead, attention,
  betaOf, yearsToExpiry, plannedExit, spxDailySd,
} from '../engine/portfolio';

const NOW = new Date('2026-10-09T15:00:00Z');          // 11:00 New York
const TODAY = '20261009';

const open = [
  { ticketRef: 10, timestamp: '2026-10-05T14:00:00.000Z', entryDate: '2026-10-05', engine: '45DTE', underlying: 'QQQ',
    strategy: 'QQQ - Iron Condor - 2 contracts', legs: '595 / 600 / 650 / 655', qty: 2, qtyOpen: 2, qtyFilled: 2,
    entryPrice: 1.5, maxRisk: 700, maxProfit: 300, status: 'Open' },
  { ticketRef: 11, timestamp: '2026-10-08T15:00:00.000Z', entryDate: '2026-10-08', engine: '0DTE', underlying: 'SPX',
    strategy: 'SPX - Butterfly - 1 contract', legs: '6700 / 6720 / 6740', qty: 1, qtyOpen: 1, qtyFilled: 1,
    entryPrice: -4.2, maxRisk: 420, maxProfit: 1580, status: 'Open' },
  { ticketRef: 12, timestamp: '2026-10-09T14:30:00.000Z', entryDate: '2026-10-09', engine: '45DTE', underlying: 'IWM',
    strategy: 'IWM - Put Spread - 3 contracts', legs: '230 / 235', qty: 3, qtyOpen: 0, qtyFilled: 0,
    entryPrice: 1.2, limitPrice: 1.2, maxRisk: 1140, maxProfit: 360, status: 'Working' },
];
const decisions = [
  { _rowIndex: 10, Timestamp: '2026-10-05T14:00:00.000Z', Price: '625', IV: '22', Notes: '' },
  { _rowIndex: 11, Timestamp: '2026-10-08T15:00:00.000Z', Price: '6720', VIX1D: '14',
    Notes: 'Legs: +1 6700C 20261008 / -2 6720C 20261008 / +1 6740C 20261008\nEngine says…' },
  { _rowIndex: 12, Timestamp: '2026-10-09T14:30:00.000Z', Price: '240', IV: '24', Notes: '' },
];
const raw = [
  { underlying: 'QQQ', expiry: '20261120', strike: 595, right: 'P', qty: 2 },
  { underlying: 'QQQ', expiry: '20261120', strike: 600, right: 'P', qty: -2 },
  { underlying: 'QQQ', expiry: '20261120', strike: 650, right: 'C', qty: -2 },
  { underlying: 'QQQ', expiry: '20261120', strike: 655, right: 'C', qty: 2 },
  { underlying: 'SPY', expiry: '20261016', strike: 670, right: 'P', qty: -1 },
];

const book = buildBook({ open, decisions, raw, todayYmd: TODAY });
const condor = book.find(p => p.underlying === 'QQQ');
const fly = book.find(p => p.underlying === 'SPX');
const ps = book.find(p => p.underlying === 'IWM');

const quotes = {
  undPrice: 625,
  legs: [0.8, 1.0, 0.9, 0.6].map((m, i) => ({ greeks: { bid: m - 0.02, ask: m + 0.02, iv: 21 + i, delta: [-0.1, -0.15, 0.14, 0.1][i] } })),
  net: { delta: -3, gamma: -0.9, theta: 4.2, vega: -11 },
};

describe('the book', () => {
  it('finds legs in TWS, then in the ticket notes; a working order has none yet', () => {
    expect(condor.legSource).toBe('TWS');
    expect(condor.legs.map(l => l.qty)).toEqual([1, -1, -1, 1]);
    expect(condor.live).toBe(2);
    expect(condor.dte).toBe(42);
    expect(fly.legSource).toBe('ticket');
    expect(fly.legs.map(l => l.qty)).toEqual([1, -2, 1]);
    expect(ps.working).toBe(true);
    expect(ps.live).toBe(0);
    expect(ps.legs).toBe(null);
  });

  it('reconciles with TWS: the SPY leg nobody logged, the 0DTE still open after expiry', () => {
    const rec = reconcile(book, raw, TODAY);
    expect(rec.extra).toEqual([{ underlying: 'SPY', expiry: '20261016', strike: 670, right: 'P', tws: -1, logged: 0 }]);
    expect(rec.missing.map(m => m.p.underlying)).toEqual(['SPX']);
    expect(rec.missing[0].why).toMatch(/Expired 2026-10-08/);
    expect(reconcile(book, null, TODAY)).toBe(null);
  });
});

describe('greeks and P&L', () => {
  it('uses the quotes when they come back: mark, P&L and greeks × contracts', () => {
    const r = positionRisk(condor, quotes, { now: NOW });
    expect(r.markSource).toBe('quotes');
    expect(r.markPS).toBeCloseTo(-0.5, 6);                  // costs 0.50 to buy back
    expect(r.pnl).toBeCloseTo(200, 6);                       // (1.50 − 0.50) × 100 × 2
    expect(r.greeks.theta).toBeCloseTo(8.4, 6);
    expect(r.beta).toBe(1.2);
    expect(r.spxDelta1).toBeCloseTo(-6 * 625 * 0.01 * 1.2, 6);
  });

  it('models the greeks when there are no quotes: a condor is short gamma and collects theta', () => {
    const r = positionRisk(condor, null, { now: NOW, spotHint: 625 });
    expect(r.markSource).toBe('model');
    expect(r.greeks.gamma).toBeLessThan(0);
    expect(r.greeks.theta).toBeGreaterThan(0);
    expect(r.greeks.vega).toBeLessThan(0);
    expect(Math.abs(r.greeks.delta)).toBeLessThan(40);      // near flat at the middle
    const t = totals([r, null]);
    expect(t.n).toBe(1);
    expect(t.modelled).toBe(1);
  });

  it('knows its betas and time', () => {
    expect(betaOf('SPXW')).toBe(1);
    expect(betaOf('ZZZZ')).toBe(1.2);
    expect(yearsToExpiry('20261009', NOW) * 365 * 1440).toBeCloseTo(300, 0);   // 5 hours to the bell
    expect(yearsToExpiry('20261008', NOW)).toBe(0);
    expect(spxDailySd(16)).toBeCloseTo(1.008, 3);
  });
});

describe('stress grid', () => {
  const r = positionRisk(condor, quotes, { now: NOW });
  it('is flat with nothing moving, and loses on big moves for a short-gamma book', () => {
    const g = stressGrid([r], { now: NOW });
    const mid = g.cells[g.moves.indexOf(0)][g.ivShifts.indexOf(0)];
    expect(Math.abs(mid.pnl)).toBeLessThan(1e-6);
    expect(g.cells[0][1].pnl).toBeLessThan(0);              // QQQ −3.6% is through the short put
    expect(g.worst.pnl).toBeLessThan(0);
    expect(g.worst.iv).toBe(5);                              // short vega: worst with IV up
    expect(g.top.key).toBe(condor.key);
  });
  it('one day later the unmoved book has earned its theta', () => {
    const g = stressGrid([r], { now: NOW, horizonDays: 1 });
    expect(g.cells[g.moves.indexOf(0)][1].pnl).toBeGreaterThan(0);
  });
});

describe('risk budget and events', () => {
  it('splits risk into live and working, by expiry and underlying', () => {
    const b = riskBudget(book, { cap: 2000, todayYmd: TODAY });
    expect(b.exp.live).toBe(1120);                           // 700 + 420
    expect(b.exp.working).toBe(1140);
    expect(b.exp.overIfFilled).toBe(true);
    const later = b.buckets.find(x => x.key === 'Later');
    expect(later.live).toBe(700);
    expect(b.underlyings[0].key).toBe('IWM');
    expect(b.concentration.key).toBe('IWM');
  });
  it('lists events before each position is planned to close', () => {
    expect(plannedExit(condor)).toBe('20261030');           // 21 DTE before 20 Nov
    const cal = { events: [
      { date: '2026-10-14', time: '08:30', kind: 'CPI', label: 'CPI' },
      { date: '2026-11-05', time: '14:00', kind: 'FOMC', label: 'FOMC statement' },
    ] };
    const ev = eventsAhead([condor], TODAY, cal);
    expect(ev.map(e => e.kind)).toEqual(['CPI']);
    expect(ev[0].positions).toEqual(['QQQ Iron Condor']);
  });
});

describe('needs attention', () => {
  it('flags the expired ticket, the resting order and a stop that is hit', () => {
    const bad = { ...quotes, legs: [0.3, 2.0, 2.5, 1.0].map(m => ({ greeks: { bid: m, ask: m, iv: 22 } })) };
    const r = positionRisk(condor, bad, { now: NOW });                // costs 3.20 to close: −340
    const items = attention(book, { risks: { [condor.key]: r }, now: NOW, todayYmd: TODAY });
    const titles = items.map(i => i.title);
    expect(titles).toContain('Expired, still open in the log');
    expect(titles).toContain('Order not filled yet');
    expect(titles).toContain('Stop reached');
    expect(items[0].tone).toBe('red');
    expect(items[items.length - 1].tone).toBe('blue');
  });
  it('takes profit at the target and warns before the 21-DTE close', () => {
    const near = { ...condor, key: 'n', expiry: '20261102', dte: 24 };
    const good = { ...quotes, legs: [0.05, 0.2, 0.2, 0.05].map(m => ({ greeks: { bid: m, ask: m, iv: 22 } })) };
    const r = positionRisk(near, good, { now: NOW });                 // 0.30 to close: +240 of 300
    const items = attention([near], { risks: { n: r }, now: NOW, todayYmd: TODAY });
    expect(items.map(i => i.title)).toEqual(['21-DTE close in 3 days', 'Target reached — take profit'])   // amber before green;
  });
});
