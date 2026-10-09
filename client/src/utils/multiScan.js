// ── Multi-scan, outside the panel (Oct 2026) ──
//
// The scan used to live inside the panel component, so it could only run for the
// group on screen and its results vanished when the panel closed. Here it is two
// functions: fetchScanData pulls what the bridge has for a list of underlyings, and
// computeScan runs the engine over it. The page keeps the results per group, and
// "Scan everything" runs every group in turn — 0DTE and 45DTE, indices, ETFs and
// stocks — sharing one fetch per ticker through `cache` (SPY's market data serves
// both its 0DTE and its 45DTE scan).

import { calc0DTE } from '../engine/calc0dte';
import { calc45DTE } from '../engine/calc45dte';
import { computeTrend } from '../engine/trend';
import { tradingSession } from '../engine/session';

// Market fields each scan type asks of the bridge (and lets you type by hand).
// 0DTE reads the session: VWAP, intraday ranges, the ES overnight. 45DTE reads
// volatility: IV, its rank, realised vol, the term structure and skew.
export const SCAN_FIELDS = {
  '0dte': [
    { key: 'price', label: 'Price' },
    { key: 'high', label: 'Day High' },
    { key: 'low', label: 'Day Low' },
    { key: 'cashOpen', label: 'Open' },
    { key: 'em', label: 'EM' },
    { key: 'atr', label: 'ATR 1 Day' },
    { key: 'atr5', label: 'ATR 5m' },
    { key: 'atr2h', label: 'ATR 2h' },
    { key: 'vix', label: 'VIX' },
    { key: 'vix1d', label: 'VIX1D' },
    { key: 'vwap5', label: 'VWAP 5' },
    { key: 'vwap5_30', label: 'VWAP 5 -30m' },
    { key: 'vwapRoll30', label: 'VWAP last 30m' },
    { key: 'vwapRoll30Prior', label: 'VWAP prior 30m' },
    { key: 'vwapAccept', label: 'VWAP acceptance' },
    { key: 'esClose', label: 'ES Pre-open' },
    { key: 'priorDayClose', label: 'ES Prior Close' },
    { key: 'esOvernightHigh', label: 'ES O/N High' },
    { key: 'esOvernightLow', label: 'ES O/N Low' },
    { key: 'esEM', label: 'ES EM' },
  ],
  '45dte': [
    { key: 'price', label: 'Price' },
    { key: 'vix', label: 'VIX' },
    { key: 'iv', label: 'IV % (45d ATM)' },
    { key: 'ivr', label: 'IV Rank %' },
    { key: 'hv', label: 'HV % (30d)' },
    { key: 'ivFront', label: 'IV front (~30d)' },
    { key: 'ivBack', label: 'IV back (~90d)' },
    { key: 'skew', label: 'Skew 25Δ (P−C)' },
  ],
};
export const VOL_SCAN_KEYS = ['iv', 'ivr', 'hv', 'ivFront', 'ivBack', 'skew'];

// One promise per (kind, ticker) per run — the master scan shares them across groups.
export const newScanCache = () => new Map();
function cached(cache, key, make) {
  if (!cache) return make();
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key);
}
// Resolves to the parsed body, or { error } saying why there is none — a timeout, an
// unreachable bridge, a web page instead of JSON. It used to resolve null for all of
// them, so a slow bridge produced a blank scan with no reason. (Oct 2026.)
function getJson(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { headers: { 'ngrok-skip-browser-warning': '1' }, signal: ctrl.signal })
    .then(async r => {
      const txt = await r.text();
      try { return JSON.parse(txt); }
      catch (e) {
        return { error: r.status === 404 || /Cannot GET/i.test(txt) ? 'bridge is an older version — pull and restart it'
          : /ngrok/i.test(txt) ? 'ngrok returned a page instead of the bridge' : `bridge returned a web page (HTTP ${r.status})` };
      }
    })
    .catch(e => ({ error: e.name === 'AbortError' ? `bridge took longer than ${Math.round(ms / 1000)} s` : 'bridge not reachable' }))
    .finally(() => clearTimeout(t));
}

// Run `fn` over `items` with at most `n` in flight. The bridge has one TWS connection;
// a whole group at once (seven tickers × five history requests) is what made it slow.
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}
const SCAN_CONCURRENCY = 2;

