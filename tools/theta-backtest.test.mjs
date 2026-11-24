// node --test tools/theta-backtest.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadDay } from './theta/quotes.mjs';
import { forwardAt, creditLegs, flyLegs, runDay, summarise, stats, report } from './theta-backtest.mjs';

const HEAD = 'symbol,expiration,strike,right,timestamp,bid_size,bid_exchange,bid,bid_condition,ask_size,ask_exchange,ask,ask_condition';
// Parity-consistent quotes: C − P = F − K at every strike; time value fades through the day.
function day(date, { F0 = 7300, F1 = 7310, step = 5 } = {}) {
  const rows = [HEAD];
  for (let m = 9 * 60 + 30; m <= 16 * 60; m += 1) {
    const f = (m - 570) / 390, F = F0 + (F1 - F0) * f, s = 30 * Math.sqrt(Math.max(0.02, 1 - f));
    for (let k = 7150; k <= 7450; k += step) {
      const tv = 0.4 * s * Math.exp(-((k - F) ** 2) / (2 * s * s)) + 0.05;
      const c = Math.max(0, F - k) + tv, p = Math.max(0, k - F) + tv;
      const t = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      for (const [r, v] of [['CALL', c], ['PUT', p]]) {
        const bid = Math.max(0, v - 0.05), ask = v + 0.05;
        rows.push(`SPXW,${date},${k}.0,${r},${date}T${t}:00.000-0500,1,5,${bid.toFixed(2)},50,1,5,${ask.toFixed(2)},50`);
      }
    }
  }
  return rows.join('\n');
}
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'bt-'));
  mkdirSync(path.join(dir, '0dte', 'SPXW'), { recursive: true });
  writeFileSync(path.join(dir, '0dte', 'SPXW', '2026-11-17.csv.gz'), gzipSync(day('2026-11-17')));
  return dir;
}

test('forward from put-call parity and the straddle EM', () => {
  const d = loadDay({ dir: fixture(), symbol: 'SPXW', date: '2026-11-17' });
  const f = forwardAt(d, '10:30');
  // F at 10:30 = 7300 + 10 × 60/390 ≈ 7301.54
  assert.ok(Math.abs(f.F - 7301.54) < 0.1, `F ${f.F}`);
  assert.equal(f.atm, 7300);
  assert.ok(f.straddle > 0);
});

test('credit legs sit d × EM out with the fixed width; fly wings on listed strikes', () => {
  const d = loadDay({ dir: fixture(), symbol: 'SPXW', date: '2026-11-17' });
  const put = creditLegs(d, 'put', 7301.5, 20, 1.0, 20);
  assert.deepEqual(put, [{ qty: -1, strike: 7280, right: 'P' }, { qty: 1, strike: 7260, right: 'P' }]);
  const call = creditLegs(d, 'call', 7301.5, 20, 1.0, 20);
  assert.deepEqual(call, [{ qty: -1, strike: 7325, right: 'C' }, { qty: 1, strike: 7345, right: 'C' }]);
  const fly = flyLegs(d, 7301.5, 20, 0.5);
  assert.deepEqual(fly.map(l => l.strike), [7290, 7300, 7310]);
});

test('runDay produces every study × exit × fill and expiry settles on the closing forward', () => {
  const d = loadDay({ dir: fixture(), symbol: 'SPXW', date: '2026-11-17' });
  const { info, rows } = runDay(d, 'SPXW', '10:30');
  assert.ok(Math.abs(info.Fclose - 7309.97) < 0.2, `Fclose ${info.Fclose}`);
  const credit = rows.filter(r => r.study === 'credit'), fly = rows.filter(r => r.study === 'fly');
  assert.equal(credit.length, 2 * 5 * 4 * 2);
  assert.equal(fly.length, 3 * 4 * 2);
  const exp = rows.find(r => r.study === 'credit' && r.side === 'put' && r.param === 1 && r.exit === 'expiry' && r.fill === 'natural');
  // the put spread finishes worthless (F 7310 > short): keep the whole credit
  assert.equal(exp.exitNet, 0);
  assert.equal(exp.pnl, Math.round(exp.entryNet * 10000) / 100);
  assert.ok(credit.every(r => r.entryNet > 0 && r.maxLoss > 0));
  assert.ok(fly.every(r => r.entryNet < 0));
  const t25 = rows.find(r => r.study === 'credit' && r.side === 'put' && r.param === 0.5 && r.exit === 't25' && r.fill === 'mid');
  assert.equal(t25.reason, 'target');
});

