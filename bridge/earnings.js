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

/**
 * Earnings for the given symbols between two dates.
 * @returns { events: [{ symbol, name, date, time }], checked: n days, failed: [dates], complete }
 */
export async function earningsBetween(symbols, fromISO, toISO, { fetchImpl, concurrency = 4 } = {}) {
  const want = new Set((symbols || []).map(s => String(s).trim().toUpperCase()).filter(Boolean));
  const days = weekdays(fromISO, toISO);
  const failed = [], events = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, days.length) }, async () => {
    while (i < days.length) {
      const d = days[i++];
      try { (await fetchDay(d, fetchImpl)).forEach(e => { if (!want.size || want.has(e.symbol)) events.push(e); }); }
      catch (e) { failed.push(d); }
    }
  }));
  events.sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol));
  failed.sort();
  return { events, checked: days.length, failed, complete: failed.length === 0 };
}

export const _cacheForTests = cache;
