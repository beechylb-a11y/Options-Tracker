import React, { useState, useEffect, useMemo } from 'react';
import { api } from '../utils/api';
import { fmt$, pnlColor, filterByAccount } from '../utils/format';

export default function Reports({ authenticated, account }) {
  const [trades, setTrades] = useState([]);
  const [rawTrades, setRawTrades] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedFY, setSelectedFY] = useState('');

  useEffect(() => {
    if (!authenticated) return;
    Promise.all([
      api.getTracker().catch(() => []),
      api.getTrades().catch(() => [])
    ]).then(([tracker, raw]) => {
      setTrades(tracker || []);
      setRawTrades(raw || []);
      setLoading(false);
    });
  }, [authenticated]);

  function parseDate(str) {
    if (!str) return null;
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
  }

  function getTradeDate(t) {
    return parseDate(t['Close Date']) || parseDate(t['Entry Date']);
  }

  function getPnL(t) {
    return parseFloat(t['Total P&L ($)'] || t['Actual P&L'] || 0);
  }

  const filtered = useMemo(() => filterByAccount(trades, account), [trades, account]);

  const closedTrades = useMemo(() => {
    return filtered.filter(t => {
      const date = getTradeDate(t);
      return date;
    }).map(t => ({
      ...t,
      _date: getTradeDate(t),
      _pnl: getPnL(t),
      _month: getTradeDate(t).getMonth(),
      _year: getTradeDate(t).getFullYear(),
      _credit: parseFloat(t['Net Credit ($)'] || 0),
      _qty: parseInt(t['Qty'] || 1)
    })).sort((a, b) => a._date - b._date);
  }, [filtered]);

  // Australian financial year: Jul 1 - Jun 30
  function getFY(date) {
    return date.getMonth() >= 6 ? date.getFullYear() + 1 : date.getFullYear();
  }
  function getFYLabel(fy) { return `FY${fy - 1}/${String(fy).slice(2)}`; }
  function getFYRange(fy) { return `1 July ${fy - 1} – 30 June ${fy}`; }

  const financialYears = useMemo(() => {
    return [...new Set(closedTrades.map(t => getFY(t._date)))].sort((a, b) => b - a);
  }, [closedTrades]);

  useEffect(() => {
    if (financialYears.length > 0 && !selectedFY) setSelectedFY(String(financialYears[0]));
  }, [financialYears]);

  const activeFY = parseInt(selectedFY) || financialYears[0] || 2026;

  const fyTrades = useMemo(() => closedTrades.filter(t => getFY(t._date) === activeFY), [closedTrades, activeFY]);

  // Total fees from raw trades for the FY
  const totalFees = useMemo(() => {
    return rawTrades.reduce((sum, t) => {
      const d = parseDate(t['Date'] || t['Entry Date']);
      if (d && getFY(d) === activeFY) return sum + Math.abs(parseFloat(t['Fees'] || 0));
      return sum;
    }, 0);
  }, [rawTrades, activeFY]);

  // Monthly breakdown
  const monthlyData = useMemo(() => {
    const months = [];
    for (let i = 0; i < 12; i++) {
      const m = (6 + i) % 12;
      const y = i < 6 ? activeFY - 1 : activeFY;
      const mt = fyTrades.filter(t => t._month === m && t._year === y);
      months.push({
        m, y,
        label: new Date(y, m).toLocaleDateString('en-AU', { month: 'short', year: '2-digit' }),
        fullLabel: new Date(y, m).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' }),
        pnl: mt.reduce((s, t) => s + t._pnl, 0),
        wins: mt.filter(t => t._pnl > 0).length,
        losses: mt.filter(t => t._pnl < 0).length,
        count: mt.length
      });
    }
    return months;
  }, [fyTrades, activeFY]);

  // FY totals
  const fy = useMemo(() => {
    const grossProfit = fyTrades.filter(t => t._pnl > 0).reduce((s, t) => s + t._pnl, 0);
    const grossLoss = fyTrades.filter(t => t._pnl < 0).reduce((s, t) => s + t._pnl, 0);
    const totalPnL = grossProfit + grossLoss;
    const wins = fyTrades.filter(t => t._pnl > 0).length;
    const losses = fyTrades.filter(t => t._pnl < 0).length;
    const count = fyTrades.length;
    const ba = count > 0 ? (wins / count * 100).toFixed(1) : '0.0';
    const avgWin = wins > 0 ? grossProfit / wins : 0;
    const avgLoss = losses > 0 ? grossLoss / losses : 0;
    const pf = grossLoss !== 0 ? Math.abs(grossProfit / grossLoss) : grossProfit > 0 ? Infinity : 0;
    const bestMonth = monthlyData.reduce((b, m) => m.pnl > b.pnl ? m : b, monthlyData[0]);
    const worstMonth = monthlyData.reduce((w, m) => m.pnl < w.pnl ? m : w, monthlyData[0]);
    const premReceived = fyTrades.filter(t => t._credit > 0).reduce((s, t) => s + t._credit, 0);
    const premPaid = fyTrades.filter(t => t._credit < 0).reduce((s, t) => s + Math.abs(t._credit), 0);
    // Holding period
    const holdDays = fyTrades.map(t => {
      const entry = parseDate(t['Entry Date']);
      const close = t._date;
      return entry && close ? Math.round((close - entry) / 86400000) : 0;
    }).filter(d => d > 0);
    const avgHold = holdDays.length > 0 ? (holdDays.reduce((s, d) => s + d, 0) / holdDays.length).toFixed(1) : '—';
    const largestWin = wins > 0 ? Math.max(...fyTrades.filter(t => t._pnl > 0).map(t => t._pnl)) : 0;
    const largestLoss = losses > 0 ? Math.min(...fyTrades.filter(t => t._pnl < 0).map(t => t._pnl)) : 0;
    const avgSize = count > 0 ? (fyTrades.reduce((s, t) => s + t._qty, 0) / count).toFixed(1) : '—';
    return { grossProfit, grossLoss, totalPnL, wins, losses, count, ba, avgWin, avgLoss, pf,
      bestMonth, worstMonth, premReceived, premPaid, avgHold, largestWin, largestLoss, avgSize };
  }, [fyTrades, monthlyData]);

  // Strategy breakdown
  const byStrategy = useMemo(() => {
    const map = {};
    fyTrades.forEach(t => {
      const s = t['Strategy (OIC)'] || t['Strategy'] || 'Unknown';
      if (!map[s]) map[s] = { count: 0, pnl: 0, wins: 0, losses: 0 };
      map[s].count++; map[s].pnl += t._pnl;
      if (t._pnl > 0) map[s].wins++; else map[s].losses++;
    });
    return Object.entries(map).sort((a, b) => b[1].pnl - a[1].pnl);
  }, [fyTrades]);

  // Underlying breakdown
  const byUnderlying = useMemo(() => {
    const map = {};
    fyTrades.forEach(t => {
      const u = t['Underlying'] || 'Unknown';
      if (!map[u]) map[u] = { count: 0, pnl: 0, wins: 0, losses: 0 };
      map[u].count++; map[u].pnl += t._pnl;
      if (t._pnl > 0) map[u].wins++; else map[u].losses++;
    });
    return Object.entries(map).sort((a, b) => b[1].pnl - a[1].pnl);
  }, [fyTrades]);

  const maxBar = Math.max(1, ...monthlyData.map(m => Math.abs(m.pnl)));

  // ── PRINT REPORT ──
  function handlePrint() {
    const w = window.open('', '_blank', 'width=900,height=700');
    const monthRows = monthlyData.map(m =>
      `<tr><td>${m.fullLabel}</td><td class="r ${m.pnl>=0?'green':'red'}">${fmt$(m.pnl)}</td><td class="c">${m.count}</td><td class="c">${m.count>0?m.wins+'/'+m.losses:'—'}</td><td class="c">${m.count>0?(m.wins/m.count*100).toFixed(0)+'%':'—'}</td></tr>`
    ).join('');
    const stratRows = byStrategy.map(([s, d]) =>
      `<tr><td>${s}</td><td class="c">${d.count}</td><td class="r ${d.pnl>=0?'green':'red'}">${fmt$(d.pnl)}</td></tr>`
    ).join('');
    const undRows = byUnderlying.map(([u, d]) =>
      `<tr><td>${u}</td><td class="c">${d.count}</td><td class="r ${d.pnl>=0?'green':'red'}">${fmt$(d.pnl)}</td></tr>`
    ).join('');
    const tradeRows = fyTrades.map((t, i) =>
      `<tr><td>${i+1}</td><td>${t['Entry Date']||''}</td><td>${t['Close Date']||''}</td><td>${t['Underlying']||''}</td><td>${t['Strategy (OIC)']||t['Strategy']||''}</td><td class="c">${t['Qty']||1}</td><td class="r">${t['Net Credit ($)']||''}</td><td class="r ${t._pnl>=0?'green':'red'}">${fmt$(t._pnl)}</td></tr>`
    ).join('');

    w.document.write(`<!DOCTYPE html><html><head><title>Options Trading Report — ${getFYLabel(activeFY)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:32px;color:#1a1a1a;font-size:12px;line-height:1.5}
h1{font-size:20px;margin-bottom:4px}
h2{font-size:14px;margin:24px 0 8px;padding-bottom:4px;border-bottom:2px solid #1a1a1a}
h3{font-size:12px;margin:16px 0 6px;color:#555}
.subtitle{font-size:12px;color:#666;margin-bottom:20px}
table{width:100%;border-collapse:collapse;margin-bottom:16px;font-size:11px}
th{text-align:left;padding:6px 8px;background:#f5f5f5;border-bottom:2px solid #ddd;font-size:10px;text-transform:uppercase;color:#555}
td{padding:5px 8px;border-bottom:1px solid #eee}
.r{text-align:right;font-family:'SF Mono',Consolas,monospace}
.c{text-align:center}
.green{color:#1a7f37}
.red{color:#cf222e}
.bold{font-weight:700}
.summary-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:16px}
.summary-box{border:1px solid #ddd;border-radius:6px;padding:12px}
.summary-row{display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid #f0f0f0}
.summary-row:last-child{border-bottom:none}
.summary-row.total{border-top:2px solid #1a1a1a;font-weight:700;padding-top:6px;margin-top:4px}
.note{font-size:10px;color:#888;font-style:italic;margin:8px 0}
.page-break{page-break-before:always}
@media print{body{padding:16px} .no-print{display:none}}
</style></head><body>
<div class="no-print" style="margin-bottom:16px"><button onclick="window.print()" style="padding:8px 20px;font-size:13px;cursor:pointer">Print / Save PDF</button></div>

<h1>Options Trading Report</h1>
<div class="subtitle">${getFYLabel(activeFY)} — ${getFYRange(activeFY)} | Generated ${new Date().toLocaleDateString('en-AU')}</div>

<h2>1. Executive Summary</h2>
<div class="summary-grid">
<div class="summary-box">
<div class="summary-row"><span>Gross Premium Received</span><span class="r">${fmt$(fy.premReceived)}</span></div>
<div class="summary-row"><span>Gross Premium Paid</span><span class="r">${fmt$(fy.premPaid)}</span></div>
<div class="summary-row"><span>Realised Trading Profit (Gross)</span><span class="r ${fy.grossProfit>=0?'green':''}">${fmt$(fy.grossProfit)}</span></div>
<div class="summary-row"><span>Realised Trading Loss (Gross)</span><span class="r red">${fmt$(fy.grossLoss)}</span></div>
<div class="summary-row"><span>Fees &amp; Commissions</span><span class="r">${fmt$(totalFees)}</span></div>
<div class="summary-row total"><span>Net Trading Profit/(Loss)</span><span class="r bold ${fy.totalPnL>=0?'green':'red'}">${fmt$(fy.totalPnL)}</span></div>
</div>
<div class="summary-box">
<div class="summary-row"><span>Total Trades Closed</span><span class="r">${fy.count}</span></div>
<div class="summary-row"><span>Winning Trades</span><span class="r">${fy.wins}</span></div>
<div class="summary-row"><span>Losing Trades</span><span class="r">${fy.losses}</span></div>
<div class="summary-row"><span>Win Rate</span><span class="r">${fy.ba}%</span></div>
<div class="summary-row"><span>Profit Factor</span><span class="r">${fy.pf === Infinity ? '∞' : fy.pf.toFixed(2)}</span></div>
<div class="summary-row"><span>Currency</span><span class="r">USD</span></div>
</div>
</div>

<h2>2. Trade Summary by Strategy</h2>
<table><thead><tr><th>Strategy</th><th class="c">Trades</th><th class="r">P&amp;L</th></tr></thead>
<tbody>${stratRows}
<tr class="bold" style="border-top:2px solid #1a1a1a"><td>Total</td><td class="c">${fy.count}</td><td class="r ${fy.totalPnL>=0?'green':'red'}">${fmt$(fy.totalPnL)}</td></tr>
</tbody></table>

<h2>3. Trade Summary by Underlying</h2>
<table><thead><tr><th>Underlying</th><th class="c">Trades</th><th class="r">P&amp;L</th></tr></thead>
<tbody>${undRows}
<tr class="bold" style="border-top:2px solid #1a1a1a"><td>Total</td><td class="c">${fy.count}</td><td class="r ${fy.totalPnL>=0?'green':'red'}">${fmt$(fy.totalPnL)}</td></tr>
</tbody></table>

<h2>4. Monthly P&amp;L</h2>
<table><thead><tr><th>Month</th><th class="r">P&amp;L</th><th class="c">Trades</th><th class="c">W/L</th><th class="c">BA%</th></tr></thead>
<tbody>${monthRows}
<tr class="bold" style="border-top:2px solid #1a1a1a"><td>Total</td><td class="r ${fy.totalPnL>=0?'green':'red'}">${fmt$(fy.totalPnL)}</td><td class="c">${fy.count}</td><td class="c">${fy.wins}/${fy.losses}</td><td class="c">${fy.ba}%</td></tr>
</tbody></table>

<div class="page-break"></div>

<h2>5. Closed Trades Register</h2>
<table><thead><tr><th>#</th><th>Open Date</th><th>Close Date</th><th>Underlying</th><th>Strategy</th><th class="c">Qty</th><th class="r">Net Cr/Db</th><th class="r">Realised P&amp;L</th></tr></thead>
<tbody>${tradeRows}
<tr class="bold" style="border-top:2px solid #1a1a1a"><td colspan="7">Total</td><td class="r ${fy.totalPnL>=0?'green':'red'}">${fmt$(fy.totalPnL)}</td></tr>
</tbody></table>

<h2>6. Fees &amp; Charges</h2>
<table style="max-width:400px">
<tbody>
<tr><td>Brokerage &amp; Commissions</td><td class="r">${fmt$(totalFees)}</td></tr>
<tr><td>Exchange &amp; Regulatory Fees</td><td class="r">Included above</td></tr>
<tr class="bold" style="border-top:2px solid #1a1a1a"><td>Total Fees</td><td class="r">${fmt$(totalFees)}</td></tr>
</tbody></table>

<h2>7. Trading Activity Statistics</h2>
<table style="max-width:400px">
<tbody>
<tr><td>Total Trades</td><td class="r">${fy.count}</td></tr>
<tr><td>Winning Trades</td><td class="r">${fy.wins}</td></tr>
<tr><td>Losing Trades</td><td class="r">${fy.losses}</td></tr>
<tr><td>Win Rate</td><td class="r">${fy.ba}%</td></tr>
<tr><td>Average Holding Period</td><td class="r">${fy.avgHold} days</td></tr>
<tr><td>Average Position Size</td><td class="r">${fy.avgSize} contracts</td></tr>
<tr><td>Largest Single Win</td><td class="r green">${fmt$(fy.largestWin)}</td></tr>
<tr><td>Largest Single Loss</td><td class="r red">${fmt$(fy.largestLoss)}</td></tr>
<tr><td>Average Win</td><td class="r green">${fmt$(fy.avgWin)}</td></tr>
<tr><td>Average Loss</td><td class="r red">${fmt$(fy.avgLoss)}</td></tr>
<tr><td>Profit Factor</td><td class="r">${fy.pf === Infinity ? '∞' : fy.pf.toFixed(2)}</td></tr>
<tr><td>Best Month</td><td class="r green">${fy.bestMonth?.fullLabel} (${fmt$(fy.bestMonth?.pnl||0)})</td></tr>
<tr><td>Worst Month</td><td class="r red">${fy.worstMonth?.fullLabel} (${fmt$(fy.worstMonth?.pnl||0)})</td></tr>
</tbody></table>

<h2>8. Foreign Currency</h2>
<table style="max-width:500px">
<thead><tr><th>Item</th><th class="r">USD</th><th class="r">AUD (convert)</th></tr></thead>
<tbody>
<tr><td>Net Trading Profit/(Loss)</td><td class="r ${fy.totalPnL>=0?'green':'red'}">${fmt$(fy.totalPnL)}</td><td class="r" style="color:#888">Apply ATO rate</td></tr>
<tr><td>Fees &amp; Commissions</td><td class="r">${fmt$(totalFees)}</td><td class="r" style="color:#888">Apply ATO rate</td></tr>
</tbody></table>
<div class="note">All amounts in USD. Convert using ATO average exchange rate for ${getFYLabel(activeFY)} or transaction-date rates as agreed with your tax advisor.</div>

<h2>9. Tax Summary</h2>
<div class="summary-box" style="max-width:500px">
<div class="summary-row"><span>Gross Profits (winning trades)</span><span class="r green">${fmt$(fy.grossProfit)}</span></div>
<div class="summary-row"><span>Gross Losses (losing trades)</span><span class="r red">${fmt$(fy.grossLoss)}</span></div>
<div class="summary-row"><span>Total Fees</span><span class="r">${fmt$(totalFees)}</span></div>
<div class="summary-row total"><span>Net Taxable Result</span><span class="r bold ${fy.totalPnL - totalFees>=0?'green':'red'}">${fmt$(fy.totalPnL - totalFees)}</span></div>
</div>
<div class="note">Options trading income is generally assessable as ordinary income for Australian residents conducting regular trading activity. Capital gains tax treatment may apply depending on individual circumstances. Consult your tax advisor for specific treatment.</div>

<div style="margin-top:32px;padding-top:16px;border-top:1px solid #ddd;font-size:10px;color:#999">
Generated by Options Tracker | ${new Date().toLocaleDateString('en-AU', {day:'numeric',month:'long',year:'numeric'})} | This report is provided for informational purposes and does not constitute tax advice.
</div>
</body></html>`);
    w.document.close();
  }

  if (loading) return <div className="text-text-muted text-sm p-8">Loading reports...</div>;

  return (
    <div className="fade-in space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-display font-bold">Reports</h2>
          <p className="text-sm text-text-muted mt-1">P&L by month, financial year, and tax reporting</p>
        </div>
        <div className="flex items-center gap-3">
          <select value={selectedFY} onChange={e => setSelectedFY(e.target.value)}
            className="px-3 py-2 bg-bg border border-bg-border rounded-lg text-sm text-white outline-none">
            {financialYears.map(fy => (
              <option key={fy} value={fy}>{getFYLabel(fy)}</option>
            ))}
          </select>
          <button onClick={handlePrint}
            className="px-4 py-2 text-sm bg-accent hover:bg-accent-hover text-white font-medium rounded-lg transition-colors">
            Print Tax Report
          </button>
          <button onClick={() => {
            const csv = ['Trade #,Open Date,Close Date,Underlying,Strategy,Qty,Net Credit/Debit,Realised P&L',
              ...fyTrades.map((t, i) =>
                [i+1, t['Entry Date']||'', t['Close Date']||'', t['Underlying']||'', t['Strategy (OIC)']||t['Strategy']||'',
                 t['Qty']||1, t['Net Credit ($)']||'', t._pnl.toFixed(2)].join(',')
              )].join('\n');
            const blob = new Blob([csv], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url; a.download = `options-pnl-${getFYLabel(activeFY)}.csv`; a.click();
          }} className="px-3 py-2 text-sm border border-bg-border rounded-lg text-text-muted hover:bg-bg-hover">
            Export CSV
          </button>
        </div>
      </div>

      {/* 1. Executive Summary */}
      <div className="grid grid-cols-4 gap-4">
        <div className="card text-center">
          <div className="text-[10px] text-text-muted uppercase">Net P&L</div>
          <div className="text-2xl font-bold mono mt-1" style={{color:pnlColor(fy.totalPnL)}}>{fmt$(fy.totalPnL)}</div>
          <div className="text-[10px] text-text-muted">{getFYLabel(activeFY)}</div>
        </div>
        <div className="card text-center">
          <div className="text-[10px] text-text-muted uppercase">Trades</div>
          <div className="text-2xl font-bold mono mt-1 text-white">{fy.count}</div>
          <div className="text-[10px] text-text-muted">{fy.wins}W / {fy.losses}L ({fy.ba}%)</div>
        </div>
        <div className="card text-center">
          <div className="text-[10px] text-text-muted uppercase">Profit Factor</div>
          <div className="text-2xl font-bold mono mt-1" style={{color: fy.pf >= 1.5 ? '#3fb950' : fy.pf >= 1 ? '#d29922' : '#f85149'}}>
            {fy.pf === Infinity ? '∞' : fy.pf.toFixed(2)}
          </div>
        </div>
        <div className="card text-center">
          <div className="text-[10px] text-text-muted uppercase">Avg Win / Loss</div>
          <div className="text-sm font-bold mono mt-2">
            <span className="text-green">{fmt$(fy.avgWin)}</span>
            <span className="text-text-muted mx-1">/</span>
            <span className="text-red">{fmt$(fy.avgLoss)}</span>
          </div>
        </div>
      </div>

      {/* Executive detail */}
      <div className="card">
        <div className="grid grid-cols-2 gap-8">
          <div className="space-y-1.5">
            <div className="flex justify-between text-sm"><span className="text-text-muted">Gross premium received</span><span className="mono text-white">{fmt$(fy.premReceived)}</span></div>
            <div className="flex justify-between text-sm"><span className="text-text-muted">Gross premium paid</span><span className="mono text-white">{fmt$(fy.premPaid)}</span></div>
            <div className="flex justify-between text-sm"><span className="text-text-muted">Realised gains</span><span className="mono text-green">{fmt$(fy.grossProfit)}</span></div>
            <div className="flex justify-between text-sm"><span className="text-text-muted">Realised losses</span><span className="mono text-red">{fmt$(fy.grossLoss)}</span></div>
            <div className="flex justify-between text-sm"><span className="text-text-muted">Fees & commissions</span><span className="mono text-white">{fmt$(totalFees)}</span></div>
            <div className="flex justify-between text-sm pt-2 border-t border-[#30363d] font-bold"><span className="text-white">Net trading result</span><span className="mono" style={{color:pnlColor(fy.totalPnL)}}>{fmt$(fy.totalPnL)}</span></div>
          </div>
          <div className="space-y-1.5">
            <div className="flex justify-between text-sm"><span className="text-text-muted">Avg holding period</span><span className="mono text-white">{fy.avgHold} days</span></div>
            <div className="flex justify-between text-sm"><span className="text-text-muted">Avg position size</span><span className="mono text-white">{fy.avgSize} contracts</span></div>
            <div className="flex justify-between text-sm"><span className="text-text-muted">Largest win</span><span className="mono text-green">{fmt$(fy.largestWin)}</span></div>
            <div className="flex justify-between text-sm"><span className="text-text-muted">Largest loss</span><span className="mono text-red">{fmt$(fy.largestLoss)}</span></div>
            <div className="flex justify-between text-sm"><span className="text-text-muted">Best month</span><span className="mono text-green">{fy.bestMonth?.label} ({fmt$(fy.bestMonth?.pnl||0)})</span></div>
            <div className="flex justify-between text-sm"><span className="text-text-muted">Worst month</span><span className="mono text-red">{fy.worstMonth?.label} ({fmt$(fy.worstMonth?.pnl||0)})</span></div>
          </div>
        </div>
      </div>

      {/* 4. Monthly P&L */}
      <div className="card">
        <h3 className="text-sm font-semibold text-white mb-3">Monthly P&L — {getFYLabel(activeFY)}</h3>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] text-text-muted uppercase tracking-wider">
              <th className="text-left py-2 w-24">Month</th>
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
                    <div className="flex items-center gap-1" style={{paddingLeft: m.pnl >= 0 ? '50%' : `${50 - (Math.abs(m.pnl) / maxBar) * 50}%`}}>
                      <div style={{ width: `${(Math.abs(m.pnl) / maxBar) * 50}%`, height: 14, borderRadius: 3, background: m.pnl > 0 ? '#238636' : '#da3633', minWidth: 4 }} />
                    </div>
                  )}
                </td>
              </tr>
            ))}
            <tr className="border-t-2 border-[#30363d]">
              <td className="py-2 text-white font-bold">Total</td>
              <td className="py-2 text-right mono font-bold" style={{color:pnlColor(fy.totalPnL)}}>{fmt$(fy.totalPnL)}</td>
              <td className="py-2 text-center text-white font-bold">{fy.count}</td>
              <td className="py-2 text-center text-white font-bold">{fy.wins}/{fy.losses}</td>
              <td className="py-2 text-center text-white font-bold">{fy.ba}%</td>
              <td></td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* 2 & 3. Strategy + Underlying breakdown */}
      <div className="grid grid-cols-2 gap-4">
        <div className="card">
          <h3 className="text-sm font-semibold text-white mb-3">By Strategy</h3>
          <table className="w-full text-sm">
            <thead><tr className="text-[10px] text-text-muted uppercase tracking-wider"><th className="text-left py-2">Strategy</th><th className="text-right py-2">P&L</th><th className="text-center py-2">Trades</th><th className="text-center py-2">BA%</th></tr></thead>
            <tbody>
              {byStrategy.map(([s, d], i) => (
                <tr key={i} className="border-t border-[#21262d]">
                  <td className="py-1.5 text-white text-xs">{s}</td>
                  <td className="py-1.5 text-right mono font-bold text-xs" style={{color:pnlColor(d.pnl)}}>{fmt$(d.pnl)}</td>
                  <td className="py-1.5 text-center text-text-muted text-xs">{d.count}</td>
                  <td className="py-1.5 text-center text-text-muted text-xs">{(d.wins / d.count * 100).toFixed(0)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card">
          <h3 className="text-sm font-semibold text-white mb-3">By Underlying</h3>
          <table className="w-full text-sm">
            <thead><tr className="text-[10px] text-text-muted uppercase tracking-wider"><th className="text-left py-2">Underlying</th><th className="text-right py-2">P&L</th><th className="text-center py-2">Trades</th><th className="text-center py-2">BA%</th></tr></thead>
            <tbody>
              {byUnderlying.map(([u, d], i) => (
                <tr key={i} className="border-t border-[#21262d]">
                  <td className="py-1.5 text-white text-xs font-bold">{u}</td>
                  <td className="py-1.5 text-right mono font-bold text-xs" style={{color:pnlColor(d.pnl)}}>{fmt$(d.pnl)}</td>
                  <td className="py-1.5 text-center text-text-muted text-xs">{d.count}</td>
                  <td className="py-1.5 text-center text-text-muted text-xs">{(d.wins / d.count * 100).toFixed(0)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* 9. Tax Summary */}
      <div className="card">
        <h3 className="text-sm font-semibold text-white mb-3">Tax Summary — {getFYLabel(activeFY)}</h3>
        <p className="text-xs text-text-muted mb-3">{getFYRange(activeFY)} | All amounts USD — convert using ATO average rate or transaction-date rates</p>
        <div className="grid grid-cols-2 gap-8">
          <div className="space-y-1.5">
            <div className="flex justify-between text-sm"><span className="text-text-muted">Gross gains (profitable trades)</span><span className="mono font-bold text-green">{fmt$(fy.grossProfit)}</span></div>
            <div className="flex justify-between text-sm"><span className="text-text-muted">Gross losses (losing trades)</span><span className="mono font-bold text-red">{fmt$(fy.grossLoss)}</span></div>
            <div className="flex justify-between text-sm"><span className="text-text-muted">Total fees & commissions</span><span className="mono text-white">{fmt$(totalFees)}</span></div>
            <div className="flex justify-between text-sm pt-2 border-t border-[#30363d]"><span className="text-white font-bold">Net taxable result</span><span className="mono font-bold" style={{color:pnlColor(fy.totalPnL - totalFees)}}>{fmt$(fy.totalPnL - totalFees)}</span></div>
          </div>
          <div>
            <p className="text-xs text-text-muted">Options trading income is generally assessable as ordinary income for Australian residents conducting regular trading activity. Capital gains tax treatment may apply depending on individual circumstances. Consult your tax advisor for specific treatment.</p>
          </div>
        </div>
      </div>

      {closedTrades.length === 0 && (
        <div className="py-12 text-center text-text-muted text-sm">No closed trades found. Import trades on the Trades tab to generate reports.</div>
      )}
    </div>
  );
}
