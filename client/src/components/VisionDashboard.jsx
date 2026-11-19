import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Target, Layers, Activity, X, ArrowUp, ArrowDown, Plus, Pencil } from 'lucide-react';
import { api } from '../utils/api';
import { fmt$ } from '../utils/format';
import { nyISODate } from '../utils/stats';
import { closedPnlEvents, journalSummary, benchmarkOf } from '../utils/benchmark';
import { accountColor } from '../utils/accountColors';
import { boardRow, exitProgress } from './PositionBoard';
import { runCheckup, bridgeUrlOf } from './Checkup45';
import { marksFor, recordMarks } from '../live/markLog';
import { DEFAULT_WATCHLIST, loadWatchlist } from '../utils/watchlist';
import { useLiveQuote, useLiveConnection, useFreshness } from '../live/useLive';
import { liveRiskTotal } from '../utils/positionLines';
import { ticketExpiry } from '../utils/ticketExpiry';
import { tradingSession, sessionDateOf } from '../engine/session';
import { nyMinutes } from '../engine/review0';
import { watchSymbols } from './VisionDashHero';
import { periodSeries, weekCounts, realisedBars, winRateWindow, monthActivity, needsYou, paceForMonth } from '../utils/visionDash';
import { bareStrategy } from '../utils/tradeStory';

// The Vision Dashboard, laid out as the design (Nov 2026): Watching and the monthly
// target ring on the left; P&L with its line, this week's trades, what needs you and
// realised P&L in the middle; win rate, this month, SPX live and open risk as tiles on
// the right, with the open positions under them. White ink, one blue; green and red
// only inside the small pills.

const BUBBLE = ['#f1e4d6', '#e8cfc4', '#e3d6ee', '#d6e4f2', '#dfe9d8'];
const money = v => { const r = Math.round(v); return (r < 0 ? '−' : r > 0 ? '+' : '') + '$' + Math.abs(r).toLocaleString('en-US'); };
const lab = { fontSize: 14, color: 'rgba(255,255,255,0.72)' };

function Seg({ options, value, onChange, testid }) {
  return (
    <div className="vd-seg" data-testid={testid}>
      {options.map(([id, label]) => (
        <button key={id} type="button" aria-pressed={value === id} className={value === id ? 'on' : ''} onClick={() => onChange(id)}>{label}</button>
      ))}
    </div>
  );
}
function Delta({ v, suffix = '', invert = false }) {
  if (v == null || !isFinite(v)) return null;
  const up = invert ? v < 0 : v >= 0;
  return <span className={`vd-delta ${up ? 'up' : 'down'}`}>{v >= 0 ? <ArrowUp size={12} /> : <ArrowDown size={12} />}{Math.abs(v)}{suffix}</span>;
}

// ── Watching ──
function Bubble({ sym, i, on, onPick }) {
  const q = useLiveQuote(sym);
  const fresh = useFreshness(q);
  return (
    <button type="button" className={`vd-bubble ${on ? 'on' : ''}`} style={{ background: BUBBLE[i % BUBBLE.length], zIndex: 10 - i }} onClick={onPick}
      title={sym} data-testid={`vd-bubble-${sym}`}>
      {sym.slice(0, 4)}
      {q && (q.last ?? q.mark) != null && <span className="vd-live" style={{ background: fresh === 'live' || fresh === 'fresh' ? '#7ee2a0' : '#ffd479' }} />}
    </button>
  );
}
function PickedQuote({ sym }) {
  const q = useLiveQuote(sym);
  const px = q && (q.last ?? q.mark);
  const chg = px != null && q.close ? (px / q.close - 1) * 100 : null;
  return (
    <div className="flex items-baseline gap-3 mt-4" data-testid="vd-picked">
      <span style={{ fontSize: 15, fontWeight: 600 }}>{sym}</span>
      <span className="num" style={{ fontSize: 22, fontWeight: 600 }}>{px != null ? Number(px).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}</span>
      {chg != null ? <span className={`vd-delta ${chg >= 0 ? 'up' : 'down'}`}>{chg >= 0 ? '+' : '−'}{Math.abs(chg).toFixed(2)}%</span> : <span style={lab}>no quote</span>}
    </div>
  );
}
function WatchingCard({ onOpenEngine }) {
  const [watch, setWatch] = useState(DEFAULT_WATCHLIST);
  useEffect(() => { let live = true; loadWatchlist().then(r => { if (live && r && r.list) setWatch(r.list); }).catch(() => {}); return () => { live = false; }; }, []);
  const all = watchSymbols(watch, 12);
  const shown = all.slice(0, 4);
  const [pick, setPick] = useState(null);
  const sym = pick || shown[0];
  const live = useLiveConnection();
  const lines = live.connection === 'open' ? (live.status && live.status.lines) || 0 : null;
  const mode = live.connection === 'open' ? (live.status && live.status.mode) || '' : '';
  return (
    <section className="card vd-card" data-testid="vd-watching">
      <div className="flex items-center justify-between">
        <h3 className="vd-h">Watching</h3>
        {onOpenEngine && <button type="button" className="vd-icon" onClick={onOpenEngine} aria-label="Edit the watchlist in the Decision Engine"><Plus size={22} /></button>}
      </div>
      <div className="flex items-center gap-2 mt-1" style={lab}>
        <span style={{ width: 8, height: 8, borderRadius: 4, background: lines != null ? '#7ee2a0' : 'rgba(255,255,255,0.35)' }} />
        {lines != null ? `TWS ${mode || 'stream'} · ${lines} lines live` : 'TWS stream off'}
      </div>
      <div className="vd-bubbles mt-4">
        {shown.map((s, i) => <Bubble key={s} sym={s} i={i} on={s === sym} onPick={() => setPick(s)} />)}
        {all.length > shown.length && <span className="vd-bubble vd-bubble-more">+{all.length - shown.length}</span>}
      </div>
      {sym && <PickedQuote sym={sym} />}
    </section>
  );
}

