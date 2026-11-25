// node --test tools/theta/quotes.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseQuotes, loadDay, combo, replay, parseLegs, clockOf } from './quotes.mjs';

// Header and row shape exactly as the 24 Nov download wrote them (SPXW 2026-11-17).
const HEAD = 'symbol,expiration,strike,right,timestamp,bid_size,bid_exchange,bid,bid_condition,ask_size,ask_exchange,ask,ask_condition';
const row = (k, r, t, bid, ask, exp = '2026-11-17') =>
  `SPXW,${exp},${k}.0,${r},2026-11-17T${t}:00.000-0500,10,5,${bid},50,10,5,${ask},50`;

function fixture() {
  const lines = [HEAD,
    // a call fly 7300/7320/7340, quotes at 10:30, 11:00 and 15:30
    row(7300, 'CALL', '10:30', 30.0, 30.6), row(7320, 'CALL', '10:30', 18.0, 18.4), row(7340, 'CALL', '10:30', 9.8, 10.2),
    row(7300, 'CALL', '11:00', 28.0, 28.6), row(7320, 'CALL', '11:00', 17.0, 17.4), row(7340, 'CALL', '11:00', 9.0, 9.4),
    row(7300, 'CALL', '15:30', 22.0, 22.6), row(7320, 'CALL', '15:30', 4.0, 4.4), row(7340, 'CALL', '15:30', 0.3, 0.5),
    // a put credit spread 7200/7180, and a far wing nobody bids
    row(7200, 'PUT', '10:30', 3.0, 3.2), row(7180, 'PUT', '10:30', 1.9, 2.1),
    row(7200, 'PUT', '15:30', 0.1, 0.15), row(7180, 'PUT', '15:30', 0.0, 0.05),
    // no quote at all: dropped
    row(7400, 'CALL', '10:30', 0.0, 0.0),
  ];
  const dir = mkdtempSync(path.join(tmpdir(), 'theta-'));
  mkdirSync(path.join(dir, '0dte', 'SPXW'), { recursive: true });
  writeFileSync(path.join(dir, '0dte', 'SPXW', '2026-11-17.csv.gz'), gzipSync(lines.join('\n') + '\n'));
  writeFileSync(path.join(dir, '0dte', 'SPXW', '2026-11-27.empty'), 'no data\n');
  mkdirSync(path.join(dir, '45dte', 'SPY'), { recursive: true });
  writeFileSync(path.join(dir, '45dte', 'SPY', '2026-11-17.csv.gz'), gzipSync([HEAD,
    'SPY,2026-12-19,720.0,PUT,2026-11-17T15:45:00.000-0500,5,1,4.10,0,5,1,4.20,0',
    'SPY,2027-01-16,720.0,PUT,2026-11-17T15:45:00.000-0500,5,1,8.00,0,5,1,8.20,0'].join('\n')));
  return dir;
}

test('reads the clock as written, offset and all', () => {
  assert.equal(clockOf('2026-11-17T09:31:00.000-0500'), '09:31');
  assert.equal(clockOf('2026-11-17 15:45:00'), '15:45');
});

test('parses the download format; CALL/PUT and float strikes normalised; empty quotes dropped', () => {
  const dir = fixture();
  const day = loadDay({ dir, symbol: 'SPXW', date: '2026-11-17' });
  assert.deepEqual(day.strikes('2026-11-17', 'C'), [7300, 7320, 7340]);
  assert.deepEqual(day.strikes('2026-11-17', 'P'), [7180, 7200]);
  assert.equal(day.quote({ strike: 7320, right: 'C' }, '10:30').mid, 18.2);
});

test('carries the last quote forward and says how old it is', () => {
  const day = loadDay({ dir: fixture(), symbol: 'SPXW', date: '2026-11-17' });
  const q = day.quote({ strike: 7200, right: 'P' }, '10:34');
  assert.equal(q.bid, 3.0); assert.equal(q.ageMin, 4); assert.equal(q.stale, false);
  assert.equal(day.quote({ strike: 7200, right: 'P' }, '11:00').stale, true);
  assert.equal(day.quote({ strike: 7200, right: 'P' }, '10:00'), null);
});

test('a far wing with no bid prices at zero, not missing', () => {
  const day = loadDay({ dir: fixture(), symbol: 'SPXW', date: '2026-11-17' });
  const q = day.quote({ strike: 7180, right: 'P' }, '15:30');
  assert.equal(q.bid, 0); assert.equal(q.ask, 0.05);
});

test('combo signs: long fly is a debit to open, put credit spread a credit', () => {
  const day = loadDay({ dir: fixture(), symbol: 'SPXW', date: '2026-11-17' });
  const fly = parseLegs('+1 7300C, -2 7320C, +1 7340C');
  const c = combo(day, fly, '10:30');
  // buy 7300 at 30.6, sell 2 × 7320 at 18.0, buy 7340 at 10.2 → −30.6 + 36 − 10.2 = −4.8
  assert.equal(c.open, -4.8);
  assert.equal(c.mark, 3.9);            // 30.3 − 36.4 + 10.0
  assert.equal(c.spread, 1.8);          // 0.6 + 2×0.4 + 0.4
  const pcs = parseLegs('-1 7200P,+1 7180P');
  assert.equal(combo(day, pcs, '10:30').open, 0.9);   // sell 3.0, buy 2.1
});

