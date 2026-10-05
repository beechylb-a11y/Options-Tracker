// Which US trading session a moment belongs to.
//
// Everything here exists because the engine is run from Australia. At 07:48 AEST
// the browser instant converts to 17:48 ET the PREVIOUS day — after the cash
// close — so every "today in ET" derivation produced the session that had just
// finished rather than the one about to start. That single mistake was printing
// tickets with yesterday's date, filing them against yesterday in the trade log,
// and fetching greeks for an expiry that had already expired.
//
// The rule: a moment belongs to the session whose cash close it still precedes.
// Past 16:00 ET, or on a weekend, it belongs to the next weekday. (Sep 2026.)

export const ET_TZ = 'America/New_York';

// Cash close. 16:00 is when the session ENDS — used only to decide which session
// a moment belongs to. HOURS_CLOSE is 15:00 because that is the engine's working
// exit time and what every 0DTE score has always been calibrated against; the two
// are deliberately different numbers and changing the second moves every score.
const SESSION_END_H = 16;
const HOURS_CLOSE_H = 15;
const OPEN_MINUTES = 9 * 60 + 30;
const FULL_SESSION_H = HOURS_CLOSE_H - 9.5;   // 09:30 → 15:00

const pad = n => String(n).padStart(2, '0');

// ET wall clock as a plain Date whose LOCAL fields read as New York's. Arithmetic
// on it is safe for same-day comparisons, which is all we do with it.
export function etClock(at = new Date()) {
  return new Date(at.toLocaleString('en-US', { timeZone: ET_TZ }));
}

function nextWeekday(d) {
  const out = new Date(d);
  do { out.setDate(out.getDate() + 1); } while (out.getDay() === 0 || out.getDay() === 6);
  return out;
}

const isoOf = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

// The session a moment belongs to: { dateISO, yyyymmdd, isNextSession, hoursLeft,
// phase }. phase is for display only — nothing branches on it.
//
// Market holidays are NOT handled: there is no holiday calendar in the client, so
// a print made the evening before Thanksgiving dates itself to a closed Thursday.
// The weekend roll covers the common case; the holiday case is visible (the wrong
// date is printed on the ticket) rather than silent.
export function tradingSession(at = new Date()) {
  const et = etClock(at);
  const minutes = et.getHours() * 60 + et.getMinutes();
  const dow = et.getDay();
  const isWeekend = dow === 0 || dow === 6;
  const afterClose = minutes >= SESSION_END_H * 60;

  const day = (isWeekend || afterClose) ? nextWeekday(et) : et;
  const isNextSession = day !== et;

  let hoursLeft;
  let phase;
  if (isNextSession) {
    // Nothing of that session has happened yet.
    hoursLeft = FULL_SESSION_H;
    phase = isWeekend ? 'weekend' : 'after close';
  } else if (minutes < OPEN_MINUTES) {
    hoursLeft = FULL_SESSION_H;
    phase = 'pre-open';
  } else {
    hoursLeft = Math.max(0, (HOURS_CLOSE_H * 60 - minutes) / 60);
    phase = hoursLeft > 0 ? 'open' : 'closing hour';
  }

  return {
    dateISO: isoOf(day),
    yyyymmdd: isoOf(day).replace(/-/g, ''),
    isNextSession,
    phase,
    hoursLeft: Math.round(hoursLeft * 10) / 10,
    // Hours to the 16:00 CASH BELL, which is when options actually expire. hoursLeft
    // above measures to the 15:00 working close and is what every 0DTE score is
    // calibrated against; the two are different questions and both are needed —
    // one for scoring, one for anything that models time to expiry.
    hoursToBell: Math.round(Math.max(0,
      isNextSession || minutes < OPEN_MINUTES ? FULL_SESSION_H + 1
        : (SESSION_END_H * 60 - minutes) / 60) * 10) / 10,
    // The real ET wall clock, for the "generated at" line. The session date and the
    // clock time can legitimately disagree and the print should show both.
    etTime: pad(et.getHours()) + ':' + pad(et.getMinutes()),
    etDateISO: isoOf(et),
  };
}

// The session date of a STORED instant — the same rule, applied after the fact, so
// a logged ticket and its printed summary agree about which day they belong to.
// Returns '' for anything unparseable rather than a wrong date.
export function sessionDateOf(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return tradingSession(d).dateISO;
}

// ── Dates that must read in New York, not on the computer (Oct 2026) ──
//
// Two different questions, and mixing them was the bug:
//   * Which session is a TICKET for? Fixed by when the ticket was built, not by
//     when you happen to print it. A ticket priced during Monday's session and
//     printed at 16:19 ET was being dated Tuesday — the next-session rule above,
//     applied to the print instant — which in Melbourne is also the computer's
//     date, so it looked like local time leaking in.
//   * On which NY date did something already HAPPEN (a close, a fill)? The most
//     recent session that has opened, never the next one.

// The session a ticket belongs to.
//   loggedAt  — when it was written to the log: decides outright.
//   createdAt — when its tab was opened: a tab opened after the close is prep for
//               the next session, one opened during the session is that session.
//   pricedAt  — the last market-data pull. A pull DURING a later session moves a
//               reused tab forward to it; an after-close pull moves nothing.
// Returns the tradingSession() shape for the chosen instant plus `basis`.
export function ticketSession({ loggedAt, createdAt, pricedAt } = {}, now = new Date()) {
  const valid = x => x != null && x !== '' && !isNaN(new Date(x).getTime());
  if (valid(loggedAt)) return { ...tradingSession(new Date(loggedAt)), basis: 'logged' };
  let best = null;
  if (valid(createdAt)) best = { ...tradingSession(new Date(createdAt)), basis: 'opened' };
  if (valid(pricedAt)) {
    const p = tradingSession(new Date(pricedAt));
    if (!p.isNextSession && (!best || p.dateISO > best.dateISO)) best = { ...p, basis: 'priced' };
  }
  return best || { ...tradingSession(now), basis: 'now' };
}

// NY date of the most recent session that has opened — the default date for
// anything being RECORDED (a close, a manual entry). 16:19 ET Monday → Monday;
// 08:00 ET Tuesday (before the open) → Monday; Saturday → Friday.
export function lastSessionDate(at = new Date()) {
  const et = etClock(at);
  const minutes = et.getHours() * 60 + et.getMinutes();
  const d = new Date(et);
  const dow = d.getDay();
  const beforeOpen = minutes < OPEN_MINUTES;
  if (dow === 0 || dow === 6 || beforeOpen) {
    do { d.setDate(d.getDate() - 1); } while (d.getDay() === 0 || d.getDay() === 6);
  }
  return isoOf(d);
}

// "Mon 5 Oct 2026" for an ISO session date, read as a calendar date (no timezone).
export function fmtSessionDate(iso, opts = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) {
  if (!iso) return '';
  const d = new Date(iso + 'T12:00:00');
  return isNaN(d) ? '' : d.toLocaleDateString('en-AU', opts).replace(',', '');
}

// Short NY session label for a stored instant: "5 Oct".
export function sessionLabelOf(ts) {
  return fmtSessionDate(sessionDateOf(ts), { day: 'numeric', month: 'short' });
}
