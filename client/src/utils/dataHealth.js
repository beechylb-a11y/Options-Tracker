// ── Data health (Nov 2026, review recommendation 4) ──
//
// Most of what went wrong in November was data, not the engine: XSP's stream line died
// and a fly priced off it for 18 hours; scans four minutes after a restart ranked names on
// blank IV; SPX bars read an hour early for weeks; a META ticket carried contracts TWS
// doesn't list; a second login cut every line to 10197. Each was found by hand. This puts
// the checks in one place and names the failure in plain words:
//
//  - quotes:  every streamed underlying — live, last value, delayed, stale, off — with
//             its age and any entitlement note; option legs summed by state.
//  - bars:    the latest session's 5-minute bars per underlying: 78 in a full day, the
//             first at 09:30 New York; a shifted first bar means the time zone was misread.
//  - settles: shadow verdicts past expiry that still have no outcome, by underlying.
//
// Pure functions; the panel and the banner fetch and draw.

import { freshnessOf } from '../live/liveStore.js';
import { barTimeET } from '../engine/managed.js';
import { expiryPassed } from '../engine/shadow.js';

export const OPEN_MIN = 9 * 60 + 30;
export const BELL_MIN = 16 * 60;
export const FULL_DAY_BARS = 78;          // 5-minute bars, 09:30–16:00
export const HALF_DAY_BARS = 42;          // early close 13:00
export const STALE_FLAG_MS = 5 * 60000;   // the bridge watchdog resubscribes at 5 min

const ET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false });
export function etNow(now = new Date()) {
  const p = Object.fromEntries(ET.formatToParts(now).map(x => [x.type, x.value]));
  const min = (p.hour === '24' ? 0 : +p.hour) * 60 + +p.minute;
  const wd = p.weekday;
  return { ymd: `${p.year}${p.month}${p.day}`, min, weekday: !['Sat', 'Sun'].includes(wd), rth: !['Sat', 'Sun'].includes(wd) && min >= OPEN_MIN && min < BELL_MIN };
}
const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const mins = ms => Math.max(1, Math.round(ms / 60000));

const ENT_TEXT = {
  10167: 'not entitled to live data: prior close only',
  10168: 'not entitled: delayed data off',
  10197: 'competing live session: another login is using the data',
  10090: 'part of the data not subscribed',
  10089: 'needs an extra subscription',
};

/**
 * One row per streamed underlying, plus the option legs summed by state.
 * @param state  liveStore state { connection, status, quotes }
 * @returns { bridge: 'off'|'down'|'noTws'|'ok', rows: [{ key, state, ok, tone, age, note }], legs: { n, byState, bad: [key] } }
 *   tone: 'ok' | 'warn' | 'bad'
 */
export function quoteHealth(state, { now = Date.now(), rth } = {}) {
  const s = state || {};
  const marketOpen = rth != null ? rth : etNow(new Date(now)).rth;
  const conn = s.connection || 'idle';
  const status = s.status || {};
  const bridge = conn === 'off' ? 'off' : conn !== 'open' ? 'down' : status.connected === false ? 'noTws' : 'ok';
  const opts = { now, connection: conn, bridgeConnected: status.connected !== false, farmOk: status.farmOk !== false, marketOpen };
  const rows = [];
  const legs = { n: 0, byState: {}, bad: [] };
  for (const [key, q] of Object.entries(s.quotes || {})) {
    const fresh = freshnessOf(q, opts);
    const age = q && q.ts ? now - q.ts : null;
    let st = fresh, tone = 'ok', note = '';
    if (q && q.noContract) { st = 'notListed'; tone = 'bad'; note = 'TWS does not list this contract'; }
    else if (q && q.notEntitled) {
      st = q.entCode === 10197 ? 'blocked' : 'notEntitled';
      tone = q.entCode === 10197 || !q.ts ? 'bad' : 'warn';
      note = ENT_TEXT[q.entCode] || 'not entitled to live data';
    } else if (fresh === 'off') { tone = bridge === 'ok' && marketOpen ? 'bad' : 'warn'; note = q && q.ts ? 'no stream' : 'no tick yet'; }
    else if (fresh === 'delayed') { tone = 'warn'; note = 'delayed: no real-time entitlement'; }
    else if (fresh === 'stale') { tone = age != null && age > STALE_FLAG_MS ? 'bad' : 'warn'; note = `no tick for ${mins(age)} min in the session`; }
    else if (fresh === 'frozen') note = 'market closed: last value';
    if (key.includes(' ')) {
      legs.n++;
      legs.byState[st] = (legs.byState[st] || 0) + 1;
      if (tone === 'bad') legs.bad.push(key);
      continue;
    }
    rows.push({ key, state: st, ok: tone === 'ok', tone, age, note });
  }
  rows.sort((a, b) => a.key.localeCompare(b.key));
  return { bridge, marketOpen, rows, legs };
}

