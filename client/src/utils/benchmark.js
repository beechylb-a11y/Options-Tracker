// Journal returns: the month on its own, the financial year as the running total,
// and each against a monthly benchmark (target return %, e.g. 10% a month).
//
// Each account carries, typed on the Journal page:
//   journalTargetPct — monthly target return %. Blank = DEFAULT_TARGET_PCT.
//   journalInvested — starting bank, the money put in (the base returns are on)
//   journalSince    — YYYY-MM-DD; only P&L on/after this date counts toward the
//                     running total. Set it to the day the invested figure was
//                     true and history before it isn't double counted. Blank =
//                     count everything.
// When journalInvested is blank the account's startingBankroll stands in, so the
// card is useful before anything has been entered.
//
// P&L events use the SAME rules as the Journal calendar's dayStats, so the running
// total always reconciles with the coloured days:
//   * TradeTracker rows: closed (Status !== 'Open'), dated Close Date || Entry Date,
//     TICKET- rows skipped (they duplicate engine tickets).
//   * Engine tickets: Status 'Closed' with an Actual P&L, dated Close Date ||
//     session date of the Timestamp.
import { isAggExcluded } from './stats';
import { sessionDateOf } from '../engine/session';

const day = s => String(s || '').split('T')[0];

export function closedPnlEvents(tracker = [], decisions = []) {
  const out = [];
  tracker.forEach(t => {
    if (t.Status === 'Open') return;
    if (String(t['Order #'] || '').startsWith('TICKET-')) return;
    const date = day(t['Close Date']) || day(t['Entry Date']);
    if (!date) return;
    out.push({ date, pnl: parseFloat(t['Total P&L ($)']) || 0, account: t.Account || '' });
  });
  decisions.forEach(d => {
    if (d.Status !== 'Closed' || !d['Actual P&L']) return;
    const date = day(d['Close Date']) || sessionDateOf(d.Timestamp);
    if (!date) return;
    out.push({ date, pnl: parseFloat(d['Actual P&L']) || 0, account: d.Account || '' });
  });
  return out;
}

export const DEFAULT_TARGET_PCT = 10;

export function benchmarkOf(acct) {
  if (!acct) return { invested: 0, since: '', fromStarting: false, targetPct: DEFAULT_TARGET_PCT, targetDefault: true };
  const typed = parseFloat(acct.journalInvested);
  const has = isFinite(typed);
  const tp = parseFloat(acct.journalTargetPct);
  return {
    invested: has ? typed : (parseFloat(acct.startingBankroll) || 0),
    since: acct.journalSince || '',
    fromStarting: !has,
    targetPct: isFinite(tp) ? tp : DEFAULT_TARGET_PCT,
    targetDefault: !isFinite(tp),
  };
}

