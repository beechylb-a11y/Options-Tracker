// ── Expiry choices for time spreads (Oct 2026) ──
//
// A calendar or diagonal is two expiries, and the engine used to say only "short
// front-month / long back-month" with no dates. These helpers turn a list of
// listed expiries (from the bridge's /api/option-chain) — or, without the bridge,
// the weekly Fridays every index/ETF we trade lists — into near/far choices.
// Dates are YYYYMMDD strings, the format TWS uses; "today" is the NY session date.

const pad = n => String(n).padStart(2, '0');
export const toYmd = d => d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
const fromYmd = s => new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), 12);
export const ymdFromIso = iso => String(iso || '').replace(/-/g, '');
export const isoFromYmd = s => s ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : '';

export function dteBetween(todayYmd, ymd) {
  return Math.round((fromYmd(ymd) - fromYmd(todayYmd)) / 86400000);
}
export function addDaysYmd(ymd, n) {
  const d = fromYmd(ymd); d.setDate(d.getDate() + n); return toYmd(d);
}

// Weekly Fridays after today, about a year out. The fallback when the bridge
// has no chain; it is what TWS lists for SPXW, SPY, QQQ and IWM, holidays aside.
export function fridaysFrom(todayYmd, days = 400) {
  const out = [];
  const d = fromYmd(todayYmd);
  d.setDate(d.getDate() + 1);
  while (d.getDay() !== 5) d.setDate(d.getDate() + 1);
  const end = fromYmd(addDaysYmd(todayYmd, days));
  while (d <= end) { out.push(toYmd(d)); d.setDate(d.getDate() + 7); }
  return out;
}

// The listed expiry closest to target, at least minDte away.
export function nearestExpiry(list, todayYmd, targetYmd, minDte = 1) {
  let best = null, bestGap = Infinity;
  for (const e of list || []) {
    if (dteBetween(todayYmd, e) < minDte) continue;
    const gap = Math.abs(dteBetween(targetYmd, e));
    if (gap < bestGap) { best = e; bestGap = gap; }
  }
  return best;
}

// Defaults: the short (near) leg at the ticket's DTE; the long (far) leg about a
// month later for a calendar, six weeks for a diagonal.
export function timeSpreadDefaults(strategy, dte, list, todayYmd) {
  const n = Math.max(7, parseInt(dte, 10) || 45);
  const near = nearestExpiry(list, todayYmd, addDaysYmd(todayYmd, n), 7);
  if (!near) return { near: null, far: null };
  const gap = /diagonal/i.test(strategy || '') ? 42 : 28;
  const far = nearestExpiry((list || []).filter(e => e > near), todayYmd, addDaysYmd(near, gap), 1);
  return { near, far };
}

// Up to `count` choices around the selected near expiry, and after it for the far.
export function nearChoices(list, todayYmd, near, count = 5) {
  const ok = (list || []).filter(e => dteBetween(todayYmd, e) >= 7);
  const i = Math.max(0, ok.indexOf(near));
  const start = Math.max(0, Math.min(i - Math.floor(count / 2), ok.length - count));
  return ok.slice(start, start + count);
}
export function farChoices(list, near, far, count = 5) {
  const after = (list || []).filter(e => e > near);
  // weekly listings are dense: thin them to roughly one a week, keeping `far`
  const i = Math.max(0, after.indexOf(far));
  const start = Math.max(0, Math.min(i - Math.floor(count / 2), after.length - count));
  return after.slice(start, start + count);
}

// "20 Nov" for a YYYYMMDD expiry.
export function fmtExpiry(ymd) {
  if (!ymd) return '';
  return fromYmd(ymd).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

// Which expiry a time-spread leg trades: its label says front/near/short-dated or
// back/far/long-dated. Anything else (single-expiry structures) gets none.
export function legRole(label) {
  const l = String(label || '').toLowerCase();
  if (/front|near|short-dated/.test(l)) return 'near';
  if (/back|far|long-dated/.test(l)) return 'far';
  return null;
}
