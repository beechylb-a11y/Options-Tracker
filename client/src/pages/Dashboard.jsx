import React, { useState, useEffect, useMemo } from 'react';
import { BarChart, Bar, ComposedChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, ReferenceLine } from 'recharts';
import { TrendingUp, TrendingDown, Target, DollarSign, Percent, Activity, Flame, Calendar } from 'lucide-react';
import { api } from '../utils/api';
import OpenPositions from '../components/OpenPositions';
import UpcomingExpiries from '../components/UpcomingExpiries';
import { fmt$, fmtPct, fmtDate, fmtDateShort, pnlColor, localISODate } from '../utils/format';
import { filterTracker, computeStats, mergeClosedTrades, BA_GREEN, BA_RED } from '../utils/stats';
import ErrorBanner from '../components/ErrorBanner';
import { eventOutlook, nowET } from '../engine/events';

const RANGE_KEY = 'ot_dash_range';
const RANGES = ['MTD', '30D', '90D', 'YTD', 'All'];

export default function Dashboard({ authenticated, account, accounts = [] }) {
  const [stats, setStats] = useState(null);
  const [config, setConfig] = useState({});
  const [tracker, setTracker] = useState([]);
  const [decisions, setDecisions] = useState([]);
  const [journal, setJournal] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const [range, setRange] = useState(() => {
    try {
      const v = localStorage.getItem(RANGE_KEY);
      return RANGES.includes(v) ? v : 'All';
    } catch { return 'All'; }
  });

  const changeRange = (r) => {
    setRange(r);
    try { localStorage.setItem(RANGE_KEY, r); } catch { /* ignore */ }
  };

  useEffect(() => {
    if (!authenticated) { setLoading(false); return; }
    setLoadError(false);
    Promise.all([
      api.getStats(account).catch(() => { setLoadError(true); return { stats: {}, config: {} }; }),
      api.getTracker().catch(() => { setLoadError(true); return []; }),
      api.getJournal().catch(() => { setLoadError(true); return []; }),
      api.getDecisions().catch(() => { setLoadError(true); return []; })
    ]).then(([s, t, j, d]) => {
      setStats(s.stats); setConfig(s.config); setTracker(t); setJournal(j);
      // Parse decisions if raw arrays
      if (Array.isArray(d) && d.length > 0 && d[0]._rowIndex !== undefined) {
        setDecisions(d);
      } else {
        setDecisions([]);
      }
      setLoading(false);
    });
  }, [authenticated, account, retryTick]);

  // ── Account-filtered data ──
  // PaperTrade exclusion + account filtering live in utils/stats.js
  // (single source of truth for aggregate rules).
  const filteredTracker = useMemo(
    () => filterTracker(tracker, account, accounts),
    [tracker, account, accounts]
  );

  // Merge closed decision tickets into trades (shared with the header strip)
  const closedTrades = useMemo(
    () => mergeClosedTrades(tracker, decisions, account, accounts),
    [tracker, decisions, account, accounts]
  );

  // ── Date-range filter (Close Date, fallback Entry Date) — the single
  // filtered array feeding ALL derived KPIs, equity curve, daily bars,
  // streaks. Open positions / expiries are current-state and unaffected. ──
  const rangedTrades = useMemo(() => {
    if (range === 'All') return closedTrades;
    const now = new Date();
    let start;
    if (range === 'MTD') start = new Date(now.getFullYear(), now.getMonth(), 1);
    else if (range === 'YTD') start = new Date(now.getFullYear(), 0, 1);
    else if (range === '30D') start = new Date(now.getTime() - 30 * 86400000);
    else if (range === '90D') start = new Date(now.getTime() - 90 * 86400000);
    else return closedTrades;
    const startStr = localISODate(start);
    return closedTrades.filter(t => {
      const d = (t['Close Date'] || t['Entry Date'] || '').split('T')[0];
      return d && d >= startStr;
    });
  }, [closedTrades, range]);

  // ── Heavy derivations, computed once per data/range change ──
  const derived = useMemo(() => {
    const trades = rangedTrades;
    const { totalPnl, battingAvg, avgWin, avgLoss, expectancy } = computeStats(trades);

    // Equity curve (cumulative P&L) + drawdown in $ from peak
    let cum = 0, peak = 0, maxDrawdownDollar = 0;
    const equityCurve = trades.map(t => {
      const pnl = parseFloat(t['Total P&L ($)']) || 0;
      cum += pnl;
      const cumPnl = Math.round(cum * 100) / 100;
      if (cumPnl > peak) peak = cumPnl;
      const dd = Math.round((peak - cumPnl) * 100) / 100;
      if (dd > maxDrawdownDollar) maxDrawdownDollar = dd;
      return {
        date: (t['Close Date'] || t['Entry Date'] || '').split('T')[0],
        cumPnl, pnl, drawdown: -dd
      };
    });

    // Streaks
    let currentStreak = 0, streakType = '';
    let longestWinStreak = 0, longestLossStreak = 0;
    let tempWin = 0, tempLoss = 0;
    trades.forEach(t => {
      const wl = t['W / L'];
      if (wl === 'Win') {
        tempWin++; tempLoss = 0;
        if (tempWin > longestWinStreak) longestWinStreak = tempWin;
      } else if (wl === 'Loss') {
        tempLoss++; tempWin = 0;
        if (tempLoss > longestLossStreak) longestLossStreak = tempLoss;
      }
    });
    for (let i = trades.length - 1; i >= 0; i--) {
      const wl = trades[i]['W / L'];
      if (i === trades.length - 1) { streakType = wl; currentStreak = 1; }
      else if (wl === streakType) currentStreak++;
      else break;
    }

    // Day-P&L map → best/worst day, win/loss days, daily bars
    const pnlByDateMap = {};
    trades.forEach(t => {
      const d = (t['Close Date'] || t['Entry Date'] || '').split('T')[0];
      if (!d) return;
      pnlByDateMap[d] = (pnlByDateMap[d] || 0) + (parseFloat(t['Total P&L ($)']) || 0);
    });
    const dayPnls = Object.entries(pnlByDateMap)
      .map(([date, pnl]) => ({ date, pnl: Math.round(pnl * 100) / 100 }))
      .sort((a, b) => a.pnl - b.pnl);
    const worstDay = dayPnls[0] || { date: '--', pnl: 0 };
    const bestDay = dayPnls[dayPnls.length - 1] || { date: '--', pnl: 0 };
    const winDays = dayPnls.filter(d => d.pnl > 0).length;
    const lossDays = dayPnls.filter(d => d.pnl < 0).length;
    const pnlByDate = [...dayPnls].sort((a, b) => a.date.localeCompare(b.date)).slice(-30);

    // Profit factor
    const totalWins = trades.filter(t => t['W / L'] === 'Win').reduce((s, t) => s + (parseFloat(t['Total P&L ($)']) || 0), 0);
    const totalLosses = Math.abs(trades.filter(t => t['W / L'] === 'Loss').reduce((s, t) => s + (parseFloat(t['Total P&L ($)']) || 0), 0));
    const profitFactor = totalLosses > 0 ? Math.round(totalWins / totalLosses * 100) / 100 : totalWins > 0 ? 999 : 0;

    return {
      totalPnl, battingAvg, avgWin, avgLoss, expectancy,
      equityCurve, cumPnl: cum, maxDrawdownDollar,
      currentStreak, streakType, longestWinStreak, longestLossStreak,
      bestDay, worstDay, winDays, lossDays, pnlByDate, profitFactor,
      tradeCount: trades.length,
      recentClosed: trades.slice(-10).reverse()
    };
  }, [rangedTrades]);

  // ── Open positions (current-state; unaffected by the range toggle) ──
  const openTrades = useMemo(
    () => filteredTracker.filter(t => t.Status === 'Open'),
    [filteredTracker]
  );
  // Open risk: the engine tickets' live max loss (what the Open positions table shows
  // as "Risk live") plus a proxy for imported trades — the TradeTracker has no max-
  // loss column, so net credit stands in. The tile used to read the tracker alone and
  // showed $0 with $3,785 open on engine tickets. (Oct 2026.)
  const [engineRisk, setEngineRisk] = useState(0);
  useEffect(() => {
    if (!authenticated) return undefined;
    let live = true;
    Promise.resolve().then(() => api.getOpenPositions(account)).then(rows => {
      const n = v => { const x = parseFloat(v); return isFinite(x) ? x : 0; };
      const sum = (Array.isArray(rows) ? rows : []).reduce((a, r) => a + (n(r.qty) > 0 ? n(r.maxRisk) * n(r.qtyOpen) / n(r.qty) : 0), 0);
      if (live) setEngineRisk(sum);
    }).catch(() => {});
    return () => { live = false; };
  }, [authenticated, account, retryTick]);
  const openRiskTotal = useMemo(() => engineRisk + openTrades.reduce((s, t) => {
    const r = parseFloat(t['Net Credit ($)'] || 0);
    return s + (isNaN(r) ? 0 : Math.abs(r));
  }, 0), [openTrades, engineRisk]);

  if (!authenticated) {
    return (
      <div className="fade-in">
        <h2 className="font-display text-2xl font-bold mb-2">Dashboard</h2>
        <p className="text-text-muted mb-6">Connect your Google account in Settings to load trading data.</p>
        <div className="grid grid-cols-4 gap-4">
          {[1,2,3,4].map(i => (
            <div key={i} className="kpi animate-pulse"><div className="h-3 bg-bg-border rounded w-20 mb-2" /><div className="h-6 bg-bg-border rounded w-16" /></div>
          ))}
        </div>
      </div>
    );
  }

  if (loading) return <div className="text-text-muted text-sm">Loading dashboard...</div>;

  const bankroll = config?.currentBankroll ?? 0;
  const startBR = config?.startingBankroll ?? 1;
  const isAggregate = !account || account === 'all';

  const {
    totalPnl, battingAvg, avgWin, avgLoss, expectancy,
    equityCurve, cumPnl, maxDrawdownDollar,
    currentStreak, streakType, longestWinStreak, longestLossStreak,
    bestDay, worstDay, winDays, lossDays, pnlByDate, profitFactor,
    tradeCount, recentClosed
  } = derived;

  const calcRoi = startBR > 0 ? (totalPnl / startBR * 100) : 0;
  const maxDrawdownPct = startBR > 0 ? (maxDrawdownDollar / startBR * 100) : 0;

  // ── Risk config (daily-loss cap/gauge lives in the header strip) ──
  const maxOpenRisk = Number(config?.maxOpenRisk) || 0;
  const openRiskUsedPct = maxOpenRisk > 0 ? Math.min(100, (openRiskTotal / maxOpenRisk) * 100) : 0;
  const aggregated = config?.aggregated === true || isAggregate;
  const acctName = (id) => accounts.find(a => a.id === id)?.name || id || '--';

  return (
    <div className="fade-in">
      {loadError && (
        <ErrorBanner
          message="Data failed to load — check connection"
          onRetry={() => setRetryTick(t => t + 1)}
        />
      )}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="font-display text-2xl font-bold">Dashboard</h2>
          <p className="text-text-muted text-sm mt-0.5">
            {aggregated
              ? 'All accounts — aggregated (excl. PaperTrade)'
              : `Account: ${account}`}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex border border-bg-border rounded-lg overflow-hidden">
            {RANGES.map(r => (
              <button key={r} onClick={() => changeRange(r)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${range === r ? 'bg-accent text-white' : 'text-text-muted hover:text-text hover:bg-bg-hover'}`}>
                {r}
              </button>
            ))}
          </div>
          <div className="text-right">
            <div className="text-xs text-text-faint">{aggregated ? 'Combined bankroll' : 'Current bankroll'}</div>
            <div className="font-display text-xl font-bold mono" style={{ color: pnlColor(bankroll - startBR) }}>{fmt$(bankroll)}</div>
          </div>
        </div>
      </div>

      <EventBanner />

      {/* KPI Cards - Row 1: performance */}
      <div className="grid grid-cols-6 gap-3 mb-3">
        <KPI icon={DollarSign} label="Total P&L" value={fmt$(totalPnl)} cls={totalPnl >= 0 ? 'green' : 'red'} />
        <KPI icon={Percent} label="ROI" value={calcRoi.toFixed(1) + '%'} cls={calcRoi >= 0 ? 'green' : 'red'}
          sub={`Start: ${fmt$(startBR)}`} />
        <KPI icon={Target} label="Batting Avg" value={battingAvg.toFixed(1) + '%'} cls={battingAvg >= BA_GREEN ? 'green' : battingAvg >= BA_RED ? 'amber' : 'red'} />
        <KPI icon={Activity} label="Expectancy" value={fmt$(expectancy)} cls={expectancy >= 0 ? 'green' : 'red'} />
        <KPI icon={TrendingUp} label="Avg Win" value={fmt$(avgWin)} cls="green" />
        <KPI icon={TrendingDown} label="Avg Loss" value={fmt$(avgLoss)} cls="red" />
      </div>

      {/* Every number above is history. This is the only thing on the Dashboard
          that is still live, so it sits directly under them. (Sep 2026.) */}
      <div className="mb-6">
        <OpenPositions authenticated={authenticated} account={account} compact maxOpenRisk={maxOpenRisk} />
      </div>

      {/* KPI Cards - Row 2: secondary metrics + risk (smaller, muted) */}
      <div className="grid grid-cols-6 gap-3 mb-6">
        <KPI small icon={Activity} label="Profit factor" value={profitFactor.toFixed(2) + 'x'}
          cls={profitFactor >= 2 ? 'green' : profitFactor >= 1 ? 'amber' : 'red'} />
        <KPI small icon={Flame} label="Streaks"
          value={`${longestWinStreak}W / ${longestLossStreak}L`}
          cls={streakType === 'Win' ? 'green' : streakType === 'Loss' ? 'red' : ''}
          sub={streakType ? `Now: ${currentStreak} ${streakType}` : ''} />
        <KPI small icon={TrendingUp} label="Best day"
          value={fmt$(bestDay.pnl)}
          cls="green"
          sub={bestDay.date !== '--' ? fmtDateShort(bestDay.date) : ''} />
        <KPI small icon={TrendingDown} label="Worst day"
          value={fmt$(worstDay.pnl)}
          cls="red"
          sub={worstDay.date !== '--' ? fmtDateShort(worstDay.date) : ''} />
        <KPI small icon={Calendar} label="Trades" value={tradeCount} cls=""
          sub={`${winDays}W / ${lossDays}L days`} />
        <KPI small icon={DollarSign} label={aggregated ? 'Open risk est. (all)' : 'Open risk est.'}
          value={fmt$(openRiskTotal)}
          cls={maxOpenRisk > 0 ? (openRiskUsedPct >= 100 ? 'red' : openRiskUsedPct >= 75 ? 'amber' : 'green') : ''}
          sub={maxOpenRisk > 0 ? `Cap: ${fmt$(maxOpenRisk)} (${openRiskUsedPct.toFixed(0)}% used)` : ''} />
      </div>

      {/* Row 2: Merged Equity Curve + Drawdown */}
      <div className="card mb-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-text-muted">Equity Curve &amp; Drawdown</h3>
          <span className={`mono text-sm font-bold ${maxDrawdownPct > 20 ? 'text-red' : maxDrawdownPct > 10 ? 'text-amber' : 'text-green'}`}>
            Max DD: {fmt$(maxDrawdownDollar)} ({maxDrawdownPct.toFixed(1)}% of start)
          </span>
        </div>
        {equityCurve.length > 2 ? (
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={equityCurve}>
              <defs>
                <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={cumPnl >= 0 ? '#3fb950' : '#f85149'} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={cumPnl >= 0 ? '#3fb950' : '#f85149'} stopOpacity={0} />
                </linearGradient>
                <linearGradient id="ddGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#f85149" stopOpacity={0.25} />
                  <stop offset="95%" stopColor="#f85149" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#8b949e' }} axisLine={false} tickLine={false} />
              <YAxis yAxisId="eq" tick={{ fontSize: 10, fill: '#8b949e' }} axisLine={false} tickLine={false} tickFormatter={v => '$' + v} />
              <YAxis yAxisId="dd" orientation="right" domain={['dataMin', 0]}
                tick={{ fontSize: 10, fill: '#f85149', opacity: 0.6 }} axisLine={false} tickLine={false} tickFormatter={v => '$' + v} />
              <Tooltip
                contentStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: '#a8b2be' }}
                formatter={(v, name) => {
                  if (name === 'drawdown') {
                    return [<span style={{ color: '#f85149', fontWeight: 600, fontFamily: 'JetBrains Mono, monospace' }}>{fmt$(Math.abs(v))}</span>, 'Drawdown'];
                  }
                  const color = v >= 0 ? '#3fb950' : '#f85149';
                  return [<span style={{ color, fontWeight: 600, fontFamily: 'JetBrains Mono, monospace' }}>{fmt$(v)}</span>, 'Cumulative'];
                }}
              />
              <ReferenceLine yAxisId="eq" y={0} stroke="#30363d" strokeDasharray="3 3" />
              <Area yAxisId="dd" type="monotone" dataKey="drawdown" stroke="#f85149" strokeOpacity={0.5} fill="url(#ddGrad)" strokeWidth={1} dot={false} />
              <Area yAxisId="eq" type="monotone" dataKey="cumPnl" stroke={cumPnl >= 0 ? '#3fb950' : '#f85149'} fill="url(#eqGrad)" strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-[260px] flex items-center justify-center text-text-faint text-sm">Need more trades to show equity curve</div>
        )}
      </div>

      {/* Row 3: Daily P&L chart + Upcoming expiries */}
      <div className="grid grid-cols-3 gap-4 mb-4">
        <div className="col-span-2 card">
          <h3 className="text-sm font-medium text-text-muted mb-3">Daily P&L — Last 30 Trading Days</h3>
          {pnlByDate.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={pnlByDate}>
                <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#8b949e' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: '#8b949e' }} axisLine={false} tickLine={false} tickFormatter={v => '$' + v} />
                <Tooltip
                  contentStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: '#a8b2be' }}
                  formatter={(v) => {
                    const color = v >= 0 ? '#3fb950' : '#f85149';
                    return [<span style={{ color, fontWeight: 600, fontFamily: 'JetBrains Mono, monospace' }}>{fmt$(v)}</span>, 'P&L'];
                  }}
                />
                <ReferenceLine y={0} stroke="#30363d" strokeDasharray="3 3" />
                <Bar dataKey="pnl" radius={[3, 3, 0, 0]}>
                  {pnlByDate.map((d, i) => (
                    <Cell key={i} fill={d.pnl >= 0 ? '#238636' : '#da3633'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[200px] flex items-center justify-center text-text-faint text-sm">Upload a TastyTrade CSV to see your P&L chart</div>
          )}
        </div>

        <UpcomingExpiries authenticated={authenticated} account={account} />
      </div>

      {/* Row 4: Recent Trades */}
      <div className="card">
        <h3 className="text-sm font-medium text-text-muted mb-3">Recent Closed Trades</h3>
        {recentClosed.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-text-faint text-xs uppercase tracking-wider">
                  <th className="text-left py-2 pr-4">Closed</th>
                  <th className="text-left py-2 pr-4">Underlying</th>
                  <th className="text-left py-2 pr-4">Strategy</th>
                  <th className="text-left py-2 pr-4">Account</th>
                  <th className="text-right py-2 pr-4">P&L</th>
                  <th className="text-center py-2 pr-4">W/L</th>
                  <th className="text-left py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {recentClosed.map((t, i) => {
                  const pnl = parseFloat(t['Total P&L ($)']) || 0;
                  return (
                    <tr key={i} className="table-row" title="View in Trades">
                      <td className="py-2 pr-4 text-text-muted">{fmtDate(t['Close Date'] || t['Entry Date'])}</td>
                      <td className="py-2 pr-4 font-medium">{t.Underlying}</td>
                      <td className="py-2 pr-4 text-text-muted">{t['Strategy (OIC)']}</td>
                      <td className="py-2 pr-4 text-text-muted">{acctName(t.Account)}</td>
                      <td className="py-2 pr-4 text-right mono font-medium" style={{ color: pnlColor(pnl) }}>{fmt$(pnl)}</td>
                      <td className="py-2 pr-4 text-center">
                        <span className={`badge ${t['W / L'] === 'Win' ? 'badge-green' : 'badge-red'}`}>{t['W / L']}</span>
                      </td>
                      <td className="py-2 text-text-muted text-xs">{t.Status}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="h-20 flex items-center justify-center text-text-faint text-sm">No closed trades yet</div>
        )}
      </div>
    </div>
  );
}

// ── Scheduled macro events (Aug 2026) ────────────────────────────────────────
// Sits above the KPIs so the first thing the dashboard says each morning is what
// kind of day it is. Deliberately renders even when there is nothing scheduled:
// a banner that only appears on event days is a banner you cannot trust on the
// quiet ones, because its absence could equally mean the calendar is broken.
// Coverage gaps are stated in the same box for the same reason.
function EventBanner() {
  const { dateISO, minutes } = nowET();
  const o = useMemo(() => eventOutlook(dateISO, minutes, 21), [dateISO, minutes]);

  const todayHigh = o.highToday;
  const border = o.todayWarnings.length ? (todayHigh ? '#6e2427' : '#4b3f7a') : '#21262d';
  const bg = o.todayWarnings.length ? (todayHigh ? '#1f1214' : '#151327') : '#0d1117';

  return (
    <div className="mb-3 rounded-lg" style={{ background: bg, border: `1px solid ${border}`, padding: '10px 14px' }}>
      <div className="flex items-center gap-2 mb-1">
        <Calendar size={14} className="text-text-muted" />
        <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">Macro calendar</span>
        {o.nextHigh && (
          <span className="text-xs mono" style={{ color: '#a8b2be' }}>
            · next major: {o.nextHigh.label} {o.nextHigh.date}
            {o.daysUntilNextHigh === 0 ? ' (today)' : ` (${o.daysUntilNextHigh}d)`}
          </span>
        )}
      </div>

      {o.todayWarnings.length > 0 ? (
        o.todayWarnings.map((w, i) => (
          <div key={i} className="text-sm" style={{ color: todayHigh ? '#f0a0a0' : '#b9a7ff', lineHeight: 1.5 }}>
            {w}
          </div>
        ))
      ) : (
        <div className="text-sm" style={{ color: '#a8b2be' }}>
          Nothing scheduled inside today's session.
        </div>
      )}

      {o.upcoming.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {o.upcoming.slice(0, 8).map((e, i) => {
            const sev = o.severityOf(e.kind);
            return (
              <span key={i} title={`${e.label} — ${e.date}${e.time ? ' ' + e.time + ' ET' : ''}${e.source === 'rule' ? ' (inferred, unconfirmed)' : ''}`}
                className="mono" style={{
                  fontSize: 11, padding: '2px 7px', borderRadius: 4,
                  background: sev === 'high' ? '#2a1418' : '#161b22',
                  border: `1px solid ${sev === 'high' ? '#6e2427' : '#21262d'}`,
                  color: sev === 'high' ? '#f85149' : '#a8b2be',
                }}>
                {e.date.slice(5)} {e.label}{e.source === 'rule' ? ' ?' : ''}
              </span>
            );
          })}
        </div>
      )}

      {o.notices.map((n, i) => (
        <div key={'n' + i} className="text-xs mt-2" style={{ color: '#9aa4b0' }}>{n}</div>
      ))}
    </div>
  );
}

function KPI({ icon: Icon, label, value, cls, sub, small }) {
  return (
    <div className="kpi" style={small ? { opacity: 0.85 } : undefined}>
      <div className="flex items-center gap-1.5 kpi-label">
        <Icon size={12} />
        {label}
      </div>
      <div className={`kpi-value ${cls}`} style={small ? { fontSize: 15 } : undefined}>{value}</div>
      {sub && <div className="text-[12px] text-text-faint mt-0.5">{sub}</div>}
    </div>
  );
}