// Australian financial year: 1 July – 30 June. Returns the FY's first month.
export function fyStartOf(year, month) {
  return month >= 6 ? { year, month: 6 } : { year: year - 1, month: 6 };
}
export function fyLabel(year, month) {
  const s = fyStartOf(year, month).year;
  return `FY${String(s + 1).slice(-2)}`; // FY27 = Jul 2026 – Jun 2027
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Everything the Journal card shows for the month on screen.
//   month — that month only: bank at month start, P&L of trades closed in the
//           month, return %, and the benchmark (target % × month-start bank)
//   fy    — running total from 1 July to the end of the month on screen, one row
//           per month, with the benchmark accumulated the same way
//   since — the original view: value and return on the starting bank
export function journalSummary(account, accounts, events, year, month) {
  const scope = scopeFor(account, accounts, events);
  // One target % for the view: each account's target weighted by its starting bank.
  const w = scope.members.reduce((s, a) => s + benchmarkOf(a).invested, 0);
  const targetPct = scope.members.length === 0 ? DEFAULT_TARGET_PCT
    : w > 0 ? scope.members.reduce((s, a) => s + benchmarkOf(a).targetPct * benchmarkOf(a).invested, 0) / w
    : scope.members.reduce((s, a) => s + benchmarkOf(a).targetPct, 0) / scope.members.length;
  const targetDefault = scope.members.every(a => benchmarkOf(a).targetDefault);

  const pad = n => String(n).padStart(2, '0');
  const prefix = `${year}-${pad(month + 1)}`;
  const rt = runningTotal(scope, year, month);
  const monthEvents = scope.events.filter(e => e.date.startsWith(prefix));
  const wins = monthEvents.filter(e => e.pnl > 0).length;
  const losses = monthEvents.filter(e => e.pnl < 0).length;
  const targetAmt = rt.startValue * targetPct / 100;
  const monthOut = {
    start: rt.startValue, end: rt.endValue, pnl: rt.monthPnl,
    returnPct: rt.monthReturnPct, trades: monthEvents.length, wins, losses,
    avgPerTrade: monthEvents.length ? rt.monthPnl / monthEvents.length : 0,
    targetPct, targetAmt, vsTarget: rt.monthPnl - targetAmt,
  };

  const fs = fyStartOf(year, month);
  const rows = [];
  let cumPnl = 0, cumTarget = 0, y = fs.year, m = fs.month;
  for (;;) {
    const r = runningTotal(scope, y, m);
    const t = r.startValue * targetPct / 100;
    cumPnl += r.monthPnl; cumTarget += t;
    rows.push({ label: MON[m], year: y, month: m, start: r.startValue, pnl: r.monthPnl,
      returnPct: r.monthReturnPct, target: t, cumPnl, cumTarget });
    if (y === year && m === month) break;
    m++; if (m > 11) { m = 0; y++; }
  }
  const fyStart = rows[0].start;
  const fyOut = {
    label: fyLabel(year, month), rows, start: fyStart, pnl: cumPnl, target: cumTarget,
    returnPct: fyStart > 0 ? (cumPnl / fyStart) * 100 : null,
    targetReturnPct: fyStart > 0 ? (cumTarget / fyStart) * 100 : null,
    vsTarget: cumPnl - cumTarget,
  };

  return {
    members: scope.members, targetDefault,
    month: monthOut, fy: fyOut,
    since: { invested: rt.invested, value: rt.endValue, pnl: rt.totalPnl, returnPct: rt.totalReturnPct },
  };
}

// Which accounts make up the current view, and the events that belong to it.
// 'all' = every real-money account (PaperTrade excluded, as everywhere else).
// A single account also picks up untagged rows — the Journal calendar does the same.
export function scopeFor(account, accounts = [], events = []) {
  const isAll = !account || account === 'all';
  const members = isAll
    ? accounts.filter(a => !isAggExcluded(a.id, accounts))
    : accounts.filter(a => a.id === account);
  const sinceById = {};
  members.forEach(a => { sinceById[a.id] = benchmarkOf(a).since; });
  const scoped = events.filter(e => {
    if (isAll) {
      if (isAggExcluded(e.account, accounts)) return false;
    } else if (e.account && e.account !== account) {
      return false;
    }
    const since = sinceById[e.account] ?? (isAll ? '' : sinceById[account]) ?? '';
    return !since || e.date >= since;
  });
  const invested = members.reduce((s, a) => s + benchmarkOf(a).invested, 0);
  return { members, events: scoped, invested };
}

// Running total for one calendar month.
//   startValue  — invested + everything realised before the month
//   endValue    — invested + everything realised up to the month's last day
//   series      — one point per day of the month: running value at that day's close
//   monthPnl / monthReturnPct — the month on its own, against startValue
//   totalPnl / totalReturnPct — since the benchmark, against invested
export function runningTotal({ invested, events }, year, month) {
  const pad = n => String(n).padStart(2, '0');
  const first = `${year}-${pad(month + 1)}-01`;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const last = `${year}-${pad(month + 1)}-${pad(daysInMonth)}`;
  let before = 0;
  const byDay = {};
  events.forEach(e => {
    if (e.date < first) before += e.pnl;
    else if (e.date <= last) byDay[e.date] = (byDay[e.date] || 0) + e.pnl;
  });
  const startValue = invested + before;
  let running = startValue;
  const series = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${year}-${pad(month + 1)}-${pad(d)}`;
    running += byDay[key] || 0;
    series.push({ day: d, date: key, value: running, pnl: byDay[key] || 0 });
  }
  const endValue = running;
  const monthPnl = endValue - startValue;
  const totalPnl = endValue - invested;
  return {
    invested, startValue, endValue, series, monthPnl, totalPnl,
    monthReturnPct: startValue > 0 ? (monthPnl / startValue) * 100 : null,
    totalReturnPct: invested > 0 ? (totalPnl / invested) * 100 : null,
  };
}

// Slices for a return pie. `invested` is the base (the month-start bank for the
// month pie), `totalPnl` the result on it. Up: base plus what came back on top.
// Down: what is left of the base, plus what was lost. Losses past the whole
// invested amount still show as one full red circle.
export function pieSlices({ invested, totalPnl }) {
  if (totalPnl >= 0) {
    return [
      { key: 'invested', name: 'Invested', value: Math.max(0, invested) },
      { key: 'returned', name: 'Returned', value: totalPnl },
    ].filter(s => s.value > 0);
  }
  const lost = Math.min(-totalPnl, Math.max(invested, -totalPnl));
  return [
    { key: 'remaining', name: 'Remaining', value: Math.max(0, invested + totalPnl) },
    { key: 'lost', name: 'Lost', value: lost },
  ].filter(s => s.value > 0);
}
