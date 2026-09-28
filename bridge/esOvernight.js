// ES overnight reference values, derived from 5-minute Globex bars (Sep 2026).
//
// The bridge used to take these straight from the live ES snapshot, which made
// every value depend on WHEN Auto-fill was clicked:
//   prior close  = IBKR's close tick, which flips from the prior settle to TODAY's
//                  settle at the end of the session (7803.75 -> 7746.75, minutes apart)
//   pre-open     = the live mid at click time, not 08:45 — and in the 17:00-18:00 ET
//                  halt the mid sits on stale quotes (7737 vs a 7746 last)
//   O/N high/low = the whole Globex session's range, RTH included
// Here each value is read off the bar that defines it, so the same session gives
// the same numbers at any hour. Pure functions; times are handled in ET.

const ET = 'America/New_York';
const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: ET, hour12: false, weekday: 'short',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
});

// epoch seconds -> { date:'YYYY-MM-DD', mins: minutes after ET midnight, wd:'Mon' }
export function etParts(epochSec) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(epochSec * 1000)).map(x => [x.type, x.value]));
  const h = p.hour === '24' ? 0 : Number(p.hour);
  return { date: `${p.year}-${p.month}-${p.day}`, mins: h * 60 + Number(p.minute), wd: p.weekday };
}

// Bars as delivered with formatDate=2: date is epoch seconds (string or number).
function norm(bars) {
  return (bars || [])
    .map(b => ({ t: Number(b.date), o: b.open, h: b.high, l: b.low, c: b.close }))
    .filter(b => isFinite(b.t) && b.t > 1e9 && b.c > 0)
    .sort((a, b) => a.t - b.t);
}

const HM = (h, m) => h * 60 + m;
const label = (date, hhmm) => {
  const d = new Date(date + 'T12:00:00Z');
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' }) + ' ' + hhmm;
};

// nowSec: current time (epoch s). Returns null when the bars can't answer.
//
// Session = the most recent RTH session whose 08:45 ET pre-open has passed (so
// after the close you still get the session just traded, matching the cash
// open/high/low the rest of the ticket shows). Before 08:45 it is the coming
// session, with pre-open = latest bar and preOpenFinal = false.
export function computeOvernight(rawBars, nowSec) {
  const bars = norm(rawBars);
  if (bars.length < 10) return null;
  const now = etParts(nowSec);
  const tagged = bars.map(b => ({ ...b, ...etParts(b.t) }));
  const weekday = d => !['Sat', 'Sun'].includes(d);

  // Session date: today if weekday and past 08:45 ET, else the next trading day
  // that has (or will have) bars — for the pre-08:45 case the latest bar's date.
  let sessionDate, preOpenFinal;
  if (weekday(now.wd) && now.mins >= HM(8, 45)) { sessionDate = now.date; preOpenFinal = true; }
  else {
    preOpenFinal = false;
    sessionDate = now.date;
    if (!weekday(now.wd)) {            // weekend -> the coming Monday
      const d = new Date(now.date + 'T12:00:00Z');
      d.setUTCDate(d.getUTCDate() + (now.wd === 'Sat' ? 2 : 1));
      sessionDate = d.toISOString().slice(0, 10);
    }
  }

  // Prior session close: the last bar that STARTS before 16:00 ET on a date
  // before the session date (skips weekends and holidays without a calendar).
  const prior = tagged.filter(b => b.date < sessionDate && b.mins < HM(16, 0) && b.mins >= HM(9, 30));
  if (!prior.length) return null;
  const pc = prior[prior.length - 1];
  const priorDate = pc.date;

  // Overnight window: 18:00 ET on the prior session date -> 09:30 ET session date.
  const inON = b => (b.date === priorDate && b.mins >= HM(18, 0)) ||
                    (b.date > priorDate && b.date < sessionDate) ||
                    (b.date === sessionDate && b.mins < HM(9, 30));
  const on = tagged.filter(inON);
  if (!on.length) return null;

  // Pre-open: the bar covering 08:40-08:45 on the session date, else (before
  // 08:45) the latest overnight bar.
  const pre = on.filter(b => b.date === sessionDate && b.mins < HM(8, 45));
  const preBar = pre.length ? pre[pre.length - 1] : on[on.length - 1];

  const hi = Math.max(...on.map(b => b.h)), lo = Math.min(...on.map(b => b.l));
  const r2 = x => Math.round(x * 100) / 100;
  const hhmm = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  const lastOn = on[on.length - 1];
  return {
    priorClose: r2(pc.c),
    priorCloseLabel: label(priorDate, '16:00'),
    preOpen: r2(preBar.c),
    preOpenLabel: preOpenFinal ? label(sessionDate, '08:45') : label(preBar.date, hhmm(preBar.mins + 5)) + ' (latest)',
    preOpenFinal,
    overnightHigh: r2(hi),
    overnightLow: r2(lo),
    overnightLabel: `${label(priorDate, '18:00')} → ${(now.date > sessionDate || (now.date === sessionDate && now.mins >= HM(9, 30))) ? label(sessionDate, '09:30') : label(lastOn.date, hhmm(lastOn.mins + 5))}`,
    sessionDate, priorDate, bars: on.length
  };
}
