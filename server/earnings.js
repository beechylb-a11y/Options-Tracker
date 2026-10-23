// ── Earnings dates from Finnhub (Oct 2026) ──
//
// The fallback when Nasdaq will not talk to the bridge's Mac (23 Oct: every
// request from Node timed out, from the same machine Chrome reached Nasdaq fine).
// Finnhub's official calendar, called from the server, so it needs neither the
// bridge nor the Mac. Free key from finnhub.io, set as FINNHUB_KEY on Railway.
// One request per symbol (the free tier allows 60 a minute); cached 6 hours.
//
// Same reply shape as the bridge's /api/earnings, so the client reads either.

const CACHE_MS = 6 * 3600 * 1000;
const cache = new Map();               // `${sym}|${from}|${to}` → { at, rows }

/** Finnhub "hour": bmo / amc / dmh (during market hours) / '' → bmo | amc | dmh | unknown */
export const hourOf = h => (h === 'bmo' || h === 'amc' || h === 'dmh' ? h : 'unknown');

export function parseFinnhub(json, symbol) {
  const rows = json && Array.isArray(json.earningsCalendar) ? json.earningsCalendar : [];
  return rows.filter(r => r && r.date && String(r.symbol || symbol).toUpperCase() === symbol)
    .map(r => ({ symbol, name: '', date: String(r.date).slice(0, 10), time: hourOf(r.hour),
      fiscalQuarter: r.quarter && r.year ? `Q${r.quarter}/${r.year}` : '', epsForecast: r.epsEstimate != null ? String(r.epsEstimate) : '' }));
}

export async function finnhubEarnings(symbols, from, to, { key = process.env.FINNHUB_KEY, fetchImpl = globalThis.fetch } = {}) {
  if (!key) { const e = new Error('FINNHUB_KEY not set'); e.code = 'NOKEY'; throw e; }
  const want = [...new Set((symbols || []).map(s => String(s).trim().toUpperCase()).filter(Boolean))];
  const events = [], unchecked = [];
  let why = '';
  for (const sym of want) {
    const k = `${sym}|${from}|${to}`;
    const hit = cache.get(k);
    if (hit && Date.now() - hit.at < CACHE_MS) { events.push(...hit.rows); continue; }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    try {
      const r = await fetchImpl(`https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&symbol=${encodeURIComponent(sym)}&token=${encodeURIComponent(key)}`, { signal: ctrl.signal });
      if (!r.ok) throw new Error('Finnhub ' + r.status);
      const rows = parseFinnhub(await r.json(), sym);
      cache.set(k, { at: Date.now(), rows });
      events.push(...rows);
    } catch (e) {
      unchecked.push(sym);
      if (!why) why = e.name === 'AbortError' ? 'Finnhub timed out' : e.message;
    } finally { clearTimeout(t); }
  }
  events.sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol));
  return { events, checked: want.length, failed: [], horizon: null, unchecked, complete: unchecked.length === 0, why, source: 'finnhub' };
}

export const _cacheForTests = cache;
