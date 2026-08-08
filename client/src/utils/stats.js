// Single source of truth for aggregate / KPI rules.
// Tracker rows are objects keyed by sheet column names — use COL to avoid
// magic strings scattered across pages.
import { filterByAccount, localISODate } from './format';

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
export function computeStats(rows) {
  const totalTrades = rows.length;
  const winRows = rows.filter(t => t[COL.WIN_LOSS] === 'Win');
  const lossRows = rows.filter(t => t[COL.WIN_LOSS] === 'Loss');
  const wins = winRows.length;
  const losses = lossRows.length;
  const scratches = totalTrades - wins - losses;
  const totalPnl = rows.reduce((s, t) => s + (parseFloat(t[COL.TOTAL_PNL]) || 0), 0);
  const avgWin = wins > 0 ? winRows.reduce((s, t) => s + (parseFloat(t[COL.TOTAL_PNL]) || 0), 0) / wins : 0;
  const avgLoss = losses > 0 ? lossRows.reduce((s, t) => s + (parseFloat(t[COL.TOTAL_PNL]) || 0), 0) / losses : 0;
  const battingAvg = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
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
      'Entry Date': d.Timestamp?.split('T')[0] || '',
      'Close Date': d['Close Date'] || d.Timestamp?.split('T')[0] || '',
      'Expiry Date': '',
      'Strategy (OIC)': (d.Strategy || '').split(' - ').slice(1, -1).join(' - ') || d.Strategy,
      Underlying: d.Underlying || '',
      Qty: d.Contracts || 1,
      'Net Credit ($)': '',
      'Total P&L ($)': d['Actual P&L'],
      'W / L': parseFloat(d['Actual P&L']) >= 0 ? 'Win' : 'Loss',
      Status: 'Closed',
      Account: d.Account || '',
      _source: 'ticket'
    }));
  return [
    ...filteredTracker.filter(t => t.Status !== 'Open' && t[COL.TOTAL_PNL]),
    ...closedTickets
  ].sort((a, b) => new Date(a[COL.ENTRY_DATE] || a[COL.CLOSE_DATE] || 0) - new Date(b[COL.ENTRY_DATE] || b[COL.CLOSE_DATE] || 0));
}

// Realised P&L for the local calendar day.
export function todayPnlOf(closedTrades) {
  const todayStr = localISODate();
  return closedTrades
    .filter(t => (t[COL.CLOSE_DATE] || t[COL.ENTRY_DATE] || '').split('T')[0] === todayStr)
    .reduce((s, t) => s + (parseFloat(t[COL.TOTAL_PNL]) || 0), 0);
}
