// Vision Dashboard numbers (Nov 2026). Pure helpers over the closed-trade set every
// page already shares (utils/stats.mergeClosedTrades), so the cards cannot disagree
// with the header, the Journal or Analytics. Dates are New York session dates.

const DAY = 864e5;
const pnlOf = t => parseFloat(t['Total P&L ($)']) || 0;
const dateOf = t => String(t['Close Date'] || t['Entry Date'] || '').slice(0, 10);
const iso = d => d.toISOString().slice(0, 10);
const at = s => new Date(s + 'T12:00:00Z');
const addDays = (s, n) => iso(new Date(at(s).getTime() + n * DAY));
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function mondayOfISO(s) { const d = at(s); const k = (d.getUTCDay() + 6) % 7; return addDays(s, -k); }
const round = x => Math.round(x * 100) / 100;

/**
 * The P&L card's line for a period: running total, a point per close (today) or per
 * trading day (week, month), starting from zero. Steps are the last five changes.
 * @param period 'today' | 'week' | 'month'
 */
export function periodSeries(trades, period, todayISO) {
  const all = (trades || []).filter(t => dateOf(t));
  let rows = [];
  if (period === 'today') {
    let cum = 0;
    rows = all.filter(t => dateOf(t) === todayISO).map(t => {
      const p = pnlOf(t); cum += p;
      return { label: t.Underlying || '—', pnl: round(p), cum: round(cum) };
    });
  } else {
    const start = period === 'week' ? mondayOfISO(todayISO) : todayISO.slice(0, 8) + '01';
    let cum = 0;
    for (let d = start; d <= todayISO; d = addDays(d, 1)) {
      const dow = at(d).getUTCDay();
      if (dow === 0 || dow === 6) continue;
      const p = all.filter(t => dateOf(t) === d).reduce((a, t) => a + pnlOf(t), 0);
      cum += p;
      rows.push({ label: period === 'week' ? DOW[dow] : String(Number(d.slice(8))), date: d, pnl: round(p), cum: round(cum) });
    }
  }
  const total = rows.length ? rows[rows.length - 1].cum : 0;
  const count = period === 'today' ? rows.length
    : all.filter(t => dateOf(t) >= (period === 'week' ? mondayOfISO(todayISO) : todayISO.slice(0, 8) + '01') && dateOf(t) <= todayISO).length;
  return { points: [{ label: '', cum: 0, pnl: 0 }, ...rows], steps: rows.filter(r => r.pnl !== 0).slice(-5), total, count };
}

/** Trades closed per week, the last n weeks oldest first, and the change on last week. */
export function weekCounts(trades, todayISO, n = 8) {
  const mon = mondayOfISO(todayISO);
  const weeks = Array.from({ length: n }, (_, i) => addDays(mon, -7 * (n - 1 - i)));
  const counts = weeks.map(w => (trades || []).filter(t => { const d = dateOf(t); return d >= w && d < addDays(w, 7); }).length);
  const now = counts[n - 1], prev = counts[n - 2] || 0;
  return { weeks, counts, now, prev, change: prev > 0 ? Math.round((now - prev) / prev * 100) : null };
}

/**
 * Realised P&L bars. week: Mon–Fri of this week; month: each week of this month;
 * year: each of the last twelve months. The current bar is flagged.
 */
export function realisedBars(trades, mode, todayISO) {
  const sum = (a, b) => (trades || []).filter(t => { const d = dateOf(t); return d >= a && d < b; }).reduce((s, t) => s + pnlOf(t), 0);
  if (mode === 'week') {
    const mon = mondayOfISO(todayISO);
    return [0, 1, 2, 3, 4].map(i => { const d = addDays(mon, i); return { label: DOW[i + 1], pnl: round(sum(d, addDays(d, 1))), now: d === todayISO, future: d > todayISO }; });
  }
  if (mode === 'month') {
    const first = todayISO.slice(0, 8) + '01';
    const next = iso(new Date(Date.UTC(+todayISO.slice(0, 4), +todayISO.slice(5, 7), 1, 12)));
    const out = [];
    for (let w = mondayOfISO(first); w < next; w = addDays(w, 7)) {
      const a = w < first ? first : w, b = addDays(w, 7) > next ? next : addDays(w, 7);
      out.push({ label: `${Number(a.slice(8))}–${Number(addDays(b, -1).slice(8))}`, pnl: round(sum(a, b)), now: todayISO >= a && todayISO < b, future: a > todayISO });
    }
    return out;
  }
  const y = +todayISO.slice(0, 4), m = +todayISO.slice(5, 7) - 1;
  return Array.from({ length: 12 }, (_, i) => {
    const mm = m - 11 + i, d0 = new Date(Date.UTC(y, mm, 1, 12)), d1 = new Date(Date.UTC(y, mm + 1, 1, 12));
    return { label: MON[d0.getUTCMonth()], pnl: round(sum(iso(d0), iso(d1))), now: i === 11, future: false };
  });
}

