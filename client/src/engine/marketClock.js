// ── New York market clock for the header (Oct 2026) ──
//
// The app is run from Australia and Asia, where "today" is usually not New York's
// today. The header shows the New York date and time and where the session stands —
// pre-market, open (with the time to the 15:00 working exit and the 16:00 bell),
// after hours, weekend or holiday — and when the next session opens.
//
// Display only. The engines keep using tradingSession(), which does not know
// holidays; on a holiday this clock says so rather than counting down to an open
// that will not happen.

import { etClock } from './session.js';

// NYSE full-day holidays and 13:00 early closes. Refresh each year from
// https://www.nyse.com/markets/hours-calendars
export const NYSE_HOLIDAYS = {
  '2026-01-01': 'New Year’s Day', '2026-01-19': 'Martin Luther King Jr. Day', '2026-02-16': 'Washington’s Birthday',
  '2026-04-03': 'Good Friday', '2026-05-25': 'Memorial Day', '2026-06-19': 'Juneteenth', '2026-07-03': 'Independence Day (observed)',
  '2026-09-07': 'Labor Day', '2026-11-26': 'Thanksgiving', '2026-12-25': 'Christmas',
  '2027-01-01': 'New Year’s Day', '2027-01-18': 'Martin Luther King Jr. Day', '2027-02-15': 'Washington’s Birthday',
  '2027-03-26': 'Good Friday', '2027-05-31': 'Memorial Day', '2027-06-18': 'Juneteenth (observed)', '2027-07-05': 'Independence Day (observed)',
  '2027-09-06': 'Labor Day', '2027-11-25': 'Thanksgiving', '2027-12-24': 'Christmas (observed)',
};
export const NYSE_EARLY_CLOSE = { '2026-11-27': 13 * 60, '2026-12-24': 13 * 60, '2027-11-26': 13 * 60 };

const OPEN = 9 * 60 + 30, EXIT = 15 * 60, BELL = 16 * 60;
const pad = n => String(n).padStart(2, '0');
const isoOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const label = d => `${DAY[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`;
export const span = mins => {
  const m = Math.max(0, Math.round(mins));
  return m >= 60 ? `${Math.floor(m / 60)}h ${pad(m % 60)}m` : `${m}m`;
};
const isTradingDay = d => d.getDay() !== 0 && d.getDay() !== 6 && !NYSE_HOLIDAYS[isoOf(d)];

function nextTradingDay(d) {
  const out = new Date(d);
  for (let i = 0; i < 10; i++) { out.setDate(out.getDate() + 1); if (isTradingDay(out)) return out; }
  return out;
}

/**
 * @returns { time 'HH:MM', date 'Wed 21 Oct', iso, phase, tone, status, detail, next? }
 *   phase: pre | open | late | after | weekend | holiday
 *   tone:  blue | green | amber | grey
 */
export function marketClock(at = new Date()) {
  const et = etClock(at);
  const min = et.getHours() * 60 + et.getMinutes();
  const iso = isoOf(et);
  const bell = NYSE_EARLY_CLOSE[iso] || BELL;
  const exit = Math.min(EXIT, bell - 60);
  const base = { time: `${pad(et.getHours())}:${pad(et.getMinutes())}`, date: label(et), iso };
  const nxt = () => { const n = nextTradingDay(et); return { date: label(n), iso: isoOf(n) }; };
  const holiday = NYSE_HOLIDAYS[iso];
  if (holiday) {
    const n = nxt();
    return { ...base, phase: 'holiday', tone: 'grey', status: 'HOLIDAY', detail: `${holiday} — closed · next session ${n.date}`, next: n };
  }
  if (!isTradingDay(et)) {
    const n = nxt();
    return { ...base, phase: 'weekend', tone: 'grey', status: 'WEEKEND', detail: `next session ${n.date}`, next: n };
  }
  if (min < OPEN) return { ...base, phase: 'pre', tone: 'blue', status: 'PRE-MARKET', detail: `opens in ${span(OPEN - min)}` };
  if (min < exit) {
    return { ...base, phase: 'open', tone: 'green', status: 'OPEN',
      detail: `${span(exit - min)} to the ${pad(Math.floor(exit / 60))}:00 exit · ${span(bell - min)} to the bell${bell < BELL ? ' (early close)' : ''}` };
  }
  if (min < bell) return { ...base, phase: 'late', tone: 'amber', status: 'CLOSING', detail: `past the ${pad(Math.floor(exit / 60))}:00 0DTE exit · bell in ${span(bell - min)}` };
  const n = nxt();
  return { ...base, phase: 'after', tone: 'grey', status: 'CLOSED', detail: `next session ${n.date}`, next: n };
}
