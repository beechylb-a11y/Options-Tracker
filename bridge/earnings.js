// ── Earnings dates (Oct 2026) ──
//
// IBKR only carries corporate event dates through a paid add-on (Wall Street
// Horizon), so the bridge reads Nasdaq's public earnings calendar instead: one
// request per trading day, every company reporting that day, with whether it is
// before the open or after the close. It runs here, on your Mac, because Nasdaq
// refuses most cloud servers.
//
// Unofficial and best-effort. A day that fails is reported as such, never as
// "no earnings": on a ticket, a calendar that failed and a clear calendar look the
// same, and only one of them is safe.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const DAY_MS = 86400000;
const FRESH_MS = 12 * 3600 * 1000;      // a future day is re-read after 12h (dates move)
const cache = new Map();                // 'YYYY-MM-DD' → { at, rows }

const isoOf = d => d.toISOString().slice(0, 10);

/** Weekdays from → to inclusive, ISO dates. Capped at 120 days. */
export function weekdays(fromISO, toISO) {
  const out = [];
  let d = new Date(fromISO + 'T12:00:00Z');
  const end = new Date(toISO + 'T12:00:00Z');
  for (let i = 0; d <= end && i < 120; i++, d = new Date(d.getTime() + DAY_MS)) {
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) out.push(isoOf(d));
  }
  return out;
}

/** Nasdaq's "time-pre-market" / "time-after-hours" / "time-not-supplied" → bmo / amc / unknown. */
export function timeOf(t) {
  const s = String(t || '').toLowerCase();
  if (s.includes('pre')) return 'bmo';
  if (s.includes('after')) return 'amc';
  return 'unknown';
}

/** One day's calendar reply → [{ symbol, name, date, time }]. */
export function parseDay(json, dateISO) {
  const rows = json && json.data && Array.isArray(json.data.rows) ? json.data.rows : [];
  return rows.filter(r => r && r.symbol).map(r => ({
    symbol: String(r.symbol).trim().toUpperCase(), name: r.name || '', date: dateISO, time: timeOf(r.time),
    fiscalQuarter: r.fiscalQuarterEnding || '', epsForecast: r.epsForecast || '',
  }));
}

async function fetchDay(dateISO, fetchImpl) {
  const hit = cache.get(dateISO);
  const past = dateISO < isoOf(new Date());
  if (hit && (past || Date.now() - hit.at < FRESH_MS)) return hit.rows;
  const f = fetchImpl || globalThis.fetch;
  if (!f) throw new Error('this Node has no fetch — Node 18 or newer is needed for earnings dates');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await f('https://api.nasdaq.com/api/calendar/earnings?date=' + dateISO, {
      headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error('Nasdaq ' + r.status);
    const rows = parseDay(await r.json(), dateISO);
    cache.set(dateISO, { at: Date.now(), rows });
    return rows;
  } finally { clearTimeout(t); }
}

/** "Earnings announcement* for NVDA: Nov 18, 2026" → '2026-11-18' (null when absent). */
const MON = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
export function parseNextDate(json) {
  const d = json && json.data;
  const text = [d && d.announcement, d && d.reportText].filter(Boolean).join(' ');
  const m = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? (\d{1,2}), (\d{4})/.exec(text);
  return m ? `${m[3]}-${String(MON[m[1]]).padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}

const nextCache = new Map();             // symbol → { at, date }
async function fetchNext(symbol, fetchImpl) {
  const hit = nextCache.get(symbol);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.date;
  const f = fetchImpl || globalThis.fetch;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await f(`https://api.nasdaq.com/api/analyst/${encodeURIComponent(symbol)}/earnings-date`, {
      headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error('Nasdaq ' + r.status);
    const date = parseNextDate(await r.json());
    nextCache.set(symbol, { at: Date.now(), date });
    return date;
  } finally { clearTimeout(t); }
}

/**
 * Earnings for the given symbols between two dates.
 *
 * Nasdaq's day calendar only lists about five weeks ahead; past that every day
 * fails. A run of failures at the END of the window is that horizon, not an error:
 * it is reported as `horizon` (the last day it lists), and for each symbol with no
 * report found before it, the company's next expected date is read instead and
 * added when it falls inside the window (marked estimated).
 * @returns { events: [{ symbol, name, date, time, estimated? }], checked, failed (gaps
 *            inside the listed range), horizon, unchecked (symbols past the horizon with
 *            no next date), complete, why }
 */
export async function earningsBetween(symbols, fromISO, toISO, { fetchImpl, concurrency = 4 } = {}) {
  const want = new Set((symbols || []).map(s => String(s).trim().toUpperCase()).filter(Boolean));
  const days = weekdays(fromISO, toISO);
  const failedAll = [], ok = [], events = [];
  let why = '';
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, days.length) }, async () => {
    while (i < days.length) {
      const d = days[i++];
      try { (await fetchDay(d, fetchImpl)).forEach(e => { if (!want.size || want.has(e.symbol)) events.push(e); }); ok.push(d); }
      catch (e) { failedAll.push(d); if (!why) why = e.message; }
    }
  }));
  ok.sort(); failedAll.sort();
  const lastOk = ok.length ? ok[ok.length - 1] : null;
  // Failures after the last listed day are the calendar's horizon; earlier ones are gaps.
  const failed = lastOk ? failedAll.filter(d => d < lastOk) : failedAll;
  const pastHorizon = lastOk ? failedAll.filter(d => d > lastOk) : [];
  const horizon = pastHorizon.length ? lastOk : null;
  const unchecked = [];
  if (horizon) {
    const found = new Set(events.map(e => e.symbol));
    for (const sym of want) {
      if (found.has(sym)) continue;           // its next report is already inside the listed range
      try {
        const date = await fetchNext(sym, fetchImpl);
        if (date && date >= fromISO && date <= toISO) events.push({ symbol: sym, name: '', date, time: 'unknown', estimated: true });
        else if (!date) unchecked.push(sym);
      } catch (e) { unchecked.push(sym); }
    }
  }
  events.sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol));
  return { events, checked: days.length, failed, horizon, unchecked,
    complete: failed.length === 0 && unchecked.length === 0 && (lastOk != null || !days.length), why };
}

export const _nextCacheForTests = nextCache;

export const _cacheForTests = cache;
