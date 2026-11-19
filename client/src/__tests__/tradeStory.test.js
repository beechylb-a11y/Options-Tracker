/* Story views (Nov 2026): the Trades, Journal and Analytics pictures all read the
   trade log through these helpers. */
import { describe, it, expect } from 'vitest';
import {
  normStrategy, strategyFamily, confOf, storyTrades, equitySeries, maxDrawdown, calibration,
  structureEdge, rHistogram, structureGrid, dailyPnl, dayStats, heatCells, monthPace, weekCards,
  mondayOf, fillTicketRows,
} from '../utils/tradeStory';

const row = (ref, o = {}) => ({
  'Ticket Ref': String(ref), 'Entry Date': '2026-11-16', 'Entry Time': '10:30', Engine: '0DTE', Underlying: 'SPX',
  Strategy: 'SPX - Asymmetric butterfly - 1 contract', Qty: '1', 'Entry Price': '-4.1', 'Max Risk': '410', Confidence: '41/100 Low',
  'Realised P&L': '100', 'R Multiple': '0.24', Status: 'Closed', 'Last Close': '2026-11-16', Account: 'paper', ...o,
});

describe('names', () => {
  it('merges strategy names that differ only by case and spacing', () => {
    expect(normStrategy('Bull Put Spread')).toBe('Bull put spread');
    expect(normStrategy('bull  put spread')).toBe('Bull put spread');
    expect(normStrategy('')).toBe('Unknown');
    // A ticket's Strategy carries the underlying and the size.
    expect(normStrategy('SPX - Bull put spread - 5 contracts')).toBe('Bull put spread');
    expect(normStrategy('QQQ - Iron Condor - Normal - 1 contract')).toBe('Iron condor - normal');
    expect(strategyFamily('QQQ - Iron Condor - Normal - 5 contracts')).toBe('Iron condor');
    expect(strategyFamily('SPX - Long Condor - Reversed - 1 contract')).toBe('Rev condor');
  });
  it('maps strategies to short families', () => {
    expect(strategyFamily('Iron Condor - Normal')).toBe('Iron condor');
    expect(strategyFamily('Asymmetric butterfly')).toBe('Asym fly');
    expect(strategyFamily('Broken Wing Butterfly')).toBe('BWB');
    expect(strategyFamily('Standard butterfly')).toBe('Std fly');
    expect(strategyFamily('Bull put spread')).toBe('Bull put');
    expect(strategyFamily('Chicken condor')).toBe('Chicken condor');
    expect(strategyFamily('Iron fly')).toBe('Iron fly');
  });
  it('reads a confidence score from its label', () => {
    expect(confOf('18/100 Weak')).toBe(18);
    expect(confOf(54)).toBe(54);
    expect(confOf('')).toBe(null);
  });
});

describe('storyTrades', () => {
  const rows = [
    row(73, { 'Last Close': '2026-11-17', 'Realised P&L': '2324.4', 'R Multiple': '1.13', Confidence: '18/100 Weak', Strategy: 'Bull put spread', 'Entry Time': '15:08' }),
    row(66, { 'Last Close': '2026-11-11', 'Realised P&L': '-621.45', 'R Multiple': '', 'Max Risk': '735', Underlying: 'SPY' }),
    row(71, { Status: 'Cancelled' }),
    row(72, { Status: 'Open', 'Realised P&L': '' }),
    row(80, { Account: 'live' }),
  ];
  it('keeps closed tickets for the account, oldest close first, with R worked out when missing', () => {
    const t = storyTrades(rows, 'paper');
    expect(t.map(x => x.ref)).toEqual(['66', '73']);
    expect(t[0].r).toBeCloseTo(-0.85, 2);
    expect(t[1]).toMatchObject({ conf: 18, family: 'Bull put', entryTime: '15:08', pnl: 2324.4 });
  });
  it('drops paper accounts from All accounts, as every page does', () => {
    const t = storyTrades(rows.map(r => ({ ...r, Account: r.Account === 'live' ? 'live' : 'PaperTrade' })), 'all');
    expect(t.map(x => x.ref)).toEqual(['80']);
  });
});

describe('Trades pictures', () => {
  const t = [{ pnl: 100 }, { pnl: -300 }, { pnl: 50 }, { pnl: 400 }].map((x, i) => ({ ref: String(i), ...x }));
  it('runs the equity line and finds the deepest drawdown', () => {
    const s = equitySeries(t);
    expect(s.map(p => p.cum)).toEqual([100, -200, -150, 250]);
    expect(maxDrawdown(s)).toEqual({ dd: -300, from: 0, to: 1 });
  });
});

