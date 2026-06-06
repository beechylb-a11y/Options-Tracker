import React, { useState, useEffect, useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, PieChart, Pie, ReferenceLine } from 'recharts';
import { Shield, AlertTriangle, Edit3, Save, RefreshCw } from 'lucide-react';
import { api } from '../utils/api';
import { fmt$, pnlColor, filterByAccount } from '../utils/format';

// Sector mapping for common underlyings
const SECTORS = {
  SPX: 'Index', SPY: 'Index', QQQ: 'Index', IWM: 'Index', DIA: 'Index',
  NVDA: 'Semiconductors', AMD: 'Semiconductors', INTC: 'Semiconductors', AVGO: 'Semiconductors', MU: 'Semiconductors',
  AAPL: 'Tech', MSFT: 'Tech', GOOGL: 'Tech', META: 'Tech', AMZN: 'Consumer/Tech', NFLX: 'Consumer/Tech',
  TSLA: 'EV/Auto', RIVN: 'EV/Auto',
  PLTR: 'Software', CRM: 'Software', SNOW: 'Software',
  MSTR: 'Crypto proxy', COIN: 'Crypto proxy',
  GLD: 'Commodities', SLV: 'Commodities', USO: 'Commodities',
  TLT: 'Bonds', HYG: 'Bonds', IEF: 'Bonds',
  XLF: 'Financials', JPM: 'Financials', BAC: 'Financials',
  XLE: 'Energy', XOP: 'Energy',
  VIX: 'Volatility', UVXY: 'Volatility', VXX: 'Volatility',
};

function getSector(underlying) {
  return SECTORS[underlying] || 'Other';
}

