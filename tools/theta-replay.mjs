#!/usr/bin/env node
/**
 * theta-replay.mjs — replay one structure on one day from real ThetaData quotes.
 *
 *   node tools/theta-replay.mjs --symbol SPXW --date 2026-11-17 --legs "+1 7300C,-2 7320C,+1 7340C" --entry 10:30 --exit 15:30
 *   node tools/theta-replay.mjs --symbol XSP --date 2026-11-17 --legs "-1 720P,+1 718P" --entry 10:30 --target 0.5 --stop 1
 *   node tools/theta-replay.mjs --symbol SPXW --date 2026-11-17 --strikes      # what was quoted that day
 *
 * Flags: --dir (default ~/Options-Tracker/data/thetadata) --kind 0dte|45dte --exp YYYY-MM-DD (45dte)
 *        --fill natural|mid (default natural) --target / --stop as a share of the entry premium
 *        --every N (path rows every N minutes, default 30)
 * Data: tools/theta/theta_download.py. Library: tools/theta/quotes.mjs.
 */
import { loadDay, replay, parseLegs, combo, DEFAULT_DIR, toMin, fromMin } from './theta/quotes.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i < 0 ? d : (args[i + 1] ?? true); };
const has = n => args.includes(`--${n}`);

const symbol = String(flag('symbol', 'SPXW')).toUpperCase();
const date = flag('date');
const kind = flag('kind', '0dte');
const dir = flag('dir', DEFAULT_DIR);
const exp = flag('exp', kind === '0dte' ? date : undefined);
if (!date) { console.error('need --date YYYY-MM-DD'); process.exit(1); }

const day = loadDay({ dir, kind, symbol, date });
if (!day) { console.log(`${symbol} ${date}: ThetaData had no data (holiday or before history).`); process.exit(0); }

if (has('strikes')) {
  for (const e of day.expirations()) {
    const c = day.strikes(e, 'C'), p = day.strikes(e, 'P');
    const span = ks => ks.length ? `${ks[0]}–${ks.at(-1)} (${ks.length})` : 'none';
    console.log(`${e}: calls ${span(c)}, puts ${span(p)}`);
  }
  const mins = day.minutes();
  console.log(mins.length ? `quotes from ${fromMin(mins[0])} to ${fromMin(mins.at(-1))} ET` : 'no quotes');
  process.exit(0);
}

const legs = parseLegs(flag('legs'));
const num = v => (v == null || v === true ? null : Number(v));
const res = replay(day, legs, {
  entry: flag('entry', '10:00'), exit: flag('exit', '15:45'), fill: flag('fill', 'natural'),
  target: num(flag('target')), stop: num(flag('stop')), exp,
});
if (!res.ok) { console.error(res.reason); process.exit(1); }

const money = x => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(2);
console.log(`${symbol} ${date} · ${legs.map(l => `${l.qty > 0 ? '+' : ''}${l.qty} ${l.strike}${l.right}`).join(', ')}`);
const e = combo(day, legs, toMin(res.entryAt), { exp });
console.log(`entry ${res.entryAt}: ${money(res.entryNet)} (${res.entryNet >= 0 ? 'credit' : 'debit'}) · mid ${money(-e.mark)} · spread ${res.entrySpread.toFixed(2)}`);
const every = Number(flag('every', 30));
let last = -Infinity;
for (const p of res.path) {
  const m = toMin(p.t);
  if (m - last >= every || p === res.path.at(-1)) { console.log(`  ${p.t}  mark ${p.mark.toFixed(2).padStart(8)}  P&L ${money(p.pnl).padStart(8)} /sh`); last = m; }
}
console.log(`exit ${res.exitAt} (${res.exitReason}): ${money(res.exitNet)}${res.exitStaleLegs ? ` · ${res.exitStaleLegs} leg(s) on a stale quote` : ''}`);
console.log(`P&L per contract ${money(res.pnlPerCt)} · best ${money(res.mfe * 100)} · worst ${money(res.mae * 100)} (mid marks, per contract)`);
