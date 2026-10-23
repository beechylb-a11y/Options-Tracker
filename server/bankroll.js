// ── Live bankroll per account (Oct 2026) ──
//
// Each account's bankroll was a number typed into Settings and never moved, so
// PaperTrade sat at $25,000 through $5,000 of closed trades — and sizing, the
// daily-loss gauge and ROI all read that stale number. Now:
//
//   bankroll = starting bankroll + realised P&L since the account's start date
//
// Realised P&L, one dated item per closed piece, each counted once:
//   • engine tickets: every tranche on the Closes tab (net of fees); a ticket closed
//     before that tab existed carries its result on the Decisions row (Actual P&L)
//   • imported trades (TradeTracker), except the "TICKET-n" rows a close ticket
//     appends — those repeat an engine close already counted above
// Open P&L is not included: the bankroll is what has been banked.

const num = v => { const x = parseFloat(String(v ?? '').replace(/[$,\s]/g, '')); return Number.isFinite(x) ? x : null; };
const day = v => String(v || '').slice(0, 10);
const objs = rows => {
  const h = (rows && rows[0]) || [];
  return (rows || []).slice(1).map((r, i) => {
    const o = { _row: i + 2 };
    h.forEach((k, j) => { o[k] = r[j] ?? ''; });
    return o;
  });
};

/** → [{ account, date 'YYYY-MM-DD', pnl, source: 'close'|'ticket'|'import', ref }] */
export function realisedItems({ decRows, closeRows, trackerRows }) {
  const items = [];
  const decisions = objs(decRows);
  const closes = objs(closeRows);
  const withCloses = new Set();
  for (const c of closes) {
    const pnl = num(c['P&L ($)']);
    if (pnl == null) continue;
    const ref = String(c['Ticket Ref'] || '');
    if (ref) withCloses.add(ref);
    items.push({ account: c.Account || '', date: day(c['Close Date']), pnl, source: 'close', ref });
  }
  const counted = new Set(withCloses);
  for (const d of decisions) {
    const ref = String(d._row);
    if (withCloses.has(ref)) continue;
    const pnl = num(d['Actual P&L']);
    if (pnl == null || d.Status !== 'Closed') continue;
    counted.add(ref);
    items.push({ account: d.Account || '', date: day(d['Close Date'] || d.Timestamp), pnl, source: 'ticket', ref });
  }
  for (const t of objs(trackerRows)) {
    if (String(t.Status || '') === 'Open') continue;
    const pnl = num(t['Total P&L ($)']);
    if (pnl == null) continue;
    const m = /^TICKET-(\d+)$/.exec(String(t['Order #'] || '').trim());
    if (m && counted.has(m[1])) continue;                     // the engine close, already counted
    items.push({ account: t.Account || '', date: day(t['Close Date'] || t['Entry Date']), pnl, source: 'import', ref: t['Order #'] || '' });
  }
  return items;
}

/** The date an account's P&L counts from: its own setting, else when its journal starts. */
export const bankrollSinceOf = a => (a && (a.bankrollSince || a.journalSince)) || '';

// Risk limits follow the bankroll (Oct 2026): each is a % of the live bankroll. An
// account set up before that has only dollar limits; its % is the ratio it was set
// at (dollars ÷ starting bankroll), so nothing jumps on the day this ships — the
// limits just start moving with P&L from there.
export const DEFAULT_LOSS_PCT = 20, DEFAULT_RISK_PCT = 40;
const pctOf = (pct, dollars, start, dflt) => {
  const p = num(pct);
  if (p != null && p > 0) return p;
  const d = num(dollars);
  if (d != null && d > 0 && start > 0) return Math.round(d / start * 1000) / 10;
  return dflt;
};

/**
 * Accounts with live bankrolls: bankroll = startingBankroll + realised since bankrollSince,
 * and maxDailyLoss / maxOpenRisk as their % of that bankroll.
 * Adds realisedPnl, realisedCount, bankrollSince, lastTradeDate, maxDailyLossPct, maxOpenRiskPct.
 */
export function withLiveBankroll(accounts, items) {
  return (accounts || []).map(a => {
    const since = bankrollSinceOf(a);
    const mine = items.filter(i => i.account === a.id && (!since || i.date >= since));
    const realised = Math.round(mine.reduce((s, i) => s + i.pnl, 0) * 100) / 100;
    const start = num(a.startingBankroll) ?? num(a.bankroll) ?? 0;
    const bankroll = Math.round((start + realised) * 100) / 100;
    const lossPct = pctOf(a.maxDailyLossPct, a.maxDailyLoss, start, DEFAULT_LOSS_PCT);
    const riskPct = pctOf(a.maxOpenRiskPct, a.maxOpenRisk, start, DEFAULT_RISK_PCT);
    return { ...a, startingBankroll: start, bankroll,
      maxDailyLossPct: lossPct, maxOpenRiskPct: riskPct,
      maxDailyLoss: Math.max(0, Math.round(bankroll * lossPct / 100)),
      maxOpenRisk: Math.max(0, Math.round(bankroll * riskPct / 100)),
      realisedPnl: realised, realisedCount: mine.length, bankrollSince: since,
      lastTradeDate: mine.map(i => i.date).sort().pop() || '' };
  });
}

/** What Settings saves: the live figures are derived on every read, so they are not stored. */
export function stripLive(accounts) {
  return (accounts || []).map(a => {
    const { realisedPnl, realisedCount, lastTradeDate, ...rest } = a;   // eslint-disable-line no-unused-vars
    return rest;
  });
}
