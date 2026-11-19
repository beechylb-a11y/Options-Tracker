import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Target, Layers, Activity, X, ArrowUp, ArrowDown, Plus } from 'lucide-react';
import { api } from '../utils/api';
import { fmt$ } from '../utils/format';
import { nyISODate } from '../utils/stats';
import { closedPnlEvents, journalSummary } from '../utils/benchmark';
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

// ── Monthly target ring ──
function TargetRing({ frac, size = 230, children }) {
  const r = size / 2 - 22, c = 2 * Math.PI * r, cx = size / 2;
  const ticks = Array.from({ length: 60 }, (_, i) => i);
  const a = -Math.PI / 2 + 2 * Math.PI * Math.min(1, Math.max(0, frac));
  return (
    <div className="vd-ring">
      <svg viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <defs><linearGradient id="vd-ring" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#a9cdff" /><stop offset="1" stopColor="#3d82f0" /></linearGradient></defs>
        <circle cx={cx} cy={cx} r={r} fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="10" />
        {frac > 0 && <circle cx={cx} cy={cx} r={r} fill="none" stroke="url(#vd-ring)" strokeWidth="10" strokeLinecap="round"
          strokeDasharray={`${c * Math.min(1, frac)} ${c}`} transform={`rotate(-90 ${cx} ${cx})`} style={{ filter: 'drop-shadow(0 0 8px rgba(106,168,255,0.6))' }} />}
        {ticks.map(i => {
          const t = -Math.PI / 2 + i / 60 * 2 * Math.PI, r1 = r - 20, r2 = r - (i % 5 ? 26 : 30);
          return <line key={i} x1={cx + r1 * Math.cos(t)} y1={cx + r1 * Math.sin(t)} x2={cx + r2 * Math.cos(t)} y2={cx + r2 * Math.sin(t)} stroke="rgba(255,255,255,0.45)" strokeWidth="1.5" />;
        })}
        {frac > 0 && <circle cx={cx + r * Math.cos(a)} cy={cx + r * Math.sin(a)} r="11" fill="#fff" stroke="#3d82f0" strokeWidth="5" />}
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>{children}</div>
    </div>
  );
}
function MonthlyTargetCard({ account, accounts, tracker, decisions }) {
  const [back, setBack] = useState(0);
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
  const s = useMemo(() => journalSummary(account, accounts, closedPnlEvents(tracker, decisions), d.getFullYear(), d.getMonth()),
    [account, accounts, tracker, decisions, back]);   // eslint-disable-line react-hooks/exhaustive-deps
  const m = s.month;
  const frac = m.targetAmt > 0 ? Math.max(0, m.pnl / m.targetAmt) : 0;
  const todayISO = nyISODate();
  const pace = back === 0 ? paceForMonth(m.pnl, m.start, todayISO) : (m.start > 0 ? Math.round(m.pnl / m.start * 1000) / 10 : null);
  const acctLabel = account === 'all' ? 'all accounts' : (accounts.find(a => a.id === account)?.name || account);
  return (
    <section className="card vd-card vd-target" data-testid="vd-target">
      <h3 className="vd-h">Monthly target</h3>
      <div style={lab}>{d.toLocaleDateString('en-AU', { month: 'short', year: 'numeric' })} · {acctLabel} · {+Number(m.targetPct).toFixed(1)}% of bank</div>
      <div className="flex justify-center my-5">
        <TargetRing frac={frac}>
          <span className="num vd-ring-pct" data-testid="vd-target-pct" style={{ fontSize: 52, fontWeight: 600, letterSpacing: '-0.03em', lineHeight: 1 }}>{m.targetAmt > 0 ? Math.round(frac * 100) : '—'}%</span>
          <span style={{ fontSize: 16, marginTop: 4 }}>{frac >= 1 ? 'Achieved' : 'of target'}</span>
          {pace != null && <span style={{ fontSize: 12.5, color: '#a9cdff', marginTop: 2 }}>{back === 0 ? `on pace for ${pace}%` : `made ${pace}%`}</span>}
        </TargetRing>
      </div>
      <div className="flex items-center justify-between">
        <button type="button" className="vd-round" onClick={() => setBack(b => b + 1)} aria-label="Previous month"><ArrowDown size={20} /></button>
        <span style={{ fontSize: 17 }}><b className="num">{fmt$(m.pnl)}</b> <span style={{ color: 'rgba(255,255,255,0.72)' }}>of {fmt$(m.targetAmt)}</span></span>
        <button type="button" className="vd-round" onClick={() => setBack(b => Math.max(0, b - 1))} disabled={back === 0} aria-label="Next month"><ArrowUp size={20} /></button>
      </div>
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
function PositionCard({ r, expiry, accountName }) {
  const is0 = /0dte/i.test(r.engine || '');
  const entry = Number(r.avgEntry) || Number(r.entryPrice);
  const now = new Date();
  let frac = 0, left = '', mid = '', right = '';
  if (is0) {
    const m = nyMinutes(now), e = /^(\d{1,2}):(\d{2})/.exec(r.entryTime || '');
    const start = e ? +e[1] * 60 + +e[2] : 570, end = 15 * 60;
    frac = Math.max(0, Math.min(1, (m - start) / Math.max(1, end - start)));
    left = `${r.entryTime || '09:30'} open`; mid = m < end ? 'On plan · hold' : 'Past the exit time'; right = '15:00 exit';
  } else if (expiry) {
    const ymd = s => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));
    const t0 = new Date(String(r.entryDate).slice(0, 10) + 'T00:00:00Z'), t1 = ymd(expiry);
    frac = Math.max(0, Math.min(1, (now - t0) / Math.max(1, t1 - t0)));
    const dte = Math.round((t1 - now) / 864e5);
    left = `${Number(String(r.entryDate).slice(8, 10))} ${t0.toLocaleDateString('en-AU', { month: 'short', timeZone: 'UTC' })} open`;
    mid = dte <= 21 ? `${dte} DTE · roll or close` : `${dte} DTE · hold`; right = `${Number(expiry.slice(6))} ${t1.toLocaleDateString('en-AU', { month: 'short', timeZone: 'UTC' })} expiry`;
  }
  const N = 46;
  return (
    <section className="card vd-card vd-player" data-testid="vd-position">
      <div className="flex items-start gap-4">
        <div className="vd-bubble vd-bubble-lg" style={{ background: BUBBLE[0], cursor: 'default' }}>{String(r.underlying || '').slice(0, 4)}</div>
        <div className="flex-1 min-w-0">
          <div className="vd-h" style={{ fontSize: 20, lineHeight: 1.2 }}>{r.legs ? `${r.legs} ` : ''}{bareStrategy(r.strategy).toLowerCase()}</div>
          <div style={{ ...lab, fontSize: 13.5, marginTop: 4 }}>{r.engine} · {entry > 0 ? `credit ${entry.toFixed(2)}` : entry < 0 ? `debit ${Math.abs(entry).toFixed(2)}` : 'entry —'} · {r.qtyOpen} ct{accountName ? ` · ${accountName}` : ''}</div>
          <span className="vd-delta mt-2" style={{ background: 'rgba(255,255,255,0.12)' }}>risk {fmt$(Number(r.maxRisk) || 0)}</span>
        </div>
      </div>
      <div className="vd-wave mt-5" aria-hidden="true">
        {Array.from({ length: N }, (_, i) => {
          const h = 14 + Math.abs(Math.sin(i * 1.7 + (Number(r.ticketRef) || 1))) * 30;
          const past = i / N <= frac;
          return <span key={i} style={{ height: h, background: past ? '#6aa8ff' : 'rgba(255,255,255,0.45)' }} />;
        })}
        <span className="vd-wave-now" style={{ left: `${frac * 100}%` }} />
      </div>
      <div className="flex justify-between gap-2 mt-3" style={{ fontSize: 13, color: 'rgba(255,255,255,0.8)', whiteSpace: 'nowrap' }}>
        <span>{left}</span><span><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: '#ffd479', marginRight: 6 }} />{mid}</span><span>{right}</span>
      </div>
    </section>
  );
}

export default function VisionDashboard({ authenticated, account, accounts, closedTrades, tracker, decisions, config, onTab, onOpenEngine }) {
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
  const open = rows.filter(r => Number(r.qtyOpen) > 0);
  const risk = liveRiskTotal(rows);
  const cap = Number(config?.maxOpenRisk) || 0;
  const bank = Number(config?.currentBankroll) || 0;
  const acctName = id => (accounts || []).find(a => a.id === id)?.name || '';

  return (
    <div className="vd-grid" data-testid="vision-dashboard">
      <div className="vd-col">
        <WatchingCard onOpenEngine={onOpenEngine} />
        <MonthlyTargetCard account={account} accounts={accounts} tracker={tracker} decisions={decisions} />
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
        {open.slice(0, 2).map(r => <PositionCard key={r.ticketRef} r={r} expiry={expiries[r.ticketRef] && expiries[r.ticketRef].expiry} accountName={acctName(r.account)} />)}
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
