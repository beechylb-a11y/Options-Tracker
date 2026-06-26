import React, { useState, useEffect } from 'react';
import { BarChart, Bar, LineChart, Line, AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, ReferenceLine } from 'recharts';
import { TrendingUp, TrendingDown, Target, DollarSign, Percent, Activity, Flame, Calendar, Award } from 'lucide-react';
import { api } from '../utils/api';
import { fmt$, fmtPct, fmtDate, fmtDateShort, pnlColor, filterByAccount } from '../utils/format';

export default function Dashboard({ authenticated, account }) {
  const [stats, setStats] = useState(null);
  const [config, setConfig] = useState({});
  const [tracker, setTracker] = useState([]);
  const [journal, setJournal] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!authenticated) { setLoading(false); return; }
    Promise.all([
      api.getStats(account).catch(() => ({ stats: {}, config: {} })),
      api.getTracker().catch(() => []),
      api.getJournal().catch(() => [])
    ]).then(([s, t, j]) => {
      setStats(s.stats); setConfig(s.config); setTracker(t); setJournal(j);
      setLoading(false);
    });
  }, [authenticated, account]);

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

  const ba = stats?.battingAvg ?? 0;
  const totalPnl = stats?.totalPnl ?? 0;
  const avgWin = stats?.avgWin ?? 0;
  const avgLoss = stats?.avgLoss ?? 0;
  const expectancy = stats?.expectancy ?? 0;
  const totalTrades = stats?.totalTrades ?? 0;
  const bankroll = config?.currentBankroll ?? 0;
  const startBR = config?.startingBankroll ?? 1;
  const roi = startBR > 0 ? ((bankroll - startBR) / startBR) : 0;

  // ── Closed trades sorted by date ──
  const allTracker = tracker;
  const filteredTracker = filterByAccount(allTracker, account);
  const closedTrades = filteredTracker
    .filter(t => t.Status !== 'Open' && t['Total P&L ($)'])
    .sort((a, b) => new Date(a['Entry Date'] || 0) - new Date(b['Entry Date'] || 0));

  // ── Equity curve (cumulative P&L over time) ──
  let cumPnl = 0;
  const equityCurve = closedTrades.map(t => {
    const pnl = parseFloat(t['Total P&L ($)']) || 0;
    cumPnl += pnl;
    return {
      date: (t['Close Date'] || t['Entry Date'] || '').split('T')[0],
      cumPnl: Math.round(cumPnl * 100) / 100,
      pnl
    };
  });

  // ── Drawdown calculation ──
  let peak = 0;
  let maxDrawdown = 0;
  let currentDrawdown = 0;
  const drawdownData = equityCurve.map(d => {
    if (d.cumPnl > peak) peak = d.cumPnl;
    currentDrawdown = peak > 0 ? ((peak - d.cumPnl) / peak) * 100 : 0;
    if (currentDrawdown > maxDrawdown) maxDrawdown = currentDrawdown;
    return { ...d, drawdown: -Math.round(currentDrawdown * 10) / 10 };
  });

  // ── Streak counter ──
  let currentStreak = 0;
  let streakType = '';
  let longestWinStreak = 0;
  let longestLossStreak = 0;
  let tempWin = 0, tempLoss = 0;

  closedTrades.forEach(t => {
    const wl = t['W / L'];
    if (wl === 'Win') {
      tempWin++;
      tempLoss = 0;
      if (tempWin > longestWinStreak) longestWinStreak = tempWin;
    } else if (wl === 'Loss') {
      tempLoss++;
      tempWin = 0;
      if (tempLoss > longestLossStreak) longestLossStreak = tempLoss;
    }
  });

  // Current streak from the end
  for (let i = closedTrades.length - 1; i >= 0; i--) {
    const wl = closedTrades[i]['W / L'];
    if (i === closedTrades.length - 1) {
      streakType = wl;
      currentStreak = 1;
    } else if (wl === streakType) {
      currentStreak++;
    } else {
      break;
    }
  }

  // ── Best / Worst day ──
  const pnlByDateMap = {};
  closedTrades.forEach(t => {
    const d = (t['Close Date'] || t['Entry Date'] || '').split('T')[0];
    if (!d) return;
    if (!pnlByDateMap[d]) pnlByDateMap[d] = 0;
    pnlByDateMap[d] += parseFloat(t['Total P&L ($)']) || 0;
  });
  const dayPnls = Object.entries(pnlByDateMap).map(([date, pnl]) => ({ date, pnl: Math.round(pnl * 100) / 100 }));
  dayPnls.sort((a, b) => a.pnl - b.pnl);
  const worstDay = dayPnls[0] || { date: '--', pnl: 0 };
  const bestDay = dayPnls[dayPnls.length - 1] || { date: '--', pnl: 0 };

  // ── P&L by date chart (last 30 trading days) ──
  const pnlByDate = dayPnls.sort((a, b) => a.date.localeCompare(b.date)).slice(-30);

  // ── Win days / Loss days ──
  const winDays = dayPnls.filter(d => d.pnl > 0).length;
  const lossDays = dayPnls.filter(d => d.pnl < 0).length;

  // ── Upcoming expiries ──
  const openTrades = filteredTracker.filter(t => t.Status === 'Open');
  const upcoming = openTrades
    .filter(t => t['Expiry Date'])
    .sort((a, b) => new Date(a['Expiry Date']) - new Date(b['Expiry Date']))
    .slice(0, 8);

  // ── Recent closed ──
  const recentClosed = closedTrades.slice(-10).reverse();

  // ── Profit factor ──
  const totalWins = closedTrades.filter(t => t['W / L'] === 'Win').reduce((s, t) => s + (parseFloat(t['Total P&L ($)']) || 0), 0);
  const totalLosses = Math.abs(closedTrades.filter(t => t['W / L'] === 'Loss').reduce((s, t) => s + (parseFloat(t['Total P&L ($)']) || 0), 0));
  const profitFactor = totalLosses > 0 ? Math.round(totalWins / totalLosses * 100) / 100 : totalWins > 0 ? 999 : 0;

  return (
    <div className="fade-in">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="font-display text-2xl font-bold">Dashboard</h2>
          <p className="text-text-muted text-sm mt-0.5">Your trading command center</p>
        </div>
        <div className="text-right">
          <div className="text-xs text-text-faint">Current bankroll</div>
          <div className="font-display text-xl font-bold mono" style={{ color: pnlColor(bankroll - startBR) }}>{fmt$(bankroll)}</div>
        </div>
      </div>

      {/* KPI Cards - Row 1 */}
      <div className="grid grid-cols-6 gap-3 mb-3">
        <KPI icon={DollarSign} label="Total P&L" value={fmt$(totalPnl)} cls={totalPnl >= 0 ? 'green' : 'red'} />
        <KPI icon={Percent} label="ROI" value={(roi * 100).toFixed(1) + '%'} cls={roi >= 0 ? 'green' : 'red'} />
        <KPI icon={Target} label="Batting Avg" value={ba + '%'} cls={ba >= 60 ? 'green' : ba >= 40 ? 'amber' : 'red'} />
        <KPI icon={TrendingUp} label="Avg Win" value={fmt$(avgWin)} cls="green" />
        <KPI icon={TrendingDown} label="Avg Loss" value={fmt$(avgLoss)} cls="red" />
        <KPI icon={Activity} label="Expectancy" value={fmt$(expectancy)} cls={expectancy >= 0 ? 'green' : 'red'} />
      </div>

      {/* KPI Cards - Row 2: New metrics */}
      <div className="grid grid-cols-6 gap-3 mb-6">
        <KPI icon={Flame} label="Current streak"
          value={`${currentStreak} ${streakType}`}
          cls={streakType === 'Win' ? 'green' : streakType === 'Loss' ? 'red' : ''} />
        <KPI icon={Award} label="Best streak" value={`${longestWinStreak}W / ${longestLossStreak}L`} cls="" />
        <KPI icon={TrendingUp} label="Best day"
          value={fmt$(bestDay.pnl)}
          cls="green"
          sub={bestDay.date !== '--' ? fmtDateShort(bestDay.date) : ''} />
        <KPI icon={TrendingDown} label="Worst day"
          value={fmt$(worstDay.pnl)}
          cls="red"
          sub={worstDay.date !== '--' ? fmtDateShort(worstDay.date) : ''} />
        <KPI icon={Calendar} label="Win / Loss days" value={`${winDays}W / ${lossDays}L`} cls="" />
        <KPI icon={Activity} label="Profit factor" value={profitFactor.toFixed(2) + 'x'}
          cls={profitFactor >= 2 ? 'green' : profitFactor >= 1 ? 'amber' : 'red'} />
      </div>

      {/* Row 2: Equity Curve + Drawdown */}
      <div className="grid grid-cols-2 gap-4 mb-4">
        {/* Equity Curve */}
        <div className="card">
          <h3 className="text-sm font-medium text-text-muted mb-3">Equity Curve — Cumulative P&L</h3>
          {equityCurve.length > 2 ? (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={equityCurve}>
                <defs>
                  <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={cumPnl >= 0 ? '#3fb950' : '#f85149'} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={cumPnl >= 0 ? '#3fb950' : '#f85149'} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#484f58' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: '#484f58' }} axisLine={false} tickLine={false} tickFormatter={v => '$' + v} />
                <Tooltip
                  contentStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: '#8b949e' }}
                  formatter={(v, name) => {
                    const color = v >= 0 ? '#3fb950' : '#f85149';
                    const label = name === 'cumPnl' ? 'Cumulative' : 'Trade';
                    return [<span style={{ color, fontWeight: 600, fontFamily: 'JetBrains Mono, monospace' }}>{fmt$(v)}</span>, label];
                  }}
                />
                <ReferenceLine y={0} stroke="#30363d" strokeDasharray="3 3" />
                <Area type="monotone" dataKey="cumPnl" stroke={cumPnl >= 0 ? '#3fb950' : '#f85149'} fill="url(#eqGrad)" strokeWidth={2} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[200px] flex items-center justify-center text-text-faint text-sm">Need more trades to show equity curve</div>
          )}
        </div>

        {/* Drawdown */}
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-text-muted">Drawdown from Peak</h3>
            <span className={`mono text-sm font-bold ${maxDrawdown > 20 ? 'text-red' : maxDrawdown > 10 ? 'text-amber' : 'text-green'}`}>
              Max: {maxDrawdown.toFixed(1)}%
            </span>
          </div>
          {drawdownData.length > 2 ? (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={drawdownData}>
                <defs>
                  <linearGradient id="ddGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f85149" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#f85149" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#484f58' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: '#484f58' }} axisLine={false} tickLine={false} tickFormatter={v => v + '%'} domain={['dataMin', 0]} />
                <Tooltip
                  contentStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: '#8b949e' }}
                  formatter={(v) => [<span style={{ color: '#f85149', fontWeight: 600, fontFamily: 'JetBrains Mono, monospace' }}>{v.toFixed(1)}%</span>, 'Drawdown']}
                />
                <ReferenceLine y={0} stroke="#30363d" />
                <Area type="monotone" dataKey="drawdown" stroke="#f85149" fill="url(#ddGrad)" strokeWidth={1.5} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[200px] flex items-center justify-center text-text-faint text-sm">Need more trades to show drawdown</div>
          )}
        </div>
      </div>

      {/* Row 3: Daily P&L chart + Upcoming expiries */}
      <div className="grid grid-cols-3 gap-4 mb-4">
        <div className="col-span-2 card">
          <h3 className="text-sm font-medium text-text-muted mb-3">Daily P&L — Last 30 Trading Days</h3>
          {pnlByDate.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={pnlByDate}>
                <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#484f58' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: '#484f58' }} axisLine={false} tickLine={false} tickFormatter={v => '$' + v} />
                <Tooltip
                  contentStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: '#8b949e' }}
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

        <div className="card">
          <h3 className="text-sm font-medium text-text-muted mb-3">Upcoming Expiries</h3>
          {upcoming.length > 0 ? (
            <div className="space-y-2">
              {upcoming.map((t, i) => {
                const expiryDate = new Date(t['Expiry Date']);
                const now = new Date();
                const dte = Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24));
                // For 0DTE (expires today): show hours remaining to 4pm ET
                const todayStr = now.toISOString().split('T')[0];
                const expiryStr = expiryDate.toISOString().split('T')[0];
                const is0DTE = dte <= 0 || expiryStr === todayStr;
                let timeLabel = `${dte}d`;
                let urgentClass = dte <= 3 ? 'badge-red' : dte <= 7 ? 'badge-amber' : 'badge-blue';
                if (is0DTE) {
                  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
                  const close4pm = new Date(et); close4pm.setHours(16, 0, 0, 0);
                  const hoursLeft = Math.max(0, (close4pm - et) / 3600000);
                  timeLabel = hoursLeft > 0 ? `${hoursLeft.toFixed(1)}h` : 'Expired';
                  urgentClass = hoursLeft <= 1 ? 'badge-red' : hoursLeft <= 2 ? 'badge-amber' : 'badge-red';
                  // 3pm ET reminder
                  const reminder3pm = new Date(et); reminder3pm.setHours(15, 0, 0, 0);
                  if (et >= reminder3pm && hoursLeft > 0) {
                    timeLabel += ' ⚠';
                  }
                }
                return (
                  <div key={i} className="flex items-center justify-between py-1.5 border-b border-bg-border last:border-0">
                    <div>
                      <span className="text-sm font-medium">{t.Underlying}</span>
                      <span className="text-xs text-text-muted ml-2">{t['Strategy (OIC)']}</span>
                    </div>
                    <span className={`badge ${urgentClass}`}>
                      {timeLabel}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="h-32 flex items-center justify-center text-text-faint text-sm">No open positions</div>
          )}
        </div>
      </div>

      {/* Row 4: Recent Trades */}
      <div className="card">
        <h3 className="text-sm font-medium text-text-muted mb-3">Recent Closed Trades</h3>
        {recentClosed.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-text-faint text-xs uppercase tracking-wider">
                  <th className="text-left py-2 pr-4">Date</th>
                  <th className="text-left py-2 pr-4">Underlying</th>
                  <th className="text-left py-2 pr-4">Strategy</th>
                  <th className="text-right py-2 pr-4">P&L</th>
                  <th className="text-center py-2 pr-4">W/L</th>
                  <th className="text-left py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {recentClosed.map((t, i) => {
                  const pnl = parseFloat(t['Total P&L ($)']) || 0;
                  return (
                    <tr key={i} className="table-row">
                      <td className="py-2 pr-4 text-text-muted">{fmtDate(t['Entry Date'])}</td>
                      <td className="py-2 pr-4 font-medium">{t.Underlying}</td>
                      <td className="py-2 pr-4 text-text-muted">{t['Strategy (OIC)']}</td>
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

function KPI({ icon: Icon, label, value, cls, sub }) {
  return (
    <div className="kpi">
      <div className="flex items-center gap-1.5 kpi-label">
        <Icon size={12} />
        {label}
      </div>
      <div className={`kpi-value ${cls}`}>{value}</div>
      {sub && <div className="text-[10px] text-text-faint mt-0.5">{sub}</div>}
    </div>
  );
}