// ── Monthly target (Nov 2026) ──
// One account: a compact row — ring, $ of target, pace — about a quarter of the old
// tile. All accounts with more than one: a ring per account in its colour, the
// combined share in the middle, a line per account beside it. The pencil edits the
// account's target (the same number as the Journal benchmark).
function Rings({ items, size, stroke = 9, gap = 14, children }) {
  const c = size / 2;
  return (
    <div style={{ position: 'relative', width: size, height: size, flex: 'none' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        {items.map((it, i) => {
          const r = c - stroke / 2 - 2 - i * gap, C = 2 * Math.PI * r, f = Math.max(0, Math.min(1, it.frac || 0));
          return (
            <g key={i}>
              <circle cx={c} cy={c} r={r} fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth={stroke} />
              {f > 0 && <circle cx={c} cy={c} r={r} fill="none" stroke={it.color} strokeWidth={stroke} strokeLinecap="round"
                strokeDasharray={`${C * f} ${C}`} transform={`rotate(-90 ${c} ${c})`} />}
            </g>
          );
        })}
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>{children}</div>
    </div>
  );
}
function PencilBtn({ label, onClick, testid }) {
  return (
    <button type="button" className="vd-round" data-testid={testid} aria-label={label} title={label} onClick={onClick}
      style={{ width: 40, height: 40, flex: 'none' }}><Pencil size={16} /></button>
  );
}
const pctOf = m => (m.targetAmt > 0 ? Math.max(0, m.pnl / m.targetAmt) : 0);
function PaceLine({ m, back, todayISO }) {
  const pace = back === 0 ? paceForMonth(m.pnl, m.start, todayISO) : (m.start > 0 ? Math.round(m.pnl / m.start * 1000) / 10 : null);
  if (pace == null) return null;
  const ahead = pace >= Number(m.targetPct);
  return <span data-testid="vd-target-pace" style={{ fontSize: 13, color: ahead ? '#7ee2a0' : '#ffd479' }}>
    {back === 0 ? `on pace for ${pace}% · ${ahead ? 'ahead' : 'behind'}` : `made ${pace}% · ${ahead ? 'hit' : 'missed'}`}</span>;
}
export function TargetEditor({ acct, start, accounts, onSaved, onCancel }) {
  const [mode, setMode] = useState('pct');
  const cur = benchmarkOf(acct).targetPct;
  const [val, setVal] = useState(String(+Number(cur).toFixed(2)));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const v = parseFloat(val);
  const pct = !isFinite(v) || v < 0 ? null : mode === 'pct' ? v : start > 0 ? v / start * 100 : null;
  const amt = pct != null && start > 0 ? start * pct / 100 : null;
  const switchMode = m => {
    if (m === mode) return;
    if (m === 'usd' && pct != null && start > 0) setVal(String(Math.round(start * pct / 100)));
    if (m === 'pct' && isFinite(v) && start > 0) setVal(String(+(v / start * 100).toFixed(2)));
    setMode(m);
  };
  async function save() {
    if (pct == null) { setErr('Enter a number'); return; }
    setBusy(true); setErr('');
    const updated = (accounts || []).map(a => (a.id === acct.id ? { ...a, journalTargetPct: Math.round(pct * 100) / 100 } : a));
    try { await api.saveAccounts(updated); onSaved(updated); }
    catch (e) { setErr('Could not save' + (e.message ? `: ${e.message}` : '')); setBusy(false); }
  }
  const seg = on => ({ border: 'none', borderRadius: 999, padding: '7px 14px', font: 'inherit', fontSize: 13.5, cursor: 'pointer',
    background: on ? 'rgba(255,255,255,0.26)' : 'transparent', color: on ? '#fff' : 'rgba(255,255,255,0.84)' });
  return (
    <div data-testid="vd-target-editor" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 500 }}>
        <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 5, background: accountColor(acct.id, accounts) }} />{acct.name} · monthly target
      </div>
      <div role="group" aria-label="Target as" style={{ display: 'inline-flex', alignSelf: 'flex-start', gap: 2, padding: 4, borderRadius: 999, background: 'rgba(0,0,0,0.16)' }}>
        <button type="button" aria-pressed={mode === 'pct'} style={seg(mode === 'pct')} onClick={() => switchMode('pct')}>% of bank</button>
        <button type="button" aria-pressed={mode === 'usd'} style={seg(mode === 'usd')} onClick={() => switchMode('usd')} disabled={!(start > 0)}>$ a month</button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <label htmlFor={`tg-${acct.id}`} style={{ fontSize: 14, color: 'rgba(255,255,255,0.86)' }}>Target</label>
        {mode === 'usd' && <span style={{ fontSize: 18 }}>$</span>}
        <input id={`tg-${acct.id}`} data-testid="vd-target-input" inputMode="decimal" value={val} onChange={e => setVal(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onCancel(); }}
          style={{ width: mode === 'usd' ? 110 : 80, fontSize: 18, fontWeight: 600 }} className="num" />
        {mode === 'pct' && <span style={{ fontSize: 18 }}>%</span>}
        <span className="num" style={{ fontSize: 13.5, color: 'rgba(255,255,255,0.86)' }}>
          {mode === 'pct' ? (amt != null ? `= ${fmt$(amt)} a month on ${fmt$(start)}` : '') : (pct != null ? `= ${+pct.toFixed(2)}% of ${fmt$(start)}` : '')}
        </span>
      </div>
      <span style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.8)' }}>The Journal benchmark uses the same number.</span>
      {err && <span style={{ fontSize: 13, color: '#ffa39a' }}>{err}</span>}
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
        <button type="button" onClick={onCancel} style={{ height: 40, padding: '0 18px', borderRadius: 20, border: 'none', font: 'inherit', fontSize: 14, color: '#fff', background: 'transparent', cursor: 'pointer' }}>Cancel</button>
        <button type="button" data-testid="vd-target-save" onClick={save} disabled={busy}
          style={{ height: 40, padding: '0 20px', borderRadius: 20, border: 'none', font: 'inherit', fontSize: 14, fontWeight: 600, color: '#24221f', background: '#fff', cursor: 'pointer' }}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}