/** Pull the bridge's data for `underlyings` into a copy of `manualData` (typed values win). */
export async function fetchScanData({ mode, underlyings, manualData = {}, bridgeUrl, cache }) {
  const is0 = mode === '0dte';
  const pulledAt = new Date().toISOString();
  const meta = {};
  const mergedData = {};
  Object.keys(manualData || {}).forEach(k => { mergedData[k] = { ...manualData[k] }; });
  const list = (underlyings || []).filter(Boolean);
  if (!bridgeUrl) return { mergedData, meta, pulledAt };

  const market = await pool(list, SCAN_CONCURRENCY, u =>
    cached(cache, 'md:' + u, () => getJson(bridgeUrl + '/api/market-data?underlying=' + u, 60000)).then(data => ({ u, data })));
  market.forEach(({ u, data }) => {
    if (!data || data.error) {
      // Say why on the row instead of leaving it blank.
      mergedData[u] = { ...(mergedData[u] || {}), _fetchError: (data && data.error) || 'no answer from the bridge' };
      return;
    }
    // Freshness is not an engine input; carry it to the tab separately.
    meta[u] = { isLive: !!data.isLive, label: data.dataTypeLabel || (data.isLive ? 'Live' : 'Last close'),
      asOf: data.asOf || data.timestamp || null, pulledAt };
    const existing = mergedData[u] || {};
    const merged = { ...existing };
    SCAN_FIELDS['0dte'].forEach(f => {
      // vwapAccept is a 0..1 ratio: 0 is a real reading, only -1 means none.
      const v = data[f.key];
      const usable = f.key === 'vwapAccept' ? (v != null && v >= 0) : (v != null && v !== 0);
      merged[f.key] = existing[f.key] || (usable ? String(v) : existing[f.key] || '');
    });
    mergedData[u] = merged;
  });

  // Normalise first, so the table and the engine agree and the straddle fetch gets a spot.
  list.forEach(u => {
    const md = mergedData[u];
    if (!md) return;
    const num = k => parseFloat(md[k]) || 0;
    const scale = v => (u === 'SPX' && v > 0 && v < 3000) ? v * 10 : v;   // SPX fields arrive SPY-scale
    const price = num('price') || scale(num('vwap5'));
    if (price) md.price = String(+price.toFixed(2));
    ['high', 'low', 'cashOpen', 'vwap5', 'vwap5_30', 'vwapRoll30', 'vwapRoll30Prior'].forEach(k => {
      const v = num(k);
      if (v) md[k] = String(+scale(v).toFixed(2));
    });
    const vix = num('vix');
    if (price && vix) md.em = String(Math.round(price * (vix / 100) / Math.sqrt(252) * 10) / 10);
  });

  if (is0) {
    // Straddle EM — the market-priced move, preferred over the VIX model.
    const today = tradingSession().yyyymmdd;
    // Does anything expire today? (Oct 2026.) Most single stocks list weeklies, not
    // dailies, and a 0DTE scan used to rank a TSLA setup on a day TSLA had no expiry.
    const oc = await pool(list, SCAN_CONCURRENCY, u =>
      cached(cache, 'oc:' + u, () => getJson(bridgeUrl + '/api/option-chain?underlying=' + u, 20000)).then(d => ({ u, d })));
    oc.forEach(({ u, d }) => {
      if (!d || d.error || !mergedData[u]) return;
      const all = Array.isArray(d.expirationsAll) ? d.expirationsAll : null;
      const list0 = all || (Array.isArray(d.expirations) ? d.expirations : null);
      if (!list0) return;
      const known = all || (d.today && today > d.today);   // an old bridge on the same day cannot tell
      if (!list0.includes(today) && known) {
        mergedData[u] = { ...mergedData[u], _noExpiryToday: true, _nextExpiry: list0.find(e => e > today) || '' };
      }
    });
    const st = await pool(list, SCAN_CONCURRENCY, u => {
      const spot = parseFloat(mergedData[u]?.price) || 0;
      return cached(cache, 'st:' + u, () => getJson(bridgeUrl + '/api/atm-straddle?underlying=' + u + '&expiry=' + today
        + '&haircut=0.85' + (spot > 0 ? '&spot=' + spot : ''), 30000)).then(sd => ({ u, sd }));
    });
    st.forEach(({ u, sd }) => {
      if (sd && sd.source === 'straddle' && sd.expectedMove > 0 && mergedData[u]) {
        mergedData[u] = { ...mergedData[u], em: String(sd.expectedMove), emSource: 'straddle',
          straddleCall: String(sd.callPrice), straddlePut: String(sd.putPrice) };
      }
    });
  } else {
    // The vol surface — ATM IV, IV rank, HV, term, skew, daily bars, VIX/VIX3M.
    const vs = await pool(list, SCAN_CONCURRENCY, u => {
      const spot = parseFloat(mergedData[u]?.price) || 0;
      return cached(cache, 'vs:' + u, () => getJson(bridgeUrl + '/api/vol-surface?underlying=' + u
        + (spot > 0 ? '&spot=' + spot : ''), 90000)).then(v => ({ u, v }));
    });
    vs.forEach(({ u, v }) => {
      if (!mergedData[u]) return;
      if (!v || v.error) { mergedData[u] = { ...mergedData[u], _volError: (v && v.error) || 'no answer from the bridge' }; return; }
      const md = { ...mergedData[u] };
      VOL_SCAN_KEYS.forEach(k => {
        const x = v[k];
        const ok = x != null && x !== '' && isFinite(x) && (k === 'skew' || x > 0);
        if (ok && (md[k] === undefined || md[k] === '')) md[k] = String(x);
      });
      if (v.termBias) md.termBias = v.termBias;
      const tr = computeTrend(v.daily);
      if (tr) { md._trend = tr; md._dailySource = v.dailySource || null; }
      md._oldBridge = !('daily' in v) && !('vix3m' in v);      // a bridge from before 6 Oct
      md._noDaily = !md._oldBridge && !tr;
      if (v.vixTermRatio) md.vixTermRatio = v.vixTermRatio;
      mergedData[u] = md;
    });
  }
  return { mergedData, meta, pulledAt };
}

