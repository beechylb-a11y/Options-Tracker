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

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Why a request failed, in words: Node's "fetch failed" hides the real reason
// (connection reset, DNS, TLS) in err.cause.
const reason = e => {
  const c = e && e.cause;
  return [e && e.message, c && (c.code || c.message)].filter(Boolean).join(': ') || 'unknown error';
};

async function getNasdaq(url, fetchImpl) {
  const f = fetchImpl || globalThis.fetch;
  if (!f) throw new Error('this Node has no fetch — Node 18 or newer is needed for earnings dates');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await f(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' },
      signal: ctrl.signal,
    });
    if (!r.ok) { const e = new Error('Nasdaq ' + r.status); e.status = r.status; throw e; }
    return await r.json();
  } finally { clearTimeout(t); }
}

// Nasdaq starts refusing a burst of requests (connections reset part-way through a
// 50-day sweep, Oct 2026). So: one at a time, a pause between, a retry with backoff,
// and a result kept until it is replaced — a refused refresh serves the last good one.
async function polite(fn, { retries = 2, backoff = [800, 2000] } = {}) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (e && e.status && e.status < 500 && e.status !== 429) break;     // a real "no", not a hiccup
      if (i < retries) await sleep(backoff[Math.min(i, backoff.length - 1)]);
    }
  }
  throw last;
}

async function fetchDay(dateISO, fetchImpl, opts = {}) {
  const hit = cache.get(dateISO);
  const past = dateISO < isoOf(new Date());
  if (hit && (past || Date.now() - hit.at < FRESH_MS)) return hit.rows;
  try {
    const rows = parseDay(await polite(() => getNasdaq('https://api.nasdaq.com/api/calendar/earnings?date=' + dateISO, fetchImpl), opts), dateISO);
    cache.set(dateISO, { at: Date.now(), rows });
    return rows;
  } catch (e) {
    if (hit) return hit.rows;                       // stale beats nothing
    throw e;
  }
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
async function fetchNext(symbol, fetchImpl, opts = {}) {
  const hit = nextCache.get(symbol);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.date;
  try {
    const date = parseNextDate(await polite(() => getNasdaq(`https://api.nasdaq.com/api/analyst/${encodeURIComponent(symbol)}/earnings-date`, fetchImpl), opts));
    nextCache.set(symbol, { at: Date.now(), date });
    return date;
  } catch (e) {
    if (hit) return hit.date;
    throw e;
  }
}

/**
 * Earnings for the given symbols between two dates — with as few requests as it
 * takes, because Nasdaq refuses bursts:
 *   1. each symbol's next expected report date (one request per symbol)
 *   2. the day calendar for the first two weekdays of the window (a 0DTE's
 *      reaction day: yesterday after the close, today before the open) and for
 *      each next date that falls inside the window (for before/after the market
 *      and to confirm it)
 *   3. a symbol whose next-date request failed: the day calendar for every day in
 *      the window, one at a time — the slow path, only when needed
 * A report found only from the next-date page is marked estimated.
 * @returns { events: [{ symbol, name, date, time, estimated? }], checked (days read),
 *            failed (days that could not be read), unchecked (symbols with no date
 *            found and no full sweep), complete, why }
 */
export async function earningsBetween(symbols, fromISO, toISO, { fetchImpl, delayMs = 300, retries = 2, backoff } = {}) {
  const want = [...new Set((symbols || []).map(s => String(s).trim().toUpperCase()).filter(Boolean))];
  const opts = { retries, backoff: backoff || (delayMs ? [800, 2000] : [0]) };
  const all = weekdays(fromISO, toISO);
  const failed = new Set(), read = new Set();
  let why = '';
  const note = e => { if (!why) why = reason(e); };
  const pause = () => (delayMs ? sleep(delayMs) : null);
  // Fail fast: three network failures in a row (timeouts, resets — not an HTTP
  // answer) mean Nasdaq is not talking to this machine right now; asking 30 more
  // times only makes the ticket wait minutes for the same answer.
  let netFails = 0;
  const NET_LIMIT = 3;
  const down = () => netFails >= NET_LIMIT;
  const track = e => { if (e && e.status) netFails = 0; else netFails++; };

  // 1. next expected dates
  const next = {}, nextFailed = [];
  for (const sym of want) {
    if (down()) { nextFailed.push(sym); continue; }
    try { next[sym] = await fetchNext(sym, fetchImpl, opts); netFails = 0; } catch (e) { nextFailed.push(sym); note(e); track(e); }
    await pause();
  }
  // 2. the days that matter; 3. a full sweep only for symbols we could not place
  const days = new Set(all.slice(0, 2));
  Object.values(next).forEach(d => { if (d && d >= fromISO && d <= toISO) days.add(d); });
  if (nextFailed.length) all.forEach(d => days.add(d));
  const byDay = {};
  for (const d of [...days].sort()) {
    if (down()) { failed.add(d); continue; }
    try { byDay[d] = await fetchDay(d, fetchImpl, opts); read.add(d); netFails = 0; } catch (e) { failed.add(d); note(e); track(e); }
    await pause();
  }
  const events = [], seen = new Set();
  Object.entries(byDay).forEach(([d, rows]) => rows.forEach(e => {
    if (want.includes(e.symbol)) { events.push(e); seen.add(e.symbol + '|' + d); }
  }));
  for (const sym of want) {
    const d = next[sym];
    if (d && d >= fromISO && d <= toISO && !seen.has(sym + '|' + d)) events.push({ symbol: sym, name: '', date: d, time: 'unknown', estimated: true });
  }
  // A symbol we could not place: unchecked unless every day of the window was read.
  const sweptAll = all.every(d => read.has(d));
  const unchecked = want.filter(sym => !(sym in next) && !sweptAll);
  events.sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol));
  return { events, checked: read.size + failed.size, failed: [...failed].sort(), horizon: null, unchecked,
    complete: failed.size === 0 && unchecked.length === 0, why: down() && why ? `${why} — Nasdaq not answering this machine; stopped asking` : why };
}

export const _nextCacheForTests = nextCache;

export const _cacheForTests = cache;