test('replay: open at the touch, close at the touch, P&L per contract', () => {
  const day = loadDay({ dir: fixture(), symbol: 'SPXW', date: '2026-11-17' });
  const r = replay(day, parseLegs('+1 7300C,-2 7320C,+1 7340C'), { entry: '10:30', exit: '15:30' });
  assert.equal(r.ok, true);
  assert.equal(r.entryNet, -4.8);
  // close: sell 7300 at 22.0, buy back 2 × 7320 at 4.4, sell 7340 at 0.3 → 22 − 8.8 + 0.3 = 13.5
  assert.equal(r.exitNet, 13.5);
  assert.equal(r.pnlPerCt, 870);
  assert.equal(r.exitReason, 'time');
  assert.equal(r.path.at(-1).t, '15:30');
});

test('replay: a profit target ends the walk early on the mark', () => {
  const day = loadDay({ dir: fixture(), symbol: 'SPXW', date: '2026-11-17' });
  const r = replay(day, parseLegs('-1 7200P,+1 7180P'), { entry: '10:30', exit: '15:45', target: 0.5 });
  assert.equal(r.exitReason, 'target');
  assert.equal(r.exitAt, '15:30');
  assert.equal(r.entryNet, 0.9);
  assert.equal(r.exitNet, -0.15);     // buy back 7200 at 0.15, sell 7180 at 0
  assert.equal(r.pnlPerCt, 75);
});

test('replay reports an unpriced leg instead of inventing a price', () => {
  const day = loadDay({ dir: fixture(), symbol: 'SPXW', date: '2026-11-17' });
  const r = replay(day, parseLegs('+1 7300C,-1 7310C'), { entry: '10:30' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /7310C/);
});

test('an .empty day is null; a day not downloaded says so', () => {
  const dir = fixture();
  assert.equal(loadDay({ dir, symbol: 'SPXW', date: '2026-11-27' }), null);
  assert.throws(() => loadDay({ dir, symbol: 'SPXW', date: '2026-11-18' }), /not downloaded/);
});

test('45DTE snapshots: pick the expiry', () => {
  const day = loadDay({ dir: fixture(), kind: '45dte', symbol: 'SPY', date: '2026-11-17' });
  assert.deepEqual(day.expirations(), ['2026-12-19', '2027-01-16']);
  assert.equal(day.quote({ strike: 720, right: 'P' }, '15:45', { exp: '2027-01-16' }).mid, 8.1);
});

test('parseLegs reads the usual spellings and rejects nonsense', () => {
  assert.deepEqual(parseLegs('+1 7300C, -2x7320c'), [{ qty: 1, strike: 7300, right: 'C' }, { qty: -2, strike: 7320, right: 'C' }]);
  assert.throws(() => parseLegs('buy the fly'), /can't read leg/);
});

test('rejects a file whose columns are not the download format', () => {
  assert.throws(() => parseQuotes('a,b,c\n1,2,3'), /unexpected columns/);
});

test('resting target: fills at the limit only when the natural close reaches it', async () => {
  const { replay, parseQuotes, Day } = await import('./quotes.mjs');
  const H = 'symbol,expiration,strike,right,timestamp,bid_size,bid_exchange,bid,bid_condition,ask_size,ask_exchange,ask,ask_condition';
  const row = (k, t, bid, ask) => `SPXW,2026-11-17,${k}.0,PUT,2026-11-17T${t}:00.000-0500,1,5,${bid},50,1,5,${ask},50`;
  // short 7300P / long 7280P. Entry 10:30 natural credit = 3.00 − 1.00 = 2.00; 25% target → close for ≤ 1.50 debit.
  const mk = later => new Day(parseQuotes([H,
    row(7300, '10:30', '3.00', '3.20'), row(7280, '10:30', '0.80', '1.00'),
    ...later.flatMap(([t, s, l]) => [row(7300, t, s[0], s[1]), row(7280, t, l[0], l[1])])].join('\n')), { symbol: 'SPXW', date: '2026-11-17' });
  const legs = [{ qty: -1, strike: 7300, right: 'P' }, { qty: 1, strike: 7280, right: 'P' }];
  // 11:00 mid of the spread = 1.40 (target touched on mid) but natural close = 1.80 − 0.20 = 1.60 debit: no resting fill
  const d1 = mk([['11:00', ['1.00', '1.80'], ['0.20', '0.40']], ['15:45', ['2.00', '2.20'], ['0.50', '0.70']]]);
  const touch = replay(d1, legs, { entry: '10:30', exit: '15:45', target: 0.25 });
  assert.equal(touch.exitReason, 'target');
  const rest = replay(d1, legs, { entry: '10:30', exit: '15:45', target: 0.25, targetFill: 'resting' });
  assert.equal(rest.exitReason, 'time');
  // 11:00 natural close = 1.50 − 0.10 = 1.40 debit ≤ 1.50 limit: filled at the limit, 1.50
  const d2 = mk([['11:00', ['1.30', '1.50'], ['0.10', '0.30']], ['15:45', ['2.00', '2.20'], ['0.50', '0.70']]]);
  const r2 = replay(d2, legs, { entry: '10:30', exit: '15:45', target: 0.25, targetFill: 'resting', tick: 0.05 });
  assert.equal(r2.exitReason, 'target');
  assert.equal(r2.exitNet, -1.5);
  assert.equal(r2.pnlPerCt, 50);
});
