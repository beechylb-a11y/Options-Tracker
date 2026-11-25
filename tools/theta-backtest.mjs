#!/usr/bin/env node
/**
 * theta-backtest.mjs — 0DTE backtest on real ThetaData quotes (Nov 2026).
 *
 * Two studies, every 0DTE expiry day in the download, entry at 10:30 ET:
 *   credit  short put / call vertical, short strike d × EM from the forward, fixed width
 *           (SPXW 20, XSP/SPY/QQQ 2, IWM 1 — the learn grid's widths),
 *           d ∈ {0.5, 0.75, 1.0, 1.25, 1.5}
 *   fly     long call butterfly, body at the forward, wings w × EM, w ∈ {0.5, 0.75, 1.0}
 * Exits: profit target 25% / 50% of the premium (judged on the mid mark, closed at the
 * touch that minute), the time exit (15:30 cash-settled SPXW/XSP, 15:45 SPY/QQQ/IWM —
 * the trading rules), or held to expiry (intrinsic at the 16:00 forward). No stops: stops
 * aren't sent (MASTER-SESSION hard rules). Fills: natural (cross the spread both ways) and mid.
 *
 * Everything comes from the option quotes themselves:
 *   forward F  = K + C − P at the strike where |C − P| is smallest (put-call parity)
 *   EM         = 0.85 × the ATM straddle at entry — the engine's IVX EM
 *
 *   node tools/theta-backtest.mjs [--dir ~/Options-Tracker/data/thetadata] [--out DIR]
 *        [--symbols SPXW,XSP,SPY,QQQ,IWM] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--entry 10:30]
 *        [--budget SECONDS]   stop cleanly after this long and print `next <date>` to resume from
 *   node tools/theta-backtest.mjs --merge runs/ --out results/   summarise every chunk under runs/
 * Writes trades.csv, days.csv, summary.json and summary.md to --out (default <dir>/results/<date>).
 */
import { readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { loadDay, combo, replay, toMin, fromMin, DEFAULT_DIR } from './theta/quotes.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i < 0 ? d : (args[i + 1] ?? true); };
const DIR = flag('dir', DEFAULT_DIR);
const SYMBOLS = String(flag('symbols', 'SPXW,XSP,SPY,QQQ,IWM')).split(',').map(s => s.trim().toUpperCase());
const FROM = flag('from', '0000-00-00'), TO = flag('to', '9999-99-99');
const ENTRY = flag('entry', '10:30');
const OUT = flag('out', path.join(DIR, 'results', new Date().toISOString().slice(0, 10)));
const BUDGET = Number(flag('budget', 0)) || 0;     // seconds; stop cleanly and print the next date to resume from
const MERGE = flag('merge', null);                 // summarise the trades.csv / days.csv under these folders instead of running

export const WIDTH = { SPXW: 20, XSP: 2, SPY: 2, QQQ: 2, IWM: 1 };
export const TIME_EXIT = { SPXW: '15:30', XSP: '15:30', SPY: '15:45', QQQ: '15:45', IWM: '15:45' };
export const DIST = [0.5, 0.75, 1.0, 1.25, 1.5];
export const WINGS = [0.5, 0.75, 1.0];
// t25 / t50: closed on the minute the mid touches the target, at natural or mid.
// t25r / t50r: the app's resting limit at the target (fills only when the natural reaches it).
export const EXITS = ['t25', 't50', 't25r', 't50r', 'time', 'expiry'];
export const TICK = { SPXW: 0.05 };
const EM_FACTOR = 0.85;

/** Forward and ATM straddle at minute t from put-call parity. null when no strike has both sides. */
export function forwardAt(day, t, exp = day.date) {
  const calls = new Set(day.strikes(exp, 'C'));
  let best = null;
  for (const k of day.strikes(exp, 'P')) {
    if (!calls.has(k)) continue;
    const c = day.quote({ strike: k, right: 'C' }, t, { exp }), p = day.quote({ strike: k, right: 'P' }, t, { exp });
    if (!c || !p || c.stale || p.stale || !(c.ask > 0) || !(p.ask > 0)) continue;
    const gap = Math.abs(c.mid - p.mid);
    if (!best || gap < best.gap) best = { k, gap, c: c.mid, p: p.mid };
  }
  if (!best) return null;
  return { F: best.k + best.c - best.p, atm: best.k, straddle: best.c + best.p };
}

const below = (ks, x) => { let r = null; for (const k of ks) if (k <= x + 1e-9) r = k; return r; };
const above = (ks, x) => { for (const k of ks) if (k >= x - 1e-9) return k; return null; };
const nearest = (ks, x) => ks.reduce((a, k) => (a == null || Math.abs(k - x) < Math.abs(a - x) ? k : a), null);
const intrinsic = (l, S) => (l.right === 'C' ? Math.max(0, S - l.strike) : Math.max(0, l.strike - S));

/** Legs for a credit vertical d × EM out, or null with no listed strikes there. */
export function creditLegs(day, side, F, em, d, width) {
  const right = side === 'put' ? 'P' : 'C';
  const ks = day.strikes(day.date, right);
  if (side === 'put') {
    const s = below(ks, F - d * em); if (s == null) return null;
    const l = ks.includes(s - width) ? s - width : below(ks, s - width); if (l == null || l >= s) return null;
    return [{ qty: -1, strike: s, right }, { qty: 1, strike: l, right }];
  }
  const s = above(ks, F + d * em); if (s == null) return null;
  const l = ks.includes(s + width) ? s + width : above(ks, s + width); if (l == null || l <= s) return null;
  return [{ qty: -1, strike: s, right }, { qty: 1, strike: l, right }];
}

/** Long call fly, body nearest F, wings w × EM rounded onto listed strikes (at least one step). */
export function flyLegs(day, F, em, w) {
  const ks = day.strikes(day.date, 'C');
  const body = nearest(ks, F); if (body == null) return null;
  const step = Math.min(...ks.slice(1).map((k, i) => k - ks[i]).filter(x => x > 0));
  const wing = Math.max(step, Math.round((w * em) / step) * step);
  if (!ks.includes(body - wing) || !ks.includes(body + wing)) return null;
  return [{ qty: 1, strike: body - wing, right: 'C' }, { qty: -2, strike: body, right: 'C' }, { qty: 1, strike: body + wing, right: 'C' }];
}

/** One structure, every exit and fill: trade rows. */
export function runStructure(day, legs, { study, side, param, maxLossOf, timeExit, Fclose, entry, bounds = null, tick = 0.01 }) {
  const rows = [];
  for (const fill of ['natural', 'mid']) {
    for (const exit of EXITS) {
      let r;
      if (exit === 'expiry') {
        const e = combo(day, legs, toMin(entry));
        if (!e.ok || Fclose == null) continue;
        const entryNet = fill === 'mid' ? -e.mark : e.open;
        const settle = legs.reduce((s, l) => s + l.qty * intrinsic(l, Fclose), 0);
        r = { ok: true, entryNet, exitNet: settle, pnlPerCt: Math.round((entryNet + settle) * 10000) / 100, exitReason: 'expiry', exitAt: '16:00' };
      } else {
        const target = exit.startsWith('t25') ? 0.25 : exit.startsWith('t50') ? 0.5 : null;
        r = replay(day, legs, { entry, exit: timeExit, fill, target, targetFill: exit.endsWith('r') ? 'resting' : 'touch', tick });
        if (!r.ok) continue;
        // A close can't cost more than the structure can ever be worth (a vertical's width, a fly's
        // zero floor): a price outside that is a broken quote on a dead wing, and holding to expiry
        // would never be worse. Cap it at the bound and mark the trade.
        if (bounds && (r.exitNet < bounds[0] - 1e-9 || r.exitNet > bounds[1] + 1e-9)) {
          const exitNet = Math.min(bounds[1], Math.max(bounds[0], r.exitNet));
          r = { ...r, exitNet, pnlPerCt: Math.round((r.entryNet + exitNet) * 10000) / 100, exitReason: `${r.exitReason} capped` };
        }
      }
      const maxLoss = maxLossOf(r.entryNet);
      if (!(maxLoss > 0)) continue;
      rows.push({ study, side, param, exit, fill, entryNet: r.entryNet, exitNet: r.exitNet, exitAt: r.exitAt, reason: r.exitReason,
        pnl: r.pnlPerCt, maxLoss: Math.round(maxLoss * 10000) / 100, R: r.pnlPerCt / (maxLoss * 100) });
    }
  }
  return rows;
}

/** Every trade for one symbol on one day. */
export function runDay(day, symbol, entry = ENTRY) {
  const f0 = forwardAt(day, entry);
  if (!f0 || !(f0.straddle > 0)) return { info: null, rows: [] };
  const em = EM_FACTOR * f0.straddle;
  const close = forwardAt(day, '15:59') || forwardAt(day, '15:58') || forwardAt(day, '15:55');
  const info = { date: day.date, F: f0.F, em, emPct: em / f0.F, Fclose: close ? close.F : null };
  const width = WIDTH[symbol] ?? 2, timeExit = TIME_EXIT[symbol] ?? '15:45';
  const rows = [];
  for (const side of ['put', 'call']) {
    for (const d of DIST) {
      const legs = creditLegs(day, side, f0.F, em, d, width);
      if (!legs) continue;
      const w = Math.abs(legs[0].strike - legs[1].strike);
      rows.push(...runStructure(day, legs, { study: 'credit', side, param: d, timeExit, entry, Fclose: info.Fclose, bounds: [-w, 0], tick: TICK[symbol] ?? 0.01,
        maxLossOf: entryNet => (entryNet > 0 ? w - entryNet : null) }));
    }
  }
  for (const w of WINGS) {
    const legs = flyLegs(day, f0.F, em, w);
    if (!legs) continue;
    const wing = legs[1].strike - legs[0].strike;
    rows.push(...runStructure(day, legs, { study: 'fly', side: 'call', param: w, timeExit, entry, Fclose: info.Fclose, bounds: [0, wing], tick: TICK[symbol] ?? 0.01,
      maxLossOf: entryNet => (entryNet < 0 ? -entryNet : null) }));
  }
  return { info, rows: rows.map(r => ({ symbol, date: day.date, ...r })) };
}

// ---- statistics ----
export function stats(xs) {
  const n = xs.length;
  if (!n) return { n: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const se = n > 1 ? sd / Math.sqrt(n) : 0;
  return { n, mean, sd, se, lo: mean - 1.96 * se, hi: mean + 1.96 * se, t: se > 0 ? mean / se : 0 };
}
const keyOf = r => `${r.symbol}|${r.study}|${r.side}|${r.param}|${r.exit}|${r.fill}`;

export function summarise(rows, infos) {
  // regime: 10:30 forward vs about 5 sessions (7 calendar days) earlier
  const reg = new Map();
  for (const [sym, list] of infos) {
    const sorted = [...list].sort((a, b) => (a.date < b.date ? -1 : 1));
    for (let i = 0; i < sorted.length; i++) {
      const t = Date.parse(sorted[i].date), back = sorted.slice(0, i).reverse().find(x => t - Date.parse(x.date) >= 7 * 864e5);
      const r5 = back ? sorted[i].F / back.F - 1 : null;
      reg.set(`${sym}|${sorted[i].date}`, r5 == null ? 'n/a' : r5 < -0.02 ? 'down >2%' : r5 > 0.02 ? 'up >2%' : 'flat');
    }
  }
  const dates = [...new Set(rows.map(r => r.date))].sort();
  const cut = dates[Math.floor(dates.length * 2 / 3)] || '9999';
  const cells = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (!cells.has(k)) cells.set(k, { symbol: r.symbol, study: r.study, side: r.side, param: r.param, exit: r.exit, fill: r.fill, R: [], pnl: [], win: 0, ins: [], oos: [], years: {}, regimes: {} });
    const c = cells.get(k);
    c.R.push(r.R); c.pnl.push(r.pnl); if (r.pnl > 0) c.win++;
    (r.date < cut ? c.ins : c.oos).push(r.R);
    const y = r.date.slice(0, 4); (c.years[y] ||= []).push(r.R);
    const g = reg.get(`${r.symbol}|${r.date}`) || 'n/a'; (c.regimes[g] ||= []).push(r.R);
  }
  const out = [...cells.values()].map(c => ({
    symbol: c.symbol, study: c.study, side: c.side, param: c.param, exit: c.exit, fill: c.fill,
    ...stats(c.R), winRate: c.win / c.R.length, meanPnl: c.pnl.reduce((a, b) => a + b, 0) / c.pnl.length, worstPnl: Math.min(...c.pnl),
    ins: stats(c.ins), oos: stats(c.oos),
    years: Object.fromEntries(Object.entries(c.years).map(([y, v]) => [y, stats(v)])),
    regimes: Object.fromEntries(Object.entries(c.regimes).map(([g, v]) => [g, stats(v)])),
  }));
  return { cut, cells: out };
}

// ---- report ----
const f2 = x => (x == null || !Number.isFinite(x) ? '–' : (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(2));
const pc = x => (x * 100).toFixed(0) + '%';
export function report(sum, meta) {
  const L = [];
  const nat = sum.cells.filter(c => c.fill === 'natural' && c.n >= 30);
  const trialsPer = DIST.length * 2 * EXITS.length;
  L.push(`# 0DTE backtest on ThetaData quotes`, '', `Entry ${meta.entry} ET · ${meta.days} symbol-days · ${meta.from} to ${meta.to} · in-sample before ${sum.cut}, out-of-sample from it`, '');
  L.push(`Credit spreads: ${trialsPer} variants per symbol (2 sides × ${DIST.length} distances × ${EXITS.length} exits). One-sided Bonferroni bar at 5%: t ≥ ${trialsPer >= 40 ? '3.0' : '2.7'}.`, '');
  for (const study of ['credit', 'fly']) {
    L.push(`## ${study === 'credit' ? 'Credit spreads' : 'Long call butterflies'} (natural fills, R = P&L ÷ max loss)`, '');
    L.push('| Symbol | Side | ' + (study === 'credit' ? 'Short at' : 'Wings') + ' | Exit | n | Win | Mean R | 95% range | t | Mean $/ct | Worst $/ct | OOS mean R (n) |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const c of nat.filter(x => x.study === study).sort((a, b) => a.symbol.localeCompare(b.symbol) || a.side.localeCompare(b.side) || a.param - b.param || EXITS.indexOf(a.exit) - EXITS.indexOf(b.exit))) {
      L.push(`| ${c.symbol} | ${c.side} | ${c.param}×EM | ${c.exit} | ${c.n} | ${pc(c.winRate)} | ${f2(c.mean)} | ${f2(c.lo)} to ${f2(c.hi)} | ${c.t.toFixed(1)} | ${f2(c.meanPnl)} | ${f2(c.worstPnl)} | ${f2(c.oos.mean)} (${c.oos.n}) |`);
    }
    L.push('');
  }
  L.push('## Walk-forward check: best in-sample cell per symbol and study, then its out-of-sample result', '');
  L.push('| Symbol | Study | Picked in-sample | IS mean R | OOS mean R | OOS 95% range | OOS n |', '|---|---|---|---|---|---|---|');
  for (const sym of [...new Set(nat.map(c => c.symbol))]) {
    for (const study of ['credit', 'fly']) {
      const pool = nat.filter(c => c.symbol === sym && c.study === study && c.ins.n >= 30 && c.oos.n >= 10);
      if (!pool.length) continue;
      const best = pool.reduce((a, b) => (b.ins.mean > a.ins.mean ? b : a));
      L.push(`| ${sym} | ${study} | ${best.side} ${best.param}×EM ${best.exit} | ${f2(best.ins.mean)} | ${f2(best.oos.mean)} | ${f2(best.oos.lo)} to ${f2(best.oos.hi)} | ${best.oos.n} |`);
    }
  }
  L.push('');
  return L.join('\n');
}

// ---- merge: read back earlier chunk outputs (every trades.csv / days.csv under the given folders) ----
function findDirs(root) {
  const out = [];
  const walk = d => { if (existsSync(path.join(d, 'trades.csv'))) out.push(d); for (const e of readdirSync(d)) { const p = path.join(d, e); if (statSync(p).isDirectory()) walk(p); } };
  walk(root); return out;
}
export function readChunks(dirs) {
  const rows = [], infos = new Map(), seen = new Set();
  for (const d of dirs) {
    const [, ...dl] = readFileSync(path.join(d, 'days.csv'), 'utf8').trim().split('\n');
    for (const line of dl) {
      if (!line) continue;
      const [symbol, date, F, em, emPct, Fclose] = line.split(',');
      if (seen.has(`${symbol}|${date}`)) continue;
      seen.add(`${symbol}|${date}`);
      if (!infos.has(symbol)) infos.set(symbol, []);
      infos.get(symbol).push({ date, F: +F, em: +em, emPct: +emPct, Fclose: Fclose === '' ? null : +Fclose });
    }
    const [, ...tl] = readFileSync(path.join(d, 'trades.csv'), 'utf8').trim().split('\n');
    for (const line of tl) {
      if (!line) continue;
      const [symbol, date, study, side, param, exit, fill, entryNet, exitNet, exitAt, reason, pnl, maxLoss, R] = line.split(',');
      rows.push({ symbol, date, study, side, param: +param, exit, fill, entryNet: +entryNet, exitNet: +exitNet, exitAt, reason, pnl: +pnl, maxLoss: +maxLoss, R: +R });
    }
  }
  // a day can appear in two chunks if a run was repeated: keep one copy of each trade
  const uniq = new Map(rows.map(r => [`${r.symbol}|${r.date}|${keyOf(r)}`, r]));
  return { rows: [...uniq.values()], infos };
}

function writeSummary(allRows, infos, extra) {
  const sum = summarise(allRows, infos);
  const dates = allRows.map(r => r.date).sort();
  const days = [...infos.values()].reduce((a, l) => a + l.length, 0);
  const meta = { entry: ENTRY, days, from: dates[0], to: dates.at(-1), trades: allRows.length, ...extra };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ meta, ...sum }));
  writeFileSync(path.join(OUT, 'summary.md'), report(sum, meta));
  return meta;
}

