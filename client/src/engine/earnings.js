// ── Earnings risk on a ticket (Oct 2026) ──
//
// The macro calendar covers CPI, FOMC and payrolls. A single stock has its own,
// bigger event: earnings — a gap the size of a month's move overnight, then the
// implied vol that priced it collapsing. This checks the ticket's underlying (and,
// for an index or index ETF, its biggest names) against the earnings dates the
// bridge reads from Nasdaq.
//
// Warn-only, like the macro events: it never blocks a trade. Same rules too —
// warnings gate the verdict ("Trade with caution"), notices never do, and a
// calendar that could not be read is a notice saying so, never silence.
//
// Data: { status: 'ok' | 'partial' | 'unavailable', events: [{ symbol, date (ISO), time: bmo|amc|unknown }],
//         failed: [ISO dates], error? }

const INDEX = ['SPX', 'SPXW', 'XSP', 'NDX', 'NDXP', 'RUT', 'RUTW', 'VIX', 'OEX', 'XEO', 'DJX'];
const ETF = ['SPY', 'QQQ', 'IWM', 'DIA', 'GLD', 'SLV', 'TLT', 'HYG', 'XLF', 'XLE', 'XLK', 'SMH', 'EEM', 'EFA', 'ARKK', 'USO', 'IBIT'];

// The names big enough to move the index on their own, with rough weights (%).
// Approximate and slow-moving; refresh once a year or so.
export const HOLDINGS = {
  NDX: { NVDA: 9, MSFT: 8, AAPL: 8, AMZN: 5, AVGO: 5, META: 4, GOOGL: 3, GOOG: 3, TSLA: 3, NFLX: 2 },
  SPX: { NVDA: 7, MSFT: 6, AAPL: 6, AMZN: 4, META: 3, AVGO: 2.5, GOOGL: 2, GOOG: 2, TSLA: 2 },
};
const HOLDINGS_OF = { QQQ: 'NDX', NDX: 'NDX', NDXP: 'NDX', SPY: 'SPX', SPX: 'SPX', SPXW: 'SPX', XSP: 'SPX', OEX: 'SPX', XEO: 'SPX' };
const BIG_WEIGHT = 5;      // a name this large reacting today moves a 0DTE on the index

export const isSingleStock = u => { const s = String(u || '').toUpperCase(); return !!s && !INDEX.includes(s) && !ETF.includes(s); };
export const holdingsOf = u => HOLDINGS[HOLDINGS_OF[String(u || '').toUpperCase()]] || null;

/** Symbols worth asking the calendar about for this underlying. */
export function earningsSymbols(underlying) {
  const u = String(underlying || '').toUpperCase();
  if (isSingleStock(u)) return [u];
  const h = holdingsOf(u);
  return h ? Object.keys(h) : [];
}

const TIME = { bmo: 'before the open', amc: 'after the close', unknown: 'time not given' };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = iso => `${+iso.slice(8, 10)} ${MON[+iso.slice(5, 7) - 1]}`;
const addDaysISO = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
/** The previous weekday (holidays are not known here; a Monday looks back to Friday). */
export function prevWeekday(iso) {
  let d = addDaysISO(iso, -1);
  while ([0, 6].includes(new Date(d + 'T12:00:00Z').getUTCDay())) d = addDaysISO(d, -1);
  return d;
}

/** The date window to ask the bridge for: the previous session (0DTE) through expiry. */
export function earningsWindow(todayISO, dte) {
  return { from: prevWeekday(todayISO), to: addDaysISO(todayISO, Math.max(0, Math.round(dte || 0))) };
}

