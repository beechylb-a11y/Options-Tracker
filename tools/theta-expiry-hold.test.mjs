// node --test tools/theta-expiry-hold.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadDay } from './theta/quotes.mjs';
import { candidates, rowsForDay, summarise } from './theta-expiry-hold.mjs';

const HEAD = 'symbol,expiration,strike,right,timestamp,bid_size,bid_exchange,bid,bid_condition,ask_size,ask_exchange,ask,ask_condition';
function day(date, F0 = 7300, F1 = 7310) {
  const rows = [HEAD];
  for (let m = 570; m <= 960; m++) {
    const f = (m - 570) / 390, F = F0 + (F1 - F0) * f, s = 30 * Math.sqrt(Math.max(0.02, 1 - f));
    for (let k = 7150; k <= 7450; k += 5) {
      const tv = 0.4 * s * Math.exp(-((k - F) ** 2) / (2 * s * s)) + 0.05;
      const t = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      for (const [r, v] of [['CALL', Math.max(0, F - k) + tv], ['PUT', Math.max(0, k - F) + tv]])
        rows.push(`SPXW,${date},${k}.0,${r},${date}T${t}:00.000-0500,1,5,${Math.max(0, v - 0.05).toFixed(2)},50,1,5,${(v + 0.05).toFixed(2)},50`);
    }
  }
  return rows.join('\n');
}
const load = () => { const dir = mkdtempSync(path.join(tmpdir(), 'eh-')); mkdirSync(path.join(dir, '0dte', 'SPXW'), { recursive: true }); writeFileSync(path.join(dir, '0dte', 'SPXW', '2026-11-17.csv.gz'), gzipSync(day('2026-11-17'))); return loadDay({ dir, symbol: 'SPXW', date: '2026-11-17' }); };

test('candidates sit 0–3 remaining EMs out, both sides, fixed width', () => {
  const c = candidates(load(), 7308, 10, 20);
  assert.ok(c.length > 0);
  assert.ok(c.every(x => x.z >= 0 && x.z <= 3));
  const p = c.find(x => x.side === 'put' && x.legs[0].strike === 7290);
  assert.deepEqual(p.legs.map(l => l.strike), [7290, 7270]);
});

test('rows: OTM spreads settle at zero; holding beats a paid close by the close cost plus commission', () => {
  const rows = rowsForDay(load(), 'SPXW', ['15:30']);
  assert.ok(rows.length > 0);
  const s = summarise(rows);
  // the fixture drifts up and finishes at 7310: no put spread 0+ EMs out finishes in the money
  const puts = rows.filter(r => r.split(',')[3] === 'put');
  assert.ok(puts.every(r => +r.split(',')[11] === 0));
  assert.ok(s.every(r => r.holdVsNat.m > 0));
});