async function main() {
  if (MERGE) {
    const dirs = String(MERGE).split(',').flatMap(findDirs);
    const { rows, infos } = readChunks(dirs);
    const meta = writeSummary(rows, infos, { chunks: dirs.length });
    console.log(`merged ${dirs.length} chunks · ${meta.days} symbol-days · ${rows.length} trades · ${OUT}`);
    return;
  }
  const allRows = [], infos = new Map();
  let next = null;
  let days = 0, skipped = 0;
  const t0 = Date.now();
  for (const symbol of SYMBOLS) {
    let files;
    try { files = readdirSync(path.join(DIR, '0dte', symbol)).filter(f => f.endsWith('.csv.gz')).map(f => f.slice(0, 10)).filter(d => d >= FROM && d <= TO).sort(); }
    catch { console.error(`no 0dte folder for ${symbol}`); continue; }
    infos.set(symbol, []);
    for (const date of files) {
      if (BUDGET && (Date.now() - t0) / 1000 > BUDGET) { next = date; break; }
      let day;
      try { day = loadDay({ dir: DIR, kind: '0dte', symbol, date }); } catch (e) { skipped++; continue; }
      if (!day) continue;
      const { info, rows } = runDay(day, symbol);
      if (!info) { skipped++; continue; }
      infos.get(symbol).push(info); allRows.push(...rows); days++;
      if (days % 100 === 0) console.log(`${symbol} ${date} · ${days} days · ${allRows.length} trades · ${Math.round((Date.now() - t0) / 1000)} s`);
    }
    if (next) break;
  }
  mkdirSync(OUT, { recursive: true });
  const head = 'symbol,date,study,side,param,exit,fill,entryNet,exitNet,exitAt,reason,pnl,maxLoss,R';
  writeFileSync(path.join(OUT, 'trades.csv'), head + '\n' + allRows.map(r => [r.symbol, r.date, r.study, r.side, r.param, r.exit, r.fill, r.entryNet, r.exitNet, r.exitAt, r.reason, r.pnl, r.maxLoss, r.R.toFixed(4)].join(',')).join('\n') + '\n');
  writeFileSync(path.join(OUT, 'days.csv'), 'symbol,date,F,em,emPct,Fclose\n' + [...infos].flatMap(([s, l]) => l.map(i => [s, i.date, i.F.toFixed(2), i.em.toFixed(3), i.emPct.toFixed(5), i.Fclose == null ? '' : i.Fclose.toFixed(2)].join(','))).join('\n') + '\n');
  writeSummary(allRows, infos, { skipped });
  console.log(`done · ${days} days (${skipped} skipped) · ${allRows.length} trades · ${Math.round((Date.now() - t0) / 1000)} s · ${OUT}`);
  if (next) console.log(`next ${next}`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) main();
