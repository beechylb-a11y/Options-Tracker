// Batting average per account and overall (Nov 2026).
// Batting average = closed trades won ÷ all closed (scratches count), the same rule as
// the Dashboard. Overall is the real-money accounts together; paper is shown on its
// own and never counted in. Bands: red under 65, amber 65–75, green 75 and up.
import { mergeClosedTrades, isAggExcluded, battingAverage, BA_GREEN, BA_RED } from './stats';
import { accountColor } from './accountColors';

export const baZone = v => (v == null ? null : v >= BA_GREEN ? 'green' : v >= BA_RED ? 'amber' : 'red');
export const BA_COLOURS = { red: '#ff8f85', amber: '#ffd479', green: '#7ee2a0' };

const pnlOf = t => parseFloat(t['Total P&L ($)']) || 0;
const dateOf = t => String(t['Close Date'] || t['Entry Date'] || '').slice(0, 10);
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function tally(trades, from, to) {
  const s = (trades || []).filter(t => { const d = dateOf(t); return d && (!from || d > from) && d <= to; });
  const wins = s.filter(t => pnlOf(t) > 0).length;
  return { wins, total: s.length, ba: s.length ? battingAverage(wins, s.length) : null };
}

// days: a window ending today (null = all time). prev: the window before it, for the change.
export function battingByAccount({ tracker, decisions, accounts = [], todayISO, days = 90 }) {
  const from = days ? addDays(todayISO, -days) : null;
  const prevFrom = days ? addDays(todayISO, -2 * days) : null;
  const rows = accounts.map(a => {
    const trades = mergeClosedTrades(tracker, decisions, a.id, accounts).filter(t => (t.Account || '') === a.id);
    const cur = tally(trades, from, todayISO);
    return { id: a.id, name: a.name, color: accountColor(a.id, accounts), paper: isAggExcluded(a.id, accounts), ...cur };
  });
  const realTrades = mergeClosedTrades(tracker, decisions, 'all', accounts);
  const overall = tally(realTrades, from, todayISO);
  const prev = days ? tally(realTrades, prevFrom, from) : { ba: null };
  return {
    rows: rows.sort((x, y) => Number(x.paper) - Number(y.paper)),
    overall: { ...overall, change: overall.ba != null && prev.ba != null ? Math.round((overall.ba - prev.ba) * 10) / 10 : null },
  };
}
