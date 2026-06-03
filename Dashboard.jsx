import React, { useState, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { TrendingUp, TrendingDown, Target, DollarSign, Percent, Activity } from 'lucide-react';
import { api } from '../utils/api';
import { fmt$, fmtPct, fmtDate, pnlColor } from '../utils/format';

export default function Dashboard({ authenticated }) {
  const [stats, setStats] = useState(null);
  const [config, setConfig] = useState({});
  const [tracker, setTracker] = useState([]);
  const [journal, setJournal] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!authenticated) { setLoading(false); return; }
    Promise.all([
      api.getStats().catch(() => ({ stats: {}, config: {} })),
      api.getTracker().catch(() => []),
      api.getJournal().catch(() => [])
    ]).then(([s, t, j]) => {
      setStats(s.stats); setConfig(s.config); setTracker(t); setJournal(j);
      setLoading(false);
    });
  }, [authenticated]);

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

  const ba = stats?.BattingAverage ?? stats?.battingAvg ?? 0;
  const totalPnl = stats?.TotalP_L ?? stats?.TotalPnl ?? stats?.totalPnl ?? 0;
  const avgWin = stats?.AvgWin ?? stats?.avgWin ?? 0;
  const avgLoss = stats?.AvgLoss ?? stats?.avgLoss ?? 0;
  const expectancy = stats?.Expectancy ?? stats?.expectancy ?? 0;
  const totalTrades = stats?.TotalTrades ?? stats?.totalTrades ?? 0;
  const bankroll = config?.currentBankroll ?? 0;
  const startBR = config?.startingBankroll ?? 1;
  const roi = startBR > 0 ? ((bankroll - startBR) / startBR) : 0;

  // P&L by date chart data
  const pnlByDate = journal
    .filter(j => j.Date && j['Day P&L'])
    .map(j => ({
      date: j.Date,
      pnl: parseFloat(j['Day P&L']) || 0
    }))
    .slice(-30);

  // Upcoming expiries (open trades)
  const openTrades = tracker.filter(t => t.Status === 'Open');
  const upcoming = openTrades
    .filter(t => t['Expiry Date'])
    .sort((a, b) => new Date(a['Expiry Date']) - new Date(b['Expiry Date']))
    .slice(0, 8);

  // Recent closed trades
  const recentClosed = tracker
    .filter(t => t.Status !== 'Open' && t['Total P&L ($)'])
    .slice(-10)
    .reverse();

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

      {/* KPI Cards */}
      <div className="grid grid-cols-6 gap-3 mb-6">
        <KPI icon={DollarSign} label="Total P&L" value={fmt$(totalPnl)} cls={totalPnl >= 0 ? 'green' : 'red'} />
        <KPI icon={Percent} label="ROI" value={(roi * 100).toFixed(1) + '%'} cls={roi >= 0 ? 'green' : 'red'} />
        <KPI icon={Target} label="Batting Avg" value={ba + '%'} cls={ba >= 60 ? 'green' : ba >= 40 ? 'amber' : 'red'} />
        <KPI icon={TrendingUp} label="Avg Win" value={fmt$(avgWin)} cls="green" />
        <KPI icon={TrendingDown} label="Avg Loss" value={fmt$(avgLoss)} cls="red" />
        <KPI icon={Activity} label="Expectancy" value={fmt$(expectancy)} cls={expectancy >= 0 ? 'green' : 'red'} />
      </div>

      <div className="grid grid-cols-3 gap-4 mb-6">
        {/* P&L Chart */}
        <div className="col-span-2 card">
          <h3 className="text-sm font-medium text-text-muted mb-3">Profit & Loss by Date</h3>
          {pnlByDate.length > 0 ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={pnlByDate}>
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#484f58' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: '#484f58' }} axisLine={false} tickLine={false} tickFormatter={v => '$' + v} />
                <Tooltip
                  contentStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: '#8b949e' }}
                  formatter={(v) => [fmt$(v), 'P&L']}
                />
                <Bar dataKey="pnl" radius={[3, 3, 0, 0]}>
                  {pnlByDate.map((d, i) => (
                    <Cell key={i} fill={d.pnl >= 0 ? '#238636' : '#da3633'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[220px] flex items-center justify-center text-text-faint text-sm">
              Upload a TastyTrade CSV to see your P&L chart
            </div>
          )}
        </div>

        {/* Upcoming Expiries */}
        <div className="card">
          <h3 className="text-sm font-medium text-text-muted mb-3">Upcoming Expiries</h3>
          {upcoming.length > 0 ? (
            <div className="space-y-2">
              {upcoming.map((t, i) => {
                const dte = Math.ceil((new Date(t['Expiry Date']) - new Date()) / (1000 * 60 * 60 * 24));
                return (
                  <div key={i} className="flex items-center justify-between py-1.5 border-b border-bg-border last:border-0">
                    <div>
                      <span className="text-sm font-medium">{t.Underlying}</span>
                      <span className="text-xs text-text-muted ml-2">{t['Strategy (OIC)']}</span>
                    </div>
                    <span className={`badge ${dte <= 3 ? 'badge-red' : dte <= 7 ? 'badge-amber' : 'badge-blue'}`}>
                      {dte}d
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

      {/* Recent Trades */}
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

function KPI({ icon: Icon, label, value, cls }) {
  return (
    <div className="kpi">
      <div className="flex items-center gap-1.5 kpi-label">
        <Icon size={12} />
        {label}
      </div>
      <div className={`kpi-value ${cls}`}>{value}</div>
    </div>
  );
}
