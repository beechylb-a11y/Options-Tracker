// ── Sell / Roll ticket, visual first (Oct 2026) ──
//
// The same conventions as the Dashboard board and the check-up card, so a position
// looks the same wherever it is opened:
//
//   TicketHeader       verdict badge · QQQ 699/709/735/745 Iron Condor 5 ct 20 Nov ·
//                      whole-position P&L (this ticket + what the rolls banked)
//   PnlLadder          one bar of WHOLE-POSITION P&L if everything closed at a price:
//                      stop on the left, entry at $0, the tranche targets as pins, the
//                      most it can make on the right, and a dot for now. Price above
//                      each mark, $ below — the price is what you type into TWS, the $
//                      is what it means.
//   RollBeforeAfter    the strikes now and after the roll on one scale, each with its
//                      profit zone between the break-evens, and price — what the roll
//                      buys on the tested side and gives up on the other.

import React, { useEffect, useRef, useState } from 'react';
import { Hourglass } from 'lucide-react';
import { ActionBadge, C, fmtYmd } from './CheckupVisual';
import { payoffShape } from '../engine/positionPlan';
import { pnlAt } from '../utils/ticketMath';

const money = v => (v == null || !isFinite(v) ? '—' : (v >= 0 ? '+$' : '−$') + Math.abs(Math.round(v)).toLocaleString());

