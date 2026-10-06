import React, { useState } from 'react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, ReferenceLine } from 'recharts';
import { Settings2, Save, X } from 'lucide-react';
import { api } from '../utils/api';
import { fmt$, pnlColor } from '../utils/format';
import { benchmarkOf, pieSlices, DEFAULT_TARGET_PCT } from '../utils/benchmark';

const SLICE = { invested: '#2f81f7', returned: '#3fb950', remaining: '#30363d', lost: '#f85149' };
const ttStyle = { background: '#161b22', border: '1px solid #30363d', borderRadius: 8, fontSize: 12 };
const pct = v => (v == null || !isFinite(v) ? '--' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`);

// Journal returns card. `s` comes from journalSummary() for the month on screen:
//   1. This month — trades closed in the month only, return on the month-start bank,
//      against the monthly benchmark (target %). Pie: bank vs returned / lost.
//   2. Financial year — running total 1 July → this month, vs the benchmark summed.
//   3. Since start — value and return on the starting bank.
export default function JournalBenchmark({ s, accounts, onAccountsChange, monthLabel, isCurrentMonth }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  function openEditor() {
    const f = {};
    accounts.forEach(a => {
      f[a.id] = { target: a.journalTargetPct ?? '', invested: a.journalInvested ?? '', since: a.journalSince ?? '' };
    });
    setForm(f); setErr(null); setEditing(true);
  }

  async function save() {
    setSaving(true); setErr(null);
    const num = v => { const t = String(v).trim(); return t !== '' && isFinite(parseFloat(t)) ? parseFloat(t) : null; };
    try {
      const updated = accounts.map(a => {
        if (!form[a.id]) return a;
        const next = { ...a, journalSince: form[a.id].since || '' };
        const tp = num(form[a.id].target), inv = num(form[a.id].invested);
        if (tp == null) delete next.journalTargetPct; else next.journalTargetPct = tp;
        if (inv == null) delete next.journalInvested; else next.journalInvested = inv;
        return next;
      });
      await api.saveAccounts(updated);
      onAccountsChange?.(updated);
      setEditing(false);
    } catch (e) {
      setErr('Could not save' + (e.message ? `: ${e.message}` : ''));
    }
    setSaving(false);
  }

  const m = s.month, fy = s.fy;
  const monthUp = m.pnl >= 0;
  const slices = pieSlices({ invested: m.start, totalPnl: m.pnl });
  // Progress toward the month's target, clamped for the bar; the number stays true.
  const progress = m.targetAmt > 0 ? Math.max(0, Math.min(1, m.pnl / m.targetAmt)) : 0;
  const anyFallback = s.members.some(a => benchmarkOf(a).fromStarting);

  return (
    <div className="card mb-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-text">{monthLabel} return</h3>
        <button onClick={editing ? () => setEditing(false) : openEditor}
          title="Monthly target return % and starting bank, per account"
          className="flex items-center gap-1 text-[12px] px-2 py-0.5 rounded border border-bg-border text-text-muted hover:text-white hover:border-accent transition-colors">
          {editing ? <><X size={11} /> Cancel</> : <><Settings2 size={11} /> Benchmark</>}
        </button>
      </div>

      {editing ? (
        <div className="space-y-2">
          <p className="text-[12px] text-text-muted leading-snug">
            <b className="text-text">Target</b> is the monthly return you're aiming for (blank = {DEFAULT_TARGET_PCT}%).
            <b className="text-text"> Starting bank</b> is what returns are measured on (blank = the account's
            starting bankroll); P&amp;L before the <b className="text-text">from</b> date is left out of it.
          </p>
          <div className="grid grid-cols-[1fr_4rem_5.5rem_8rem] gap-1.5 text-[11px] text-text-faint uppercase tracking-wider">
            <span>Account</span><span>Target %</span><span>Start bank</span><span>From</span>
          </div>
          {Object.keys(form).map(id => {
            const a = accounts.find(x => x.id === id);
            const set = (k, v) => setForm(p => ({ ...p, [id]: { ...p[id], [k]: v } }));
            const inputCls = 'px-1.5 py-1 bg-bg border border-bg-border rounded text-xs mono text-text outline-none focus:border-accent min-w-0';
            return (
              <div key={id} className="grid grid-cols-[1fr_4rem_5.5rem_8rem] gap-1.5 items-center">
                <span className="text-xs text-white truncate">{a?.name || id}</span>
                <input type="number" inputMode="decimal" step="0.5" value={form[id].target}
                  placeholder={String(DEFAULT_TARGET_PCT)} onChange={e => set('target', e.target.value)} className={inputCls} />
                <input type="number" inputMode="decimal" value={form[id].invested}
                  placeholder={String(parseFloat(a?.startingBankroll) || 0)} onChange={e => set('invested', e.target.value)} className={inputCls} />
                <input type="date" value={form[id].since} onChange={e => set('since', e.target.value)} className={inputCls} />
              </div>
            );
          })}
          {err && <div className="text-[12px] text-red">{err}</div>}
          <button onClick={save} disabled={saving}
            className="mt-1 flex items-center gap-1.5 px-3 py-1 text-xs font-medium bg-accent hover:bg-accent-hover text-white rounded-lg transition-colors disabled:opacity-50">
            <Save size={12} /> {saving ? 'Saving…' : 'Save benchmarks'}
          </button>
        </div>
      ) : s.members.length === 0 ? (
        <div className="py-6 text-center text-text-faint text-sm">No account selected</div>
      ) : (<>
        {/* ── 1. This month only ── */}
        <div className="flex items-center gap-3">
          <div className="w-[104px] h-[104px] flex-shrink-0 relative">
            {slices.length > 0 && (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={slices.map(x => x.key === 'invested' ? { ...x, name: 'Bank at month start' } : x)}
                    dataKey="value" nameKey="name" cx="50%" cy="50%" startAngle={90} endAngle={-270}
                    outerRadius={50} innerRadius={31} strokeWidth={1} stroke="#161b22" isAnimationActive={false}>
                    {slices.map(x => <Cell key={x.key} fill={SLICE[x.key]} />)}
                  </Pie>
                  <Tooltip contentStyle={ttStyle} formatter={(v, n) => [fmt$(v), n]} />
                </PieChart>
              </ResponsiveContainer>
            )}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <span className="mono text-[13px] font-bold" style={{ color: pnlColor(m.pnl) }}>{pct(m.returnPct)}</span>
            </div>
          </div>
          <div className="flex-1 min-w-0">
            <div className="mono text-2xl font-bold" style={{ color: pnlColor(m.pnl) }}>{fmt$(m.pnl)}</div>
            <div className="text-[12px] text-text-faint mb-1.5">
              {isCurrentMonth ? 'month to date' : 'for the month'} · {m.trades}t {m.wins}W {m.losses}L
              {m.trades > 0 && <> · avg {fmt$(m.avgPerTrade)}</>}
            </div>
            <div className="space-y-1 text-xs">
              <Row color={SLICE.invested} label="Bank at start" value={fmt$(m.start)} />
              {monthUp
                ? <Row color={SLICE.returned} label="Returned" value={fmt$(m.pnl)} valueColor="#3fb950" />
                : <Row color={SLICE.lost} label="Lost" value={fmt$(-m.pnl)} valueColor="#f85149" />}
            </div>
          </div>
        </div>

        {/* Monthly benchmark */}
        <div className="mt-3">
          <div className="flex justify-between text-[12px] mb-1">
            <span className="text-text-muted">
              Benchmark {+m.targetPct.toFixed(2)}%{s.targetDefault && <span className="text-text-faint"> (default)</span>} = {fmt$(m.targetAmt)}
            </span>
            <span className="mono" style={{ color: pnlColor(m.vsTarget) }}>
              {m.vsTarget >= 0 ? 'ahead ' : 'behind '}{fmt$(Math.abs(m.vsTarget))}
            </span>
          </div>
          <div className="h-2 rounded-full bg-bg-border overflow-hidden">
            <div className="h-full rounded-full" style={{ width: `${progress * 100}%`, background: m.vsTarget >= 0 ? '#3fb950' : (m.pnl > 0 ? '#d29922' : '#f85149') }} />
          </div>
        </div>

        {/* ── 2. Financial year running total ── */}
        <div className="mt-5 pt-4 border-t border-bg-border">
          <div className="flex items-baseline justify-between">
            <span className="text-[12px] text-text-faint uppercase tracking-wider">{fy.label} running total</span>
            <span className="mono text-[12px]" style={{ color: pnlColor(fy.pnl) }}>{pct(fy.returnPct)}</span>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="mono text-xl font-bold" style={{ color: pnlColor(fy.pnl) }}>{fmt$(fy.pnl)}</span>
            <span className="text-[12px] text-text-muted">
              target {fmt$(fy.target)} · <span className="mono" style={{ color: pnlColor(fy.vsTarget) }}>{fy.vsTarget >= 0 ? '+' : '-'}{fmt$(Math.abs(fy.vsTarget))}</span>
            </span>
          </div>
          <div className="h-[110px] -mx-1 mt-1">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={fy.rows} margin={{ top: 6, right: 4, bottom: 0, left: 4 }}>
                <XAxis dataKey="label" tick={{ fill: '#8b949e', fontSize: 11 }} axisLine={false} tickLine={false} interval={0} />
                <YAxis hide domain={[d => Math.min(0, d), d => Math.max(0, d)]} />
                <ReferenceLine y={0} stroke="#30363d" />
                <Tooltip contentStyle={ttStyle} labelFormatter={(l, p) => p?.[0] ? `${l} ${p[0].payload.year}` : l}
                  formatter={(v, n, p) => {
                    if (n === 'pnl') return [`${fmt$(v)} (${pct(p.payload.returnPct)})`, 'Month'];
                    if (n === 'cumPnl') return [fmt$(v), 'Running total'];
                    return [fmt$(v), 'Benchmark to date'];
                  }} />
                <Bar dataKey="pnl" maxBarSize={18} isAnimationActive={false}>
                  {fy.rows.map((r, i) => <Cell key={i} fill={r.pnl >= 0 ? '#3fb950' : '#f85149'} fillOpacity={0.55} />)}
                </Bar>
                <Line dataKey="cumTarget" stroke="#2f81f7" strokeDasharray="4 3" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                <Line dataKey="cumPnl" stroke="#e6edf3" strokeWidth={1.75} dot={{ r: 2 }} isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className="flex gap-3 text-[11px] text-text-faint mt-0.5">
            <span><span className="inline-block w-3 border-t-2 border-text align-middle mr-1" />running total</span>
            <span><span className="inline-block w-3 border-t-2 border-dashed border-accent align-middle mr-1" />benchmark</span>
            <span>bars = month</span>
          </div>
        </div>

        {/* ── 3. Since start, on the starting bank ── */}
        <div className="mt-4 pt-3 border-t border-bg-border text-xs space-y-1">
          <div className="text-[12px] text-text-faint uppercase tracking-wider mb-1">Since start</div>
          <Row label={<>Starting bank{anyFallback && <span className="text-amber"> (bankroll)</span>}</>} value={fmt$(s.since.invested)} />
          <Row label={s.since.pnl >= 0 ? 'Returned' : 'Lost'} value={`${fmt$(Math.abs(s.since.pnl))}  ${pct(s.since.returnPct)}`} valueColor={pnlColor(s.since.pnl)} />
          <Row label="Now worth" value={fmt$(s.since.value)} bold />
        </div>
      </>)}
    </div>
  );
}

function Row({ color, label, value, valueColor, bold }) {
  return (
    <div className="flex items-center gap-2">
      {color && <div className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: color }} />}
      <span className="text-text-muted flex-1">{label}</span>
      <span className={`mono ${bold ? 'font-bold text-white' : ''}`} style={valueColor ? { color: valueColor } : undefined}>{value}</span>
    </div>
  );
}