export function MonthlyTargetCard({ account, accounts, tracker, decisions, onAccountsChange }) {
  const [back, setBack] = useState(0);
  const [editing, setEditing] = useState(null);   // account id
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
  const Y = d.getFullYear(), M = d.getMonth();
  const events = useMemo(() => closedPnlEvents(tracker, decisions), [tracker, decisions]);
  const s = useMemo(() => journalSummary(account, accounts, events, Y, M), [account, accounts, events, Y, M]);
  const members = s.members || [];
  const per = useMemo(() => (account === 'all' && members.length > 1
    ? members.map(a => ({ a, m: journalSummary(a.id, accounts, events, Y, M).month })) : null), [account, accounts, events, Y, M, members]);
  const m = s.month;
  const frac = pctOf(m);
  const todayISO = nyISODate();
  const monthLbl = d.toLocaleDateString('en-AU', { month: 'short', year: 'numeric' });
  const single = !per ? (members[0] || accounts.find(a => a.id === account) || null) : null;
  const arrows = (
    <span style={{ display: 'inline-flex', gap: 6 }}>
      <button type="button" className="vd-round" style={{ width: 34, height: 34 }} onClick={() => setBack(b => b + 1)} aria-label="Previous month"><ArrowDown size={15} /></button>
      <button type="button" className="vd-round" style={{ width: 34, height: 34 }} onClick={() => setBack(b => Math.max(0, b - 1))} disabled={back === 0} aria-label="Next month"><ArrowUp size={15} /></button>
    </span>
  );
  const saved = updated => { setEditing(null); onAccountsChange && onAccountsChange(updated); };
  const editAcct = editing ? accounts.find(a => a.id === editing) : null;
  const editStart = editAcct ? (per ? (per.find(x => x.a.id === editing) || {}).m?.start : m.start) || 0 : 0;

  return (
    <section className="card vd-card vd-target" data-testid="vd-target" data-layout={per ? 'rings' : 'compact'} style={{ padding: '18px 22px' }}>
      <div className="flex items-center gap-3" style={{ marginBottom: 12 }}>
        <div className="flex-1 min-w-0">
          <h3 className="vd-h" style={{ fontSize: 19 }}>Monthly target</h3>
          <div style={{ ...lab, fontSize: 13 }}>{monthLbl}{per ? ` · ${fmt$(m.pnl)} of ${fmt$(m.targetAmt)}` : ''}</div>
        </div>
        {arrows}
      </div>
      {editAcct ? (
        <TargetEditor acct={editAcct} start={editStart} accounts={accounts} onSaved={saved} onCancel={() => setEditing(null)} />
      ) : per ? (
        <div className="flex items-center gap-4">
          <Rings size={150} items={per.slice(0, 4).map(x => ({ color: accountColor(x.a.id, accounts), frac: pctOf(x.m) }))}>
            <span className="num" data-testid="vd-target-pct" style={{ fontSize: 26, fontWeight: 600, lineHeight: 1 }}>{m.targetAmt > 0 ? Math.round(frac * 100) : '—'}%</span>
            <span style={{ fontSize: 11.5, color: 'rgba(255,255,255,0.86)', marginTop: 3 }}>all accounts</span>
          </Rings>
          <div className="flex-1 min-w-0" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {per.map(({ a, m: am }) => (
              <div key={a.id} data-testid="vd-target-acct" className="flex items-center gap-2">
                <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 5, background: accountColor(a.id, accounts), flex: 'none' }} />
                <div className="flex-1 min-w-0" style={{ lineHeight: 1.3 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{a.name} <span style={{ fontWeight: 500, color: 'rgba(255,255,255,0.86)' }}>{am.targetAmt > 0 ? `${Math.round(pctOf(am) * 100)}%` : '—'}</span></div>
                  <div className="num" title={`${+Number(am.targetPct).toFixed(1)}% of bank`} style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.86)' }}>{fmt$(am.pnl)} of {fmt$(am.targetAmt)}</div>
                </div>
                <PencilBtn label={`Edit ${a.name}'s target`} testid="vd-target-edit" onClick={() => setEditing(a.id)} />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-4">
          <Rings size={104} items={[{ color: single ? accountColor(single.id, accounts) : '#6aa8ff', frac }]}>
            <span className="num" data-testid="vd-target-pct" style={{ fontSize: 24, fontWeight: 600, lineHeight: 1 }}>{m.targetAmt > 0 ? Math.round(frac * 100) : '—'}%</span>
          </Rings>
          <div className="flex-1 min-w-0" style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span className="num" style={{ fontSize: 15 }}><b style={{ fontWeight: 600 }}>{fmt$(m.pnl)}</b> <span style={{ color: 'rgba(255,255,255,0.8)' }}>of {fmt$(m.targetAmt)}</span></span>
            <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.8)' }}>{+Number(m.targetPct).toFixed(1)}% of bank{single ? ` · ${single.name}` : ''}</span>
            <PaceLine m={m} back={back} todayISO={todayISO} />
          </div>
          {single && <PencilBtn label="Edit target" testid="vd-target-edit" onClick={() => setEditing(single.id)} />}
        </div>
      )}
    </section>
  );
}

// ── P&L with its line ──
function AreaLine({ points, height = 150 }) {
  const W = 600;
  if (points.length < 2) return <div style={{ height }} />;
  const ys = points.map(p => p.cum), lo = Math.min(0, ...ys), hi = Math.max(0, ...ys);
  const X = i => i / (points.length - 1) * W, Y = v => height - 8 - (v - lo) / ((hi - lo) || 1) * (height - 24);
  // A smooth line: midpoint quadratic curves through the points.
  let d = `M0 ${Y(points[0].cum)}`;
  for (let i = 1; i < points.length; i++) {
    const x0 = X(i - 1), y0 = Y(points[i - 1].cum), x1 = X(i), y1 = Y(points[i].cum), mx = (x0 + x1) / 2;
    d += ` C${mx} ${y0} ${mx} ${y1} ${x1} ${y1}`;
  }
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" aria-hidden="true" data-testid="vd-line">
      <defs><linearGradient id="vd-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="rgba(255,255,255,0.28)" /><stop offset="1" stopColor="rgba(255,255,255,0)" /></linearGradient></defs>
      <line x1="0" x2={W} y1={Y(0)} y2={Y(0)} stroke="rgba(255,255,255,0.3)" strokeDasharray="4 6" vectorEffect="non-scaling-stroke" />
      <path d={`${d} L${W} ${height} L0 ${height} Z`} fill="url(#vd-fill)" />
      <path d={d} fill="none" stroke="#fff" strokeWidth="3" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
function PnlCard({ trades, config, bank }) {
  const todayISO = nyISODate();
  const hasToday = useMemo(() => trades.some(t => String(t['Close Date'] || '').slice(0, 10) === todayISO), [trades, todayISO]);
  const [period, setPeriod] = useState(hasToday ? 'today' : 'week');
  const s = useMemo(() => periodSeries(trades, period, todayISO), [trades, period, todayISO]);
  const cap = Number(config?.maxDailyLoss) || 0;
  const pctBank = bank > 0 ? Math.round(s.total / bank * 1000) / 10 : null;
  const title = { today: 'P&L today', week: 'P&L this week', month: 'P&L this month' }[period];
  return (
    <section className="card vd-card vd-pnl" data-testid="vd-pnl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div style={lab}>{title}</div>
          <div className="flex items-end gap-3 mt-1">
            <span className="num vd-huge" data-testid="vd-pnl-value">{money(s.total)}</span>
            {period === 'today' && cap > 0 && <span style={{ ...lab, fontSize: 17, lineHeight: 1.2, paddingBottom: 10 }}>/ {fmt$(cap)}<br />loss cap</span>}
          </div>
          <div style={{ ...lab, marginTop: 4 }}>
            {pctBank != null && <>{s.total >= 0 ? '↑' : '↓'} {pctBank >= 0 ? '+' : ''}{pctBank}% of bank · </>}{s.count} trade{s.count === 1 ? '' : 's'} closed
          </div>
        </div>
        <Seg options={[['today', 'Today'], ['week', 'Week'], ['month', 'Month']]} value={period} onChange={setPeriod} testid="vd-pnl-period" />
      </div>
      <div className="mt-3 -mx-6"><AreaLine points={s.points} /></div>
      {s.steps.length > 0 ? (
        <div className="vd-steps">
          {s.steps.map((p, i) => (
            <div key={i} className="text-center">
              <div className={`num vd-step ${p.pnl < 0 ? 'down' : ''}`}>{p.pnl >= 0 ? '↑' : '↓'} {money(p.pnl)}</div>
              <div style={{ ...lab, fontSize: 13 }}>{p.label}</div>
            </div>
          ))}
        </div>
      ) : <div style={{ ...lab, textAlign: 'center' }}>{period === 'today' ? 'Nothing closed yet today' : 'Nothing closed yet'}</div>}
    </section>
  );
}

// ── This week · trades ──
function WeekTradesCard({ trades }) {
  const w = useMemo(() => weekCounts(trades, nyISODate(), 8), [trades]);
  const mx = Math.max(1, ...w.counts);
  return (
    <section className="card vd-card" data-testid="vd-week">
      <div style={lab}>This week</div>
      <h3 className="vd-h">Trades</h3>
      <div className="flex items-end justify-between mt-4 gap-3" style={{ minHeight: 150 }}>
        <div>
          <div className="num" style={{ fontSize: 52, fontWeight: 600, lineHeight: 1 }}>{w.now}</div>
          {w.change != null && <div className="mt-2"><Delta v={w.change} suffix="%" /></div>}
          <div style={{ ...lab, fontSize: 12.5, marginTop: 6 }}>last week {w.prev}</div>
        </div>
        <div className="flex items-end gap-2" style={{ height: 140 }} title="Trades closed per week, last 8 weeks">
          {w.counts.map((c, i) => (
            <span key={i} style={{ width: 14, height: Math.max(8, c / mx * 136), borderRadius: 8,
              background: i === w.counts.length - 1 ? 'linear-gradient(180deg,#6aa8ff,#3d82f0)' : 'linear-gradient(180deg, rgba(255,255,255,0.55), rgba(255,255,255,0.12))' }} />
          ))}
        </div>
      </div>
    </section>
  );
}

// ── What needs you ──
function NeedsYouCard({ rows, expiries, onReview }) {
  const ny = useMemo(() => needsYou(rows, expiries, { todayYmd: tradingSession().yyyymmdd, nyMinutes: nyMinutes(new Date()) }), [rows, expiries]);
  const [hide, setHide] = useState(false);
  const open = (rows || []).filter(r => Number(r.qtyOpen) > 0);
  const first = ny[0];
  if (!first || hide) {
    return (
      <section className="card vd-card" data-testid="vd-needs">
        <div style={lab}>{open.length} open</div>
        <h3 className="vd-h">Nothing needs you</h3>
        <p style={{ ...lab, fontSize: 13.5, marginTop: 10, lineHeight: 1.45 }}>{open.length ? 'Open positions are inside their plan: no roll or time exit due.' : 'No open positions.'}</p>
        {open.length > 0 && <button type="button" className="vd-pill-btn mt-4" onClick={onReview}>Open ›</button>}
      </section>
    );
  }
  const r = first.row;
  return (
    <section className="card vd-card" data-testid="vd-needs">
      <div className="flex items-start justify-between">
        <div>
          <div style={lab}>{ny.length} need{ny.length === 1 ? 's' : ''} you</div>
          <h3 className="vd-h">{first.title}</h3>
        </div>
        <button type="button" className="vd-round vd-round-sm" onClick={() => setHide(true)} aria-label="Hide"><X size={18} /></button>
      </div>
      <span className="vd-badge mt-2">{first.badge}</span>
      <div style={{ ...lab, marginTop: 12, lineHeight: 1.4 }}>{r.underlying} {bareStrategy(r.strategy).toLowerCase()} {r.legs || ''}</div>
      <button type="button" className="vd-slide mt-4" onClick={onReview} data-testid="vd-needs-review">
        <span className="vd-slide-knob">›</span><span style={{ opacity: 0.8 }}>Review in Open</span>
      </button>
    </section>
  );
}

// ── Realised P&L bars ──
function RealisedCard({ trades }) {
  const [mode, setMode] = useState('week');
  const bars = useMemo(() => realisedBars(trades, mode, nyISODate()), [trades, mode]);
  const mx = Math.max(1, ...bars.map(b => Math.abs(b.pnl)));
  return (
    <section className="card vd-card" data-testid="vd-realised">
      <div className="flex items-center justify-between gap-3">
        <h3 className="vd-h">Realised P&amp;L ($)</h3>
        <Seg options={[['week', 'Week'], ['month', 'Month'], ['year', 'Year']]} value={mode} onChange={setMode} testid="vd-realised-mode" />
      </div>
      <div className="flex items-end gap-4 mt-5" style={{ height: 200 }}>
        {bars.map((b, i) => (
          <div key={i} className="flex-1 flex flex-col items-center justify-end gap-2 h-full" title={`${b.label}: ${fmt$(b.pnl)}`}>
            {(b.now || Math.abs(b.pnl) === mx) && b.pnl !== 0 && <span className="vd-tag">{money(b.pnl)}</span>}
            <span style={{ width: '100%', maxWidth: 44, height: Math.max(b.pnl ? 6 : 3, Math.abs(b.pnl) / mx * 150), borderRadius: 12, opacity: b.future ? 0.35 : 1,
              background: b.now ? 'linear-gradient(180deg,#6aa8ff,#3d82f0)' : b.pnl < 0 ? 'linear-gradient(180deg, rgba(255,163,154,0.85), rgba(255,163,154,0.35))' : 'linear-gradient(180deg, rgba(255,255,255,0.6), rgba(255,255,255,0.14))' }} />
            <span style={{ ...lab, fontSize: 13 }}>{b.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── Right-hand tiles ──
const history = new Map();      // symbol → recent prices, kept across page changes
const histSubs = new Set();
function useHistory(sym) {
  const q = useLiveQuote(sym);
  const px = q && (q.last ?? q.mark);
  useEffect(() => {
    if (!(px > 0)) return;
    const a = history.get(sym) || [];
    if (a[a.length - 1] !== px) { a.push(px); if (a.length > 240) a.shift(); history.set(sym, a); histSubs.forEach(f => f()); }
  }, [sym, px]);
  useSyncExternalStore(f => { histSubs.add(f); return () => histSubs.delete(f); }, () => (history.get(sym) || []).length);
  return { q, px, series: history.get(sym) || [] };
}
function Spark({ series }) {
  if (series.length < 2) return <div style={{ height: 120 }} />;
  const lo = Math.min(...series), hi = Math.max(...series), W = 200, H = 120;
  const pts = series.map((v, i) => `${(i / (series.length - 1)) * W},${H - 10 - (v - lo) / ((hi - lo) || 1) * (H - 30)}`).join(' ');
  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={`0,${H} ${pts} ${W},${H}`} fill="rgba(106,168,255,0.16)" stroke="none" />
      <polyline points={pts} fill="none" stroke="#6aa8ff" strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
function SpxTile() {
  const { q, px, series } = useHistory('SPX');
  const chg = px > 0 && q.close ? (px / q.close - 1) * 100 : null;
  return (
    <div className="card vd-tile" data-testid="vd-spx">
      <div className="flex items-center gap-2"><Activity size={22} /><span className="vd-live-pill">{q && q.ts ? 'LIVE' : 'NO FEED'}</span></div>
      <div className="-mx-4 mt-1"><Spark series={series} /></div>
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="num vd-tile-num" style={{ fontSize: 36, fontWeight: 600, letterSpacing: '-0.02em' }}>{px > 0 ? px.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : '—'}</span>
        {chg != null && <span className={`vd-delta ${chg >= 0 ? 'up' : 'down'}`}>{chg >= 0 ? '+' : '−'}{Math.abs(chg).toFixed(2)}%</span>}
      </div>
      <div style={{ fontSize: 18 }}>SPX</div>
    </div>
  );
}
function WinTile({ trades }) {
  const w = useMemo(() => winRateWindow(trades, nyISODate(), 90), [trades]);
  return (
    <div className="card vd-tile" data-testid="vd-win">
      <Target size={24} />
      <div className="flex items-baseline gap-2 mt-8 flex-wrap">
        <span className="num vd-tile-num" style={{ fontSize: 40, fontWeight: 600 }}>{w.rate != null ? Math.round(w.rate) + '%' : '—'}</span>
        <Delta v={w.change} suffix=" pts" />
      </div>
      <div style={{ fontSize: 16, whiteSpace: 'nowrap' }}>Win rate · 90d</div>
      <div style={{ ...lab, fontSize: 12.5 }}>{w.n} decided trades</div>
    </div>
  );
}
function MonthTile({ trades, decisions }) {
  const a = useMemo(() => monthActivity(trades, decisions, nyISODate(), sessionDateOf), [trades, decisions]);
  const mx = Math.max(1, a.opened, a.closed);
  const row = (label, n, blue) => (
    <div className="mt-3" key={label}>
      <div className="flex justify-between" style={{ fontSize: 13.5, color: 'rgba(255,255,255,0.8)' }}><span>{label}</span><span className="num">{n}</span></div>
      <div className="vd-bar mt-1.5"><span style={{ width: `${n / mx * 100}%`, background: blue ? 'linear-gradient(90deg,#6aa8ff,#3d82f0)' : 'rgba(255,255,255,0.75)' }} /></div>
    </div>
  );
  return (
    <div className="card vd-tile" data-testid="vd-month">
      <Layers size={24} />
      <div style={{ fontSize: 13.5, color: 'rgba(255,255,255,0.72)', marginTop: 10 }}>This month</div>
      {row('Opened', a.opened)}{row('Closed', a.closed)}{row('Won', a.won)}{row('Lost', a.lost, true)}
    </div>
  );
}
function RiskTile({ risk, cap }) {
  const pct = cap > 0 ? Math.min(100, risk / cap * 100) : null;
  return (
    <div className="card vd-tile" data-testid="vd-risk">
      <div style={{ ...lab, fontSize: 13.5 }}>{pct != null ? `${Math.round(pct)}% of the cap` : 'no cap set'}</div>
      <div className="vd-bar mt-2"><span style={{ width: `${pct || 0}%`, background: pct >= 80 ? '#ffa39a' : 'linear-gradient(90deg,#6aa8ff,#3d82f0)' }} /></div>
      <div style={{ flex: 1 }} />
      <div className="num vd-tile-num" style={{ fontSize: 40, fontWeight: 600, letterSpacing: '-0.02em' }}>{fmt$(risk)}</div>
      <div style={{ fontSize: 18 }}>Open risk</div>
      {cap > 0 && <div style={{ ...lab, fontSize: 12.5 }}>of {fmt$(cap)}</div>}
    </div>
  );
}

// ── An open position, as the design's "player" card ──
// Nov 2026: the bars say how the trade is tracking, not just where in time it is.
// 45DTE: one bar per trading day, open → expiry. A day this browser saw a mark for is
// green (up) or red (under water), as tall as the P&L against the exit lines; a day
// without one is drawn in the status colour; days to come are faint. The white bar is
// the 21 DTE manage day, a diamond an event inside the trade. 0DTE: bars across the
// session to the exit, lit in the status colour.
const VTONE = { green: '#7ee2a0', amber: '#ffd479', red: '#ffa39a', grey: 'rgba(255,255,255,0.55)', purple: '#d4b0ff', blue: '#8fc0ff' };
export function tradingDays(startYmd, endYmd) {
  const out = [];
  if (!startYmd || !endYmd) return out;
  const p = y => Date.UTC(+y.slice(0, 4), +y.slice(4, 6) - 1, +y.slice(6, 8));
  for (let t = p(startYmd); t <= p(endYmd) && out.length < 400; t += 864e5) {
    const d = new Date(t), dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`);
  }
  return out;
}
export function dayBars(row, marks, todayYmd) {
  const days = tradingDays(row.startYmd, row.expiry);
  const scale = Math.max(1, Math.abs(row.stop || 0), Math.abs(row.target || 0));
  const status = VTONE[row.tone] || VTONE.grey;
  const evDays = new Set((row.events || []).map(e => String(e.date || '').slice(0, 10).replace(/-/g, '')));
  return days.map(y => {
    const past = y <= todayYmd;
    const mark = y === todayYmd && row.posPnl != null ? row.posPnl : marks[y];
    if (row.closeYmd && y === row.closeYmd && !past) return { y, h: 44, color: '#ffffff', manage: true, event: evDays.has(y) };
    if (!past) return { y, h: 14, color: 'rgba(255,255,255,0.30)', event: evDays.has(y), manage: y === row.closeYmd };
    if (mark == null) return { y, h: 16, color: status, dim: true, event: evDays.has(y), manage: y === row.closeYmd };
    return { y, h: 12 + Math.min(1, Math.abs(mark) / scale) * 32, color: mark >= 0 ? VTONE.green : VTONE.red, mark, event: evDays.has(y), manage: y === row.closeYmd };
  });
}
export function PositionCard({ row, accounts }) {
  const r = row.r;
  const is0 = row.is0;
  const entry = Number(r.avgEntry) || Number(r.entryPrice);
  const todayYmd = tradingSession().yyyymmdd;
  const stCol = VTONE[row.tone] || VTONE.grey;
  const acctCol = accountColor(row.account, accounts);
  const acctName = (accounts || []).find(a => a.id === row.account)?.name || '';
  const fmtD = y => `${Number(y.slice(6, 8))} ${new Date(Date.UTC(+y.slice(0, 4), +y.slice(4, 6) - 1, 1)).toLocaleDateString('en-AU', { month: 'short', timeZone: 'UTC' })}`;
  let bars = [], nowFrac = 0, left = '', mid = '', right = '';
  if (is0) {
    const mm = nyMinutes(new Date()), e = /^(\d{1,2}):(\d{2})/.exec(r.entryTime || '');
    const start = e ? +e[1] * 60 + +e[2] : 570, end = 15 * 60;
    nowFrac = Math.max(0, Math.min(1, (mm - start) / Math.max(1, end - start)));
    const N = 46;
    bars = Array.from({ length: N }, (_, i) => (i / N <= nowFrac ? { h: 18 + (i % 3) * 6, color: stCol } : { h: 14, color: 'rgba(255,255,255,0.30)' }));
    left = `${r.entryTime || '09:30'} open`; mid = mm < end ? `${row.label} · to 15:00` : 'Past the exit time'; right = '15:00 exit';
  } else if (row.expiry && row.startYmd) {
    bars = dayBars(row, marksFor(row.key), todayYmd);
    const done = bars.filter(b => b.y <= todayYmd).length;
    nowFrac = bars.length ? done / bars.length : 0;
    left = `${fmtD(row.startYmd)} open`;
    mid = `${row.dte} DTE · ${row.label.toLowerCase()}`;
    right = `${fmtD(row.expiry)} expiry`;
  }
  const pg = exitProgress(row.posPnl, row.stop, row.target);
  return (
    <section className="card vd-card vd-player" data-testid="vd-position" data-tone={row.tone}>
      <div className="flex items-start gap-4">
        <div className="vd-bubble vd-bubble-lg" style={{ background: BUBBLE[0], cursor: 'default', boxShadow: `0 0 0 3px ${acctCol}` }}>{String(row.underlying || '').slice(0, 4)}</div>
        <div className="flex-1 min-w-0">
          <div className="vd-h" style={{ fontSize: 19, lineHeight: 1.2 }}>{row.strategy}</div>
          <div className="num" style={{ ...lab, fontSize: 13.5, marginTop: 4, color: 'rgba(255,255,255,0.86)' }}>
            {row.strikes.join(' / ')} · {row.qtyOpen} ct · {entry > 0 ? `credit ${entry.toFixed(2)}` : entry < 0 ? `debit ${Math.abs(entry).toFixed(2)}` : 'entry —'}</div>
          {acctName && <div data-testid="vd-position-account" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, color: acctCol, marginTop: 4 }}>
            <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 4, background: acctCol }} />{acctName}</div>}
        </div>
        <span data-testid="vd-position-status" style={{ padding: '4px 11px', borderRadius: 999, background: stCol, color: '#24221f', fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap' }}>{row.label}</span>
      </div>
      <div className="flex items-baseline gap-3 mt-3">
        <span className="num" data-testid="vd-position-pnl" style={{ fontSize: 30, fontWeight: 600, letterSpacing: '-0.02em', color: row.posPnl == null ? '#fff' : row.posPnl >= 0 ? '#7ee2a0' : '#ffa39a' }}>{row.posPnl == null ? '—' : fmtSigned(row.posPnl)}</span>
        <span style={{ fontSize: 13.5, color: 'rgba(255,255,255,0.86)' }}>{pg ? `${Math.round(pg.frac * 100)}% to ${pg.side} ${fmtSigned(pg.side === 'target' ? row.target : row.stop)}` : row.posPnl == null ? 'no live price' : `risk ${fmt$(row.risk)}`}</span>
      </div>
      <div className="vd-wave mt-4" aria-hidden="true" style={{ height: 60 }}>
        {bars.map((b, i) => (
          <span key={i} style={{ position: 'relative', height: b.h, background: b.color, opacity: b.dim ? 0.55 : 1, width: bars.length > 50 ? 3 : 4 }}>
            {b.event && <i style={{ position: 'absolute', left: '50%', top: -14, width: 7, height: 7, marginLeft: -3.5, background: '#ffd479', transform: 'rotate(45deg)' }} />}
          </span>
        ))}
        <span className="vd-wave-now" style={{ left: `${nowFrac * 100}%` }} />
      </div>
      <div className="flex justify-between gap-2 mt-3" style={{ fontSize: 13, color: 'rgba(255,255,255,0.8)', whiteSpace: 'nowrap' }}>
        <span>{left}</span><span style={{ color: '#fff' }}><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: stCol, marginRight: 6 }} />{mid}</span><span>{right}</span>
      </div>
    </section>
  );
}
const fmtSigned = v => (v >= 0 ? '+' : '−') + fmt$(Math.abs(v)).replace('-', '');

export default function VisionDashboard({ authenticated, account, accounts, onAccountsChange, closedTrades, tracker, decisions, config, onTab, onOpenEngine }) {
  const [rows, setRows] = useState([]);
  const [expiries, setExpiries] = useState({});
  useEffect(() => {
    if (!authenticated) return undefined;
    let live = true;
    Promise.resolve().then(() => api.getOpenPositions(account)).then(r => {
      if (!live) return;
      const list = Array.isArray(r) ? r : [];
      setRows(list);
      const todayYmd = tradingSession().yyyymmdd, ex = {};
      for (const p of list) {
        const d = (decisions || []).find(x => (p.timestamp && x.Timestamp === p.timestamp) || Number(x._rowIndex) === Number(p.ticketRef));
        const e = d ? ticketExpiry(d, decisions, { todayYmd }) : null;
        if (e) ex[p.ticketRef] = e;
      }
      setExpiries(ex);
    }).catch(() => {});
    return () => { live = false; };
  }, [authenticated, account, decisions]);
  // The same shared check-up the Open tab runs (cached a minute), for status and P&L.
  const [checks, setChecks] = useState({});
  useEffect(() => {
    if (!authenticated || !rows.length || !Array.isArray(decisions) || !bridgeUrlOf()) return undefined;
    const live0 = rows.filter(r => Number(r.qtyOpen) > 0 && /45|0DTE/i.test(r.engine || ''));
    const tickets = live0.map(r => decisions.find(x => (r.timestamp && x.Timestamp === r.timestamp) || Number(x._rowIndex) === Number(r.ticketRef))).filter(Boolean);
    if (!tickets.length) return undefined;
    let alive = true;
    runCheckup({ tickets, openPositions: rows }).then(res => {
      if (!alive) return;
      const by = {};
      (res.list || []).forEach((x, i) => { if (tickets[i]) by[Number(tickets[i]._rowIndex)] = x; });
      setChecks(by);
    }).catch(() => {});
    return () => { alive = false; };
  }, [authenticated, rows, decisions]);
  const open = rows.filter(r => Number(r.qtyOpen) > 0);
  const board = open.map(r => boardRow(r, { expiry: expiries[r.ticketRef] || null, check: checks[Number(r.ticketRef)] || null }));
  const markSig = board.map(b => `${b.key}:${b.posPnl == null ? '' : Math.round(b.posPnl)}`).join('|');
  useEffect(() => { recordMarks(board, tradingSession().yyyymmdd); }, [markSig]);   // eslint-disable-line react-hooks/exhaustive-deps
  const risk = liveRiskTotal(rows);
  const cap = Number(config?.maxOpenRisk) || 0;
  const bank = Number(config?.currentBankroll) || 0;

  return (
    <div className="vd-grid" data-testid="vision-dashboard">
      <div className="vd-col">
        <WatchingCard onOpenEngine={onOpenEngine} />
        <MonthlyTargetCard account={account} accounts={accounts || []} tracker={tracker} decisions={decisions} onAccountsChange={onAccountsChange} />
      </div>
      <div className="vd-col">
        <PnlCard trades={closedTrades} config={config} bank={bank} />
        <div className="vd-pair">
          <WeekTradesCard trades={closedTrades} />
          <NeedsYouCard rows={rows} expiries={expiries} onReview={() => onTab && onTab('open')} />
        </div>
        <RealisedCard trades={closedTrades} />
      </div>
      <div className="vd-col">
        <section className="card vd-tiles" data-testid="vd-tiles">
          <WinTile trades={closedTrades} />
          <MonthTile trades={closedTrades} decisions={decisions} />
          <SpxTile />
          <RiskTile risk={risk} cap={cap} />
        </section>
        {board.slice(0, 2).map(b => <PositionCard key={b.key} row={b} accounts={accounts || []} />)}
        {!open.length && (
          <section className="card vd-card" data-testid="vd-position-none">
            <h3 className="vd-h">No open positions</h3>
            <p style={{ ...lab, marginTop: 8 }}>Open one from the Decision Engine; it shows here with its time to exit.</p>
          </section>
        )}
      </div>
    </div>
  );
}
