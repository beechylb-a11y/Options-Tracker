// Single source of truth for aggregate / KPI rules.
// Tracker rows are objects keyed by sheet column names — use COL to avoid
// magic strings scattered across pages.
import { filterByAccount } from './format';
import { sessionDateOf } from '../engine/session';

export const COL = {
  ENTRY_DATE: 'Entry Date',
  CLOSE_DATE: 'Close Date',
  EXPIRY_DATE: 'Expiry Date',
  STRATEGY: 'Strategy (OIC)',
  UNDERLYING: 'Underlying',
  QTY: 'Qty',
  NET_CREDIT: 'Net Credit ($)',
  TOTAL_PNL: 'Total P&L ($)',
  WIN_LOSS: 'W / L',
  STATUS: 'Status',
  ACCOUNT: 'Account'
};

// Batting-average colour thresholds (%)
export const BA_GREEN = 60;
export const BA_RED = 40;

// PaperTrade is excluded from the aggregated "All accounts" view so it never
// distorts real-money P&L / batting average / streaks. The Account column
// stores account *ids*, so resolve PaperTrade's id by name (fallback to the
// literal string for any legacy rows tagged by name).
export function isAggExcluded(accountId, accounts = []) {
  const id = accountId || '';
  if (id === 'PaperTrade') return true;
  if (id.toLowerCase().startsWith('papertrade')) return true;
  return accounts.some(a =>
    a.id === id && (a.name || '').toLowerCase() === 'papertrade'
  );
}

// Filter tracker rows by account. When viewing all accounts, agg-excluded
// (paper) accounts are dropped.
export function filterTracker(rows, account, accounts = []) {
  if (!account || account === 'all') {
    return rows.filter(r => !isAggExcluded(r[COL.ACCOUNT] || '', accounts));
  }
  return filterByAccount(rows, account);
}

// KPI formulas (must stay identical to what Dashboard historically computed).
// `rows` are closed trades.
// One win/loss rule for every page (Oct 2026). Before this the Journal called a $0
// ticket a Win, Reports' strategy table called it a Loss, the Dashboard merge called
// it a Win. A $0 result is a scratch: it counts as a trade, not as a win or a loss.
export function wlOf(pnl) {
  const x = parseFloat(pnl);
  if (!Number.isFinite(x) || x === 0) return 'Scratch';
  return x > 0 ? 'Win' : 'Loss';
}
// The W/L a closed row carries, falling back to its P&L when the column is blank.
export function rowWl(t) {
  const w = t[COL.WIN_LOSS];
  return w === 'Win' || w === 'Loss' ? w : wlOf(t[COL.TOTAL_PNL]);
}
// Batting average — the ONE definition: wins ÷ all closed trades, scratches included
// (what the Dashboard has always shown). Journal, Reports and Analytics use this.
export const battingAverage = (wins, total) => (total > 0 ? wins / total * 100 : 0);

export function computeStats(rows) {
  const totalTrades = rows.length;
  const winRows = rows.filter(t => rowWl(t) === 'Win');
  const lossRows = rows.filter(t => rowWl(t) === 'Loss');
  const wins = winRows.length;
  const losses = lossRows.length;
  const scratches = totalTrades - wins - losses;
  const totalPnl = rows.reduce((s, t) => s + (parseFloat(t[COL.TOTAL_PNL]) || 0), 0);
  const avgWin = wins > 0 ? winRows.reduce((s, t) => s + (parseFloat(t[COL.TOTAL_PNL]) || 0), 0) / wins : 0;
  const avgLoss = losses > 0 ? lossRows.reduce((s, t) => s + (parseFloat(t[COL.TOTAL_PNL]) || 0), 0) / losses : 0;
  const battingAvg = battingAverage(wins, totalTrades);
  const expectancy = totalTrades > 0 ? totalPnl / totalTrades : 0;
  return { totalPnl, wins, losses, scratches, battingAvg, avgWin, avgLoss, expectancy };
}

