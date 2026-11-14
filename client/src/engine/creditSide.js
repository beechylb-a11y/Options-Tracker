// ── 0DTE credit spread: side, strike anchor and entry time (Nov 2026) ──
//
// The engine picks a 0DTE structure from rating tables, and a credit vertical rarely
// wins. This is the other way in: build a credit spread on purpose, with the side and
// the strike distance set by what the replay found (tools/odte-timing-bt.js, 696 SPX
// sessions Jan 2024 – Nov 2026; project doc 0dte-verticals-timing-ema-nov2026.md).
//
//   Entry time   The 09:30 open was the worst entry for both sides. The first hour takes
//                ~20% off the move left but only ~14% off the priced range (tastylive's
//                16Δ curve); after 10:30 they shrink together. Window 10:30–12:30; the
//                priced range is half gone by 13:00.
//   Trend        Daily EMA 5/21/50 stack as of yesterday's close — the tastytrade chart.
//                It barely predicts the day (closes up 53% of up-stack days vs 51% of
//                down-stack days); the FIRST HOUR does (after a first hour up >0.15%, the
//                rest of the day closed up 61%; after a first hour down, 52%).
//   Side         Full-loss rates (close beyond short + width, 10:30, short at the IVX EM):
//                  EMA up            put 5.5%  call 3.5%   — selloffs are sharper than rallies
//                  EMA up, 1st up    put 5.5%  call 2.1%
//                  EMA up, 1st down  put 6.6%  call 4.9%
//                  down/mixed, 1st up    put 8.1%  call 9.3%
//                  down/mixed, 1st down  put 9.6%  call 16.4%  — relief rallies: no call spreads
//   Anchor       IVX EM by default; a full VIX1D EM when the stack is down or mixed (put
//                spreads there held up best; n = 69–140, small).
//
// Pure. Every input can be missing; the read degrades to "no call" rather than guessing.

export const FIRST_HOUR_FLAT = 0.15;            // % — inside this the first hour is "flat"

/** tastylive's median 16Δ range vs the open, by hours since 09:30 (Spina, 26 Sep 2026). */
export function rangeLeft(h) {
  const pts = [[0, 1], [1, 0.86], [2, 0.75], [3, 0.655], [3.5, 0.5]];
  if (!(h > 0)) return 1;
  if (h >= 6.5) return 0;
  if (h > 3.5) return 0.5 * Math.sqrt((6.5 - h) / 3);
  for (let i = 1; i < pts.length; i++) {
    const [a, fa] = pts[i - 1], [b, fb] = pts[i];
    if (h <= b) return fa + (fb - fa) * (h - a) / (b - a);
  }
  return 0.5;
}

function ema(closes, n) {
  const k = 2 / (n + 1);
  let e = null;
  for (const c of closes) e = e == null ? c : c * k + e * (1 - k);
  return e;
}

/**
 * Daily EMA 5/21/50 stack. bars = [[yyyymmdd, o, h, l, c], …] oldest first (the bridge's
 * `daily`). A bar dated today is still forming, so it is left out: the stack is as of
 * yesterday's close, which is what the replay used.
 */
export function emaStack(bars, todayYmd) {
  if (!Array.isArray(bars) || bars.length < 60) return null;
  const done = bars.filter(b => b && String(b[0]).slice(0, 8) !== String(todayYmd || ''));
  const closes = done.map(b => +b[4]).filter(x => x > 0);
  if (closes.length < 60) return null;
  const e5 = ema(closes, 5), e21 = ema(closes, 21), e50 = ema(closes, 50);
  const stack = e5 > e21 && e21 > e50 ? 'up' : e5 < e21 && e21 < e50 ? 'down' : 'mixed';
  return { e5, e21, e50, stack, last: closes[closes.length - 1] };
}

/**
 * The first hour from 30-minute bars (the bridge's /api/history): today's 09:30 open to
 * the close of the 10:00 bar. Bars: [{ date: 'yyyymmdd  hh:mm:ss', open, close }].
 * Before 10:30 it reports the move so far with done = false.
 */
