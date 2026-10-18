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
  ].sort((a, b) => new Date(a[COL.ENTRY_DATE] || a[COL.CLOSE_DATE] || 0) - new Date(b[COL.ENTRY_DATE] || b[COL.CLOSE_DATE] || 0));
}

// Realised P&L for the local calendar day.
export function todayPnlOf(closedTrades) {
  const todayStr = localISODate();
  return closedTrades
    .filter(t => (t[COL.CLOSE_DATE] || t[COL.ENTRY_DATE] || '').split('T')[0] === todayStr)
    .reduce((s, t) => s + (parseFloat(t[COL.TOTAL_PNL]) || 0), 0);
}
