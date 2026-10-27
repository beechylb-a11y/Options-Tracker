// ── Decision Engine, verdict and order card (Oct 2026) ──
//
// The same conventions as the board, the check-up and the Sell ticket:
//
//   VerdictTitle   the verdict as a badge, then the trade on one bold line —
//                  "SPX 7350/7370 Bull put spread 2 ct 27 Oct" — instead of a 30px
//                  ticker and a 30px word with strategy and size on a third line.
//   EdgeRow        the four numbers that decide it, each with ONE name used
//                  everywhere: Expected value · Max-loss chance · Win chance · Kelly size.
//   ExitPlanStrip  the exit, visible before you log: stop → $0 → target(s) → max as one
//                  bar in $ for the contracts on the ticket, and when it is planned to
//                  be gone. It lived in the closed Evidence drawer.
//   MoreMenu       the secondary actions behind ⋯, so Log trade is the one button.

import React, { useState } from 'react';
import { MoreHorizontal, Clock } from 'lucide-react';
import { normalisePosition, targetToPrice, stopToPrice, pnlAt } from '../utils/ticketMath';

const C = { green: '#3fb950', red: '#f85149', amber: '#e3b341', blue: '#58a6ff', grey: '#8b949e', text: '#e6edf3', line: '#30363d', bg: '#0d1117', panel: '#161b22' };
const money = v => (v == null || !isFinite(v) ? '—' : (v >= 0 ? '+$' : '−$') + Math.abs(Math.round(v)).toLocaleString());
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const fmtYmd = y => (y && String(y).length === 8 ? `${+String(y).slice(6, 8)} ${MON[+String(y).slice(4, 6) - 1]}` : '');

/** The names, once. Every label for these numbers in the engine reads from here. */
export const METRIC = { ev: 'Expected value', pml: 'Max-loss chance', pop: 'Win chance', kelly: 'Kelly size', edge: 'Edge score' };

export function VerdictTitle({ word, tone, underlying, strikes = [], strategy, qty, expiry, price }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span data-testid="verdict" style={{ display: 'inline-flex', alignItems: 'center', padding: '6px 12px', borderRadius: 8, fontWeight: 800,
          fontSize: 15, letterSpacing: '.02em', color: tone, background: tone + '1f', border: `1.5px solid ${tone}` }}>{word}</span>
        {price ? <span className="mono" style={{ fontSize: 13, color: C.grey }}>{underlying} @ {price}</span> : null}
      </span>
      <span data-testid="verdict-title" className="mono" style={{ color: '#fff', fontWeight: 800, fontSize: 21, lineHeight: 1.25, display: 'flex', flexWrap: 'wrap', columnGap: 12 }}>
        <span data-testid="verdict-ticker" style={{ whiteSpace: 'nowrap' }}>{underlying}{strikes.length ? ' ' + strikes.join('/') : ''}</span>
        {strategy && <span style={{ whiteSpace: 'nowrap' }}>{strategy}</span>}
        {qty ? <span style={{ whiteSpace: 'nowrap' }}>{qty} ct</span> : null}
        {expiry && <span style={{ whiteSpace: 'nowrap' }}>{fmtYmd(expiry)}</span>}
      </span>
    </div>
  );
}

