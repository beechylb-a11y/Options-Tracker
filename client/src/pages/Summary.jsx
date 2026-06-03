import React, { useState, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, PieChart, Pie } from 'recharts';
import { api } from '../utils/api';
import { fmt$, pnlColor } from '../utils/format';

export default function Summary({ authenticated }) {
  const [perf, setPerf] = useState(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('strategy');

  useEffect(() => {
    if (!authenticated) { setLoading(false); return; }
    api.getPerformance().then(setPerf).catch(() => {}).finally(() => setLoading(false));
  }, [authenticated]);

  if (!authenticated) {
    return (
      <div className="fade-in">
        <h2 className="font-display text-2xl font-bold mb-2">Summary</h2>
        <p className="text-text-muted">Connect Google to view performance summary.</p>
      </div>
    );
  }

  if (loading) return <div className="text-text-muted text-sm">Loading performance data...</div>;

  const data = view === 'strategy' ? perf?.byStrategy : perf?.byUnderlying;
  const overall = perf?.overall || {};

  const chartData = Object.entries(data || {})
    .map(([name, d]) => ({ name, pnl: d.pnl, trades: d.trades, ba: d.ba, wins: d.wins, losses: d.losses }))
    .sort((a, b) => b.pnl - a.pnl);

  return (
    <div className="fade-in">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="font-display text-2xl font-bold">Summary</h2>
          <p className="text-text-muted text-sm mt-0.5">Strategy and underlying performance breakdown</p>
        </div>
        <div className="flex border border-bg-border rounded-lg overflow-hidden">
          <button onClick={() => setView('strategy')}
            className={`px-4 py-2 text-sm font-medium transition-colors ${view === 'strategy' ? 'bg-accent text-white' : 'text-text-muted hover:text-text hover:bg-bg-hover'}`}>
            By Strategy
          </button>
          <button onClick={() => setView('underlying')}
            className={`px-4 py-2 text-sm font-medium transition-colors ${view === 'underlying' ? 'bg-accent text-white' : 'text-text-muted hover:text-text hover:bg-bg-hover'}`}>
            By Underlying
          </button>
        </div>
      </div>

      {/* Overall KPIs */}
      <div className="grid grid-cols-5 gap-3 mb-6">
        <div className="kpi">
          <div className="kpi-label">Total Trades</div>
          <div className="kpi-value">{overall.totalTrades || 0}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Total P&L</div>
          <div className={`kpi-value ${(overall.totalPnl || 0) >= 0 ? 'green' : 'red'}`}>{fmt$(overall.totalPnl)}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Batting Average</div>
          <div className={`kpi-value ${(overall.battingAvg || 0) >= 50 ? 'green' : 'red'}`}>{overall.battingAvg || 0}%</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Avg Win</div>
          <div className="kpi-value green">{fmt$(overall.avgWin)}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Avg Loss</div>
          <div className="kpi-value red">{fmt$(overall.avgLoss)}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-6">
        {/* P&L Bar Chart */}
        <div className="card">
          <h3 className="text-sm font-medium text-text-muted mb-3">P&L by {view === 'strategy' ? 'Strategy' : 'Underlying'}</h3>
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={chartData} layout="vertical" margin={{ left: 100 }}>
                <XAxis type="number" tick={{ fontSize: 10, fill: '#484f58' }} axisLine={false} tickLine={false} tickFormatter={v => '$' + v} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: '#8b949e' }} axisLine={false} tickLine={false} width={100} />
                <Tooltip
                  contentStyle={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: '#e6edf3' }}
                  itemStyle={{ color: '#e6edf3' }}
                  formatter={(v) => {
                    const color = v >= 0 ? '#3fb950' : '#f85149';
                    return [<span style={{ color, fontWeight: 600, fontFamily: 'JetBrains Mono, monospace' }}>{fmt$(v)}</span>, 'P&L'];
                  }}
                />
                <Bar dataKey="pnl" radius={[0, 4, 4, 0]}>
                  {chartData.map((d, i) => (
                    <Cell key={i} fill={d.pnl >= 0 ? '#238636' : '#da3633'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[300px] flex items-center justify-center text-text-faint text-sm">No data</div>
          )}
        </div>

        {/* Win/Loss distribution */}
        <div className="card">
          <h3 className="text-sm font-medium text-text-muted mb-3">Win Rate by {view === 'strategy' ? 'Strategy' : 'Underlying'}</h3>
          {chartData.length > 0 ? (
            <div className="space-y-2">
              {chartData.map((d, i) => (
                <div key={i} className="flex items-center gap-3">
                  <span className="text-xs text-text-muted w-28 truncate">{d.name}</span>
                  <div className="flex-1 h-4 rounded-full bg-bg-border overflow-hidden flex">
                    <div className="bg-green h-full transition-all" style={{ width: `${d.ba}%` }} />
                    <div className="bg-red h-full transition-all" style={{ width: `${100 - d.ba}%` }} />
                  </div>
                  <span className="mono text-xs w-10 text-right">{d.ba}%</span>
                  <span className="text-xs text-text-faint w-14 text-right">{d.trades}t</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="h-[300px] flex items-center justify-center text-text-faint text-sm">No data</div>
          )}
        </div>
      </div>

      {/* Detailed table */}
      <div className="card">
        <h3 className="text-sm font-medium text-text-muted mb-3">Detailed Breakdown</h3>
        {chartData.length > 0 ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-text-faint text-[11px] uppercase tracking-wider">
                <th className="text-left py-2">{view === 'strategy' ? 'Strategy' : 'Underlying'}</th>
                <th className="text-center py-2">Trades</th>
                <th className="text-center py-2">Wins</th>
                <th className="text-center py-2">Losses</th>
                <th className="text-center py-2">BA %</th>
                <th className="text-right py-2">Total P&L</th>
                <th className="text-right py-2">Avg P&L</th>
              </tr>
            </thead>
            <tbody>
              {chartData.map((d, i) => (
                <tr key={i} className="table-row">
                  <td className="py-2 font-medium">{d.name}</td>
                  <td className="py-2 text-center mono">{d.trades}</td>
                  <td className="py-2 text-center mono text-green">{d.wins}</td>
                  <td className="py-2 text-center mono text-red">{d.losses}</td>
                  <td className="py-2 text-center">
                    <span className={`badge ${d.ba >= 60 ? 'badge-green' : d.ba >= 40 ? 'badge-amber' : 'badge-red'}`}>{d.ba}%</span>
                  </td>
                  <td className="py-2 text-right mono font-medium" style={{ color: pnlColor(d.pnl) }}>{fmt$(d.pnl)}</td>
                  <td className="py-2 text-right mono text-text-muted">{d.trades > 0 ? fmt$(d.pnl / d.trades) : '--'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="py-8 text-center text-text-faint text-sm">Upload trades to see performance breakdown</div>
        )}
      </div>
    </div>
  );
}
