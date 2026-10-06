import React, { useState } from 'react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, AreaChart, Area, XAxis, YAxis, ReferenceLine } from 'recharts';
import { Settings2, Save, X } from 'lucide-react';
import { api } from '../utils/api';
import { fmt$, pnlColor } from '../utils/format';
import { benchmarkOf, pieSlices } from '../utils/benchmark';

const SLICE = { invested: '#2f81f7', returned: '#3fb950', remaining: '#30363d', lost: '#f85149' };
const ttStyle = { background: '#161b22', border: '1px solid #30363d', borderRadius: 8, fontSize: 12 };
const pct = v => (v == null ? '--' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`);

// Running total + end-of-month pie for the Journal. `rt` comes from runningTotal()
// for the month on screen; `members` are the accounts in the current view.
export default function JournalBenchmark({ rt, members, accounts, onAccountsChange, monthLabel, isCurrentMonth }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const anyFallback = members.some(a => benchmarkOf(a).fromStarting);
  const slices = pieSlices(rt);
  const up = rt.totalPnl >= 0;

  function openEditor() {
    const f = {};
    accounts.forEach(a => {
      f[a.id] = { invested: a.journalInvested ?? '', since: a.journalSince ?? '' };
    });
    setForm(f); setErr(null); setEditing(true);
  }

  async function save() {
    setSaving(true); setErr(null);
    try {
      const updated = accounts.map(a => {
        if (!form[a.id]) return a;
        const inv = String(form[a.id].invested).trim();
        const next = { ...a, journalSince: form[a.id].since || '' };
        if (inv === '' || !isFinite(parseFloat(inv))) delete next.journalInvested;
        else next.journalInvested = parseFloat(inv);
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

  return (
    <div className="card mb-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-text">Running total</h3>
        <button onClick={editing ? () => setEditing(false) : openEditor}
          title="Money invested per account — the offset the running total starts from"
          className="flex items-center gap-1 text-[12px] px-2 py-0.5 rounded border border-bg-border text-text-muted hover:text-white hover:border-accent transition-colors">
          {editing ? <><X size={11} /> Cancel</> : <><Settings2 size={11} /> Benchmark</>}
        </button>
      </div>

      {editing ? (
        <div className="space-y-2">
          <p className="text-[12px] text-text-muted leading-snug">
            Money invested in each account. Only P&amp;L on or after the <em>from</em> date
            counts, so set it to the day the figure was true. Blank invested uses the
            account's starting bankroll.
          </p>
          {Object.keys(form).map(id => {
            const a = accounts.find(x => x.id === id);
            return (
              <div key={id} className="grid grid-cols-[1fr_6.5rem_8.5rem] gap-1.5 items-center">
                <span className="text-xs text-white truncate">{a?.name || id}</span>
                <input type="number" inputMode="decimal" value={form[id].invested}
                  placeholder={String(parseFloat(a?.startingBankroll) || 0)}
                  onChange={e => setForm(p => ({ ...p, [id]: { ...p[id], invested: e.target.value } }))}
                  className="px-2 py-1 bg-bg border border-bg-border rounded text-xs mono text-text outline-none focus:border-accent" />
                <input type="date" value={form[id].since}
                  onChange={e => setForm(p => ({ ...p, [id]: { ...p[id], since: e.target.value } }))}
                  className="px-1.5 py-1 bg-bg border border-bg-border rounded text-xs text-text outline-none focus:border-accent" />
              </div>
            );
          })}
          {err && <div className="text-[12px] text-red">{err}</div>}
          <button onClick={save} disabled={saving}
            className="mt-1 flex items-center gap-1.5 px-3 py-1 text-xs font-medium bg-accent hover:bg-accent-hover text-white rounded-lg transition-colors disabled:opacity-50">
            <Save size={12} /> {saving ? 'Saving…' : 'Save benchmarks'}
          </button>
        </div>
      ) : members.length === 0 ? (
        <div className="py-6 text-center text-text-faint text-sm">No account selected</div>
      ) : (<>
        {/* Headline: where the money stands at the end of the month on screen */}
        <div className="flex items-baseline justify-between">
          <div className="mono text-3xl font-bold text-white">{fmt$(rt.endValue)}</div>
          <div className="mono text-sm font-bold" style={{ color: pnlColor(rt.totalPnl) }}>{pct(rt.totalReturnPct)}</div>
        </div>
        <div className="text-[12px] text-text-faint mb-3">
          {isCurrentMonth ? 'today' : `end of ${monthLabel}`} · invested {fmt$(rt.invested)}
          {anyFallback && <span className="text-amber"> (starting bankroll)</span>}
        </div>

        {/* Running total through the month */}
        <div className="h-[90px] -mx-1">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={rt.series} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
              <defs>
                <linearGradient id="rtFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={up ? '#3fb950' : '#f85149'} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={up ? '#3fb950' : '#f85149'} stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="day" hide />
              <YAxis hide domain={['dataMin', 'dataMax']} />
              <ReferenceLine y={rt.invested} stroke="#2f81f7" strokeDasharray="3 3" strokeOpacity={0.6} />
              <Tooltip contentStyle={ttStyle} labelFormatter={d => `Day ${d}`}
                formatter={(v, _n, p) => [`${fmt$(v)}${p.payload.pnl ? `  (${p.payload.pnl > 0 ? '+' : ''}${fmt$(p.payload.pnl)})` : ''}`, 'Running total']} />
              <Area type="stepAfter" dataKey="value" stroke={up ? '#3fb950' : '#f85149'} strokeWidth={1.5} fill="url(#rtFill)" isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="flex justify-between text-[12px] text-text-faint mb-4">
          <span>start {fmt$(rt.startValue)}</span>
          <span>month <span className="mono" style={{ color: pnlColor(rt.monthPnl) }}>{fmt$(rt.monthPnl)} {pct(rt.monthReturnPct)}</span></span>
        </div>

        {/* End-of-month pie: invested vs returned, or remaining vs lost */}
        <div className="flex items-center gap-3">
          <div className="w-[110px] h-[110px] flex-shrink-0 relative">
            {slices.length > 0 && (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={slices} dataKey="value" nameKey="name" cx="50%" cy="50%" startAngle={90} endAngle={-270}
                    outerRadius={52} innerRadius={32} strokeWidth={1} stroke="#161b22" isAnimationActive={false}>
                    {slices.map(s => <Cell key={s.key} fill={SLICE[s.key]} />)}
                  </Pie>
                  <Tooltip contentStyle={ttStyle} formatter={(v, n) => [fmt$(v), n]} />
                </PieChart>
              </ResponsiveContainer>
            )}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <span className="mono text-[12px] font-bold" style={{ color: pnlColor(rt.totalPnl) }}>{pct(rt.totalReturnPct)}</span>
            </div>
          </div>
          <div className="flex-1 space-y-1.5 text-xs">
            <Row color={SLICE.invested} label="Invested" value={fmt$(rt.invested)} />
            {up
              ? <Row color={SLICE.returned} label="Returned" value={fmt$(rt.totalPnl)} valueColor="#3fb950" />
              : <Row color={SLICE.lost} label="Lost" value={fmt$(-rt.totalPnl)} valueColor="#f85149" />}
            <div className="border-t border-bg-border pt-1.5">
              <Row label={up ? 'Now worth' : 'Remaining'} value={fmt$(rt.endValue)} bold />
            </div>
          </div>
        </div>
      </>)}
    </div>
  );
}

function Row({ color, label, value, valueColor, bold }) {
  return (
    <div className="flex items-center gap-2">
      {color ? <div className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: color }} /> : <div className="w-2.5" />}
      <span className="text-text-muted flex-1">{label}</span>
      <span className={`mono ${bold ? 'font-bold text-white' : ''}`} style={valueColor ? { color: valueColor } : undefined}>{value}</span>
    </div>
  );
}