/** Run the engine for each underlying over `data`; best setup first. */
export function computeScan(mode, underlyings, data) {
  const is0 = mode === '0dte';
  const out = (underlyings || []).filter(Boolean).map(underlying => {
    const m0 = (data || {})[underlying] || {};
    const scaleV = v => {
      const p = parseFloat(m0.price) || 0;
      return (underlying === 'SPX' && p > 1000 && v > 0 && v < p * 0.3) ? v * 10 : v;
    };
    const f = k => parseFloat(m0[k]) || 0;
    const inp = {
      price: f('price'), high: scaleV(f('high')), low: scaleV(f('low')), cashOpen: scaleV(f('cashOpen')),
      em: f('em'), emSource: m0.emSource || (m0.em ? 'vix' : undefined),
      straddleCall: f('straddleCall') || undefined, straddlePut: f('straddlePut') || undefined,
      atr: f('atr'), atr5: f('atr5'), atr2h: f('atr2h'), vix: f('vix'), vix1d: f('vix1d'),
      vwap5: scaleV(f('vwap5')), vwap5_30: scaleV(f('vwap5_30')), vwapRoll30: scaleV(f('vwapRoll30')),
      vwapRoll30Prior: scaleV(f('vwapRoll30Prior')),
      vwapAccept: (m0.vwapAccept == null || m0.vwapAccept === '' || parseFloat(m0.vwapAccept) < 0) ? null : parseFloat(m0.vwapAccept),
      esClose: f('esClose'), priorDayClose: f('priorDayClose'), esOvernightHigh: f('esOvernightHigh'),
      esOvernightLow: f('esOvernightLow'), esEM: f('esEM'),
    };
    if (!inp.price) {
      let vp = f('vwap5');
      if (underlying === 'SPX' && vp > 0 && vp < 3000) vp *= 10;
      if (vp > 0) inp.price = vp;
    }
    const vol = {};
    if (!is0) {
      VOL_SCAN_KEYS.forEach(k => { if (m0[k] !== undefined && m0[k] !== '') vol[k] = m0[k]; });
      if (m0.termBias) vol.termBias = m0.termBias;
      if (m0._trend) { vol._trend = m0._trend; vol.outlook = m0._trend.outlook; vol._dailySource = m0._dailySource; }
      if (m0.vixTermRatio) vol.vixTermRatio = m0.vixTermRatio;
      if (m0._oldBridge) vol._oldBridge = true;
      if (m0._noDaily) vol._noDaily = true;
      if (m0._volError) vol._volError = m0._volError;
    }
    const rowData = is0 ? inp : { price: inp.price, vix: inp.vix, ...vol };
    if (is0 && m0._noExpiryToday) {
      const nx = String(m0._nextExpiry || '');
      const nice = nx.length === 8 ? new Date(+nx.slice(0, 4), +nx.slice(4, 6) - 1, +nx.slice(6, 8))
        .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
      return { underlying, error: `No expiry today${nice ? ` — next ${nice}` : ''}`, noExpiryToday: true, result: null, data: rowData };
    }
    if (!inp.price) return { underlying, error: m0._fetchError ? 'Bridge: ' + m0._fetchError : 'No price from the bridge', result: null, data: rowData };
    try {
      const result = is0 ? calc0DTE({
        ...inp, gamStrike: 0, bankroll: 3000, startBR: 3000, risk: 0, maxLoss: 300, win: 0, maxOpen: 450,
        pop: 0, theta: 0, delta: 0, gamma: 0, hours: 6.5, underlying, overrideStrategy: null,
      }) : calc45DTE({
        price: inp.price, vix: inp.vix,
        ivr: parseFloat(vol.ivr) || 0, iv: parseFloat(vol.iv) || 0, hv: parseFloat(vol.hv) || 0,
        ivFront: parseFloat(vol.ivFront) || 0, ivBack: parseFloat(vol.ivBack) || 0, skew: parseFloat(vol.skew) || 0,
        termBias: vol.termBias || '',          // no invented contango
        dte: 45, pop: 0, win: 0, risk: 0, bankroll: 3000, startBR: 3000, maxLoss: 300, maxOpen: 450, bpr: 0,
        theta: 0, vega: 0, delta: 0, underlying,
        outlook: vol.outlook || 'neutral', trend: vol._trend || null, vixTermRatio: vol.vixTermRatio || null,
        overrideStrategy: null,
      });
      return { underlying, result, data: rowData };
    } catch (e) {
      return { underlying, error: e.message, result: null, data: rowData };
    }
  });
  out.sort((a, b) => (b.result?.setupScore || 0) - (a.result?.setupScore || 0));
  return out;
}