/**
 * The latest session's 5-minute bars for one underlying.
 * @param bars  [{ date }] from /api/history (barSize 5 mins)
 * @returns null with no bars, else { ymd, count, expected, first, last, missing: [min], outside, shift, zone, tone, text }
 */
export function barHealth(bars, { now = new Date() } = {}) {
  const list = (bars || []).map(b => ({ b, t: barTimeET(b && b.date), raw: String((b && b.date) ?? '') })).filter(x => x.t);
  if (!list.length) return null;
  const ymd = list.reduce((m, x) => (x.t.ymd > m ? x.t.ymd : m), '');
  const day = list.filter(x => x.t.ymd === ymd);
  const zoneM = /\s([A-Za-z_]+\/[A-Za-z_]+|[A-Z]{3})\s*$/.exec(day[0].raw);
  const zone = zoneM ? zoneM[1] : /^\d{9,11}$/.test(day[0].raw.trim()) ? 'epoch' : 'none';
  const ms = [...new Set(day.map(x => x.t.min))].sort((a, b) => a - b);
  const inSession = ms.filter(m => m >= OPEN_MIN && m < BELL_MIN);
  const outside = ms.length - inSession.length;
  const first = ms[0], last = ms[ms.length - 1];
  // Expected: a full day, a half day that ended at 13:00, or today so far.
  const et = etNow(now);
  let expected = FULL_DAY_BARS, partial = false;
  if (ymd === et.ymd && et.rth) { expected = Math.max(0, Math.floor((et.min - OPEN_MIN) / 5)); partial = true; }
  else if (last != null && last <= 12 * 60 + 55 && last >= 12 * 60 + 50 && first === OPEN_MIN) expected = HALF_DAY_BARS;
  const slots = [];
  for (let m = OPEN_MIN; m < OPEN_MIN + expected * 5; m += 5) slots.push(m);
  const have = new Set(inSession);
  const missing = slots.filter(m => !have.has(m));
  // A whole session moved by an hour or more: the zone was read wrong (SPX's Chicago stamps, Oct).
  const shift = first != null && first !== OPEN_MIN && Math.abs(first - OPEN_MIN) >= 60 && (first - OPEN_MIN) % 60 === 0 && outside > 0 ? first - OPEN_MIN : 0;
  let tone = 'ok', text;
  if (shift) { tone = 'bad'; text = `bars start at ${hhmm(first)} New York, ${Math.abs(shift / 60)} h ${shift < 0 ? 'early' : 'late'}: the time zone (${zone}) was read wrong`; }
  else if (!inSession.length) { tone = 'bad'; text = `no regular-session bars on ${ymd}`; }
  else if (missing.length > 2) { tone = missing.length > expected / 4 ? 'bad' : 'warn'; text = `${inSession.length} of ${expected} bars${partial ? ' so far' : ''}: missing ${missing.slice(0, 3).map(hhmm).join(', ')}${missing.length > 3 ? ` and ${missing.length - 3} more` : ''}`; }
  else text = `${inSession.length} of ${expected} bars${partial ? ' so far' : ''}, first ${hhmm(first)}`;
  return { ymd, count: inSession.length, expected, first, last, missing, outside, shift, zone, tone, text };
}

