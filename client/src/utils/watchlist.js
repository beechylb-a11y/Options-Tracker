// ── Watchlist (Nov 2026) ──
//
// One list, shared across accounts and devices (stored in the database as config key
// `watchlist`), that the engine scans for 0DTE and 45DTE. Up to 20 names; the top N
// (10 by default) of each mode are scanned.
//
//   0DTE   your order, pins first; a name with no expiry today is skipped (most single
//          stocks list weeklies, not dailies).
//   45DTE  pins first, then by IV Rank (bridge /api/ivr, one request per name, kept for
//          the day). A stock with earnings inside the 45-day window drops 20 IVR points
//          in the ranking — IVR inflates into earnings, and an IVR made by one event
//          should not push out steadier names. Pin it to keep it.
//
// Asset class decides which scan group a name lands in (Indices / ETFs / Stocks).

import { api } from './api';

export const INDEX_SYMBOLS = ['SPX', 'SPXW', 'XSP', 'NDX', 'NDXP', 'RUT', 'RUTW', 'VIX', 'OEX', 'XEO', 'DJX'];
export const ETF_SYMBOLS = ['SPY', 'QQQ', 'IWM', 'DIA', 'GLD', 'SLV', 'TLT', 'HYG', 'XLF', 'XLE', 'XLK', 'SMH', 'EEM', 'EFA', 'ARKK', 'USO', 'IBIT'];
export const assetClassOf = u => {
  const x = String(u || 'SPX').toUpperCase();
  return INDEX_SYMBOLS.includes(x) ? 'index' : ETF_SYMBOLS.includes(x) ? 'etf' : 'stock';
};

export const WATCH_MAX = 20;
export const SCAN_N_DEFAULT = 10;
export const EARNINGS_PENALTY = 20;            // IVR points, 45DTE ranking only
export const EARNINGS_WINDOW_DAYS = 45;

export const DEFAULT_WATCHLIST = {
  v: 1, scanN: SCAN_N_DEFAULT,
  items: [
    { sym: 'SPX', on0: true, on45: true, pin: true },
    { sym: 'SPY', on0: true, on45: true, pin: true },
    { sym: 'XSP', on0: true, on45: false, pin: false },
    { sym: 'QQQ', on0: true, on45: true, pin: false },
    { sym: 'IWM', on0: true, on45: true, pin: false },
    { sym: 'TSLA', on0: false, on45: true, pin: false },
    { sym: 'NVDA', on0: false, on45: true, pin: false },
    { sym: 'AAPL', on0: false, on45: true, pin: false },
    { sym: 'AMD', on0: false, on45: true, pin: false },
    { sym: 'GLD', on0: false, on45: true, pin: false },
  ],
};

const SYM_RE = /^[A-Z][A-Z.]{0,5}$/;
export const cleanSym = s => String(s || '').trim().toUpperCase().replace(/^\$/, '');
export const validSym = s => SYM_RE.test(cleanSym(s));

/** Any stored shape → { v, scanN, items[] }, deduped and capped. */
export function normalise(raw) {
  let w = raw;
  if (typeof w === 'string') { try { w = JSON.parse(w); } catch { w = null; } }
  if (!w || !Array.isArray(w.items)) return null;
  const seen = new Set();
  const items = [];
  for (const it of w.items) {
    const sym = cleanSym(it && it.sym);
    if (!validSym(sym) || seen.has(sym)) continue;
    seen.add(sym);
    items.push({ sym, on0: it.on0 !== false, on45: it.on45 !== false, pin: !!it.pin });
    if (items.length >= WATCH_MAX) break;
  }
  const n = Number(w.scanN);
  return { v: 1, scanN: n >= 1 && n <= WATCH_MAX ? Math.round(n) : SCAN_N_DEFAULT, items };
}

/** First run: the per-group scan lists this browser kept, folded into one list. */
export function fromLegacy(legacy) {
  const out = { ...DEFAULT_WATCHLIST, items: DEFAULT_WATCHLIST.items.map(x => ({ ...x })) };
  if (!legacy || typeof legacy !== 'object') return out;
  for (const [g, list] of Object.entries(legacy)) {
    if (!Array.isArray(list)) continue;
    const is0 = g.startsWith('0dte');
    for (const s of list) {
      const sym = cleanSym(s);
      if (!validSym(sym)) continue;
      const hit = out.items.find(x => x.sym === sym);
      if (hit) { if (is0) hit.on0 = true; else hit.on45 = true; }
      else if (out.items.length < WATCH_MAX) out.items.push({ sym, on0: is0, on45: !is0, pin: false });
    }
  }
  return out;
}

export async function loadWatchlist(legacy) {
  try {
    const cfg = await api.getConfig();
    const w = normalise(cfg && cfg.watchlist);
    if (w) return { list: w, stored: true };
  } catch { /* offline: fall through */ }
  return { list: fromLegacy(legacy), stored: false };
}
export function saveWatchlist(w) {
  return api.updateConfig('watchlist', JSON.stringify(normalise(w)));
}