describe('Journal pictures', () => {
  const t = [
    { ref: '1', closeDate: '2026-11-02', pnl: 100, engine: '0DTE', entryTime: '10:00' },
    { ref: '2', closeDate: '2026-11-03', pnl: 50, engine: '0DTE', entryTime: '11:59' },
    { ref: '3', closeDate: '2026-11-04', pnl: -80, engine: '0DTE', entryTime: '12:05' },
    { ref: '4', closeDate: '2026-11-05', pnl: 30, engine: '45DTE', entryTime: '14:00' },
    { ref: '5', closeDate: '2026-11-05', pnl: 20, engine: '0DTE', entryTime: '09:45' },
    { ref: '6', closeDate: '2026-11-10', pnl: 200, engine: '0DTE', entryTime: '15:08' },
  ];
  it('sums P&L by close day and finds best, worst and the green streak', () => {
    const d = dailyPnl(t);
    expect(d['2026-11-05']).toBe(50);
    const s = dayStats(d);
    expect(s.best).toMatchObject({ date: '2026-11-10', pnl: 200, label: '10 Nov' });
    expect(s.worst).toMatchObject({ date: '2026-11-04', pnl: -80 });
    expect(s).toMatchObject({ green: 4, days: 5 });
    expect(s.streak).toMatchObject({ n: 2, from: '2026-11-02' });
  });
  it('lays weekdays out in week columns with month labels', () => {
    const h = heatCells({ '2026-11-02': 5 }, '2026-10-29', '2026-11-04');
    expect(h.cells.map(c => c.date)).toEqual(['2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03', '2026-11-04']);
    expect(h.cells[2]).toMatchObject({ col: 1, row: 0, pnl: 5 });
    expect(h.months).toEqual([{ col: 0, label: 'Oct' }, { col: 1, label: 'Nov' }]);
    expect(h.cols).toBe(2);
  });
  it('paces the month against its target and projects month end', () => {
    const p = monthPace(dailyPnl(t), '2026-11', 3087, '2026-11-15');
    expect(p.total).toBe(320);
    expect(p.gap).toBe(2767);
    expect(p.projected).toBe(640);                  // 320 over 15 days → 30 days
    expect(p.points.length).toBe(15);
  });
  it('builds week cards with the entry-by-12:00 rule from 0DTE ticket times', () => {
    expect(mondayOf('2026-11-05')).toBe('2026-11-02');
    const w = weekCards(t);
    expect(w[0]).toMatchObject({ monday: '2026-11-09', total: 200, early: { kept: 0, of: 1 } });
    expect(w[1]).toMatchObject({ monday: '2026-11-02', total: 120, early: { kept: 3, of: 4 }, label: '2–6 Nov' });
    expect(w[1].late.map(x => x.ref)).toEqual(['3']);
    expect(w[1].trades[0].ref).toBe('1');           // biggest first
  });
});

describe('Analytics pictures', () => {
  const t = [
    { family: 'Asym fly', und: 'SPX', pnl: 100, r: 0.2, conf: 45 },
    { family: 'Asym fly', und: 'SPY', pnl: 60, r: 0.1, conf: 41 },
    { family: 'Asym fly', und: 'SPY', pnl: -620, r: -0.85, conf: 44 },
    { family: 'Bull put', und: 'SPX', pnl: 2324, r: 1.13, conf: 18 },
    { family: 'Bull put', und: 'QQQ', pnl: 7, r: 0, conf: 16 },
    { family: 'Iron condor', und: 'QQQ', pnl: -1588, r: -0.53, conf: null },
  ];
  it('splits each structure into what it wins and loses per trade', () => {
    const e = structureEdge(t, 2);
    expect(e.map(x => x.name)).toEqual(['Bull put', 'Asym fly']);   // Iron condor has one trade
    const fly = e.find(x => x.name === 'Asym fly');
    expect(fly.winPart).toBeCloseTo(160 / 3, 5);
    expect(fly.lossPart).toBeCloseTo(-620 / 3, 5);
    expect(fly.expectancy).toBeCloseTo(-460 / 3, 5);
    expect(fly.avgWin).toBe(80);
  });
  it('bands confidence and averages R in each band', () => {
    const c = calibration(t);
    expect(c[0]).toMatchObject({ label: '0–24', n: 2, win: 0.5 });
    expect(c[0].avgR).toBeCloseTo(0.565, 5);
    expect(c[2]).toMatchObject({ label: '40–49', n: 3 });
    expect(c[3].n).toBe(0);
  });
  it('bins R with the ends caught', () => {
    const h = rHistogram([...t, { r: -1.4 }, { r: 3 }]);
    expect(h[0].n).toBe(2);                         // −0.85 and −1.4
    expect(h[h.length - 1].n).toBe(2);              // 1.13 and 3
    expect(h.find(b => b.lo === 0).n).toBe(3);      // 0.2, 0.1 and 0
  });
  it('totals structure × underlying cells', () => {
    const g = structureGrid(t);
    expect(g.rows[0]).toBe('Asym fly');
    expect(g.cell('Asym fly', 'SPY')).toEqual({ total: -560, n: 2 });
    expect(g.cell('Iron condor', 'SPX')).toBe(null);
  });
});

describe('fillTicketRows', () => {
  const log = [row(73, { 'Entry Price': '9.67', 'Avg Entry': '9.7', Qty: '5' }), row(62, { Engine: '45DTE', 'Entry Price': '1.86', Qty: '5' })];
  it('fills credit and 0DTE expiry on engine tracker rows that have none', () => {
    const out = fillTicketRows([
      { 'Order #': 'TICKET-73', Qty: '5', 'Net Credit ($)': null, 'Expiry Date': null },
      { 'Order #': 'TICKET-62', Qty: '2', 'Net Credit ($)': '', 'Expiry Date': '' },
      { 'Order #': 'TICKET-99', Qty: '1' },
      { 'Order #': '12345', 'Net Credit ($)': '120' },
      { 'Order #': 'TICKET-73', 'Net Credit ($)': '300' },
    ], log);
    expect(out[0]).toMatchObject({ 'Net Credit ($)': '4850', 'Expiry Date': '2026-11-16' });
    expect(out[1]['Net Credit ($)']).toBe('372');      // the row's own 2 contracts
    expect(out[1]['Expiry Date']).toBe('');             // a 45DTE expiry is not guessed
    expect(out[2]).toEqual({ 'Order #': 'TICKET-99', Qty: '1' });
    expect(out[3]['Net Credit ($)']).toBe('120');
    expect(out[4]['Net Credit ($)']).toBe('300');      // a recorded value is kept
  });
});