function Tile({ k, v, sub, col, pct, testid, title }) {
  return (
    <div data-testid={testid} title={title} style={{ flex: '1 1 120px', minWidth: 0, background: 'rgba(0,0,0,0.25)', border: `1px solid ${C.line}`, borderRadius: 10, padding: '8px 10px' }}>
      <div style={{ fontSize: 10.5, letterSpacing: '.07em', textTransform: 'uppercase', color: C.grey }}>{k}</div>
      <div className="mono" style={{ fontSize: 19, fontWeight: 800, color: col || C.text, lineHeight: 1.2 }}>{v}</div>
      {pct != null && (
        <div style={{ height: 4, borderRadius: 2, background: '#21262d', marginTop: 4, overflow: 'hidden' }}>
          <div style={{ width: `${Math.max(2, Math.min(100, pct))}%`, height: '100%', background: col || C.blue }} />
        </div>
      )}
      {sub && <div style={{ fontSize: 11, color: C.grey, marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</div>}
    </div>
  );
}

/**
 * @param ev        $ for the ticket's contracts, null until sized
 * @param pml       0..1, null without greeks
 * @param pop       % (0..100), null until entered
 * @param kellyCt   contracts Kelly sizes; kellyDollar its $
 */
export function EdgeRow({ ev, pml, pop, kellyCt, kellyDollar, needsSizing }) {
  const pmlCol = pml == null ? C.grey : pml <= 0.15 ? C.green : pml <= 0.30 ? C.amber : C.red;
  return (
    <div data-testid="edge-row" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <Tile testid="edge-ev" k={METRIC.ev} v={needsSizing || ev == null ? 'needs sizing' : money(ev)} col={needsSizing || ev == null ? C.amber : ev > 0 ? C.green : C.red}
        sub={needsSizing ? 'enter win, risk, POP' : 'after commission'} />
      <Tile testid="edge-pml" k={METRIC.pml} v={pml == null ? 'no greeks' : `${(pml * 100).toFixed(1)}%`} col={pmlCol} pct={pml == null ? null : pml / 0.4 * 100}
        sub="beyond a wing" />
      <Tile testid="edge-pop" k={METRIC.pop} v={pop == null ? '—' : `${Math.round(pop)}%`} col={pop == null ? C.grey : pop >= 60 ? C.green : pop >= 45 ? C.amber : C.red} pct={pop}
        sub="any profit at expiry" />
      <Tile testid="edge-kelly" k={METRIC.kelly} v={needsSizing ? '—' : !(kellyDollar > 0) ? 'no edge' : `${kellyCt} ct`} col={needsSizing ? C.grey : kellyDollar > 0 ? C.text : '#e3833c'}
        sub={needsSizing ? 'after sizing' : kellyDollar > 0 ? `$${Math.round(kellyDollar).toLocaleString()} of bankroll` : 'Kelly says size 0'} />
    </div>
  );
}

/**
 * The exit plan for the ticket as it would be logged.
 * @param net       signed per share, + credit
 * @param win       max profit per contract ($), 0 if unknown
 * @param plan      { rows:[{qty,pct}], stopPct, basis }  (ProfitTaker's onPlan)
 * @param when      { label, days } — e.g. { label: 'close by 1 Dec (21 DTE)', days: 24 } or the 0DTE exit
 */
export function ExitPlanStrip({ net, win, qty, plan, when, onEdit }) {
  const n = Number(net);
  const q = Math.max(1, Number(qty) || 1);
  if (!isFinite(n) || n === 0) {
    return <div data-testid="exit-plan" style={{ fontSize: 12.5, color: C.grey }}>Exit plan appears once the net credit/debit is in.</div>;
  }
  const pos = normalisePosition({ qty: q, qtyOpen: q, entryPrice: n, maxProfit: win > 0 ? win * q : '', basis: plan && plan.basis });
  const rows = plan && plan.rows && plan.rows.length ? plan.rows.filter(r => Number(r.qty) > 0 && Number(r.pct) > 0) : [];
  const targets = rows.map((r, i) => { const price = targetToPrice(pos, Number(r.pct)); return { label: rows.length > 1 ? `T${i + 1}` : 'Target', pct: Number(r.pct), qty: Number(r.qty), price, gain: pnlAt(pos, price, Number(r.qty)) }; });
  const targetAll = targets.reduce((a, t) => a + t.gain, 0);
  const stopPct = plan && plan.stopPct !== '' && plan.stopPct != null ? Number(plan.stopPct) : null;
  const stopPrice = stopPct > 0 ? stopToPrice(pos, stopPct) : null;
  const stop = stopPrice != null ? pnlAt(pos, stopPrice, q) : null;
  const max = win > 0 ? win * q : Math.abs(n) * 100 * q;
  const lo = Math.min(stop ?? 0, 0), hi = Math.max(max, targetAll, 0);
  const P = v => ((v - lo) / Math.max(1, hi - lo)) * 100;
  const side = pos.isCredit ? 'db' : 'cr';
  return (
    <div data-testid="exit-plan" style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 320px', minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, letterSpacing: '.07em', textTransform: 'uppercase', color: C.grey }}>
          <span>Exit plan · {q} ct</span>
          {onEdit && <button onClick={onEdit} style={{ color: C.blue, fontSize: 11.5, textTransform: 'none', letterSpacing: 0 }}>edit targets & stop</button>}
        </div>
        <div style={{ position: 'relative', height: 20, marginTop: 6 }}>
          <div style={{ position: 'absolute', left: 0, right: 0, top: 7, height: 6, borderRadius: 3,
            background: `linear-gradient(90deg, ${C.red} 0%, ${C.red}55 ${P(0)}%, ${C.green}55 ${P(0)}%, ${C.green} 100%)` }} />
          <div style={{ position: 'absolute', left: `${P(0)}%`, top: 2, width: 2, height: 16, background: C.text, opacity: 0.5, marginLeft: -1 }} />
          {stop != null && <div title={`stop @${stopPrice.toFixed(2)} ${side}`} style={{ position: 'absolute', left: `${P(stop)}%`, top: 3, width: 12, height: 12, marginLeft: -6, borderRadius: '50%', border: `2.5px solid ${C.red}`, background: C.bg }} />}
          {targets.map((t, i) => (
            <div key={i} title={`${t.label} @${t.price.toFixed(2)} ${side}`} style={{ position: 'absolute', left: `${P(t.gain * (q / Math.max(1, t.qty)))}%`, top: 3, width: 12, height: 12, marginLeft: -6, borderRadius: '50%', border: `2.5px solid ${C.green}`, background: C.bg }} />
          ))}
        </div>
        <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11.5, marginTop: 3, flexWrap: 'wrap' }}>
          <span data-testid="exit-stop" style={{ color: C.red }}>{stop != null ? <>stop @{stopPrice.toFixed(2)} {money(stop)}</> : 'no stop'}</span>
          <span data-testid="exit-targets" style={{ color: C.green }}>
            {targets.length ? targets.map(t => `${t.label} @${t.price.toFixed(2)}${targets.length > 1 ? ` ×${t.qty}` : ''}`).join(' · ') + ` = ${money(targetAll)}` : 'no target'}
          </span>
          <span style={{ color: '#2ea043' }}>max {money(max)}</span>
        </div>
      </div>
      {when && (
        <div data-testid="exit-when" style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 'none' }}>
          <TimeRing days={when.days} hours={when.hours} />
          <div style={{ fontSize: 12, color: C.grey, lineHeight: 1.4 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}><Clock size={12} /> {when.label}</div>
            {when.sub && <div style={{ color: C.amber }}>{when.sub}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function TimeRing({ days, hours }) {
  const r = 16, c = 2 * Math.PI * r;
  const val = hours != null ? hours : days;
  const span = hours != null ? 6.5 : 45;
  const used = val == null ? 0 : Math.max(0.04, Math.min(1, 1 - val / span));
  const col = val == null ? C.grey : (hours != null ? val <= 1 : val <= 5) ? C.amber : C.blue;
  return (
    <svg width="44" height="44" viewBox="0 0 44 44">
      <circle cx="22" cy="22" r={r} fill="none" stroke="#21262d" strokeWidth="5" />
      <circle cx="22" cy="22" r={r} fill="none" stroke={col} strokeWidth="5" strokeLinecap="round" strokeDasharray={`${c * used} ${c}`} transform="rotate(-90 22 22)" />
      <text x="22" y="26" textAnchor="middle" fontSize="11.5" fontWeight="800" fill={C.text} fontFamily="JetBrains Mono,monospace">
        {val == null ? '—' : hours != null ? `${val.toFixed(1)}h` : `${days}d`}</text>
    </svg>
  );
}

export function MoreMenu({ items }) {
  const [open, setOpen] = useState(false);
  const list = items.filter(Boolean);
  if (!list.length) return null;
  return (
    <span style={{ position: 'relative' }}>
      <button data-testid="engine-more" onClick={() => setOpen(o => !o)} aria-label="More actions"
        style={{ padding: '8px 10px', borderRadius: 8, border: `1px solid ${C.line}`, color: C.grey, display: 'inline-flex', background: 'transparent' }}>
        <MoreHorizontal size={18} />
      </button>
      {open && (
        <div style={{ position: 'absolute', right: 0, bottom: 44, zIndex: 40, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8,
          minWidth: 190, boxShadow: '0 8px 24px rgba(0,0,0,.5)', overflow: 'hidden' }}>
          {list.map(it => (
            <button key={it.label} data-testid={it.testid} disabled={it.disabled} title={it.title}
              onClick={() => { setOpen(false); it.onClick(); }}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 12px', fontSize: 13, color: it.disabled ? C.grey : (it.color || C.text),
                cursor: it.disabled ? 'not-allowed' : 'pointer', background: 'transparent' }}>{it.label}</button>
          ))}
        </div>
      )}
    </span>
  );
}