test('stats and the summary tables', () => {
  const s = stats([1, -1, 1, 1]);
  assert.equal(s.n, 4); assert.equal(s.mean, 0.5);
  const d = loadDay({ dir: fixture(), symbol: 'SPXW', date: '2026-11-17' });
  const { info, rows } = runDay(d, 'SPXW');
  const sum = summarise(rows, new Map([['SPXW', [info]]]));
  assert.ok(sum.cells.length > 0);
  const md = report(sum, { entry: '10:30', days: 1, from: '2026-11-17', to: '2026-11-17' });
  assert.match(md, /0DTE backtest on ThetaData quotes/);
});

test('chunked runs merge back to the same summary', async () => {
  const { execFileSync } = await import('node:child_process');
  const dir = fixture();
  writeFileSync(path.join(dir, '0dte', 'SPXW', '2026-11-18.csv.gz'), gzipSync(day('2026-11-18', { F0: 7310, F1: 7290 })));
  const run = (...a) => execFileSync('node', ['tools/theta-backtest.mjs', '--dir', dir, '--symbols', 'SPXW', ...a], { encoding: 'utf8' });
  run('--out', path.join(dir, 'whole'));
  run('--to', '2026-11-17', '--out', path.join(dir, 'runs', 'a'));
  run('--from', '2026-11-18', '--out', path.join(dir, 'runs', 'b'));
  run('--from', '2026-11-18', '--out', path.join(dir, 'runs', 'b2'));   // a repeated chunk must not double count
  run('--merge', path.join(dir, 'runs'), '--out', path.join(dir, 'merged'));
  const { readFileSync } = await import('node:fs');
  const a = JSON.parse(readFileSync(path.join(dir, 'whole', 'summary.json'), 'utf8'));
  const b = JSON.parse(readFileSync(path.join(dir, 'merged', 'summary.json'), 'utf8'));
  assert.equal(b.meta.trades, a.meta.trades);
  assert.equal(b.meta.days, 2);
  const pick = s => s.cells.find(c => c.study === 'credit' && c.side === 'put' && c.param === 1 && c.exit === 'expiry' && c.fill === 'natural');
  assert.equal(pick(b).n, 2);
  assert.ok(Math.abs(pick(b).mean - pick(a).mean) < 1e-4);
  const out = run('--budget', '0.001', '--out', path.join(dir, 'budget'));
  assert.match(out, /next 2026-11-1[78]/);
});

test('a close priced outside what the structure can be worth is capped at the bound', () => {
  const dir = fixture();
  // the long put wing stops quoting a sane bid: put spread natural close would cost more than the width
  const txt = day('2026-11-19').split('\n').map(l => {
    const f = l.split(',');
    if (f[2] === '7260.0' && f[3] === 'PUT' && f[4] > '2026-11-19T12') { f[7] = '0.00'; f[11] = '0.05'; }
    if (f[2] === '7280.0' && f[3] === 'PUT' && f[4] > '2026-11-19T12') { f[7] = '0.00'; f[11] = '45.00'; }
    return f.join(',');
  }).join('\n');
  writeFileSync(path.join(dir, '0dte', 'SPXW', '2026-11-19.csv.gz'), gzipSync(txt));
  const d = loadDay({ dir, symbol: 'SPXW', date: '2026-11-19' });
  const { rows } = runDay(d, 'SPXW', '10:30');
  const t = rows.find(r => r.study === 'credit' && r.side === 'put' && r.param === 1 && r.exit === 'time' && r.fill === 'natural');
  assert.equal(t.exitNet, -20);
  assert.match(t.reason, /capped/);
  assert.ok(t.R >= -1 - 1e-9);
  assert.ok(rows.filter(r => r.study === 'fly').every(r => r.R >= -1 - 1e-9));
});