/**
 * Shadow verdicts past expiry with no outcome yet.
 * @returns { due, settled, pending: [{ underlying, n, oldest }], managedPending, tone, text }
 */
export function settleHealth(rows, { now = new Date() } = {}) {
  const due = (rows || []).filter(r => r.expiry && expiryPassed(String(r.expiry).replace(/-/g, ''), now));
  const open = due.filter(r => !r.settled_at);
  const by = new Map();
  for (const r of open) {
    const k = r.underlying || '—';
    const g = by.get(k) || { underlying: k, n: 0, oldest: null };
    g.n++;
    const e = String(r.expiry).replace(/-/g, '');
    if (!g.oldest || e < g.oldest) g.oldest = e;
    by.set(k, g);
  }
  const pending = [...by.values()].sort((a, b) => b.n - a.n);
  const managedPending = due.filter(r => r.engine === '0DTE' && r.settled_at && !r.managed_at).length;
  const et = etNow(now);
  // A day's verdicts settle on the next press after the close: only older ones are a fault.
  const late = pending.filter(g => g.oldest < et.ymd);
  const tone = late.length ? (late.some(g => daysBetween(g.oldest, et.ymd) > 3) ? 'bad' : 'warn') : 'ok';
  const text = !due.length ? 'nothing past expiry yet'
    : !open.length ? `all ${due.length} past expiry settled${managedPending ? `; ${managedPending} 0DTE still need a managed exit` : ''}`
      : `${open.length} of ${due.length} past expiry not settled: ${pending.slice(0, 4).map(g => `${g.underlying} ${g.n}`).join(', ')}`;
  return { due: due.length, settled: due.length - open.length, pending, managedPending, tone, text };
}
function daysBetween(a, b) {
  const d = s => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  return Math.round((d(b) - d(a)) / 86400000);
}

/**
 * One line naming the worst failure first.
 * @param q  quoteHealth()   @param bars { SYM: barHealth() }   @param settle settleHealth() (optional)
 * @returns { tone: 'ok'|'warn'|'bad', text, items: [string] }
 */
export function healthHeadline(q, bars = {}, settle = null) {
  const found = [];
  const add = (t, text) => found.push({ t, text });
  if (q.bridge === 'off') { return { tone: 'warn', text: 'No bridge set: every number is typed or the model\'s', items: [] }; }
  if (q.bridge === 'down') { return { tone: 'bad', text: 'Bridge stream down: no live data reaching the app', items: [] }; }
  if (q.bridge === 'noTws') { return { tone: 'bad', text: 'Bridge up, TWS not connected: nothing new can arrive', items: [] }; }
  for (const r of q.rows) if (r.tone !== 'ok') add(r.tone, `${r.key} ${r.note}`);
  if (q.legs.bad.length) add('bad', `${q.legs.bad.length} option leg${q.legs.bad.length === 1 ? '' : 's'} ${q.legs.bad.length === 1 ? 'is' : 'are'} not live`);
  for (const [sym, b] of Object.entries(bars)) if (b && b.tone !== 'ok') add(b.tone, `${sym} ${b.text}`);
  if (settle && settle.tone !== 'ok') add(settle.tone, settle.text);
  // Worst first, then in the order checked (lines, legs, bars, settles).
  const items = found.map((f, i) => ({ ...f, i })).sort((a, b) => (a.t === b.t ? a.i - b.i : a.t === 'bad' ? -1 : 1)).map(f => f.text);
  const tone = found.some(f => f.t === 'bad') ? 'bad' : found.length ? 'warn' : 'ok';
  const text = !items.length ? 'All data checks pass' : items.length === 1 ? cap(items[0]) : `${cap(items[0])} · and ${items.length - 1} more`;
  return { tone, text, items };
}
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

/** The banner's rule: in the session only, and only for streamed underlyings that are
 *  off, blocked, not entitled or quiet past the watchdog's 5 minutes. */
export function bannerIssues(q) {
  if (!q.marketOpen || q.bridge !== 'ok') return [];
  return q.rows.filter(r => r.tone === 'bad' || r.state === 'notEntitled' || r.state === 'delayed');
}
