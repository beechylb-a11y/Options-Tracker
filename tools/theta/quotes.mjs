/**
 * quotes.mjs — real option quotes from the ThetaData history download (Nov 2026).
 *
 * Reads the gzip CSVs written by tools/theta/theta_download.py:
 *   <dir>/0dte/<SYMBOL>/<YYYY-MM-DD>.csv.gz    1-minute NBBO, that day's expiry, 09:30–16:00
 *   <dir>/45dte/<SYMBOL>/<YYYY-MM-DD>.csv.gz   one 15:45 quote, every expiry ≤ 60 DTE
 *   <dir>/<kind>/<SYMBOL>/<YYYY-MM-DD>.empty   ThetaData had nothing (holiday, before history)
 *
 * and prices any structure at any minute from the real bid and ask, instead of the
 * Black-Scholes-with-skew marks the learn grid and band-backtest use today.
 *
 * Legs use the shadow-verdict shape: { strike, right: 'C' | 'P', qty } with qty > 0
 * long, < 0 short (engine/shadow.js shadowLegs). Money is per share with the engine's
 * sign: an entry is + for a credit, − for a debit; a mark is what the position is worth
 * to the holder. P&L per contract = (entry + exit) × 100.
 *
 * Times are New York clock strings 'HH:MM'. ThetaData stamps carry the ET offset
 * (2026-11-17T09:31:00.000-0500), so the clock part is read as written: no zone maths,
 * and none of the Chicago-hour trap the bridge bars had (Oct 2026).
 */
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import os from 'node:os';

export const DEFAULT_DIR = path.join(os.homedir(), 'Options-Tracker', 'data', 'thetadata');

export const toMin = hhmm => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };
export const fromMin = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const normRight = r => { const s = String(r || '').trim().toUpperCase(); return s.startsWith('C') ? 'C' : s.startsWith('P') ? 'P' : null; };
const normExp = e => { const s = String(e || '').trim().slice(0, 10); return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : s; };
const keyOf = (exp, strike, right) => `${exp}|${Number(strike)}|${right}`;
const r2 = x => Math.round(x * 100) / 100;

/** ThetaData's timestamp → 'HH:MM' on the exchange clock it was written in. */
export function clockOf(ts) {
  const s = String(ts || '');
  const t = s.indexOf('T') >= 0 ? s.split('T')[1] : s.includes(' ') ? s.split(' ')[1] : s;
  return t && /^\d{2}:\d{2}/.test(t) ? t.slice(0, 5) : null;
}

/**
 * CSV text → Map(key → [{ t, m, bid, ask }]) sorted by minute.
 * A row with neither a bid nor an ask is no quote and is dropped; a zero bid with an
 * ask (a far wing nobody bids) is kept as bid 0.
 */
export function parseQuotes(text) {
  const lines = String(text || '').split(/\r?\n/).filter(Boolean);
  const out = new Map();
  if (lines.length < 2) return out;
  const head = lines[0].split(',').map(h => h.trim().toLowerCase());
  const ix = name => head.indexOf(name);
  const iE = ix('expiration'), iK = ix('strike'), iR = ix('right'), iT = ix('timestamp'), iB = ix('bid'), iA = ix('ask');
  if ([iE, iK, iR, iT, iB, iA].some(i => i < 0)) throw new Error(`unexpected columns: ${head.join(',')}`);
  for (let n = 1; n < lines.length; n++) {
    const c = lines[n].split(',');
    const right = normRight(c[iR]), t = clockOf(c[iT]);
    const bid = Number(c[iB]), ask = Number(c[iA]);
    if (!right || !t || !Number.isFinite(bid) || !Number.isFinite(ask)) continue;
    if (!(ask > 0) && !(bid > 0)) continue;
    const k = keyOf(normExp(c[iE]), c[iK], right);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push({ t, m: toMin(t), bid: Math.max(0, bid), ask: ask > 0 ? ask : bid });
  }
  for (const rows of out.values()) rows.sort((a, b) => a.m - b.m);
  return out;
}

export class Day {
  constructor(map, { symbol, date, kind }) {
    this.map = map; this.symbol = symbol; this.date = date; this.kind = kind;
  }
  expirations() { return [...new Set([...this.map.keys()].map(k => k.split('|')[0]))].sort(); }
  strikes(exp = this.date, right) {
    return [...new Set([...this.map.keys()].filter(k => k.startsWith(exp + '|') && (!right || k.endsWith('|' + right)))
      .map(k => Number(k.split('|')[1])))].sort((a, b) => a - b);
  }
  minutes() {
    // cached: replay asks for this once per structure × exit, and rebuilding it walks every quote row
    if (!this._minutes) { const set = new Set(); for (const rows of this.map.values()) for (const r of rows) set.add(r.m); this._minutes = [...set].sort((a, b) => a - b); }
    return this._minutes;
  }

  /**
   * The quote standing at minute t for one leg: the last update at or before t.
   * ageMin says how old it is; stale is true past maxAgeMin (a wing that stopped
   * updating). null when the leg had no quote at all by then.
   */
  quote(leg, t, { exp = this.date, maxAgeMin = 5 } = {}) {
    const rows = this.map.get(keyOf(exp, leg.strike, normRight(leg.right)));
    if (!rows || !rows.length) return null;
    const want = typeof t === 'number' ? t : toMin(t);
    let lo = 0, hi = rows.length - 1, at = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (rows[mid].m <= want) { at = mid; lo = mid + 1; } else hi = mid - 1; }
    if (at < 0) return null;
    const q = rows[at], ageMin = want - q.m;
    return { bid: q.bid, ask: q.ask, mid: (q.bid + q.ask) / 2, t: q.t, ageMin, stale: ageMin > maxAgeMin };
  }
}

