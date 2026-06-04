import React, { useState, useEffect, useMemo } from 'react';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, ReferenceLine, ScatterChart, Scatter, ZAxis } from 'recharts';
import { TrendingUp, Calendar, Clock, Layers, Activity } from 'lucide-react';
import { api } from '../utils/api';
import { fmt$, pnlColor } from '../utils/format';

export default function Analytics({ authenticated }) {
  const [tracker, setTracker] = useState([]);
  const [decisions, setDecisions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [section, setSection] = useState('time');

  useEffect(() => {
    if (!authenticated) { setLoading(false); return; }
    Promise.all([
      api.getTracker().catch(() => []),
      api.getDecisions().catch(() => [])
    ]).then(([t, d]) => {
      setTracker(t);
      if (d && d.length > 1) {
        const headers = d[0];
        setDecisions(d.slice(1).map(row => {
          const obj = {};
          headers.forEach((h, i) => { obj[h] = row[i] || ''; });
          return obj;
        }));
      }
      setLoading(false);
    });
  }, [authenticated]);

  const closed = useMemo(() =>
    tracker.filter(t => t.Status !== 'Open' && t['Total P&L ($)'])
      .map(t => ({
        ...t,
        pnl: parseFloat(t['Total P&L ($)']) || 0,
        entryDate: t['Entry Date'] ? new Date(t['Entry Date']) : null,
        closeDate: t['Close Date'] ? new Date(t['Close Date']) : null,
        strategy: t['Strategy (OIC)'] || 'Unknown',
        underlying: t.Underlying || '',
        wl: t['W / L'] || '',
        dte: t['Expiry Date'] && t['Entry Date']
          ? Math.ceil((new Date(t['Expiry Date']) - new Date(t['Entry Date'])) / 86400000) : null
      }))
      .filter(t => t.entryDate)
      .sort((a, b) => a.entryDate - b.entryDate)
  , [tracker]);

  if (!authenticated) {
    return (
      <div className="fade-in">
        <h2 className="font-display text-2xl font-bold mb-2">Analytics</h2>
        <p className="text-text-muted">Connect Google to view performance analytics.</p>
      </div>
    );
  }
  if (loading) return <div className="text-text-muted text-sm">Loading analytics...</div>;

  const SECTIONS = [
    { id: 'time', label: 'Time patterns', icon: Clock },
    { id: 'regime', label: 'Regime performance', icon: Layers },
    { id: 'decay', label: 'DTE analysis', icon: Calendar },
    { id: 'rolling', label: 'Rolling stats', icon: Activity },
  ];

  return (
    <div className="fade-in">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="font-display text-2xl font-bold">Analytics</h2>
          <p className="text-text-muted text-sm mt-0.5">{closed.length} closed trades analysed</p>
        </div>
        <div className="flex border border-bg-border rounded-lg overflow-hidden">
          {SECTIONS.map(s => (
            <button key={s.id} onClick={() => setSection(s.id)}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors ${section === s.id ? 'bg-accent text-white' : 'text-text-muted hover:text-text hover:bg-bg-hover'}`}>
              <s.icon size={12} /> {s.label}
            </button>
          ))}
        </div>
      </div>

      {section === 'time' && <TimePatterns closed={closed} />}
      {section === 'regime' && <RegimePerformance closed={closed} decisions={decisions} />}
      {section === 'decay' && <DTEAnalysis closed={closed} />}
      {section === 'rolling' && <RollingStats closed={closed} />}
    </div>
  );
}

// ═══════════════════════════════════════════
//  TIME PATTERNS
// ═══════════════════════════════════════════
function TimePatterns({ closed }) {
  // Day of week
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const byDow = DOW.map(d => ({ name: d, pnl: 0, trades: 0, wins: 0 }));
  closed.forEach(t => {
    const d = t.entryDate.getDay();
    byDow[d].pnl += t.pnl;
    byDow[d].trades++;
    if (t.wl === 'Win') byDow[d].wins++;
  });
  const dowData = byDow.filter(d => d.trades > 0).map(d => ({ ...d, ba: d.trades > 0 ? Math.round(d.wins / d.trades * 100) : 0 }));

  // Hour of day (from entry time if available)
  const byHour = {};
  closed.forEach(t => {
    const h = t.entryDate.getHours();
    if (!byHour[h]) byHour[h] = { hour: h, pnl: 0, trades: 0, wins: 0 };
    byHour[h].pnl += t.pnl;
    byHour[h].trades++;
    if (t.wl === 'Win') byHour[h].wins++;
  });
  const hourData = Object.values(byHour)
    .sort((a, b) => a.hour - b.hour)
    .map(h => ({ ...h, label: `${h.hour}:00`, ba: h.trades > 0 ? Math.round(h.wins / h.trades * 100) : 0 }));

  // Monthly performance
  const byMonth = {};
  closed.forEach(t => {
    const key = `${t.entryDate.getFullYear()}-${String(t.entryDate.getMonth() + 1).padStart(2, '0')}`;
    if (!byMonth[key]) byMonth[key] = { month: key, pnl: 0, trades: 0, wins: 0 };
    byMonth[key].pnl += t.pnl;
    byMonth[key].trades++;
    if (t.wl === 'Win') byMonth[key].wins++;
  });
  const monthData = Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month))
    .map(m => ({ ...m, ba: m.trades > 0 ? Math.round(m.wins / m.trades * 100) : 0 }));

  // Best and worst days of week
  const bestDow = dowData.reduce((best, d) => d.pnl > best.pnl ? d : best, { pnl: -Infinity, name: '--' });
  const worstDow = dowData.reduce((worst, d) => d.pnl < worst.pnl ? d : worst, { pnl: Infinity, name: '--' });

  return (
    <div className="space-y-4">
      {/* KPI row */}
      <div className="grid grid-cols-4 gap-3">
        <MiniKPI label="Best day of week" value={bestDow.name} sub={fmt$(bestDow.pnl)} cls="text-green" />
        <MiniKPI label="Worst day of week" value={worstDow.name} sub={fmt$(worstDow.pnl)} cls="text-red" />
        <MiniKPI label="Most active day" value={dowData.sort((a,b)=>b.trades-a.trades)[0]?.name || '--'} sub={`${dowData[0]?.trades || 0} trades`} />
        <MiniKPI label="Best month" value={monthData.sort((a,b)=>b.pnl-a.pnl)[0]?.month || '--'} sub={fmt$(monthData[0]?.pnl || 0)} cls="text-green" />
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* P&L by Day of Week */}
        <div className="card">
          <h3 className="text-sm font-medium text-text-muted mb-3">P&L by Day of Week</h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={dowData}>
              <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#8b949e' }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 10, fill: '#484f58' }} axisLine={false} tickLine={false} tickFormatter={v => '$' + v} />
              <Tooltip contentStyle={ttStyle} labelStyle={{ color: '#8b949e' }}
                formatter={v => [<span style={{ color: v >= 0 ? '#3fb950' : '#f85149', fontWeight: 600, fontFamily: 'JetBrains Mono' }}>{fmt$(v)}</span>, 'P&L']} />
              <ReferenceLine y={0} stroke="#30363d" strokeDasharray="3 3" />
              <Bar dataKey="pnl" radius={[4, 4, 0, 0]}>
                {dowData.map((d, i) => <Cell key={i} fill={d.pnl >= 0 ? '#238636' : '#da3633'} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <div className="flex gap-2 mt-2">
            {dowData.map((d, i) => (
              <div key={i} className="flex-1 text-center">
                <div className="text-[10px] text-text-muted">{d.trades}t</div>
                <div className={`text-[10px] mono font-medium ${d.ba >= 60 ? 'text-green' : d.ba >= 40 ? 'text-amber' : 'text-red'}`}>{d.ba}%</div>
              </div>
            ))}
          </div>
        </div>

        {/* P&L by Hour */}
        <div className="card">
          <h3 className="text-sm font-medium text-text-muted mb-3">P&L by Entry Hour</h3>
          {hourData.length > 1 ? (
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={hourData}>
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#8b949e' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: '#484f58' }} axisLine={false} tickLine={false} tickFormatter={v => '$' + v} />
                <Tooltip contentStyle={ttStyle} labelStyle={{ color: '#8b949e' }}
                  formatter={(v, n, p) => {
                    const d = p.payload;
                    return [<span style={{ color: v >= 0 ? '#3fb950' : '#f85149', fontWeight: 600, fontFamily: 'JetBrains Mono' }}>
                      {fmt$(v)} ({d.trades}t, {d.ba}% BA)
                    </span>, 'P&L'];
                  }} />
                <ReferenceLine y={0} stroke="#30363d" strokeDasharray="3 3" />
                <Bar dataKey="pnl" radius={[3, 3, 0, 0]}>
                  {hourData.map((d, i) => <Cell key={i} fill={d.pnl >= 0 ? '#238636' : '#da3633'} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[250px] flex items-center justify-center text-text-faint text-sm">
              Need trades with time-of-day data to show hourly patterns
            </div>
          )}
        </div>
      </div>

      {/* Monthly performance */}
      <div className="card">
        <h3 className="text-sm font-medium text-text-muted mb-3">Monthly Performance</h3>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={monthData}>
            <XAxis dataKey="month" tick={{ fontSize: 10, fill: '#8b949e' }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 10, fill: '#484f58' }} axisLine={false} tickLine={false} tickFormatter={v => '$' + v} />
            <Tooltip contentStyle={ttStyle} labelStyle={{ color: '#8b949e' }}
              formatter={(v, n, p) => {
                const d = p.payload;
                return [<span style={{ color: v >= 0 ? '#3fb950' : '#f85149', fontWeight: 600, fontFamily: 'JetBrains Mono' }}>
                  {fmt$(v)} ({d.trades}t, {d.ba}% BA)
                </span>, 'P&L'];
              }} />
            <ReferenceLine y={0} stroke="#30363d" strokeDasharray="3 3" />
            <Bar dataKey="pnl" radius={[4, 4, 0, 0]}>
              {monthData.map((d, i) => <Cell key={i} fill={d.pnl >= 0 ? '#238636' : '#da3633'} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════
//  REGIME PERFORMANCE
// ═══════════════════════════════════════════
function RegimePerformance({ closed, decisions }) {
  // Build regime map from decisions
  const decByKey = {};
  decisions.forEach(d => {
    if (!d.Timestamp || !d.Underlying) return;
    const date = new Date(d.Timestamp).toISOString().split('T')[0];
    const key = `${d.Underlying}_${date}`;
    decByKey[key] = d;
  });

  // Match trades to their decision engine entries
  const tradesByRegime = {};
  const tradesBySetup = {};
  const tradesByDirection = {};

  closed.forEach(t => {
    const date = t.entryDate.toISOString().split('T')[0];
    const key = `${t.underlying}_${date}`;
    const dec = decByKey[key];

    const regime = dec?.Regime || 'Unknown';
    const setup = dec?.['Setup Grade'] || 'No engine data';
    const direction = dec?.Direction || 'No engine data';

    [tradesByRegime, regime].reduce((m, k) => { if (!m[k]) m[k] = { pnl: 0, trades: 0, wins: 0 }; m[k].pnl += t.pnl; m[k].trades++; if (t.wl === 'Win') m[k].wins++; return m; }, tradesByRegime);
    [tradesBySetup, setup].reduce((m, k) => { if (!m[k]) m[k] = { pnl: 0, trades: 0, wins: 0 }; m[k].pnl += t.pnl; m[k].trades++; if (t.wl === 'Win') m[k].wins++; return m; }, tradesBySetup);
    [tradesByDirection, direction].reduce((m, k) => { if (!m[k]) m[k] = { pnl: 0, trades: 0, wins: 0 }; m[k].pnl += t.pnl; m[k].trades++; if (t.wl === 'Win') m[k].wins++; return m; }, tradesByDirection);
  });

  const regimeData = Object.entries(tradesByRegime).map(([name, d]) => ({ name, ...d, ba: d.trades > 0 ? Math.round(d.wins / d.trades * 100) : 0 })).sort((a, b) => b.pnl - a.pnl);
  const setupData = Object.entries(tradesBySetup).map(([name, d]) => ({ name, ...d, ba: d.trades > 0 ? Math.round(d.wins / d.trades * 100) : 0 })).sort((a, b) => b.pnl - a.pnl);
  const dirData = Object.entries(tradesByDirection).map(([name, d]) => ({ name, ...d, ba: d.trades > 0 ? Math.round(d.wins / d.trades * 100) : 0 })).sort((a, b) => b.pnl - a.pnl);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-4">
        {/* By Regime */}
        <div className="card">
          <h3 className="text-sm font-medium text-text-muted mb-3">P&L by Regime</h3>
          <BreakdownTable data={regimeData} />
        </div>

        {/* By Setup Grade */}
        <div className="card">
          <h3 className="text-sm font-medium text-text-muted mb-3">P&L by Setup Grade</h3>
          <BreakdownTable data={setupData} />
        </div>

        {/* By Engine Direction */}
        <div className="card">
          <h3 className="text-sm font-medium text-text-muted mb-3">P&L by Engine Direction</h3>
          <BreakdownTable data={dirData} />
        </div>
      </div>

      {/* Regime chart */}
      {regimeData.length > 0 && (
        <div className="card">
          <h3 className="text-sm font-medium text-text-muted mb-3">Regime P&L Comparison</h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={regimeData} layout="vertical" margin={{ left: 120 }}>
              <XAxis type="number" tick={{ fontSize: 10, fill: '#484f58' }} axisLine={false} tickLine={false} tickFormatter={v => '$' + v} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: '#8b949e' }} axisLine={false} tickLine={false} width={120} />
              <Tooltip contentStyle={ttStyle} formatter={v => [<span style={{ color: v >= 0 ? '#3fb950' : '#f85149', fontWeight: 600, fontFamily: 'JetBrains Mono' }}>{fmt$(v)}</span>, 'P&L']} />
              <ReferenceLine x={0} stroke="#30363d" />
              <Bar dataKey="pnl" radius={[0, 4, 4, 0]}>
                {regimeData.map((d, i) => <Cell key={i} fill={d.pnl >= 0 ? '#238636' : '#da3633'} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Setup quality edge */}
      {setupData.filter(d => d.name !== 'No engine data').length > 0 && (
        <div className="card">
          <h3 className="text-sm font-medium text-text-muted mb-3">Does Setup Quality Predict Wins?</h3>
          <div className="grid grid-cols-4 gap-3">
            {['A+ Setup', 'A Setup', 'B Setup', 'No setup'].map(grade => {
              const d = setupData.find(s => s.name === grade);
              if (!d) return <div key={grade} className="p-3 rounded-lg border border-bg-border text-center text-text-faint text-xs">{grade}: no data</div>;
              return (
                <div key={grade} className="p-3 rounded-lg border border-bg-border">
                  <div className="text-xs text-text-muted text-center mb-1">{grade}</div>
                  <div className="mono text-lg font-bold text-center" style={{ color: pnlColor(d.pnl) }}>{fmt$(d.pnl)}</div>
                  <div className="flex justify-center gap-3 mt-1 text-[10px]">
                    <span className="text-text-muted">{d.trades}t</span>
                    <span className={d.ba >= 60 ? 'text-green' : d.ba >= 40 ? 'text-amber' : 'text-red'}>{d.ba}% BA</span>
                  </div>
                  <div className="mt-2 h-1.5 rounded-full bg-bg-border overflow-hidden flex">
                    <div className="bg-green h-full" style={{ width: `${d.ba}%` }} />
                    <div className="bg-red h-full" style={{ width: `${100 - d.ba}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════
//  DTE ANALYSIS
// ═══════════════════════════════════════════
function DTEAnalysis({ closed }) {
  // Group by DTE buckets
  const dteBuckets = { '0DTE': { min: 0, max: 0 }, '1-7 DTE': { min: 1, max: 7 }, '8-21 DTE': { min: 8, max: 21 },
    '22-45 DTE': { min: 22, max: 45 }, '46+ DTE': { min: 46, max: 9999 } };

  const byBucket = {};
  Object.keys(dteBuckets).forEach(k => { byBucket[k] = { pnl: 0, trades: 0, wins: 0 }; });

  closed.forEach(t => {
    if (t.dte === null) return;
    for (const [name, range] of Object.entries(dteBuckets)) {
      if (t.dte >= range.min && t.dte <= range.max) {
        byBucket[name].pnl += t.pnl;
        byBucket[name].trades++;
        if (t.wl === 'Win') byBucket[name].wins++;
        break;
      }
    }
  });

  const bucketData = Object.entries(byBucket)
    .filter(([_, d]) => d.trades > 0)
    .map(([name, d]) => ({ name, ...d, ba: d.trades > 0 ? Math.round(d.wins / d.trades * 100) : 0, avgPnl: d.trades > 0 ? d.pnl / d.trades : 0 }));

  // P&L vs DTE scatter (individual trades)
  const scatterData = closed.filter(t => t.dte !== null).map(t => ({
    dte: t.dte, pnl: t.pnl, strategy: t.strategy, underlying: t.underlying
  }));

  // Holding period analysis (entry to close)
  const holdingPeriod = {};
  closed.forEach(t => {
    if (!t.closeDate || !t.entryDate) return;
    const days = Math.ceil((t.closeDate - t.entryDate) / 86400000);
    const bucket = days === 0 ? '0d (same day)' : days <= 3 ? '1-3 days' : days <= 7 ? '4-7 days'
      : days <= 14 ? '8-14 days' : days <= 30 ? '15-30 days' : '31+ days';
    if (!holdingPeriod[bucket]) holdingPeriod[bucket] = { pnl: 0, trades: 0, wins: 0 };
    holdingPeriod[bucket].pnl += t.pnl;
    holdingPeriod[bucket].trades++;
    if (t.wl === 'Win') holdingPeriod[bucket].wins++;
  });
  const holdData = Object.entries(holdingPeriod)
    .map(([name, d]) => ({ name, ...d, ba: d.trades > 0 ? Math.round(d.wins / d.trades * 100) : 0 }));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        {/* DTE bucket performance */}
        <div className="card">
          <h3 className="text-sm font-medium text-text-muted mb-3">P&L by DTE at Entry</h3>
          {bucketData.length > 0 ? (
            <>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={bucketData}>
                  <XAxis dataKey="name" tick={{ fontSize: 10, fill: '#8b949e' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: '#484f58' }} axisLine={false} tickLine={false} tickFormatter={v => '$' + v} />
                  <Tooltip contentStyle={ttStyle} formatter={(v, n, p) => {
                    const d = p.payload;
                    return [<span style={{ color: v >= 0 ? '#3fb950' : '#f85149', fontWeight: 600, fontFamily: 'JetBrains Mono' }}>
                      {fmt$(v)} ({d.trades}t, {d.ba}% BA)
                    </span>, 'P&L'];
                  }} />
                  <ReferenceLine y={0} stroke="#30363d" strokeDasharray="3 3" />
                  <Bar dataKey="pnl" radius={[4, 4, 0, 0]}>
                    {bucketData.map((d, i) => <Cell key={i} fill={d.pnl >= 0 ? '#238636' : '#da3633'} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <BreakdownTable data={bucketData} />
            </>
          ) : (
            <div className="h-[200px] flex items-center justify-center text-text-faint text-sm">No DTE data available</div>
          )}
        </div>

        {/* Holding period */}
        <div className="card">
          <h3 className="text-sm font-medium text-text-muted mb-3">P&L by Holding Period</h3>
          {holdData.length > 0 ? (
            <BreakdownTable data={holdData} />
          ) : (
            <div className="h-[200px] flex items-center justify-center text-text-faint text-sm">Need close dates to analyse holding periods</div>
          )}
        </div>
      </div>

      {/* P&L vs DTE Scatter */}
      {scatterData.length > 3 && (
        <div className="card">
          <h3 className="text-sm font-medium text-text-muted mb-3">P&L vs DTE at Entry (each dot = one trade)</h3>
          <ResponsiveContainer width="100%" height={250}>
            <ScatterChart>
              <XAxis dataKey="dte" name="DTE" tick={{ fontSize: 10, fill: '#8b949e' }} axisLine={false} tickLine={false} />
              <YAxis dataKey="pnl" name="P&L" tick={{ fontSize: 10, fill: '#484f58' }} axisLine={false} tickLine={false} tickFormatter={v => '$' + v} />
              <ZAxis range={[30, 30]} />
              <Tooltip contentStyle={ttStyle} formatter={(v, name) => [
                <span style={{ fontFamily: 'JetBrains Mono', fontWeight: 600, color: name === 'P&L' ? (v >= 0 ? '#3fb950' : '#f85149') : '#8b949e' }}>
                  {name === 'P&L' ? fmt$(v) : v}
                </span>, name
              ]} />
              <ReferenceLine y={0} stroke="#30363d" strokeDasharray="3 3" />
              <Scatter data={scatterData.filter(d => d.pnl >= 0)} fill="#238636" opacity={0.7} />
              <Scatter data={scatterData.filter(d => d.pnl < 0)} fill="#da3633" opacity={0.7} />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════
//  ROLLING STATS
// ═══════════════════════════════════════════
function RollingStats({ closed }) {
  // Rolling 10-trade win rate
  const rollingBA = [];
  const rollingPnl = [];
  const WINDOW = 10;

  for (let i = WINDOW - 1; i < closed.length; i++) {
    const window = closed.slice(i - WINDOW + 1, i + 1);
    const wins = window.filter(t => t.wl === 'Win').length;
    const pnl = window.reduce((s, t) => s + t.pnl, 0);
    const label = closed[i].entryDate.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
    rollingBA.push({ label, ba: Math.round(wins / WINDOW * 100), idx: i });
    rollingPnl.push({ label, pnl: Math.round(pnl * 100) / 100, idx: i });
  }

  // Cumulative stats
  let cumWins = 0, cumTrades = 0;
  const cumBA = closed.map((t, i) => {
    cumTrades++;
    if (t.wl === 'Win') cumWins++;
    return {
      label: t.entryDate.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }),
      ba: Math.round(cumWins / cumTrades * 100),
      idx: i
    };
  });

  // Win/loss run distribution
  const runs = [];
  let currentRun = { type: '', count: 0 };
  closed.forEach(t => {
    if (t.wl === currentRun.type) {
      currentRun.count++;
    } else {
      if (currentRun.count > 0) runs.push({ ...currentRun });
      currentRun = { type: t.wl, count: 1 };
    }
  });
  if (currentRun.count > 0) runs.push(currentRun);

  const winRuns = runs.filter(r => r.type === 'Win').map(r => r.count);
  const lossRuns = runs.filter(r => r.type === 'Loss').map(r => r.count);
  const avgWinRun = winRuns.length > 0 ? (winRuns.reduce((s, v) => s + v, 0) / winRuns.length).toFixed(1) : 0;
  const avgLossRun = lossRuns.length > 0 ? (lossRuns.reduce((s, v) => s + v, 0) / lossRuns.length).toFixed(1) : 0;
  const maxWinRun = winRuns.length > 0 ? Math.max(...winRuns) : 0;
  const maxLossRun = lossRuns.length > 0 ? Math.max(...lossRuns) : 0;

  // Expectancy over time
  let cumPnl = 0;
  const expectancyCurve = closed.map((t, i) => {
    cumPnl += t.pnl;
    return { label: t.entryDate.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }), expectancy: Math.round(cumPnl / (i + 1) * 100) / 100, idx: i };
  });

  return (
    <div className="space-y-4">
      {/* KPIs */}
      <div className="grid grid-cols-4 gap-3">
        <MiniKPI label="Avg win streak" value={`${avgWinRun} trades`} sub={`Max: ${maxWinRun}`} cls="text-green" />
        <MiniKPI label="Avg loss streak" value={`${avgLossRun} trades`} sub={`Max: ${maxLossRun}`} cls="text-red" />
        <MiniKPI label="Current rolling BA" value={rollingBA.length > 0 ? `${rollingBA[rollingBA.length - 1].ba}%` : '--'} sub={`Last ${WINDOW} trades`} />
        <MiniKPI label="Expectancy/trade" value={closed.length > 0 ? fmt$(cumPnl / closed.length) : '--'}
          cls={cumPnl > 0 ? 'text-green' : 'text-red'} />
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* Rolling win rate */}
        <div className="card">
          <h3 className="text-sm font-medium text-text-muted mb-3">Rolling {WINDOW}-Trade Win Rate</h3>
          {rollingBA.length > 2 ? (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={rollingBA}>
                <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#484f58' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: '#484f58' }} axisLine={false} tickLine={false} domain={[0, 100]} tickFormatter={v => v + '%'} />
                <Tooltip contentStyle={ttStyle} formatter={v => [<span style={{ color: v >= 50 ? '#3fb950' : '#f85149', fontWeight: 600, fontFamily: 'JetBrains Mono' }}>{v}%</span>, 'Win rate']} />
                <ReferenceLine y={50} stroke="#d29922" strokeDasharray="3 3" label={{ value: '50%', fill: '#d29922', fontSize: 10 }} />
                <Line type="monotone" dataKey="ba" stroke="#2f81f7" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[200px] flex items-center justify-center text-text-faint text-sm">Need {WINDOW}+ trades for rolling stats</div>
          )}
        </div>

        {/* Cumulative win rate */}
        <div className="card">
          <h3 className="text-sm font-medium text-text-muted mb-3">Cumulative Win Rate Over Time</h3>
          {cumBA.length > 2 ? (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={cumBA}>
                <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#484f58' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: '#484f58' }} axisLine={false} tickLine={false} domain={[0, 100]} tickFormatter={v => v + '%'} />
                <Tooltip contentStyle={ttStyle} formatter={v => [<span style={{ color: v >= 50 ? '#3fb950' : '#f85149', fontWeight: 600, fontFamily: 'JetBrains Mono' }}>{v}%</span>, 'Cumulative BA']} />
                <ReferenceLine y={50} stroke="#d29922" strokeDasharray="3 3" />
                <Line type="monotone" dataKey="ba" stroke="#3fb950" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[200px] flex items-center justify-center text-text-faint text-sm">Need more trades</div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* Rolling P&L */}
        <div className="card">
          <h3 className="text-sm font-medium text-text-muted mb-3">Rolling {WINDOW}-Trade P&L</h3>
          {rollingPnl.length > 2 ? (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={rollingPnl}>
                <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#484f58' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: '#484f58' }} axisLine={false} tickLine={false} tickFormatter={v => '$' + v} />
                <Tooltip contentStyle={ttStyle} formatter={v => [<span style={{ color: v >= 0 ? '#3fb950' : '#f85149', fontWeight: 600, fontFamily: 'JetBrains Mono' }}>{fmt$(v)}</span>, `Last ${WINDOW} trades`]} />
                <ReferenceLine y={0} stroke="#30363d" strokeDasharray="3 3" />
                <Line type="monotone" dataKey="pnl" stroke="#2f81f7" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[200px] flex items-center justify-center text-text-faint text-sm">Need {WINDOW}+ trades</div>
          )}
        </div>

        {/* Expectancy curve */}
        <div className="card">
          <h3 className="text-sm font-medium text-text-muted mb-3">Expectancy Per Trade Over Time</h3>
          {expectancyCurve.length > 2 ? (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={expectancyCurve}>
                <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#484f58' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: '#484f58' }} axisLine={false} tickLine={false} tickFormatter={v => '$' + v} />
                <Tooltip contentStyle={ttStyle} formatter={v => [<span style={{ color: v >= 0 ? '#3fb950' : '#f85149', fontWeight: 600, fontFamily: 'JetBrains Mono' }}>{fmt$(v)}</span>, 'Expectancy/trade']} />
                <ReferenceLine y={0} stroke="#30363d" strokeDasharray="3 3" />
                <Line type="monotone" dataKey="expectancy" stroke="#d29922" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-[200px] flex items-center justify-center text-text-faint text-sm">Need more trades</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════
//  SHARED COMPONENTS
// ═══════════════════════════════════════════
const ttStyle = { background: '#161b22', border: '1px solid #30363d', borderRadius: 8, fontSize: 12 };

function MiniKPI({ label, value, sub, cls }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value ${cls || ''}`}>{value}</div>
      {sub && <div className="text-[10px] text-text-faint mt-0.5">{sub}</div>}
    </div>
  );
}

function BreakdownTable({ data }) {
  return (
    <div className="space-y-1.5 mt-2">
      {data.map((d, i) => (
        <div key={i} className="flex items-center gap-2 py-1.5 border-b border-bg-border last:border-0">
          <span className="text-xs text-text w-28 truncate font-medium">{d.name}</span>
          <div className="flex-1 h-1.5 rounded-full bg-bg-border overflow-hidden flex">
            <div className="bg-green h-full" style={{ width: `${d.ba}%` }} />
            <div className="bg-red h-full" style={{ width: `${100 - d.ba}%` }} />
          </div>
          <span className="mono text-[10px] w-8 text-right">{d.ba}%</span>
          <span className="text-[10px] text-text-faint w-8 text-right">{d.trades}t</span>
          <span className="mono text-xs w-14 text-right font-medium" style={{ color: pnlColor(d.pnl) }}>{fmt$(d.pnl)}</span>
        </div>
      ))}
    </div>
  );
}
