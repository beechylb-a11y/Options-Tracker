#!/usr/bin/env node
/**
 * theta-expiry-hold.mjs — close at the time exit or let it expire? (Nov 2026)
 *
 * For cash-settled 0DTE (SPXW, XSP): at each check time (default 15:00 and 15:30 ET),
 * every short vertical whose short strike sits 0–3 remaining-EMs out of the money is
 * either closed there (natural or mid, + $0.65 a leg) or held to the 16:00 settlement
 * (intrinsic at the closing forward, no commission: IBKR charges none on exercise or
 * assignment). One row per spread per check:
 *   z = (F − K) / EMrem  for puts (K − F for calls)   EMrem = 0.85 × ATM straddle at the check
 * Appends to <out>/rows-<shard>.csv; a day already written is skipped, so runs resume.
 *
 *   node tools/theta-expiry-hold.mjs --dir ~/…/thetadata --symbols SPXW,XSP --out DIR
 *        [--times 15:00,15:30] [--shard 0 --shards 4] [--budget 160]
 *   node tools/theta-expiry-hold.mjs --summary DIR      → DIR/summary.csv + table on stdout
 */
import { readdirSync, readFileSync, appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadDay, combo, toMin, DEFAULT_DIR } from './theta/quotes.mjs';
import { forwardAt } from './theta-backtest.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i < 0 ? d : (args[i + 1] ?? true); };
export const WIDTH = { SPXW: 20, XSP: 2 };
export const COMM_LEG = 0.65;
const EM_FACTOR = 0.85;
const intrinsic = (l, S) => (l.right === 'C' ? Math.max(0, S - l.strike) : Math.max(0, l.strike - S));
const HEAD = 'symbol,date,time,side,short,long,F,emRem,z,closeNat,closeMid,settle,Fclose';

/** Every candidate spread at one check: [{side, legs, z}] */
export function candidates(day, F, emRem, width, zMax = 3) {
  const out = [];
  for (const [side, right] of [['put', 'P'], ['call', 'C']]) {
    const ks = day.strikes(day.date, right);
    for (const k of ks) {
      const z = side === 'put' ? (F - k) / emRem : (k - F) / emRem;
      if (z < 0 || z > zMax) continue;
      const lk = side === 'put' ? k - width : k + width;
      if (!ks.includes(lk)) continue;
      out.push({ side, z, legs: [{ qty: -1, strike: k, right }, { qty: 1, strike: lk, right }] });
    }
  }
  return out;
}

/** Rows for one day: per check time × candidate spread. */
export function rowsForDay(day, symbol, times) {
  const close = forwardAt(day, '15:59') || forwardAt(day, '15:58') || forwardAt(day, '15:55');
  if (!close) return [];
  const rows = [];
  for (const t of times) {
    const f = forwardAt(day, t);
    if (!f || !(f.straddle > 0)) continue;
    const emRem = EM_FACTOR * f.straddle;
    for (const c of candidates(day, f.F, emRem, WIDTH[symbol] ?? 2)) {
      const q = combo(day, c.legs, toMin(t));
      if (!q.ok || q.stale.length) continue;
      const w = Math.abs(c.legs[0].strike - c.legs[1].strike);
      // A close priced past the width is a broken quote on a dead wing; cap it there.
      const closeNat = Math.max(-w, Math.min(0, q.close)), closeMid = Math.max(-w, Math.min(0, q.mark));
      const settle = c.legs.reduce((s, l) => s + l.qty * intrinsic(l, close.F), 0);
      rows.push([symbol, day.date, t, c.side, c.legs[0].strike, c.legs[1].strike, f.F.toFixed(2), emRem.toFixed(3), c.z.toFixed(3), closeNat.toFixed(2), closeMid.toFixed(3), settle.toFixed(2), close.F.toFixed(2)].join(','));
    }
  }
  return rows;
}

const BUCKETS = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3.01];
const bucketOf = z => { for (let i = BUCKETS.length - 2; i >= 0; i--) if (z >= BUCKETS[i]) return `${BUCKETS[i]}–${Math.min(3, BUCKETS[i + 1]).toFixed(2).replace(/\.?0+$/, '')}`; return '0'; };