/** Load one day. Returns null for a day ThetaData had nothing for (.empty). */
export function loadDay({ dir = DEFAULT_DIR, kind = '0dte', symbol, date }) {
  const base = path.join(dir, kind, String(symbol).toUpperCase());
  const file = path.join(base, `${date}.csv.gz`);
  if (existsSync(file)) return new Day(parseQuotes(gunzipSync(readFileSync(file)).toString('utf8')), { symbol, date, kind });
  if (existsSync(path.join(base, `${date}.empty`))) return null;
  throw new Error(`no ${kind} file for ${symbol} on ${date} under ${base} (not downloaded yet?)`);
}

/**
 * Every price of a structure at minute t, per share:
 *   open   what opening at the touch gets you (+ credit / − debit): buy at the ask, sell at the bid
 *   close  what closing at the touch gets you: sell longs at the bid, buy shorts back at the ask
 *   mark   mid value to the holder (Σ qty × mid)
 *   spread natural width, Σ |qty| × (ask − bid)
 * missing lists legs with no quote; stale lists legs whose last update is older than maxAgeMin.
 */
export function combo(day, legs, t, opts = {}) {
  let open = 0, close = 0, mark = 0, spread = 0, maxAge = 0;
  const missing = [], stale = [];
  for (const l of legs) {
    const q = day.quote(l, t, opts);
    if (!q) { missing.push(l); continue; }
    if (q.stale) stale.push(l);
    maxAge = Math.max(maxAge, q.ageMin);
    open += l.qty > 0 ? -l.qty * q.ask : -l.qty * q.bid;
    close += l.qty > 0 ? l.qty * q.bid : l.qty * q.ask;
    mark += l.qty * q.mid;
    spread += Math.abs(l.qty) * (q.ask - q.bid);
  }
  if (missing.length) return { ok: false, missing, stale, t: typeof t === 'number' ? fromMin(t) : t };
  return { ok: true, open: r2(open), close: r2(close), mark: r2(mark), spread: r2(spread), maxAge, missing, stale, t: typeof t === 'number' ? fromMin(t) : t };
}

/**
 * Open at `entry`, hold, close at `exit`, on the real quotes.
 * fill 'natural' (default) crosses the spread both ways; 'mid' fills at mid both ways.
 * Optional profit target / stop as a share of the entry premium end the walk early,
 * judged on the mark (mid), filled at the close price of that minute.
 * Returns per-share entry and exit, P&L per contract, and the mid path with its best
 * and worst points (MFE / MAE) — or { ok: false, reason } when a leg was unpriced.
 */
export function replay(day, legs, { entry = '10:00', exit = '15:45', fill = 'natural', target = null, stop = null, exp, maxAgeMin = 5 } = {}) {
  const opts = { exp: exp || day.date, maxAgeMin };
  const e0 = toMin(entry), x0 = toMin(exit);
  const at0 = combo(day, legs, e0, opts);
  if (!at0.ok) return { ok: false, reason: `no quote at entry ${entry} for ${at0.missing.map(l => `${l.strike}${l.right}`).join(', ')}` };
  const entryNet = fill === 'mid' ? -at0.mark : at0.open;
  const premium = Math.abs(entryNet);
  const path = [];
  let mfe = -Infinity, mae = Infinity, end = null;
  const mins = day.minutes().filter(m => m > e0 && m <= x0);
  if (!mins.includes(x0)) mins.push(x0);
  for (const m of mins) {
    const c = combo(day, legs, m, opts);
    if (!c.ok) continue;
    const pnl = r2(entryNet + c.mark);
    path.push({ t: c.t, mark: c.mark, pnl });
    mfe = Math.max(mfe, pnl); mae = Math.min(mae, pnl);
    const hitTarget = target != null && premium > 0 && pnl >= target * premium;
    const hitStop = stop != null && premium > 0 && pnl <= -stop * premium;
    if (hitTarget || hitStop || m === x0) {
      end = { t: c.t, reason: hitTarget ? 'target' : hitStop ? 'stop' : 'time', value: fill === 'mid' ? c.mark : c.close, stale: c.stale.length };
      break;
    }
  }
  if (!end) return { ok: false, reason: `no quote to exit on by ${exit}` };
  return {
    ok: true, entryAt: at0.t, entryNet: r2(entryNet), entrySpread: at0.spread,
    exitAt: end.t, exitNet: r2(end.value), exitReason: end.reason, exitStaleLegs: end.stale,
    pnlPerCt: Math.round((entryNet + end.value) * 100 * 100) / 100,
    mfe: Number.isFinite(mfe) ? mfe : null, mae: Number.isFinite(mae) ? mae : null, path,
  };
}

/** "+1 7300C, -2 7320C, +1 7340C" → shadow-shape legs. */
export function parseLegs(s) {
  return String(s || '').split(',').map(x => x.trim()).filter(Boolean).map(x => {
    const m = x.match(/^([+-]?\d+)\s*[x×]?\s*(\d+(?:\.\d+)?)\s*([CP])$/i);
    if (!m) throw new Error(`can't read leg "${x}" (want e.g. +1 7300C or -2 7320P)`);
    return { qty: Number(m[1]), strike: Number(m[2]), right: m[3].toUpperCase() };
  });
}