/** Win rate over the last `days` and the change on the window before it (in points). Scratches don't count. */
export function winRateWindow(trades, todayISO, days = 90) {
  const rate = (a, b) => {
    const s = (trades || []).filter(t => { const d = dateOf(t); return d > a && d <= b && pnlOf(t) !== 0; });
    return { n: s.length, rate: s.length ? s.filter(t => pnlOf(t) > 0).length / s.length * 100 : null };
  };
  const cur = rate(addDays(todayISO, -days), todayISO), prev = rate(addDays(todayISO, -2 * days), addDays(todayISO, -days));
  return { ...cur, prev: prev.rate, change: cur.rate != null && prev.rate != null ? Math.round((cur.rate - prev.rate) * 10) / 10 : null };
}

/** This month so far: tickets opened (engine decisions), closed, won, lost. */
export function monthActivity(trades, decisions, todayISO, sessionDateOf = s => String(s || '').slice(0, 10)) {
  const m = todayISO.slice(0, 7);
  const closed = (trades || []).filter(t => dateOf(t).startsWith(m));
  const opened = (decisions || []).filter(d => {
    const s = String(d.Status || '').toLowerCase();
    return !/cancel/.test(s) && sessionDateOf(d.Timestamp).startsWith(m);
  }).length;
  return { opened, closed: closed.length, won: closed.filter(t => pnlOf(t) > 0).length, lost: closed.filter(t => pnlOf(t) < 0).length };
}

/**
 * What needs you on the open book: a 45DTE position at or inside 21 DTE is a roll /
 * close decision (the tastylive rule the engine plans with); a 0DTE position still open
 * after 13:30 New York is past its time exit.
 * @param rows /api/positions/open rows; expiries: ticketRef → { expiry: 'yyyymmdd' }
 */
export function needsYou(rows, expiries, { todayYmd, nyMinutes }) {
  const out = [];
  const days = (a, b) => Math.round((Date.UTC(+b.slice(0, 4), +b.slice(4, 6) - 1, +b.slice(6, 8)) - Date.UTC(+a.slice(0, 4), +a.slice(4, 6) - 1, +a.slice(6, 8))) / DAY);
  for (const r of rows || []) {
    if (!(Number(r.qtyOpen) > 0)) continue;
    const ex = expiries && expiries[r.ticketRef] && expiries[r.ticketRef].expiry;
    const dte = ex ? days(todayYmd, ex) : null;
    if (/45/.test(r.engine || '') && dte != null && dte <= 21) out.push({ row: r, kind: 'roll', title: 'Roll due', badge: `${dte} DTE`, dte });
    else if (/0dte/i.test(r.engine || '') && nyMinutes >= 13 * 60 + 30) out.push({ row: r, kind: 'exit', title: 'Exit due', badge: 'past 13:30', dte });
  }
  return out;
}

/** Projected month return (% of the bank at the start of the month) at today's pace. */
export function paceForMonth(pnl, startBank, todayISO) {
  const y = +todayISO.slice(0, 4), m = +todayISO.slice(5, 7);
  const daysIn = new Date(Date.UTC(y, m, 0)).getUTCDate(), d = Number(todayISO.slice(8, 10));
  if (!(startBank > 0) || !d) return null;
  return Math.round(pnl * daysIn / d / startBank * 1000) / 10;
}