/** Per symbol × time × bucket: what holding gains over closing, $ per spread. */
export function summarise(lines) {
  const g = new Map();
  for (const line of lines) {
    const [symbol, , time, side, , , , , z, closeNat, closeMid, settle] = line.split(',');
    const key = `${symbol}|${time}|${bucketOf(+z)}`;
    if (!g.has(key)) g.set(key, { symbol, time, bucket: bucketOf(+z), lo: +bucketOf(+z).split('–')[0], n: 0, nat: [], mid: [], itm: 0, maxLossHit: 0, worst: 0, sides: { put: 0, call: 0 } });
    const c = g.get(key);
    const comm = 2 * COMM_LEG;
    const vsNat = (+settle - +closeNat) * 100 + comm, vsMid = (+settle - +closeMid) * 100 + comm;
    c.n++; c.nat.push(vsNat); c.mid.push(vsMid); c.sides[side]++;
    if (+settle < 0) c.itm++;
    c.worst = Math.min(c.worst, vsNat);
  }
  const st = xs => { const n = xs.length, m = xs.reduce((a, b) => a + b, 0) / n; const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, n - 1)); return { m, t: sd ? m / (sd / Math.sqrt(n)) : 0 }; };
  return [...g.values()].map(c => ({ symbol: c.symbol, time: c.time, bucket: c.bucket, lo: c.lo, n: c.n, holdVsNat: st(c.nat), holdVsMid: st(c.mid), pItm: c.itm / c.n, worst: c.worst }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.time.localeCompare(b.time) || a.lo - b.lo);
}

function main() {
  const sumDir = flag('summary', null);
  if (sumDir) {
    const files = readdirSync(sumDir).filter(f => /^rows-\d+\.csv$/.test(f));
    const lines = files.flatMap(f => readFileSync(path.join(sumDir, f), 'utf8').trim().split('\n').filter(l => l && !l.startsWith('symbol')));
    const s = summarise(lines);
    writeFileSync(path.join(sumDir, 'summary.csv'), 'symbol,time,z_bucket,n,hold_minus_close_nat_usd,t_nat,hold_minus_close_mid_usd,t_mid,p_finish_itm,worst_usd\n' +
      s.map(r => [r.symbol, r.time, r.bucket, r.n, r.holdVsNat.m.toFixed(2), r.holdVsNat.t.toFixed(1), r.holdVsMid.m.toFixed(2), r.holdVsMid.t.toFixed(1), r.pItm.toFixed(4), r.worst.toFixed(0)].join(',')).join('\n') + '\n');
    for (const r of s) console.log(`${r.symbol} ${r.time} z ${r.bucket.padEnd(9)} n ${String(r.n).padStart(6)}  hold−close(nat) ${r.holdVsNat.m.toFixed(2).padStart(7)} (t ${r.holdVsNat.t.toFixed(1)})  vs mid ${r.holdVsMid.m.toFixed(2).padStart(7)} (t ${r.holdVsMid.t.toFixed(1)})  ITM ${(r.pItm * 100).toFixed(2)}%  worst ${r.worst.toFixed(0)}`);
    console.log(`lines ${lines.length}`);
    return;
  }
  const DIR = flag('dir', DEFAULT_DIR), OUT = flag('out', path.join(DIR, 'results', 'expiry-hold'));
  const SYMBOLS = String(flag('symbols', 'SPXW,XSP')).split(',');
  const TIMES = String(flag('times', '15:00,15:30')).split(',');
  const SHARD = +flag('shard', 0), SHARDS = +flag('shards', 1), BUDGET = +flag('budget', 0);
  mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `rows-${SHARD}.csv`);
  const done = new Set();
  if (existsSync(file)) for (const l of readFileSync(file, 'utf8').split('\n')) { const p = l.split(','); if (p[1]) done.add(`${p[0]}|${p[1]}`); }
  else appendFileSync(file, HEAD + '\n');
  const doneDays = path.join(OUT, `done-${SHARD}.txt`);
  if (existsSync(doneDays)) for (const l of readFileSync(doneDays, 'utf8').split('\n')) if (l) done.add(l);
  const t0 = Date.now(); let n = 0, left = 0;
  for (const symbol of SYMBOLS) {
    const dates = readdirSync(path.join(DIR, '0dte', symbol)).filter(f => f.endsWith('.csv.gz')).map(f => f.slice(0, 10)).sort().filter((_, i) => i % SHARDS === SHARD);
    for (const date of dates) {
      if (done.has(`${symbol}|${date}`)) continue;
      if (BUDGET && (Date.now() - t0) / 1000 > BUDGET) { left++; continue; }
      let day; try { day = loadDay({ dir: DIR, kind: '0dte', symbol, date }); } catch { day = null; }
      const rows = day ? rowsForDay(day, symbol, TIMES) : [];
      if (rows.length) appendFileSync(file, rows.join('\n') + '\n');
      appendFileSync(doneDays, `${symbol}|${date}\n`);
      n++;
    }
  }
  console.log(`shard ${SHARD}: ${n} days in ${Math.round((Date.now() - t0) / 1000)} s · ${left} left`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) main();