// ── Day caches (this browser): IVR and the option-chain check ──
const nyDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d).replace(/-/g, '');
function dayCache(key) {
  try { const c = JSON.parse(localStorage.getItem(key) || 'null'); return c && c.day === nyDay() ? c.map || {} : {}; } catch { return {}; }
}
function putDayCache(key, map) {
  try { localStorage.setItem(key, JSON.stringify({ day: nyDay(), at: Date.now(), map })); } catch { /* private window */ }
}
const HDR = { headers: { 'ngrok-skip-browser-warning': '1' } };

export const cachedIvr = () => dayCache('wl-ivr-v1');
/** IV Rank for the names not already read today (all of them with force). */
export async function fetchIvr(bridgeUrl, syms, { force = false } = {}) {
  const have = force ? {} : cachedIvr();
  const want = syms.filter(s => force || !have[s]);
  if (!bridgeUrl || !want.length) return have;
  const r = await fetch(`${bridgeUrl}/api/ivr?symbols=${encodeURIComponent(want.join(','))}${force ? '&force=1' : ''}`, HDR);
  const j = await r.json();
  if (!j || !j.ivr) throw new Error(j && j.error ? j.error : 'no IVR from the bridge');
  const map = { ...have, ...j.ivr };
  putDayCache('wl-ivr-v1', map);
  return map;
}

export const cachedChains = () => dayCache('wl-chain-v1');
/** Does it have options, and does it expire today? One /api/option-chain per name, kept for the day. */
export async function checkChain(bridgeUrl, sym) {
  const r = await fetch(`${bridgeUrl}/api/option-chain?underlying=${encodeURIComponent(sym)}`, HDR);
  let j = null; try { j = await r.json(); } catch { j = null; }
  let out;
  if (!j || j.error || !Array.isArray(j.expirationsAll)) out = { ok: false, error: (j && j.error) || 'no option chain' };
  else {
    const today = j.today;
    const all = j.expirationsAll;
    const week = all.filter(e => e >= today && e <= addDaysYmd(today, 7));
    out = { ok: all.length > 0, today: all.includes(today), next: all.find(e => e > today) || null, dailies: week.length >= 4 };
  }
  const map = { ...cachedChains(), [sym]: out };
  putDayCache('wl-chain-v1', map);
  return out;
}
function addDaysYmd(ymd, n) {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)) + n * 864e5);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/** Earnings inside the next 45 days, per symbol: { SYM: 'yyyy-mm-dd' } (stocks only). */
export async function fetchEarnings(syms) {
  const stocks = syms.filter(s => assetClassOf(s) === 'stock');
  if (!stocks.length) return {};
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + EARNINGS_WINDOW_DAYS * 864e5).toISOString().slice(0, 10);
  const d = await api.getEarnings(stocks, from, to);
  const out = {};
  for (const e of (d && d.events) || []) if (e && e.symbol && !out[e.symbol]) out[e.symbol] = e.date;
  return out;
}

/**
 * Which names a mode scans. → { scan: [sym], rest: [sym], why: { sym: text } }
 * ctx: { ivr: {SYM:{ivr}}, earn: {SYM:date}, chain: {SYM:{today}} }
 */
export function rankWatchlist(mode, w, ctx = {}) {
  const items = (w && w.items) || [];
  const n = (w && w.scanN) || SCAN_N_DEFAULT;
  const ivr = ctx.ivr || {}, earn = ctx.earn || {}, chain = ctx.chain || {};
  const why = {};
  let ordered;
  if (mode === '0dte') {
    const on = items.filter(x => x.on0);
    // No expiry today AND no dailies (a weekly-only stock): skip. A weekend or holiday has
    // no expiry "today" for anything, so dailies alone keep SPX & co. on the list.
    const usable = on.filter(x => { const c = chain[x.sym]; return !(c && c.ok && c.today === false && !c.dailies); });
    on.filter(x => !usable.includes(x)).forEach(x => { why[x.sym] = 'no expiry today'; });
    ordered = [...usable.filter(x => x.pin), ...usable.filter(x => !x.pin)];
    ordered.forEach(x => { why[x.sym] = x.pin ? 'pinned' : 'your order'; });
    const scan = ordered.slice(0, n).map(x => x.sym);
    const rest = [...ordered.slice(n), ...on.filter(x => !usable.includes(x))].map(x => x.sym);
    return { scan, rest, why };
  }
  const on = items.filter(x => x.on45);
  const score = x => {
    const r = ivr[x.sym] && ivr[x.sym].ivr != null ? ivr[x.sym].ivr : -1;
    return earn[x.sym] ? r - EARNINGS_PENALTY : r;
  };
  const pins = on.filter(x => x.pin);
  const others = on.filter(x => !x.pin).map((x, i) => ({ x, i, s: score(x) }))
    .sort((a, b) => b.s - a.s || a.i - b.i).map(o => o.x);
  ordered = [...pins, ...others];
  ordered.forEach(x => {
    const r = ivr[x.sym] && ivr[x.sym].ivr;
    why[x.sym] = x.pin ? 'pinned' : r == null ? 'no IVR yet' : `IVR ${r}${earn[x.sym] ? ' · earnings −' + EARNINGS_PENALTY : ''}`;
  });
  return { scan: ordered.slice(0, n).map(x => x.sym), rest: ordered.slice(n).map(x => x.sym), why };
}

/** The scan list for one group (mode × asset class). */
export const groupList = (rank, cls) => rank.scan.filter(s => assetClassOf(s) === cls);