// Only a single stock gets the "not checked" notice: for an index the big names
// are context, and saying so on every SPX ticket while the bridge is off is noise.
function coverage(data, underlying, own) {
  if (!own) return [];
  if (!data || data.status === 'unavailable') {
    return [`Earnings not checked${data && data.error ? ` (${data.error})` : ''} — ${own ? `${underlying}'s` : 'the index’s largest names’'} report dates are unknown for this ticket; check them before trading`];
  }
  if (data.unchecked && data.unchecked.includes(underlying)) {
    return [data.horizon
      ? `Earnings checked to ${dayLabel(data.horizon)} only — Nasdaq lists no expected date for ${underlying} after that; check it before holding past ${dayLabel(data.horizon)}`
      : `Earnings date not found for ${underlying}${data.why ? ` (${data.why})` : ''} — check it before trading`];
  }
  if (data.status === 'partial' && data.failed && data.failed.length) {
    return [`Earnings calendar unreadable for ${data.failed.length} day${data.failed.length > 1 ? 's' : ''} in this window (${data.failed.slice(0, 3).map(dayLabel).join(', ')}${data.failed.length > 3 ? '…' : ''}) — those days are unchecked`];
  }
  return [];
}

/**
 * 0DTE: only the reaction day matters. A report before today's open, or after the
 * previous close, is today's gap and today's IV crush; one after today's close lands
 * after the option has expired.
 */
export function earningsRisk0DTE({ underlying, todayISO, earnings }) {
  const u = String(underlying || '').toUpperCase();
  const own = isSingleStock(u);
  const warnings = [], notices = coverage(earnings, u, own), hits = [];
  const evs = (earnings && earnings.events) || [];
  const prev = prevWeekday(todayISO);
  const h = holdingsOf(u);
  for (const e of evs) {
    const mine = e.symbol === u;
    if (!mine && !(h && h[e.symbol])) continue;
    const reactingToday = (e.date === todayISO && e.time === 'bmo') || (e.date === prev && e.time === 'amc');
    const name = mine ? u : `${e.symbol} (≈${h[e.symbol]}% of ${u})`;
    if (reactingToday) {
      hits.push(e);
      const msg = `${name} reported ${e.date === prev ? 'after yesterday’s close' : 'before today’s open'} — today is the reaction: a gap at the open, ranges wider than usual, and the implied vol that priced the report draining away`;
      if (mine || h[e.symbol] >= BIG_WEIGHT) warnings.push(msg); else notices.push(msg);
    } else if (e.date === todayISO) {
      hits.push(e);
      if (e.time === 'amc') notices.push(`${name} reports after today’s close — after a 0DTE expires; today's IV is still carrying it`);
      else if (mine) warnings.push(`${u} reports today, ${TIME[e.time]} — check the time before trading a 0DTE`);
      else notices.push(`${name} reports today, ${TIME[e.time]}`);
    }
  }
  return { warnings, notices, events: hits };
}

/**
 * 45DTE: anything before the planned close (closeDte before expiry) is held through.
 * Short premium through earnings is a different trade — a gap through a short strike
 * with no time to recover, and the IV rank that made it look rich was the report.
 * After the planned close but before expiry: close first.
 * The index's big names are notices only: in earnings season one of them reports
 * inside almost every 45-day window, and a permanent warning teaches you to stop
 * reading warnings.
 */
export function earningsRisk45DTE({ underlying, todayISO, dte, closeDte = 21, earnings }) {
  const u = String(underlying || '').toUpperCase();
  const own = isSingleStock(u);
  const warnings = [], notices = coverage(earnings, u, own), hits = [];
  const evs = (earnings && earnings.events) || [];
  const expiryISO = addDaysISO(todayISO, Math.max(0, Math.round(dte || 0)));
  const closeISO = addDaysISO(expiryISO, -closeDte);
  const h = holdingsOf(u);
  for (const e of evs) {
    if (e.date < todayISO || e.date > expiryISO) continue;
    const mine = e.symbol === u;
    if (!mine && !(h && h[e.symbol])) continue;
    hits.push(e);
    const when = `${dayLabel(e.date)}, ${e.estimated ? 'expected date (not yet confirmed)' : TIME[e.time]}`;
    const beforeClose = e.date <= closeISO;
    if (mine) {
      if (beforeClose) warnings.push(`${u} earnings ${when} — inside the hold, before your ${closeDte}-DTE close on ${dayLabel(closeISO)}. Expect a gap through the strikes and IV collapsing after; today's IV rank is partly that report. Held through earnings this is a different trade — smaller size, or wait until it has reported`);
      else notices.push(`${u} earnings ${when} — after your planned ${closeDte}-DTE close (${dayLabel(closeISO)}) but before expiry: close on plan, don't hold into it`);
    } else {
      notices.push(`${e.symbol} (≈${h[e.symbol]}% of ${u}) reports ${when}${beforeClose ? ', inside the hold' : ', after your planned close'}`);
    }
  }
  return { warnings, notices, events: hits, expiryISO, closeISO };
}