function useWidth(initial = 640) {
  const ref = useRef(null);
  const [w, setW] = useState(initial);
  useEffect(() => {
    if (!ref.current) return undefined;
    const set = () => ref.current && setW(Math.max(260, ref.current.clientWidth));
    set();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(set);
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

const ACTION_LABEL = {
  'take-profit': 'Take profit', hold: 'Hold', watch: 'Watch', 'roll-untested': 'Roll untested side',
  'roll-out': 'Roll out', 'roll-short': 'Roll the short', close: 'Close', 'close-or-roll': 'Close or roll',
};

/** Badge from the check-up, or a plain one saying why there isn't a verdict. */
export function VerdictBadge({ check, fallback }) {
  const rv = check && check.review;
  if (rv && rv.action && rv.action !== 'unknown') return <ActionBadge action={rv.action} tone={rv.tone} label={ACTION_LABEL[rv.action] || rv.action} />;
  const t = fallback || 'Open';
  return (
    <span data-testid="checkup-action" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8,
      fontWeight: 800, fontSize: 13, letterSpacing: '.03em', textTransform: 'uppercase', color: '#a8b2be', background: '#a8b2be1f', border: '1.5px solid #a8b2be' }}>
      {/working/i.test(t) && <Hourglass size={15} />}{t}
    </span>
  );
}

/**
 * @param title     { underlying, strikes:[], strategy, qty, expiry YYYYMMDD }
 * @param posPnl    whole position $ (null when there is no live mark)
 */
export function TicketHeader({ check, fallback, title, sub, posPnl, ticketPnl, banked, onClose, side = 'SELL' }) {
  const head = check && check.review && check.review.action !== 'unknown' ? check.review.headline : null;
  const tone = check && check.review ? ({ green: C.green, amber: C.amber, red: C.red }[check.review.tone] || '#a8b2be') : '#a8b2be';
  return (
    <div data-testid="ticket-header" style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <VerdictBadge check={check} fallback={fallback} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div data-testid="ticket-title" className="mono" style={{ color: '#fff', fontWeight: 800, fontSize: 19, lineHeight: 1.25, display: 'flex', flexWrap: 'wrap', columnGap: 12 }}>
            <span style={{ whiteSpace: 'nowrap' }}>{title.underlying} {(title.strikes || []).join('/')}</span>
            <span style={{ whiteSpace: 'nowrap' }}>{title.strategy}</span>
            <span style={{ whiteSpace: 'nowrap' }}>{title.qty} ct</span>
            {title.expiry && <span style={{ whiteSpace: 'nowrap' }}>{fmtYmd(title.expiry)}</span>}
          </div>
          <div style={{ fontSize: 12, color: C.grey, marginTop: 3 }}>
            <span style={{ color: side === 'SELL' ? C.red : C.amber, fontWeight: 700 }}>{side}</span> · {sub}
          </div>
        </div>
        <div style={{ marginLeft: 'auto', textAlign: 'right', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div data-testid="ticket-pnl">
            <div className="mono" style={{ fontWeight: 800, fontSize: 26, lineHeight: 1, color: posPnl == null ? C.grey : posPnl >= 0 ? C.green : C.red }}>{posPnl == null ? '—' : money(posPnl)}</div>
            <div className="mono" style={{ fontSize: 11, color: C.grey, marginTop: 3, whiteSpace: 'nowrap' }}>
              {posPnl == null ? 'no live mark' : banked ? <>ticket {money(ticketPnl)} + banked <span style={{ color: banked >= 0 ? C.green : C.red }}>{money(banked)}</span></> : 'open P&L'}
            </div>
          </div>
          {onClose && <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', color: '#a8b2be', cursor: 'pointer', fontSize: 20, lineHeight: 1 }}>×</button>}
        </div>
      </div>
      {head && <div data-testid="ticket-headline" style={{ marginTop: 8, color: tone, fontSize: 14, fontWeight: 700 }}>{head}</div>}
    </div>
  );
}

/**
 * Whole-position P&L if every open contract closed at a price.
 * @param pos        normalisePosition() output (ncd, isCredit, maxProfitPerContract)
 * @param targets    [{ label:'T1', price, qty, filled }]
 * @param stopPrice  close price at the stop, or null
 * @param nowPrice   close price now (from the check-up mark), or null
 */
export function PnlLadder({ pos, qtyOpen, banked = 0, targets = [], stopPrice = null, nowPrice = null }) {
  const [ref, w] = useWidth();
  const e = Math.abs(pos.ncd || 0);
  if (!(e > 0) || !(qtyOpen > 0)) return null;
  const side = pos.isCredit ? 'db' : 'cr';
  const P = price => banked + pnlAt(pos, price, qtyOpen);
  // The best close: a credit bought back for nothing; a debit sold at entry + max profit.
  const mpShare = pos.maxProfitPerContract > 0 ? pos.maxProfitPerContract / 100 : e;
  const bestPrice = pos.isCredit ? 0 : e + mpShare;
  const marks = [
    stopPrice != null && { k: 'stop', label: 'STOP', price: stopPrice, col: C.red },
    { k: 'entry', label: 'ENTRY', price: e, col: C.grey },
    ...targets.filter(t => isFinite(t.price)).map(t => ({ k: t.label, label: w < 560 ? t.label : `${t.label} · ${t.qty} ct`, price: t.price, col: C.green, filled: t.filled })),
    { k: 'max', label: 'MAX', price: bestPrice, col: '#2ea043' },
  ].filter(Boolean);
  const xs = [...marks.map(m => P(m.price)), nowPrice != null ? P(nowPrice) : null, 0].filter(v => v != null && isFinite(v));
  const lo = Math.min(...xs), hi = Math.max(...xs);
  const pad = (hi - lo) * 0.06 || 1;
  const L = 14, R = 14;
  const X = v => L + ((v - (lo - pad)) / ((hi + pad) - (lo - pad))) * (w - L - R);
  // Labels go in up to three rows above (price) and below ($): each takes the first
  // row whose last label is far enough left, so close marks never print on each other.
  const gap = w < 560 ? 84 : 120;
  const sorted = [...marks].sort((a, b) => X(P(a.price)) - X(P(b.price)));
  const ends = [-1e9, -1e9, -1e9];
  sorted.forEach(m => {
    const x = X(P(m.price));
    let r = ends.findIndex(e => x - e >= gap);
    if (r < 0) r = ends.indexOf(Math.min(...ends));
    m.row = r; ends[r] = x;
  });
  const rows = Math.max(1, ...marks.map(m => m.row + 1));
  const barY = 24 + rows * 18, H = barY + 18 + rows * 14 + 18;
  // Keep text inside the box: anchor at the edges.
  const anchor = x => (x < 46 ? 'start' : x > w - 60 ? 'end' : 'middle');
  const nowV = nowPrice != null ? P(nowPrice) : null;
  const nowCol = nowV == null ? C.grey : nowV >= 0 ? C.green : C.red;
  return (
    <div ref={ref} data-testid="pnl-ladder" style={{ background: C.bg, border: `1px solid ${C.line}`, borderRadius: 10, padding: '8px 4px 2px', marginBottom: 12 }}>
      <div style={{ fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', color: C.grey, padding: '0 10px' }}>
        If all {qtyOpen} closed at… · whole position{banked ? ', rolls included' : ''}
      </div>
      <svg width={w - 8} height={H} role="img" aria-label="P&L at each closing price">
        <defs>
          <linearGradient id="ladder-g" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor={C.red} />
            <stop offset={`${Math.max(0, Math.min(100, (X(0) - L) / (w - L - R) * 100))}%`} stopColor={C.red} stopOpacity="0.35" />
            <stop offset={`${Math.max(0, Math.min(100, (X(0) - L) / (w - L - R) * 100))}%`} stopColor={C.green} stopOpacity="0.35" />
            <stop offset="100%" stopColor={C.green} />
          </linearGradient>
        </defs>
        <rect x={L} y={barY - 3} width={w - L - R - 8} height={6} rx="3" fill="url(#ladder-g)" />
        <line x1={X(0)} x2={X(0)} y1={barY - 9} y2={barY + 9} stroke={C.text} strokeOpacity="0.5" strokeWidth="1.5" />
        {marks.map(m => {
          const x = X(P(m.price));
          const up = barY - 12 - m.row * 18;
          return (
            <g key={m.k} data-testid={`ladder-${m.k}`}>
              <line x1={x} x2={x} y1={up + 4} y2={barY + 10} stroke={m.col} strokeWidth={m.k === 'entry' ? 1 : 2} strokeDasharray={m.k === 'entry' ? '2 2' : 'none'} />
              {(m.k !== 'entry' && m.k !== 'max') && <circle cx={x} cy={barY} r="4.5" fill={m.filled ? m.col : C.bg} stroke={m.col} strokeWidth="2" />}
              <text x={x} y={up} fontSize="10.5" fontWeight="700" textAnchor={anchor(x)} fill={m.col} fontFamily="JetBrains Mono,monospace">
                {m.label} @{m.price.toFixed(2)}
              </text>
              <text x={x} y={barY + 24 + m.row * 14} fontSize="11.5" fontWeight="800" textAnchor={anchor(x)} fill={m.k === 'entry' ? C.grey : P(m.price) >= 0 ? C.green : C.red}
                fontFamily="JetBrains Mono,monospace">{m.k === 'entry' && !banked ? '$0' : money(P(m.price))}</text>
            </g>
          );
        })}
        {nowV != null && (
          <g data-testid="ladder-now">
            <circle cx={X(nowV)} cy={barY} r="8" fill={nowCol} stroke={C.bg} strokeWidth="2.5" />
            <text x={X(nowV)} y={H - 4} fontSize="11" fontWeight="800" textAnchor={anchor(X(nowV))} fill={nowCol} fontFamily="JetBrains Mono,monospace">
              now @{nowPrice.toFixed(2)} {money(nowV)}
            </text>
          </g>
        )}
      </svg>
      <div style={{ fontSize: 11, color: C.dim, padding: '0 10px 6px' }}>prices are the {side === 'db' ? 'debit to buy it back' : 'credit to sell it'}, per share · $ before commission</div>
    </div>
  );
}

/**
 * The strikes now and after the roll, one scale, with each profit zone and price.
 * @param oldLegs / newLegs  [{ strike, right, qty (signed, per lot) }]
 * @param ncdOld / ncdNew    whole-position entry per share, + credit (rolls included);
 *                           ncdNew null when the roll is not priced yet
 */
export function RollBeforeAfter({ oldLegs, newLegs, spot, ncdOld, ncdNew }) {
  const [ref, w] = useWidth();
  if (!oldLegs || !oldLegs.length) return null;
  const before = ncdOld != null ? payoffShape(oldLegs, ncdOld) : null;
  const after = newLegs && ncdNew != null ? payoffShape(newLegs, ncdNew) : null;
  const ks = [...oldLegs, ...(newLegs || [])].map(l => Number(l.strike));
  const all = [...ks, ...(before ? before.breakevens : []), ...(after ? after.breakevens : []), ...(spot > 0 ? [spot] : [])];
  const lo0 = Math.min(...all), hi0 = Math.max(...all);
  const pad = Math.max((hi0 - lo0) * 0.08, 1);
  const lo = lo0 - pad, hi = hi0 + pad;
  const L = 74, R = 12;
  const X = v => L + ((v - lo) / (hi - lo)) * (w - L - R);
  const rowH = 46, H = rowH * 2 + 26;
  const moved = l => !oldLegs.some(o => Number(o.strike) === Number(l.strike) && o.right === l.right);
  const gone = l => newLegs && !newLegs.some(n => Number(n.strike) === Number(l.strike) && n.right === l.right);
  const Row = ({ y, label, legs, shape, ghostOf }) => (
    <g>
      <text x={8} y={y + 22} fontSize="11.5" fontWeight="800" fill={C.text}>{label}</text>
      {shape && shape.breakevens.length >= 2 && (
        <rect x={X(shape.breakevens[0])} y={y + 10} width={Math.max(1, X(shape.breakevens[shape.breakevens.length - 1]) - X(shape.breakevens[0]))} height={16} rx="3"
          fill="rgba(63,185,80,0.16)" stroke="rgba(63,185,80,0.6)" />
      )}
      <line x1={L} x2={w - R} y1={y + 18} y2={y + 18} stroke={C.line} strokeWidth="2" />
      {shape && shape.breakevens.map((b, i) => (
        <text key={'b' + i} x={X(b)} y={y + 6} fontSize="10" textAnchor="middle" fill={C.green} fontFamily="JetBrains Mono,monospace">{Math.round(b)}</text>
      ))}
      {legs.map((l, i) => {
        const short = l.qty < 0;
        const hl = ghostOf ? ghostOf(l) : false;
        const col = short ? '#f0883e' : '#6e7681';
        return (
          <g key={i} opacity={hl === 'ghost' ? 0.35 : 1}>
            <rect x={X(l.strike) - (short ? 2 : 1.25)} y={y + 6} width={short ? 4 : 2.5} height={24} rx="1" fill={hl === 'new' ? C.amber : col}
              strokeDasharray={hl === 'ghost' ? '2 2' : 'none'} />
            <text x={X(l.strike)} y={y + 42} fontSize="10" textAnchor="middle" fill={hl === 'new' ? C.amber : col} fontFamily="JetBrains Mono,monospace"
              fontWeight={hl === 'new' ? 800 : 400}>{l.strike}{l.right}</text>
          </g>
        );
      })}
    </g>
  );
  const sideMove = (b, a) => (b != null && a != null ? a - b : null);
  const loMove = before && after && before.breakevens.length && after.breakevens.length ? sideMove(before.breakevens[0], after.breakevens[0]) : null;
  const hiMove = before && after && before.breakevens.length && after.breakevens.length
    ? sideMove(before.breakevens[before.breakevens.length - 1], after.breakevens[after.breakevens.length - 1]) : null;
  return (
    <div ref={ref} data-testid="roll-before-after" style={{ background: C.bg, border: `1px solid ${C.line}`, borderRadius: 10, padding: '8px 4px 6px', margin: '12px 0' }}>
      <div style={{ fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', color: C.grey, padding: '0 10px' }}>
        Strikes now → after the roll · green = in profit at expiry, rolls included
      </div>
      <svg width={w - 8} height={H}>
        <Row y={8} label="NOW" legs={oldLegs} shape={before} ghostOf={l => (gone(l) ? 'ghost' : null)} />
        <Row y={8 + rowH} label="AFTER" legs={newLegs || oldLegs} shape={after} ghostOf={l => (newLegs && moved(l) ? 'new' : null)} />
        {spot > 0 && (
          <g>
            <line x1={X(spot)} x2={X(spot)} y1={10} y2={8 + rowH * 2 + 4} stroke={C.text} strokeWidth="1.5" strokeDasharray="3 3" />
            <circle cx={X(spot)} cy={8 + 18} r="5" fill={C.text} stroke={C.bg} strokeWidth="2" />
            <circle cx={X(spot)} cy={8 + rowH + 18} r="5" fill={C.text} stroke={C.bg} strokeWidth="2" />
            <text x={X(spot)} y={H - 2} fontSize="10.5" fontWeight="800" textAnchor="middle" fill={C.text} fontFamily="JetBrains Mono,monospace">{spot}</text>
          </g>
        )}
      </svg>
      <div data-testid="roll-moves" className="mono" style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, padding: '0 10px' }}>
        {!after && <span style={{ color: C.grey }}>change a strike and wait for quotes to see the new break-evens</span>}
        {loMove != null && <span>low break-even <b>{Math.round(before.breakevens[0])} → {Math.round(after.breakevens[0])}</b>{' '}
          <span style={{ color: loMove <= 0 ? C.green : C.red }}>({loMove <= 0 ? 'more' : 'less'} room below, {Math.abs(loMove).toFixed(1)} pts)</span></span>}
        {hiMove != null && <span>high break-even <b>{Math.round(before.breakevens[before.breakevens.length - 1])} → {Math.round(after.breakevens[after.breakevens.length - 1])}</b>{' '}
          <span style={{ color: hiMove >= 0 ? C.green : C.red }}>({hiMove >= 0 ? 'more' : 'less'} room above, {Math.abs(hiMove).toFixed(1)} pts)</span></span>}
      </div>
    </div>
  );
}