export function firstHour(bars, nyMin) {
  if (!Array.isArray(bars) || !bars.length || nyMin == null || nyMin < 570) return null;
  // Regular-hours bars, so a session's first bar IS 09:30 ET and its second is 10:00,
  // whatever timezone TWS stamps them in (a Melbourne login dates them the next day).
  // The latest session in the series is today's once the market has opened.
  const rows = bars.map(b => ({ key: String(b.date || '').replace(/\D/g, ''), open: +b.open, close: +b.close }))
    .filter(b => b.key.length >= 12 && b.open > 0 && b.close > 0)
    .sort((a, b) => a.key.localeCompare(b.key));
  if (!rows.length) return null;
  const day = rows[rows.length - 1].key.slice(0, 8);
  const today = rows.filter(b => b.key.slice(0, 8) === day);
  // A session that started more than ~7 h before "now" is yesterday's (the bridge has
  // nothing for today yet): don't read yesterday's first hour as today's.
  if (today.length > Math.ceil((nyMin - 570) / 30) + 1) return null;
  const b0 = today[0];
  const b1 = today[1];
  const done = !!(b1 && (today.length >= 3 || nyMin >= 630));
  const at = done ? b1.close : today[today.length - 1].close;
  const movePct = (at - b0.open) / b0.open * 100;
  const dir = movePct > FIRST_HOUR_FLAT ? 'up' : movePct < -FIRST_HOUR_FLAT ? 'down' : 'flat';
  return { open: b0.open, at, movePct, dir, done };
}

/** Where the clock is for a new 0DTE credit spread. nyMin = minutes since midnight ET. */
export function entryWindow(nyMin) {
  if (nyMin == null || !isFinite(nyMin)) return { state: 'unknown', tone: 'grey', label: '' };
  const h = (nyMin - 570) / 60;                 // hours since 09:30
  const left = Math.round(rangeLeft(h) * 100);
  if (nyMin < 570) return { state: 'pre', tone: 'grey', label: 'Before the open', left: 100 };
  if (nyMin < 630) return { state: 'first-hour', tone: 'amber', label: 'First hour — wait for 10:30', left,
    why: 'The open was the worst entry in the replay: the first hour moves the most, and waiting costs only ~14% of the range.' };
  if (nyMin < 750) return { state: 'window', tone: 'green', label: 'Entry window 10:30–12:30', left };
  if (nyMin < 900) return { state: 'late', tone: 'amber', label: nyMin >= 780 ? 'Range half gone' : 'Late — range shrinking fast', left,
    why: 'By 13:00 the priced range is about half the open’s — less credit for the same tail risk.' };
  if (nyMin < 960) return { state: 'last', tone: 'red', label: 'Too late for new premium', left,
    why: 'Short premium sold in the last hour, and above all the last 30 minutes, lost money in tastylive’s work.' };
  return { state: 'closed', tone: 'grey', label: 'Market closed', left: 0 };
}

/**
 * The plan: which side, which strike anchor, and why.
 * side: 'put' | 'call' | null (no lean); blocked: { call?: reason }.
 * anchor: a vertVariant id in calc0dte — 'engine' (IVX EM) or 'em1d' (VIX1D EM).
 */
export function creditPlan({ ema: e, first: f } = {}) {
  const stack = e && e.stack;
  const fh = f && f.done ? f.dir : null;
  const weak = stack === 'down' || stack === 'mixed';
  const out = { side: null, anchor: weak ? 'em1d' : 'engine', blocked: {}, reasons: [] };
  if (weak && fh === 'down') {
    out.blocked.call = 'Relief-rally risk: with the trend down/mixed and a down first hour, 16% of call spreads went to a full loss in the replay.';
  }
  if (stack === 'up') {
    out.side = 'call';
    out.reasons.push(fh === 'up'
      ? 'Up-trend and an up first hour: call spreads went to a full loss 2.1% of the time vs 5.5% for puts.'
      : 'Up-trend: selloffs are sharper than rallies — call spreads hit a full loss less often (3.5% vs 5.5%).');
  } else if (weak) {
    out.side = 'put';
    out.reasons.push(fh === 'down'
      ? 'Trend down/mixed after a down first hour: puts only — and further out.'
      : 'Trend down/mixed: put spreads further out (a full VIX1D EM) held up best; relief rallies hurt call spreads.');
  } else if (fh) {
    out.side = fh === 'down' ? 'put' : 'call';
    out.reasons.push(fh === 'down' ? 'Down first hour: call spreads failed more often (9.2% vs 7.7%).'
      : 'First hour ' + fh + ': call spreads failed less often than puts.');
  }
  if (weak) out.reasons.push('Strikes: full VIX1D EM, not the IVX — the further anchor in a weak tape.');
  return out;
}