export default function PortfolioRisk({ authenticated, account }) {
  const [tracker, setTracker] = useState([]);
  const [loading, setLoading] = useState(true);
  const [greeks, setGreeks] = useState({}); // { underlying: { delta, gamma, theta, vega, iv } }
  const [editingRow, setEditingRow] = useState(null);
  const [editForm, setEditForm] = useState({ delta: '', gamma: '', theta: '', vega: '', iv: '' });

  useEffect(() => {
    if (!authenticated) { setLoading(false); return; }
    api.getTracker().then(t => {
      setTracker(t);
      // Load saved greeks from localStorage (persists between sessions)
      try {
        const saved = localStorage.getItem('portfolio-greeks');
        if (saved) setGreeks(JSON.parse(saved));
      } catch (e) {}
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [authenticated]);

  // Open positions
  const openPositions = useMemo(() =>
    filterByAccount(tracker, account).filter(t => t.Status === 'Open').map(t => {
      const underlying = t.Underlying || '';
      const qty = parseInt(t.Qty) || 1;
      const g = greeks[underlying] || {};
      const dte = t['Expiry Date']
        ? Math.max(0, Math.ceil((new Date(t['Expiry Date']) - new Date()) / 86400000)) : null;
      return {
        ...t, underlying, qty, dte,
        strategy: t['Strategy (OIC)'] || '',
        credit: parseFloat(t['Net Credit ($)']) || 0,
        sector: getSector(underlying),
        delta: (g.delta || 0) * qty,
        gamma: (g.gamma || 0) * qty,
        theta: (g.theta || 0) * qty,
        vega: (g.vega || 0) * qty,
        iv: g.iv || 0,
        hasGreeks: !!(g.delta || g.theta || g.vega),
      };
    })
  , [tracker, greeks]);

  // Portfolio totals
  const totals = useMemo(() => {
    const t = { delta: 0, gamma: 0, theta: 0, vega: 0, positions: openPositions.length, withGreeks: 0 };
    openPositions.forEach(p => {
      t.delta += p.delta;
      t.gamma += p.gamma;
      t.theta += p.theta;
      t.vega += p.vega;
      if (p.hasGreeks) t.withGreeks++;
    });
    return t;
  }, [openPositions]);

  // Sector concentration
  const sectorData = useMemo(() => {
    const sectors = {};
    openPositions.forEach(p => {
      if (!sectors[p.sector]) sectors[p.sector] = { name: p.sector, count: 0, risk: 0, delta: 0, theta: 0 };
      sectors[p.sector].count++;
      sectors[p.sector].risk += Math.abs(p.credit);
      sectors[p.sector].delta += p.delta;
      sectors[p.sector].theta += p.theta;
    });
    return Object.values(sectors).sort((a, b) => b.count - a.count);
  }, [openPositions]);

  // Underlying concentration
  const underlyingData = useMemo(() => {
    const map = {};
    openPositions.forEach(p => {
      if (!map[p.underlying]) map[p.underlying] = { name: p.underlying, count: 0, delta: 0, theta: 0, vega: 0 };
      map[p.underlying].count++;
      map[p.underlying].delta += p.delta;
      map[p.underlying].theta += p.theta;
      map[p.underlying].vega += p.vega;
    });
    return Object.values(map).sort((a, b) => b.count - a.count);
  }, [openPositions]);

  // Correlation groups (underlyings in same sector)
  const correlationWarnings = useMemo(() => {
    const warnings = [];
    sectorData.forEach(s => {
      if (s.count >= 3 && s.name !== 'Index') {
        warnings.push(`${s.count} positions in ${s.name} — high correlation risk`);
      }
    });
    const totalDelta = Math.abs(totals.delta);
    if (totalDelta > 50) warnings.push(`Portfolio delta ${totals.delta > 0 ? '+' : ''}${totals.delta.toFixed(1)} — significant directional exposure`);
    if (totals.vega > 200 || totals.vega < -200) warnings.push(`Portfolio vega ${totals.vega > 0 ? '+' : ''}${totals.vega.toFixed(0)} — large vol exposure`);
    return warnings;
  }, [sectorData, totals]);

  function saveGreeks(underlying) {
    const updated = { ...greeks, [underlying]: {
      delta: parseFloat(editForm.delta) || 0,
      gamma: parseFloat(editForm.gamma) || 0,
      theta: parseFloat(editForm.theta) || 0,
      vega: parseFloat(editForm.vega) || 0,
      iv: parseFloat(editForm.iv) || 0,
    }};
    setGreeks(updated);
    try { localStorage.setItem('portfolio-greeks', JSON.stringify(updated)); } catch (e) {}
    setEditingRow(null);
  }

  function clearAllGreeks() {
    setGreeks({});
    try { localStorage.removeItem('portfolio-greeks'); } catch (e) {}
  }

  if (!authenticated) {
    return (
      <div className="fade-in">
        <h2 className="font-display text-2xl font-bold mb-2">Portfolio Risk</h2>
        <p className="text-text-muted">Connect Google to view portfolio risk.</p>
      </div>
    );
  }
  if (loading) return <div className="text-text-muted text-sm">Loading portfolio...</div>;

  const COLORS = ['#2f81f7', '#3fb950', '#d29922', '#f85149', '#a371f7', '#79c0ff', '#d2a8ff', '#7ee787', '#ffa657', '#ff7b72'];

  return (
    <div className="fade-in">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="font-display text-2xl font-bold">Portfolio Risk</h2>
          <p className="text-text-muted text-sm mt-0.5">
            {totals.positions} open position{totals.positions !== 1 ? 's' : ''}
            {totals.withGreeks > 0 && ` — ${totals.withGreeks} with Greeks entered`}
          </p>
        </div>
        {Object.keys(greeks).length > 0 && (
          <button onClick={clearAllGreeks}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-bg-border rounded-lg hover:bg-bg-hover text-text-muted transition-colors">
            <RefreshCw size={12} /> Clear all Greeks
          </button>
        )}
      </div>

      {openPositions.length === 0 ? (
        <div className="card py-12 text-center text-text-faint">No open positions. Upload a TastyTrade CSV with open trades.</div>
      ) : (
        <div className="space-y-4">
          {/* Risk warnings */}
          {correlationWarnings.length > 0 && (
            <div className="p-3 rounded-lg border border-amber/30 bg-amber/5">
              <div className="flex items-center gap-2 text-amber text-xs font-medium mb-1">
                <AlertTriangle size={14} /> Risk warnings
              </div>
              {correlationWarnings.map((w, i) => (
                <div key={i} className="text-xs text-text-muted ml-5 mt-0.5">{w}</div>
              ))}
            </div>
          )}

          {/* Portfolio Greeks KPIs */}
          <div className="grid grid-cols-5 gap-3">
            <GreekKPI label="Portfolio Delta" value={totals.delta.toFixed(1)} sub="Directional exposure"
              cls={Math.abs(totals.delta) > 20 ? (totals.delta > 0 ? 'text-green' : 'text-red') : ''} />
            <GreekKPI label="Portfolio Gamma" value={totals.gamma.toFixed(2)} sub="Delta acceleration"
              cls={totals.gamma > 0 ? 'text-green' : 'text-red'} />
            <GreekKPI label="Portfolio Theta" value={fmt$(totals.theta)} sub="Daily time decay"
              cls={totals.theta > 0 ? 'text-green' : 'text-red'} />
            <GreekKPI label="Portfolio Vega" value={totals.vega.toFixed(0)} sub="Vol sensitivity"
              cls={Math.abs(totals.vega) > 100 ? 'text-amber' : ''} />
            <GreekKPI label="Positions" value={totals.positions} sub={`${totals.withGreeks} with Greeks`} />
          </div>

          <div className="grid grid-cols-3 gap-4">
            {/* Sector concentration pie */}
            <div className="card">
              <h3 className="text-sm font-medium text-text-muted mb-3">Sector Concentration</h3>
              {sectorData.length > 0 ? (
                <>
                  <ResponsiveContainer width="100%" height={180}>
                    <PieChart>
                      <Pie data={sectorData} dataKey="count" nameKey="name" cx="50%" cy="50%"
                        outerRadius={70} innerRadius={35} strokeWidth={1} stroke="#0d1117">
                        {sectorData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                      </Pie>
                      <Tooltip contentStyle={ttStyle}
                        formatter={(v, n, p) => [`${v} position${v !== 1 ? 's' : ''}`, p.payload.name]} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="space-y-1 mt-2">
                    {sectorData.map((s, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs">
                        <div className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: COLORS[i % COLORS.length] }} />
                        <span className="text-text flex-1">{s.name}</span>
                        <span className="mono text-text-muted">{s.count}</span>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="h-[180px] flex items-center justify-center text-text-faint text-sm">No data</div>
              )}
            </div>

            {/* Delta by underlying */}
            <div className="card">
              <h3 className="text-sm font-medium text-text-muted mb-3">Delta Exposure by Underlying</h3>
              {underlyingData.filter(u => u.delta !== 0).length > 0 ? (
                <ResponsiveContainer width="100%" height={Math.max(180, underlyingData.length * 28)}>
                  <BarChart data={underlyingData} layout="vertical" margin={{ left: 50 }}>
                    <XAxis type="number" tick={{ fontSize: 10, fill: '#484f58' }} axisLine={false} tickLine={false} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: '#8b949e' }} axisLine={false} tickLine={false} width={50} />
                    <Tooltip contentStyle={ttStyle}
                      formatter={v => [<span style={{ color: v >= 0 ? '#3fb950' : '#f85149', fontWeight: 600, fontFamily: 'JetBrains Mono' }}>{v.toFixed(1)}</span>, 'Delta']} />
                    <ReferenceLine x={0} stroke="#30363d" />
                    <Bar dataKey="delta" radius={[0, 4, 4, 0]}>
                      {underlyingData.map((d, i) => <Cell key={i} fill={d.delta >= 0 ? '#238636' : '#da3633'} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-[180px] flex items-center justify-center text-text-faint text-sm">Enter Greeks for positions to see delta exposure</div>
              )}
            </div>

            {/* Theta by underlying */}
            <div className="card">
              <h3 className="text-sm font-medium text-text-muted mb-3">Daily Theta by Underlying</h3>
              {underlyingData.filter(u => u.theta !== 0).length > 0 ? (
                <ResponsiveContainer width="100%" height={Math.max(180, underlyingData.length * 28)}>
                  <BarChart data={underlyingData} layout="vertical" margin={{ left: 50 }}>
                    <XAxis type="number" tick={{ fontSize: 10, fill: '#484f58' }} axisLine={false} tickLine={false} tickFormatter={v => '$' + v} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 11, fill: '#8b949e' }} axisLine={false} tickLine={false} width={50} />
                    <Tooltip contentStyle={ttStyle}
                      formatter={v => [<span style={{ color: v >= 0 ? '#3fb950' : '#f85149', fontWeight: 600, fontFamily: 'JetBrains Mono' }}>{fmt$(v)}</span>, 'Theta/day']} />
                    <ReferenceLine x={0} stroke="#30363d" />
                    <Bar dataKey="theta" radius={[0, 4, 4, 0]}>
                      {underlyingData.map((d, i) => <Cell key={i} fill={d.theta >= 0 ? '#238636' : '#da3633'} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-[180px] flex items-center justify-center text-text-faint text-sm">Enter Greeks for positions to see theta</div>
              )}
            </div>
          </div>

          {/* Position table with editable Greeks */}
          <div className="card">
            <h3 className="text-sm font-medium text-text-muted mb-3">Open Positions — Greeks</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-text-faint text-[10px] uppercase tracking-wider">
                    <th className="text-left py-2 pr-3">Underlying</th>
                    <th className="text-left py-2 pr-3">Strategy</th>
                    <th className="text-center py-2 pr-3">DTE</th>
                    <th className="text-center py-2 pr-3">Qty</th>
                    <th className="text-right py-2 pr-3">Delta</th>
                    <th className="text-right py-2 pr-3">Gamma</th>
                    <th className="text-right py-2 pr-3">Theta</th>
                    <th className="text-right py-2 pr-3">Vega</th>
                    <th className="text-right py-2 pr-3">IV</th>
                    <th className="text-center py-2">Sector</th>
                    <th className="text-center py-2 w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {openPositions.map((p, i) => {
                    const isEditing = editingRow === i;
                    return (
                      <React.Fragment key={i}>
                        <tr className="table-row">
                          <td className="py-2 pr-3 font-medium">{p.underlying}</td>
                          <td className="py-2 pr-3 text-text-muted text-xs">{p.strategy}</td>
                          <td className="py-2 pr-3 text-center">
                            <span className={`badge text-[10px] ${p.dte !== null && p.dte <= 3 ? 'badge-red' : p.dte !== null && p.dte <= 7 ? 'badge-amber' : 'badge-blue'}`}>
                              {p.dte !== null ? `${p.dte}d` : '--'}
                            </span>
                          </td>
                          <td className="py-2 pr-3 text-center mono">{p.qty}</td>
                          <td className="py-2 pr-3 text-right mono" style={{ color: p.delta !== 0 ? pnlColor(p.delta) : '#484f58' }}>
                            {p.hasGreeks ? p.delta.toFixed(2) : '--'}
                          </td>
                          <td className="py-2 pr-3 text-right mono text-text-muted">
                            {p.hasGreeks ? p.gamma.toFixed(3) : '--'}
                          </td>
                          <td className="py-2 pr-3 text-right mono" style={{ color: p.theta !== 0 ? pnlColor(p.theta) : '#484f58' }}>
                            {p.hasGreeks ? fmt$(p.theta) : '--'}
                          </td>
                          <td className="py-2 pr-3 text-right mono text-text-muted">
                            {p.hasGreeks ? p.vega.toFixed(1) : '--'}
                          </td>
                          <td className="py-2 pr-3 text-right mono text-text-muted">
                            {p.iv > 0 ? `${p.iv.toFixed(0)}%` : '--'}
                          </td>
                          <td className="py-2 pr-3 text-center">
                            <span className="text-[10px] text-text-faint">{p.sector}</span>
                          </td>
                          <td className="py-2 text-center">
                            <button onClick={() => {
                              if (isEditing) { setEditingRow(null); }
                              else {
                                const g = greeks[p.underlying] || {};
                                setEditForm({ delta: g.delta || '', gamma: g.gamma || '', theta: g.theta || '', vega: g.vega || '', iv: g.iv || '' });
                                setEditingRow(i);
                              }
                            }} className="text-text-faint hover:text-accent transition-colors">
                              <Edit3 size={12} />
                            </button>
                          </td>
                        </tr>
                        {isEditing && (
                          <tr className="bg-bg">
                            <td colSpan={11} className="px-3 py-2">
                              <div className="flex items-end gap-3 fade-in">
                                <GInp label="Delta (per contract)" value={editForm.delta} onChange={v => setEditForm(f => ({ ...f, delta: v }))} />
                                <GInp label="Gamma" value={editForm.gamma} onChange={v => setEditForm(f => ({ ...f, gamma: v }))} />
                                <GInp label="Theta ($)" value={editForm.theta} onChange={v => setEditForm(f => ({ ...f, theta: v }))} />
                                <GInp label="Vega ($)" value={editForm.vega} onChange={v => setEditForm(f => ({ ...f, vega: v }))} />
                                <GInp label="IV (%)" value={editForm.iv} onChange={v => setEditForm(f => ({ ...f, iv: v }))} />
                                <button onClick={() => saveGreeks(p.underlying)}
                                  className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-accent hover:bg-accent-hover text-white rounded-lg transition-colors">
                                  <Save size={12} /> Save
                                </button>
                              </div>
                              <div className="text-[10px] text-text-faint mt-1">
                                Enter per-contract Greeks from your broker. Values will be multiplied by quantity ({p.qty}) automatically.
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
                {/* Totals row */}
                <tfoot>
                  <tr className="border-t border-bg-border">
                    <td className="py-2 pr-3 font-medium text-text-muted" colSpan={4}>Portfolio total</td>
                    <td className="py-2 pr-3 text-right mono font-bold" style={{ color: pnlColor(totals.delta) }}>{totals.delta.toFixed(2)}</td>
                    <td className="py-2 pr-3 text-right mono font-bold text-text-muted">{totals.gamma.toFixed(3)}</td>
                    <td className="py-2 pr-3 text-right mono font-bold" style={{ color: pnlColor(totals.theta) }}>{fmt$(totals.theta)}</td>
                    <td className="py-2 pr-3 text-right mono font-bold text-text-muted">{totals.vega.toFixed(1)}</td>
                    <td colSpan={3}></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* Risk scenarios */}
          {totals.withGreeks > 0 && (
            <div className="card">
              <h3 className="text-sm font-medium text-text-muted mb-3">What-if Scenarios — Portfolio P&L Impact</h3>
              <div className="grid grid-cols-4 gap-3">
                <ScenarioCard title="Market +1%" impact={totals.delta * 0.01 * 100} sub={`Delta: ${totals.delta.toFixed(1)}`} />
                <ScenarioCard title="Market -1%" impact={-totals.delta * 0.01 * 100} sub={`Delta: ${totals.delta.toFixed(1)}`} />
                <ScenarioCard title="IV +5pts" impact={totals.vega * 5} sub={`Vega: ${totals.vega.toFixed(0)}`} />
                <ScenarioCard title="1 Day passes" impact={totals.theta} sub={`Theta: ${fmt$(totals.theta)}`} />
              </div>
              <div className="text-[10px] text-text-faint mt-2">
                Estimates based on first-order Greeks only. Actual P&L will differ due to gamma, higher-order effects, and changes in IV surface.
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ───
const ttStyle = { background: '#161b22', border: '1px solid #30363d', borderRadius: 8, fontSize: 12 };

function GreekKPI({ label, value, sub, cls }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value mono ${cls || ''}`}>{value}</div>
      {sub && <div className="text-[10px] text-text-faint mt-0.5">{sub}</div>}
    </div>
  );
}

function GInp({ label, value, onChange }) {
  return (
    <div className="flex-1">
      <label className="text-[9px] text-text-muted block mb-0.5">{label}</label>
      <input type="number" step="any" value={value} onChange={e => onChange(e.target.value)}
        className="w-full px-2 py-1 bg-bg-card border border-bg-border rounded text-xs text-text mono outline-none focus:border-accent" />
    </div>
  );
}

function ScenarioCard({ title, impact, sub }) {
  return (
    <div className="p-3 rounded-lg border border-bg-border">
      <div className="text-xs text-text-muted mb-1">{title}</div>
      <div className="mono text-lg font-bold" style={{ color: pnlColor(impact) }}>
        {impact >= 0 ? '+' : ''}{fmt$(impact)}
      </div>
      <div className="text-[10px] text-text-faint mt-0.5">{sub}</div>
    </div>
  );
}