// Merge closed TradeTracker rows with closed Decision-ticket rows into one
// tracker-shaped, date-sorted list. Single source of truth so Dashboard and
// the header strip can never disagree on "today's P&L".
export function mergeClosedTrades(tracker, decisions, account, accounts = []) {
  const isAggregate = !account || account === 'all';
  const filteredTracker = filterTracker(tracker || [], account, accounts);
  const filteredDecisions = isAggregate
    ? (decisions || []).filter(d => !isAggExcluded(d.Account || '', accounts))
    : (decisions || []).filter(d => {
        const decAccount = d.Account || '';
        return decAccount === account || !decAccount;
      });
  const closedTickets = filteredDecisions
    .filter(d => d.Status === 'Closed' && d['Actual P&L'])
    .map(d => ({
      // The ticket's New York session, not the UTC day of its timestamp (a 20:00 ET
      // log is the next UTC day). Same rule as the Journal.
      'Entry Date': sessionDateOf(d.Timestamp) || d.Timestamp?.split('T')[0] || '',
      'Close Date': d['Close Date'] || sessionDateOf(d.Timestamp) || d.Timestamp?.split('T')[0] || '',
      'Expiry Date': '',
      'Strategy (OIC)': (d.Strategy || '').split(' - ').slice(1, -1).join(' - ') || d.Strategy,
      Underlying: d.Underlying || '',
      Qty: d.Contracts || 1,
      // Premium taken in (+) or paid (−), $ for all contracts — Reports sums it.
      'Net Credit ($)': Number.isFinite(parseFloat(d['Net Debit/Credit']))
        ? String(Math.round(parseFloat(d['Net Debit/Credit']) * 100 * (parseFloat(d.Contracts) || 1) * 100) / 100) : '',
      'Total P&L ($)': d['Actual P&L'],
      'W / L': wlOf(d['Actual P&L']),
      Status: 'Closed',
      Account: d.Account || '',
      _source: 'ticket'
    }));
  // Every engine close is stored twice: the ticket itself (Status Closed, Actual P&L)
  // and a "TICKET-<row>" TradeTracker row per tranche, appended by the close ticket.
  // Journal and the monthly benchmark already drop those tracker rows; this merge did
  // not, so the Dashboard, its daily bars and the header strip counted every engine
  // trade twice. (Oct 2026.) The ticket wins, as on those pages — it carries the
  // whole trade's P&L across tranches. A TICKET row is only dropped when its ticket
  // is here as a closed trade, so a tranche whose ticket is still Partial (or is
  // filtered out) is not lost.
  const ticketRows = new Set(filteredDecisions
    .filter(d => d.Status === 'Closed' && d['Actual P&L'] && d._rowIndex != null)
    .map(d => String(d._rowIndex)));
  const ticketRowOf = t => {
    const m = /^TICKET-(\d+)$/.exec(String(t['Order #'] || '').trim());
    return m ? m[1] : null;
  };
  return [
    ...filteredTracker.filter(t => {
      if (t.Status === 'Open' || !t[COL.TOTAL_PNL]) return false;
      const ref = ticketRowOf(t);
      return !(ref && ticketRows.has(ref));
    }),
    ...closedTickets
  // In CLOSE-date order (entry date breaks ties): the equity curve and daily bars are
  // plotted by close date, and "recent closed" means the latest closes. Sorting by
  // entry let the curve run backwards in time. (Oct 2026.)
  ].sort((a, b) => {
    const k = t => String(t[COL.CLOSE_DATE] || t[COL.ENTRY_DATE] || '').slice(0, 10);
    const e = t => String(t[COL.ENTRY_DATE] || '').slice(0, 10);
    return k(a) < k(b) ? -1 : k(a) > k(b) ? 1 : e(a) < e(b) ? -1 : e(a) > e(b) ? 1 : 0;
  });
}

// Today's date in New York — the trading day. Close dates are stored as the NY
// session date; the browser's local date is a day ahead for most of an Australian
// or Asian morning, so "Today" read $0 while the session's closes sat under
// "yesterday". (Oct 2026.)
export function nyISODate(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(d).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

// Realised P&L for today's New York trading day.
export function todayPnlOf(closedTrades, now = new Date()) {
  const todayStr = nyISODate(now);
  return closedTrades
    .filter(t => (t[COL.CLOSE_DATE] || t[COL.ENTRY_DATE] || '').split('T')[0] === todayStr)
    .reduce((s, t) => s + (parseFloat(t[COL.TOTAL_PNL]) || 0), 0);
}

// What the engine said when a ticket was logged, as a short label. The tickets list
// only knew 'Trade' / 'Trade with caution', but tickets log the engine's grade
// ('Strong setup', 'Marginal setup', …) or 'Roll' — so every one read "✗ No",
// including trades taken. (Oct 2026.)
export function directionBadge(dir) {
  const d = String(dir || '').trim();
  if (/^trade$|strong|decent|^take/i.test(d)) return { icon: '✓', text: 'Go', tone: 'green' };
  if (/caution|marginal|smaller/i.test(d)) return { icon: '⚠', text: 'Caution', tone: 'amber' };
  if (/roll/i.test(d)) return { icon: '↻', text: 'Roll', tone: 'blue' };
  if (/weak|no trade|^pass|block/i.test(d)) return { icon: '✗', text: 'No', tone: 'red' };
  return { icon: '·', text: d ? d.replace(/ setup$/i, '') : '—', tone: 'grey' };
}
