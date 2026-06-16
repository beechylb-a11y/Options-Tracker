import React, { useState, useEffect, useMemo } from 'react';
import { api } from '../utils/api';
import { fmt$, pnlColor, filterByAccount } from '../utils/format';

export default function Reports({ authenticated, account }) {
  const [trades, setTrades] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedFY, setSelectedFY] = useState('');

  useEffect(() => {
    if (!authenticated) return;
    api.tracker().then(d => { setTrades(d || []); setLoading(false); }).catch(() => setLoading(false));
  }, [authenticated]);

  // Parse date helper (handles AU and US formats)
  function parseDate(str) {
    if (!str) return null;
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
  }

  // Get close date or entry date for each trade
  function getTradeDate(t) {
    return parseDate(t['Close Date']) || parseDate(t['Entry Date']);
  }

  function getPnL(t) {
    return parseFloat(t['Total P&L ($)'] || t['Actual P&L'] || 0);
  }

  // Filter trades by account
  const filtered = useMemo(() => filterByAccount(trades, account), [trades, account]);

  // Closed trades with dates and P&L
  const closedTrades = useMemo(() => {
    return filtered.filter(t => {
      const pnl = getPnL(t);
      const date = getTradeDate(t);
      return date && !isNaN(pnl);
    }).map(t => ({
      ...t,
      _date: getTradeDate(t),
      _pnl: getPnL(t),
      _month: getTradeDate(t).getMonth(),
      _year: getTradeDate(t).getFullYear()
    })).sort((a, b) => a._date - b._date);
  }, [filtered]);

  // Australian financial year: July 1 - June 30
  // FY2025 = Jul 2024 - Jun 2025
  function getFY(date) {
    const m = date.getMonth(); // 0-11
    const y = date.getFullYear();
    return m >= 6 ? y + 1 : y; // Jul-Dec = next FY, Jan-Jun = current FY
  }

  function getFYLabel(fy) {
    return `FY${fy - 1}/${String(fy).slice(2)}`;
  }

  // Get all unique FYs
  const financialYears = useMemo(() => {
    const fys = [...new Set(closedTrades.map(t => getFY(t._date)))].sort((a, b) => b - a);
    return fys;
  }, [closedTrades]);

  // Set default FY
  useEffect(() => {
    if (financialYears.length > 0 && !selectedFY) setSelectedFY(String(financialYears[0]));
  }, [financialYears]);

  const activeFY = parseInt(selectedFY) || financialYears[0] || 2026;

  // Trades for selected FY
  const fyTrades = useMemo(() => {
    return closedTrades.filter(t => getFY(t._date) === activeFY);
  }, [closedTrades, activeFY]);

  // Monthly breakdown for selected FY
  const monthlyData = useMemo(() => {
    const months = [];
    // FY runs Jul(6) to Jun(5)
    for (let i = 0; i < 12; i++) {
      const m = (6 + i) % 12; // 6,7,8,...11,0,1,...5
      const y = i < 6 ? activeFY - 1 : activeFY;
      const monthTrades = fyTrades.filter(t => t._month === m && t._year === y);
      const pnl = monthTrades.reduce((s, t) => s + t._pnl, 0);
      const wins = monthTrades.filter(t => t._pnl > 0).length;
      const losses = monthTrades.filter(t => t._pnl < 0).length;
      const count = monthTrades.length;
      const label = new Date(y, m).toLocaleDateString('en-AU', { month: 'short', year: '2-digit' });
      months.push({ m, y, label, pnl, wins, losses, count, trades: monthTrades });
    }
    return months;
  }, [fyTrades, activeFY]);

  // FY totals
  const fyTotals = useMemo(() => {
    const totalPnL = fyTrades.reduce((s, t) => s + t._pnl, 0);
    const wins = fyTrades.filter(t => t._pnl > 0).length;
    const losses = fyTrades.filter(t => t._pnl < 0).length;
    const count = fyTrades.length;
    const ba = count > 0 ? (wins / count * 100).toFixed(1) : '0.0';
    const avgWin = wins > 0 ? fyTrades.filter(t => t._pnl > 0).reduce((s, t) => s + t._pnl, 0) / wins : 0;
    const avgLoss = losses > 0 ? fyTrades.filter(t => t._pnl < 0).reduce((s, t) => s + t._pnl, 0) / losses : 0;
    const grossProfit = fyTrades.filter(t => t._pnl > 0).reduce((s, t) => s + t._pnl, 0);
    const grossLoss = fyTrades.filter(t => t._pnl < 0).reduce((s, t) => s + t._pnl, 0);
    const profitFactor = grossLoss !== 0 ? Math.abs(grossProfit / grossLoss) : grossProfit > 0 ? Infinity : 0;
    const bestMonth = monthlyData.reduce((best, m) => m.pnl > best.pnl ? m : best, monthlyData[0]);
    const worstMonth = monthlyData.reduce((worst, m) => m.pnl < worst.pnl ? m : worst, monthlyData[0]);

    return { totalPnL, wins, losses, count, ba, avgWin, avgLoss, grossProfit, grossLoss, profitFactor, bestMonth, worstMonth };
  }, [fyTrades, monthlyData]);

  // Strategy breakdown for tax
  const strategyBreakdown = useMemo(() => {
    const map = {};
    fyTrades.forEach(t => {
      const strat = t['Strategy (OIC)'] || t['Strategy'] || 'Unknown';
      if (!map[strat]) map[strat] = { count: 0, pnl: 0, wins: 0, losses: 0 };
      map[strat].count++;
      map[strat].pnl += t._pnl;
      if (t._pnl > 0) map[strat].wins++; else map[strat].losses++;
    });
    return Object.entries(map).sort((a, b) => b[1].pnl - a[1].pnl);
  }, [fyTrades]);

  // Underlying breakdown
  const underlyingBreakdown = useMemo(() => {
    const map = {};
    fyTrades.forEach(t => {
      const und = t['Underlying'] || 'Unknown';
      if (!map[und]) map[und] = { count: 0, pnl: 0, wins: 0, losses: 0 };
      map[und].count++;
      map[und].pnl += t._pnl;
      if (t._pnl > 0) map[und].wins++; else map[und].losses++;
    });
    return Object.entries(map).sort((a, b) => b[1].pnl - a[1].pnl);
  }, [fyTrades]);

  // Cumulative P&L for equity curve
  const cumPnL = useMemo(() => {
    let cum = 0;
    return fyTrades.map(t => { cum += t._pnl; return { date: t._date, pnl: cum }; });
  }, [fyTrades]);

  // Max P&L bar width
  const maxMonthlyPnl = Math.max(1, ...monthlyData.map(m => Math.abs(m.pnl)));

  if (loading) return <div className="text-text-muted text-sm p-8">Loading reports...</div>;

  return (
    <div className="fade-in space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-display font-bold">Reports</h2>
          <p className="text-sm text-text-muted mt-1">P&L reports by month, financial year, and tax summary</p>
        </div>
        <div className="flex items-center gap-3">
          <select value={selectedFY} onChange={e => setSelectedFY(e.target.value)}
            className="px-3 py-2 bg-bg border border-bg-border rounded-lg text-sm text-white outline-none">
            {financialYears.map(fy => (
              <option key={fy} value={fy}>{getFYLabel(fy)}</option>
            ))}
          </select>
          <button onClick={() => {
            const csv = ['Date,Underlying,Strategy,Qty,Net Credit,P&L,W/L',
              ...fyTrades.map(t =>
                [t._date.toLocaleDateString('en-AU'), t['Underlying'], t['Strategy (OIC)']||t['Strategy'],
                 t['Qty'], t['Net Credit ($)'], t._pnl.toFixed(2), t['W / L']||''].join(',')
              )].join('\n');
            const blob = new Blob([csv], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = `options-pnl-${getFYLabel(activeFY)}.csv`; a.click();
          }} className="px-3 py-2 text-sm border border-bg-border rounded-lg text-text-muted hover:bg-bg-hover">
            Export CSV
          </button>
        </div>
      </div>

      {/* FY Summary Cards */}
      <div className="grid grid-cols-4 gap-4">
        <div className="card text-center">
          <div className="text-xs text-text-muted uppercase">Total P&L</div>
          <div className="text-2xl font-bold mono mt-1" style={{color:pnlColor(fyTotals.totalPnL)}}>{fmt$(fyTotals.totalPnL)}</div>
        </div>
        <div className="card text-center">
          <div className="text-xs text-text-muted uppercase">Trades</div>
          <div className="text-2xl font-bold mono mt-1 text-white">{fyTotals.count}</div>
          <div className="text-xs text-text-muted mt-0.5">{fyTotals.wins}W / {fyTotals.losses}L ({fyTotals.ba}%)</div>
        </div>
        <div className="card text-center">
          <div className="text-xs text-text-muted uppercase">Profit Factor</div>
          <div className="text-2xl font-bold mono mt-1" style={{color: fyTotals.profitFactor >= 1.5 ? '#3fb950' : fyTotals.profitFactor >= 1 ? '#d29922' : '#f85149'}}>
            {fyTotals.profitFactor === Infinity ? '∞' : fyTotals.profitFactor.toFixed(2)}
          </div>
        </div>
        <div className="card text-center">
          <div className="text-xs text-text-muted uppercase">Avg Win / Loss</div>
          <div className="text-sm font-bold mono mt-1">
            <span className="text-green">{fmt$(fyTotals.avgWin)}</span>
            <span className="text-text-muted mx-1">/</span>
            <span className="text-red">{fmt$(fyTotals.avgLoss)}</span>
          </div>
        </div>
      </div>

      {/* Monthly P&L Table */}
      <div className="card">
        <h3 className="text-sm font-semibold text-white mb-3">Monthly P&L — {getFYLabel(activeFY)}</h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] text-text-muted uppercase tracking-wider">
              <th className="text-left py-2 w-20">Month</th>
              <th className="text-right py-2 w-24">P&L</th>
              <th className="text-center py-2 w-16">Trades</th>
              <th className="text-center py-2 w-16">W/L</th>
              <th className="text-center py-2 w-16">BA%</th>
              <th className="text-left py-2">P&L Bar</th>
            </tr>
          </thead>
          <tbody>
            {monthlyData.map((m, i) => (
              <tr key={i} className="border-t border-[#21262d]">
                <td className="py-2 text-white font-medium">{m.label}</td>
                <td className="py-2 text-right mono font-bold" style={{color:pnlColor(m.pnl)}}>{m.pnl !== 0 ? fmt$(m.pnl) : '—'}</td>
                <td className="py-2 text-center text-text-muted">{m.count || '—'}</td>
                <td className="py-2 text-center text-text-muted">{m.count > 0 ? `${m.wins}/${m.losses}` : '—'}</td>
                <td className="py-2 text-center text-text-muted">{m.count > 0 ? (m.wins / m.count * 100).toFixed(0) + '%' : '—'}</td>
                <td className="py-2">
                  {m.pnl !== 0 && (
                    <div className="flex items-center gap-1" style={{paddingLeft: m.pnl >= 0 ? '50%' : `${50 - (Math.abs(m.pnl) / maxMonthlyPnl) * 50}%`}}>
                      <div style={{
                        width: `${(Math.abs(m.pnl) / maxMonthlyPnl) * 50}%`,
                        height: 14,
                        borderRadius: 3,
                        background: m.pnl > 0 ? '#238636' : '#da3633',
                        minWidth: 4
                      }} />
                    </div>
                  )}
                </td>
              </tr>
            ))}
            <tr className="border-t-2 border-[#30363d]">
              <td className="py-2 text-white font-bold">Total</td>
              <td className="py-2 text-right mono font-bold" style={{color:pnlColor(fyTotals.totalPnL)}}>{fmt$(fyTotals.totalPnL)}</td>
              <td className="py-2 text-center text-white font-bold">{fyTotals.count}</td>
              <td className="py-2 text-center text-white font-bold">{fyTotals.wins}/{fyTotals.losses}</td>
              <td className="py-2 text-center text-white font-bold">{fyTotals.ba}%</td>
              <td></td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Strategy Breakdown */}
      <div className="grid grid-cols-2 gap-4">
        <div className="card">
          <h3 className="text-sm font-semibold text-white mb-3">By Strategy</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] text-text-muted uppercase tracking-wider">
                <th className="text-left py-2">Strategy</th>
                <th className="text-right py-2">P&L</th>
                <th className="text-center py-2">Trades</th>
                <th className="text-center py-2">BA%</th>
              </tr>
            </thead>
            <tbody>
              {strategyBreakdown.map(([strat, data], i) => (
                <tr key={i} className="border-t border-[#21262d]">
                  <td className="py-1.5 text-white text-xs">{strat}</td>
                  <td className="py-1.5 text-right mono font-bold text-xs" style={{color:pnlColor(data.pnl)}}>{fmt$(data.pnl)}</td>
                  <td className="py-1.5 text-center text-text-muted text-xs">{data.count}</td>
                  <td className="py-1.5 text-center text-text-muted text-xs">{(data.wins / data.count * 100).toFixed(0)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card">
          <h3 className="text-sm font-semibold text-white mb-3">By Underlying</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] text-text-muted uppercase tracking-wider">
                <th className="text-left py-2">Underlying</th>
                <th className="text-right py-2">P&L</th>
                <th className="text-center py-2">Trades</th>
                <th className="text-center py-2">BA%</th>
              </tr>
            </thead>
            <tbody>
              {underlyingBreakdown.map(([und, data], i) => (
                <tr key={i} className="border-t border-[#21262d]">
                  <td className="py-1.5 text-white text-xs font-bold">{und}</td>
                  <td className="py-1.5 text-right mono font-bold text-xs" style={{color:pnlColor(data.pnl)}}>{fmt$(data.pnl)}</td>
                  <td className="py-1.5 text-center text-text-muted text-xs">{data.count}</td>
                  <td className="py-1.5 text-center text-text-muted text-xs">{(data.wins / data.count * 100).toFixed(0)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Tax Summary */}
      <div className="card">
        <h3 className="text-sm font-semibold text-white mb-3">Tax Summary — {getFYLabel(activeFY)} (Australian FY: Jul {activeFY - 1} – Jun {activeFY})</h3>
        <div className="grid grid-cols-2 gap-6">
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-text-muted">Gross gains (profitable trades)</span>
              <span className="mono font-bold text-green">{fmt$(fyTotals.grossProfit)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-text-muted">Gross losses (losing trades)</span>
              <span className="mono font-bold text-red">{fmt$(fyTotals.grossLoss)}</span>
            </div>
            <div className="flex justify-between text-sm pt-2 border-t border-[#30363d]">
              <span className="text-white font-semibold">Net trading P&L</span>
              <span className="mono font-bold" style={{color:pnlColor(fyTotals.totalPnL)}}>{fmt$(fyTotals.totalPnL)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-text-muted">Total trades closed</span>
              <span className="mono text-white">{fyTotals.count}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-text-muted">Win rate</span>
              <span className="mono text-white">{fyTotals.ba}%</span>
            </div>
          </div>
          <div className="space-y-2">
            <div className="text-xs text-text-muted mb-2">Note: Options trading income is generally assessable as ordinary income for Australian residents. Capital gains tax treatment may apply in some cases. Consult your tax advisor.</div>
            <div className="flex justify-between text-sm">
              <span className="text-text-muted">Best month</span>
              <span className="mono text-green">{fyTotals.bestMonth?.label} ({fmt$(fyTotals.bestMonth?.pnl || 0)})</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-text-muted">Worst month</span>
              <span className="mono text-red">{fyTotals.worstMonth?.label} ({fmt$(fyTotals.worstMonth?.pnl || 0)})</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-text-muted">Profitable months</span>
              <span className="mono text-white">{monthlyData.filter(m => m.pnl > 0).length} / {monthlyData.filter(m => m.count > 0).length}</span>
            </div>
          </div>
        </div>
      </div>

      {closedTrades.length === 0 && (
        <div className="py-12 text-center text-text-muted text-sm">No closed trades found. Import trades on the Trades tab to generate reports.</div>
      )}
    </div>
  );
}
