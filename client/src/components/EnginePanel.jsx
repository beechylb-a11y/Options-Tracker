import React, { useState, useMemo, useEffect, useRef } from 'react';
import ProfitTaker from './ProfitTaker';
import { normalisePosition, planText, savePlan } from '../utils/ticketMath';
import ReactDOM from 'react-dom';
import { calc0DTE } from '../engine/calc0dte';
import { calc45DTE } from '../engine/calc45dte';
import { UNDERLYING_LIST, resolveCashType, exitRuleFor, EXIT_RULES } from '../engine/data';
import { tradingSession, ticketSession, fmtSessionDate } from '../engine/session';
import { DEFAULT_STRIKE_METHOD, DELTA_TARGETS, deltaStrikePlan, bracketStrikes, pickByDelta, shortDeltaSummary } from '../engine/deltaStrikes';
import { listedLadder } from '../engine/listedStrikes';
import { accrualTable, windowShare, sessionsToExpiry } from '../engine/accrual';
import { commissionRate, unitsFromLegs, roundTripCommission } from '../utils/commission';
import { fridaysFrom, timeSpreadDefaults, nearestExpiry, addDaysYmd, nearChoices, farChoices, dteBetween, fmtExpiry, legRole, isoFromYmd } from '../utils/expiries';
import { curveLegs, priceRange, entryNet, curveAt, probProfit, closeDay as closeDayOf, nearDte as nearDteOf, ivAtDte, divYieldOf, simulateExit, RATE, positionValue } from '../engine/payoffCurve';
import { solveBreakevenNet, winRiskAtNet } from '../engine/breakeven';
import PayoffTimeChart from './PayoffTimeChart';
import { computeTrend, trendLabel } from '../engine/trend';

const OUTLOOKS = ['neutral', 'bullish', 'bearish'];
// '' = unknown. Only used when IV Front/Back are absent — with both present the
// engine derives the bias from them and the dropdown is replaced by a readout.
const TERM_BIASES = [{ value: '', label: '— unknown' }, 'contango', 'flat', 'backwardation'];

// ── Fields the TWS auto-fill owns (Aug 2026) ──
// Anything here can arrive from the bridge, so it is also something you can
// override by hand and expect the override to SURVIVE the next pull. Sizing
// fields (bankroll, max loss, win/risk, net credit) are never fed and so are
// deliberately absent: typing one of those is not an override of anything.
const MKT_0 = ['price','high','low','vwap5','vwap5_30','vwapRoll30','vwapRoll30Prior','vwapAccept','em',
  'atr','atr5','atr2h','vix','vix1d','esOvernightHigh','esOvernightLow','esClose',
  'priorDayClose','cashOpen','esEM'];
const MKT_45 = ['price','vix'];
// 45DTE fields Fetch Greeks can fill from the bridge's per-leg model IVs.
// Same override contract as MKT_45: type one by hand and later fetches skip it.
const GREEKS_45 = ['iv','skew'];
// 45DTE vol-surface fields the bridge's /api/vol-surface fills (Oct 2026). Same
// override contract again: type one and later pulls leave it alone.
const VOL_45 = ['iv','ivr','hv','ivFront','ivBack','skew'];

const clockOf = ts => {
  if (!ts) return '';
  const d = new Date(ts);
  return isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-AU', { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
};
const agoOf = (ts, now) => {
  if (!ts) return '';
  const t = new Date(ts).getTime();
  if (!isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? s + 's ago' : s < 3600 ? Math.round(s / 60) + 'm ago' : Math.round(s / 3600) + 'h ago';
};

// ── Composite score ──
// Blends setup quality (market conditions) with sizing metrics (trade edge).
// Each metric normalized to 0-100, then averaged: 40% setup quality + 60% sizing
// (Kelly, Vol, Sharpe, POP, EV). EV is normalised by CAPITAL AT RISK, not
// absolute dollars (Jul 2026): +8% of risk = 100, 0 = 40, −5.3% = 0; falls back
// to the old "$200 = perfect" anchor when no risk base exists. Pure function of
// a calc result so the structure-comparison table scores alternative strategies
// with EXACTLY the formula the banner uses.
function compositeScoreOf(res) {
  const setupNorm = res.setupScore || 0;
  if (res.missingSize) return setupNorm; // only setup quality when no sizing entered
  const kellyNorm = Math.min(100, ((res.adjustedKelly || 0) / 0.25) * 100); // 25% = perfect
  const volNorm = Math.min(100, (res.volFactor || 0) * 100); // 1.0 = perfect
  const sharpeNorm = Math.min(100, (res.sharpeFactor || 0) * 100); // 1.0 = perfect
  const popNorm = Math.min(100, ((res.popMargin || 0) / 2.0) * 100); // 2.0x = perfect
  const evRiskBase = res.evBasis?.maxLoss || 0;
  const evPerRisk = evRiskBase > 0 ? (res.ev || 0) / evRiskBase : 0;
  const evNorm = evRiskBase > 0
    ? Math.max(0, Math.min(100, 40 + (evPerRisk / 0.08) * 60))
    : (res.ev > 0 ? Math.min(100, (res.ev / 200) * 100) : 0); // fallback: old anchor
  const sizingAvg = (kellyNorm + volNorm + sharpeNorm + popNorm + evNorm) / 5;
  return Math.round(setupNorm * 0.40 + sizingAvg * 0.60);
}

// Seed a fresh input bag from a multi-scan row. Only the market fields the scan
// actually resolved are taken; sizing and defaults are left as they are.
function applySeed(base, seed, keys) {
  if (!seed) return base;
  const out = { ...base };
  if (seed.underlying) out.underlying = seed.underlying;
  keys.forEach(k => {
    const v = seed[k];
    if (v != null && v !== '' && v !== 0) out[k] = String(v);
  });
  if (seed.emSource) out.emSource = seed.emSource;
  if (seed.straddleCall) out.straddleCall = String(seed.straddleCall);
  if (seed.straddlePut) out.straddlePut = String(seed.straddlePut);
  return out;
}

// ── Phase-2 strike ladder cache ──
// One ladder fetch (7 strikes × greeks) cached for 60s, keyed by
// (underlying, expiry, right, centerStrike). Module scope so reopening the same
// chip's ladder inside a minute is instant, across re-renders and across tabs.
const LADDER_CACHE = new Map();
const LADDER_TTL_MS = 60000;

// The ladder popover itself: compact mono table of 7 strikes around the leg.
// Pure presentation — the parent owns fetch/loading/error and the strike list.
// The 7 rows render even while loading or after a bridge failure, so a strike
// can still be picked with no greeks at all; only the Δ/θ/γ cells wait for data.
function LadderPopover({ ladder, current, engineStrike, onPick, onRetry, outcomes, isShort }) {
  const fmt = (v, dp, signed) => (v == null || !isFinite(v)) ? '--'
    : (signed && v > 0 ? '+' : '') + v.toFixed(dp);
  // Rows worth pointing at: the most decay, the lowest chance of max loss and the
  // best reward:risk — each tagged once, and only from real numbers.
  const bestOf = (get, better) => {
    let best = null, bestV = null;
    ladder.strikes.forEach(s => {
      const v = get(s);
      if (v == null || !isFinite(v)) return;
      if (bestV == null || better(v, bestV)) { bestV = v; best = s; }
    });
    return best;
  };
  const maxThetaStrike = ladder.rows ? bestOf(s => ladder.rows[s] && ladder.rows[s].theta != null ? Math.abs(ladder.rows[s].theta) : null, (a, b) => a > b) : null;
  const safest = outcomes ? bestOf(s => outcomes[s] ? outcomes[s].pml : null, (a, b) => a < b) : null;
  const bestRR = outcomes ? bestOf(s => outcomes[s] ? outcomes[s].rr : null, (a, b) => a > b) : null;
  const pmlClr = v => v == null ? '#8b949e' : v <= 0.15 ? '#3fb950' : v <= 0.30 ? '#d29922' : '#f85149';
  const cols = { display:'grid', gridTemplateColumns:'54px 46px 50px 60px 54px minmax(64px,auto)', alignItems:'center', columnGap:2 };
  const num = { textAlign:'right', paddingRight:6 };
  const noGreeks = !ladder.loading && !ladder.rows;
  return (
    <div onClick={e => e.stopPropagation()} data-testid="ladder"
      style={{position:'absolute', top:'calc(100% + 6px)', left:0, zIndex:120,
        background:'#161b22', border:'1px solid #30363d', borderRadius:8,
        padding:'8px 6px', minWidth:356, boxShadow:'0 8px 24px rgba(0,0,0,0.55)',
        cursor:'default', fontFamily:'JetBrains Mono,monospace', fontWeight:400}}>
      <div style={{fontSize:12,color:'#c9d1d9',padding:'0 6px 6px',fontFamily:'DM Sans,system-ui,sans-serif',lineHeight:1.4}}>
        Move this {isShort ? 'short' : 'long'} leg — each row re-runs the engine with the leg at that strike.
      </div>
      {ladder.loading && (
        <div style={{fontSize:12,color:'#a8b2be',padding:'0 6px 5px'}}>fetching greeks…</div>
      )}
      {!ladder.loading && ladder.error && (
        <div style={{fontSize:12,color:'#d29922',padding:'0 6px 5px',fontFamily:'DM Sans,system-ui,sans-serif'}}>
          Greeks: {ladder.error} ·{' '}
          <span onClick={onRetry} style={{color:'#58a6ff',textDecoration:'underline',cursor:'pointer'}}>retry</span>
          <span style={{color:'#8b949e'}}> — the outcome columns still work</span>
        </div>
      )}
      <div style={{...cols, fontSize:10.5, color:'#a8b2be', letterSpacing:'0.04em', padding:'0 4px 3px'}}>
        <span>STRIKE</span>
        <span style={num} title="Delta — roughly the chance this strike finishes in the money">Δ</span>
        <span style={num} title="Theta per day for one contract of this strike">θ/day</span>
        <span style={num} title="Chance the whole trade loses its maximum with the leg here">MAX LOSS</span>
        <span style={num} title="Max profit over max loss, priced at the model's fair value for these strikes">R:R</span>
        <span />
      </div>
      {ladder.strikes.map(s => {
        const g = ladder.rows ? ladder.rows[s] : null;
        const o = outcomes ? outcomes[s] : null;
        const isCur = s === current;
        const isEng = engineStrike != null && s === engineStrike;
        const tags = [];
        if (isEng) tags.push(['engine', '#58a6ff']);
        if (s === safest && !isCur) tags.push(['safest', '#3fb950']);
        if (s === bestRR && !isCur) tags.push(['best R:R', '#79c0ff']);
        if (s === maxThetaStrike) tags.push(['max θ', '#3fb950']);
        return (
          <div key={s} onClick={() => onPick(s)} data-testid="ladder-row"
            title={`Set this leg to ${s}` + (g && g.gamma != null ? ` · γ ${fmt(g.gamma, 3)}` : '') + (o && o.fair != null ? ` · fair ${o.fair >= 0 ? 'cr' : 'dr'} ${Math.abs(o.fair).toFixed(2)}` : '')}
            style={{...cols, fontSize:12.5, color:'#c9d1d9', padding:'3px 4px', borderRadius:4,
              cursor:'pointer', background:isCur ? 'rgba(47,129,247,0.16)' : 'transparent'}}>
            <span style={{fontWeight:isCur?700:400, color:isCur?'#fff':'#c9d1d9'}}>{s}</span>
            <span style={num}>{g ? fmt(g.delta, 2, true) : '--'}</span>
            <span style={num}>{g ? fmt(g.theta, 2, false) : '--'}</span>
            <span style={{...num, color: pmlClr(o ? o.pml : null)}}>{o && o.pml != null ? (o.pml * 100).toFixed(1) + '%' : '--'}</span>
            <span style={{...num, color:'#79c0ff'}}>{o && o.rr != null ? o.rr.toFixed(2) : '--'}</span>
            <span style={{fontSize:10.5, display:'flex', gap:4, flexWrap:'wrap', fontFamily:'DM Sans,system-ui,sans-serif'}}>
              {tags.map(([t, c]) => <span key={t} style={{color:c}}>{t}</span>)}
            </span>
          </div>
        );
      })}
      <div style={{marginTop:6, fontSize:11.5, color:'#a8b2be', padding:'0 4px', lineHeight:1.45, fontFamily:'DM Sans,system-ui,sans-serif', maxWidth:340}}>
        {isShort
          ? 'Short legs: closer to price collects more but lifts max-loss chance. Pick the row whose max-loss and R:R you can live with.'
          : 'Wings: further out cheapens protection and widens max loss. Closer in costs more but cuts the tail.'}
        {noGreeks ? '' : ' Δ ≈ chance the strike finishes in the money.'} Click a row to set it.
      </div>
    </div>
  );
}

// ── One banner strike chip (Zone 1b) ──
// Click swaps the chip for a compact mono input of the same footprint. Enter or
// blur commits (the parent rounds to the underlying's increment), Escape cancels,
// ArrowUp/Down steps one increment. An edited chip carries the app's manual-field
// convention: amber border + ✎. onCommit(idx, rawText) is the single seam both
// the inline input and the phase-2 ladder popover call — the chip knows nothing
// about how overrides are stored. The '≡' affordance at the right edge opens the
// ladder (parent-owned data via the ladder* props); the chip body still opens the
// inline input.
function StrikeChip({ leg, idx, engineStrike, step, onCommit, stripLabel, compact, fill, outcomes, expiryTag,
  ladderOpen, ladder, onOpenLadder, onCloseLadder, onRetryLadder }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const escRef = useRef(false); // Escape pressed → the unmount blur must not commit
  const wrapRef = useRef(null); // chip + popover, for the click-outside guard
  const isShort = leg.label.toLowerCase().includes('short');
  const edited = engineStrike != null && leg.strike !== engineStrike;
  const label = stripLabel ? stripLabel(leg.label) : leg.label;
  // Compact, order-ticket form: +751P · −2×754P. The full label is the tooltip.
  const lbl = leg.label.toLowerCase();
  const qtyX = /x2\b/.test(lbl) ? 2 : 1;
  // Words, not letters: "+772 Call", "−2×775 Put". (Oct 2026.)
  const ticketTxt = `${isShort ? '\u2212' : '+'}${qtyX > 1 ? qtyX + '\u00d7' : ''}${leg.strike} ${lbl.includes('call') ? 'Call' : 'Put'}`;

  // Ladder dismissal: Escape or click outside. Listeners exist only while THIS
  // chip's ladder is open (the parent opens one at a time, so at most one pair
  // of document listeners exists app-wide) and are removed on close/unmount.
  useEffect(() => {
    if (!ladderOpen) return;
    const onKey = e => { if (e.key === 'Escape') onCloseLadder && onCloseLadder(); };
    const onDown = e => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) onCloseLadder && onCloseLadder();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [ladderOpen]);

  const box = {
    padding: fill ? (expiryTag ? '6px 10px' : '9px 12px') : compact ? '3px 8px' : '3px 10px', borderRadius:8, fontSize: fill ? 16 : 13, fontWeight:700, whiteSpace:'nowrap',
    overflow:'hidden', textOverflow:'ellipsis',
    ...(fill ? { textAlign:'center', boxSizing:'border-box', width:'100%' } : {}),
    // TWS convention: sell red, buy blue.
    background:isShort?'#8b2025':'#0c2d6b', color:isShort?'#ff7b72':'#79c0ff',
    fontFamily:'JetBrains Mono,monospace',
    border: edited || editing ? '1px solid #d29922' : '1px solid transparent'
  };
  const chip = editing ? (
    <div style={{...box, cursor:'text'}}>
      <input autoFocus type="text" inputMode="decimal" value={text}
        onChange={e=>setText(e.target.value)}
        onKeyDown={e=>{
          if (e.key === 'Enter') { e.preventDefault(); setEditing(false); onCommit(idx, text); }
          else if (e.key === 'Escape') { escRef.current = true; setEditing(false); }
          else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const v = parseFloat(text);
            const base = isFinite(v) ? v : leg.strike;
            setText(String(+(base + (e.key === 'ArrowUp' ? step : -step)).toFixed(2)));
          }
        }}
        onBlur={()=>{ if (escRef.current) { escRef.current = false; return; } setEditing(false); onCommit(idx, text); }}
        style={{width:(String(leg.strike).length + 2) + 'ch', background:'transparent', border:'none',
          outline:'none', color:'inherit', font:'inherit', padding:0}} />
      {!compact && <span style={{fontSize:12,fontWeight:400,opacity:0.8}}> {label}</span>}
    </div>
  ) : (
    <div onClick={()=>{ if (ladderOpen && onCloseLadder) onCloseLadder(); setText(String(leg.strike)); setEditing(true); }}
      title={(compact ? label + ' — ' : '') + (edited ? `Edited by hand — engine suggested ${engineStrike}. Click to change.` : 'Click to edit this strike')}
      style={{...box, cursor:'pointer'}}>
      {/* The expiry sits on its own small line under the strike, so four legs with a
          date each still fit their tiles (it ran past the edge inline). (Oct 2026.) */}
      <div style={{overflow:'hidden',textOverflow:'ellipsis'}}>
        {compact ? ticketTxt : leg.strike}{edited && <span style={{fontSize:11,marginLeft:3,color:'#d29922'}}>✎</span>}{!compact && <> <span style={{fontSize:12,fontWeight:400,opacity:0.8}}>{label}</span></>}
        {onOpenLadder && (
          <span onClick={e=>{ e.stopPropagation(); onOpenLadder(idx); }}
            title="Strike ladder — what moving this leg does to the trade"
            style={{fontSize:12,marginLeft:5,opacity:0.6,cursor:'pointer'}}>≡</span>
        )}
      </div>
      {expiryTag && (
        <div data-testid="leg-expiry" style={{fontSize:11.5,fontWeight:600,opacity:0.8,lineHeight:1.2,marginTop:1,
          overflow:'hidden',textOverflow:'ellipsis'}}>{expiryTag}</div>
      )}
    </div>
  );
  return (
    <div ref={wrapRef} style={fill ? {position:'relative', flex:'1 1 0', minWidth:0} : {position:'relative', display:'inline-block'}}>
      {chip}
      {ladderOpen && ladder && !editing && (
        <LadderPopover ladder={ladder} current={leg.strike} engineStrike={engineStrike} outcomes={outcomes} isShort={isShort}
          onPick={s => { onCommit(idx, String(s)); onCloseLadder && onCloseLadder(); }}
          onRetry={onRetryLadder} />
      )}
    </div>
  );
}

// ── Fly profit band in the market's units (F1, Oct 2026) ──
function FlyBandLine({ band }) {
  const thin = band.pctOfDay != null && band.pctOfDay < 0.30;
  const col = thin ? '#d29922' : '#a8b2be';
  const f = x => (x == null ? '∞' : x.toFixed(x >= 100 ? 0 : 1));
  return (
    <div data-testid="fly-band" data-thin={thin ? '1' : '0'} style={{marginTop:8,fontSize:12.5,color:col,display:'flex',gap:10,flexWrap:'wrap',alignItems:'baseline'}}
      title="The price range where the fly makes money at expiry, measured against the move still to come (the straddle's SD) and against today's whole ±EM.">
      <span style={{fontSize:11,letterSpacing:'0.06em',textTransform:'uppercase',color:'#8b949e'}}>Profit band</span>
      <span className="mono" style={{color:'#e6edf3'}}>{f(band.lo)}–{f(band.hi)}</span>
      {band.halfSD != null && <span>±{band.halfSD.toFixed(1)} SD of the move left (±{band.sdLeft.toFixed(1)})</span>}
      <span><b style={{color: band.pInside >= 0.45 ? '#3fb950' : band.pInside >= 0.30 ? '#e6edf3' : '#f85149'}}>{Math.round(band.pInside * 100)}%</b> to finish inside</span>
      {band.pctOfDay != null && <span>{Math.round(band.pctOfDay * 100)}% of today's ±EM{thin ? ' — thin' : ''}</span>}
      {!band.typed && <span style={{color:'#8b949e'}}>(at model fair price — enter your fill)</span>}
    </div>
  );
}

// ── Vertical strike choices (Oct 2026) ──
// One row, one choice, one spread on the ticket. Replaces the old stack of variant
// cards over two strike rows (VIX pair and VIX1D pair) under an EM/Delta/Both toggle,
// where picking things often changed nothing visible. Each tile says where its strikes
// sit; the chosen one IS the trade — payoff, price map, EV all follow it.
function StrikeChoices({ variants, active, strat, plan, check, emRem, onPick, fetching, deltaDefault }) {
  const isDebit = /Bull call|Bear put/.test(strat || '');
  const spec = (DELTA_TARGETS['0dte'] || {})[strat];
  const tgt = spec ? Object.values(spec.shorts)[0].t : null;
  const shortOf = legs => (legs || []).find(l => /short/i.test(l.label || ''));
  const tip = {
    engine: 'Strikes from the expected move left today by VIX (the full-day EM scaled to the hours left), slid by the pullback buffer.',
    em1d: 'Same rule, from VIX1D — the market\u2019s one-day vol. Usually tighter than VIX on a quiet day, wider on an event day.',
    v1d: isDebit ? 'Whole spread slid toward the money by EM remaining (VIX1D), capped at 40% of its width — break-even comes down through spot; the debit rises.' : 'Short pushed a further EM remaining (VIX1D) out of the money — safer, less credit.',
    vix: isDebit ? 'Whole spread slid toward the money by EM remaining (VIX), capped at 40% of its width.' : 'Short pushed a further EM remaining (VIX) out of the money.',
  };
  const tile = (id, label, strikes, sub, title, disabled) => {
    const on = active === id;
    return (
      <button key={id} data-testid={'strike-choice-' + id} data-on={on ? '1' : '0'} disabled={disabled}
        onClick={() => onPick(id)} title={title}
        style={{textAlign:'left',padding:'6px 10px',borderRadius:8,cursor: disabled ? 'wait' : 'pointer',minWidth:118,
          background: on ? '#0d1a2b' : '#0d1117', border:`1px solid ${on ? '#58a6ff' : '#30363d'}`,
          boxShadow: on ? '0 0 0 1px #58a6ff inset' : 'none'}}>
        <div style={{fontSize:11.5,fontWeight:700,letterSpacing:'0.03em',color: on ? '#58a6ff' : '#a8b2be'}}>{on ? '● ' : ''}{label}</div>
        <div className="mono" style={{fontSize:13.5,fontWeight:700,color:'#e6edf3'}}>{strikes}</div>
        <div className="mono" style={{fontSize:11.5,color:'#8b949e'}}>{sub}</div>
      </button>
    );
  };
  const subOf = v => {
    if (isDebit) return v.rrCeil != null ? `long ${v.intrinsic.toFixed(2)} ITM · ≤${v.rrCeil.toFixed(2)}:1` : `${v.width} wide · long at/above spot`;
    return v.otmEM != null ? `short ${v.otmEM.toFixed(1)}× EM OTM` : '';
  };
  const ds = plan && plan.moves && plan.moves[0];
  return (
    <div data-testid="strike-choices" style={{marginBottom:8}}>
      <div style={{fontSize:11,letterSpacing:'0.06em',textTransform:'uppercase',color:'#8b949e',marginBottom:4}}>
        Strikes — pick one{emRem > 0 ? <span style={{textTransform:'none',letterSpacing:0}}> · EM left today ±{emRem.toFixed(emRem < 10 ? 1 : 0)}</span> : null}
      </div>
      <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
        {variants.map(v => tile(v.id, v.label, v.legs.map(l => l.strike).join(' / '), subOf(v), tip[v.id]))}
        {tgt != null && tile('delta', `Delta · short ${tgt}Δ${deltaDefault ? ' · default' : ''}`,
          plan ? plan.legs.map(l => l.strike).join(' / ') : (check && check.suspended ? 'off — final hour' : 'fetch greeks'),
          ds ? `short ~${ds.estDelta.toFixed(0)}Δ (now ${ds.curDelta.toFixed(0)}Δ)`
            : deltaDefault ? 'goes on with Fetch Greeks' : 'solved from live deltas',
          `Short strike moved to ${tgt}Δ (the market\u2019s own probability, skew included); the wing moves with it so the width stays the same.`,
          fetching || (check && check.suspended))}
      </div>
      {active == null && (
        <div style={{marginTop:4,fontSize:12,color:'#d29922'}}>Strikes edited by hand — none of the choices is on the ticket. Pick one to replace your edits.</div>
      )}
    </div>
  );
}

// ── Strike method + delta cross-check strip (R-49, Oct 2026) ──
// Sits under the strike chips. One line chooses how strikes are built (EM | Delta |
// Both); one line shows each short's live delta against its band and the POP those
// deltas imply; and, when the delta method would place the shorts differently, one
// line shows where — with the button that applies it or goes back to EM.
function DeltaStrip({ strat, check, plan, method, onMethod, builtBy, confirmed, pop, legs,
  onFetch, fetching, onApply, applying, onBack, hideMethod }) {
  const seg = on => ({ padding:'2px 10px', fontSize:12, fontWeight:600, cursor:'pointer',
    border:'1px solid ' + (on ? '#58a6ff' : '#30363d'), background: on ? '#0d1a2b' : '#0d1117',
    color: on ? '#58a6ff' : '#a8b2be' });
  const link = { color:'#58a6ff', textDecoration:'underline', cursor:'pointer' };
  const methods = [['em','EM'], ['delta','Delta']];
  const ip = check.impliedPop != null ? check.impliedPop * 100 : null;
  const gapBad = check.popGap != null && Math.abs(check.popGap) > 10;
  const planStrikes = plan ? plan.legs.map(l => l.strike).join(' / ') : '';
  // The delta alternative shows whenever it differs and isn't already on the ticket.
  const showPlan = !hideMethod && plan && plan.changed && builtBy !== 'Delta';
  // Always on screen, so the control can be found; structures with no delta band say
  // why instead of showing an empty check. (Oct 2026.)
  if (!check.applicable) {
    return (
      <div data-testid="delta-strip" style={{marginTop:8,fontSize:12.5,color:'#8b949e'}}>
        <span style={{fontSize:11,letterSpacing:'0.06em',textTransform:'uppercase'}}>Strikes by</span>{' '}
        <span style={{color:'#a8b2be'}}>EM</span> — the delta check doesn't apply to {strat || 'this structure'}: its
        strikes are placed at the pin or by time, not by probability. Delta strikes cover condors, credit and debit
        verticals, jade lizards and ratio spreads.
      </div>
    );
  }
  return (
    <div data-testid="delta-strip" style={{marginTop:8,display:'flex',flexDirection:'column',gap:5,fontSize:12.5,color:'#a8b2be'}}>
      {!hideMethod && <div style={{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap'}}>
        <span style={{fontSize:11,letterSpacing:'0.06em',textTransform:'uppercase'}}>Strikes by</span>
        <span style={{display:'inline-flex'}}>
          {methods.map(([id, lbl], i) => (
            <button key={id} onClick={() => onMethod(id)} data-testid={'method-' + id}
              title={id === 'em' ? 'Put the engine\u2019s expected-move strikes on the ticket (clears hand edits)'
                : 'Move the short strikes to their target delta (fetches greeks first if needed)'}
              style={{...seg(builtBy === 'Delta' ? id === 'delta' : builtBy === 'EM' ? id === 'em' : false), borderRadius: i === 0 ? '6px 0 0 6px' : '0 6px 6px 0',
                marginLeft: i ? -1 : 0}}>{lbl}</button>
          ))}
        </span>
        <span>on ticket: <span style={{color:'#c9d1d9'}}>{builtBy}</span>
          {builtBy === 'Delta' && <span style={{color: confirmed ? '#3fb950' : '#d29922'}}>{confirmed ? ' ✓ confirmed' : ' · estimated'}</span>}
          {builtBy === 'Manual' && <span style={{color:'#d29922'}}> — hand-edited; EM or Delta replaces your edits</span>}</span>
      </div>}
      <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
        {!check.haveGreeks ? (
          <span>{check.stale ? 'Strikes changed since the last fetch — ' : 'No live deltas yet — '}
            <span onClick={onFetch} style={link}>{fetching ? 'fetching…' : 'fetch greeks'}</span>
            {' '}to check the short strikes{method !== 'em' ? ' and solve delta strikes' : ''}.</span>
        ) : check.suspended ? (
          <span>Delta check off — final hour (0DTE deltas collapse toward zero).</span>
        ) : (<>
          {check.rows.filter((x, i, a) => x.target != null && a.findIndex(y => y.strike === x.strike && y.right === x.right) === i).map(x => (
            <span key={x.strike + x.right} className="mono"
              title={`Band ${x.lo}–${x.hi}Δ, target ${x.target}Δ`}
              style={{padding:'1px 7px',borderRadius:5,background: x.inBand ? '#0d2818' : '#2d1f0a',
                color: x.inBand ? '#3fb950' : '#e3a008'}}>
              {x.strike}{x.right} {x.delta.toFixed(0)}Δ <span style={{opacity:0.7}}>({x.lo}–{x.hi})</span>
            </span>
          ))}
          {ip != null && (
            <span className="mono" style={{color: gapBad ? '#e3a008' : '#a8b2be'}}
              title="POP ≈ 1 − the short deltas (one per side): the chance both shorts expire out of the money">
              POP by delta ~{ip.toFixed(0)}%{pop > 0 ? ` · entered ${pop.toFixed(0)}%` : ''}
              {check.popGap != null ? ` (${check.popGap > 0 ? '+' : ''}${check.popGap.toFixed(0)})` : ''}
            </span>
          )}
        </>)}
      </div>
      {showPlan && (
        <div data-testid="delta-plan" style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap',
          padding:'5px 9px',borderRadius:6,border:'1px solid #21262d',background:'#0d1117'}}>
          <span style={{color:'#c9d1d9',fontWeight:600}}>Delta strikes</span>
          <span className="mono" style={{color:'#c9d1d9'}}>{planStrikes}</span>
          <span>{plan.moves.map(m => `${m.right === 'P' ? 'put' : 'call'} ${m.from}→${m.to} (~${m.estDelta.toFixed(0)}Δ)`).join(' · ')}</span>
          <button onClick={onApply} disabled={applying}
            style={{marginLeft:'auto',padding:'3px 10px',borderRadius:6,fontSize:12,fontWeight:600,cursor:'pointer',
              background:'#1f6feb',color:'#fff',border:'none',opacity: applying ? 0.6 : 1}}>
            {applying ? 'Confirming…' : 'Use delta strikes'}</button>
        </div>
      )}
      {plan && !plan.changed && builtBy !== 'Delta' && check.haveGreeks && (
        <span>The EM strikes already sit at the target delta.</span>
      )}
    </div>
  );
}

export default function EnginePanel({ mode, onLogTrade, accountConfig, strategyHistory, captureStats, seed, initialState, onStateChange, onSummary, toast, onOpenInTab, createdAt }) {
  const is0 = mode === '0dte';
  const acfg = accountConfig || {};
  // Notices go through the parent's toast (top-right, auto-dismiss). Falls back
  // to alert only if no toast prop was wired, so the panel never fails silently.
  const notify = (msg, type) => { if (toast) toast(msg, type || 'error'); else window.alert(msg); };
  const defBankroll = acfg.bankroll || 3000;
  const defMaxLoss = acfg.maxDailyLoss || 300;
  const defMaxOpen = acfg.maxOpenRisk || 450;
  // Commission per contract per side, from the account (Settings). Oct 2026.
  const commRateAcct = commissionRate(acfg);
  const init = initialState || null;
  const [overrideStrat, setOverrideStrat] = useState(init?.overrideStrat ?? null);
  // Whole sessions AFTER today's before the structure expires. 0 = a true 0DTE;
  // 1 = tomorrow's expiry, which is what gets traded late in the session and which
  // the engine otherwise has no way to express. Feeds the accrual table ONLY — every
  // score still runs on today's clock, and the table says so.
  const [expirySessions, setExpirySessions] = useState(init?.expirySessions ?? 0);
  const [autoFilling, setAutoFilling] = useState(false);
  const [dataFresh, setDataFresh] = useState(init?.dataFresh ?? (seed?._meta || null)); // market-data freshness (live vs last close) + when it was pulled
  const [esContract, setEsContract] = useState(init?.esContract ?? ''); // ES front-month label from bridge
  // What time each ES value actually is, from the bridge (Sep 2026). Empty when the
  // bridge fell back to the live snapshot — the labels then say so.
  const [esMeta, setEsMeta] = useState(init?.esMeta ?? null);
  const [fetchingGreeks, setFetchingGreeks] = useState(false);
  const [greeksFresh, setGreeksFresh] = useState(init?.greeksFresh ?? null); // option-feed freshness (real-time/delayed) + asOf
  // Market fields you have typed by hand. Auto-fill will not overwrite these;
  // they render amber with the feed's value alongside so the override is visible.
  const [held, setHeld] = useState(init?.held ?? {});
  // Per-leg strike overrides, keyed by engine bag ('0' | '45') and TAGGED with the
  // structure they were typed against: { '0': { strat, map: { legIndex: strike } } }.
  // The calc ignores a map whose strat tag no longer matches, so switching
  // structures can never restrike the wrong shape. Persisted with the tab state
  // exactly like held / overrideStrat.
  const [overrideStrikes, setOverrideStrikes] = useState(init?.overrideStrikes ?? {});
  // Which vertical variant is being traded: 'engine' | 'v1d' | 'vix'. Persisted with
  // the tab like overrideStrat so a tab reopens on the structure you chose, and read
  // by Log trade and Print summary so the record says which one actually went on.
  const [vertVariant, setVertVariant] = useState(init?.vertVariant ?? 'engine');
  // V1 (Oct 2026): on a vertical, Delta is the default once greeks are in — the shorts
  // move to their target delta on Fetch Greeks unless an EM tile was picked by hand.
  // 'auto' (default) | 'em' (an EM tile was chosen) | 'delta' (the Delta tile was chosen).
  const [vertPick, setVertPick] = useState(init?.vertPick ?? 'auto');
  // Contracts typed on the ticket, per horizon ({ '0': n, '45': n }); unset = Kelly's size.
  const [sizeOv, setSizeOv] = useState(init?.sizeOv ?? {});
  // ── Strike method (R-49, Oct 2026) ──
  // 'em'    — expected-move strikes; deltas are only a cross-check.
  // 'delta' — short strikes placed at their target delta (applied after Fetch Greeks).
  // 'both'  — EM strikes on the ticket, delta strikes alongside to compare or switch to.
  // Defaults: EM for 0DTE (it tracks the time left in the session exactly), Delta for
  // 45DTE (it carries skew and is stable over days). The last choice per engine is
  // remembered in this browser; a tab keeps its own.
  const [strikeMethod, setStrikeMethodState] = useState(() => {
    // 'both' was retired in Oct 2026 — the alternative is always shown beside EM now.
    const fix = m => (m === 'both' ? 'em' : m);
    if (init?.strikeMethod) return { '0': fix(init.strikeMethod['0']), '45': fix(init.strikeMethod['45']) };
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('ot_strike_method')) || {}; } catch (e) { /* private mode */ }
    return { '0': fix(saved['0']) || DEFAULT_STRIKE_METHOD['0dte'], '45': fix(saved['45']) || DEFAULT_STRIKE_METHOD['45dte'] };
  });
  // Per-leg greeks from the last Fetch Greeks: { bag, asOf, rows: [{ strike, right, delta, iv }] }.
  // The delta check matches them to legs by strike, so a strike edited afterwards simply
  // reads as "not fetched" rather than borrowing another strike's delta.
  const [legGreeks, setLegGreeks] = useState(init?.legGreeks ?? null);
  // The strikes the delta method last applied: { bag, strat, map }. Log trade compares the
  // live overrides with it to record which method actually built the ticket.
  const [deltaApplied, setDeltaApplied] = useState(init?.deltaApplied ?? null);
  const [applyingDelta, setApplyingDelta] = useState(false);
  // The last raw bridge pull: what it gave us, what it did not, and when. This is
  // what lets a re-fill say "these three did not come back" instead of quietly
  // leaving stale numbers behind a LIVE badge.
  const [feed, setFeed] = useState(init?.feed ?? null);
  // Last /api/vol-surface pull: expiries used, IVR basis, 25Δ legs, notes. Display only.
  // A 45DTE scan pick carries the trend it read, so the ticket opens with it.
  const [volMeta, setVolMeta] = useState(init?.volMeta ?? (seed && seed._scanMode === '45dte' && seed._trend
    ? { und: seed.underlying, trend: seed._trend, vixTermRatio: seed.vixTermRatio || null, dailySource: seed._dailySource || null } : null));
  const [fetchingVol, setFetchingVol] = useState(false);
  const [justRefreshed, setJustRefreshed] = useState(false);
  const [tick, setTick] = useState(() => Date.now());

  // One slow clock for every relative age on the panel, so "2m ago" is true
  // rather than however old the last keystroke was.
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);
  const [showWhatIf, setShowWhatIf] = useState(false);
  const [showRiskBudget, setShowRiskBudget] = useState(false);
  // Exit plan from the BUY ticket's profit-taker ladder; written into the notes and
  // saved under the log timestamp so the Sell ticket opens with it.
  const [exitPlan, setExitPlan] = useState(null);
  // tastylive long-fly targets (25–50% of MAX PROFIT) instead of the 0DTE default of
  // % return on the debit. One switch shared by the payoff card and the Profit Taker
  // so the two always show the same target. (Oct 2026.)
  const [tastyFly, setTastyFly] = useState(false);
  // Calendar/diagonal close: null = the rule's default (7 DTE on the front leg);
  // the chart and Profit Taker can switch it to 21. Persisted with the tab.
  const [tsClose, setTsClose] = useState(init?.tsClose ?? null);
  // Payoff-curve model of the managed trade (time spreads): POP, avg win, avg loss
  // from simulating target-or-time-stop exits. Fed to the 45DTE engine, which has no
  // TWS POP for a two-expiry trade. (Oct 2026.)
  const [curveModel, setCurveModel] = useState(null);
  // Inline log-note input (replaces the old window.prompt on Log trade).
  const [logNoteOpen, setLogNoteOpen] = useState(false);
  // Set only after the write is CONFIRMED (onLogTrade resolves true). `loggedSig` is a
  // fingerprint of the ticket at that moment — strategy, strikes, size, net — so that
  // editing the ticket afterwards drops the badge and brings the button back rather
  // than leaving "Logged" sitting over a trade that is no longer the one on the sheet.
  const [loggedAt, setLoggedAt] = useState(init?.loggedAt ?? null);
  // Calendar / diagonal expiries chosen on the ticket: { near, far } as YYYYMMDD.
  const [calExp, setCalExp] = useState(init?.calExp ?? null);
  // Listed expiries from the bridge's /api/option-chain, per underlying.
  const [chainExp, setChainExp] = useState(null);
  // Strikes listed for the ticket's 45DTE expiry, calls and puts apart: { key, C, P, err }.
  const [listedChain, setListedChain] = useState(null);
  const [loggedSig, setLoggedSig] = useState(init?.loggedSig ?? null);
  const [logging, setLogging] = useState(false);
  const [logNote, setLogNote] = useState('');
  const [loadingTws, setLoadingTws] = useState(false);
  const [twsStructures, setTwsStructures] = useState(null); // picker list when >1
  const [twsLegs, setTwsLegs] = useState(null); // exact legs from a loaded TWS position

  const [i0, setI0] = useState(() => {
    const base = {
    underlying:'SPX', price:'', high:'', low:'', vwap5:'', vwap5_30:'',
    vwapRoll30:'', vwapRoll30Prior:'', vwapAccept:'',
    em:'', atr5:'', atr2h:'', atr:'',
    vix:'', vix1d:'', ivx:'',
    esOvernightHigh:'', esOvernightLow:'', esClose:'', priorDayClose:'', cashOpen:'', esEM:'',
    win:'', risk:'', pop:'', hours:'', netCreditDebit:'', comboBid:'', comboAsk:'',
    theta:'', delta:'', gamma:'', gamStrike:'',
    lowerWingDelta:'', upperWingDelta:'',
    emSource:'', straddleCall:'', straddlePut:'', straddleHaircut:'1.2533',
    bankroll:defBankroll, startBR:defBankroll, maxLoss:defMaxLoss, maxOpen:defMaxOpen
    };
    if (init?.i0) return { ...base, ...init.i0 };
    return applySeed(base, seed, MKT_0);
  });

  // Auto-calculate hours remaining on mount
  useEffect(() => {
    if (!is0) return;
    // Always overwrite. The old `!i0.hours` guard meant a structure-comparison tab,
    // which is seeded from the ticket it was opened from, kept the hours figure
    // computed when THAT ticket was created — a print made hours later still claimed
    // the original time remaining. Session data is meant to be recomputed per tab.
    const { hoursLeft } = tradingSession();
    if (hoursLeft > 0) setI0(prev => ({ ...prev, hours: hoursLeft }));
  }, [is0]);

  // A multi-scan pick no longer merges into whatever ticket happens to be open —
  // it opens its own tab, and this panel is seeded at mount (see applySeed above).

  const [i45, setI45] = useState(() => {
    const base = {
    underlying:'SPX', price:'', ivr:'', iv:'', hv:'', vix:'', ivx:'',
    ivFront:'', ivBack:'', skew:'', termBias:'', dte:'45',
    outlook:'neutral', pop:'', win:'', risk:'', netCreditDebit:'',
    bankroll:defBankroll, startBR:defBankroll, maxLoss:defMaxLoss, maxOpen:defMaxOpen,
    bpr:'', theta:'', vega:'', delta:'', lowerWingDelta:'', upperWingDelta:''
    };
    if (init?.i45) return { ...base, ...init.i45 };
    // A 45DTE scan also carries the vol surface it pulled; a 0DTE scan never seeds 45DTE vol.
    const out = applySeed(base, seed, seed && seed._scanMode === '45dte' ? [...MKT_45, ...VOL_45] : MKT_45);
    if (seed && seed._scanMode === '45dte' && seed.termBias) out.termBias = seed.termBias;
    if (seed && seed._scanMode === '45dte' && seed.outlook) out.outlook = seed.outlook;
    return out;
  });

  // ── Manual holds ──
  // Typing into a market field marks it held for THIS engine (0DTE and 45DTE keep
  // separate holds — they share field names but not meaning). Held fields survive
  // auto-fill; everything else is genuinely refetched.
  const bag = is0 ? '0' : '45';
  const markHeld = (b, k) => setHeld(h => (h[b + ':' + k] ? h : { ...h, [b + ':' + k]: true }));
  const set0 = (k,v) => { setI0(p => ({...p,[k]:v})); if (MKT_0.includes(k)) markHeld('0', k); };
  // Outlook is held too (Oct 2026): the daily trend sets it on every vol-surface
  // pull until you choose one yourself.
  // Typing POP replaces a model-filled one (popSource 'model' → '').
  const set45 = (k,v) => { setI45(p => ({...p,[k]:v, ...(k === 'pop' ? { popSource: '' } : {}),
    ...(k === 'win' ? { winSource: '' } : {}), ...(k === 'risk' ? { riskSource: '' } : {})})); if (MKT_45.includes(k) || GREEKS_45.includes(k) || VOL_45.includes(k) || k === 'outlook') markHeld('45', k); };
  const fv = (o,k) => parseFloat(o[k]) || 0;

  const isHeld = k => !!held[bag + ':' + k];
  const feedValOf = k => (feed && feed.values ? feed.values[k] : undefined);
  const notFed = k => !!feed && Array.isArray(feed.missing) && feed.missing.indexOf(k) >= 0;
  const heldKeys = Object.keys(held).filter(x => x.indexOf(bag + ':') === 0);
  // Render props for one market input.
  const mk = k => ({ field: k, manual: isHeld(k), feedVal: feedValOf(k), stale: notFed(k) && !isHeld(k) });

  // ── Collapsible input sections ──
  // Collapse state per mode, persisted. Default: everything expanded (an absent
  // key reads as expanded, so a fresh browser shows the full column).
  const [collapsedSections, setCollapsedSections] = useState(() => {
    try { return JSON.parse(localStorage.getItem('ot_engine_sections')) || {}; } catch (e) { return {}; }
  });
  const isCollapsed = id => !!(collapsedSections[mode] && collapsedSections[mode][id]);
  const setSectionCollapsed = (id, val) => setCollapsedSections(prev => {
    const next = { ...prev, [mode]: { ...(prev[mode] || {}), [id]: val } };
    try { localStorage.setItem('ot_engine_sections', JSON.stringify(next)); } catch (e) { /* private mode */ }
    return next;
  });
  const toggleSection = id => setSectionCollapsed(id, !isCollapsed(id));
  const expandSection = id => { if (isCollapsed(id)) setSectionCollapsed(id, false); };

  // Banner zone-4 warning chips: which chip's "why" explanation is expanded (key or null)
  const [expandedWarning, setExpandedWarning] = useState(null);
  // Advisories collapse by default. They were made visible in Aug 2026 after
  // spending months reaching only the Print summary, so nothing is hidden
  // silently: the collapsed row carries the counts, and events are counted
  // separately because they are the ones that are time-critical rather than
  // structural. Blockers never collapse — they stop the trade. (Sep 2026.)
  const [showAdvisories, setShowAdvisories] = useState(false);
  // Evidence drawer (Oct 2026): which tab is open, or null for closed. Closed by
  // default — the verdict, the choices and the Needs-you queue carry the decision.
  const [drawerTab, setDrawerTab] = useState(null);
  // The Needs-you row the cursor is in. A row whose last missing input you are
  // typing would otherwise vanish on the first keystroke (sizing complete →
  // the row is gone), dropping focus to the page, where the next digit hit the
  // 1–9 page shortcuts and opened another page. (Oct 2026.)
  const [needsFocus, setNeedsFocus] = useState(null);
  const lastNeedsRef = useRef({});
  const panelRef = useRef(null);
  const tabShow = id => ({ display: drawerTab === id ? undefined : 'none' });
  // The proposed trade used to scroll away long before the market data you are
  // checking it against, so the two numbers you wanted to compare were never on
  // screen together. A condensed bar takes over once the full block clears the
  // top. HeaderStrip is 48px tall and z-20, so this sits just under it.
  const decisionRef = useRef(null);
  const [ticketStuck, setTicketStuck] = useState(false);
  useEffect(() => {
    const el = decisionRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      ([e]) => setTicketStuck(!e.isIntersecting && e.boundingClientRect.top < 0),
      { rootMargin: '-48px 0px 0px 0px', threshold: 0 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // ── Section completeness ──
  // "Required" mirrors the exact gates behind the banner's incomplete states:
  // calc0dte sets hardBlocker ('Enter underlying price…') when price <= 0 and
  // missingSize → the 'Enter sizing' banner when win/risk/pop <= 0; calc45dte
  // sets hardBlocker ('Enter IV…', hasVol = iv > 0) when iv <= 0 plus the same
  // missingSize gate. Nothing else blanks the banner, so nothing else counts.
  const secBag = is0 ? i0 : i45;
  const missingOf = keys => keys.reduce((n, k) => n + (fv(secBag, k) > 0 ? 0 : 1), 0);
  const secMissing = {
    market: missingOf(['price']),
    vol: is0 ? null : missingOf(['iv']),
    sizing: missingOf(['win', 'risk', 'pop'])
  };

  // Drop every hold on this engine and take the feed's value back where we have
  // one. The escape hatch for "I typed that by mistake" — without it a held field
  // could never return to the feed short of reloading the page.
  function releaseHolds() {
    if (!heldKeys.length) return;
    setHeld(h => { const o = { ...h }; heldKeys.forEach(k => { delete o[k]; }); return o; });
    if (feed && feed.values) {
      const apply = prev => {
        const out = { ...prev };
        heldKeys.forEach(x => {
          const k = x.slice(bag.length + 1);
          if (feed.values[k] !== undefined) out[k] = feed.values[k];
        });
        return out;
      };
      if (is0) setI0(apply); else setI45(apply);
    }
  }

  // Hand the whole candidate up so the parent can label its tab and persist it.
  // Through a ref so an unstable parent callback cannot re-trigger the effect.
  const oscRef = useRef(onStateChange);
  oscRef.current = onStateChange;
  useEffect(() => {
    if (oscRef.current) oscRef.current({ i0, i45, overrideStrat, overrideStrikes, vertVariant, dataFresh, esContract, esMeta, greeksFresh, held, feed, volMeta, loggedAt, loggedSig, strikeMethod, legGreeks, deltaApplied, calExp, tsClose, vertPick, sizeOv });
  }, [i0, i45, overrideStrat, overrideStrikes, vertVariant, dataFresh, esContract, esMeta, greeksFresh, held, feed, volMeta, loggedAt, loggedSig, strikeMethod, legGreeks, deltaApplied, calExp, tsClose, vertPick, sizeOv]);

  // Does the ES overnight block describe the session this ticket is for? The bridge
  // reports its own session date, so prefer comparing the two; without one (snapshot
  // source, or a bridge that predates the field) fall back to the only thing we can
  // know locally — that we are past the close, so the coming session's overnight has
  // not happened yet. (Sep 2026.)
  const overnightStale = (() => {
    const ses = tradingSession();
    if (esMeta && esMeta.session) return esMeta.session !== ses.dateISO;
    return ses.isNextSession;
  })();

  // SPX VWAP fix: if underlying is SPX and values look like SPY, scale x10
  function scaleVWAP(val) {
    const price = fv(i0, 'price');
    const v = parseFloat(val) || 0;
    if (i0.underlying === 'SPX' && price > 1000 && v > 0 && v < price * 0.3) return v * 10;
    return v;
  }
  const vwapScaled = is0 && i0.underlying === 'SPX';
  const vwapFromIWM = is0 && i0.underlying === 'RUT';

  // The 0DTE argument object, built once so the what-if toggle can re-run the whole
  // engine at the OTHER vol estimate without duplicating twenty input mappings.
  const mk0 = (over) => ({
          price:fv(i0,'price'), high:fv(i0,'high'), low:fv(i0,'low'),
          vwap5:scaleVWAP(i0.vwap5), vwap5_30:scaleVWAP(i0.vwap5_30),
          // Rolling windows are prices and scale like the rest. Acceptance is a
          // 0..1 ratio — it must NEVER go through scaleVWAP. Blank = unavailable,
          // which the engine reads as "no acceptance data" rather than "0%".
          vwapRoll30:scaleVWAP(i0.vwapRoll30), vwapRoll30Prior:scaleVWAP(i0.vwapRoll30Prior),
          vwapAccept: i0.vwapAccept === '' || i0.vwapAccept == null ? null : (parseFloat(i0.vwapAccept) || 0),
          atr:fv(i0,'atr'), em:fv(i0,'em'), atr5:fv(i0,'atr5'), atr2h:fv(i0,'atr2h'),
          gamStrike:fv(i0,'gamStrike'), vix:fv(i0,'vix'), vix1d:fv(i0,'vix1d'),
          esOvernightHigh:fv(i0,'esOvernightHigh'), esOvernightLow:fv(i0,'esOvernightLow'),
          esClose:fv(i0,'esClose'), priorDayClose:fv(i0,'priorDayClose'), cashOpen:fv(i0,'cashOpen'), esEM:fv(i0,'esEM'),
          overnightStale,
          bankroll:fv(i0,'bankroll'), startBR:fv(i0,'startBR'),
          risk:fv(i0,'risk'), maxLoss:fv(i0,'maxLoss'), win:fv(i0,'win'),
        netCreditDebit:fv(i0,'netCreditDebit'),
          comboBid: i0.comboBid !== '' ? parseFloat(i0.comboBid) : null,
          comboAsk: i0.comboAsk !== '' ? parseFloat(i0.comboAsk) : null,
          maxOpen:fv(i0,'maxOpen'), pop:fv(i0,'pop'), theta:fv(i0,'theta'),
          delta:fv(i0,'delta'), gamma:fv(i0,'gamma'), hours:fv(i0,'hours'),
          underlying:i0.underlying,
          overrideStrategy: overrideStrat,
          overrideStrikes: overrideStrikes['0']?.map || null,
          overrideStrikesStrat: overrideStrikes['0']?.strat || null,
          vertVariant,
          legGreeks: legGreeks && legGreeks.bag === '0' ? legGreeks.rows : null,
          hoursToBell: tradingSession().hoursToBell,
          historyByStrategy: strategyHistory || null,
          captureByStrategy: captureStats ? captureStats['0DTE'] || null : null,
          wingDeltas: (i0.lowerWingDelta !== '' || i0.upperWingDelta !== '') ? {
            lowerAbsDelta: i0.lowerWingDelta !== '' ? Math.abs(parseFloat(i0.lowerWingDelta)) : null,
            upperAbsDelta: i0.upperWingDelta !== '' ? Math.abs(parseFloat(i0.upperWingDelta)) : null
          } : null,
          emSource: i0.emSource || '',
          straddleCall: i0.straddleCall !== '' ? parseFloat(i0.straddleCall) : null,
          straddlePut: i0.straddlePut !== '' ? parseFloat(i0.straddlePut) : null,
          straddleHaircut: i0.straddleHaircut !== '' ? parseFloat(i0.straddleHaircut) : 1.2533,
          commissionPerContract: commRateAcct,
          contractsOverride: sizeOv['0'] || null,
          ...(over || {})
  });

  // The 45DTE argument object, same shape/purpose as mk0: built once so the
  // structure-comparison table can re-run the engine at a different strategy
  // without duplicating the input mapping.
  const trendNow = volMeta && volMeta.trend && (!volMeta.und || volMeta.und === i45.underlying) ? volMeta.trend : null;
  // Listed strikes only while they are for this underlying (the expiry is checked
  // when they are fetched; a DTE change refetches).
  const listedNow = !is0 && listedChain && listedChain.u === i45.underlying && (listedChain.C || listedChain.P)
    ? { C: listedChain.C || [], P: listedChain.P || [] } : null;
  const mk45 = (over) => ({
          price:fv(i45,'price'), ivr:fv(i45,'ivr'), iv:fv(i45,'iv'),
          hv:fv(i45,'hv'), vix:fv(i45,'vix'), ivFront:fv(i45,'ivFront'),
          ivBack:fv(i45,'ivBack'), skew:fv(i45,'skew'), dte:fv(i45,'dte')||45,
          pop:fv(i45,'pop'), win:fv(i45,'win'), risk:fv(i45,'risk'),
          netCreditDebit:fv(i45,'netCreditDebit'),   // the stop-guide loss prior needs the premium
          bankroll:fv(i45,'bankroll'), startBR:fv(i45,'startBR'),
          maxLoss:fv(i45,'maxLoss'), maxOpen:fv(i45,'maxOpen'), bpr:fv(i45,'bpr'),
          theta:fv(i45,'theta'), vega:fv(i45,'vega'), delta:fv(i45,'delta'),
          underlying:i45.underlying, termBias:i45.termBias, outlook:i45.outlook,
          // the trend read only while it is for this underlying
          trend: trendNow, vixTermRatio: trendNow ? (volMeta.vixTermRatio || null) : null,
          overrideStrategy: overrideStrat,
          overrideStrikes: overrideStrikes['45']?.map || null,
          overrideStrikesStrat: overrideStrikes['45']?.strat || null,
          listedStrikes: listedNow,
          legGreeks: legGreeks && legGreeks.bag === '45' ? legGreeks.rows : null,
          closeDte: tsClose || null,
          curveModel,
          historyByStrategy: strategyHistory || null,
          captureByStrategy: captureStats ? captureStats['45DTE'] || null : null,
          wingDeltas: (i45.lowerWingDelta !== '' || i45.upperWingDelta !== '') ? {
            lowerAbsDelta: i45.lowerWingDelta !== '' ? Math.abs(parseFloat(i45.lowerWingDelta)) : null,
            upperAbsDelta: i45.upperWingDelta !== '' ? Math.abs(parseFloat(i45.upperWingDelta)) : null
          } : null,
          commissionPerContract: commRateAcct,
          contractsOverride: sizeOv['45'] || null,
          ...(over || {})
  });

  const r = useMemo(() => {
    try {
      if (is0) {
        return calc0DTE(mk0());
      } else {
        return calc45DTE(mk45());
      }
    } catch (e) {
      console.error('Calc engine error:', e);
      return { decision:'Error', decisionClass:'nogo', hardBlocker:'Calculation error: ' + e.message,
        setup:'No setup', setupScore:0, criteria:[], ratings:[], legs:[], engineLegs:[], strikeOrderWarning:null, warnings:[], notices:[], blockers:[],
        bestStrat:'', bestRating:'POOR', legStrat:'', kelly:0, rawKelly:0, adjustedKelly:0,
        kellyDollar:0, contracts:1, maxRisk:0, popMargin:0, bePop:0, wlRatio:0, ev:0,
        volFactor:1, sharpeFactor:1, sharpeProxy:0, kellyOverRisk:false, missingSize:true,
        vixGap:0, vixGrade:'', dirScore:0, dirLabel:'', regime:'', behaviour:'',
        comp:null, rmRatio:0, moveConsumed:0, volRemaining:1, payoff:null, greeks:null,
        vwapDistPctEM:0, vwapOverextended:false, confirmed:false, diverges:false,
        slope5:{}, slope:'flat', slopeDirection:'unknown', vwapAccept:null, acceptLabel:'n/a',
        overnightDir:'unknown', trendPattern:'unknown', wingTxt:'',
        targetCredit:null, targetLabel:'', targetLow:0, targetHigh:0, targetMax:0, targetIsCredit:true,
        fairValueScore:0, fairValueGrade:'', volScore:0, volGrade:'', structScore:0, structGrade:'',
        regimeScore:0, regimeGrade:'', ivHvRatio:0,
        vertVariants:null, vertVariant:'engine' };
    }
  }, [is0, i0, i45, overrideStrat, overrideStrikes, vertVariant, strategyHistory, captureStats, commRateAcct, legGreeks, tsClose, trendNow, volMeta, curveModel, listedChain, sizeOv]);

  // What-if vol: re-run the engine on the other vol estimate and show the delta.
  // Which "other" depends on what is driving EM now. Straddle -> the VIX1D model;
  // manual -> the VIX1D model; model-only -> plain VIX (the 30-day number) instead
  // of VIX1D. Nothing here changes the live result; it is a second, parallel run.
  const altVol = useMemo(() => {
    if (!is0 || r.decision === 'Error') return null;
    let over = null, label = '', short = '';
    if (r.emIsStraddle) {
      over = { straddleCall: null, straddlePut: null, emSource: 'vix', em: 0 };
      label = 'the VIX1D model'; short = 'VIX1D';
    } else if (i0.emSource === 'manual') {
      over = { em: 0, emSource: 'vix', straddleCall: null, straddlePut: null };
      label = 'the VIX1D model'; short = 'VIX1D';
    } else if (fv(i0, 'vix') > 0 && fv(i0, 'vix1d') > 0) {
      over = { vix1d: fv(i0, 'vix') };
      label = `VIX ${fv(i0,'vix').toFixed(1)} (30-day) rather than VIX1D`; short = 'VIX 30d';
    }
    if (!over) return null;
    let a;
    try { a = calc0DTE(mk0(over)); } catch (e) { return null; }
    const pct = v => v == null ? '--' : `${(v*100).toFixed(0)}%`;
    const p1  = v => v == null ? '--' : `${(v*100).toFixed(1)}%`;
    const num = v => v == null || !isFinite(v) ? '--' : v.toFixed(1);
    const dol = v => v == null || !isFinite(v) ? '--' : `$${Math.round(v)}`;
    const rows = [
      { k:'EM session',     now:`${num(r.emSession)} pts`, alt:`${num(a.emSession)} pts` },
      { k:'Move consumed',  now:pct(r.moveConsumed),       alt:pct(a.moveConsumed) },
      { k:'Regime',         now:r.regime || '--',          alt:a.regime || '--' },
      { k:'Best strategy',  now:r.bestStrat || '--',       alt:a.bestStrat || '--' },
      { k:'P(max loss)',    now:p1(r.pMaxLoss),            alt:p1(a.pMaxLoss) },
      { k:'EV / contract',  now:dol(r.ev),                 alt:dol(a.ev) },
      { k:'Confidence',     now:num(r.tradeConfidence),    alt:num(a.tradeConfidence) }
    ];
    return { label, short, rows, changed: rows.filter(x => x.now !== x.alt).length };
  }, [is0, i0, r, overrideStrat, strategyHistory, captureStats]);

  // Override: calc engine generates legs for overrideStrat if set
  const isOverride = overrideStrat && overrideStrat !== r.bestStrat;
  const effectiveStrat = r.legStrat || r.bestStrat;

  // ── Per-leg strike editing (Zone 1b chips) ──
  // The strike increment mirrors calc0dte's roundTo; the 45DTE builder rounds
  // every strike to 0.5, so that is its increment.
  const strikeStep = is0
    ? ((i0.underlying === 'SPX' || i0.underlying === 'RUT') ? 5
      : ['SPY', 'QQQ', 'IWM', 'XSP'].includes(i0.underlying) ? 1 : 0.5)
    : (['SPX', 'NDX', 'RUT'].includes(i45.underlying) ? 5
      : ['SPY', 'QQQ', 'IWM', 'XSP', 'DIA'].includes(i45.underlying) ? 1 : 0.5);

  // ── Time spreads: two expiries (Oct 2026) ──
  // A calendar or diagonal is a near (sold) and a far (bought) expiry. The engine
  // only knows strikes, so the dates live here: listed expiries from the bridge's
  // option chain when it has them, weekly Fridays otherwise. The near leg's DTE is
  // the ticket's DTE, so picking it re-scores the trade at that horizon.
  const isTimeSpread = !is0 && /calendar|diagonal/i.test(effectiveStrat || '');
  const todayYmd = tradingSession().yyyymmdd;
  const chainOk = chainExp && chainExp.underlying === i45.underlying && Array.isArray(chainExp.list) && chainExp.list.length;
  const expList = !is0 ? (chainOk ? chainExp.list : fridaysFrom(todayYmd)) : [];
  // 45DTE single-expiry structures trade one listed expiry: the one nearest today + DTE.
  // Picking another sets DTE to it, so the two never disagree.
  const singleExp = (!is0 && !isTimeSpread && expList.length)
    ? nearestExpiry(expList, todayYmd, addDaysYmd(todayYmd, Math.max(1, parseInt(i45.dte, 10) || 45)), 1) : null;
  // The listed strikes of that expiry (Oct 2026): far-dated chains thin out unevenly
  // (QQQ 20 Nov: puts every $1, calls every $5), and the engine fits to them.
  useEffect(() => {
    if (is0 || isTimeSpread || !singleExp) return;
    const key = i45.underlying + '|' + singleExp;
    if (listedChain && listedChain.key === key) return;
    let bridgeUrl = '';
    try { bridgeUrl = localStorage.getItem('bridgeUrl') || ''; } catch (e) { /* private mode */ }
    if (!bridgeUrl) return;
    // the old expiry's strikes must not fit this one while the new ones load
    setListedChain({ key, u: i45.underlying, exp: singleExp, C: null, P: null, err: null, loading: true });
    let live = true;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 35000);
    fetch(bridgeUrl + '/api/listed-strikes?underlying=' + i45.underlying + '&expiry=' + singleExp,
      { headers: { 'ngrok-skip-browser-warning': '1' }, signal: ctrl.signal })
      .then(r => r.text()).then(txt => {
        let d = null; try { d = JSON.parse(txt); } catch (e) { d = null; }
        if (!live) return;
        const ok = d && !d.error && (Array.isArray(d.calls) || Array.isArray(d.puts)) && d.complete !== false;
        setListedChain({ key, u: i45.underlying, exp: singleExp, C: ok ? d.calls || [] : null, P: ok ? d.puts || [] : null,
          err: ok ? null : d && d.complete === false ? `TWS timed out listing strikes (${(d.puts || []).length} puts, ${(d.calls || []).length} calls arrived)`
            : (d && d.error) || 'bridge has no listed-strikes yet — pull and restart it' });
      })
      .catch(() => { if (live) setListedChain({ key, u: i45.underlying, exp: singleExp, C: null, P: null, err: 'bridge not reachable' }); })
      .finally(() => clearTimeout(t));
    return () => { live = false; ctrl.abort(); clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [is0, isTimeSpread, singleExp, i45.underlying]);
  function pickSingle(e) {
    const d = dteBetween(todayYmd, e);
    if (d > 0) setI45(p => ({ ...p, dte: String(d) }));
    markGreeksStale();
  }
  const tsDefault = isTimeSpread ? timeSpreadDefaults(effectiveStrat, i45.dte, expList, todayYmd) : { near: null, far: null };
  const nearExp = isTimeSpread && calExp && calExp.near && expList.includes(calExp.near) && dteBetween(todayYmd, calExp.near) >= 1
    ? calExp.near : tsDefault.near;
  const farExp = !isTimeSpread || !nearExp ? null
    : (calExp && calExp.far && calExp.far > nearExp && expList.includes(calExp.far)) ? calExp.far
    : nearestExpiry(expList.filter(e => e > nearExp), todayYmd,
        addDaysYmd(nearExp, /diagonal/i.test(effectiveStrat || '') ? 42 : 28), 1);
  const legExpiryOf = l => {
    if (!l) return null;
    if (!isTimeSpread) return singleExp;
    const role = legRole(l.label);
    return role === 'near' ? nearExp : role === 'far' ? farExp : null;
  };
  function pickNear(e) {
    const far = farExp && farExp > e ? farExp : null;
    setCalExp({ near: e, far });
    const d = dteBetween(todayYmd, e);
    if (d > 0) setI45(p => ({ ...p, dte: String(d) }));
  }
  function pickFar(e) { setCalExp({ near: nearExp, far: e }); }
  useEffect(() => {
    if (is0) return;
    if (chainExp && chainExp.underlying === i45.underlying) return;
    let bridgeUrl = '';
    try { bridgeUrl = localStorage.getItem('bridgeUrl') || ''; } catch (e) { /* private mode */ }
    if (!bridgeUrl) { setChainExp({ underlying: i45.underlying, list: null, err: 'no bridge' }); return; }
    let live = true;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    fetch(bridgeUrl + '/api/option-chain?underlying=' + i45.underlying, { headers: { 'ngrok-skip-browser-warning': '1' }, signal: ctrl.signal })
      // Read the body as text first: an older bridge without this endpoint (or an
      // ngrok error page) answers with HTML, and JSON.parse on that surfaced as
      // "Unexpected token '<'". Say what actually happened instead. (Oct 2026.)
      .then(async r => {
        const txt = await r.text();
        let d = null;
        try { d = JSON.parse(txt); } catch (e) { d = null; }
        if (!d) {
          const why = r.status === 404 || /Cannot GET/i.test(txt)
            ? 'bridge is an older version — pull and restart it'
            : /ngrok/i.test(txt) ? 'ngrok returned a page instead of the bridge — check the tunnel'
            : `bridge returned a web page (HTTP ${r.status})`;
          throw Object.assign(new Error(why), { friendly: true });
        }
        return d;
      })
      .then(d => { if (live) setChainExp({ underlying: i45.underlying, list: Array.isArray(d.expirations) ? d.expirations : null, err: d.error || null }); })
      .catch(e => { if (live) setChainExp({ underlying: i45.underlying, list: null,
        err: e.name === 'AbortError' ? 'bridge timed out' : e.friendly ? e.message : 'bridge not reachable' }); })
      .finally(() => clearTimeout(t));
    return () => { live = false; ctrl.abort(); clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [is0, i45.underlying]);
  const editedCount = (Array.isArray(r.engineLegs) && r.engineLegs.length === r.legs.length)
    ? r.legs.reduce((n, l, i) => n + (l.strike !== r.engineLegs[i].strike ? 1 : 0), 0)
    : 0;
  // Commit one edited strike (the seam the phase-2 ladder/popover will call too).
  // Invalid input can never produce a NaN leg — it falls back to the engine strike.
  function commitStrike(idx, rawVal) {
    const eng = r.engineLegs?.[idx]?.strike;
    const cur = r.legs?.[idx]?.strike;
    if (eng == null || cur == null) return;
    const v = parseFloat(rawVal);
    const next = (isFinite(v) && v > 0) ? Math.round(v / strikeStep) * strikeStep : eng;
    if (next === cur) return;
    setOverrideStrikes(prev => {
      const keep = (prev[bag] && prev[bag].strat === (r.legStrat || '')) ? { ...prev[bag].map } : {};
      if (next === eng) delete keep[idx]; else keep[idx] = next;
      const out = { ...prev };
      if (Object.keys(keep).length) out[bag] = { strat: r.legStrat || '', map: keep };
      else delete out[bag];
      return out;
    });
    markGreeksStale();
  }
  function resetStrikes() {
    if (!overrideStrikes[bag]) return;
    setOverrideStrikes(prev => { const out = { ...prev }; delete out[bag]; return out; });
    markGreeksStale();
  }
  // A strike change invalidates any greeks already fetched (they priced the OLD
  // legs). Reuse the existing amber "mixed" badge state as the refetch prompt —
  // a successful refetch rebuilds greeksFresh from the response and clears it.
  function markGreeksStale() {
    setGreeksFresh(g => (g && !g.greeksMixed)
      ? { ...g, greeksMixed: true, greekSource: 'edited strikes' } : g);
  }

  // Expiry (YYYYMMDD) for option-greeks calls: 0DTE = today (ET); 45DTE = today
  // + the DTE input. Shared by Fetch Greeks and the strike ladder so the two can
  // never disagree about which expiry they priced.
  function deriveExpiryYYYYMMDD() {
    const ses = tradingSession();
    // 0DTE = the session's own expiry. Run after the close this used to ask for the
    // expiry that had just expired, and the greeks came back off a dead chain.
    if (is0) return ses.yyyymmdd;
    if (isTimeSpread && nearExp) return nearExp;
    // 45DTE single-expiry: the LISTED expiry nearest today + DTE. Today + DTE on its
    // own lands on whatever weekday that is (Oct 7 + 45 = a Saturday), and greeks
    // for an expiry that does not exist come back empty — so Delta never moved the
    // strikes and every card said "no greeks". (Oct 2026.)
    if (singleExp) return singleExp;
    const base = new Date(ses.dateISO + 'T12:00:00');
    const dte = parseInt(i45.dte, 10);
    if (dte > 0) base.setDate(base.getDate() + dte);
    return base.getFullYear().toString()
      + String(base.getMonth() + 1).padStart(2, '0')
      + String(base.getDate()).padStart(2, '0');
  }

  // ── Strike ladder popover (phase 2) ──
  // One ladder open at a time: { idx, right, center, strikes[7, high→low],
  // loading, error, rows: { strike → greeks|null } }. The fetch lives HERE, not
  // in the chip, because underlying/expiry/bridge plumbing is the panel's. A row
  // click goes through commitStrike, so payoff / P(max loss) / EV recompute by
  // the same path a typed strike uses — no extra coupling.
  const [ladder, setLadder] = useState(null);
  const ladderAbortRef = useRef(null);
  useEffect(() => () => { if (ladderAbortRef.current) ladderAbortRef.current.abort(); }, []);
  const closeLadder = () => {
    if (ladderAbortRef.current) { ladderAbortRef.current.abort(); ladderAbortRef.current = null; }
    setLadder(null);
  };
  function toggleLadder(idx, force) {
    if (!force && ladder && ladder.idx === idx) { closeLadder(); return; }
    const leg = r.legs?.[idx];
    if (!leg) return;
    const right = (leg.label || '').toLowerCase().includes('put') ? 'P' : 'C';
    const center = leg.strike;
    let strikes = [];
    for (let k = 3; k >= -3; k--) strikes.push(+(center + k * strikeStep).toFixed(2));
    // 45DTE: the strikes this expiry actually lists for this right.
    const lad = !is0 && listedNow && (listedNow[right] || []).length >= 5 ? listedLadder(listedNow[right], center, 3) : null;
    if (lad && lad.length) strikes = lad;
    const underlying = is0 ? i0.underlying : i45.underlying;
    const expiry = legExpiryOf(leg) || deriveExpiryYYYYMMDD();
    const key = underlying + '|' + expiry + '|' + right + '|' + center;
    const cached = LADDER_CACHE.get(key);
    if (cached && Date.now() - cached.ts < LADDER_TTL_MS) {
      setLadder({ idx, right, center, strikes, loading: false, error: null, rows: cached.rows });
      return;
    }
    let bridgeUrl = '';
    try { bridgeUrl = localStorage.getItem('bridgeUrl') || ''; } catch (e) { /* private mode */ }
    if (!bridgeUrl) {
      setLadder({ idx, right, center, strikes, loading: false, error: 'Bridge URL not set (Settings)', rows: null });
      return;
    }
    setLadder({ idx, right, center, strikes, loading: true, error: null, rows: null });
    fetchLadder(idx, underlying, expiry, right, center, strikes, bridgeUrl, key);
  }
  async function fetchLadder(idx, underlying, expiry, right, center, strikes, bridgeUrl, key) {
    if (ladderAbortRef.current) ladderAbortRef.current.abort();
    const ctrl = new AbortController();
    ladderAbortRef.current = ctrl;
    const t = setTimeout(() => ctrl.abort(), 10000);
    try {
      const legsParam = encodeURIComponent(JSON.stringify(strikes.map(s => ({ strike: s, right, qty: 1 }))));
      const url = bridgeUrl + '/api/option-greeks?underlying=' + underlying
        + '&expiry=' + expiry + '&legs=' + legsParam;
      const resp = await fetch(url, { headers: { 'ngrok-skip-browser-warning': '1' }, signal: ctrl.signal });
      const d = await resp.json();
      if (d.error) throw new Error(d.error);
      const rows = {};
      if (Array.isArray(d.legs)) d.legs.forEach(l => { rows[l.strike] = l.greeks || null; });
      LADDER_CACHE.set(key, { ts: Date.now(), rows });
      setLadder(prev => (prev && prev.idx === idx && prev.center === center)
        ? { ...prev, loading: false, error: null, rows } : prev);
    } catch (e) {
      // Superseded by a newer fetch (its abort landed here) — the newer one owns the state.
      if (ctrl.signal.aborted && ladderAbortRef.current !== ctrl) return;
      setLadder(prev => (prev && prev.idx === idx && prev.center === center)
        ? { ...prev, loading: false, error: (e && e.name === 'AbortError') ? 'bridge timed out' : (e && e.message) || 'bridge unavailable' } : prev);
    } finally {
      clearTimeout(t);
      if (ladderAbortRef.current === ctrl) ladderAbortRef.current = null;
    }
  }
  function retryLadder() { if (ladder) toggleLadder(ladder.idx, true); }

  // What each ladder strike does to THIS trade (Oct 2026). The engine is a pure
  // function, so every row is a full re-run with that one leg moved: chance of max
  // loss, and reward:risk priced at the model's fair value for the new strikes (the
  // ticket's own net belongs to the old ones). Needs no bridge. A moved OUTER wing
  // takes its |delta| from the ladder when the bridge supplied one, otherwise that
  // side falls back to the model, so a stale wing delta never prices a new strike.
  const ladderOutcomes = useMemo(() => {
    if (!ladder || !Array.isArray(ladder.strikes) || r.hardBlocker) return null;
    const idx = ladder.idx;
    const keep = (overrideStrikes[bag] && overrideStrikes[bag].strat === (r.legStrat || '')) ? { ...overrideStrikes[bag].map } : {};
    const out = {};
    ladder.strikes.forEach(s => {
      try {
        const map = { ...keep, [idx]: s };
        const strikesAfter = r.legs.map((l, j) => (j === idx ? s : l.strike));
        const lo = Math.min(...strikesAfter), hi = Math.max(...strikesAfter);
        const g = ladder.rows ? ladder.rows[s] : null;
        const cur = is0 ? i0 : i45;
        let wd = (cur.lowerWingDelta !== '' || cur.upperWingDelta !== '') ? {
          lowerAbsDelta: cur.lowerWingDelta !== '' ? Math.abs(parseFloat(cur.lowerWingDelta)) : null,
          upperAbsDelta: cur.upperWingDelta !== '' ? Math.abs(parseFloat(cur.upperWingDelta)) : null } : null;
        if (wd && s === lo) wd = { ...wd, lowerAbsDelta: g && g.delta != null ? Math.abs(g.delta) : null };
        if (wd && s === hi) wd = { ...wd, upperAbsDelta: g && g.delta != null ? Math.abs(g.delta) : null };
        const over = { overrideStrikes: map, overrideStrikesStrat: r.legStrat || '', wingDeltas: wd };
        const res = is0 ? calc0DTE(mk0(over)) : calc45DTE(mk45(over));
        const fair = res.priceCheck && isFinite(res.priceCheck.fair) ? -res.priceCheck.fair : null;
        const pay = fair != null ? legsPayoff(res.legs, fair) : null;
        const rr = pay && pay.maxProfit > 0 && pay.maxLoss < 0 ? pay.maxProfit / Math.abs(pay.maxLoss) : null;
        out[s] = { pml: res.pMaxLoss != null ? res.pMaxLoss : null, rr, fair };
      } catch (e) { out[s] = null; }
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ladder, is0, i0, i45, overrideStrat, overrideStrikes, r.legStrat, commRateAcct]);

  // ── Net credit/debit pre-fills from the engine's TARGET for the structure in
  // front of you. A fresh ticket -- and every structure opened in its own tab --
  // is therefore scoreable immediately instead of showing nothing until you have
  // typed a number you do not have yet.
  //
  // It is a TARGET, not a fill. That distinction now matters more than it used to:
  // the debit is written to the Decisions log (column AH), so an untouched target
  // left in the box would be recorded as if it were a real price. The chip beside
  // the label says which one you are looking at and disappears the instant the
  // value differs from what was auto-filled.
  //
  // Fills once per (engine, structure). Clearing the box by hand keeps it clear --
  // the ref remembers the key, not the emptiness. (Aug 2026.)
  const netAutoRef = useRef({ key: null, value: '' });
  const netKey = bag + '|' + (effectiveStrat || '');
  const netTarget = (r && r.targetCredit != null && isFinite(r.targetCredit)) ? r.targetCredit : null;
  useEffect(() => {
    if (netTarget == null) return;
    if (netAutoRef.current.key === netKey) return;
    const cur = is0 ? i0.netCreditDebit : i45.netCreditDebit;
    if (cur !== '' && cur != null) { netAutoRef.current = { key: netKey, value: '' }; return; }
    const v = netTarget.toFixed(2);
    netAutoRef.current = { key: netKey, value: v };
    if (is0) setI0(p => ({ ...p, netCreditDebit: v }));
    else setI45(p => ({ ...p, netCreditDebit: v }));
  }, [netKey, netTarget]);
  const netCur = is0 ? i0.netCreditDebit : i45.netCreditDebit;
  const netIsTarget = netCur !== '' && netCur != null && netAutoRef.current.value === netCur;

  // ── Structure comparison opens its pick in a new tab.
  // Session & sizing is the one block that does NOT travel: max profit, max loss,
  // POP and the fill you got all describe the legs in front of you, so carrying
  // them into a different structure would score the new one on the old one's
  // numbers. Hours re-derives itself on mount, and net credit/debit re-fills from
  // the new structure's own target. Everything else -- market data, vol, ES,
  // greeks, which fields you typed by hand, feed provenance -- is a property of
  // the session, and comes across untouched. (Aug 2026.)
  const SIZING_KEYS = ['win', 'risk', 'pop', 'hours', 'netCreditDebit'];
  function openStructureInTab(name) {
    const nextOverride = name === r.bestStrat ? null : name;
    if (!onOpenInTab) { setOverrideStrat(nextOverride); return; }   // fallback: old in-place behaviour
    const strip = o => {
      const c = { ...o };
      SIZING_KEYS.forEach(k => { if (k in c) c[k] = ''; });
      return c;
    };
    onOpenInTab({
      i0: strip(i0), i45: strip(i45),
      overrideStrat: nextOverride,
      dataFresh, esContract, esMeta, greeksFresh, held, feed, expirySessions
    }, mode, name);
    if (toast) toast(name + ' opened in a new tab \u2014 re-enter win/risk/POP from your broker preview');
  }
  const ticketNet = is0 ? i0.netCreditDebit : i45.netCreditDebit;
  const cashType = resolveCashType(effectiveStrat, ticketNet); // 'credit' | 'debit' | 'varies'
  const effectiveRating = isOverride ? (r.ratings.find(s => s.name === overrideStrat)?.rating || 'MARGINAL') : r.bestRating;
  // ── Composite banner score ── (formula extracted to compositeScoreOf, module
  // scope, so the structure-comparison table scores alternatives identically)
  const missingInputs = r.missingSize;
  const hasBlocker = !!r.hardBlocker;
  const compositeScore = compositeScoreOf(r);

  // ── Structure comparison ──
  // The calc engines are pure functions of their inputs (no fetches, no clocks,
  // no module state), so alternative structures can be scored by re-running the
  // SAME inputs with a different overrideStrategy. Current selection first,
  // then the next-best rated strategies — 3 columns total. Cost: two extra
  // engine runs, memoized on the same deps as the live result (the engine
  // already runs on every keystroke, so 3× is fine).
  const stratCompare = useMemo(() => {
    if (r.decision === 'Error' || !Array.isArray(r.ratings) || r.ratings.length < 2) return null;
    const cur = r.legStrat || r.bestStrat;
    if (!cur) return null;
    const names = [cur];
    for (const s of r.ratings) {
      if (names.length >= 3) break;
      if (!names.includes(s.name)) names.push(s.name);
    }
    return names.map(name => {
      const rating = r.ratings.find(s => s.name === name)?.rating || '';
      if (name === cur) return { name, rating, res: r, current: true };
      try {
        const res = is0 ? calc0DTE(mk0({ overrideStrategy: name }))
                        : calc45DTE(mk45({ overrideStrategy: name }));
        return res ? { name, rating, res, current: false } : null;
      } catch (e) { return null; }
    }).filter(Boolean);
  }, [is0, i0, i45, r, overrideStrat, strategyHistory, captureStats]);

  let bannerTitle, bannerGrade;
  if (hasBlocker) {
    bannerTitle = r.hardBlocker;
    bannerGrade = 'weak';
  } else if (compositeScore >= 75) {
    bannerTitle = 'Strong setup';
    bannerGrade = 'strong';
  } else if (compositeScore >= 55) {
    bannerTitle = 'Decent setup';
    bannerGrade = 'decent';
  } else if (compositeScore >= 35) {
    bannerTitle = 'Marginal setup';
    bannerGrade = 'marginal';
  } else {
    bannerTitle = 'Weak setup';
    bannerGrade = 'weak';
  }
  if (missingInputs && !hasBlocker) bannerTitle = 'Enter sizing';
  if (isOverride && bannerGrade !== 'weak') bannerTitle += ' (override)';

  const effectiveDecision = bannerTitle;

  // Banner zone-3 thesis: skewNote trimmed to a clause (trailing period stripped,
  // leading char lowercased unless it starts an acronym/ticker). Empty → omitted.
  const skewClause = (() => {
    const s = (r.skewNote || '').trim().replace(/\.\s*$/, '');
    if (!s) return '';
    return /^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
  })();

  const dcBg = bannerGrade==='strong'?'#0d1f0d':bannerGrade==='decent'?'#0d1a0d':bannerGrade==='marginal'?'#1f1a0d':'#1f0d0d';
  const dcBorder = bannerGrade==='strong'?'#238636':bannerGrade==='decent'?'#4d8c2a':bannerGrade==='marginal'?'#9e6a03':'#da3633';
  const dcColor = bannerGrade==='strong'?'#3fb950':bannerGrade==='decent'?'#7bc74d':bannerGrade==='marginal'?'#d29922':'#f85149';
  const sBg = r.setupScore>=85?'#0d1f0d':r.setupScore>=70?'#0d1a2e':r.setupScore>=50?'#1f1a0d':'#1f0d0d';
  const sClr = r.setupScore>=85?'#3fb950':r.setupScore>=70?'#2f81f7':r.setupScore>=50?'#d29922':'#f85149';
  // ── Trade Confidence colours (gated metric from the engine) ──
  // A one-line verdict for the parent, so the tab strip can rank tickets without
  // reaching into the panel's state or recomputing the engine a second time.
  // Deliberately separate from onStateChange above: that payload is persisted to
  // localStorage and describes INPUTS, while this is derived and disposable.
  //
  // `ready` is the honest test for "has this ticket got enough to be compared" —
  // tradeConfidence is null exactly when sizing inputs are missing, which is the
  // engine's own answer to the same question.
  const sumRef = useRef(onSummary);
  sumRef.current = onSummary;
  // Only what the strip actually uses. Carrying spare fields here means the parent's
  // change-guard has to know about every one of them or quietly serve stale numbers.
  const confidence = r && r.tradeConfidence != null ? r.tradeConfidence : null;
  const confTier = r ? r.confidenceTier : '--';
  const isBlocked = !!(r && r.blockers && r.blockers.length);
  // Tabs rank on the COMPOSITE (Sep 2026) — the same number and the same colour
  // band as the banner — so the strip reads exactly like the tickets behind it.
  // Confidence still travels for the tooltip.
  useEffect(() => {
    if (!sumRef.current) return;
    sumRef.current({ confidence, tier: confTier, ready: confidence != null, blocked: isBlocked,
      composite: compositeScore, grade: bannerGrade, bg: dcBg, border: dcBorder, color: dcColor });
  }, [confidence, confTier, isBlocked, compositeScore, bannerGrade, dcBg, dcBorder, dcColor]);

  // ── When the value arrives ──────────────────────────────────────────────
  // A pin structure is a terminal-value trade: it converges on its payoff only as
  // the distribution of expiry prices collapses onto the body. Held 11:35 → 15:35 on
  // the session before expiry, the SPY 759/763/768 fly of 29 Sep collected about a
  // tenth of that — and the whole of that fact was computable at entry. (Sep 2026.)
  const accrual = useMemo(() => {
    if (!is0 || !r.payoff || !Array.isArray(r.payoff.legs) || r.payoff.legs.length < 3) return null;
    const spot = fv(i0, 'price');
    const em = r.emSession > 0 ? r.emSession : fv(i0, 'em');
    if (!(spot > 0) || !(em > 0)) return null;
    // payoff.legs carries side/qty, not a signed ratio. qty only ever detects "x2"
    // from the label, so a 1.5x wing arrives here as 1 — the same blind spot that let
    // a 1.5x print stand against a 1/-2/+1 fill. Worth knowing when reading this.
    const legs = r.payoff.legs.map(l => ({
      strike: l.strike,
      right: l.type === 'put' ? 'P' : 'C',
      ratio: (l.side === 'sell' ? -1 : 1) * (l.qty || 1),
    }));
    const ses = tradingSession();
    const sessionsLeft = sessionsToExpiry(ses.hoursToBell, expirySessions);
    if (!(sessionsLeft > 0)) return null;
    const table = accrualTable({ legs, spot, em, sessionsLeft });
    if (!table) return null;
    // What closing at the working close of TODAY would capture — the plan most
    // likely to be run by default, and the one worth pricing before it is run.
    // What closing at the 15:00 working close would capture — the plan most likely
    // to be run by default, and the one worth pricing before it is run.
    //
    // `hoursToBell - 1` was wrong and badly so: it is hours remaining ONE HOUR FROM
    // NOW, not hours remaining AT 15:00. On the 30 Sep SPY ticket, printed 11:49, it
    // priced an exit at 12:49 and reported 7% where holding to 15:00 was worth 39% —
    // then labelled it "leaves most of the value on the table". At 15:00 there is
    // exactly one hour left to the bell, whatever time it is now. (Oct 2026.)
    const outToday = ses.hoursToBell > 1.1 ? windowShare({ legs, spot, em, sessionsLeft,
      exitSessionsLeft: sessionsToExpiry(1, expirySessions) }) : null;
    return { ...table, sessionsLeft, outToday, legs };
  }, [is0, r.payoff, r.emSession, i0.price, i0.em, expirySessions]);

  // ── Verdict band, Needs-you queue, drawer tabs and log gate (Oct 2026) ──
  // One plain-language verdict replaces the four competing 0-100 readouts at the
  // top of the ticket. Order matters: anything that stops the trade outranks the
  // composite, so the headline can never say "take it" over a blocker.
  const blockers = r.blockers || [];
  const verdict = hasBlocker ? { word: 'Can’t build this ticket yet', tone: 'warn',
      sub: 'The engine needs one more input before it can place strikes.' }
    : blockers.length ? { word: blockers.length > 1 ? `Blocked · ${blockers.length} issues` : 'Blocked', tone: 'bad' }
    : missingInputs ? { word: 'Waiting on sizing', tone: 'warn' }
    // A setup can score well and still lose money at the price on the ticket. EV
    // after commission is the last word on whether to enter at this fill.
    : !(r.ev > 0) ? { word: 'Pass at this price', tone: 'pass' }
    : bannerGrade === 'strong' ? { word: 'Take the trade', tone: 'grade' }
    : bannerGrade === 'decent' ? { word: 'Take the trade', tone: 'grade' }
    : bannerGrade === 'marginal' ? { word: 'Take it smaller, or pass', tone: 'grade' }
    : { word: 'Pass on this one', tone: 'grade' };
  const vTone = verdict.tone === 'pass'
    ? { color: '#e3833c', bg: 'linear-gradient(180deg,#24160c 0%,#170f0a 100%)', border: '#9a4f1c' }
    : verdict.tone === 'bad'
    ? { color: '#f85149', bg: 'linear-gradient(180deg,#2a1012 0%,#1b0d0f 100%)', border: '#da3633' }
    : verdict.tone === 'warn'
      ? { color: '#d29922', bg: 'linear-gradient(180deg,#1f1a0d 0%,#16130b 100%)', border: '#9e6a03' }
      : { color: dcColor, bg: `linear-gradient(180deg,${dcBg} 0%,#0d1117 140%)`, border: dcBorder };

  // Needs you: only things a person has to act on, each carrying its own control.
  const session = tradingSession();
  const sessionOpen = session.phase === 'open' || session.phase === 'closing hour';
  const feedMissing = (feed && Array.isArray(feed.missing)) ? feed.missing.filter(k => !isHeld(k)) : [];
  const heldConflicts = heldKeys.map(x => x.slice(bag.length + 1)).filter(k => {
    const fed = feedValOf(k);
    if (fed === undefined || fed === null || fed === '') return false;
    const a = parseFloat(fed), b = parseFloat(secBag[k]);
    return isFinite(a) && isFinite(b) ? Math.abs(a - b) > 1e-9 : String(fed) !== String(secBag[k]);
  });
  const greeksAgeMin = greeksFresh && greeksFresh.asOf
    ? Math.max(0, Math.round((tick - new Date(greeksFresh.asOf).getTime()) / 60000)) : null;
  const splitMsg = s => {
    const k = String(s).indexOf(' — ');
    return k > 0 ? [s.slice(0, k), s.slice(k + 3)] : [s, ''];
  };
  const autoFillAct = { label: 'Pull from TWS', onClick: handleAutoFill, busy: autoFilling, busyLabel: 'Pulling…', primary: true };
  const openInputsAct = { label: 'Open inputs', onClick: () => setDrawerTab('inputs') };
  const needs = [];
  if (hasBlocker) needs.push({ key: 'hard', tone: 'bad', title: r.hardBlocker, actions: [autoFillAct, openInputsAct] });
  blockers.forEach((b, i) => {
    const [title, detail] = splitMsg(b);
    needs.push({ key: 'blk' + i, tone: 'bad', title, detail,
      net: /net (credit|debit)/i.test(b), actions: [openInputsAct] });
  });
  if (missingInputs && !hasBlocker) needs.push({ key: 'size', tone: 'warn', sizing: true,
    title: 'Enter sizing from your broker preview',
    detail: 'Edge score, EV and Kelly size wait on win, risk and POP.' });
  if (dataFresh && !dataFresh.isLive && sessionOpen) needs.push({ key: 'close', tone: 'warn',
    title: 'Market data is from the last close',
    detail: 'The session is open — pull live prices before deciding.', actions: [autoFillAct] });
  if (feedMissing.length) needs.push({ key: 'feed', tone: 'warn',
    title: `${feedMissing.length} value${feedMissing.length > 1 ? 's' : ''} didn’t come back from the last pull`,
    detail: feedMissing.join(', ') + ' — still showing the previous number.', actions: [autoFillAct, openInputsAct] });
  if (heldConflicts.length) needs.push({ key: 'held', tone: 'info',
    title: `You typed ${heldConflicts.length === 1 ? 'a value' : heldConflicts.length + ' values'} the feed disagrees with`,
    detail: heldConflicts.map(k => `${k} ${secBag[k]} (feed ${feedValOf(k)})`).join(' · '),
    actions: [{ label: 'Use feed values', onClick: releaseHolds }, openInputsAct] });
  if (!hasBlocker && r.legs.length > 0 && r.pMaxLoss == null) needs.push({ key: 'greeks', tone: 'warn',
    title: 'No greeks for these strikes yet',
    detail: 'Chance of max loss and the greeks gauges need them.',
    actions: [{ label: 'Fetch greeks', onClick: handleFetchGreeks, busy: fetchingGreeks, busyLabel: 'Fetching…', primary: true }] });
  else if (is0 && sessionOpen && greeksAgeMin != null && greeksAgeMin >= 10) needs.push({ key: 'greeksAge', tone: 'warn',
    title: `Greeks are ${greeksAgeMin} minutes old`,
    detail: 'Chance of max loss is still using the earlier wing deltas.',
    actions: [{ label: 'Refresh greeks', onClick: handleFetchGreeks, busy: fetchingGreeks, busyLabel: 'Fetching…', primary: true }] });

  // Keep the row you are typing in until you leave it, shown as done.
  needs.forEach(n => { lastNeedsRef.current[n.key] = n; });
  if (needsFocus && !needs.some(n => n.key === needsFocus) && lastNeedsRef.current[needsFocus]) {
    needs.push({ ...lastNeedsRef.current[needsFocus], resolved: true, actions: [] });
  }

  // Commission for the execution row: the trade as sized, round trip.
  const commUnitsNow = unitsFromLegs(r.legs);
  const commQtyNow = missingInputs ? 1 : Math.max(1, r.contracts || 1);
  const commTotalNow = roundTripCommission(commUnitsNow, commQtyNow, commRateAcct);

  // Log gate. A blocker no longer leaves a green button under a red banner: it
  // turns the button into the reason, with a deliberate "Log anyway" for the cases
  // where the trader knows better (paper, legging in, a data glitch).
  const logGate = bannerGrade === 'weak' && !blockers.length
      ? { ok: false, tone: 'muted', label: 'Weak setup — not logged', why: 'Composite below 35' }
    : missingInputs ? { ok: false, tone: 'muted', label: 'Log trade · enter sizing first', why: 'Win, risk and POP are blank' }
    : blockers.length ? { ok: false, tone: 'bad', anyway: true,
        label: `Blocked · ${blockers.length} issue${blockers.length > 1 ? 's' : ''}`, why: blockers.join('\n') }
    : { ok: true };

  // ── Your inputs (Oct 2026) ── Everything the Bridge does NOT supply, on the
  // evidence line where it can be seen without opening anything: the sizing you
  // type from the broker preview, values you typed over the feed, fields the last
  // pull didn't return, and greeks. Red = required and blank. Click jumps to it.
  const FIELD_LABEL = { netCreditDebit: cashType === 'debit' ? 'Net debit' : 'Net credit', win: 'Win $', risk: 'Risk $',
    pop: 'POP %', iv: 'IV %', ivr: 'IV rank', price: 'Price', high: 'Day high', low: 'Day low', vwap5: 'VWAP',
    vwap5_30: 'VWAP −30m', vwapRoll30: 'VWAP last 30m', vwapRoll30Prior: 'VWAP prior 30m', vwapAccept: 'VWAP accept',
    em: 'EM', atr: 'ATR 1d', atr5: 'ATR 5m', atr2h: 'ATR 2h', vix: 'VIX', vix1d: 'VIX1D', esOvernightHigh: 'ES o/n high',
    esOvernightLow: 'ES o/n low', esClose: 'ES close', priorDayClose: 'Prior close', cashOpen: 'Cash open', esEM: 'ES EM', skew: 'Skew' };
  const fieldSection = k => ['win', 'risk', 'pop', 'netCreditDebit', 'comboBid', 'comboAsk'].includes(k) ? 'sizing'
    : /^es|priorDayClose|cashOpen/.test(k) ? 'es'
    : ['theta', 'delta', 'gamma', 'gamStrike', 'lowerWingDelta', 'upperWingDelta', 'vega'].includes(k) ? 'greeks'
    : (!is0 && ['iv', 'ivr', 'hv', 'ivFront', 'ivBack', 'skew', 'termBias'].includes(k)) ? 'vol' : 'market';
  function openField(k) {
    setDrawerTab('inputs');
    expandSection(fieldSection(k));
    setTimeout(() => {
      const el = panelRef.current && panelRef.current.querySelector(`[data-field="${k}"]`);
      if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.focus({ preventScroll: true }); }
    }, 60);
  }
  const blankOf = k => { const v = secBag[k]; return v === '' || v == null || !(parseFloat(v) !== 0 && isFinite(parseFloat(v))); };
  const inputChips = [];
  if (!is0 && blankOf('iv')) inputChips.push({ k: 'iv', state: 'missing', text: 'IV % — enter' });
  ['netCreditDebit', 'win', 'risk', 'pop'].forEach(k => {
    const lab = FIELD_LABEL[k];
    if (blankOf(k)) inputChips.push({ k, state: 'missing', text: `${lab} — enter` });
    else if (k === 'netCreditDebit' && netIsTarget) inputChips.push({ k, state: 'target', text: `${lab} ${Math.abs(parseFloat(secBag[k])).toFixed(2)} · target, use your fill` });
    else inputChips.push({ k, state: 'typed', text: `${lab} ${k === 'netCreditDebit' ? Math.abs(parseFloat(secBag[k])).toFixed(2) : secBag[k]}` });
  });
  heldKeys.map(x => x.slice(bag.length + 1)).forEach(k => {
    const fed = feedValOf(k);
    inputChips.push({ k, state: 'override', text: `${FIELD_LABEL[k] || k} ${secBag[k]} ✎${fed !== undefined && String(fed) !== String(secBag[k]) ? ` · feed ${fed}` : ''}` });
  });
  feedMissing.forEach(k => inputChips.push({ k, state: 'nofeed', text: `${FIELD_LABEL[k] || k} · not from Bridge` }));
  if (!r.hardBlocker && r.legs.length > 0 && r.pMaxLoss == null) inputChips.push({ k: 'lowerWingDelta', state: 'missing', text: 'Greeks — fetch' });
  else if (greeksAgeMin != null && greeksAgeMin >= 10 && sessionOpen) inputChips.push({ k: 'lowerWingDelta', state: 'nofeed', text: `Greeks ${greeksAgeMin}m old` });
  const nMissing = inputChips.filter(c => c.state === 'missing').length;

  // Evidence drawer tabs: a status dot each, so you know which one is worth opening.
  const pmlNow = r.pMaxLoss;
  const fvs = r.fairValueScore;
  const inputsDot = (secMissing.market || secMissing.sizing || secMissing.vol || nMissing) ? '#f85149'
    : (heldKeys.length || feedMissing.length) ? '#d29922'
    : (dataFresh && dataFresh.isLive) ? '#3fb950' : '#8b949e';
  const drawerTabs = [
    { id: 'inputs', label: 'Inputs', dot: inputsDot,
      meta: nMissing ? `${nMissing} to enter` : heldKeys.length ? `${heldKeys.length} typed` : dataFresh ? (dataFresh.isLive ? 'live' : 'last close') : '' },
    { id: 'setup', label: 'Setup quality', dot: sClr, meta: String(r.setupScore ?? '') },
    { id: 'structures', label: 'Structures', dot: '#58a6ff', meta: String((r.ratings || []).length || '') },
    { id: 'sizing', label: 'Sizing & price', dot: missingInputs ? '#484f58' : r.ev > 0 ? '#3fb950' : '#f85149',
      meta: missingInputs ? 'needs sizing' : `EV $${Math.round(r.ev || 0)}` },
    { id: 'greeks', label: 'Greeks & tail', dot: pmlNow == null ? '#484f58' : pmlNow <= 0.15 ? '#3fb950' : pmlNow <= 0.30 ? '#d29922' : '#f85149',
      meta: pmlNow == null ? 'none yet' : `${(pmlNow * 100).toFixed(0)}% max loss` },
    { id: 'timing', label: 'Payoff & timing', dot: '#58a6ff', meta: '' },
    { id: 'regime', label: 'Regime & signals', dot: '#58a6ff', meta: r.regime || '' },
    ...(is0 && fvs !== undefined ? [{ id: 'value', label: 'Fair value', meta: String(fvs),
      dot: fvs >= 70 ? '#3fb950' : fvs >= 50 ? '#d29922' : '#f85149' }] : [])
  ];

  // 0DTE long flies: the tastylive "% of max profit" targets are offered alongside the
  // app's % on entry. Ticket target and tastylive lines in $ per contract for the chart.
  const flyTastyOk = is0 && /^(Standard|Asymmetric|Broken wing) butterfly$/.test(effectiveStrat || '');
  const flyTargets = (() => {
    if (!is0 || !r.payoff || !(r.payoff.maxProfit > 0)) return [];
    const ncdS = signedNet(ticketNet, cashType);
    const rule = exitRuleFor('0DTE', effectiveStrat);
    const useMax = flyTastyOk && tastyFly;
    const pct = exitPlan && exitPlan.rows && exitPlan.rows.length ? Number(exitPlan.rows[0].pct) || 0 : (useMax ? 25 : rule.target);
    const out = [];
    const tick = useMax || rule.basis === 'max' ? r.payoff.maxProfit * pct / 100
      : (isFinite(ncdS) ? Math.abs(ncdS) * 100 * pct / 100 : null);
    if (tick > 0) out.push({ pnl: tick, label: `ticket +${pct}%${useMax || rule.basis === 'max' ? ' of max' : ' on entry'}`, color: '#3fb950' });
    if (flyTastyOk && tastyFly) [25, 50].forEach(p => {
      const v = r.payoff.maxProfit * p / 100;
      if (!out.some(o => Math.abs(o.pnl - v) < 1)) out.push({ pnl: v, label: `tastylive ${p}% of max`, color: '#58a6ff' });
    });
    return out;
  })();

  // ── Payoff at any date (45DTE, Oct 2026) ──
  // Every leg valued with Black-Scholes at its own expiry and IV, so the curve
  // exists for calendars and diagonals and for any day up to expiry — the 21-DTE
  // hard close above all. IV per leg: the leg's own model IV from Fetch Greeks
  // (matched by strike, right and, for time spreads, expiry); else for a time
  // spread's far leg the vol surface interpolated to its DTE; else the ticket IV.
  const payCurve = (() => {
    if (is0 || !Array.isArray(r.legs) || !r.legs.length) return null;
    const spot = fv(i45, 'price'), baseIV = fv(i45, 'iv');
    if (!(spot > 0) || !(baseIV > 0)) return null;
    const tradeDte = parseInt(i45.dte, 10) || 45;
    const dteOf = l => { const e = legExpiryOf(l); return e ? dteBetween(todayYmd, e) : tradeDte; };
    const rows = legGreeks && legGreeks.bag === '45' && Array.isArray(legGreeks.rows) ? legGreeks.rows : [];
    const ivOf = l => {
      const e = legExpiryOf(l);
      const right = String(l.label || '').toLowerCase().includes('put') ? 'P' : 'C';
      const row = rows.find(x => x.strike === Number(l.strike) && x.right === right && (isTimeSpread ? x.expiry === e : true));
      if (row && row.iv > 0) return row.iv;
      if (isTimeSpread && e) {
        const dd = dteBetween(todayYmd, e);
        const vmE = volMeta && volMeta.expiries;
        return ivAtDte(dd, tradeDte, baseIV, vmE && vmE.backDte, fv(i45, 'ivBack'));
      }
      return null;
    };
    const divYield = divYieldOf(i45.underlying);
    const cl = curveLegs(r.legs, { dteOf, ivOf, baseIV, divYield });
    if (!cl) return null;
    const { net, source } = entryNet(cl, spot, ticketNet, cashType);
    if (net == null) return null;
    const [lo, hi] = priceRange(cl, spot, baseIV);
    const nd = nearDteOf(cl);
    // ATM IV to the near expiry for P(profit): the near leg's own IV, else the ticket IV.
    const nearLeg = cl.find(l => l.dte === nd);
    const sigmaNear = nearLeg ? nearLeg.iv : baseIV / 100;
    const atExpiry = curveAt(cl, { net, lo, hi, days: nd });
    // The strategy's profit target in $ per contract (EXIT_RULES): % of the debit for
    // a calendar, % of max profit (at expiry / near expiry) for everything else.
    const rule = exitRuleFor('45DTE', effectiveStrat);
    const closeDte = (rule.closeOptions && tsClose && rule.closeOptions.includes(tsClose)) ? tsClose : rule.closeDte;
    const tgtBase = rule.basis === 'entry' ? Math.abs(net) * 100 : atExpiry.maxProfit;
    const target = tgtBase > 0 ? { dollars: tgtBase * rule.target / 100,
      label: `${rule.target}% of ${rule.basis === 'entry' ? 'the debit' : 'max profit'}` } : null;
    return { cl, net, netSource: source, spot, lo, hi, nearDte: nd, closeDay: closeDayOf(cl, closeDte), closeDte,
      closeOptions: rule.closeOptions || null, closeLeg: rule.closeLeg || '',
      sigmaNear, divYield, target, atExpiry, popExpiry: probProfit(atExpiry, spot, sigmaNear, nd) };
  })();
  // Sizing suggestions for 45DTE come from the expiry curve (near expiry for a time
  // spread) — the engine's capture fractions already model the 21-DTE exit, so
  // feeding it the at-close numbers would discount the trade twice. Only offered
  // once the ticket carries a real fill; a model-priced curve is a picture, not a fill.
  const pay45 = payCurve && payCurve.netSource === 'ticket' ? payCurve.atExpiry : null;
  const sizingPay = r.payoff || pay45;

  // ── The managed trade, simulated (Oct 2026) ──
  // 1,000 price paths at the near leg's IV; each closes at the profit target the
  // first day it is reached, else at the planned close. Gives POP for trades TWS
  // shows none for (calendars, diagonals), and avg win / avg loss that already
  // reflect the exit rules. Memoised on its inputs — ~50 ms a run.
  const simKey = payCurve ? JSON.stringify([
    payCurve.cl.map(l => [l.strike, l.right, l.sign, l.qty, l.dte, +l.iv.toFixed(4)]),
    +payCurve.net.toFixed(4), payCurve.spot, +payCurve.sigmaNear.toFixed(4), payCurve.closeDay,
    payCurve.target ? Math.round(payCurve.target.dollars) : null]) : '';
  const exitSim = useMemo(() => (payCurve && payCurve.closeDay >= 1)
    ? simulateExit(payCurve.cl, { net: payCurve.net, spot: payCurve.spot, sigma: payCurve.sigmaNear,
        mu: RATE - payCurve.divYield, closeDay: payCurve.closeDay,
        target: payCurve.target ? payCurve.target.dollars : Infinity })
    : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [simKey]);
  useEffect(() => {
    if (is0) return;
    // Engine model for time spreads only; every other 45DTE structure keeps its
    // capture-fraction EV (and the capture tracker).
    const want = isTimeSpread && exitSim ? { key: simKey, pop: exitSim.pop, avgWin: exitSim.avgWin, avgLoss: exitSim.avgLoss,
      pTarget: exitSim.pTarget, ev: exitSim.ev, paths: exitSim.paths, closeDte: payCurve ? payCurve.closeDte : null,
      netSource: payCurve ? payCurve.netSource : '' } : null;
    setCurveModel(prev => (prev && want && prev.key === want.key) || (!prev && !want) ? prev : want);
    // POP: fill a blank (or model-filled) POP from the simulation, any structure.
    // Type TWS's POP to override; clearing the field brings the model back.
    if (exitSim && (i45.pop === '' || i45.popSource === 'model')) {
      const p = String(Math.round(exitSim.pop * 100));
      if (i45.pop !== p) setI45(prev => ({ ...prev, pop: p, popSource: 'model' }));
    }
    // Win and Risk for time spreads (TWS gives neither for two expiries). Win = the
    // peak of the near-expiry curve; Risk = the most the curve can lose at the near
    // expiry over a wide price range — the debit for a calendar, debit + strike gap
    // for a diagonal whose long leg is the further one out. Model-filled when blank;
    // typing either replaces it.
    if (isTimeSpread && payCurve) {
      const winM = String(Math.round(payCurve.atExpiry.maxProfit));
      const wide = curveAt(payCurve.cl, { net: payCurve.net, lo: payCurve.spot * 0.5, hi: payCurve.spot * 1.6, days: payCurve.nearDte, n: 240 });
      const riskM = String(Math.round(Math.max(Math.abs(payCurve.net) * 100, -wide.maxLoss)));
      const patch = {};
      if ((i45.win === '' || i45.winSource === 'model') && payCurve.atExpiry.maxProfit > 0 && i45.win !== winM) Object.assign(patch, { win: winM, winSource: 'model' });
      if ((i45.risk === '' || i45.riskSource === 'model') && i45.risk !== riskM) Object.assign(patch, { risk: riskM, riskSource: 'model' });
      if (Object.keys(patch).length) setI45(prev => ({ ...prev, ...patch }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simKey, is0, isTimeSpread, i45.pop, i45.popSource, i45.win, i45.winSource, i45.risk, i45.riskSource]);

  // ── Break-even fill (Oct 2026) ──
  // The entry price at which EV = 0: pay at most this debit / take at least this
  // credit. Single-expiry structures re-run the engine across fills — their expiry
  // payoff is intrinsic + net, so Win and Risk shift one-for-one with the price
  // (POP held at what is entered). Time spreads re-run the managed-trade simulation
  // at each fill, POP and all. Memoised; ~25 engine runs or ~18 small simulations.
  const beBag = is0 ? i0 : i45;
  const beKey = JSON.stringify([is0, effectiveStrat, overrideStrat, tsClose, (r.legs || []).map(l => [l.strike, l.label]),
    Object.fromEntries(Object.entries(beBag).filter(([k]) => !['netCreditDebit', 'win', 'risk', 'winSource', 'riskSource', 'popSource'].includes(k))),
    isTimeSpread && payCurve ? [payCurve.cl.map(l => [l.strike, l.right, l.sign, l.qty, l.dte, +l.iv.toFixed(4)]), payCurve.spot, +payCurve.sigmaNear.toFixed(4), payCurve.closeDay] : null,
    r.evBasis ? r.evBasis.commissionRoundTrip : 0, captureStats ? 1 : 0]);
  const breakeven = useMemo(() => {
    try {
      if (!Array.isArray(r.legs) || !r.legs.length) return null;
      if (!is0 && isTimeSpread) {
        if (!payCurve || payCurve.closeDay < 1) return null;
        const pc = payCurve;
        const comm = r.evBasis ? (r.evBasis.commissionRoundTrip || 0) : 0;
        const fair = -positionValue(pc.cl, pc.spot, 0);           // model fair, per share (− = debit)
        // The profit target stays at the ticket's own $ figure: re-deriving "25% of the
        // debit" at each trial price would shrink the target to nothing as the price
        // falls, and EV would stop rising with a better fill.
        const tgt = pc.target ? pc.target.dollars : Infinity;
        const evAt = n => {
          const sim = simulateExit(pc.cl, { net: n, spot: pc.spot, sigma: pc.sigmaNear, mu: RATE - pc.divYield,
            closeDay: pc.closeDay, target: tgt > 0 ? tgt : Infinity, paths: 400 });
          return sim ? sim.ev - comm : NaN;
        };
        const worst = Math.min(fair * 3, -0.05);
        return { ...solveBreakevenNet(evAt, worst, -0.01, 18), basis: 'sim' };
      }
      const pay0 = legsPayoff(r.legs, 0);
      if (!pay0) return null;
      const mp0 = pay0.maxProfit, ml0 = pay0.maxLoss;
      const lo = -mp0 / 100, hi = -ml0 / 100;
      if (!(hi > lo)) return null;
      const popNow = fv(beBag, 'pop');
      if (!(popNow > 0)) return { status: 'needPop' };
      const eps = (hi - lo) * 0.002;
      const evAt = n => {
        const wr = winRiskAtNet(mp0, ml0, n);
        if (!(wr.win > 0) || !(wr.risk > 0)) return NaN;
        const res = is0 ? calc0DTE(mk0({ netCreditDebit: n, win: wr.win, risk: wr.risk }))
          : calc45DTE(mk45({ win: wr.win, risk: wr.risk }));
        return res.ev;
      };
      // 0DTE premium-selling: also solve as if winners bank the 25% exit target —
      // shown for information, not used to score (see calc0dte targetCapture).
      let atTarget = null;
      if (is0 && EXIT_RULES['0DTE'][effectiveStrat]) {
        const evT = n => {
          const wr = winRiskAtNet(mp0, ml0, n);
          if (!(wr.win > 0) || !(wr.risk > 0)) return NaN;
          return calc0DTE(mk0({ netCreditDebit: n, win: wr.win, risk: wr.risk, useTargetCapture: true })).ev;
        };
        atTarget = { ...solveBreakevenNet(evT, lo + eps, hi - eps), target: EXIT_RULES['0DTE'][effectiveStrat].target };
      }
      return { ...solveBreakevenNet(evAt, lo + eps, hi - eps), basis: 'engine', pop: popNow, atTarget,
        measured: !!(r.evBasis && r.evBasis.mode === 'measured') };
    } catch (e) { return null; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beKey]);
  // Put the break-even price in the net field, in the same sign style as what's there.
  function applyBreakevenNet() {
    if (!breakeven || breakeven.status !== 'ok') return;
    const n = breakeven.net;
    // Round toward the safe side: a debit down, a credit up, to the cent.
    const safe = n < 0 ? -Math.floor(Math.abs(n) * 100) / 100 : Math.ceil(n * 100) / 100;
    const typed = parseFloat(ticketNet);
    const v = (isFinite(typed) && typed > 0 && safe < 0) ? Math.abs(safe) : safe;
    if (is0) set0('netCreditDebit', v.toFixed(2)); else set45('netCreditDebit', v.toFixed(2));
  }
  const beView = (() => {
    if (!breakeven) return null;
    if (breakeven.status === 'needPop') return { tone: 'muted', text: 'Break-even fill: enter POP to solve' };
    if (breakeven.measured) return { tone: 'muted', text: 'Break-even fill: EV is from measured history, which the fill price does not move' };
    if (breakeven.status === 'none') return { tone: 'bad', text: `No fill gives EV ≥ 0${breakeven.pop ? ` at POP ${breakeven.pop}%` : ''}` };
    if (breakeven.status === 'any') return { tone: 'good', text: 'EV ≥ 0 at any fill in range' };
    const n = breakeven.net, cur = signedNet(ticketNet, cashType);
    const txt = n < 0 ? `pay ≤ ${Math.abs(n).toFixed(2)} debit` : `receive ≥ ${n.toFixed(2)} credit`;
    const at = breakeven.atTarget;
    const infoText = !at ? '' : at.status === 'ok'
      ? `If winners bank your ${at.target}% target: ${at.net < 0 ? `pay ≤ ${Math.abs(at.net).toFixed(2)}` : `receive ≥ ${at.net.toFixed(2)}`} — for information; the engine moves on your measured closes (Analytics → Capture)`
      : at.status === 'none' ? `If winners bank your ${at.target}% target, no fill clears EV = 0 at this POP — for information only` : '';
    const gap = isFinite(cur) ? cur - n : null;                 // + = your fill is better than break-even
    return { tone: gap == null ? 'muted' : gap >= 0 ? 'good' : 'bad', text: `EV = 0 at: ${txt}`,
      gapText: gap == null ? '' : gap >= 0 ? `your fill clears it by ${gap.toFixed(2)}` : `your fill is ${Math.abs(gap).toFixed(2)} short`,
      infoText, gap, net: n,
      basis: breakeven.basis === 'sim' ? 'simulated managed trade, target held at the ticket\'s $ figure' : `POP ${breakeven.pop}% held` };
  })();

  // ── Trade choices (Oct 2026) ──
  // Built from stratCompare (current + next two, each a full engine run). The
  // current card uses this ticket's own payoff and fill. Alternatives are drawn at
  // the model's fair value for THEIR strikes (priceCheck.fair), because their run
  // still carries this ticket's net credit, which belongs to other legs.
  const choiceList = (!hasBlocker && Array.isArray(stratCompare)) ? stratCompare.map(c => {
    const res = c.res || {};
    const isCur = !!c.current;
    // Signed by the structure's cash type: a debit typed as a positive number (the
    // way TWS shows it) was drawn and labelled as a credit.
    const netNow = signedNet(ticketNet, cashType);
    let pay = null, priced = 'shape', netShow = null;
    if (isCur) {
      if (res.payoff && Array.isArray(res.payoff.points) && res.payoff.points.length > 1) { pay = res.payoff; priced = 'ticket'; }
      else { pay = legsPayoff(res.legs, isFinite(netNow) && netNow !== 0 ? netNow : null); priced = pay && !pay.shapeOnly ? 'ticket' : 'shape'; }
      netShow = isFinite(netNow) && netNow !== 0 ? netNow : null;
    } else {
      const fair = res.priceCheck && isFinite(res.priceCheck.fair) ? -res.priceCheck.fair : null;
      pay = legsPayoff(res.legs, fair);
      priced = fair != null && pay && !pay.shapeOnly ? 'fair' : 'shape';
      netShow = fair;
    }
    if (/calendar|diagonal/i.test(c.name)) {
      // Intrinsic maths can't draw a time spread; the current ticket's BS curve can.
      if (isCur && payCurve) { pay = payCurve.atExpiry; priced = payCurve.netSource === 'ticket' ? 'ticket' : 'fair'; }
      else { pay = null; priced = 'shape'; }
    }
    const rr = pay && !pay.shapeOnly && pay.maxProfit > 0 && pay.maxLoss < 0 ? pay.maxProfit / Math.abs(pay.maxLoss) : null;
    return {
      name: c.name, rating: c.rating, isCur, override: isCur && isOverride,
      cash: resolveCashType(c.name, isCur ? ticketNet : (netShow != null ? String(netShow) : null)),
      outlook: outlookOf(c.name),
      edge: isCur ? compositeScore : null,
      edgeColor: dcColor, edgeLabel: missingInputs ? 'SETUP' : 'EDGE',
      pml: res.pMaxLoss != null ? res.pMaxLoss : null,
      ev: isCur && !missingInputs ? res.ev : null,
      contracts: isCur && !missingInputs ? res.contracts : null,
      rr, pay, priced, netShow,
      strikes: strikeMarks(res.legs),
      profitIf: profitIfText(pay, secBag.underlying) || res.behaviour || '',
    };
  }) : [];
  const choiceRRMax = Math.max(0, ...choiceList.map(c => c.rr || 0));
  // Switching structure in place clears the four sizing fields: max profit, max
  // loss, POP and the fill all describe the legs being left behind. Net credit
  // re-fills from the new structure's target and Needs-you asks for the rest.
  function switchStructure(name) {
    const next = name === r.bestStrat ? null : name;
    const strip = o => ({ ...o, win: '', risk: '', pop: '', netCreditDebit: '' });
    if (is0) setI0(strip); else setI45(strip);
    setOverrideStrat(next);
  }

  // ── Price map inputs (Oct 2026) ──
  const netNum = signedNet(ticketNet, cashType);
  const mapPay = hasBlocker ? null
    : /calendar|diagonal/i.test(effectiveStrat || '') ? (payCurve ? payCurve.atExpiry : null)
    : (r.payoff && Array.isArray(r.payoff.points) && r.payoff.points.length > 1) ? r.payoff
    : legsPayoff(r.legs, isFinite(netNum) && netNum !== 0 ? netNum : null);
  const mapEM = is0 ? (r.emRemaining || 0) : (r.em45 || 0);
  const cushion = shortCushion(r.legs, fv(secBag, 'price'), mapEM);

  const tc = r.tradeConfidence;
  const confClr = tc==null?'#a8b2be':tc>=70?'#3fb950':tc>=50?'#7bc74d':tc>=30?'#d29922':tc>=15?'#e3833c':'#f85149';
  const confBg  = tc==null?'#161b22':tc>=70?'#0d1f0d':tc>=50?'#0d1a0d':tc>=30?'#1f1a0d':'#1f0d0d';

  // Show VWAP scaling notice (vwapScaled defined above)

  // opts.autoApply === false: a refetch the delta method itself asked for, which must
  // not trigger another apply. Click handlers pass an event here, which reads as auto.
  async function handleFetchGreeks(opts) {
    const autoApply = !(opts && opts.autoApply === false);
    let fetchedRows = null, fetchedLegs = null;
    setFetchingGreeks(true);
    try {
      const bridgeUrl = localStorage.getItem('bridgeUrl') || '';
      if (!bridgeUrl) { notify('Set IBKR Bridge URL in Settings first'); setFetchingGreeks(false); return; }
      const underlying = is0 ? i0.underlying : i45.underlying;
      // opts.legs: the delta method refetching for legs it has just set, before the
      // re-render that would put them in r.legs.
      const legsSrc = (opts && Array.isArray(opts.legs) && opts.legs) || r?.legs || [];
      if (!legsSrc.length) { notify('No strikes computed yet — fill in the setup first.'); setFetchingGreeks(false); return; }

      // Expiry (YYYYMMDD) — shared derivation with the strike ladder popover.
      const yyyymmdd = deriveExpiryYYYYMMDD();

      // Build legs: right from label (put/call), signed qty from long/short (+x2 body).
      const legs = legsSrc.map(l => {
        const lbl = (l.label || '').toLowerCase();
        const right = lbl.includes('put') ? 'P' : 'C';
        const isShort = lbl.includes('short');
        const isBody = lbl.includes('body') || lbl.includes('x2');
        const mag = isBody ? 2 : 1;
        const legExp = legExpiryOf(l);
        return { strike: l.strike, right, qty: (isShort ? -mag : mag), ...(legExp ? { expiry: legExp } : {}) };
      });

      const url = bridgeUrl + '/api/option-greeks?underlying=' + underlying
        + '&expiry=' + yyyymmdd + '&legs=' + encodeURIComponent(JSON.stringify(legs));
      const resp = await fetch(url, { headers: { 'ngrok-skip-browser-warning': '1' } });
      const d = await resp.json();
      if (d.error) { notify('Bridge error: ' + d.error); setFetchingGreeks(false); return; }
      if (d.notSubscribed || (!d.net && d.message)) {
        notify(d.message || 'TWS returned no Greeks — options market data not subscribed. Enter Greeks manually.');
        setFetchingGreeks(false); return;
      }
      if (!d.net) { notify('No Greeks returned — TWS may lack option data permissions, or the expiry/strikes are invalid. You can enter Greeks manually.'); setFetchingGreeks(false); return; }

      // Feed freshness (real-time / delayed / frozen) + the underlying price the model used.
      setGreeksFresh(d.dataType ? { dataType: d.dataType, label: d.dataTypeLabel || '', asOf: d.asOf, undPrice: d.undPrice,
        greekSource: d.greekSource, greeksMixed: !!d.greeksMixed } : null);
      const freshPx = (d.undPrice != null && d.undPrice > 0) ? String(d.undPrice) : null;
      // Keep every leg's own delta and IV for the delta cross-check (R-49). Only the
      // wing deltas used to survive this call.
      if (Array.isArray(d.legs)) {
        fetchedRows = d.legs.filter(l => l.greeks && l.greeks.delta != null && isFinite(l.greeks.delta))
          .map(l => ({ strike: Number(l.strike), right: String(l.right || '').toUpperCase(),
            delta: l.greeks.delta, iv: l.greeks.iv, ...(l.expiry ? { expiry: String(l.expiry) } : {}) }));
        setLegGreeks({ bag, asOf: d.asOf || new Date().toISOString(), rows: fetchedRows });
      }
      fetchedLegs = legsSrc;

      // Net position greeks. gamStrike (pin magnet) ~ the body strike for flies.
      const bodyLeg = legsSrc.find(l => (l.label || '').toLowerCase().includes('body'));
      // Outer wing deltas for the skew-aware P(max loss) cross-check: pick the
      // lowest- and highest-strike legs from the per-leg greeks the bridge returned.
      let lowerWD = '', upperWD = '';
      if (Array.isArray(d.legs) && d.legs.length > 1) {
        const withGreeks = d.legs.filter(l => l.greeks && l.greeks.delta != null);
        if (withGreeks.length > 1) {
          const sorted = [...withGreeks].sort((a, b) => a.strike - b.strike);
          lowerWD = String(Math.abs(sorted[0].greeks.delta));
          upperWD = String(Math.abs(sorted[sorted.length - 1].greeks.delta));
        }
      }
      // The bridge's model greeks carry a per-leg implied vol (%, generic tick
      // 106). Average the legs that returned one — that average IS the
      // expiry-specific IV of the structure ("IVx"). 45DTE feeds it into the IV
      // input as before; 0DTE has no IV input, so it rides along as i0.ivx
      // purely for the log-time vol snapshot (IVx Open column).
      let avgIV = '';
      if (Array.isArray(d.legs)) {
        const withIV = d.legs.filter(l => l.greeks && l.greeks.iv != null && l.greeks.iv > 0);
        if (withIV.length) avgIV = String(+(withIV.reduce((s, l) => s + l.greeks.iv, 0) / withIV.length).toFixed(2));
      }
      if (is0) {
        setI0(prev => ({
          ...prev,
          price: freshPx || prev.price,
          theta: d.net.theta ? String(d.net.theta) : prev.theta,
          delta: d.net.delta != null ? String(d.net.delta) : prev.delta,
          gamma: d.net.gamma != null ? String(d.net.gamma) : prev.gamma,
          gamStrike: bodyLeg ? String(bodyLeg.strike) : prev.gamStrike,
          // The combo quote rides along with the greeks fetch, so the frictions
          // gauge fills itself on the same click. Only when every leg quoted.
          comboBid: d.net.bid != null ? String(d.net.bid) : prev.comboBid,
          comboAsk: d.net.ask != null ? String(d.net.ask) : prev.comboAsk,
          ivx: avgIV || prev.ivx,
          lowerWingDelta: lowerWD || prev.lowerWingDelta,
          upperWingDelta: upperWD || prev.upperWingDelta
        }));
      } else {
        // When the outer legs are a put and a call (condor-style), put-wing IV
        // minus call-wing IV fills Skew in vol points. Same-right structures
        // (flies) have no put/call skew to read, so Skew is left alone there.
        // Held fields are skipped — same override contract as auto-fill.
        let skewIV = '';
        if (Array.isArray(d.legs)) {
          const withIV = d.legs.filter(l => l.greeks && l.greeks.iv != null && l.greeks.iv > 0);
          if (withIV.length > 1) {
            const byStrike = [...withIV].sort((a, b) => a.strike - b.strike);
            const loLeg = byStrike[0], hiLeg = byStrike[byStrike.length - 1];
            if (String(loLeg.right).toUpperCase() === 'P' && String(hiLeg.right).toUpperCase() === 'C') {
              skewIV = String(+(loLeg.greeks.iv - hiLeg.greeks.iv).toFixed(2));
            }
          }
        }
        setI45(prev => ({
          ...prev,
          price: freshPx || prev.price,
          theta: d.net.theta ? String(d.net.theta) : prev.theta,
          delta: d.net.delta != null ? String(d.net.delta) : prev.delta,
          vega: d.net.vega != null ? String(d.net.vega) : prev.vega,
          // The vol surface's ATM IV and 25Δ skew outrank the leg-average IV and the
          // structure's own wing skew: EM45 wants ATM vol, and a wing average carries
          // the put skew straight into it. These only fill when the surface did not.
          iv: avgIV && !held['45:iv'] && !volOwns('iv') ? avgIV : prev.iv,
          ivx: avgIV || prev.ivx,
          skew: skewIV && !held['45:skew'] && !volOwns('skew') ? skewIV : prev.skew,
          lowerWingDelta: lowerWD || prev.lowerWingDelta,
          upperWingDelta: upperWD || prev.upperWingDelta
        }));
      }
    } catch (e) {
      notify('Fetch Greeks failed: ' + e.message);
    }
    setFetchingGreeks(false);
    // Delta method: place the shorts at their target delta straight from these deltas.
    // Hand-edited strikes are left alone — the apply button is still there if wanted.
    const deltaByDefault = !!(r.vertVariants && vertPick !== 'em');
    if (autoApply && fetchedRows && fetchedRows.length && (strikeMethod[bag] === 'delta' || deltaByDefault) && strikesBuiltBy !== 'Manual') {
      const plan = deltaStrikePlan({ legs: fetchedLegs, strat: r.legStrat, horizon: deltaHorizon,
        price: fv(secBag, 'price'), legGreeks: fetchedRows, T: deltaT(), underlying: secBag.underlying, listed: is0 ? null : listedNow });
      if (plan && plan.changed) { await applyDeltaStrikes({ plan, rows: fetchedRows, legs: fetchedLegs }); clearFillForNewStrikes(); }
      else if (plan) setDeltaApplied({ bag, strat: r.legStrat || '', map: (ovNow && ovNow.map) || {}, confirmed: true, at: new Date().toISOString() });
    }
  }

  // ── Delta strikes (R-49) ──
  // r.deltaPlan is the estimate: each short's strike solved from its own live delta.
  // Before anything is applied, the estimate is confirmed against live greeks on a
  // small bracket of listed strikes around it, and the strike whose delta is nearest the
  // target wins. The structure's wings move with their shorts, so widths are unchanged.
  // Then the greeks are fetched again for the new legs, so the net greeks, combo quote,
  // P(max loss) and the check itself all describe the trade that is now on the ticket.
  const deltaHorizon = is0 ? '0dte' : '45dte';
  const deltaT = () => is0 ? (tradingSession().hoursToBell || 1) / 8760 : (fv(i45, 'dte') || 45) / 365;
  function persistMethod(m) {
    setStrikeMethodState(prev => {
      const next = { ...prev, [bag]: m };
      try { localStorage.setItem('ot_strike_method', JSON.stringify(next)); } catch (e) { /* private mode */ }
      return next;
    });
  }
  // New strikes, new trade: the fill typed for the old strikes would price the new
  // ones wrongly (that is what blocked "debit 1.88 on 777/782" — a long 4 pts ITM can't
  // cost 1.88). Clear it, like a structure switch does, and say so.
  function clearFillForNewStrikes() {
    const typed = fv(secBag, 'netCreditDebit') !== 0 || fv(secBag, 'win') > 0 || fv(secBag, 'pop') > 0;
    const strip = o => ({ ...o, win: '', risk: '', pop: '', netCreditDebit: '' });
    if (is0) setI0(strip); else setI45(strip);
    if (typed) notify('Strikes changed — enter the fill, win, risk and POP for the new strikes', 'info');
  }
  // The method buttons now DO something every time (Oct 2026). EM puts the engine's
  // EM strikes back, hand edits included; Delta moves the shorts to their target
  // delta, fetching greeks first if it has none.
  const [pendingDeltaFetch, setPendingDeltaFetch] = useState(false);
  useEffect(() => {
    if (!pendingDeltaFetch) return;
    setPendingDeltaFetch(false);
    handleFetchGreeks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDeltaFetch]);
  function setStrikeMethod(m) {
    persistMethod(m);
    if (m === 'delta') {
      if (r.deltaPlan && r.deltaPlan.changed) { applyDeltaStrikes(); clearFillForNewStrikes(); }
      else if (r.deltaPlan && !r.deltaPlan.changed) notify('These strikes already sit at the target delta', 'info');
      else { if (overrideStrikes[bag]) { resetStrikes(); setDeltaApplied(null); } setPendingDeltaFetch(true); }
    }
    if (m === 'em' && overrideStrikes[bag]) { backToEmStrikes(); clearFillForNewStrikes(); }
  }
  // Vertical strike choices: one tile = one spread on the ticket.
  function chooseVertical(id) {
    if (id === 'delta') { setVertPick('delta'); setStrikeMethod('delta'); return; }
    setVertPick('em');
    persistMethod('em');
    const changing = id !== (r.vertVariant || 'engine') || !!overrideStrikes[bag];
    if (overrideStrikes[bag]) { resetStrikes(); }
    setDeltaApplied(null);
    setVertVariant(id);
    if (changing) { clearFillForNewStrikes(); markGreeksStale(); }
  }
  // opts (from Fetch Greeks in Delta mode): { plan, rows, legs } computed from the deltas
  // just fetched, which have not reached r yet. A click passes an event: use r.
  async function applyDeltaStrikes(opts) {
    const o = opts && opts.plan ? opts : {};
    const plan0 = o.plan || r.deltaPlan;
    const rowsNow = o.rows || (legGreeks ? legGreeks.rows : null);
    const legsNow = o.legs || r.legs;
    if (!plan0 || !plan0.moves || !plan0.moves.length) {
      notify('Fetch greeks first — delta strikes are solved from the live deltas of the short legs.');
      return;
    }
    setApplyingDelta(true);
    let plan = plan0, confirmed = false;
    try {
      let bridgeUrl = '';
      try { bridgeUrl = localStorage.getItem('bridgeUrl') || ''; } catch (e) { /* private mode */ }
      if (bridgeUrl) {
        const underlying = secBag.underlying;
        const brackets = {};
        const req = [];
        plan0.moves.forEach(m => {
          brackets[m.idx] = bracketStrikes(m.to, underlying, 2, !is0 && listedNow && (listedNow[m.right] || []).length >= 5 ? listedNow[m.right] : null);
          brackets[m.idx].forEach(k => {
            if (!req.some(q => q.strike === k && q.right === m.right)) req.push({ strike: k, right: m.right, qty: 1 });
          });
        });
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 20000);
        const url = bridgeUrl + '/api/option-greeks?underlying=' + underlying
          + '&expiry=' + deriveExpiryYYYYMMDD() + '&legs=' + encodeURIComponent(JSON.stringify(req));
        const resp = await fetch(url, { headers: { 'ngrok-skip-browser-warning': '1' }, signal: ctrl.signal });
        clearTimeout(t);
        const d = await resp.json();
        if (!d.error && Array.isArray(d.legs)) {
          const shortStrikes = {};
          plan0.moves.forEach(m => {
            const rows = d.legs
              .filter(l => String(l.right || '').toUpperCase() === m.right && l.greeks && l.greeks.delta != null
                && brackets[m.idx].includes(Number(l.strike)))
              .map(l => ({ strike: Number(l.strike), delta: l.greeks.delta }));
            const pick = pickByDelta(rows, m.target);
            if (pick) shortStrikes[m.idx] = pick.strike;
          });
          if (Object.keys(shortStrikes).length === plan0.moves.length) {
            const p2 = deltaStrikePlan({ legs: legsNow, strat: r.legStrat, horizon: deltaHorizon,
              price: fv(secBag, 'price'), legGreeks: rowsNow, T: deltaT(),
              underlying, shortStrikes, listed: is0 ? null : listedNow });
            if (p2) { plan = p2; confirmed = true; }
          }
        }
      }
    } catch (e) { /* bridge unreachable: fall back to the estimate, and say so below */ }
    const eng = r.engineLegs || [];
    const map = {};
    plan.legs.forEach((l, i) => { if (eng[i] && l.strike !== eng[i].strike) map[i] = l.strike; });
    setOverrideStrikes(prev => {
      const out = { ...prev };
      if (Object.keys(map).length) out[bag] = { strat: r.legStrat || '', map }; else delete out[bag];
      return out;
    });
    setDeltaApplied({ bag, strat: r.legStrat || '', map, confirmed, at: new Date().toISOString() });
    markGreeksStale();
    setApplyingDelta(false);
    notify(confirmed
      ? 'Delta strikes applied and confirmed against live greeks.'
      : 'Delta strikes applied from the estimate only — the bridge could not confirm them.',
      confirmed ? 'success' : 'error');
    // Refresh greeks for the legs now on the ticket (net greeks, combo quote, and the
    // delta check itself), without re-applying.
    await handleFetchGreeks({ autoApply: false, legs: plan.legs });
  }
  function backToEmStrikes() {
    resetStrikes();
    setDeltaApplied(null);
  }
  // Which method built the strikes on the ticket right now: 'Delta' when the overrides
  // are exactly what the delta method applied, 'Manual' for any other hand edit, else 'EM'.
  const ovNow = overrideStrikes[bag];
  const deltaMatches = !!(deltaApplied && deltaApplied.bag === bag && deltaApplied.strat === (r.legStrat || '')
    && JSON.stringify(deltaApplied.map || {}) === JSON.stringify((ovNow && ovNow.map) || {}));
  const strikesBuiltBy = deltaMatches ? 'Delta' : ovNow ? 'Manual' : 'EM';


  // Load an option structure from TWS open positions into the ticket, then
  // chain the market-data auto-fill. Auto-loads if one structure, else picker.
  async function handleLoadFromTWS() {
    setLoadingTws(true);
    setTwsStructures(null);
    try {
      const bridgeUrl = localStorage.getItem('bridgeUrl') || '';
      if (!bridgeUrl) { notify('Set IBKR Bridge URL in Settings first'); setLoadingTws(false); return; }
      const resp = await fetch(bridgeUrl + '/api/positions', { headers: { 'ngrok-skip-browser-warning': '1' } });
      const d = await resp.json();
      if (d.error) { notify('Bridge error: ' + d.error); setLoadingTws(false); return; }
      const structs = d.structures || [];
      if (structs.length === 0) {
        notify('No open option positions in TWS. For paper trades, enter the strikes, contracts and net credit/debit manually — the ticket fields below mirror what a fetch would fill.');
        setLoadingTws(false); return;
      }
      if (structs.length === 1) {
        await applyTwsStructure(structs[0]);
      } else {
        // Several open structures — show a picker.
        setTwsStructures(structs);
      }
    } catch (e) {
      notify('Load from TWS failed: ' + e.message);
    }
    setLoadingTws(false);
  }

  // Apply a chosen structure to the ticket fields, then fetch market data.
  async function applyTwsStructure(s) {
    setTwsStructures(null);
    const underlying = s.underlying || (is0 ? i0.underlying : i45.underlying);
    // The bridge's netCreditDebit is per share for one unit of the structure
    // (+ credit, − debit) — exactly what the net field holds. It used to be
    // multiplied by 100 here, so a 0.64 fly landed in the field as 64. (Oct 2026.)
    const ncdIn = Number(s.netCreditDebit) || 0;
    const patch = {
      underlying,
      contracts: s.contracts || 1,
      netCreditDebit: ncdIn ? ncdIn.toFixed(2) : '',
    };
    if (is0) setI0(prev => ({ ...prev, ...patch }));
    else setI45(prev => ({ ...prev, ...patch }));
    // Stash the legs so Fetch Greeks / payoff can use exact strikes.
    setTwsLegs(s.legs || []);
    // Chain the market-data auto-fill so price/EM/VIX populate too.
    await handleAutoFill();
  }

  // Did the last vol-surface pull supply this field? (Fetch Greeks defers to it.)
  const volOwns = k => !!(volMeta && feed && feed.values && feed.values[k] !== undefined);

  // ── Vol surface (45DTE) ──
  // One bridge call fills IV, IVR, HV, IV Front/Back and Skew; term bias is then
  // derived by the engine from Front/Back. Runs on its own after the market auto-fill
  // (it takes 10-20 s: ~8 option lines plus a cached year of IV history) so price and
  // VIX never wait on it. opts.spot passes the price just pulled; opts.quiet skips toasts.
  async function fetchVolSurface(opts) {
    const quiet = !!(opts && opts.quiet);
    let bridgeUrl = '';
    try { bridgeUrl = localStorage.getItem('bridgeUrl') || ''; } catch (e) { /* private mode */ }
    if (!bridgeUrl) { if (!quiet) notify('Set IBKR Bridge URL in Settings first'); return; }
    setFetchingVol(true);
    try {
      const expiry = deriveExpiryYYYYMMDD();
      const spot = parseFloat((opts && opts.spot) || i45.price) || 0;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 45000);
      const resp = await fetch(bridgeUrl + '/api/vol-surface?underlying=' + i45.underlying + '&expiry=' + expiry
        + (spot > 0 ? '&spot=' + spot : ''), { headers: { 'ngrok-skip-browser-warning': '1' }, signal: ctrl.signal });
      clearTimeout(t);
      const d = await resp.json();
      if (d.error) { notify('Vol surface: ' + d.error); return; }
      // Skew can be zero or negative and still be a reading; everything else must be > 0.
      const vals = {}, missing = [];
      VOL_45.forEach(k => {
        const v = d[k];
        const ok = v != null && v !== '' && isFinite(v) && (k === 'skew' || v > 0);
        if (ok) vals[k] = String(v); else missing.push(k);
      });
      setFeed(f => {
        const b = f || { at: new Date().toISOString(), values: {}, missing: [] };
        return { ...b, values: { ...(b.values || {}), ...vals },
          missing: [...(b.missing || []).filter(k => !VOL_45.includes(k)), ...missing] };
      });
      setI45(prev => {
        const out = { ...prev };
        VOL_45.forEach(k => { if (!held['45:' + k] && vals[k] !== undefined) out[k] = vals[k]; });
        return out;
      });
      const trend = computeTrend(d.daily);
      if (trend && !held['45:outlook']) setI45(prev => ({ ...prev, outlook: trend.outlook }));
      setVolMeta({ und: i45.underlying, trend, oldBridge: !('daily' in d) && !('vix3m' in d), vix: d.vix, vix3m: d.vix3m, vixTermRatio: d.vixTermRatio, dailySource: d.dailySource || null,
        asOf: d.asOf, dataType: d.dataType, expiries: d.expiries, atmStrike: d.atm ? d.atm.strike : null,
        termBias: d.termBias, termRatio: d.termRatio, ivPctl: d.ivPctl, iv30: d.iv30,
        iv52wLow: d.iv52wLow, iv52wHigh: d.iv52wHigh, hvSource: d.hvSource,
        skewDetail: d.skewDetail, notes: d.notes || [], missing });
      if (!quiet) {
        if (d.notSubscribed) notify('Vol surface: no option IVs — check the OPRA / options market-data subscription.');
        else if (missing.length) notify('Vol surface: ' + missing.join(', ') + ' not returned — enter by hand or retry.');
      }
    } catch (e) {
      if (!quiet) notify('Vol surface failed: ' + (e.name === 'AbortError' ? 'timed out' : e.message));
    } finally {
      setFetchingVol(false);
    }
  }

  async function handleAutoFill() {
    setAutoFilling(true);
    try {
      const bridgeUrl = localStorage.getItem('bridgeUrl') || '';
      if (!bridgeUrl) { notify('Set IBKR Bridge URL in Settings first'); setAutoFilling(false); return; }
      const underlying = is0 ? i0.underlying : i45.underlying;
      const resp = await fetch(bridgeUrl + '/api/market-data?underlying=' + underlying, { headers: { 'ngrok-skip-browser-warning': '1' } });
      const d = await resp.json();
      if (d.error) { notify('Bridge error: ' + d.error); setAutoFilling(false); return; }
      // Data-freshness flag from the bridge (realtime | frozen | delayed | ...).
      // pulledAt is OUR clock at the moment of the pull; asOf is the feed's own
      // stamp. They answer different questions — "how old is this screen" vs
      // "how old is the quote" — so both are kept.
      const pulledAt = new Date().toISOString();
      setDataFresh({ isLive: !!d.isLive, label: d.dataTypeLabel || d.dataType || '', dataType: d.dataType || '', asOf: d.asOf || d.timestamp || pulledAt, pulledAt });
      if (d.esContractLabel || d.esContractMonth) setEsContract(d.esContractLabel || d.esContractMonth);
      if (is0) setEsMeta({
        source: d.esSource || 'snapshot', prior: d.esPriorCloseLabel || '', pre: d.esPreOpenLabel || '',
        preFinal: d.esPreOpenFinal, window: d.esOvernightLabel || '',
        session: d.esSessionDate || '',
        basis: d.esBasis, esNow: d.esNow, cash: d.price, underlying
      });

      // Fetch the straddle EM separately, with a short timeout so a slow/after-
      // hours option fetch can't hang the essential price+VIX auto-fill.
      let straddle = null;
      if (is0) {
        try {
          const today = tradingSession().yyyymmdd;
          const hc = parseFloat(i0.straddleHaircut) || 1.2533;  // 1 SD = straddle x 1.2533
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 7000);
          const sResp = await fetch(bridgeUrl + '/api/atm-straddle?underlying=' + underlying + '&expiry=' + today + '&haircut=' + hc, { headers: { 'ngrok-skip-browser-warning': '1' }, signal: ctrl.signal });
          clearTimeout(t);
          const sData = await sResp.json();
          if (sData && sData.source === 'straddle' && sData.expectedMove > 0) straddle = sData;
        } catch (e) { /* straddle optional — VIX EM stands */ }
      }

      // ── What the feed actually returned ──
      // A field the bridge answers with 0, null or '' has NOT been refreshed — it
      // has failed. The old code wrote `d.x || prev.x`, which silently kept the
      // stale number under a fresh LIVE badge and looked identical to a successful
      // pull. Now the failures are recorded and shown on the field itself.
      const fields = is0 ? MKT_0 : MKT_45;
      const vals = {}, missing = [];
      fields.forEach(k => {
        let v = d[k];
        if (is0 && k === 'em' && straddle) v = straddle.expectedMove; // straddle beats the VIX model
        // Zero means "the feed failed" for every field here EXCEPT vwapAccept, which
        // is a 0..1 ratio whose 0 is the strongest reading it has: not one of the last
        // twelve bars closed above VWAP. Dropping it as missing would have blinded the
        // engine to acceptance on exactly the most one-sided days — the days it exists
        // to catch. The bridge's sentinel for "no reading" is -1, so that is the test.
        const absent = k === 'vwapAccept'
          ? (v == null || v === '' || v < 0)
          : (v == null || v === '' || v === 0);
        if (absent) missing.push(k); else vals[k] = String(v);
      });
      setFeed({ at: pulledAt, values: vals, missing });
      setJustRefreshed(true);
      setTimeout(() => setJustRefreshed(false), 6000);

      if (is0) {
        // Hours to the 15:00 ET working close OF THE SESSION THIS BELONGS TO — a
        // refresh run before the open gets the full session, not zero.
        const hoursRounded = tradingSession().hoursLeft;

        setI0(prev => {
          const out = { ...prev };
          MKT_0.forEach(k => { if (!held['0:' + k] && vals[k] !== undefined) out[k] = vals[k]; });
          // EM's provenance travels with EM: only restate it if EM itself refreshed.
          if (!held['0:em'] && vals.em !== undefined) {
            out.emSource = straddle ? 'straddle' : 'vix';
            out.straddleCall = straddle ? String(straddle.callPrice) : '';
            out.straddlePut = straddle ? String(straddle.putPrice) : '';
          }
          out.esDelayed = !!d.esDelayed;
          out.priceDelayed = !!d.priceDelayed;
          out.hours = hoursRounded > 0 ? hoursRounded : prev.hours;
          return out;
        });
      } else {
        // 45DTE: fill price and VIX now, then pull the vol surface (IV, IVR, HV,
        // IV Front/Back, Skew) behind it — not awaited, so the slow option fetch
        // never holds up the market fields. Freshness tag (dataFresh) is set above.
        setI45(prev => {
          const out = { ...prev };
          MKT_45.forEach(k => { if (!held['45:' + k] && vals[k] !== undefined) out[k] = vals[k]; });
          return out;
        });
        fetchVolSurface({ quiet: true, spot: vals.price });
      }
    } catch (e) {
      notify('Auto-fill failed: ' + e.message);
    }
    setAutoFilling(false);
  }

  function handlePrint() {
    const g = r.greeks;
    const underlying = is0 ? i0.underlying : i45.underlying;

    // Printed alongside the strikes so a filed summary says which position was taken,
    // not just where the strikes landed.
    var variantTxt = '';
    if (r.vertVariants) {
      var pv = r.vertVariants.find(function(x){ return x.id === (r.vertVariant || 'engine'); });
      if (pv) variantTxt = '<b>Position:</b> ' + pv.label
        + (pv.shift > 0 ? ' — slid ' + pv.shift.toFixed(2) + ' pts toward the money (1 × EM remaining), width unchanged' : ' — engine strikes')
        + (pv.rrCeil != null ? ' · max profit ≤ ' + pv.maxProfitCeil.toFixed(2) + ' against ' + pv.intrinsic.toFixed(2) + ' intrinsic (' + pv.rrCeil.toFixed(2) + ':1 ceiling)' : '');
    }

    const legsHtml = r.legs.map(function(l) {
      var isShort = l.label.toLowerCase().includes('short');
      var cls = isShort ? 'leg-short' : 'leg-long';
      var le = legExpiryOf(l);
      return '<span class="leg ' + cls + '">' + l.strike + (le ? ' \u00b7 ' + fmtExpiry(le) + ' ' + le.slice(0, 4) + ' (' + dteBetween(todayYmd, le) + 'd)' : '')
        + ' <span style="font-size:10px;font-weight:400;opacity:0.8">' + l.label + '</span></span>';
    }).join('');

    const criteriaHtml = r.criteria.map(function(c) {
      var pct = c.max > 0 ? Math.round(c.pts / c.max * 100) : 0;
      var col = pct >= 80 ? '#3fb950' : pct >= 50 ? '#2f81f7' : pct >= 30 ? '#d29922' : '#f85149';
      return '<div class="row"><span class="label">' + c.label + '</span><span class="value" style="color:' + col + '">' + c.pts + '/' + c.max + '</span></div>';
    }).join('');

    const warningsHtml = (r.warnings || []).map(function(w) {
      return '<div class="warn">\u26A0 ' + w + '</div>';
    }).join('');

    var greeksHtml = '';
    if (g) {
      var teCol = g.tEdge >= 0.15 ? 'green' : g.tEdge >= 0.05 ? 'amber' : 'red';
      var grCol = g.gRisk < 0.30 ? 'green' : g.gRisk < 0.70 ? 'amber' : 'red';
      var dsCol = g.dsATR > 0.50 ? 'green' : g.dsATR > 0.25 ? 'amber' : 'red';
      greeksHtml = '<div class="section"><div class="section-title">Trade Survivability</div>' +
        '<div class="row"><span class="label">Theta Edge</span><span class="value ' + teCol + '">' + g.tEdge.toFixed(3) + ' \u2014 ' + g.tEdgeSignal + '</span></div>' +
        '<div class="row"><span class="label">Gamma Risk</span><span class="value ' + grCol + '">' + g.gRisk.toFixed(3) + ' \u2014 ' + g.gRiskSignal + '</span></div>' +
        '<div class="row"><span class="label">Max tolerable move</span><span class="value ' + dsCol + '">' + g.dsMax.toFixed(1) + ' pts (' + (g.dsATR * 100).toFixed(0) + '% ATR) \u2014 ' + g.dsSignal + '</span></div>' +
        (g.sweetSpot ? '<div style="margin-top:6px;font-size:11px;color:#3fb950;font-weight:600">\uD83C\uDFAF SWEET SPOT</div>' : '') +
        '</div>';
    }

    var signalsHtml = '';
    if (is0) {
      signalsHtml = '<div class="row"><span class="label">Direction</span><span class="value ' + (r.dirScore > 0 ? 'green' : r.dirScore < 0 ? 'red' : 'white') + '">' + r.dirLabel + '</span></div>' +
        '<div class="row"><span class="label">Move consumed</span><span class="value white">' + (r.moveConsumed !== undefined ? (r.moveConsumed * 100).toFixed(0) + '%' : '--') + '</span></div>' +
        '<div class="row"><span class="label">Regime</span><span class="value white">' + r.regime + '</span></div>' +
        '<div class="row"><span class="label">VIX gap</span><span class="value white">' + (r.vixGap * 100).toFixed(1) + '% \u2014 ' + r.vixGrade + '</span></div>' +
        '<div class="row"><span class="label">Compression</span><span class="value white">' + (r.comp !== null ? r.comp.toFixed(2) : '--') + '</span></div>';
    } else {
      signalsHtml = '<div class="row"><span class="label">IVR</span><span class="value white">' + (r.ivrBand || '--') + '</span></div>' +
        '<div class="row"><span class="label">IV/HV</span><span class="value white">' + (r.ivhvRatio ? r.ivhvRatio.toFixed(2) : '--') + '</span></div>' +
        '<div class="row"><span class="label">Regime</span><span class="value white">' + r.regime + '</span></div>';
    }

    // Date and time on the summary, in ET — the session the trade belongs to, not the
    // browser's timezone. A filed summary with no timestamp is unfileable: two tickets
    // on the same underlying and structure are indistinguishable a week later, and the
    // printed date is also what the browser puts in the PDF filename by default.
    // The SESSION the trade belongs to, which after the close is not the same as the
    // calendar day in ET. Both go on the ticket: the session date is what files it,
    // the wall clock is what tells you when you looked at it, and when they disagree
    // saying so is the whole point.
    //
    // Oct 2026: the session is the TICKET's (logged, else when its tab was opened or
    // last priced live), not the print instant's. Printed after the close, a ticket
    // built during Monday's session was being dated Tuesday. Every time on the page
    // is New York time; the computer's own clock appears once, labelled.
    var _ses = ticketSession({ loggedAt: loggedAt, createdAt: createdAt,
      pricedAt: dataFresh && (dataFresh.pulledAt || dataFresh.asOf) });
    var _now = tradingSession();
    var _printDate = _ses.dateISO;
    var _sesLong = fmtSessionDate(_ses.dateISO);
    var _nowLong = fmtSessionDate(_now.etDateISO, { weekday: 'short', day: 'numeric', month: 'short' });
    var _localNow = new Date().toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
    var _basisTxt = { logged: 'logged ', opened: 'opened ', priced: 'priced ', now: '' }[_ses.basis] || '';
    var _basisAt = _ses.basis === 'logged' ? loggedAt : _ses.basis === 'opened' ? createdAt
      : _ses.basis === 'priced' ? (dataFresh && (dataFresh.pulledAt || dataFresh.asOf)) : null;
    var _basisClock = _basisAt ? tradingSession(new Date(_basisAt)).etTime + ' ET' : '';
    var _printStamp = (_basisTxt && _basisClock ? 'Ticket ' + _basisTxt + _basisClock + ' \u00b7 ' : '')
      + 'printed ' + _now.etTime + ' ET ' + _nowLong
      + ' \u00b7 your computer: ' + _localNow.replace(/,/g, '');

    var html = '<!DOCTYPE html><html><head><title>' + underlying + ' ' + effectiveStrat + ' — ' + _printDate + ' NY session</title>' +
      '<style>' +
      'body{font-family:-apple-system,sans-serif;max-width:700px;margin:40px auto;color:#e6edf3;background:#0d1117;padding:20px}' +
      'h1{font-size:22px;margin-bottom:4px}' +
      'h2{font-size:14px;color:#a8b2be;font-weight:400;margin-top:0}' +
      '.decision{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:' + dcColor + ';margin-bottom:4px}' +
      '.override{display:inline-block;font-size:10px;font-weight:600;padding:2px 8px;border-radius:4px;background:#9e6a03;color:#fff;margin-left:8px}' +
      '.section{margin-top:20px;padding-top:12px;border-top:1px solid #21262d}' +
      '.section-title{font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#a8b2be;margin-bottom:8px}' +
      '.row{display:flex;justify-content:space-between;padding:3px 0;font-size:13px}' +
      '.row .label{color:#a8b2be}.row .value{font-weight:600;font-family:monospace}' +
      '.green{color:#3fb950}.red{color:#f85149}.amber{color:#d29922}.white{color:#e6edf3}' +
      '.leg{display:inline-block;padding:4px 10px;border-radius:6px;font-size:12px;font-weight:700;font-family:monospace;margin:2px 4px 2px 0}' +
      '.leg-short{background:#8b2025;color:#f85149}.leg-long{background:#0d2818;color:#3fb950}' +
      '.warn{font-size:12px;color:#d29922;margin:2px 0}' +
      '.timestamp{font-size:11px;color:#8b949e;margin-top:24px}' +
      '@media print{body{background:#fff;color:#1a1a1a}.leg-long{color:#1a7f37}.leg-short{color:#cf222e}}' +
      '</style></head><body>' +
      '<div class="decision">' + effectiveDecision + (isOverride ? '<span class="override">MANUAL OVERRIDE</span>' : '') + '</div>' +
      '<h1>' + underlying + ' \u2014 ' + effectiveStrat + ' \u2014 ' + r.contracts + ' contract' + (r.contracts !== 1 ? 's' : '') + '</h1>' +
      '<div style="font-size:15px;font-weight:600;color:#c9d1d9;margin:2px 0 4px">' + _sesLong + ' \u00b7 New York session</div>' +
      '<div style="font-size:12px;color:#8b949e;margin-bottom:6px">' + _printStamp + '</div>' +
      '<h2>' + (is0 ? r.dirLabel : r.outlook || '') + ' \u2014 max loss $' + (r.maxRisk ? r.maxRisk.toFixed(0) : '0') + '</h2>' +
      (r.tradeConfidence != null ?
        '<div style="margin-top:12px;padding:12px 16px;border-radius:8px;background:' + confBg + ';border:1px solid ' + confClr + '">' +
          '<div style="display:flex;align-items:center;gap:12px">' +
            '<span style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#a8b2be">Trade Confidence</span>' +
            '<span style="font-size:22px;font-weight:800;font-family:monospace;color:' + confClr + '">' + r.tradeConfidence + '<span style="font-size:12px;color:#a8b2be">/100</span></span>' +
            '<span style="font-size:11px;font-weight:700;padding:2px 10px;border-radius:10px;background:' + confClr + ';color:#0d1117;text-transform:uppercase;letter-spacing:0.04em">' + r.confidenceTier + '</span>' +
          '</div>' +
          '<div style="font-size:12px;color:#c9d1d9;margin-top:5px">' + r.confidenceDriver + '</div>' +
          ((r.confConflicts && r.confConflicts.length) ?
            '<div style="margin-top:7px;display:flex;flex-wrap:wrap;gap:6px">' +
            r.confConflicts.map(function(c){
              return '<span title="' + c.label.replace(/"/g,'') + '" style="font-size:10px;font-weight:600;padding:2px 8px;border-radius:4px;background:' + (c.severity==='high'?'#3d1418':'#2a2410') + ';color:' + (c.severity==='high'?'#f85149':'#d29922') + '">\u26a0 ' + c.tag + '</span>';
            }).join('') + '</div>' : '') +
        '</div>' : '') +
      '<div style="display:flex;gap:20px;margin-top:8px;font-size:12px">' +
        '<div style="padding:6px 12px;border-radius:6px;background:' + sBg + ';border:1px solid ' + sClr + '">' +
          '<span style="color:#a8b2be">Setup Quality</span> <span style="color:' + sClr + ';font-weight:700;font-family:monospace">' + r.setup + ' ' + r.setupScore + '/100</span>' +
        '</div>' +
        '<div style="padding:6px 12px;border-radius:6px;background:#161b22;border:1px solid #30363d">' +
          '<span style="color:#a8b2be">Adj Kelly</span> <span style="color:' + (r.kellyOverRisk ? '#f85149' : '#3fb950') + ';font-weight:700;font-family:monospace">$' + (r.kellyDollar ? r.kellyDollar.toFixed(0) : '0') + ' (' + (r.adjustedKelly ? (r.adjustedKelly*100).toFixed(1) : '0') + '%)</span>' +
        '</div>' +
        '<div style="padding:6px 12px;border-radius:6px;background:#161b22;border:1px solid #30363d">' +
          '<span style="color:#a8b2be">Fair Value</span> <span style="color:' + (r.fairValueScore >= 80 ? '#3fb950' : r.fairValueScore >= 70 ? '#d29922' : '#f85149') + ';font-weight:700;font-family:monospace">' + r.fairValueScore + '/100 ' + r.fairValueGrade + '</span>' +
        '</div>' +
        '<div style="padding:6px 12px;border-radius:6px;background:#161b22;border:1px solid #30363d">' +
          '<span style="color:#a8b2be">Score</span> <span style="color:' + dcColor + ';font-weight:700;font-family:monospace">' + compositeScore + '/100</span>' +
        '</div>' +
      '</div>' +
      (warningsHtml ? '<div style="margin-top:10px;padding:8px 12px;background:#1f1a0d;border:1px solid #9e6a03;border-radius:6px">' + warningsHtml + '</div>' : '') +
      '<div style="margin-top:12px">' + legsHtml + '</div>' +
      (variantTxt ? '<div style="font-size:11px;color:#a8b2be;margin-top:4px">' + variantTxt + '</div>' : '') +
      (r.wingTxt ? '<div style="font-size:11px;color:#a8b2be;margin-top:4px">' + r.wingTxt + '</div>' : '') +
      (is0 && r.holdToExpiry ? '<div style="font-size:11px;color:#a8b2be;margin-top:4px"><b>Expiry:</b> ' + r.holdToExpiry.label + ' — ' + r.holdToExpiry.note + '</div>' : '') +
      (r.behaviour ? '<div style="font-size:12px;color:#a8b2be;margin-top:8px;font-style:italic">Profit if: ' + r.behaviour + '</div>' : '') +
      '<div class="section"><div class="section-title">Setup Quality</div>' + criteriaHtml + '</div>' +
      (r.payoff ? '<div class="section"><div class="section-title">Payoff at Expiry</div>' +
      '<div class="row"><span class="label">Max profit</span><span class="value green">$' + r.payoff.maxProfit.toFixed(0) + '</span></div>' +
      '<div class="row"><span class="label">Max loss</span><span class="value red">$' + r.payoff.maxLoss.toFixed(0) + '</span></div>' +
      '<div class="row"><span class="label">Breakeven(s)</span><span class="value white">' + (r.payoff.breakevens.length > 0 ? r.payoff.breakevens.map(function(b){return b.toFixed(1)}).join(', ') : '--') + '</span></div>' +
      '<div class="row"><span class="label">Profit band</span><span class="value white">' + (r.payoff.profitBandWidth > 0 ? r.payoff.profitBandLow.toFixed(0) + '\u2013' + r.payoff.profitBandHigh.toFixed(0) + ' (' + r.payoff.profitBandWidth.toFixed(0) + ' pts)' : '--') + '</span></div>' +
      '</div>' : '') +
      (r.priceCheck ? '<div class="section"><div class="section-title">Entry Price</div>' +
        '<div class="row"><span class="label">' + (r.priceCheck.cost >= 0 ? 'Paying' : 'Receiving') +
          '</span><span class="value white">' + Math.abs(r.priceCheck.cost).toFixed(2) + '</span></div>' +
        '<div class="row"><span class="label">Modelled fair at spot</span><span class="value white">' +
          r.priceCheck.fair.toFixed(2) + '</span></div>' +
        '<div class="row"><span class="label">Possible range for these strikes</span><span class="value white">' +
          r.priceCheck.bareMin.toFixed(2) + ' to ' + r.priceCheck.bareMax.toFixed(2) + '</span></div>' +
        (r.priceCheck.ratio != null
          ? '<div class="row"><span class="label">vs fair</span><span class="value ' +
            (r.priceCheck.ratio >= 1.30 ? 'red' : r.priceCheck.ratio >= 1.15 ? 'amber' : 'green') + '">' +
            r.priceCheck.ratio.toFixed(2) + '\u00d7' +
            (r.priceCheck.ratio > 1.05 ? ' \u2014 must appreciate ' + (r.priceCheck.cost - r.priceCheck.fair).toFixed(2) + ' to break even' : '') +
            '</span></div>'
          : '') +
        '</div>' : '') +
      // When the value arrives. A printed ticket that shows the payoff but not its
      // timing invites exactly the plan that collects a tenth of it.
      (accrual ? '<div class="section"><div class="section-title">When the Value Arrives ('
        + accrual.sessionsLeft.toFixed(2) + ' sessions left, body ' + accrual.bodyStrike + ')</div>' +
        (accrual.outToday && accrual.outToday.pct != null
          ? '<div class="row"><span class="label">Out at today\u2019s 15:00</span><span class="value '
            + (accrual.outToday.pct >= 60 ? 'green' : accrual.outToday.pct >= 30 ? 'amber' : 'red') + '">'
            + accrual.outToday.pct.toFixed(0) + '% of the move \u2014 ' + accrual.outToday.verdict + '</span></div>'
          : '') +
        accrual.rows.map(function (row, i) {
          return '<div class="row"><span class="label">' + row.label + '</span><span class="value white">'
            + row.atBody.toFixed(2) + ' (' + (row.pctOfMax == null ? '--' : row.pctOfMax.toFixed(0) + '%')
            + ')' + (i && row.shareOfRemaining != null ? ' \u00b7 ' + row.shareOfRemaining.toFixed(0) + '% of the move' : '')
            + '</span></div>';
        }).join('') +
        '</div>' : '') +
      '<div class="section"><div class="section-title">Sizing (Sharpe-Adjusted Kelly)</div>' +
      '<div class="row"><span class="label">Contracts</span><span class="value white">' + r.contracts + '</span></div>' +
      '<div class="row"><span class="label">Adj Kelly $</span><span class="value ' + (r.kellyOverRisk ? 'red' : 'green') + '">$' + (r.kellyDollar ? r.kellyDollar.toFixed(0) : '0') + '</span></div>' +
      '<div class="row"><span class="label">Raw Kelly</span><span class="value white">' + (r.rawKelly ? (r.rawKelly*100).toFixed(1) : '0') + '%' + (r.sizingModel === 'full' ? ' (45DTE: not adjusted)' : '') + '</span></div>' +
      '<div class="row"><span class="label">Vol factor</span><span class="value white">' + (r.volFactor ? r.volFactor.toFixed(2) : '--') + '</span></div>' +
      '<div class="row"><span class="label">Sharpe factor</span><span class="value white">' + (r.sharpeFactor ? r.sharpeFactor.toFixed(2) : '--') + '</span></div>' +
      '<div class="row"><span class="label">EV / trade' + (r.evBasis ? ' <span style="opacity:0.6;font-size:9px">(' + (r.evBasis.mode==='measured'?'measured':'est') + ')</span>' : '') + '</span><span class="value ' + (r.ev > 0 ? 'green' : 'red') + '">$' + (r.ev ? r.ev.toFixed(0) : '0') + '</span></div>' +
      '<div class="row"><span class="label">POP margin</span><span class="value ' + (r.popMargin >= 1.5 ? 'green' : r.popMargin >= 1.0 ? 'amber' : 'red') + '">' + (r.popMargin ? r.popMargin.toFixed(2) : '--') + 'x</span></div>' +
      '</div>' +
      greeksHtml +
      '<div class="section"><div class="section-title">Fair Value Score — ' + r.fairValueScore + '/100 (' + r.fairValueGrade + ')</div>' +
      '<div class="row"><span class="label">Volatility (IV/HV)</span><span class="value white">' + r.volScore + '/100 — ' + r.volGrade + '</span></div>' +
      '<div class="row"><span class="label">Structure</span><span class="value white">' + r.structScore + '/100 — ' + r.structGrade + '</span></div>' +
      '<div class="row"><span class="label">Regime</span><span class="value white">' + r.regimeScore + '/100 — ' + r.regimeGrade + '</span></div>' +
      '</div>' +
      '<div class="section"><div class="section-title">Signals</div>' + signalsHtml + '</div>' +
      '<div class="timestamp">Generated ' + new Date().toLocaleString('en-AU') + ' \u2014 Options Tracker Decision Engine</div>' +
      '</body></html>';

    var win = window.open('', '_blank');
    if (win) {
      win.document.write(html);
      win.document.close();
      win.focus();
      setTimeout(function() { win.print(); }, 500);
    }
  }

  // Build a condensed plain-text summary of the engine's analysis for the notes
  // field — captures what the setup looked like at trade time.
  // Confidence chips and the warnings/notices stack. Rendered under the price map when
  // there is one (so the strikes get the left column to themselves), else in the left
  // column. (Oct 2026.)
  function renderSideStack() {
    return (<div style={{display:'flex',flexDirection:'column',gap:10}}>
            {!r.hardBlocker && (
              <div style={{display:'flex',flexWrap:'wrap',gap:8,alignItems:'center'}}>
                {r.tradeConfidence != null && (
                  <span title={r.confidenceDriver}
                    style={{display:'inline-flex',alignItems:'center',gap:6,padding:'4px 10px',borderRadius:6,background:'rgba(255,255,255,0.05)',fontSize:13,color:'#e6edf3'}}>
                    <span style={{width:7,height:7,borderRadius:'50%',background:confClr}} />
                    Confidence: {String(r.confidenceTier || '').toLowerCase()} <span className="mono" style={{color:'#8b949e'}}>{r.tradeConfidence}</span>
                  </span>
                )}
                {(r.confConflicts || []).map((c,i) => (
                  <span key={i} title={c.label} style={{fontSize:12.5,fontWeight:600,padding:'4px 9px',borderRadius:6,
                    background:c.severity==='high'?'#3d1418':'#2a2410',color:c.severity==='high'?'#f85149':'#d29922'}}>⚠ {c.tag}</span>
                ))}
              </div>
            )}

        {/* Zone 3b — blockers, warnings and notices (Aug 2026)
            These existed in the engine from the start but were rendered NOWHERE on the
            ticket: they reached only the Print summary and the logged trade notes, so
            every warning the engine raised was invisible at the moment of the decision.
            Three tiers, because they mean different things:
              blockers — the trade is not takeable as configured
              warnings — takeable, but they downgrade the decision
              notices  — facts about the DATA, never about the trade; they never gate */}
        {(r.warnings?.length > 0 || r.notices?.length > 0) && (() => {
          const warns = r.warnings || [], notes = r.notices || [];
          const isEventW = w => /FOMC|CPI|payroll|Employment|PPI|PCE|ISM|minutes|released|lands (INSIDE|after)|before expiry|final week/i.test(w);
          const nEvent = warns.filter(isEventW).length;
          const nWarn = warns.length - nEvent;
          const parts = [];
          if (nWarn) parts.push(`\u26a0 ${nWarn} warning${nWarn > 1 ? 's' : ''}`);
          if (nEvent) parts.push(`\ud83d\udcc5 ${nEvent} event${nEvent > 1 ? 's' : ''}`);
          if (notes.length) parts.push(`${notes.length} notice${notes.length > 1 ? 's' : ''}`);
          return (
          <div style={{display:'flex',flexDirection:'column',gap:6}}>
            {showAdvisories && r.warnings?.map((w,i) => {
              // Event warnings earn a distinct colour: they are the only ones that are
              // about the calendar rather than the structure, and they are actionable
              // in a different way — you wait, or you size down, you do not re-strike.
              const isEvent = /FOMC|CPI|payroll|Employment|PPI|PCE|ISM|minutes|released|lands (INSIDE|after)|before expiry|final week/i.test(w);
              return (
                <div key={'w'+i} style={{fontSize:13,lineHeight:1.45,padding:'6px 10px',borderRadius:6,
                  background: isEvent ? '#1a1726' : '#1f1a0d',
                  border:`1px solid ${isEvent ? '#4b3f7a' : '#9e6a03'}`,
                  color: isEvent ? '#b9a7ff' : '#d29922'}}>
                  {isEvent ? '📅' : '⚠'} {w}
                </div>
              );
            })}
            {showAdvisories && r.notices?.map((n,i) => (
              <div key={'n'+i} title="A fact about the calendar data, not about this trade — it does not affect the decision."
                style={{fontSize:12.5,lineHeight:1.45,padding:'5px 10px',borderRadius:6,
                  background:'#0d1117',border:'1px solid #21262d',color:'#a8b2be'}}>
                {n}
              </div>
            ))}
            {parts.length > 0 && (
              <div onClick={() => setShowAdvisories(v => !v)} role="button" tabIndex={0}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setShowAdvisories(v => !v); }}
                title={showAdvisories ? 'Collapse' : parts.join(' \u00b7 ')}
                style={{fontSize:12.5,lineHeight:1.45,padding:'5px 10px',borderRadius:6,cursor:'pointer',
                  userSelect:'none',background:'#161b22',border:'1px solid #30363d',color:'#a8b2be',
                  display:'flex',alignItems:'center',gap:8}}>
                <span style={{color:'#a8b2be'}}>{showAdvisories ? '\u25be' : '\u25b8'}</span>
                <span>{parts.join(' \u00b7 ')}</span>
                <span style={{marginLeft:'auto',color:'#8b949e'}}>{showAdvisories ? 'hide' : 'show'}</span>
              </div>
            )}
          </div>
          );
        })()}
    </div>);
  }

  function buildTradeSummary() {
    const inp = is0 ? i0 : i45;
    const ncd = parseFloat(inp.netCreditDebit) || 0;
    const lines = [];
    lines.push(`${inp.underlying} — ${effectiveStrat} — ${r.contracts}x  [${is0?'0DTE':'45DTE'}]`);
    lines.push(`Setup: ${r.setup} ${r.setupScore}/100 · Composite ${compositeScore}/100 · FV ${r.fairValueScore}/100 (${r.fairValueGrade})`);
    if (r.tradeConfidence != null) {
      lines.push(`Confidence: ${r.tradeConfidence}/100 (${r.confidenceTier}) — ${r.confidenceDriver}`);
      if (r.confConflicts?.length) lines.push(`Conflicts: ${r.confConflicts.map(c=>c.tag).join(', ')}`);
    }
    if (isOverride) lines.push(`Override: engine picked ${r.bestStrat}, logged ${effectiveStrat}`);
    // Which vertical position was actually traded. Without this the log cannot tell an
    // ITM-shifted spread from the engine's own — the strikes alone do not say why.
    if (r.vertVariants) {
      const v = r.vertVariants.find(x => x.id === (r.vertVariant || 'engine'));
      if (v) lines.push(`Position: ${v.label}${v.shift > 0 ? ` — slid ${v.shift.toFixed(2)} pts toward the money (1 × EM remaining), width unchanged` : ' — engine strikes'}`
        + (v.rrCeil != null ? ` · max profit ≤ ${v.maxProfitCeil.toFixed(2)} against ${v.intrinsic.toFixed(2)} intrinsic (${v.rrCeil.toFixed(2)}:1 ceiling)` : ''));
    }
    lines.push(`Strikes: ${r.legs.map(l=>`${l.strike} ${l.label}`).join(' | ')}`);
    if (Array.isArray(r.engineLegs) && r.engineLegs.length === r.legs.length
        && r.legs.some((l,i)=>l.strike!==r.engineLegs[i].strike)) {
      lines.push(`Engine strikes (${strikesBuiltBy === 'Delta' ? 'EM, before delta strikes' : 'before hand edits'}): ${r.engineLegs.map(l=>l.strike).join(' / ')}`);
    }
    if (r.deltaCheck && r.deltaCheck.applicable) {
      const dc = r.deltaCheck;
      lines.push(`Strikes by: ${strikesBuiltBy}${strikesBuiltBy === 'Delta' && !(deltaApplied && deltaApplied.confirmed) ? ' (estimated)' : ''}`
        + (dc.haveGreeks ? ` · short deltas ${shortDeltaSummary(dc)}` : ' · short deltas not fetched')
        + (dc.impliedPop != null ? ` · POP by delta ~${(dc.impliedPop * 100).toFixed(0)}%` : '')
        + (dc.suspended ? ' · delta check off (final hour)' : ''));
    }
    if (r.skewNote) lines.push(r.skewNote);
    if (is0 && r.holdToExpiry) lines.push(`Expiry: ${r.holdToExpiry.label} — ${r.holdToExpiry.note}`);
    lines.push(`${ncd>0?`Credit $${ncd.toFixed(2)}`:ncd<0?`Debit $${Math.abs(ncd).toFixed(2)}`:''} · POP ${inp.pop||'--'}% · Win $${inp.win||'--'} · Risk $${inp.risk||'--'}`);
    lines.push(`Sizing: Kelly ${(r.adjustedKelly*100).toFixed(1)}% · ${r.contracts} contract${r.contracts!==1?'s':''} · EV $${r.ev?.toFixed(0)||0}${r.ev<0?' (negative)':''}`);
    if (r.evBasis?.pMaxLoss != null) lines.push(`P(max loss): ${(r.evBasis.pMaxLoss*100).toFixed(1)}% (${r.evBasis.pMaxLossSource||'model'})`);
    if (r.evBasis?.winBreakeven != null) lines.push(`Win needed for EV=0: $${r.evBasis.winBreakeven}`);
    // Key signals
    if (is0) {
      lines.push(`Signals: ${r.dirLabel} · ${r.trendPattern||'--'} · Regime ${r.regime} · Move ${r.moveConsumed!==undefined?(r.moveConsumed*100).toFixed(0)+'%':'--'} · VIX gap ${(r.vixGap*100).toFixed(1)}%`);
    } else {
      lines.push(`Signals: IVR ${r.ivrBand||'--'} · IV/HV ${r.ivhvRatio?r.ivhvRatio.toFixed(2):'--'} · Regime ${r.regime}`);
    }
    if (r.greeks) lines.push(`Survivability: ${r.greeks.thetaPaid ? 'Decay cost' : 'Theta edge'} ${r.greeks.tEdge.toFixed(2)} (${r.greeks.tEdgeSignal}) · Gamma ${r.greeks.gRisk.toFixed(2)}${r.greeks.thetaPaid ? ' · PAYS decay' : ''}`);
    if (r.warnings?.length) lines.push(`Warnings: ${r.warnings.join('; ')}`);
    return lines.filter(Boolean).join('\n');
  }

  // Log flow (Aug 2026): the old window.prompt is now an inline note input next
  // to the Log button. Confirm (button or Enter) logs the trade with the note;
  // Cancel or Escape closes the input and nothing is logged — the same abort
  // semantics the prompt's Cancel had, but without a blocking modal, and the
  // half-typed note is only lost, never the ticket.
  function handleLog() {
    if (!onLogTrade) return;
    if (!accountConfig?.id) {
      notify('Please select a specific account in the sidebar before logging a trade.');
      return;
    }
    setLogNote('');
    setLogNoteOpen(true);
  }
  // Fingerprint of what is on the ticket right now. Compared against the one captured
  // at log time so the "Logged" badge disappears the moment the ticket stops being the
  // trade that was written.
  const ticketSig = `${effectiveStrat}|${r.legs.map(l => l.strike).join('/')}|${r.contracts}|${ticketNet}`;
  const isLogged = !!loggedAt && loggedSig === ticketSig;

  function confirmLog() {
    const inp = is0 ? i0 : i45;
    const engineSummary = buildTradeSummary();
    // One timestamp for the row AND the saved exit plan — it is the key the Sell
    // ticket looks the plan up by.
    const logTs = new Date().toISOString();
    const ncdNow = fv(inp, 'netCreditDebit');
    const ncdSigned = signedNet(inp.netCreditDebit, cashType);
    const planPos = normalisePosition({ qty: r.contracts, qtyOpen: r.contracts, entryPrice: isFinite(ncdSigned) ? ncdSigned : ncdNow,
      maxProfit: fv(inp, 'win') ? r.contracts * fv(inp, 'win') : '', basis: (exitPlan && exitPlan.basis) || exitRuleFor(is0 ? '0DTE' : '45DTE', effectiveStrat).basis });
    const planBlock = (exitPlan && exitPlan.rows?.length && ncdNow)
      ? '\n\n' + planText(planPos, exitPlan.rows, exitPlan.stopPct) : '';
    const expiriesLine = isTimeSpread && nearExp && farExp
      ? `Expiries: sell ${fmtExpiry(nearExp)} ${nearExp.slice(0, 4)} (${dteBetween(todayYmd, nearExp)}d) / buy ${fmtExpiry(farExp)} ${farExp.slice(0, 4)} (${dteBetween(todayYmd, farExp)}d)\n`
      : '';
    // Legs with side, right and expiry (Oct 2026), so the 45DTE check-up can find the
    // position when TWS has no match (the Wing Strikes column is strikes only).
    // A 45DTE expiry here is the one PLANNED from the DTE unless the chain set it.
    const legsLine = !is0 && r.legs && r.legs.length ? 'Legs: ' + r.legs.map(l => {
      const lb = String(l.label || '').toLowerCase();
      const q = (/short|sell/.test(lb) ? -1 : 1) * (/x2\b/.test(lb) ? 2 : 1);
      return `${q > 0 ? '+' : '-'}${Math.abs(q)} ${l.strike}${lb.includes('put') ? 'P' : 'C'} ${legExpiryOf(l) || deriveExpiryYYYYMMDD()}`;
    }).join(' / ') + '\n' : '';
    const fullNotes = expiriesLine + legsLine + engineSummary + planBlock
      + '\n\n--- My notes ---\n'
      + (logNote.trim() || '(none)');
    setLogNoteOpen(false);
    setLogging(true);
    const sigAtLog = ticketSig;
    // onLogTrade resolves true only when the sheet confirmed the write, so "Logged"
    // never appears over a write that did not happen.
    Promise.resolve(onLogTrade({ engine:is0?'0DTE':'45DTE', underlying:inp.underlying,
      strategy:`${inp.underlying} - ${effectiveStrat} - ${r.contracts} contract${r.contracts!==1?'s':''}`,
      direction:effectiveDecision, contracts:r.contracts, kellyDollar:`$${r.kellyDollar?.toFixed(0)||0}`,
      popMargin:r.popMargin?`${r.popMargin.toFixed(2)}x`:'', setupScore:`${r.setupScore}/100`,
      setupGrade:r.setup, regime:r.regime, wingStrikes:r.legs.map(l=>l.strike).join(' / '),
      // Dual strike record: wingStrikes above is the FINAL legs (hand edits
      // included); engineStrikes is what the engine itself suggested. Identical
      // when nothing was edited.
      engineStrikes:((r.engineLegs && r.engineLegs.length ? r.engineLegs : r.legs).map(l=>l.strike).join(' / ')),
      // R-49: which method built the strikes, the shorts' live deltas, and the POP
      // those deltas imply — so the review can compare EM-built and delta-built trades.
      strikeMethod: strikesBuiltBy + (strikesBuiltBy === 'Delta' && !(deltaApplied && deltaApplied.confirmed) ? ' (estimated)' : ''),
      shortDeltas: r.deltaCheck && r.deltaCheck.haveGreeks ? shortDeltaSummary(r.deltaCheck) : '',
      impliedPop: r.deltaCheck && r.deltaCheck.impliedPop != null ? (r.deltaCheck.impliedPop * 100).toFixed(0) : '',
      marketBehaviour:r.behaviour,
      notes: fullNotes,
      price:fv(inp,'price'), vix:fv(inp,'vix'),
      vix1d:is0?fv(inp,'vix1d'):0, iv:is0?0:fv(inp,'iv'), ivr:is0?0:fv(inp,'ivr'),
      em:is0?fv(inp,'em'):0, timestamp:logTs,
      // Expiry-specific IV at log time (IVx Open, col AR): the per-leg average
      // from Fetch Greeks when it ran; 45DTE falls back to the typed IV. Blank
      // when nothing is known — never a fake zero.
      ivxOpen: (inp.ivx || (is0 ? '' : inp.iv) || ''),
      account: accountConfig?.id || '',
      // Open position greeks (already populated by Fetch Greeks or entered manually)
      delta:fv(inp,'delta'), theta:fv(inp,'theta'),
      gamma:fv(inp,'gamma'), vega:fv(inp,'vega'),
      // The trade as priced, and the engine's own verdict on it. Logged so a month of
      // reviews is a query rather than a stack of ticket PDFs. (Aug 2026.)
      netCreditDebit: fv(inp, 'netCreditDebit'),
      maxRisk: r.maxRisk ?? '',
      maxProfit: (r.contracts && fv(inp, 'win')) ? r.contracts * fv(inp, 'win') : '',
      ev: r.ev != null ? Math.round(r.ev) : '',
      confidence: r.tradeConfidence != null ? `${r.tradeConfidence}/100 ${r.confidenceTier}` : '',
      pMaxLoss: r.pMaxLoss != null ? `${(r.pMaxLoss * 100).toFixed(1)}%` : '',
      pMaxLossBasis: r.pMaxLossBasis
        ? `${r.pMaxLossBasis.emSrc} EM ${r.pMaxLossBasis.em.toFixed(1)} \u2192 \u03c3 ${r.pMaxLossBasis.sigma.toFixed(1)}`
        : '',
      cushionEM: r.holdToExpiry?.cushionEM != null ? r.holdToExpiry.cushionEM.toFixed(2) : '',
      // ── VWAP inputs and reads, persisted (Aug 2026) ──
      // Nothing VWAP-derived used to reach the sheet, so no logged trade could
      // ever be re-scored against a changed VWAP rule — the reason the Aug 2026
      // rework could not be validated against 11 weeks of history. These six
      // columns make the next such change answerable with a query instead of a
      // rebuild. Raw inputs first (so any future rule can be recomputed), then
      // the reads this build produced (so old and new can be compared directly).
      vwapAnchored: is0 ? fv(inp, 'vwap5') : '',
      vwapRoll30: is0 ? fv(inp, 'vwapRoll30') : '',
      vwapRoll30Prior: is0 ? fv(inp, 'vwapRoll30Prior') : '',
      vwapAccept: is0 && inp.vwapAccept !== '' && inp.vwapAccept != null ? inp.vwapAccept : '',
      vwapTrend: is0 ? `${r.slope}${r.slopeDirection && r.slopeDirection !== 'flat' ? ` ${r.slopeDirection}` : ''}`
        + `${r.slope5?.shiftEM != null ? ` ${r.slope5.shiftEM >= 0 ? '+' : ''}${r.slope5.shiftEM.toFixed(2)}EM30` : ''}`
        + `${r.confirmed ? ' confirmed' : r.diverges ? ' diverges' : ''}` : '',
      vwapDistEM: is0 && r.vwapDistPctEM ? `${(r.vwapDistPctEM * 100).toFixed(0)}%` : '',
      // Expiry info for tracking
      dte: is0 ? '0DTE' : '45DTE',
      // The SESSION's expiry, not the UTC calendar date — logged from an Australian
      // morning the latter is the expiry that has already expired. Close dates
      // elsewhere in the app deliberately keep the UTC date: a close looks BACK at the
      // session that just ended, which is the one the UTC date already names.
      expiryDate: is0 ? tradingSession().dateISO : isoFromYmd(deriveExpiryYYYYMMDD())
    }))
      .then(ok => {
        // Strictly true. A rejection, an explicit false, or a host that returns nothing
        // all leave the button alone — "Logged" is a claim about the sheet, so it needs
        // the sheet to have said yes, not merely the absence of a no.
        if (ok !== true) return;
        if (exitPlan && exitPlan.rows?.length) savePlan(logTs, { ...exitPlan, openAtSave: r.contracts });
        setLoggedAt(Date.now());
        setLoggedSig(sigAtLog);
      })
      .finally(() => setLogging(false));
  }

  // ES overnight reference-date labels (ET). ES trades ~23h, so "close"/"open" are
  // reference times, not real session boundaries: prior close = prior weekday 16:00,
  // pre-open = today 08:45.
  const _nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const _esPreDate = _nowET;
  const _esPriorDate = new Date(_nowET);
  _esPriorDate.setDate(_esPriorDate.getDate() - 1);
  const _pdow = _esPriorDate.getDay();
  if (_pdow === 0) _esPriorDate.setDate(_esPriorDate.getDate() - 2);
  else if (_pdow === 6) _esPriorDate.setDate(_esPriorDate.getDate() - 1);
  const _fmtDM = (dt) => dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  // Bridge-supplied labels win: they name the bar each value was read from. The
  // date-arithmetic ones are only a fallback for old bridges / snapshot mode.
  const esBars = esMeta && esMeta.source === 'bars';
  const esPriorCloseLabel = esBars && esMeta.prior ? `ES ${esMeta.prior}` : `ES ${_fmtDM(_esPriorDate)} 16:00`;
  const esPreOpenLabel = esBars && esMeta.pre ? `ES ${esMeta.pre}` : `ES ${_fmtDM(_esPreDate)} 08:45`;

  return (
    <div className="space-y-4" ref={panelRef}>
      {/* Condensed ticket — only while the full block is scrolled past. display:none
          when idle so it takes no space and creates no gap in the space-y stack. */}
      <div style={{position:'sticky',top:48,zIndex:10,display:ticketStuck?'block':'none',
        margin:'0 -4px',padding:'8px 12px',borderRadius:10,
        background:'rgba(13,17,23,0.94)',backdropFilter:'blur(8px)',
        border:`1px solid ${dcBorder}`,boxShadow:'0 6px 18px rgba(0,0,0,0.45)'}}>
        <div style={{display:'flex',alignItems:'center',gap:14,flexWrap:'nowrap',
          overflowX:'auto',fontSize:13,whiteSpace:'nowrap'}}>
          <span style={{fontWeight:700,color:dcColor}}>
            {secBag.underlying} · {effectiveStrat} · {r.contracts}x
          </span>
          <span className="mono" style={{color:'#a8b2be'}}>
            {r.legs?.map(l => l.strike).join(' / ')}
          </span>
          <span style={{marginLeft:'auto',display:'flex',gap:14,alignItems:'baseline'}}>
            <span className="mono"><span style={{color:'#a8b2be',fontSize:11}}>COMP </span>
              <span style={{color:dcColor,fontWeight:700}}>{compositeScore}</span></span>
            <span className="mono"><span style={{color:'#a8b2be',fontSize:11}}>EV </span>
              <span style={{color:r.ev>0?'#3fb950':'#f85149',fontWeight:700}}>
                ${Math.round(r.ev||0)}</span></span>
            <span className="mono"><span style={{color:'#a8b2be',fontSize:11}}>KELLY </span>
              <span style={{fontWeight:700}}>${Math.round(r.kellyDollar||0)}</span></span>
            {r.tradeConfidence != null && (
              <span className="mono"><span style={{color:'#a8b2be',fontSize:11}}>CONF </span>
                <span style={{color:dcColor,fontWeight:700}}>{r.tradeConfidence}</span></span>
            )}
          </span>
        </div>
      </div>
      {/* ── 1 · VERDICT BAND (Oct 2026 redesign) ──
          One verdict, one score, one sentence of why. Everything that used to sit
          here as tiles now lives on the trade-choice cards or in the evidence
          drawer below, so the band only ever answers "do I trade this?". */}
      <div ref={decisionRef} data-testid="verdict-band"
        style={{background:vTone.bg,border:`1px solid ${vTone.border}`,borderRadius:14,padding:'20px 24px'}}>
        <div style={{display:'flex',gap:24,alignItems:'flex-start',flexWrap:'wrap'}}>
          <div style={{flex:'1 1 420px',minWidth:0,display:'flex',flexDirection:'column',gap:12}}>
            <div style={{display:'flex',alignItems:'center',gap:18}}>
              <EdgeRing score={compositeScore} color={vTone.color} label={missingInputs ? 'SETUP' : 'EDGE'}
                dim={!!r.hardBlocker}
                title={missingInputs
                  ? 'Setup quality only — the edge score needs win, risk and POP.'
                  : 'Composite edge score: setup quality blended with Kelly, vol, Sharpe, POP margin and EV per unit of risk. The same number ranks the trade tabs.'} />
              <div style={{display:'flex',flexDirection:'column',gap:4,minWidth:0}}>
                <span style={{fontSize:12,fontWeight:600,letterSpacing:'0.08em',textTransform:'uppercase',color:vTone.color}}>Engine verdict</span>
                <span data-testid="verdict" style={{fontSize:30,fontWeight:700,lineHeight:1.08,color:'#fff',letterSpacing:'-0.01em'}}>{verdict.word}</span>
                <span style={{fontSize:15,color:'#e6edf3',display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
                  {r.hardBlocker ? <span style={{color:'#a8b2be'}}>{verdict.sub}</span> : <>
                    <span>{secBag.underlying} · {effectiveStrat}{missingInputs ? '' : <> · <span className="mono">{r.contracts}</span>x</>}</span>
                    {(() => {
                      const net = parseFloat(ticketNet);
                      const hasNet = !isNaN(net) && net !== 0;
                      const label = cashType === 'credit' ? 'CREDIT' : cashType === 'debit' ? 'DEBIT' : 'CREDIT / DEBIT';
                      const bg = cashType === 'credit' ? '#0d2818' : cashType === 'debit' ? '#2d1a0d' : '#1c2128';
                      const fg = cashType === 'credit' ? '#3fb950' : cashType === 'debit' ? '#e3a008' : '#a8b2be';
                      const hint = hasNet ? ` ${net > 0 ? '+' : '−'}$${Math.abs(net).toFixed(2)}` : '';
                      return <span title={cashType==='varies' ? 'This structure can be credit or debit — enter the net to resolve' : (cashType==='credit'?'You collect premium at entry':'You pay premium at entry')}
                        style={{fontSize:12,fontWeight:700,padding:'2px 8px',borderRadius:4,background:bg,color:fg,letterSpacing:'0.04em'}}>{label}{hint}</span>;
                    })()}
                    {isOverride && <span style={{fontSize:12,fontWeight:600,padding:'2px 8px',borderRadius:4,background:'#9e6a03',color:'#fff'}}>MANUAL OVERRIDE</span>}
                  </>}
                </span>
              </div>
            </div>

            {!r.hardBlocker && (
              <div style={{fontSize:14.5,lineHeight:1.5,color:'#c9d1d9',maxWidth:'72ch'}}>
                <span style={{color:'#fff',fontWeight:600}}>{is0
                  ? `${r.dirLabel || '—'} · ${r.trendPattern || '—'}`
                  : `${String(i45.outlook || 'neutral').replace(/^./, ch => ch.toUpperCase())} outlook`}</span>
                {skewClause ? ` — ${skewClause}.` : '.'}
                {r.behaviour ? <> Profits if: {r.behaviour}</> : null}
              </div>
            )}

        {/* Zone 1b — strike chips (compact mono) with wing-distance appended inline */}
        {r.legs.length > 0 && (
          <div style={{marginTop:8}}>
            {/* Vertical position variants. Picking one rebuilds the structure as a single
                unambiguous two-leg spread and everything downstream — EV, P(max loss),
                Kelly, payoff, Log trade, Print summary — recomputes from it. `rr` is a
                CEILING derived from the long leg's intrinsic value, so the real fill is
                worse; it is shown because the engine cannot price the debit and the cost
                of shifting into the money is otherwise invisible until the fill. */}
            {r.vertVariants && (
              <StrikeChoices variants={r.vertVariants} active={strikesBuiltBy === 'Delta' ? 'delta' : strikesBuiltBy === 'Manual' ? null : (r.vertVariant || 'engine')}
                strat={r.legStrat} plan={r.deltaPlan} check={r.deltaCheck} emRem={r.emRemaining}
                onPick={chooseVertical} fetching={fetchingGreeks || applyingDelta} deltaDefault={vertPick !== 'em'} />
            )}
            {false ? (
              <div />            ) : (
              // The trade on one line, low strike to high, order-ticket style
              // (+751P −2×754P +756P). Wing distance moves to the ⓘ tooltip. (Oct 2026.)
              <div data-testid="strike-line" style={{display:'flex',flexWrap:'nowrap',gap:6,alignItems:'center',minWidth:0}}>
                {r.legs.map((l,i) => ({ l, i })).sort((a, b) => (a.l.strike - b.l.strike)
                  || String(legExpiryOf(a.l) || '').localeCompare(String(legExpiryOf(b.l) || ''))).map(({ l, i }) => (
                  <StrikeChip key={i} leg={l} idx={i} engineStrike={r.engineLegs?.[i]?.strike} compact fill
                    expiryTag={legExpiryOf(l) ? fmtExpiry(legExpiryOf(l)) : null}
                    step={strikeStep} onCommit={commitStrike}
                    ladderOpen={ladder?.idx === i} ladder={ladder} outcomes={ladder?.idx === i ? ladderOutcomes : null}
                    onOpenLadder={toggleLadder} onCloseLadder={closeLadder} onRetryLadder={retryLadder} />
                ))}
                {(r.wingTxt || r.strikeLine) && (
                  <span title={r.wingTxt || r.strikeLine} aria-label={'Strike placement: ' + (r.wingTxt || r.strikeLine)}
                    style={{flex:'none',fontSize:12.5,color:'#8b949e',cursor:'help',padding:'0 4px'}}>ⓘ</span>
                )}
              </div>
            )}
            {!is0 && !isTimeSpread && singleExp && (
              <SingleExpiryPicker today={todayYmd} list={expList} sel={singleExp} onPick={pickSingle}
                source={chainOk ? 'chain' : (chainExp && chainExp.err) ? 'fallback:' + chainExp.err : chainExp ? 'fallback' : 'loading'}
                strikeNote={listedStrikeNote(listedChain, singleExp, r.legs, r.listedFit)} />
            )}
            {isTimeSpread && nearExp && (
              <ExpiryPicker today={todayYmd} list={expList} near={nearExp} far={farExp}
                onNear={pickNear} onFar={pickFar} isDiagonal={/diagonal/i.test(effectiveStrat || '')}
                source={chainOk ? 'chain' : (chainExp && chainExp.err) ? 'fallback:' + chainExp.err : chainExp ? 'fallback' : 'loading'} />
            )}
            {editedCount > 0 && (
              <div style={{marginTop:4,fontSize:12.5,color:'#d29922'}}>
                ✎ {editedCount} leg{editedCount>1?'s':''} edited ·{' '}
                <span onClick={resetStrikes} title="Clear every hand-edited strike and take the engine's suggestion back"
                  style={{textDecoration:'underline',cursor:'pointer'}}>reset to engine</span>
              </div>
            )}
            {(() => {
              // Unequal condor / iron-fly wings: TWS lists them as a custom combo, not an
              // iron condor, and max loss is set by the wider wing. (Oct 2026.)
              const L = r.legs || [];
              if (L.length !== 4 || !/Iron Condor|Iron butterfly|Chicken condor/i.test(r.legStrat || '')) return null;
              const ks = L.map(l => l.strike).slice().sort((a, b) => a - b);
              const wp = ks[1] - ks[0], wc = ks[3] - ks[2];
              if (!(wp > 0 && wc > 0) || Math.abs(wp - wc) < 1e-9) return null;
              return (
                <div data-testid="unequal-wings" style={{marginTop:4,fontSize:12.5,color:'#d29922'}}>
                  ⚠ Wings are {wp} and {wc} wide — TWS shows unequal wings as a custom combo, not an iron condor, and max loss is set by the {Math.max(wp, wc)}-wide side.
                </div>
              );
            })()}
            {r.strikeOrderWarning && (
              <div style={{marginTop:4,fontSize:12.5,color:'#f85149'}}>⚠ {r.strikeOrderWarning}</div>
            )}
            {r.flyBand && r.flyBand.pInside != null && <FlyBandLine band={r.flyBand} />}
            {r.deltaCheck && r.legs.length > 0 && (
              <DeltaStrip strat={r.legStrat} check={r.deltaCheck} plan={r.deltaPlan} method={strikeMethod[bag]} hideMethod={!!r.vertVariants}
                onMethod={setStrikeMethod} builtBy={strikesBuiltBy}
                confirmed={!!(deltaMatches && deltaApplied && deltaApplied.confirmed)}
                pop={fv(secBag, 'pop')} legs={r.legs}
                onFetch={handleFetchGreeks} fetching={fetchingGreeks}
                onApply={() => setStrikeMethod('delta')} applying={applyingDelta} onBack={() => setStrikeMethod('em')} />
            )}
          </div>
        )}

            {!mapPay && renderSideStack()}
          </div>

          {/* Right: price map — where price can go, against this structure */}
          {mapPay && (
            <div style={{flex:'1.25 1 460px',minWidth:300,display:'flex',flexDirection:'column',gap:4}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',gap:8,flexWrap:'wrap'}}>
                <span style={EX_LBL}>Where price can go</span>
                {cushion && (
                  <span title="Distance from price to the nearest short strike, in remaining expected moves" style={{fontSize:12.5,color:'#a8b2be'}}>
                    Cushion{cushion.below != null && <> below <span className="mono" style={{color: cushion.below < 1 ? '#d29922' : '#e6edf3'}}>{cushion.below.toFixed(2)} EM</span></>}
                    {cushion.below != null && cushion.above != null ? ' \u00b7' : ''}
                    {cushion.above != null && <> above <span className="mono" style={{color: cushion.above < 1 ? '#d29922' : '#e6edf3'}}>{cushion.above.toFixed(2)} EM</span></>}
                  </span>
                )}
              </div>
              <PriceMap pay={mapPay} legs={r.legs} price={fv(secBag, 'price')} em={mapEM}
                emLabel={is0 ? 'Expected move left' : '1 SD to expiry'}
                high={is0 ? fv(i0, 'high') : 0} low={is0 ? fv(i0, 'low') : 0}
                vwap={is0 ? scaleVWAP(i0.vwap5) : 0} underlying={secBag.underlying} />
              <div style={{marginTop:10}}>{renderSideStack()}</div>
            </div>
          )}
        </div>
      </div>

      {/* ── 2 · NEEDS YOU ── only what a person has to do, each with its own control.
          Nothing renders here when the Bridge has everything covered. */}
      {needs.length > 0 && (
        <section data-testid="needs-you" style={{display:'flex',flexDirection:'column',gap:8}}>
          <div style={{fontSize:12,fontWeight:600,letterSpacing:'0.08em',textTransform:'uppercase',color:'#d29922'}}>
            Needs you · {needs.length}
          </div>
          {needs.map((n, idx) => (
            <div key={n.key} data-testid={'need-' + n.key} data-resolved={n.resolved ? '1' : '0'}
              onFocus={() => setNeedsFocus(n.key)}
              onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setNeedsFocus(k => (k === n.key ? null : k)); }}
              style={{display:'flex',flexWrap:'wrap',alignItems:'center',gap:12,padding:'12px 14px',borderRadius:10,
              background:'#0d1117',border:`1px solid ${n.resolved ? '#238636' : n.tone==='bad'?'#6e2427':n.tone==='warn'?'#9e6a03':'#30363d'}`}}>
              <span className="mono" style={{width:24,height:24,borderRadius:'50%',flex:'none',display:'flex',alignItems:'center',justifyContent:'center',
                fontSize:12.5,fontWeight:700,color:'#0d1117',background:n.resolved ? '#3fb950' : n.tone==='bad'?'#f85149':n.tone==='warn'?'#d29922':'#8b949e'}}>{n.resolved ? '✓' : idx+1}</span>
              <div style={{flex:'1 1 280px',minWidth:0,display:'flex',flexDirection:'column',gap:3}}>
                <span style={{fontSize:14.5,fontWeight:600,color:'#fff'}}>{n.resolved ? 'Done — ' : ''}{n.title}</span>
                {n.detail && <span style={{fontSize:13,lineHeight:1.45,color:'#a8b2be'}}>{n.detail}</span>}
              </div>
              {n.net && (
                <NeedNum label={cashType==='debit' ? 'Net debit' : 'Net credit'} value={ticketNet}
                  onChange={v=>is0?set0('netCreditDebit',v):set45('netCreditDebit',v)} />
              )}
              {n.sizing && (
                <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'flex-start'}}>
                  <NeedNum label="Win $" value={secBag.win} onChange={v=>is0?set0('win',v):set45('win',v)}
                    suggest={sizingPay?.maxProfit > 0 ? Math.round(sizingPay.maxProfit) : null} />
                  <NeedNum label="Risk $" value={secBag.risk} onChange={v=>is0?set0('risk',v):set45('risk',v)}
                    suggest={sizingPay && Number.isFinite(sizingPay.maxLoss) && sizingPay.maxLoss !== 0 ? Math.round(Math.abs(sizingPay.maxLoss)) : null} />
                  <NeedNum label="POP %" value={secBag.pop} onChange={v=>is0?set0('pop',v):set45('pop',v)}
                    suggest={!is0 && exitSim ? Math.round(exitSim.pop * 100) : null} />
                </div>
              )}
              {(n.actions || []).map(a => (
                <button key={a.label} onClick={a.onClick} disabled={a.busy}
                  style={{padding:'8px 12px',borderRadius:8,fontSize:13,fontWeight:600,cursor:a.busy?'default':'pointer',minHeight:36,
                    border:`1px solid ${a.primary?'#2f81f7':'#30363d'}`,background:a.primary?'#0d1a2b':'transparent',
                    color:a.primary?'#58a6ff':'#e6edf3',opacity:a.busy?0.6:1}}>{a.busy ? (a.busyLabel || 'Working…') : a.label}</button>
              ))}
            </div>
          ))}
        </section>
      )}

      {/* ── 2b · YOUR CHOICES ── the engine pick and the next two structures, each a
          full engine run on the same market inputs. Alternatives are priced at the
          model's fair value (not this ticket's fill), so their payoff and range
          describe THEIR strikes; EV and size appear once a structure is selected
          and sized, because they depend on your broker's POP and fill. */}
      {choiceList.length > 0 && (
        <section data-testid="choices" style={{display:'flex',flexDirection:'column',gap:10}}>
          <div style={{display:'flex',alignItems:'baseline',justifyContent:'space-between',gap:12,flexWrap:'wrap'}}>
            <span style={{fontSize:17,fontWeight:600,color:'#fff'}}>Your choices
              <span style={{fontSize:13,fontWeight:400,color:'#a8b2be'}}>{r.regime ? ` · ${r.regime}` : ''}{is0 && r.dirLabel ? ` · ${r.dirLabel.toLowerCase()} read` : ''}</span>
            </span>
            <button onClick={() => setDrawerTab('structures')} style={EX_LINK}>All {(r.ratings || []).length} structures</button>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit, minmax(280px, 1fr))',gap:12}}>
            {choiceList.map(c => (
              <ChoiceCard key={c.name} c={c} price={fv(secBag, 'price')} underlying={secBag.underlying} rrMax={choiceRRMax}
                onSwitch={() => switchStructure(c.name)}
                onNewTab={onOpenInTab ? () => openStructureInTab(c.name) : null} />
            ))}
          </div>
        </section>
      )}

      {/* ── 3 · EXECUTION ── size, price, expiry plan and the one button that writes. */}
      {!r.hardBlocker && (
        <section data-testid="execution" style={{display:'flex',flexWrap:'wrap',alignItems:'stretch',gap:16,padding:'14px 16px',
          borderRadius:12,background:'#161b22',border:'1px solid #21262d'}}>
          <div style={{flex:'1 1 130px',display:'flex',flexDirection:'column',gap:4,minWidth:0}}>
            <span style={EX_LBL}>Size</span>
            {missingInputs ? <span style={{fontSize:13,color:'#8b949e'}}>after sizing</span> : <SizeInput
              value={r.contracts} kellyC={r.kellyContracts ?? r.contracts} mine={!!r.contractsOverride}
              noEdge={!(r.kellyDollar > 0)} kellyDollar={r.kellyDollar} overRisk={r.kellyOverRisk} riskEach={r.maxRisk && r.contracts ? r.maxRisk / r.contracts : 0}
              onSet={n => setSizeOv(p => ({ ...p, [bag]: n > 0 ? n : null }))} />}
          </div>
          <div style={{flex:'1 1 170px',display:'flex',flexDirection:'column',gap:4,minWidth:0}}>
            <span style={EX_LBL}>{cashType==='debit' ? 'Net debit' : 'Net credit'}{netIsTarget && <span title="Pre-filled from the engine's target — replace it with your fill; this number is logged."
              style={{marginLeft:6,padding:'1px 6px',borderRadius:4,fontSize:10.5,fontWeight:700,letterSpacing:'0.04em',background:'#3a2d00',color:'#e3b341'}}>TARGET</span>}</span>
            <input type="number" step="any" aria-label="Net credit or debit" value={ticketNet}
              onChange={e=>is0?set0('netCreditDebit',e.target.value):set45('netCreditDebit',e.target.value)}
              placeholder="—" className="mono"
              style={{width:'100%',maxWidth:140,padding:'7px 10px',borderRadius:8,border:'1px solid #30363d',background:'#0d1117',
                color: parseFloat(ticketNet) > 0 ? '#3fb950' : parseFloat(ticketNet) < 0 ? '#f85149' : '#e6edf3',fontSize:16,fontWeight:700,outline:'none'}} />
            {r.priceCheck && r.priceCheck.ratio != null && !r.priceCheck.arb && (
              <span style={{fontSize:12.5,color: r.priceCheck.ratio >= 1.15 ? '#d29922' : '#a8b2be'}}>
                fair {r.priceCheck.fair.toFixed(2)} · {r.priceCheck.ratio.toFixed(2)}× fair
              </span>
            )}
            {beView && <BreakevenLine v={beView} onUse={breakeven && breakeven.status === 'ok' ? applyBreakevenNet : null} />}
            {!is0 && isTimeSpread && <VolViewFlag be={beView} />}
          </div>
          {commUnitsNow > 0 && (
            <div data-testid="commission-cell" style={{flex:'1 1 170px',display:'flex',flexDirection:'column',gap:4,minWidth:0}}
              title="Per contract, each way, from this account's Settings. Calibrate it there from a day's TWS fills.">
              <span style={EX_LBL}>Commission</span>
              <span className="mono" style={{fontSize:18,fontWeight:700,color:'#e6edf3'}}>${commTotalNow.toFixed(2)}</span>
              <span style={{fontSize:12.5,color:'#a8b2be'}}>{commUnitsNow * commQtyNow} contracts × ${commRateAcct.toFixed(2)} × 2 sides{r.evBasis && r.evBasis.commission > 0 ? ' · in EV' : ''}</span>
            </div>
          )}
          {is0 && r.holdToExpiry && (() => {
            const h = r.holdToExpiry;
            const fg = h.verdict==='hold'?'#3fb950':h.verdict==='watch'?'#d29922':'#f85149';
            const bg = h.verdict==='hold'?'#0d2818':h.verdict==='watch'?'#1f1a0d':'#2d0f11';
            return (
              <div style={{flex:'1.4 1 220px',display:'flex',flexDirection:'column',gap:4,minWidth:0}}>
                <span style={EX_LBL}>At expiry</span>
                <span title={h.note} style={{alignSelf:'flex-start',padding:'4px 10px',borderRadius:6,background:bg,color:fg,fontSize:13,fontWeight:600}}>{h.label}</span>
                <span style={{fontSize:12.5,color:'#a8b2be'}}>Cushion {h.cushionEM.toFixed(2)} EM (wants {h.needed.toFixed(2)}) · {h.isCashSettled?'cash-settled':'settles into shares'}</span>
              </div>
            );
          })()}
          <div style={{flex:'1 1 200px',display:'flex',flexDirection:'column',justifyContent:'center',gap:6}}>
            {isLogged ? (
              // Confirmed-write state. "Log again" stays available but demoted, so a
              // second write has to be chosen rather than fallen into (legging in).
              <div style={{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap'}}>
                <span data-testid="logged-badge" title={`Written to the Decisions log at ${new Date(loggedAt).toLocaleString()}`}
                  style={{padding:'10px 16px',borderRadius:10,fontSize:14,fontWeight:600,
                    background:'#0d2818',border:'1px solid #238636',color:'#3fb950'}}>
                  ✓ Logged · {new Date(loggedAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}
                </span>
                <button onClick={handleLog} title="Log a second ticket for these same strikes — for legging in, not for correcting a mistake"
                  style={EX_LINK}>Log again</button>
              </div>
            ) : logGate.ok ? (
              <button data-testid="log-trade" onClick={handleLog} disabled={logging}
                style={{padding:'12px 18px',borderRadius:10,border:'none',minHeight:46,
                  background: logging ? '#1a4d24' : '#238636', color:'#fff', fontSize:15, fontWeight:700,
                  cursor: logging ? 'default' : 'pointer', opacity: logging ? 0.7 : 1}}>
                {logging ? 'Logging…' : 'Log trade'}
              </button>
            ) : (
              <div style={{display:'flex',flexDirection:'column',gap:4}}>
                <button data-testid="log-trade" disabled title={logGate.why}
                  style={{padding:'12px 18px',borderRadius:10,minHeight:46,fontSize:14,fontWeight:600,cursor:'not-allowed',
                    border:`1px solid ${logGate.tone === 'bad' ? '#6e2427' : '#30363d'}`,
                    background: logGate.tone === 'bad' ? '#2d0f11' : '#1c2128',
                    color: logGate.tone === 'bad' ? '#f85149' : '#8b949e'}}>
                  {logGate.label}
                </button>
                {logGate.anyway && (
                  <button data-testid="log-anyway" onClick={handleLog}
                    title="Write this ticket despite the blocker — it is logged with the blocker in its notes"
                    style={{...EX_LINK,alignSelf:'flex-start'}}>Log anyway</button>
                )}
              </div>
            )}
            <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
              {isOverride && (
                <button onClick={() => setOverrideStrat(null)} style={EX_GHOST}>Clear override</button>
              )}
              <button onClick={handlePrint} style={EX_GHOST}>Print summary</button>
            </div>
          </div>
        {logNoteOpen && (
          <div style={{flexBasis:'100%',display:'flex',gap:6,alignItems:'center',maxWidth:640}}>
            <input autoFocus type="text" value={logNote}
              onChange={e=>setLogNote(e.target.value)}
              onKeyDown={e=>{ if (e.key==='Enter') { e.preventDefault(); confirmLog(); } else if (e.key==='Escape') { setLogNoteOpen(false); } }}
              placeholder="Add a note for this trade (optional) — your rationale, plan, or anything to remember"
              style={{flex:1,padding:'7px 10px',borderRadius:8,border:'1px solid #30363d',background:'#0d1117',color:'#e6edf3',fontSize:13,outline:'none'}} />
            <button onClick={confirmLog} style={{padding:'6px 14px',borderRadius:8,border:'none',background:'#238636',color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>Log</button>
            <button onClick={()=>setLogNoteOpen(false)} title="Abort logging (nothing is written)"
              style={{padding:'6px 12px',borderRadius:8,border:'1px solid #30363d',background:'transparent',color:'#a8b2be',fontSize:13,cursor:'pointer'}}>Cancel</button>
          </div>
        )}
        </section>
      )}

      {/* ── 4 · EVIDENCE DRAWER ── closed by default. Every panel stays mounted
          (display:none) so half-typed inputs and open details survive a tab switch. */}
      <section data-testid="evidence" style={{borderRadius:12,background:'#161b22',border:'1px solid #21262d'}}>
        <div style={{display:'flex',alignItems:'center',gap:4,flexWrap:'wrap',padding:'8px 10px'}}>
          <span style={{...EX_LBL,padding:'0 8px 0 6px'}}>Evidence</span>
          {drawerTabs.map(t => {
            const on = drawerTab === t.id;
            return (
              <button key={t.id} data-testid={'drawer-tab-' + t.id} onClick={() => setDrawerTab(on ? null : t.id)}
                aria-pressed={on}
                style={{display:'inline-flex',alignItems:'center',gap:7,padding:'6px 11px',borderRadius:7,fontSize:13,cursor:'pointer',minHeight:34,
                  border:`1px solid ${on ? '#58a6ff' : (t.dot === '#f85149' && t.id === 'inputs') ? '#6e2427' : 'transparent'}`,
                  background:on ? '#1c2128' : (t.dot === '#f85149' && t.id === 'inputs') ? '#2d0f11' : 'transparent',color:on ? '#fff' : '#a8b2be'}}>
                <span style={{width:7,height:7,borderRadius:'50%',background:t.dot}} />
                {t.label}
                {t.meta ? <span className="mono" style={{fontSize:12,color:'#8b949e'}}>{t.meta}</span> : null}
              </button>
            );
          })}
          <span style={{marginLeft:'auto',fontSize:12.5,color:'#8b949e',paddingRight:6}}>
            {drawerTab ? 'Click the tab again to close' : ''}
          </span>
        </div>
        {inputChips.length > 0 && (
          <div data-testid="input-chips" style={{display:'flex',alignItems:'center',gap:6,flexWrap:'wrap',padding:'8px 12px 10px',borderTop:'1px solid #21262d'}}>
            <span style={{...EX_LBL,marginRight:4}} title="Everything the Bridge does not fill. Click one to jump to it.">
              Not from Bridge{nMissing ? <span style={{color:'#f85149'}}> · {nMissing} to enter</span> : ''}
            </span>
            {inputChips.map((c, j) => {
              const st = INPUT_CHIP[c.state];
              return (
                <button key={c.k + j} data-testid={'input-chip-' + c.k} data-state={c.state} onClick={() => openField(c.k)}
                  title={st.tip}
                  style={{display:'inline-flex',alignItems:'center',gap:6,padding:'4px 9px',borderRadius:6,fontSize:12.5,cursor:'pointer',
                    border:`1px ${c.state === 'nofeed' ? 'dashed' : 'solid'} ${st.border}`,background:st.bg,color:st.fg,minHeight:28}}>
                  <span style={{width:6,height:6,borderRadius:'50%',background:st.fg}} />
                  <span className={c.state === 'missing' ? '' : 'mono'}>{c.text}</span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      <div data-testid="evidence-body" style={{display: drawerTab ? 'block' : 'none'}}>
        {/* ── INPUTS PANEL ── */}
        <div className="card" style={{...tabShow('inputs'),maxWidth:1040}}>

          {/* Source legend — the SAME colours the per-field states already use:
              green = the feed / LIVE badge, amber = Inp's manual (held) state,
              dim grey = Inp's stale (not returned by the last pull) state. */}
          <div style={{display:'flex',alignItems:'center',gap:14,flexWrap:'wrap',fontSize:12,color:'#a8b2be',lineHeight:1,marginBottom:2}}>
            <span style={{display:'inline-flex',alignItems:'center',gap:4}}><span style={{width:6,height:6,borderRadius:'50%',background:'#3fb950',display:'inline-block'}}/>live feed</span>
            <span style={{display:'inline-flex',alignItems:'center',gap:4}}><span style={{width:6,height:6,borderRadius:'50%',background:'#d29922',display:'inline-block'}}/>manual ✎</span>
            <span style={{display:'inline-flex',alignItems:'center',gap:4}}><span style={{width:6,height:6,borderRadius:'50%',background:'#9aa4b0',display:'inline-block'}}/>stale</span>
          </div>

          {/* Market Data */}
          <InputSection
            title="Market data"
            info="Price, high, low from your chart or auto-filled from IBKR. VWAP 5 is the anchored session VWAP (used for position and distance). VWAP last 30m / prior 30m are rolling windows used for the trend read — unlike the anchored line, their slope does not decay as the session wears on. VWAP acceptance is the share (0-1) of the last twelve 5-min bars that closed above the session VWAP; leave blank if unknown. SPX uses SPY VWAP ×10 automatically."
            missing={secMissing.market}
            collapsed={isCollapsed('market')}
            onToggle={() => toggleSection('market')}
            onExpand={() => expandSection('market')}
            actions={<>
              {dataFresh && (
                <span title={(dataFresh.label || '') + (dataFresh.asOf ? ' \u00b7 quote stamped ' + new Date(dataFresh.asOf).toLocaleString('en-AU') : '')
                  + (feed && feed.missing && feed.missing.length ? '\n' + feed.missing.length + ' field(s) not returned by this pull: ' + feed.missing.join(', ') : '')}
                  style={{padding:'2px 8px',borderRadius:4,fontSize:12,fontWeight:700,letterSpacing:'0.04em',whiteSpace:'nowrap',
                    background: dataFresh.isLive ? '#0d2818' : '#161b22',
                    color: dataFresh.isLive ? '#3fb950' : '#a8b2be',
                    border: '1px solid ' + (dataFresh.isLive ? '#238636' : '#30363d')}}>
                  {dataFresh.isLive ? '\u25cf LIVE' : '\u25cb LAST CLOSE'}
                  {(dataFresh.pulledAt || dataFresh.asOf) && <span style={{fontWeight:600}}> {clockOf(dataFresh.pulledAt || dataFresh.asOf)}</span>}
                  <span style={{fontWeight:400,opacity:0.75}}> · {agoOf(dataFresh.pulledAt || dataFresh.asOf, tick)}</span>
                </span>
              )}
              {justRefreshed && (
                <span style={{padding:'2px 8px',borderRadius:4,fontSize:12,fontWeight:700,letterSpacing:'0.04em',whiteSpace:'nowrap',
                  background:'#0d2818',color:'#3fb950',border:'1px solid #238636'}}>
                  ✓ REFRESHED{feed && feed.missing && feed.missing.length ? ' · ' + feed.missing.length + ' missing' : ''}
                </span>
              )}
              {heldKeys.length > 0 && (
                <button onClick={releaseHolds}
                  title={'You are holding ' + heldKeys.length + ' hand-typed market field(s); auto-fill leaves them alone. Click to release them and take the last feed value back.'}
                  style={{padding:'2px 8px',borderRadius:4,fontSize:12,fontWeight:700,letterSpacing:'0.04em',whiteSpace:'nowrap',
                    background:'#2d1a0d',color:'#d29922',border:'1px solid #5a3a1a',cursor:'pointer'}}>
                  ✎ {heldKeys.length} MANUAL
                </button>
              )}
              <button onClick={handleLoadFromTWS} disabled={loadingTws}
                title="Load an open option position from TWS into the ticket, then pull market data"
                style={{padding:'3px 10px',borderRadius:6,border:'1px solid #30363d',background:loadingTws?'#161b22':'transparent',color:loadingTws?'#a8b2be':'#3fb950',fontSize:12.5,fontWeight:600,cursor:'pointer'}}>
                {loadingTws ? 'Loading…' : '📥 Load position (TWS)'}
              </button>
              <button onClick={handleAutoFill} disabled={autoFilling}
                style={{padding:'3px 10px',borderRadius:6,border:'1px solid #30363d',background:autoFilling?'#161b22':'transparent',color:autoFilling?'#a8b2be':'#2f81f7',fontSize:12.5,fontWeight:600,cursor:'pointer'}}>
                {autoFilling ? 'Fetching...' : '⚡ Auto-fill'}
              </button>
            </>}
            pinned={twsStructures && twsStructures.length > 1 && (
            <div style={{border:'1px solid #30363d',borderRadius:8,padding:10,marginBottom:8,background:'#0d1117'}}>
              <div style={{fontSize:13,color:'#a8b2be',marginBottom:6}}>Multiple open positions in TWS — pick one:</div>
              {twsStructures.map((s, i) => (
                <button key={i} onClick={() => applyTwsStructure(s)}
                  style={{display:'block',width:'100%',textAlign:'left',padding:'6px 8px',marginBottom:4,borderRadius:6,border:'1px solid #30363d',background:'transparent',color:'#c9d1d9',fontSize:13,cursor:'pointer'}}>
                  <b>{s.underlying}</b> {s.shape} · {s.legCount} legs · strikes {s.strikes.join('/')} · {s.isCredit ? 'credit' : 'debit'} ${Math.abs(Math.round((s.netCreditDebit||0)*100))} · exp {s.expiry}
                </button>
              ))}
              <button onClick={() => setTwsStructures(null)}
                style={{marginTop:4,padding:'3px 8px',borderRadius:5,border:'none',background:'transparent',color:'#a8b2be',fontSize:12.5,cursor:'pointer'}}>Cancel</button>
            </div>
          )}>
          <div className="grid grid-cols-2 gap-2.5">
            <Sel label="Underlying" value={is0?i0.underlying:i45.underlying} onChange={v=>is0?set0('underlying',v):set45('underlying',v)} options={UNDERLYING_LIST}/>
            <Inp label="Price" {...mk('price')} value={is0?i0.price:i45.price} onChange={v=>is0?set0('price',v):set45('price',v)}/>
            {is0 ? <>
              <Inp label="Day high" {...mk('high')} value={i0.high} onChange={v=>set0('high',v)}/>
              <Inp label="Day low" {...mk('low')} value={i0.low} onChange={v=>set0('low',v)}/>
              <Inp label={`VWAP 5${vwapScaled ? ' (SPY→x10)' : ''}`} {...mk('vwap5')} value={i0.vwap5} onChange={v=>set0('vwap5',v)}/>
              <Inp label={`VWAP 5 -30min${vwapScaled ? ' (x10)' : ''}`} {...mk('vwap5_30')} value={i0.vwap5_30} onChange={v=>set0('vwap5_30',v)}/>
              <Inp label={`VWAP last 30m${vwapScaled ? ' (x10)' : ''}`} {...mk('vwapRoll30')} value={i0.vwapRoll30} onChange={v=>set0('vwapRoll30',v)}/>
              <Inp label={`VWAP prior 30m${vwapScaled ? ' (x10)' : ''}`} {...mk('vwapRoll30Prior')} value={i0.vwapRoll30Prior} onChange={v=>set0('vwapRoll30Prior',v)}/>
              <Inp label="VWAP acceptance (0-1)" {...mk('vwapAccept')} value={i0.vwapAccept} onChange={v=>set0('vwapAccept',v)}/>
              <Inp label="EM" {...mk('em')} value={i0.em} onChange={v=>{setI0(prev=>({...prev, em:v, emSource:'manual', straddleCall:'', straddlePut:''})); markHeld('0','em');}}/>
              <Inp label="ATR 1 Day" {...mk('atr')} value={i0.atr} onChange={v=>set0('atr',v)}/>
              <Inp label="ATR 5m" {...mk('atr5')} value={i0.atr5} onChange={v=>set0('atr5',v)}/>
              <Inp label="ATR 2h" {...mk('atr2h')} value={i0.atr2h} onChange={v=>set0('atr2h',v)}/>
              <Inp label="VIX" {...mk('vix')} value={i0.vix} onChange={v=>set0('vix',v)}/>
              <Inp label="VIX1D" {...mk('vix1d')} value={i0.vix1d} onChange={v=>set0('vix1d',v)}/>
            </> : <>
              <Inp label="VIX" {...mk('vix')} value={i45.vix} onChange={v=>set45('vix',v)}/>
            </>}
          </div>

          {/* EM: source + BOTH rulers. Remaining drives strikes/POP; session drives
              move-consumed, regime and every "% EM" score. One number used to do both. */}
          {is0 && r.emDetail && (
            <div style={{marginTop:6,padding:'7px 10px',borderRadius:8,background:'#0d1117',border:`1px solid ${r.emDisagree ? '#5a3a1a' : '#21262d'}`}}>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:8}}>
                <div style={{fontSize:13,lineHeight:1.4,color: r.emIsStraddle ? '#3fb950' : i0.emSource==='manual' ? '#58a6ff' : '#e3a008'}}>
                  <b>EM {r.emIsStraddle ? '(straddle)' : i0.emSource==='manual' ? '(manual)' : '(VIX model)'}:</b><Info text="Expected move - how far the market is priced to travel, in points. The engine keeps TWO rulers and uses both. REMAINING (now to the close) sets strikes, breakevens and POP. SESSION (open to close) sets move-consumed, regime and every '% EM' score. They differ by sqrt(fraction of session left), so Remaining is always the smaller number - that is scale, not disagreement. SOURCE: straddle (green) = ATM call + put x 1.2533, the market's own priced move with skew and events baked in - preferred. VIX model (amber) = VIX1D / sqrt(252) x the cash open, the fallback when option data is not subscribed. Manual (blue) = your number, always read as a SESSION EM. SD mult converts a straddle to 1 SD: straddle = 0.7979 x S x sigma x sqrt(T), so 1 SD = straddle x 1.2533. Leave it at 1.2533. The line underneath cross-checks the two sources like-for-like by putting the straddle back on the session ruler and comparing its implied session vol against VIX1D; more than 15% apart reads DISAGREE and raises a warning. 'Single source - no cross-check available' means only one source is live, so nothing is validating it. What-if re-runs every EM-driven reading off the other volatility input, so you can see which numbers actually depend on the EM source and which do not." /> {r.emDetail}
                </div>
                <div style={{display:'flex',alignItems:'center',gap:5}}>
                  <span style={{fontSize:12.5,color:'#a8b2be'}} title="Straddle to 1 SD. Black-Scholes ATM identity: straddle = 0.7979 x S x sigma x sqrt(T), so 1 SD = straddle x 1.2533. Leave at 1.2533 unless you know why you're changing it.">SD mult</span>
                  <input type="number" step="0.01" value={i0.straddleHaircut}
                    onChange={e=>set0('straddleHaircut', e.target.value)}
                    style={{width:60,padding:'3px 6px',borderRadius:5,border:'1px solid #30363d',background:'#0d1117',color:'#e6edf3',fontSize:13,fontFamily:'JetBrains Mono,monospace'}} />
                </div>
              </div>
              {(r.emRemainingDetail || r.emSessionDetail) && (
                <div style={{display:'flex',gap:16,flexWrap:'wrap',marginTop:6,fontSize:12.5,lineHeight:1.5,fontFamily:'JetBrains Mono,monospace',color:'#e6edf3'}}>
                  <div><span style={{color:'#a8b2be'}}>Remaining</span> (strikes, POP, breakevens): {r.emRemainingDetail}</div>
                  <div><span style={{color:'#a8b2be'}}>Session</span> (move-consumed, regime, % EM): {r.emSessionDetail}</div>
                </div>
              )}
              {r.emAgreeDetail && (
                <div style={{marginTop:4,fontSize:12.5,lineHeight:1.4,color: r.emDisagree ? '#e3a008' : '#a8b2be'}}>
                  {r.emDisagree ? '\u26a0 ' : ''}{r.emAgreeDetail}
                </div>
              )}
              {r.emScaleShift != null && Math.abs(r.emScaleShift - 1) > 0.08 && r.moveConsumedLegacy != null && (
                <div style={{marginTop:4,fontSize:12.5,lineHeight:1.4,color:'#a8b2be'}}>
                  Scale fix: move-consumed reads {(r.moveConsumed*100).toFixed(0)}% on the session ruler
                  (old build showed {(r.moveConsumedLegacy*100).toFixed(0)}%).
                </div>
              )}
              {altVol && (
                <div style={{marginTop:7,paddingTop:6,borderTop:'1px solid #21262d'}}>
                  <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8,flexWrap:'wrap'}}>
                    <div style={{fontSize:12.5,color:'#a8b2be',lineHeight:1.4}}>
                      What if EM came from <b style={{color:'#e6edf3'}}>{altVol.label}</b>?
                      {altVol.changed === 0
                        ? ' \u2014 nothing changes.'
                        : ` \u2014 ${altVol.changed} of ${altVol.rows.length} readings move.`}
                    </div>
                    <button onClick={()=>setShowWhatIf(v=>!v)}
                      style={{padding:'3px 9px',borderRadius:5,border:'1px solid #30363d',background:showWhatIf?'#1f2937':'#0d1117',
                        color:'#a8b2be',fontSize:12.5,cursor:'pointer',whiteSpace:'nowrap'}}>
                      {showWhatIf ? 'Hide' : 'Show'} what-if
                    </button>
                  </div>
                  {showWhatIf && (
                    <div style={{marginTop:6,display:'grid',gridTemplateColumns:'auto 1fr 1fr',gap:'3px 12px',
                      fontSize:12.5,fontFamily:'JetBrains Mono,monospace',alignItems:'baseline'}}>
                      <div style={{color:'#a8b2be'}} />
                      <div style={{color:'#a8b2be',textAlign:'right'}}>now</div>
                      <div style={{color:'#a8b2be',textAlign:'right'}}>{altVol.short}</div>
                      {altVol.rows.flatMap((row, ix) => {
                        const moved = row.now !== row.alt;
                        return [
                          <div key={ix+'k'} style={{color:'#a8b2be'}}>{row.k}</div>,
                          <div key={ix+'n'} style={{textAlign:'right',color:'#e6edf3'}}>{row.now}</div>,
                          <div key={ix+'a'} style={{textAlign:'right',color:moved?'#e3a008':'#8b949e',
                            fontWeight:moved?600:400}}>{row.alt}</div>
                        ];
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          </InputSection>

          {/* Vol surface (45DTE only) */}
          {!is0 && (
            <InputSection
              title="Vol surface"
              info={"All of these fill from TWS (Auto-fill, or the Fetch button here). IV = ATM model IV at the trade's expiry; it drives EM45 and the strikes, and a blank IV blocks the decision. IV Rank = where IB's 30-day IV sits in its 52-week range (percentile shown underneath — it is steadier after a spike). HV = IB's 30-day historical vol, for the IV/HV ratio. IV Front / IV Back = ATM IV at the listed expiries nearest 30 and 90 days. Term bias is DERIVED from them: Front/Back below 0.95 = contango (15 pts), 0.95-1.02 = flat (8), above 1.02 = backwardation (0, and a hard blocker on short premium). The dropdown only appears when Front/Back are missing; blank = unknown = 0 pts. Skew = 25-delta put IV minus 25-delta call IV at the trade's expiry, in vol points. Type any value to override it — later fetches leave it alone (amber ✎)."}
              missing={secMissing.vol}
              collapsed={isCollapsed('vol')}
              onToggle={() => toggleSection('vol')}
              onExpand={() => expandSection('vol')}
              actions={<>
                {volMeta && volMeta.asOf && (() => {
                  const age = Math.max(0, Math.round((Date.now() - new Date(volMeta.asOf).getTime()) / 60000));
                  const rt = volMeta.dataType === 'realtime';
                  return <span title={'Vol surface pulled ' + new Date(volMeta.asOf).toLocaleTimeString() + ' · ' + (volMeta.dataType || '')}
                    style={{fontSize:12,fontWeight:700,letterSpacing:'0.04em',padding:'2px 8px',borderRadius:4,
                      background: rt ? '#0d2818' : '#161b22', color: rt ? '#3fb950' : '#a8b2be',
                      border: '1px solid ' + (rt ? '#238636' : '#30363d')}}>
                    {(volMeta.dataType === 'realtime' ? 'LIVE' : (volMeta.dataType || '').toUpperCase()) + (age < 1 ? ' · now' : ' · ' + age + 'm ago')}
                  </span>;
                })()}
                <button onClick={() => fetchVolSurface()} disabled={fetchingVol}
                  title="Pull IV, IV Rank, HV, IV Front/Back and Skew from TWS for this underlying and DTE"
                  style={{padding:'3px 10px',borderRadius:6,border:'1px solid #30363d',background:fetchingVol?'#161b22':'transparent',color:fetchingVol?'#a8b2be':'#2f81f7',fontSize:12.5,fontWeight:600,cursor:'pointer'}}>
                  {fetchingVol ? 'Fetching…' : '🔄 Fetch vol'}
                </button>
              </>}>
              <div className="grid grid-cols-2 gap-2.5">
                <Inp label="IV Rank (%)" {...mk('ivr')} value={i45.ivr} onChange={v=>set45('ivr',v)}/>
                <Inp label="IV (%)" {...mk('iv')} value={i45.iv} onChange={v=>set45('iv',v)}/>
                <Inp label="HV (%)" {...mk('hv')} value={i45.hv} onChange={v=>set45('hv',v)}/>
                <Inp label="IV Front (~30d)" {...mk('ivFront')} value={i45.ivFront} onChange={v=>set45('ivFront',v)}/>
                <Inp label="IV Back (~90d)" {...mk('ivBack')} value={i45.ivBack} onChange={v=>set45('ivBack',v)}/>
                <Inp label="Skew (25Δ, vol pts)" {...mk('skew')} value={i45.skew} onChange={v=>set45('skew',v)}/>
                {r && r.termDerived ? (() => {
                  const tb = r.termBias || '';
                  const col = tb === 'contango' ? '#3fb950' : tb === 'flat' ? '#d29922' : '#f85149';
                  return (<div>
                    <label className="text-[12.5px] text-[#c9d1d9] block mb-1" title="Derived from IV Front / IV Back — clear either to set it by hand">Term bias — from Front/Back</label>
                    <div className="w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-sm mono flex justify-between items-center">
                      <span style={{color:col,fontWeight:700}}>{tb || '—'}</span>
                      <span className="text-[#9aa4b0]">{r.termRatio != null ? r.termRatio.toFixed(2) : ''}</span>
                    </div>
                  </div>);
                })() : (
                  <Sel label="Term bias — manual (no Front/Back)" value={i45.termBias} onChange={v=>set45('termBias',v)} options={TERM_BIASES}/>
                )}
              </div>
              {volMeta && (() => {
                const e = volMeta.expiries || {};
                const sd = volMeta.skewDetail;
                const fmtE = (x, n) => x ? x.slice(4,6) + '/' + x.slice(6,8) + (n != null ? ' (' + n + 'd)' : '') : '—';
                const bits = [];
                if (volMeta.ivPctl != null) bits.push('IV pctl ' + volMeta.ivPctl.toFixed(0) + '%');
                if (volMeta.iv30 != null) bits.push('IB 30d IV ' + volMeta.iv30.toFixed(1) + (volMeta.iv52wLow != null ? ' (52w ' + volMeta.iv52wLow.toFixed(1) + '–' + volMeta.iv52wHigh.toFixed(1) + ')' : ''));
                if (volMeta.hvSource === 'close-to-close-30d') bits.push('HV from closes (IB HV unavailable)');
                const exps = 'Trade ' + fmtE(e.trade, e.tradeDte) + (volMeta.atmStrike ? ' @ ' + volMeta.atmStrike : '')
                  + ' · Front ' + fmtE(e.front, e.frontDte) + ' · Back ' + fmtE(e.back, e.backDte);
                const sk = sd ? '25Δ P ' + sd.put.strike + ' ' + sd.put.iv.toFixed(1) + ' / C ' + sd.call.strike + ' ' + sd.call.iv.toFixed(1) : '';
                return (<div className="mt-2 text-[12px] text-[#9aa4b0] leading-relaxed">
                  {bits.length > 0 && <div>{bits.join(' · ')}</div>}
                  <div>{exps}{sk ? ' · ' + sk : ''}</div>
                  {(volMeta.notes || []).map((n, i) => <div key={i} className="text-[#d29922]">⚠ {n}</div>)}
                </div>);
              })()}
            </InputSection>
          )}

          {/* Trade setup (45DTE only) */}
          {!is0 && (
            <InputSection
              title="Trade setup"
              info="Days to expiry and directional outlook — these steer strategy selection and the 21-DTE exit maths. DTE defaults to 45 when blank."
              collapsed={isCollapsed('setup')}
              onToggle={() => toggleSection('setup')}
              onExpand={() => expandSection('setup')}>
              <div className="grid grid-cols-2 gap-2.5">
                <Inp label="DTE" value={i45.dte} onChange={v=>set45('dte',v)}/>
                <Sel label="Outlook" value={i45.outlook} onChange={v=>set45('outlook',v)} options={OUTLOOKS}/>
              </div>
              <TrendReadout trend={trendNow} held={!!held['45:outlook']} outlook={i45.outlook}
                oldBridge={!!(volMeta && volMeta.oldBridge && (!volMeta.und || volMeta.und === i45.underlying))}
                vixTermRatio={trendNow ? volMeta.vixTermRatio : null} source={volMeta && volMeta.dailySource}
                onUseTrend={() => { setHeld(h => { const o = { ...h }; delete o['45:outlook']; return o; });
                  setI45(p => ({ ...p, outlook: trendNow.outlook })); }} />
            </InputSection>
          )}

          {/* ES Overnight (0DTE only) */}
          {is0 && (
            <InputSection
              title={<>ES overnight{esContract && ` \u00b7 ${esContract}`}</>}
              info="ES futures (the contract named in the title) read from 5-minute Globex bars, so the numbers don't depend on when you click Auto-fill. Prior close = the 16:00 ET bar of the previous session. Pre-open = the 08:45 ET bar of this session (before 08:45 it is the latest bar, marked 'latest'). Overnight High/Low = 18:00 ET previous session to 09:30 ET. ES trades ABOVE the cash index by carry until expiry — the basis line shows by how much — so compare these with an ES quote, not an SPX chart. ES EM = expected move for ES. Used for move consumed and continuation/reversal detection."
              collapsed={isCollapsed('es')}
              onToggle={() => toggleSection('es')}
              onExpand={() => expandSection('es')}>
              {i0.esDelayed && (
                <div style={{margin:'2px 0 8px',padding:'5px 9px',borderRadius:6,background:'#2d1a0d',border:'1px solid #5a3a1a',fontSize:12.5,color:'#e3a008',lineHeight:1.4}}>
                  ⚠ ES data is <b>delayed ~10 min</b> — no CME real-time subscription. Overnight range, move-consumed and continuation/reversal detection may be stale. Subscribe to CME Real-Time in IBKR for live ES.
                </div>
              )}
              {esMeta && (
                <div style={{margin:'2px 0 8px',fontSize:12.5,color:'#a8b2be',lineHeight:1.5}}>
                  {esBars
                    ? <>Overnight window <span className="mono" style={{color:'#c9d1d9'}}>{esMeta.window}</span>{esMeta.preFinal === false && <span style={{color:'#d29922'}}> · pre-open not final until 08:45 ET</span>}</>
                    : <span style={{color:'#d29922'}}>⚠ From the live ES quote, not bars — values depend on the time of the pull (close flips at the session end; high/low are the whole session).</span>}
                  {esMeta.basis != null && (
                    <div>ES {esMeta.esNow} − {esMeta.underlying} {esMeta.cash} = basis <b className="mono" style={{color:'#c9d1d9'}}>{esMeta.basis >= 0 ? '+' : ''}{Number(esMeta.basis).toFixed(2)}</b> — subtract this to read ES levels on an {esMeta.underlying} chart.</div>
                  )}
                </div>
              )}
              <div className="grid grid-cols-2 gap-2.5">
                <Inp label={esPriorCloseLabel} {...mk('priorDayClose')} value={i0.priorDayClose} onChange={v=>set0('priorDayClose',v)}/>
                <Inp label={esPreOpenLabel} {...mk('esClose')} value={i0.esClose} onChange={v=>set0('esClose',v)}/>
                <Inp label="ES Overnight High" {...mk('esOvernightHigh')} value={i0.esOvernightHigh} onChange={v=>set0('esOvernightHigh',v)} bad={r.onSwapped}/>
                <Inp label="ES Overnight Low" {...mk('esOvernightLow')} value={i0.esOvernightLow} onChange={v=>set0('esOvernightLow',v)} bad={r.onSwapped}/>
                <Inp label="ES EM" {...mk('esEM')} value={i0.esEM} onChange={v=>set0('esEM',v)}/>
                <Inp label={i0.underlying + ' Open'} {...mk('cashOpen')} value={i0.cashOpen} onChange={v=>set0('cashOpen',v)}/>
              </div>
              {r.onSwapped && (
                <div style={{margin:'8px 0 0',padding:'5px 9px',borderRadius:6,background:'#3d1418',border:'1px solid #7d2b2b',fontSize:12.5,color:'#f85149',lineHeight:1.4}}>
                  ⚠ <b>High is below Low</b> — these two look swapped. Scoring has been corrected to a {(r.onHigh-r.onLow).toFixed(1)} pt range, but fix the inputs: an inverted range distorts move-consumed, the regime and the strategy pick.
                  <button type="button" onClick={()=>setI0(prev=>({...prev, esOvernightHigh:prev.esOvernightLow, esOvernightLow:prev.esOvernightHigh}))}
                    style={{marginLeft:8,padding:'1px 7px',borderRadius:4,border:'1px solid #7d2b2b',background:'#5a1e22',color:'#ffb4b4',cursor:'pointer'}}>Swap</button>
                </div>
              )}
            </InputSection>
          )}

          {/* Session & sizing */}
          <InputSection
            title={is0 ? 'Session & sizing' : 'Sizing'}
            info="Net credit/debit pre-fills from the engine's TARGET for this structure and is flagged as such until you change it — replace it with your broker's actual fill, because this is the number written to the trade log. Positive for credit, negative for debit. Label and box colour change automatically. POP = probability of profit (red if below breakeven POP). Win = max profit, Risk = max loss per contract (red if exceeds Kelly $). Credit/debit tape shows where your fill sits vs target range. Profit targets show TWS limit order values at 25/30/40/50/75/100%. Butterfly debit blocked above 55% of wing width. Frictions = spread (round trip) + commission as a share of MAX PROFIT — the one gauge that asks whether winning is worth anything after execution, rather than how likely winning is. Under 5% is clean, over 20% means the payoff is too thin to survive its own costs and no probability repairs it."
            missing={secMissing.sizing}
            collapsed={isCollapsed('sizing')}
            onToggle={() => toggleSection('sizing')}
            onExpand={() => expandSection('sizing')}>
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="text-xs block mb-1" style={{ fontWeight: 600, color: (() => {
                const v = parseFloat(is0?i0.netCreditDebit:i45.netCreditDebit);
                const t = (!isNaN(v) && v !== 0) ? (v > 0 ? 'credit' : 'debit') : cashType;
                return t === 'credit' ? '#3fb950' : t === 'debit' ? '#f85149' : '#a8b2be';
              })() }}>{(() => {
                const v = parseFloat(is0?i0.netCreditDebit:i45.netCreditDebit);
                const t = (!isNaN(v) && v !== 0) ? (v > 0 ? 'credit' : 'debit') : cashType;
                return t === 'credit' ? 'Net credit ($) — expected'
                  : t === 'debit' ? 'Net debit ($) — expected'
                  : 'Net credit/debit ($)';
              })()}{netIsTarget && (
                <span title="Pre-filled from the engine's target for this structure — not a fill. Overwrite it with your actual price; this number is logged."
                  style={{marginLeft:6,padding:'1px 6px',borderRadius:4,fontSize:11,fontWeight:700,
                    letterSpacing:'0.04em',background:'#3a2d00',color:'#e3b341',verticalAlign:'1px'}}>
                  TARGET — REPLACE WITH FILL
                </span>
              )}</label>
              <input type="number" step="any"
                value={is0?i0.netCreditDebit:i45.netCreditDebit}
                data-field="netCreditDebit" onChange={e=>is0?set0('netCreditDebit',e.target.value):set45('netCreditDebit',e.target.value)}
                placeholder="—"
                style={{
                  width:'100%', padding:'8px 12px', borderRadius:8, fontSize:14, fontFamily:'JetBrains Mono,monospace',
                  outline:'none', border:'1px solid',
                  borderColor: (is0?i0.netCreditDebit:i45.netCreditDebit)
                    ? (parseFloat(is0?i0.netCreditDebit:i45.netCreditDebit) > 0 ? '#238636' : parseFloat(is0?i0.netCreditDebit:i45.netCreditDebit) < 0 ? '#da3633' : '#30363d')
                    : '#30363d',
                  background: (is0?i0.netCreditDebit:i45.netCreditDebit)
                    ? (parseFloat(is0?i0.netCreditDebit:i45.netCreditDebit) > 0 ? '#0d2818' : parseFloat(is0?i0.netCreditDebit:i45.netCreditDebit) < 0 ? '#2d0f0f' : '#0d1117')
                    : '#0d1117',
                  color: (is0?i0.netCreditDebit:i45.netCreditDebit)
                    ? (parseFloat(is0?i0.netCreditDebit:i45.netCreditDebit) > 0 ? '#3fb950' : parseFloat(is0?i0.netCreditDebit:i45.netCreditDebit) < 0 ? '#f85149' : '#c9d1d9')
                    : '#c9d1d9'
                }}
              />
              {beView && <BreakevenLine v={beView} onUse={breakeven && breakeven.status === 'ok' ? applyBreakevenNet : null} />}
            {!is0 && isTimeSpread && <VolViewFlag be={beView} />}
            </div>
            <div>
              <label className="text-xs text-text-muted block mb-1">POP (%)</label>
              <input type="number" step="any"
                value={is0?i0.pop:i45.pop}
                data-field="pop" onChange={e=>is0?set0('pop',e.target.value):set45('pop',e.target.value)}
                placeholder="—"
                style={{
                  width:'100%', padding:'8px 12px', borderRadius:8, fontSize:14, fontFamily:'JetBrains Mono,monospace',
                  outline:'none', border:'1px solid',
                  borderColor: (() => {
                    const pop = parseFloat(is0?i0.pop:i45.pop) || 0;
                    const bePop = (r.bePop || 0) * 100;
                    if (!pop) return '#30363d';
                    return pop >= bePop ? '#238636' : '#da3633';
                  })(),
                  background: (() => {
                    const pop = parseFloat(is0?i0.pop:i45.pop) || 0;
                    const bePop = (r.bePop || 0) * 100;
                    if (!pop) return '#0d1117';
                    return pop >= bePop ? '#0d2818' : '#2d0f0f';
                  })(),
                  color: (() => {
                    const pop = parseFloat(is0?i0.pop:i45.pop) || 0;
                    const bePop = (r.bePop || 0) * 100;
                    if (!pop) return '#c9d1d9';
                    return pop >= bePop ? '#3fb950' : '#f85149';
                  })()
                }}
              />
              {r.bePop > 0 && <div style={{fontSize:11,color:'#a8b2be',marginTop:2}}>Min POP: {(r.bePop*100).toFixed(1)}%</div>}
              {!is0 && i45.popSource === 'model' && exitSim && (
                <div data-testid="pop-model-note" style={{fontSize:11.5,color:'#58a6ff',marginTop:2,lineHeight:1.4}}>
                  Model POP — {exitSim.paths.toLocaleString()} simulated paths, closing at the target or at {payCurve.closeDte} DTE.
                  {' '}Type TWS's POP to override.
                </div>
              )}
            </div>
            <div>
              <Inp label={!is0 && i45.winSource === 'model' ? 'Win amount ($) — model, curve peak' : 'Win amount ($)'} field="win" value={is0?i0.win:i45.win} onChange={v=>is0?set0('win',v):set45('win',v)}/>
              <PrefillChip payoffVal={sizingPay?.maxProfit} fieldVal={is0?i0.win:i45.win}
                onFill={v=>is0?set0('win',v):set45('win',v)}/>
            </div>
            <div>
              <label className="text-xs text-text-muted block mb-1">Risk / contract ($)</label>
              <input type="number" step="any"
                value={is0?i0.risk:i45.risk}
                data-field="risk" onChange={e=>is0?set0('risk',e.target.value):set45('risk',e.target.value)}
                placeholder="—"
                style={{
                  width:'100%', padding:'8px 12px', borderRadius:8, fontSize:14, fontFamily:'JetBrains Mono,monospace',
                  outline:'none', border:'1px solid',
                  borderColor: (() => {
                    const riskVal = parseFloat(is0?i0.risk:i45.risk) || 0;
                    const kellyDol = r.kellyDollar || 0;
                    if (!riskVal) return '#30363d';
                    return riskVal <= kellyDol ? '#238636' : '#da3633';
                  })(),
                  background: (() => {
                    const riskVal = parseFloat(is0?i0.risk:i45.risk) || 0;
                    const kellyDol = r.kellyDollar || 0;
                    if (!riskVal) return '#0d1117';
                    return riskVal <= kellyDol ? '#0d2818' : '#2d0f0f';
                  })(),
                  color: (() => {
                    const riskVal = parseFloat(is0?i0.risk:i45.risk) || 0;
                    const kellyDol = r.kellyDollar || 0;
                    if (!riskVal) return '#c9d1d9';
                    return riskVal <= kellyDol ? '#3fb950' : '#f85149';
                  })()
                }}
              />
              {r.kellyDollar > 0 && <div style={{fontSize:11,color:'#a8b2be',marginTop:2}}>Adj Kelly $: {r.kellyDollar.toFixed(0)}</div>}
              {!is0 && i45.riskSource === 'model' && (
                <div data-testid="risk-model-note" style={{fontSize:11.5,color:'#58a6ff',marginTop:2,lineHeight:1.4}}>
                  Model risk — the most the position can lose at the near expiry (the debit for a calendar; debit + strike gap for a wide diagonal). TWS margin impact should match; type it to override.
                </div>
              )}
              <PrefillChip payoffVal={sizingPay?.maxLoss} fieldVal={is0?i0.risk:i45.risk}
                onFill={v=>is0?set0('risk',v):set45('risk',v)}/>
            </div>
          </div>
          {/* Combo quote — the two numbers TWS prints under the Strategy Builder.
              Fetch Greeks fills them from the bridge; typed by hand they work with
              no bridge at all. They drive the frictions gauge below and nothing else. */}
          <div className="grid grid-cols-2 gap-2.5 mt-2">
            <Inp label="Combo bid" value={is0?i0.comboBid:i45.comboBid}
              onChange={v=>is0?set0('comboBid',v):set45('comboBid',v)}/>
            <Inp label="Combo ask" value={is0?i0.comboAsk:i45.comboAsk}
              onChange={v=>is0?set0('comboAsk',v):set45('comboAsk',v)}/>
          </div>
          {/* What you are about to pay, against the quote and against the model.
              Four numbers in one line because the comparison IS the decision: the
              SPY 767/770/775 of 30 Sep was bid at 1.11 with fair near 0.75, and
              nothing on the screen put those side by side. (Oct 2026.) */}
          {(() => {
            const bid = parseFloat(is0 ? i0.comboBid : i45.comboBid);
            const ask = parseFloat(is0 ? i0.comboAsk : i45.comboAsk);
            if (!isFinite(bid) || !isFinite(ask) || ask < bid) return null;
            const mid = (bid + ask) / 2, spread = ask - bid;
            const fair = r.priceCheck ? r.priceCheck.fair : null;
            const ncd = parseFloat(is0 ? i0.netCreditDebit : i45.netCreditDebit);
            const yours = isFinite(ncd) ? -ncd : null;      // debit paid, as a positive
            // How far the typed price sits from the mid, measured in spreads. Half a
            // spread is paying the ask; more than that is paying through the market.
            const spreads = (yours != null && spread > 0) ? (yours - mid) / spread : null;
            const setPrice = v => {
              const t = (-v).toFixed(2);
              if (is0) set0('netCreditDebit', t); else set45('netCreditDebit', t);
            };
            const col = spreads == null ? '#c9d1d9'
              : spreads > 0.75 ? '#f85149' : spreads > 0.5 ? '#d29922' : '#3fb950';
            return (
              <div style={{marginTop:8,padding:'7px 9px',borderRadius:6,background:'#0d1117',
                border:'1px solid #21262d',fontSize:12.5,lineHeight:1.6}}>
                <div style={{display:'flex',gap:14,flexWrap:'wrap',alignItems:'center'}}>
                  <span><span style={{color:'#8b949e'}}>bid </span><b className="mono">{bid.toFixed(2)}</b>
                    <span style={{color:'#8b949e'}}> / ask </span><b className="mono">{ask.toFixed(2)}</b></span>
                  <span><span style={{color:'#8b949e'}}>mid </span><b className="mono">{mid.toFixed(2)}</b></span>
                  <span><span style={{color:'#8b949e'}}>spread </span><b className="mono">{spread.toFixed(2)}</b></span>
                  {fair != null && <span><span style={{color:'#8b949e'}}>fair </span>
                    <b className="mono">{fair.toFixed(2)}</b></span>}
                  {yours != null && <span style={{color:col}}><span style={{color:'#8b949e'}}>you </span>
                    <b className="mono">{yours.toFixed(2)}</b>
                    {spreads != null && <span> ({spreads >= 0 ? '+' : ''}{spreads.toFixed(1)} spreads from mid)</span>}
                  </span>}
                </div>
                <div style={{marginTop:4,color:'#9aa4b0'}}>
                  {/* Plain guidance rather than a rule: a multi-leg combo fills at mid
                      more often than people expect, and the half-spread saved is the
                      same money as a better entry. */}
                  A limit at <b className="mono" style={{color:'#c9d1d9'}}>{mid.toFixed(2)}</b> is usually
                  workable on a {(r.payoff?.legs?.length || 3)}-leg combo with patience; paying the ask
                  costs <b className="mono" style={{color:'#c9d1d9'}}>{(spread / 2).toFixed(2)}</b> per
                  contract each way.
                  {fair != null && mid > 0 && Math.abs(mid - fair) > 0.10 && (
                    <> The market&rsquo;s mid is {mid > fair ? 'above' : 'below'} the model by{' '}
                      <b className="mono" style={{color:'#c9d1d9'}}>{Math.abs(mid - fair).toFixed(2)}</b> —
                      {mid > fair ? ' implied vol is richer than the EM you typed' : ' check the quote is live'}.</>
                  )}
                </div>
                <div style={{marginTop:5,display:'flex',gap:6,flexWrap:'wrap'}}>
                  <button onClick={() => setPrice(mid)}
                    className="text-[12px] px-2 py-0.5 rounded border border-bg-border text-text-muted hover:text-white hover:border-accent transition-colors">
                    Use mid {mid.toFixed(2)}
                  </button>
                  <button onClick={() => setPrice(+(mid + spread / 4).toFixed(2))}
                    title="A quarter of the way to the ask — the usual price of getting filled promptly"
                    className="text-[12px] px-2 py-0.5 rounded border border-bg-border text-text-muted hover:text-white hover:border-accent transition-colors">
                    Mid + ¼ spread {(mid + spread / 4).toFixed(2)}
                  </button>
                  <button onClick={() => setPrice(ask)}
                    className="text-[12px] px-2 py-0.5 rounded border border-bg-border text-text-faint hover:text-white hover:border-red transition-colors">
                    Pay the ask {ask.toFixed(2)}
                  </button>
                </div>
              </div>
            );
          })()}

          {(() => {
            const f = r.frictions;
            if (!f) return (
              <div style={{marginTop:8,fontSize:12.5,color:'#9aa4b0',lineHeight:1.5}}>
                Enter the combo bid/ask above (or press Fetch Greeks) to price what getting
                in and out of this structure costs against its maximum profit.
              </div>
            );
            const col = f.signal === 'clean' ? '#3fb950' : f.signal === 'acceptable' ? '#7bc74d'
              : f.signal === 'heavy' ? '#d29922' : '#f85149';
            const bg  = f.signal === 'prohibitive' ? '#2d0f0f' : f.signal === 'heavy' ? '#2a1f00' : '#0d1117';
            return (
              <div style={{marginTop:8,padding:'10px 12px',borderRadius:8,background:bg,
                border:`1px solid ${f.signal === 'prohibitive' ? '#5c1f1f' : '#21262d'}`,
                fontSize:13,lineHeight:1.5,color:'#c9d1d9'}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',gap:10}}>
                  <span style={{fontWeight:600}}>Frictions</span>
                  <span className="mono" style={{color:col,fontWeight:700}}>
                    {(f.pct * 100).toFixed(0)}% of max profit · {f.signal}
                  </span>
                </div>
                <div style={{fontSize:12.5,color:'#a8b2be',marginTop:3}}>
                  spread {f.spreadWidth.toFixed(2)} wide → ${Math.round(f.spreadCost)} round trip · commission
                  ${f.commission.toFixed(2)} on {f.legCount} contracts · <strong style={{color:'#c9d1d9'}}>${Math.round(f.total)}</strong> to
                  get in and out of ${Math.round(fv(is0?i0:i45,'win'))} max profit
                  {r.contracts > 1 && <> · ${Math.round(f.totalAll)} at {r.contracts} contracts</>}
                </div>
                <div style={{fontSize:12.5,color:col,marginTop:4}}>{f.action}</div>
              </div>
            );
          })()}
          {/* Risk budget — the account limits Kelly sizing is computed against.
              These fields have no inputs on the panel (they seed from the account
              config), so without this line the denominator was un-auditable. */}
          {(() => {
            const b = is0 ? i0 : i45;
            return (
              <div style={{marginTop:6,fontSize:12.5,color:'#a8b2be',lineHeight:1.5}}>
                <span onClick={()=>setShowRiskBudget(v=>!v)} style={{cursor:'pointer',userSelect:'none'}}
                  title="What Kelly sizing is computed against — click to expand">
                  {showRiskBudget ? '▾' : '▸'} Risk budget: bankroll ${fv(b,'bankroll').toFixed(0)} · max loss/trade ${fv(b,'maxLoss').toFixed(0)} · max open ${fv(b,'maxOpen').toFixed(0)}
                </span>
                {showRiskBudget && (
                  <div style={{marginTop:2,paddingLeft:14,color:'#9aa4b0'}}>
                    Start-of-day bankroll ${fv(b,'startBR').toFixed(0)} · account {acfg.id || 'default'} — seeded from account settings
                    (bankroll / max daily loss / max open risk). Adj Kelly $ and the contract cap are computed against these numbers.
                  </div>
                )}
              </div>
            );
          })()}
          {r.targetMax > 0 && (() => {
            const ncdVal = parseFloat(is0?i0.netCreditDebit:i45.netCreditDebit) || 0;
            const actualIsCredit = ncdVal >= 0;
            return <CreditTape
              value={Math.abs(ncdVal)}
              low={r.targetLow}
              high={r.targetHigh}
              max={r.targetMax}
              isCredit={actualIsCredit}
              label={r.targetLabel}
            />;
          })()}
          {r.targetLabel && !r.targetMax && <div style={{fontSize:12.5,color:'#a8b2be',marginTop:4,fontStyle:'italic'}}>{r.targetLabel}</div>}
          {is0 && (
            <div className="grid grid-cols-2 gap-2.5 mt-2">
              <div>
                <label className="text-xs text-text-muted block mb-1">Hours remaining</label>
                <input type="number" step="0.1"
                  value={i0.hours}
                  onChange={e=>set0('hours',e.target.value)}
                  style={{
                    width:'100%', padding:'8px 12px', borderRadius:8, fontSize:14,
                    fontFamily:'JetBrains Mono,monospace', outline:'none',
                    border:'1px solid #30363d', background:'#0d1117', color:'#c9d1d9'
                  }}
                />
                <div style={{fontSize:11,color:'#8b949e',marginTop:2}}>Auto: 3pm ET minus current time</div>
              </div>
            </div>
          )}

          {/* Profit target scale */}
          {(parseFloat(is0?i0.netCreditDebit:i45.netCreditDebit) || 0) !== 0 && (
            <ProfitTaker ncd={signedNet(ticketNet, cashType)} win={parseFloat(is0?i0.win:i45.win) || 0}
              contracts={r.contracts} underlying={(is0?i0:i45).underlying} legs={r.legs} onPlan={setExitPlan}
              engine={is0 ? '0DTE' : '45DTE'} kelly={r.contracts} commRate={commRateAcct} strategy={effectiveStrat}
              tastyFly={flyTastyOk ? tastyFly : null} onTastyFly={setTastyFly}
              closeDte={!is0 ? (r.closeDte || null) : null} onCloseDte={setTsClose} />
          )}

          </InputSection>

          {/* Greeks & tail risk */}
          <InputSection
            title="Greeks & tail risk"
            info="Enter from your broker's position Greeks, or fetch live from TWS. Theta = daily dollar decay, SIGNED: positive if the position collects decay, negative if it pays it (a long butterfly or debit spread before the body is reached). Fetching from TWS fills the sign for you; entering by hand, keep the minus sign - the survivability read inverts on it. Delta = price sensitivity. Gamma = delta acceleration. Gamma strike = price where gamma is highest (pin magnet). Used for trade survivability analysis (Directional Edge). UNITS: Theta, Delta, Gamma and Vega are POSITION-level (per-share greek x contracts x 100), so Delta 4.68 means the position gains $4.68 per 1 point of underlying. Wing |Δ| below is the opposite — a PER-SHARE delta between 0 and 1. Two different scales, and TWS fills both correctly; a position delta near 5 alongside a wing delta near 0.2 is not an import error. Wing |Δ|: enter the absolute delta of the lowest- and highest-strike long legs (put OR call — the engine converts each by its right) for the skew-aware P(max loss) cross-check. All Greeks are optional — nothing here blocks the decision."
            collapsed={isCollapsed('greeks')}
            onToggle={() => toggleSection('greeks')}
            onExpand={() => expandSection('greeks')}
            actions={<>
              {greeksFresh && (() => {
                const rt = greeksFresh.dataType === 'realtime';
                const dl = greeksFresh.dataType === 'delayed';
                const age = greeksFresh.asOf ? Math.max(0, Math.round((Date.now() - new Date(greeksFresh.asOf).getTime()) / 1000)) : null;
                const txt = rt ? 'REAL-TIME' : dl ? 'DELAYED ~15m' : greeksFresh.dataType === 'frozen' ? 'FROZEN' : (greeksFresh.label || '—').toUpperCase();
                const ageTxt = age == null ? '' : age < 60 ? ' \u00b7 ' + age + 's ago' : ' \u00b7 ' + Math.round(age/60) + 'm ago';
                // Net greeks are only a valid sum when every leg came off the same
                // computation. Amber the badge and name the source when they did not.
                const mixed = !!greeksFresh.greeksMixed;
                const srcTxt = mixed ? ' \u00b7 ' + String(greeksFresh.greekSource || 'non-model').toUpperCase() : '';
                return <span title={(greeksFresh.label || '') + (greeksFresh.undPrice ? ' \u00b7 model px ' + greeksFresh.undPrice : '')
                    + (mixed ? ' \u00b7 not model greeks: legs served by ' + greeksFresh.greekSource + ' computation, so the net sum is unreliable - refetch' : '')}
                  style={{fontSize:12,fontWeight:700,letterSpacing:'0.04em',padding:'2px 8px',borderRadius:4,
                    background: mixed ? '#2d1e0a' : rt ? '#0d2818' : '#161b22',
                    color: mixed ? '#e3a008' : rt ? '#3fb950' : dl ? '#e3a008' : '#a8b2be',
                    border: '1px solid ' + (mixed ? '#9e6a03' : rt ? '#238636' : '#30363d')}}>{txt}{ageTxt}{srcTxt}</span>;
              })()}
              <button onClick={handleFetchGreeks} disabled={fetchingGreeks}
                title="Pull fresh model Greeks + underlying price for the current strikes — use right before entry"
                style={{padding:'3px 10px',borderRadius:6,border:'1px solid #30363d',background:fetchingGreeks?'#161b22':'transparent',color:fetchingGreeks?'#a8b2be':'#2f81f7',fontSize:12.5,fontWeight:600,cursor:'pointer'}}>
                {fetchingGreeks ? 'Fetching…' : '🔄 Refresh (live)'}
              </button>
            </>}>
          <div className="grid grid-cols-2 gap-2.5">
            {is0 ? <>
              <Inp label="Theta ($/day, position)" value={i0.theta} onChange={v=>set0('theta',v)}/>
              <Inp label="Delta ($ per 1 pt, position)" value={i0.delta} onChange={v=>set0('delta',v)}/>
              <Inp label="Gamma (Δ$ per 1 pt, position)" value={i0.gamma} onChange={v=>set0('gamma',v)}/>
              <Inp label="Gamma strike" value={i0.gamStrike} onChange={v=>set0('gamStrike',v)}/>
              <Inp label="Lower wing |Δ| (lowest strike)" value={i0.lowerWingDelta} onChange={v=>set0('lowerWingDelta',v)}/>
              <Inp label="Upper wing |Δ| (highest strike)" value={i0.upperWingDelta} onChange={v=>set0('upperWingDelta',v)}/>
            </> : <>
              <Inp label="Theta ($/day, position)" value={i45.theta} onChange={v=>set45('theta',v)}/>
              <Inp label="Vega ($ per 1 vol pt, position)" value={i45.vega} onChange={v=>set45('vega',v)}/>
              <Inp label="Delta ($ per 1 pt, position)" value={i45.delta} onChange={v=>set45('delta',v)}/>
              {!is0 && <Inp label="BPR ($)" value={i45.bpr} onChange={v=>set45('bpr',v)}/>}
              <Inp label="Lower wing |Δ| (lowest strike)" value={i45.lowerWingDelta} onChange={v=>set45('lowerWingDelta',v)}/>
              <Inp label="Upper wing |Δ| (highest strike)" value={i45.upperWingDelta} onChange={v=>set45('upperWingDelta',v)}/>
            </>}
          </div>
          {r.pMaxLoss != null && (
            <div style={{marginTop:8,padding:'10px 12px',borderRadius:8,background:'#0d1117',border:'1px solid #21262d',fontSize:13,lineHeight:1.5,color:'#c9d1d9'}}>
              <span style={{color:'#fff',fontWeight:700,fontSize:14}}>P(max loss): {(r.pMaxLoss*100).toFixed(1)}%</span>
              <span style={{marginLeft:8,padding:'2px 7px',borderRadius:4,fontSize:12,fontWeight:600,
                background: r.pMaxLossSource==='blend'?'#0d2818':r.pMaxLossSource==='delta'?'#1f1a0d':'#161b22',
                color: r.pMaxLossSource==='blend'?'#3fb950':r.pMaxLossSource==='delta'?'#d29922':'#a8b2be'}}>
                {r.pMaxLossSource==='blend'?'MODEL + DELTA':r.pMaxLossSource==='delta'?'DELTA (skew)':'MODEL (flat vol)'}
              </span>
              <div style={{marginTop:6,color:'#e6edf3'}}>
                {r.pMaxLossModel!=null && <>Model {(r.pMaxLossModel*100).toFixed(1)}% ({is0?'VIX1D':`${i45.dte||45}d IV`}, flat)</>}
                {r.pMaxLossDelta!=null && <> · Delta {(r.pMaxLossDelta*100).toFixed(1)}% (real IV + skew)</>}
                {r.pMaxLossDelta==null && <> · enter |Δ| of each outer long leg above (put or call — the engine converts by right) for the skew-aware cross-check</>}
              </div>
              {r.pMaxLossLow!=null && r.pMaxLossHigh!=null && (
                <div style={{marginTop:3,color:'#a8b2be'}}>Down tail {(r.pMaxLossLow*100).toFixed(1)}% · Up tail {(r.pMaxLossHigh*100).toFixed(1)}%</div>
              )}
            </div>
          )}
          </InputSection>
        </div>

        {/* ── RESULTS PANEL ── */}
        <div style={{display: drawerTab && drawerTab !== 'inputs' ? 'grid' : 'none',gridTemplateColumns:'repeat(auto-fit, minmax(420px, 1fr))',gap:16,alignItems:'start'}}>
          <div className="empty:hidden" style={tabShow('setup')}>
          {/* Setup quality — weighted bar + points-lost list (full rows collapsible) */}
          <SetupQualityCard r={r} sBg={sBg} sClr={sClr} />

          </div>
          <div className="empty:hidden" style={tabShow('structures')}>
          {/* Strategy ratings */}
          <div className="card">
            <div className="flex items-center justify-between mb-1">
              <SectionLabel white info="Each strategy rated EXCELLENT, GOOD, MARGINAL, or POOR based on current regime, direction strength, and move consumed. Every row is clickable - including POOR - so you can override the engine and push any structure through; the rating stays on the ticket as information, not as a gate. BWB preferred for strong direction, Asymmetric for mild, Standard butterfly for neutral.">Strategy ratings — {r.regime}</SectionLabel>
              {isOverride && <span style={{fontSize:12,color:'#d29922'}}>Override active</span>}
            </div>
            {r.runnerUp && !isOverride && (
              <div style={{fontSize:12.5,color:'#a8b2be',marginBottom:6,lineHeight:1.5}}>
                {r.tiebreakApplied ? <>Tiebreak: chose <b style={{color:'#c9d1d9'}}>{r.bestStrat}</b> over </> : <>Also {r.runnerUp.rating.toLowerCase()}: </>}
                <span onClick={()=>setOverrideStrat(r.runnerUp.name)} title="Switch to this structure"
                  style={{color:'#58a6ff',cursor:'pointer',textDecoration:'underline'}}>{r.runnerUp.name}</span>
                {r.tiebreakApplied ? <> (closer regime fit) · click to switch</> : <> · click to switch</>}
              </div>
            )}
            <div className="space-y-0.5">
              {r.ratings.map((s,i) => {
                const cls = s.rating==='EXCELLENT'?'badge-green':s.rating==='GOOD'?'badge-blue':s.rating==='MARGINAL'?'badge-amber':'badge-red';
                // Every strategy is selectable, POOR included. The rating is
                // information about the structure, not permission to trade it -
                // a discretionary ticket can always be pushed through and logged
                // against its real rating. (Jul 2026.)
                const clickable = true;
                const isSelected = overrideStrat === s.name;
                return (<div key={i}
                  onClick={() => { if (clickable) setOverrideStrat(isSelected ? null : s.name); }}
                  className={`flex items-center justify-between py-1.5 rounded px-1 -mx-1 transition-colors ${clickable ? 'cursor-pointer hover:bg-[#161b22]' : 'opacity-50'} ${isSelected ? 'bg-[#1f1a0d] ring-1 ring-[#9e6a03]' : ''}`}>
                  <span className="text-sm text-white">{s.name}
                    {(() => {
                      const ct = resolveCashType(s.name, null);
                      const t = ct === 'credit' ? 'CR' : ct === 'debit' ? 'DR' : 'CR/DR';
                      const c = ct === 'credit' ? '#3fb950' : ct === 'debit' ? '#e3a008' : '#9aa4b0';
                      return <span title={ct==='credit'?'Credit — collect premium':ct==='debit'?'Debit — pay premium':'Credit or debit'}
                        style={{marginLeft:6,fontSize:11,fontWeight:700,color:c,letterSpacing:'0.03em'}}>{t}</span>;
                    })()}
                  </span>
                  <div className="flex items-center gap-2">
                    {isSelected && <span style={{fontSize:11,color:'#d29922',fontWeight:600}}>SELECTED</span>}
                    <span className={`badge text-[12px] ${cls}`}>{s.rating}</span>
                  </div>
                </div>);
              })}
            </div>
          </div>

          </div>
          <div className="empty:hidden" style={tabShow('structures')}>
          {/* Structure comparison — current pick vs the next-best rated structures,
              each a FULL engine re-run on the same inputs (the calc is pure). */}
          {stratCompare && stratCompare.length > 1 && (
            <div className="card">
              <SectionLabel white info="Side-by-side FULL engine runs for the top structures on the SAME market inputs — only the strategy differs. Composite, EV, P(max loss) and Kelly are complete engine outputs, not the rating shortcut. Net cr/dr is the engine's TARGET fill for that structure. Click a column header to open that structure in its OWN tab, carrying this ticket's market data, vol and greeks — only Session & sizing is cleared, because max profit, max loss, POP and your fill belong to the legs you were looking at. This ticket is left exactly as it is, so both stay on screen.">Structure comparison</SectionLabel>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr>
                      <th className="text-left py-1.5 px-1"></th>
                      {stratCompare.map((c, i) => (
                        <th key={i} onClick={() => { if (!c.current) openStructureInTab(c.name); }}
                          title={c.current ? 'Selected structure' : 'Open this structure in its own tab \u2014 same market data, sizing cleared'}
                          className="text-center py-1.5 px-2 cursor-pointer hover:bg-[#161b22]"
                          style={{minWidth:104,borderRadius:6}}>
                          <div style={{fontSize:12.5,fontWeight:700,color:c.current?'#fff':'#c9d1d9'}}>{c.name}</div>
                          <div style={{fontSize:8,fontWeight:600,marginTop:1,letterSpacing:'0.04em',
                            color: c.current ? (isOverride ? '#d29922' : '#3fb950') : '#9aa4b0'}}>
                            {c.current ? (isOverride ? '✓ OVERRIDE' : '✓ ENGINE PICK') : c.rating}
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { label: 'Composite', render: c => { const s = compositeScoreOf(c.res);
                          const col = s>=75?'#3fb950':s>=55?'#7bc74d':s>=35?'#d29922':'#f85149';
                          return <span style={{color:col,fontWeight:700}}>{s}/100</span>; } },
                      { label: 'EV / trade', render: c => c.res.ev
                          ? <span style={{color: c.res.ev>0?'#3fb950':'#f85149'}}>${c.res.ev.toFixed(0)}</span>
                          : '--' },
                      { label: 'P(max loss)', render: c => c.res.pMaxLoss != null
                          ? <span style={{color: c.res.pMaxLoss<=0.15?'#3fb950':c.res.pMaxLoss<=0.30?'#d29922':'#f85149'}}>{(c.res.pMaxLoss*100).toFixed(1)}%</span>
                          : '--' },
                      { label: 'Net cr/dr (target)', render: c => c.res.targetCredit != null
                          ? <span style={{color: c.res.targetCredit>=0?'#3fb950':'#e3a008'}}>{c.res.targetCredit>=0?'cr':'dr'} ${Math.abs(c.res.targetCredit).toFixed(2)}</span>
                          : '--' },
                      { label: 'Breakevens', render: c => c.res.payoff?.breakevens?.length
                          ? c.res.payoff.breakevens.map(b=>b.toFixed(0)).join(' / ')
                          : '--' },
                      { label: 'Kelly', render: c =>
                          <span style={{color: c.res.kellyOverRisk?'#f85149':'#e6edf3'}}>{c.res.contracts}x · ${c.res.kellyDollar?.toFixed(0)||0}</span> },
                    ].map((row, ri) => (
                      <tr key={ri} className="border-t border-[#21262d]">
                        <td className="py-1.5 px-1 text-[#a8b2be]">{row.label}</td>
                        {stratCompare.map((c, i) => (
                          <td key={i} className="py-1.5 px-2 text-center mono">{row.render(c)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          </div>
          <div className="empty:hidden" style={tabShow('sizing')}>
          {/* Entry price — what is being paid against what the structure is worth */}
          {r.priceCheck && (
            <div className="card">
              <SectionLabel white info="What you are paying against what the structure is worth right now at the prevailing spot and vol, plus the arbitrage bounds — the range of prices the strikes can possibly settle between. A price outside those bounds is impossible at any volatility; a price far inside them but well above fair value is simply a bad fill. Fair value uses the same sigma as P(max loss), so it cannot disagree with the rest of the ticket.">
                Entry price
              </SectionLabel>
              {(() => {
                const pc = r.priceCheck;
                const ratio = pc.ratio;
                const col = pc.arb ? '#f85149'
                  : ratio == null ? '#a8b2be'
                  : ratio >= 1.30 ? '#f85149' : ratio >= 1.15 ? '#d29922'
                  : ratio <= 0.8 ? '#3fb950' : '#c9d1d9';
                return (
                  <>
                    <div className="grid grid-cols-2 gap-1.5">
                      <KV label={pc.cost >= 0 ? 'Paying (debit)' : 'Receiving (credit)'}
                        value={Math.abs(pc.cost).toFixed(2)} />
                      <KV label="Modelled fair at spot" value={pc.fair.toFixed(2)} />
                      <KV label="Possible range for these strikes"
                        value={`${pc.bareMin.toFixed(2)} to ${pc.bareMax.toFixed(2)}`} />
                      <KV label="Max profit at this price" value={'$' + (pc.maxProfitBare * 100 - pc.cost * 100).toFixed(0)} />
                    </div>
                    <div className="text-sm mt-2" style={{
                      padding: '6px 8px', borderRadius: 4, background: '#0d1117',
                      border: '1px solid #21262d', color: col
                    }}>
                      {pc.arb
                        ? 'Impossible at any volatility — this price is outside what the strikes can pay'
                        : ratio == null
                          ? 'No fair-value comparison available'
                          : <>Paying <b>{ratio.toFixed(2)}×</b> fair value
                              {ratio > 1.05 && <> — it must appreciate <b>{(pc.cost - pc.fair).toFixed(2)}</b> before the trade is even</>}
                              {ratio <= 0.8 && <> — cheap against the model, check the quote is real</>}
                            </>}
                    </div>
                  </>
                );
              })()}
            </div>
          )}

          </div>
          <div className="empty:hidden" style={tabShow('timing')}>
          {/* When the value arrives — the time dimension of the payoff below */}
          {accrual && (
            <div className="card">
              <SectionLabel white info="A butterfly or condor converges on its payoff only as the spread of possible expiry prices collapses onto the body, so most of its value arrives in the final hours of expiry day. This table prices that: what the structure is worth at each point from now to expiry, assuming price sits AT the body (the time question, isolated from the direction question), and what share of the remaining move each window carries. Display only — no score, gate or sizing reads this.">
                When the value arrives
              </SectionLabel>

              <div className="flex items-center gap-3 flex-wrap mb-2">
                <span className="text-[12px] text-text-muted">Expires</span>
                {[[0, 'today'], [1, 'next session']].map(([v, lbl]) => (
                  <button key={v} onClick={() => setExpirySessions(v)}
                    className={`text-[12px] px-2 py-0.5 rounded border transition-colors ${expirySessions === v
                      ? 'border-accent text-white bg-accent/10' : 'border-bg-border text-text-muted hover:text-white'}`}>
                    {lbl}
                  </button>
                ))}
                <span className="text-[12px] text-text-faint">
                  {accrual.sessionsLeft.toFixed(2)} sessions left · body {accrual.bodyStrike} · ceiling {accrual.maxValue.toFixed(2)}
                </span>
              </div>

              {accrual.outToday && accrual.outToday.pct != null && (
                <div className="text-[12px] mb-2" style={{
                  padding: '6px 8px', borderRadius: 4, background: '#0d1117', border: '1px solid #21262d',
                  color: accrual.outToday.pct >= 60 ? '#3fb950' : accrual.outToday.pct >= 30 ? '#d29922' : '#f85149'
                }}>
                  Closing at today's 15:00 captures <b>{accrual.outToday.pct.toFixed(0)}%</b> of the value still to come — {accrual.outToday.verdict}
                </div>
              )}

              <div style={{ overflowX: 'auto' }}>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-text-faint text-[12px] uppercase tracking-wider">
                      <th className="text-left py-1 pr-2">Point</th>
                      <th className="text-right py-1 pr-2">At body</th>
                      <th className="text-right py-1 pr-2">At spot</th>
                      <th className="text-right py-1 pr-2">% of max</th>
                      <th className="text-right py-1 pl-2">Share of the move</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accrual.rows.map((row, i) => (
                      <tr key={i} style={{ borderTop: '1px solid #21262d' }}>
                        <td className="py-1 pr-2 text-text-muted">{row.label}</td>
                        <td className="py-1 pr-2 text-right mono">{row.atBody.toFixed(2)}</td>
                        <td className="py-1 pr-2 text-right mono text-text-muted">{row.atSpot.toFixed(2)}</td>
                        <td className="py-1 pr-2 text-right mono text-text-muted">{row.pctOfMax == null ? '--' : row.pctOfMax.toFixed(0) + '%'}</td>
                        <td className="py-1 pl-2 text-right mono">
                          {row.shareOfRemaining == null || !i ? '—' : row.shareOfRemaining.toFixed(0) + '%'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="text-[12px] text-text-faint mt-2">
                Modelled at {(accrual.sigmaAnnual * 100).toFixed(1)}% annualised, from the session EM. Scores still use today's clock — this table is the payoff's timing, nothing else.
              </div>
            </div>
          )}

          </div>
          <div className="empty:hidden" style={tabShow('timing')}>
          {/* Payoff over time — 45DTE: today / 21-DTE close / expiry, calendars included */}
          {!is0 && payCurve && (
            <div className="card">
              <SectionLabel white info="Position P&L on any date up to expiry, TWS performance-graph style. Opens on the 21-DTE hard close: that is the curve a 45DTE trade realises, since it never reaches expiry. Solid = chosen date, with a band for IV moving ±N vol points. Dotted = today. Dashed = expiry (near expiry for a calendar or diagonal). Each leg is priced with Black-Scholes at its own expiry and IV — Fetch Greeks first for the exact leg IVs. Drag the slider or hover the chart for P&L at a price.">Payoff over time</SectionLabel>
              <PayoffTimeChart cl={payCurve.cl} net={payCurve.net} netSource={payCurve.netSource} spot={payCurve.spot}
                lo={payCurve.lo} hi={payCurve.hi} sigmaNear={payCurve.sigmaNear} nearDte={payCurve.nearDte}
                closeDay={payCurve.closeDay} todayYmd={todayYmd} isTimeSpread={isTimeSpread}
                underlying={i45.underlying} divYield={payCurve.divYield} closeDte={payCurve.closeDte} target={payCurve.target}
                closeOptions={payCurve.closeOptions} closeLeg={payCurve.closeLeg} onCloseDte={setTsClose} exitSim={exitSim} />
            </div>
          )}
          {!is0 && !payCurve && Array.isArray(r.legs) && r.legs.length > 0 && (
            <div className="card" style={{ fontSize: 13, color: '#a8b2be' }}>
              Payoff over time needs the underlying price and IV — Auto-fill or Fetch vol fills both.
            </div>
          )}
          {/* Payoff diagram — full width */}
          {r.payoff && r.payoff.points.length > 0 && (
            <div className="card">
              <SectionLabel white info="P&L diagram at expiration across price range. Green zone = profit, red zone = loss. White line = payoff curve. Blue dashed = current price. Yellow dots = breakeven prices. Calculated from leg structure and net credit/debit entered.">Payoff at expiry</SectionLabel>
              {flyTastyOk && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '0 0 6px' }}>
                  <button type="button" data-testid="tasty-fly-toggle" onClick={() => setTastyFly(v => !v)}
                    title="tastylive's long-fly guidance: take 25–50% of MAX PROFIT. The app's 0DTE default is a % return on the debit, which on a cheap fly is far less."
                    style={{ padding: '3px 10px', borderRadius: 6, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
                      border: '1px solid ' + (tastyFly ? '#2f81f7' : '#30363d'), background: tastyFly ? '#0d1a2b' : 'transparent', color: tastyFly ? '#58a6ff' : '#c9d1d9' }}>
                    {tastyFly ? '✓ ' : ''}tastylive targets: 25–50% of max
                  </button>
                  {r.payoff.maxProfit > 0 && isFinite(signedNet(ticketNet, cashType)) && (
                    <span className="mono" style={{ fontSize: 12, color: '#8b949e' }}>
                      25% of max = +{(r.payoff.maxProfit * 0.25 / (Math.abs(signedNet(ticketNet, cashType)) * 100) * 100).toFixed(0)}% on entry ·
                      50% = +{(r.payoff.maxProfit * 0.5 / (Math.abs(signedNet(ticketNet, cashType)) * 100) * 100).toFixed(0)}%
                    </span>
                  )}
                </div>
              )}
              <PayoffDiagram payoff={r.payoff} currentPrice={is0?fv(i0,'price'):fv(i45,'price')} targets={flyTargets} />
              <div className="grid grid-cols-2 gap-1.5 mt-3">
                <KV label="Max profit" value={'$' + (r.payoff.maxProfit?.toFixed(0)||0)} cls="text-green"/>
                <KV label="Max loss" value={'$' + (r.payoff.maxLoss?.toFixed(0)||0)} cls="text-red"/>
                <KV label="Breakeven(s)" value={r.payoff.breakevens?.map(b=>b.toFixed(1)).join(', ')||'--'}/>
                <KV label="Profit band" value={r.payoff.profitBandWidth>0?(r.payoff.profitBandLow.toFixed(0)+'\u2013'+r.payoff.profitBandHigh.toFixed(0)+' ('+r.payoff.profitBandWidth.toFixed(0)+' pts)'):'--'}/>
              </div>
            </div>
          )}

          </div>
          <div className="empty:hidden" style={tabShow('sizing')}>
          {/* Sharpe-adjusted Kelly sizing */}
          <div className="card">
            <SectionLabel white info="Position sizing using 4-factor adjusted Kelly: Raw Kelly × Vol Factor (VIX level) × Sharpe Factor (EV/risk edge) × Strategy Modifier (tail risk per strategy). Vol Factor: VIX <12 = 1.0, 12-18 = 0.75, 18-25 = 0.50, >25 = 0.25. Sharpe Factor: based on EV/risk ratio. Strategy Modifier: butterflies 1.0, IC/credit spreads 0.85, BWB 0.80, reversed condor 0.70. Adj Kelly $ = max recommended risk. Risk per contract turns red if it exceeds Kelly $. POP turns red if below breakeven POP.">Sizing (Sharpe-adjusted Kelly)</SectionLabel>
            <div className="grid grid-cols-2 gap-1.5 mb-3">
              <KV label="Contracts" value={r.contractsOverride ? `${r.contracts} (Kelly ${r.kellyContracts})` : r.contracts} cls={r.contractsOverride ? 'text-amber' : ''}/>
              <KV label={r.sizingModel === 'full' ? 'Kelly $' : 'Adj Kelly $'} value={`$${r.kellyDollar?.toFixed(0)||0}`} cls={r.kellyOverRisk?'text-red':'text-green'}/>
              <KV label="Raw Kelly" value={isFinite(r.rawKelly) ? `${(r.rawKelly*100).toFixed(1)}%` : '—'}/>
              <KV label="Adjusted Kelly" value={r.sizingModel === 'full' ? 'not adjusted' : isFinite(r.adjustedKelly) ? `${(r.adjustedKelly*100).toFixed(1)}%` : '—'} cls={r.adjustedKelly<r.rawKelly?'text-amber':''}/>
            </div>
            {r.sizingModel === 'full' && (
              <div data-testid="sizing-full-note" style={{fontSize:13,color:'#a8b2be',margin:'0 0 12px'}}>
                45DTE sizes on full Kelly: no vol, Sharpe or strategy factor is applied. Contracts are capped only by max loss and max open risk in Settings.
              </div>
            )}
            <div className="space-y-3">
              {r.sizingModel !== 'full' && <>
              <SpeedTape label="Vol factor" value={r.volFactor||0} min={0} max={1}
                zones={[{to:0.25,color:'#f85149'},{to:0.50,color:'#d29922'},{to:0.75,color:'#e3b341'},{to:1.0,color:'#3fb950'}]}
                display={r.volFactor?.toFixed(2)||'--'}
                sublabel={r.volFactor>=1?'VIX <12':r.volFactor>=0.75?'VIX 12-18':r.volFactor>=0.50?'VIX 18-25':'VIX >25'} />
              <SpeedTape label="Sharpe factor" value={r.sharpeFactor||0} min={0} max={1}
                zones={[{to:0.25,color:'#f85149'},{to:0.50,color:'#d29922'},{to:0.75,color:'#e3b341'},{to:1.0,color:'#3fb950'}]}
                display={`${r.sharpeFactor?.toFixed(2)||'--'} (${r.sharpeProxy?.toFixed(2)||'--'})`}
                sublabel={r.sharpeProxy>0.30?'Strong edge':r.sharpeProxy>0.15?'Decent edge':r.sharpeProxy>0.05?'Marginal edge':r.sharpeProxy>0?'Weak edge':'Negative EV'} />
              <SpeedTape label="Strategy modifier" value={r.stratModifier||1} min={0.5} max={1}
                zones={[{to:0.70,color:'#f85149'},{to:0.85,color:'#d29922'},{to:0.95,color:'#e3b341'},{to:1.0,color:'#3fb950'}]}
                display={`${r.stratModifier?.toFixed(2)||'--'}`}
                sublabel={r.stratModReason||''} />
              </>}
              <SpeedTape label="POP margin" value={Math.min(r.popMargin||0, 2.5)} min={0} max={2.5}
                zones={[{to:0.8,color:'#f85149'},{to:1.0,color:'#d29922'},{to:1.5,color:'#e3b341'},{to:2.5,color:'#3fb950'}]}
                display={r.popMargin?`${r.popMargin.toFixed(2)}x`:'--'}
                sublabel={r.popMargin>=1.5?'Strong':r.popMargin>=1.0?'Breakeven+':'Below breakeven'} />
              <SpeedTape label="EV / trade" value={Math.max(Math.min(r.ev||0, 500), -200)} min={-200} max={500}
                zones={[{to:-50,color:'#f85149'},{to:0,color:'#d29922'},{to:100,color:'#e3b341'},{to:500,color:'#3fb950'}]}
                display={r.ev?`$${r.ev.toFixed(0)}`:'--'}
                sublabel={(r.evBasis?.mode==='measured'
                  ? `Measured · ${r.evBasis.historyTrades} trades`
                  : `Est. · ${r.evBasis?.historyTrades||0}/${r.evBasis?.threshold||50}`)
                  + (r.ev>100?' · Excellent':r.ev>50?' · Good':r.ev>0?' · Marginal':' · No edge')} />
              {r.evBasis && (
                <div style={{fontSize:'13px',lineHeight:'1.5',color:'#e6edf3',margin:'4px 0 12px',paddingLeft:'2px',whiteSpace:'normal'}}>
                  {r.evBasis.curve
                    ? `EV from the payoff curve (${r.evBasis.curve.paths} paths, close at the target or ${r.evBasis.curve.closeDte} DTE): ${(r.evBasis.winP*100).toFixed(0)}% × $${r.evBasis.avgWin.toFixed(0)} − ${((1-r.evBasis.winP)*100).toFixed(0)}% × $${r.evBasis.avgLoss.toFixed(0)}`
                      + (r.evBasis.commission > 0 ? ` − $${r.evBasis.commission.toFixed(2)} commission` : '')
                      + ` · P(target hit) ${(r.evBasis.curve.pTarget*100).toFixed(0)}%`
                      + (r.evBasis.curve.netSource !== 'ticket' ? ' · priced at model fair — enter the fill' : '')
                  : r.evBasis.mode==='measured'
                    ? `EV from realized history: ${(r.evBasis.winP*100).toFixed(0)}% × $${r.evBasis.avgWin.toFixed(0)} − ${((1-r.evBasis.winP)*100).toFixed(0)}% × $${r.evBasis.avgLoss.toFixed(0)}`
                    : r.evBasis.lossModel === 'stop'
                      ? `EV estimated (win ${r.evBasis.winBasis || ((r.evBasis.winCap*100).toFixed(0) + '% of max')}, losers stopped at ${r.evBasis.capture && r.evBasis.capture.loss && r.evBasis.capture.loss.n > 0 ? 'the blended' : '100% of the premium,'} $${(r.evBasis.lossCap * r.evBasis.maxLoss).toFixed(0)}): ${(r.evBasis.winP*100).toFixed(0)}% × $${r.evBasis.avgWin.toFixed(0)} − ${((1-r.evBasis.winP)*100).toFixed(0)}% × $${(r.evBasis.lossCap * r.evBasis.maxLoss).toFixed(0)}`
                        + (r.evBasis.commission > 0 ? ` − $${r.evBasis.commission.toFixed(2)} commission` : '')
                      : `EV estimated (win ${r.evBasis.winBasis || ((r.evBasis.winCap*100).toFixed(0) + '% of max')}, loss ${(r.evBasis.lossCap*100).toFixed(0)}% of max): ${(r.evBasis.winP*100).toFixed(0)}% × $${r.evBasis.avgWin.toFixed(0)} − ${((1-r.evBasis.winP)*100).toFixed(0)}% × $${r.evBasis.avgLoss.toFixed(0)}`
                      + (r.evBasis.commission > 0 ? ` − $${r.evBasis.commission.toFixed(2)} commission` : '')}
                  {r.evBasis.lossModel === 'stop' && r.evBasis.evHeld != null && (
                    <div data-testid="ev-held" style={{marginTop:4,color:'#8b949e'}}>
                      ⓘ Held to expiry with no stop (P(max loss) {r.evBasis.pMaxLoss != null ? (r.evBasis.pMaxLoss*100).toFixed(0) + '%' : '—'} at full risk): EV ${r.evBasis.evHeld.toFixed(0)}. The stop is what keeps losers at the premium — a gap past it costs more.
                    </div>
                  )}
                  {r.evBasis.targetCapture && !r.evBasis.targetCapture.applied && (
                    <div data-testid="target-capture-info" style={{marginTop:4,color:'#8b949e'}}>
                      ⓘ If winners bank your {r.evBasis.targetCapture.target}% exit target (win capture {(r.evBasis.targetCapture.winCap*100).toFixed(0)}%): EV ${r.evBasis.targetCapture.ev.toFixed(0)}.
                      {' '}For information — EV and Kelly use the historic capture and move only as your closes come in (Analytics → Capture).
                    </div>
                  )}
                  {r.evBasis.mode !== 'measured' && !r.evBasis.curve && r.evBasis.capture && (() => {
                    // Capture tracker: what the win/loss fractions are built from.
                    const cw = r.evBasis.capture.win, cl = r.evBasis.capture.loss;
                    const pc = v => (v * 100).toFixed(0) + '%';
                    const stopLbl = r.evBasis.lossModel === 'stop' ? ' of max (stop at 100% of premium)' : '';
                    const side = (lbl, c, unit) => c.n > 0
                      ? `${lbl} ${pc(c.value)} — ${lbl === 'loss' && stopLbl ? 'stop' : 'assumed'} ${pc(c.prior)}, your ${c.n} closed ${unit} ${pc(c.measured)}`
                      : `${lbl} ${pc(c.value)}${lbl === 'loss' ? stopLbl : ''} — assumed, no closed ${unit} yet`;
                    return (
                      <div data-testid="capture-basis" style={{marginTop:4,color:'#c9d1d9'}}>
                        Capture: {side('win', cw, 'winners')} · {side('loss', cl, 'losers')}
                        {(cw.n > 0 || cl.n > 0) ? ` (blended, ${10} closes = halfway)` : ''}
                      </div>
                    );
                  })()}
                  {r.evBasis.commissionRoundTrip > 0 && (
                    <div style={{marginTop:4,color:'#c9d1d9'}}>
                      Commission {r.evBasis.commissionUnits} contracts × ${r.evBasis.commissionRate.toFixed(2)} × 2 sides = <b style={{color:'#fff'}}>${r.evBasis.commissionRoundTrip.toFixed(2)}</b> per unit
                      {r.evBasis.mode === 'measured' ? ' (already inside the measured history, so not charged again)' : ''}
                    </div>
                  )}
                  {r.evBasis.pMaxLoss != null && (
                    <div style={{marginTop:4,color:'#c9d1d9'}}>
                      {r.evBasis.lossModel === 'stop' ? 'P(max loss) at expiry (blockers and the no-stop line; EV uses the stop)' : 'P(max loss) used in sizing'}: <b style={{color:'#fff'}}>{(r.evBasis.pMaxLoss*100).toFixed(1)}%</b>
                      <span style={{marginLeft:5,fontSize:12,fontWeight:600,color:r.evBasis.pMaxLossSource==='blend'?'#3fb950':r.evBasis.pMaxLossSource==='delta'?'#d29922':'#a8b2be'}}>
                        ({r.evBasis.pMaxLossSource==='blend'?'model+delta':r.evBasis.pMaxLossSource==='delta'?'delta/skew':'model'})
                      </span>
                    </div>
                  )}
                  {r.evBasis.winBreakeven != null && (
                    <div style={{marginTop:2,color:'#c9d1d9'}}>
                      Win needed for EV = 0: <b style={{color: r.ev>=0 ? '#3fb950' : '#e3a008'}}>${r.evBasis.winBreakeven}</b>
                      {r.ev < 0 && r.evBasis.maxWin>0 && <span style={{color:'#a8b2be',fontSize:12.5}}> (currently ${r.evBasis.maxWin.toFixed(0)} max — need +${Math.max(0, r.evBasis.winBreakeven - r.evBasis.maxWin)})</span>}
                    </div>
                  )}
                </div>
              )}
              <SpeedTape label="W/L ratio" value={Math.min(r.wlRatio||0, 3)} min={0} max={3}
                zones={[{to:0.5,color:'#f85149'},{to:1.0,color:'#d29922'},{to:1.5,color:'#e3b341'},{to:3.0,color:'#3fb950'}]}
                display={r.wlRatio?.toFixed(2)||'--'}
                sublabel={r.wlRatio>=1.5?'Wins dominate':r.wlRatio>=1.0?'Balanced':r.wlRatio>=0.5?'POP compensates':'Check sizing'} />
            </div>
            <div className="grid grid-cols-2 gap-1.5 mt-3" style={{paddingTop:8,borderTop:'1px solid #21262d'}}>
              <KV label="BE POP" value={r.bePop?`${(r.bePop*100).toFixed(1)}%`:'--'}/>
              <KV label="Max risk" value={r.maxRisk?`$${r.maxRisk.toFixed(0)}`:'--'}/>
            </div>
          </div>

          </div>
          <div className="empty:hidden" style={tabShow('greeks')}>
          {/* Directional Edge prompt — always visible so the feature is discoverable */}
          {!r.greeks && (
            <div className="card" style={{borderStyle:'dashed',borderColor:'#30363d'}}>
              <div className="flex items-center justify-between mb-1">
                <SectionLabel white info="Directional Edge compares how much price movement can still benefit the position (delta × remaining expected move) against remaining time decay (theta pressure). Enter Greeks — or fetch them from TWS — to unlock the survivability gauges and Edge Ratio.">Trade survivability · Directional Edge</SectionLabel>
              </div>
              <div style={{fontSize:13,color:'#a8b2be',lineHeight:1.5}}>
                Enter <span style={{color:'#c9d1d9'}}>Delta</span> and <span style={{color:'#c9d1d9'}}>Theta</span>{is0 && <> (and optionally Gamma)</>} above to compute Directional Edge — the metric that tells you whether expected price movement still outweighs time decay.
                <button onClick={handleFetchGreeks} disabled={fetchingGreeks}
                  style={{marginLeft:8,padding:'2px 8px',borderRadius:5,border:'1px solid #30363d',background:'transparent',color:'#2f81f7',fontSize:12.5,fontWeight:600,cursor:'pointer'}}>
                  {fetchingGreeks ? 'Fetching…' : '⚡ Fetch from TWS'}
                </button>
              </div>
            </div>
          )}

          </div>
          <div className="empty:hidden" style={tabShow('greeks')}>
          {/* Greeks Analysis — Theta Edge, Gamma Risk, Max Move */}
          {is0 && r.greeks && (
            <div className="card">
              <div className="flex items-center justify-between mb-2">
                <SectionLabel white info="Three survivability gauges plus Directional Edge. Theta Edge = theta earned per unit of directional risk (0.15-0.40 sweet spot). Gamma Risk = how fast delta changes vs theta (< 0.70 safe). Max Tolerable Move = furthest price can move before theta consumed. Directional Edge = remaining expected move × delta vs remaining theta. For credit strategies, lower Edge Ratio is better (theta dominates). For debit strategies, higher is better (move dominates). Butterfly strategies transition through three phases: Approach (need movement to body), Transition (balanced), Collection (theta collecting). Thresholds tighten through the day as gamma accelerates. SIGNED THETA: if the position PAYS decay (negative theta - a long butterfly before the body is reached, a debit spread) every gauge inverts. Theta Edge becomes Decay Cost and small is good, Gamma Risk becomes Gamma Offset and large is good, Max Tolerable Move disappears because there is no theta cushion to consume, and Edge Ratio wants to be HIGH whatever the strategy name says - only the move can pay the decay bill.">Trade survivability</SectionLabel>
                {r.greeks.sweetSpot && <span style={{fontSize:12,fontWeight:600,padding:'2px 8px',borderRadius:4,background:'#0d1f0d',color:'#3fb950'}}>🎯 SWEET SPOT</span>}
              </div>
              <div className="space-y-3">
                {/* Both gauges invert when the position PAYS decay: a small theta ratio
                    means time is cheap rather than that theta cannot defend you, and gamma
                    is the compensation you bought rather than the thing that kills you. Same
                    numbers, mirrored colour zones, renamed labels. (Jul 2026.) */}
                <SpeedTape label={r.greeks.thetaPaid ? 'Decay cost (|Θ| ÷ |Δ| × ATR)' : 'Theta Edge (Θ ÷ |Δ| × ATR)'} value={Math.min(r.greeks.tEdge, 0.6)} min={0} max={0.6}
                  zones={r.greeks.thetaPaid
                    ? [{to:0.05,color:'#3fb950'},{to:0.15,color:'#e3b341'},{to:0.30,color:'#d29922'},{to:0.6,color:'#f85149'}]
                    : [{to:0.05,color:'#f85149'},{to:0.15,color:'#d29922'},{to:0.30,color:'#e3b341'},{to:0.6,color:'#3fb950'}]}
                  display={r.greeks.tEdge.toFixed(3)}
                  sublabel={r.greeks.tEdgeSignal + ' — ' + r.greeks.tEdgeAction} />
                <SpeedTape label={r.greeks.thetaPaid ? 'Gamma offset (Γ × ATR ÷ |Θ|)' : 'Gamma Risk (Γ × ATR ÷ Θ)'} value={Math.min(r.greeks.gRisk, 1.5)} min={0} max={1.5}
                  zones={r.greeks.thetaPaid
                    ? [{to:0.30,color:'#f85149'},{to:0.70,color:'#d29922'},{to:1.20,color:'#e3b341'},{to:1.5,color:'#3fb950'}]
                    : [{to:0.30,color:'#3fb950'},{to:0.70,color:'#e3b341'},{to:1.20,color:'#d29922'},{to:1.5,color:'#f85149'}]}
                  display={r.greeks.gRisk.toFixed(3)}
                  sublabel={r.greeks.gRiskSignal + ' — ' + r.greeks.gRiskAction} />
                {r.greeks.thetaPaid ? (
                  <div className="text-[12px] text-[#a8b2be]" style={{padding:'6px 8px',borderRadius:4,background:'#0d1117',border:'1px solid #21262d'}}>
                    <b style={{color:'#e3a008'}}>Position pays decay</b> · {r.greeks.dsAction}
                  </div>
                ) : (
                <SpeedTape label="Max tolerable move (ΔS_max)" value={Math.min(r.greeks.dsATR * 100, 200)} min={0} max={200}
                  zones={[{to:25,color:'#f85149'},{to:50,color:'#d29922'},{to:100,color:'#e3b341'},{to:200,color:'#3fb950'}]}
                  display={`${r.greeks.dsMax.toFixed(1)} pts (${(r.greeks.dsATR*100).toFixed(0)}% ATR)`}
                  sublabel={r.greeks.dsSignal + ' — ' + r.greeks.dsAction} />
                )}

                {/* Directional Edge */}
                {r.greeks.edgeRatio !== undefined && (
                  <div style={{marginTop:12,paddingTop:10,borderTop:'1px solid #21262d'}}>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-white font-semibold">Directional Edge</span>
                      <span className="text-[12px] px-2 py-0.5 rounded font-semibold" style={{
                        background: r.greeks.edgeSignal==='excellent'?'#0d2818':r.greeks.edgeSignal==='good'?'#0d1a0d':r.greeks.edgeSignal==='marginal'?'#1f1a0d':'#1f0d0d',
                        color: r.greeks.edgeSignal==='excellent'?'#3fb950':r.greeks.edgeSignal==='good'?'#7bc74d':r.greeks.edgeSignal==='marginal'?'#d29922':'#f85149'
                      }}>{r.greeks.edgePhase}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 mb-2">
                      <div className="text-center p-2 rounded" style={{background:'#0d1117'}}>
                        <div className="text-[11px] text-[#a8b2be]">Directional $</div>
                        <div className="mono text-sm font-bold text-white">${r.greeks.directionalGain?.toFixed(0)}</div>
                        <div className="text-[8px] text-[#8b949e]">{r.greeks.remainingMove?.toFixed(1)} pts left</div>
                      </div>
                      <div className="text-center p-2 rounded" style={{background:'#0d1117'}}>
                        <div className="text-[11px] text-[#a8b2be]">{r.greeks.thetaPaid ? 'Decay $ paid' : 'Theta $'}</div>
                        <div className="mono text-sm font-bold" style={{color: r.greeks.thetaPaid ? '#e3a008' : '#fff'}}>{r.greeks.thetaPaid ? '-' : ''}${r.greeks.thetaPressure?.toFixed(0)}</div>
                        <div className="text-[8px] text-[#8b949e]">to planned exit</div>
                      </div>
                      <div className="text-center p-2 rounded" style={{background: r.greeks.edgeSignal==='excellent'?'#0d2818':r.greeks.edgeSignal==='good'?'#0d1a0d':r.greeks.edgeSignal==='marginal'?'#1f1a0d':'#1f0d0d'}}>
                        <div className="text-[11px] text-[#a8b2be]">Edge Ratio</div>
                        <div className="mono text-lg font-bold" style={{color: r.greeks.edgeSignal==='excellent'?'#3fb950':r.greeks.edgeSignal==='good'?'#7bc74d':r.greeks.edgeSignal==='marginal'?'#d29922':'#f85149'}}>{r.greeks.edgeRatio?.toFixed(2)}</div>
                      </div>
                    </div>
                    {/* A position paying decay always wants the move to dominate, whatever
                        its strategy label says - so it takes the higher-is-better zones. */}
                    <SpeedTape label="Move / Theta" value={Math.min(r.greeks.edgeRatio, 4)} min={0} max={4}
                      zones={r.greeks.isCreditStrat && !r.greeks.thetaPaid
                        ? [{to:0.7,color:'#3fb950'},{to:1.0,color:'#e3b341'},{to:1.5,color:'#d29922'},{to:4,color:'#f85149'}]
                        : [{to:0.7,color:'#f85149'},{to:1.0,color:'#d29922'},{to:1.5,color:'#e3b341'},{to:4,color:'#3fb950'}]
                      }
                      display={r.greeks.edgeRatio?.toFixed(2)}
                      sublabel={r.greeks.edgeAction} />
                    <div className="text-[11px] text-[#8b949e] mt-1">Time threshold: {r.greeks.edgeThreshold?.toFixed(1)} | {r.greeks.thetaPaid ? 'Paying decay: higher = better' : r.greeks.isCreditStrat ? 'Credit: lower = better' : r.greeks.isBflyCondor ? 'Butterfly: transitions through phases' : 'Debit: higher = better'}</div>
                  </div>
                )}
              </div>
            </div>
          )}

          </div>
          <div className="empty:hidden" style={tabShow('greeks')}>
          {/* 45DTE Directional Edge */}
          {!is0 && r.greeks && r.greeks.edgeRatio !== undefined && (
            <div className="card">
              <SectionLabel white info="Directional Edge for 45DTE trades. Compares expected directional P&L (delta × remaining expected move) against total theta earned over the holding period to 21 DTE exit. Remaining EM = price × IV × √(remaining DTE / 365). Credit sellers (IC, spreads): want Edge Ratio < 0.5 (theta strongly dominates over the holding period). Debit directional (bull call, calendars): want Edge Ratio > 2.0 (move potential exceeds decay). Theta efficiency = daily theta as % of buying power reduction. Vega/Theta = IV sensitivity per unit of decay — high ratio means IV changes matter more than time. If theta is NEGATIVE the position pays decay over the hold, and the Edge Ratio wants to be high regardless of strategy class — only the move can cover the bill.">Directional Edge (45DTE)</SectionLabel>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-[#a8b2be]">Holding: {r.greeks.daysToExit} days to 21 DTE exit | Remaining EM: {r.greeks.remainingEM?.toFixed(1)} pts</span>
                <span className="text-[12px] px-2 py-0.5 rounded font-semibold" style={{
                  background: r.greeks.edgeSignal==='excellent'?'#0d2818':r.greeks.edgeSignal==='good'?'#0d1a0d':r.greeks.edgeSignal==='marginal'?'#1f1a0d':'#1f0d0d',
                  color: r.greeks.edgeSignal==='excellent'?'#3fb950':r.greeks.edgeSignal==='good'?'#7bc74d':r.greeks.edgeSignal==='marginal'?'#d29922':'#f85149'
                }}>{r.greeks.edgePhase}</span>
              </div>
              <div className="grid grid-cols-3 gap-2 mb-2">
                <div className="text-center p-2 rounded" style={{background:'#0d1117'}}>
                  <div className="text-[11px] text-[#a8b2be]">Directional $</div>
                  <div className="mono text-sm font-bold text-white">${r.greeks.directionalGain?.toFixed(0)}</div>
                </div>
                <div className="text-center p-2 rounded" style={{background:'#0d1117'}}>
                  <div className="text-[11px] text-[#a8b2be]">{r.greeks.thetaPaid ? 'Decay $ paid' : 'Theta $'} ({r.greeks.daysToExit}d)</div>
                  <div className="mono text-sm font-bold" style={{color: r.greeks.thetaPaid ? '#e3a008' : '#fff'}}>{r.greeks.thetaPaid ? '-' : ''}${r.greeks.thetaPressure?.toFixed(0)}</div>
                </div>
                <div className="text-center p-2 rounded" style={{background: r.greeks.edgeSignal==='excellent'?'#0d2818':'#0d1117'}}>
                  <div className="text-[11px] text-[#a8b2be]">Edge Ratio</div>
                  <div className="mono text-lg font-bold" style={{color: r.greeks.edgeSignal==='excellent'?'#3fb950':r.greeks.edgeSignal==='good'?'#7bc74d':r.greeks.edgeSignal==='marginal'?'#d29922':'#f85149'}}>{r.greeks.edgeRatio?.toFixed(2)}</div>
                </div>
              </div>
              <SpeedTape label="Move / Theta" value={Math.min(r.greeks.edgeRatio, 4)} min={0} max={4}
                zones={r.greeks.isCreditStrat && !r.greeks.thetaPaid
                  ? [{to:0.5,color:'#3fb950'},{to:0.8,color:'#e3b341'},{to:1.2,color:'#d29922'},{to:4,color:'#f85149'}]
                  : [{to:0.8,color:'#f85149'},{to:1.2,color:'#d29922'},{to:2.0,color:'#e3b341'},{to:4,color:'#3fb950'}]
                }
                display={r.greeks.edgeRatio?.toFixed(2)}
                sublabel={r.greeks.edgeAction} />
              <div className="grid grid-cols-2 gap-1.5 mt-3">
                <KV label="Theta efficiency" value={r.greeks.tEff ? (r.greeks.tEff * 100).toFixed(2) + '%' : '--'} />
                <KV label="Vega/Theta" value={r.greeks.tvRatio?.toFixed(2) || '--'} />
              </div>
            </div>
          )}

          </div>
          <div className="empty:hidden" style={tabShow('regime')}>
          {/* Regime */}
          <div className="card">
            <SectionLabel white info="Current market regime based on realised move as % of expected move (RM ratio) and ATR compression. Determines which strategies are favoured. Butterfly zone = >60% consumed + compressing. Each regime has different strategy ratings.">Regime</SectionLabel>
            <div className="text-sm font-semibold text-white">{is0 ? r.regime : `${r.regime} — ${r.outlook||''}`}</div>
            <div className="text-xs text-[#c9d1d9] mt-1.5 leading-relaxed">{is0 ? `${r.regimeConds||''} — ${r.regimeCommentary||''}` : r.regimeCommentary||''}</div>
          </div>

          </div>
          <div className="empty:hidden" style={tabShow('value')}>
          {/* Fair Value Score */}
          {is0 && r.fairValueScore !== undefined && (
            <div className="card">
              <div className="flex items-center justify-between mb-2">
                <SectionLabel white info="Strategy-specific score: is this trade cheap, fair, or expensive? Volatility Score = IV/HV ratio (credit sellers want rich, debit buyers want cheap). Structure Score = credit/debit ratio and greeks quality. Regime Score = do conditions suit this strategy? Weights vary by strategy type.">Fair Value Score</SectionLabel>
                <div className="flex items-center gap-2">
                  <span className="mono text-lg font-bold" style={{color: r.fairValueScore>=90?'#3fb950':r.fairValueScore>=80?'#7bc74d':r.fairValueScore>=70?'#d29922':'#f85149'}}>{r.fairValueScore}/100</span>
                  <span className="text-xs px-2 py-0.5 rounded font-semibold" style={{
                    background: r.fairValueScore>=90?'#0d1f0d':r.fairValueScore>=80?'#0d1a0d':r.fairValueScore>=70?'#1f1a0d':'#1f0d0d',
                    color: r.fairValueScore>=90?'#3fb950':r.fairValueScore>=80?'#7bc74d':r.fairValueScore>=70?'#d29922':'#f85149'
                  }}>{r.fairValueGrade}</span>
                </div>
              </div>
              <div className="space-y-3">
                <SpeedTape label="Volatility (IV/HV)" value={r.volScore} min={0} max={100}
                  zones={[{to:30,color:'#f85149'},{to:60,color:'#d29922'},{to:80,color:'#e3b341'},{to:100,color:'#3fb950'}]}
                  display={`${r.volScore}/100 — ${r.volGrade}`}
                  sublabel={r.ivHvRatio?`IV/HV ${r.ivHvRatio.toFixed(2)}`:''} />
                <SpeedTape label="Structure (credit/debit ratio)" value={r.structScore} min={0} max={100}
                  zones={[{to:30,color:'#f85149'},{to:60,color:'#d29922'},{to:80,color:'#e3b341'},{to:100,color:'#3fb950'}]}
                  display={`${r.structScore}/100 — ${r.structGrade}`}
                  sublabel={r.greeks?'Includes theta/gamma':'Enter credit/debit + Greeks for full score'} />
                <SpeedTape label="Regime (conditions)" value={r.regimeScore} min={0} max={100}
                  zones={[{to:30,color:'#f85149'},{to:60,color:'#d29922'},{to:80,color:'#e3b341'},{to:100,color:'#3fb950'}]}
                  display={`${r.regimeScore}/100 — ${r.regimeGrade}`}
                  sublabel={`Move ${(r.moveConsumed*100).toFixed(0)}% consumed, comp ${r.comp?.toFixed(2)||'--'}`} />
              </div>
              <div className="mt-3 pt-2 text-xs text-[#a8b2be]" style={{borderTop:'1px solid #21262d'}}>
                Weights ({r.legStrat||'--'}): Vol {((r.fvWeightVol||0.3)*100).toFixed(0)}% + Structure {((r.fvWeightStruct||0.3)*100).toFixed(0)}% + Regime {((r.fvWeightRegime||0.4)*100).toFixed(0)}%
              </div>
            </div>
          )}

          </div>
          <div className="empty:hidden" style={tabShow('regime')}>
          {/* Signals */}
          <div className="card">
            <SectionLabel white info="All derived market signals: direction and trend pattern, move consumed breakdown (directional vs range), overnight ES analysis, VWAP trend (rolling 30-min windows, sized in units of the 30-min expected move) confirmed or contradicted by VWAP acceptance, VIX gap grade, compression ratio, gamma distance. These feed into the setup quality scoring.">Signals</SectionLabel>
            <div className="grid grid-cols-2 gap-1.5">
              {is0 ? <>
                <KV label="Direction" value={r.dirLabel} cls={r.dirScore>0?'text-green':r.dirScore<0?'text-red':''}/>
                <KV label="Move consumed" value={r.moveConsumed!==undefined?`${(r.moveConsumed*100).toFixed(0)}% (dir ${(r.moveConsumedDir*100).toFixed(0)}% / range ${(r.moveConsumedRange*100).toFixed(0)}%)`:'--'} cls={r.moveConsumed>0.80?'text-amber':r.moveConsumed>0.60?'text-amber':''}/>
                <KV label="Vol remaining" value={r.volRemaining!==undefined?`${(r.volRemaining*100).toFixed(0)}%`:'--'} cls={r.volRemaining<0.30?'text-amber':''}/>
                <KV label="Trend pattern" value={r.trendPattern||'--'} cls={r.trendPattern==='continuation'?'text-green':r.trendPattern==='reversal'?'text-amber':''}/>
                <KV label="ES overnight" value={r.overnightDir!=='unknown'?`${r.overnightDir} (${r.overnightDirMove>0?'+':''}${r.overnightDirMove?.toFixed(1)||0} pts)`:'--'} cls={r.overnightDir==='bullish'?'text-green':r.overnightDir==='bearish'?'text-red':''}/>
                <KV label="Cash move" value={r.cashDirMove!==undefined?`${r.cashDirMove>0?'+':''}${r.cashDirMove?.toFixed(1)||0} pts (${r.cashDir})`:'--'} cls={r.cashDir==='bullish'?'text-green':r.cashDir==='bearish'?'text-red':''}/>
                <KV label="Overnight range" value={r.overnightRangePct>0?`${(r.overnightRangePct*100).toFixed(0)}% EM`:'--'}/>
                <KV label="VWAP trend (30m windows)" value={`${r.slope5?.strength||'--'} (${r.slope5?.direction||'--'})${r.slope5?.shiftEM?` · ${r.slope5.shiftEM>0?'+':''}${r.slope5.shiftEM.toFixed(2)} EM30`:''}`} cls={r.slope5?.direction==='rising'?'text-green':r.slope5?.direction==='falling'?'text-red':''}/>
                <KV label="VWAP acceptance" value={r.vwapAccept==null?'--':`${(r.vwapAccept*100).toFixed(0)}% above · ${r.acceptLabel}`} cls={r.vwapAccept==null?'':r.vwapAccept>=0.65?'text-green':r.vwapAccept<=0.35?'text-red':''}/>
                <KV label="Trend confirmed" value={r.confirmed?'Yes ✓':r.diverges?'Diverges ✗':'—'} cls={r.confirmed?'text-green':r.diverges?'text-amber':''}/>
                <KV label="VIX1D/VIX gap" value={`${(r.vixGap*100).toFixed(1)}%`}/>
                <KV label="VIX grade" value={r.vixGrade}/>
                <KV label="RM ratio" value={r.rmRatio?`${(r.rmRatio*100).toFixed(0)}% EM`:'--'}/>
                <KV label="Compression" value={r.comp!==null?r.comp.toFixed(2):'--'}/>
                <KV label="VWAP distance" value={r.vwapDistPctEM>0?`${(r.vwapDistPctEM*100).toFixed(0)}% EM`:'--'} cls={r.vwapOverextended?'text-amber':''}/>
                <KV label="Gamma dist" value={r.gamDist!==null?`${r.gamDist.toFixed(2)}x ATR`:'--'}/>
                <KV label={`EM active${r.emIsStraddle?' (straddle)':i0.emSource==='manual'?' (manual)':' (VIX1D)'}`} value={`${fv(i0,'em').toFixed(1)} pts`}/>
                <KV label="EM(VIX) ref" value={`${r.emVIX} pts`}/>
                <KV label="EM(VIX1D) ref" value={`${r.emV1D} pts`}/>
              </> : <>
                <KV label="IVR" value={`${fv(i45,'ivr').toFixed(0)}% — ${r.ivrBand}`}/>
                <KV label="IV/HV" value={r.ivhvRatio?`${r.ivhvRatio.toFixed(2)} — ${r.ivhvLabel}`:'--'}/>
                <KV label="EM45" value={r.em45?`${r.em45.toFixed(1)} pts`:'--'}/>
                <KV label="Term" value={r.termLabel}/>
              </>}
            </div>
          </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Verdict band helpers (Oct 2026) ──
const EX_LBL = { fontSize: 12, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#8b949e' };
const EX_LINK = { padding: 0, border: 'none', background: 'transparent', color: '#a8b2be', fontSize: 13,
  textDecoration: 'underline', cursor: 'pointer' };
const EX_GHOST = { padding: '6px 12px', borderRadius: 8, border: '1px solid #30363d', background: 'transparent',
  color: '#c9d1d9', fontSize: 13, cursor: 'pointer' };

// Near (sold) and far (bought) expiries for a calendar or diagonal. Five choices
// each, around the current pick; the far row only offers dates after the near.
// 45DTE single-expiry structures: which listed expiry the ticket trades. (Oct 2026.)
// Contracts on the ticket (Oct 2026). Kelly picks the size; you can type your own,
// and Kelly's stays beside it with a reset. Logging, commission and max risk all
// follow what is in the box.
function SizeInput({ value, kellyC, mine, noEdge, kellyDollar, overRisk, riskEach, onSet }) {
  const [txt, setTxt] = useState(String(value));
  useEffect(() => { setTxt(String(value)); }, [value]);
  const commit = v => { const n = Math.floor(parseFloat(v)); if (n > 0) onSet(n === kellyC && !mine ? null : n); else setTxt(String(value)); };
  const step = d => onSet(Math.max(1, value + d));
  const btn = { width:28,height:32,borderRadius:7,border:'1px solid #30363d',background:'transparent',color:'#c9d1d9',fontSize:16,cursor:'pointer' };
  const over = mine && value > kellyC;
  return (
    <>
      <div style={{display:'flex',alignItems:'center',gap:6}}>
        <button type="button" aria-label="One fewer contract" style={btn} onClick={() => step(-1)}>−</button>
        <input data-testid="size-input" type="number" min="1" step="1" aria-label="Contracts" value={txt}
          onChange={e => setTxt(e.target.value)} onBlur={e => commit(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') commit(e.target.value); }}
          className="mono" style={{width:64,padding:'5px 8px',borderRadius:8,border:`1px solid ${mine ? '#d29922' : '#30363d'}`,background:'#0d1117',
            color: over || overRisk ? '#f85149' : '#e6edf3',fontSize:20,fontWeight:700,outline:'none',textAlign:'center'}} />
        <button type="button" aria-label="One more contract" style={btn} onClick={() => step(1)}>+</button>
        <span className="mono" style={{fontSize:13,color:'#8b949e'}}>ct</span>
      </div>
      <span data-testid="size-kelly" style={{fontSize:12.5,color: noEdge ? '#e3833c' : '#a8b2be'}}>
        {noEdge ? `Kelly says no edge at this price (${kellyC} ct is a floor)` : `Kelly ${kellyC} ct · $${Math.round(kellyDollar || 0)}`}
        {overRisk ? ' · over risk cap' : ''}
        {mine && <> · <button type="button" data-testid="size-reset" onClick={() => onSet(null)}
          style={{padding:0,border:'none',background:'transparent',color:'#58a6ff',fontSize:12.5,textDecoration:'underline',cursor:'pointer'}}>use Kelly</button></>}
      </span>
      {over && riskEach > 0 && <span style={{fontSize:12.5,color:'#f85149'}}>
        {value} ct risks ${Math.round(value * riskEach)} — above Kelly's ${Math.round(kellyC * riskEach)}
      </span>}
    </>
  );
}

// "Strikes listed: puts every $1, calls every $5 near the shorts" — the spacing the
// chain actually has where the ticket's shorts sit, for the picked expiry.
function listedStrikeNote(lc, exp, legs, fit) {
  if (!lc || lc.exp !== exp) return null;
  if (lc.loading) return 'Loading listed strikes…';
  if (lc.err) return `Listed strikes unavailable: ${lc.err}.`;
  const gapNear = (list, k) => {
    if (!Array.isArray(list) || list.length < 2 || !(k > 0)) return null;
    const i = list.reduce((b, x, j) => (Math.abs(x - k) < Math.abs(list[b] - k) ? j : b), 0);
    const g = [list[i + 1] - list[i], list[i] - list[i - 1]].filter(x => x > 0);
    return g.length ? Math.max(...g) : null;
  };
  const shortOf = r => (legs || []).find(l => /short/i.test(l.label) && new RegExp(r === 'P' ? 'put' : 'call', 'i').test(l.label));
  const parts = [];
  [['P', 'puts'], ['C', 'calls']].forEach(([r, name]) => {
    const sl = shortOf(r); const g = sl ? gapNear(lc[r], sl.strike) : null;
    if (g) parts.push(`${name} every $${+g.toFixed(2)}`);
  });
  const count = r => { const l = lc[r] || []; return l.length ? `${l.length} ${r === 'P' ? 'puts' : 'calls'} ${l[0]}–${l[l.length - 1]}` : `0 ${r === 'P' ? 'puts' : 'calls'}`; };
  if (fit && fit.skipped) return `Listed strikes not used: ${fit.skipped} (TWS sent ${count('P')}, ${count('C')}). Standard grid shown — check strikes in TWS.`;
  if (!parts.length) return `Listed strikes: ${count('P')}, ${count('C')}.`;
  return `Strikes listed here: ${parts.join(', ')}`
    + (fit && fit.moves ? ` — engine strikes fitted${fit.equalWings ? `, wings ${fit.equalWings} wide both sides` : ''}.` : '.');
}

function SingleExpiryPicker({ today, list, sel, onPick, source, strikeNote }) {
  const items = nearChoices(list, today, sel);
  return (
    <div data-testid="expiry-single" style={{marginTop:10,display:'flex',alignItems:'center',gap:6,flexWrap:'wrap',padding:'8px 12px',
      borderRadius:10,background:'rgba(255,255,255,0.03)',border:'1px solid #21262d'}}>
      <span style={{width:118,fontSize:12.5,color:'#a8b2be'}}>Expiry <span style={{color:'#8b949e'}}>all legs</span></span>
      {items.map(e => {
        const on = e === sel;
        return (
          <button key={e} type="button" onClick={() => onPick(e)} aria-pressed={on}
            style={{padding:'5px 10px',borderRadius:7,fontSize:13,cursor:'pointer',minHeight:32,
              border:`1px solid ${on ? '#58a6ff' : '#30363d'}`,background:on ? '#58a6ff22' : 'transparent',color:on ? '#fff' : '#c9d1d9'}}>
            <span style={{fontWeight:on ? 700 : 500}}>{fmtExpiry(e)}</span>
            <span className="mono" style={{fontSize:11.5,color:'#8b949e',marginLeft:6}}>{dteBetween(today, e)}d</span>
          </button>
        );
      })}
      <span style={{fontSize:12,color:'#8b949e',flexBasis:'100%'}}>
        {source === 'chain' ? 'Listed expiries from TWS.' : source === 'loading' ? 'Loading listed expiries from TWS…'
          : 'Weekly Fridays (holidays not checked) — TWS expiry list unavailable' + (source.startsWith('fallback:') ? `: ${source.slice(9)}.` : '.')}
      </span>
      {strikeNote && <span data-testid="listed-strike-note" style={{fontSize:12,color:'#8b949e',flexBasis:'100%'}}>{strikeNote}</span>}
    </div>
  );
}

function ExpiryPicker({ today, list, near, far, onNear, onFar, source, isDiagonal }) {
  const nears = nearChoices(list, today, near);
  const fars = farChoices(list, near, far);
  const row = (label, sub, items, sel, onPick, clr, testid) => (
    <div style={{display:'flex',alignItems:'center',gap:6,flexWrap:'wrap'}} data-testid={testid}>
      <span style={{width:118,fontSize:12.5,color:'#a8b2be'}}>{label} <span style={{color:'#8b949e'}}>{sub}</span></span>
      {items.map(e => {
        const on = e === sel;
        return (
          <button key={e} type="button" onClick={() => onPick(e)} aria-pressed={on}
            style={{padding:'5px 10px',borderRadius:7,fontSize:13,cursor:'pointer',minHeight:32,
              border:`1px solid ${on ? clr : '#30363d'}`,background:on ? clr + '22' : 'transparent',color:on ? '#fff' : '#c9d1d9'}}>
            <span style={{fontWeight:on ? 700 : 500}}>{fmtExpiry(e)}</span>
            <span className="mono" style={{fontSize:11.5,color:'#8b949e',marginLeft:6}}>{dteBetween(today, e)}d</span>
          </button>
        );
      })}
    </div>
  );
  const gap = near && far ? dteBetween(near, far) : null;
  return (
    <div data-testid="expiry-picker" style={{marginTop:10,display:'flex',flexDirection:'column',gap:6,padding:'10px 12px',
      borderRadius:10,background:'rgba(255,255,255,0.03)',border:'1px solid #21262d'}}>
      {row('Sell', 'near expiry', nears, near, onNear, '#f85149', 'expiry-near')}
      {row('Buy', 'far expiry', fars, far, onFar, '#58a6ff', 'expiry-far')}
      <div style={{fontSize:12,color:'#8b949e'}}>
        {gap != null ? `${gap} days between the legs · ` : ''}
        {isDiagonal ? 'Diagonal: the far leg is usually 5–8 weeks past the near. ' : 'Calendar: the far leg is usually 3–5 weeks past the near. '}
        {source === 'chain' ? 'Listed expiries from TWS.'
          : source === 'loading' ? 'Loading listed expiries from TWS…'
          : 'Showing weekly Fridays (holidays not checked). TWS expiry list unavailable'
            + (source.startsWith('fallback:') ? `: ${source.slice(9)}.` : '.')}
      </div>
    </div>
  );
}

// Evidence-line chip states: what each input's source is.
const INPUT_CHIP = {
  missing: { fg: '#f85149', bg: '#2d0f11', border: '#6e2427', tip: 'Required and blank — the engine waits on this' },
  target: { fg: '#e3b341', bg: '#2a2410', border: '#5a4a12', tip: 'Pre-filled from the engine\u2019s target. Replace it with your broker fill — this number is logged.' },
  typed: { fg: '#c9d1d9', bg: '#161b22', border: '#30363d', tip: 'You entered this from the broker preview' },
  override: { fg: '#d29922', bg: '#1f1a0d', border: '#5a3a1a', tip: 'You typed over the feed; auto-fill leaves it alone' },
  nofeed: { fg: '#d29922', bg: 'transparent', border: '#5a3a1a', tip: 'The last Bridge pull did not return this — it is an older value' },
};

// The one headline score: composite as a ring, coloured by the verdict.
function EdgeRing({ score, color, label, dim, title }) {
  const R = 34, C = 2 * Math.PI * R;
  const s = Math.max(0, Math.min(100, Math.round(score || 0)));
  return (
    <div title={title} data-testid="edge-ring" style={{ position: 'relative', width: 80, height: 80, flex: 'none', opacity: dim ? 0.45 : 1 }}>
      <svg viewBox="0 0 80 80" width="80" height="80" aria-hidden="true">
        <circle cx="40" cy="40" r={R} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="8" />
        {!dim && <circle cx="40" cy="40" r={R} fill="none" stroke={color} strokeWidth="8" strokeLinecap="round"
          strokeDasharray={`${(C * s / 100).toFixed(1)} ${C.toFixed(1)}`} transform="rotate(-90 40 40)" />}
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <span className="mono" style={{ fontSize: 22, fontWeight: 700, lineHeight: 1, color: dim ? '#8b949e' : color }}>{dim ? '--' : s}</span>
        <span style={{ fontSize: 9.5, color: '#a8b2be', letterSpacing: '0.08em', marginTop: 2 }}>{label}</span>
      </div>
    </div>
  );
}

// Compact labelled number for the Needs-you queue, with an optional one-click
// suggestion (e.g. the payoff's own max profit / max loss).
function NeedNum({ label, value, onChange, suggest }) {
  const cur = parseFloat(value);
  const showSuggest = suggest != null && isFinite(suggest) && !(isFinite(cur) && Math.abs(cur - suggest) < 0.5);
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, color: '#8b949e' }}>
      {label}
      <input type="number" step="any" value={value ?? ''} onChange={e => onChange(e.target.value)} placeholder="—"
        className="mono"
        style={{ width: 96, padding: '8px 10px', borderRadius: 8, border: '1px solid #9e6a03', background: '#0d1117',
          color: '#e6edf3', fontSize: 14, outline: 'none' }} />
      {showSuggest && (
        <button type="button" onClick={() => onChange(String(suggest))}
          title="Computed from the payoff at expiry"
          style={{ padding: '1px 6px', borderRadius: 4, border: '1px solid #1f6feb55', background: '#0d1a2e',
            color: '#58a6ff', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', alignSelf: 'flex-start' }}>
          ← {suggest} from payoff
        </button>
      )}
    </label>
  );
}

// Time spreads (Oct 2026): the model prices price movement only — at the front
// leg's IV, every IV held — so a calendar or diagonal usually looks expensive to it.
// What you pay above its break-even is the price of the vol view (back-month IV
// holding up or rising, front-month IV crushing). Always on for these trades so the
// EV, POP and Kelly beside it are read for what they are.
function VolViewFlag({ be }) {
  const gap = be && be.gap != null && be.net != null ? -be.gap : null;   // + = paying over break-even
  return (
    <span data-testid="vol-view-flag" style={{ display: 'block', marginTop: 4, padding: '6px 8px', borderRadius: 6,
      background: '#1f1a0d', border: '1px solid #9e6a03', color: '#e3b341', fontSize: 12, lineHeight: 1.45 }}>
      <b>Vol view not priced.</b>{' '}
      {gap != null && gap > 0
        ? <>You're paying <b className="mono">{gap.toFixed(2)}</b> over the movement-only break-even — that is the price of your IV view.</>
        : gap != null ? <>Your fill is inside the movement-only break-even; any IV view is extra.</>
        : <>The model prices price movement only.</>}
      {' '}EV, POP and Kelly here assume IVs stay put; back-month IV rising (or front-month IV crushing) is not in them.
    </span>
  );
}

// One line: the fill at which EV = 0, how the current fill compares, and a button
// that puts it in the net field. (Oct 2026.)
function BreakevenLine({ v, onUse }) {
  const col = v.tone === 'good' ? '#3fb950' : v.tone === 'bad' ? '#f85149' : '#8b949e';
  return (
    <span data-testid="breakeven-fill" title={v.basis ? 'Break-even fill from the ' + v.basis : undefined}
      style={{ fontSize: 12.5, color: col, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 2 }}>
      <span className="mono">{v.text}</span>
      {v.gapText && <span style={{ color: '#a8b2be' }}>· {v.gapText}</span>}
      {v.infoText && <span data-testid="breakeven-target-info" style={{ flexBasis: '100%', color: '#8b949e', fontSize: 12 }}>ⓘ {v.infoText}</span>}
      {onUse && (
        <button type="button" onClick={onUse}
          style={{ padding: '1px 7px', borderRadius: 4, border: '1px solid #1f6feb55', background: '#0d1a2e', color: '#58a6ff',
            fontSize: 11.5, fontWeight: 600, cursor: 'pointer' }}>use</button>
      )}
    </span>
  );
}

// Net per share, credit > 0, from what was typed: a strategy that is always a debit
// (or always a credit) takes that sign whatever was typed; 'varies' keeps the sign.
function signedNet(typed, cashType) {
  const n = parseFloat(typed);
  if (!isFinite(n) || n === 0) return NaN;
  return cashType === 'debit' ? -Math.abs(n) : cashType === 'credit' ? Math.abs(n) : n;
}

// ── Trade choice cards (Oct 2026) ──
// Expiry payoff from engine legs, mirroring calc0dte's generic payoff: intrinsic
// per leg × side × qty, plus the per-share net (credit > 0). With no net the
// SHAPE is still right but the zero line is not, so it is flagged shapeOnly.
function legsPayoff(legs, ncd) {
  if (!Array.isArray(legs) || legs.length < 2) return null;
  const use = (legs.length === 4 && legs[0]?.label?.includes('VIX')) ? legs.slice(0, 2) : legs;
  const parsed = use.filter(l => isFinite(l.strike)).map(l => {
    const lb = String(l.label || '').toLowerCase();
    return { strike: l.strike, call: lb.includes('call'), sign: (lb.includes('short') || lb.includes('sell')) ? -1 : 1,
      qty: lb.includes('x2') ? 2 : 1 };
  });
  if (parsed.length < 2) return null;
  const ks = parsed.map(p => p.strike);
  const lo = Math.min(...ks), hi = Math.max(...ks), span = (hi - lo) || 10;
  const a = lo - span, b = hi + span, n = 160, net = ncd == null ? 0 : ncd;
  const points = [];
  for (let i = 0; i <= n; i++) {
    const px = a + (b - a) * i / n;
    let v = 0;
    parsed.forEach(p => { v += p.sign * p.qty * (p.call ? Math.max(0, px - p.strike) : Math.max(0, p.strike - px)); });
    points.push({ price: px, pnl: (v + net) * 100 });
  }
  const pnls = points.map(p => p.pnl);
  const breakevens = [];
  if (ncd != null) for (let i = 1; i < points.length; i++) {
    const p0 = points[i - 1], p1 = points[i];
    if ((p0.pnl < 0 && p1.pnl >= 0) || (p0.pnl >= 0 && p1.pnl < 0)) {
      const t = p0.pnl / (p0.pnl - p1.pnl);
      breakevens.push(+(p0.price + t * (p1.price - p0.price)).toFixed(1));
    }
  }
  return { points, breakevens, maxProfit: Math.max(...pnls), maxLoss: Math.min(...pnls), shapeOnly: ncd == null };
}

// Where a structure makes money, in words, from its breakevens.
function profitIfText(pay, underlying) {
  if (!pay || pay.shapeOnly || !Array.isArray(pay.points)) return '';
  const bes = (pay.breakevens || []).filter(Number.isFinite).slice().sort((x, y) => x - y);
  const at = px => {
    let best = pay.points[0];
    pay.points.forEach(p => { if (Math.abs(p.price - px) < Math.abs(best.price - px)) best = p; });
    return best.pnl;
  };
  const u = underlying || 'Price';
  const f = v => Math.round(v);
  if (bes.length === 2) return at((bes[0] + bes[1]) / 2) > 0
    ? `${u} stays ${f(bes[0])}–${f(bes[1])}` : `${u} breaks out of ${f(bes[0])}–${f(bes[1])}`;
  if (bes.length === 1) return at(bes[0] + 1) > 0 ? `${u} holds above ${f(bes[0])}` : `${u} holds below ${f(bes[0])}`;
  return '';
}

// Daily trend under the Outlook select: what it says, why, and whether the
// outlook is following it or you have set your own.
function TrendReadout({ trend, held, outlook, vixTermRatio, source, onUseTrend, oldBridge }) {
  if (!trend) return (
    <div data-testid="trend-readout" style={{ marginTop: 8, fontSize: 12.5, color: oldBridge ? '#d29922' : '#8b949e' }}>
      {oldBridge
        ? 'Daily trend: your Bridge predates the 6 Oct update and sends no daily bars — git pull in the bridge folder and restart it. Until then the outlook is yours to set.'
        : 'Daily trend: fetch the vol surface to read it — until then the outlook is yours to set.'}
    </div>
  );
  const col = trend.outlook === 'bullish' ? '#3fb950' : trend.outlook === 'bearish' ? '#f85149' : '#c9d1d9';
  const chip = (label, val, tone, tip) => (
    <span title={tip} style={{ display: 'inline-flex', gap: 4, padding: '2px 7px', borderRadius: 5, background: '#161b22',
      border: '1px solid #30363d', color: tone || '#c9d1d9', fontSize: 12 }}>
      <span style={{ color: '#8b949e' }}>{label}</span><span className="mono">{val}</span>
    </span>
  );
  const sgn = x => (x > 0 ? '+' : '') + x;
  return (
    <div data-testid="trend-readout" data-outlook={trend.outlook} style={{ marginTop: 10, padding: '8px 10px', borderRadius: 8, background: '#0d1117', border: '1px solid #21262d' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12.5 }}>
        <span style={{ color: '#8b949e' }}>Daily trend{source ? ` (${source})` : ''}</span>
        <b style={{ color: col }}>{trendLabel(trend)}</b>
        {held && outlook !== trend.outlook
          ? <button data-testid="use-trend" onClick={onUseTrend} style={{ marginLeft: 'auto', fontSize: 12, padding: '2px 8px', borderRadius: 5,
              border: '1px solid #1f6feb', color: '#58a6ff', background: 'transparent', cursor: 'pointer' }}>
              You set {outlook} · use trend ({trend.outlook})</button>
          : <span style={{ marginLeft: 'auto', fontSize: 12, color: '#8b949e' }}>{held ? 'outlook set by you' : 'outlook follows the trend'}</span>}
      </div>
      <div style={{ fontSize: 12, color: '#a8b2be', marginTop: 4 }}>{trend.why}</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
        {trend.pctVs20 != null && chip('vs 20d', sgn(trend.pctVs20) + '%', null, 'Close against the 20-day simple moving average')}
        {trend.pctVs50 != null && chip('vs 50d', sgn(trend.pctVs50) + '%', null, 'Close against the 50-day simple moving average')}
        {trend.z20 != null && chip('stretch', sgn(trend.z20) + 'σ', trend.stretch !== 'normal' ? '#d29922' : null,
          'Distance from the 20-day mean in standard deviations of the last 20 closes. Beyond ±2 is stretched.')}
        {trend.accept10 != null && chip('above 20d', Math.round(trend.accept10 * 10) + '/10', null, 'How many of the last 10 closes were above the 20-day average')}
        {trend.hvRatio != null && chip('HV10/60', trend.hvRatio.toFixed(2), trend.hvRegime !== 'steady' ? '#d29922' : null,
          'Realised vol, last 10 days over last 60. Below 0.7 coiled, above 1.3 expanding.')}
        {vixTermRatio != null && chip('VIX/VIX3M', (+vixTermRatio).toFixed(2), vixTermRatio >= 1 ? '#f85149' : null,
          'Above 1 is index backwardation — wider swings ahead: a sizing signal, not a direction call.')}
      </div>
    </div>
  );
}

function outlookOf(name) {
  const n = String(name || '');
  if (/calendar|diagonal/i.test(n)) return 'Time spread';
  if (/bull/i.test(n)) return 'Bullish';
  if (/bear/i.test(n)) return 'Bearish';
  if (/reversed|straddle|strangle/i.test(n)) return 'Breakout';
  if (/broken wing|asymmetric/i.test(n)) return 'Leaning';
  return 'Neutral';
}

// Payoff shape for a card: scaled to its own range, zero line when priced,
// a dashed marker where price is now.
// Strikes of a structure for labelling: low to high, short/long, ×2 bodies.
function strikeMarks(legs) {
  if (!Array.isArray(legs) || !legs.length) return [];
  const use = (legs.length === 4 && String(legs[0]?.label || '').includes('VIX')) ? legs.slice(0, 2) : legs;
  // Legs sharing a strike (an iron fly's two shorts) become one mark.
  const by = new Map();
  use.filter(l => isFinite(l.strike)).forEach(l => {
    const lb = String(l.label || '').toLowerCase();
    const m = by.get(l.strike) || { strike: l.strike, short: false, n: 0 };
    m.short = m.short || lb.includes('short') || lb.includes('sell');
    // A calendar's two legs share a strike but not an expiry — one mark, not "2×".
    m.n += legRole(lb) ? 0.5 : /x2\b/.test(lb) ? 2 : 1;
    by.set(l.strike, m);
  });
  return [...by.values()].map(m => ({ strike: m.strike, short: m.short, x2: m.n > 1 })).sort((a, b) => a.strike - b.strike);
}

// Payoff shape for a card: scaled to its own range, zero line when priced, a
// dashed marker where price is now, and the strikes labelled underneath so the
// card says WHERE the structure sits, not just its shape. (Oct 2026.)
function PayoffGlyph({ pay, price, color, strikes }) {
  if (!pay || !Array.isArray(pay.points) || pay.points.length < 2) {
    return <div style={{ height: 56, display: 'flex', alignItems: 'center', fontSize: 12.5, color: '#8b949e' }}>No single-expiry payoff to draw</div>;
  }
  const pts = pay.points, W = 160, H = 48, pad = 3;
  const xs = pts.map(p => p.price), ys = pts.map(p => p.pnl);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const lo = Math.min(...ys, pay.shapeOnly ? Infinity : 0), hi = Math.max(...ys, pay.shapeOnly ? -Infinity : 0);
  const X = v => ((v - x0) / ((x1 - x0) || 1)) * W;
  const Y = v => pad + (H - 2 * pad) * (1 - (v - lo) / ((hi - lo) || 1));
  const line = pts.map(p => `${X(p.price).toFixed(1)},${Y(p.pnl).toFixed(1)}`).join(' ');
  const showPx = isFinite(price) && price >= x0 && price <= x1;
  // label rows: a second row only when two strikes would collide
  const marks = [];
  let lastPct = -100, row = 0;
  (strikes || []).forEach(m => {
    if (!(m.strike >= x0 && m.strike <= x1)) return;
    const pct = (m.strike - x0) / ((x1 - x0) || 1) * 100;
    row = pct - lastPct < 11 ? 1 - row : 0;
    lastPct = pct;
    marks.push({ ...m, pct, row });
  });
  const twoRows = marks.some(m => m.row);
  const fmtK = k => (Math.round(k * 100) / 100).toString();
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="56" preserveAspectRatio="none" aria-hidden="true">
        {!pay.shapeOnly && <line x1="0" y1={Y(0)} x2={W} y2={Y(0)} stroke="#30363d" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />}
        {marks.map((m, i) => (
          <line key={i} x1={X(m.strike)} y1={H - 1} x2={X(m.strike)} y2={H - 7} stroke={m.short ? '#e6edf3' : '#6e7681'} strokeWidth="1" vectorEffect="non-scaling-stroke" />
        ))}
        <polyline points={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {showPx && <line x1={X(price)} y1="1" x2={X(price)} y2={H - 1} stroke="#ffffff" strokeOpacity="0.55" strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />}
      </svg>
      {marks.length > 0 && (
        <div data-testid="glyph-strikes" style={{ position: 'relative', height: twoRows ? 30 : 16, marginTop: 2 }}>
          {marks.map((m, i) => (
            <span key={i} className="mono" style={{ position: 'absolute', top: m.row ? 14 : 0, left: `${m.pct}%`,
              transform: `translateX(${m.pct < 6 ? '0' : m.pct > 94 ? '-100%' : '-50%'})`, whiteSpace: 'nowrap',
              fontSize: 11, lineHeight: '14px', fontWeight: m.short ? 700 : 400, color: m.short ? '#e6edf3' : '#8b949e' }}>
              {m.x2 ? '2×' : ''}{fmtK(m.strike)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function CardBar({ label, value, pct, color, title }) {
  return (
    <div title={title} style={{ display: 'grid', gridTemplateColumns: '112px 1fr 88px', alignItems: 'center', gap: 10, fontSize: 12.5 }}>
      <span style={{ color: '#a8b2be' }}>{label}</span>
      <span style={{ height: 6, borderRadius: 3, background: '#21262d', position: 'relative', overflow: 'hidden' }}>
        {pct != null && <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.max(3, Math.min(100, pct))}%`, background: color, borderRadius: 3 }} />}
      </span>
      <span className="mono" style={{ textAlign: 'right', color, fontWeight: 600 }}>{value}</span>
    </div>
  );
}

function ChoiceCard({ c, price, underlying, rrMax, onSwitch, onNewTab }) {
  const on = c.isCur;
  const accent = on ? (c.override ? '#d29922' : '#3fb950') : '#8b949e';
  const ratingClr = { EXCELLENT: '#3fb950', GOOD: '#58a6ff', MARGINAL: '#d29922', POOR: '#f85149' }[c.rating] || '#8b949e';
  const cashClr = c.cash === 'credit' ? '#3fb950' : c.cash === 'debit' ? '#e3a008' : '#9aa4b0';
  const cashBg = c.cash === 'credit' ? '#0d2818' : c.cash === 'debit' ? '#2d1a0d' : '#1c2128';
  const pmlClr = c.pml == null ? '#8b949e' : c.pml <= 0.15 ? '#3fb950' : c.pml <= 0.30 ? '#d29922' : '#f85149';
  const tag = on ? (c.override ? 'YOUR PICK' : 'ENGINE PICK') : 'ALTERNATIVE';
  const netTxt = c.netShow == null ? null : `${c.netShow >= 0 ? 'cr' : 'dr'} ${Math.abs(c.netShow).toFixed(2)}`;
  return (
    <div data-testid="choice-card" data-current={on ? '1' : '0'}
      style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16, borderRadius: 12,
        background: on ? (c.override ? '#1a160c' : '#101d14') : '#161b22', border: `1px solid ${on ? accent : '#21262d'}` }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.07em', color: on ? accent : '#8b949e' }}>{tag}</span>
          <span style={{ fontSize: 16.5, fontWeight: 600, color: '#fff' }}>{c.name}</span>
          <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11.5, fontWeight: 700, padding: '2px 7px', borderRadius: 4, background: cashBg, color: cashClr, letterSpacing: '0.03em' }}>
              {c.cash === 'credit' ? 'CREDIT' : c.cash === 'debit' ? 'DEBIT' : 'CR / DR'}
            </span>
            <span style={{ fontSize: 11.5, padding: '2px 7px', borderRadius: 4, background: 'rgba(255,255,255,0.06)', color: '#a8b2be' }}>{c.outlook}</span>
          </span>
        </div>
        {on ? (
          <div style={{ textAlign: 'right', flex: 'none' }} title={c.edgeLabel === 'SETUP' ? 'Setup quality only until win, risk and POP are entered' : 'Composite edge score for this ticket'}>
            <div className="mono" style={{ fontSize: 22, fontWeight: 700, lineHeight: 1, color: c.edgeColor }}>{c.edge}</div>
            <div style={{ fontSize: 10, color: '#8b949e', letterSpacing: '0.07em', marginTop: 3 }}>{c.edgeLabel}</div>
          </div>
        ) : (
          <span style={{ flex: 'none', fontSize: 11.5, fontWeight: 700, padding: '3px 8px', borderRadius: 5, color: ratingClr,
            border: `1px solid ${ratingClr}55`, letterSpacing: '0.04em' }}>{c.rating}</span>
        )}
      </div>

      <PayoffGlyph pay={c.pay} price={price} color={on ? accent : '#8b949e'} strikes={c.strikes} />

      {c.profitIf && (
        <div style={{ fontSize: 13.5, color: '#c9d1d9', lineHeight: 1.4 }}>
          Profits if <b style={{ color: '#fff', fontWeight: 600 }}>{c.profitIf.replace(/^Price /, '').replace(/\.$/, '')}</b>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <CardBar label="Max-loss chance" value={c.pml == null ? 'no greeks' : `${(c.pml * 100).toFixed(1)}%`}
          pct={c.pml == null ? null : (c.pml / 0.4) * 100} color={pmlClr}
          title="Probability price finishes beyond a wing — model and delta cross-check blended" />
        <CardBar label="Reward : risk" value={c.rr == null ? '--' : `${c.rr.toFixed(2)}:1`}
          pct={c.rr == null || !rrMax ? null : (c.rr / rrMax) * 100} color="#58a6ff"
          title={c.priced === 'fair' ? 'Max profit over max loss at the model’s fair price for these strikes' : 'Max profit over max loss at this ticket’s net'} />
        {on && (
          <CardBar label="Expected value" value={c.ev == null ? 'needs sizing' : `$${Math.round(c.ev)}`}
            pct={null} color={c.ev == null ? '#d29922' : c.ev > 0 ? '#3fb950' : '#f85149'} />
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingTop: 10, borderTop: '1px solid #21262d', marginTop: 'auto' }}>
        <span className="mono" style={{ fontSize: 12.5, color: '#a8b2be' }}>
          {on ? <>{netTxt || 'no fill yet'}{c.contracts != null ? ` · ${c.contracts} ct` : ''}</>
            : netTxt ? `fair ≈ ${netTxt}` : 'price after switching'}
        </span>
        {on ? (
          <span style={{ padding: '7px 12px', borderRadius: 8, fontSize: 13, fontWeight: 600, color: accent,
            border: `1px solid ${accent}66`, background: 'rgba(255,255,255,0.03)' }}>Selected</span>
        ) : (
          <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {onNewTab && <button onClick={onNewTab} title="Open in its own tab — keeps this ticket as it is" style={EX_LINK}>New tab</button>}
            <button data-testid="choice-switch" onClick={onSwitch}
              title="Make this the ticket. Win, risk, POP and the fill are cleared — they belonged to the old legs."
              style={{ padding: '7px 12px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', minHeight: 34,
                border: '1px solid #30363d', background: 'transparent', color: '#e6edf3' }}>Switch to this</button>
          </span>
        )}
      </div>
    </div>
  );
}

// ── Price map (Oct 2026) ──
// One strip on a price axis answering "where can price go, and what happens to me
// there": payoff zones, strikes, breakevens, the remaining expected move, today's
// range and VWAP, and price itself. Every mark is placed with one scale.
function PriceMap({ pay, legs, price, em, emLabel, high, low, vwap, underlying }) {
  if (!pay || !Array.isArray(pay.points) || pay.points.length < 2 || !(price > 0)) return null;
  const use = (Array.isArray(legs) && legs.length === 4 && legs[0]?.label?.includes('VIX')) ? legs.slice(0, 2) : (legs || []);
  const strikes = use.filter(l => isFinite(l.strike)).map(l => ({
    strike: l.strike, short: /short|sell/i.test(l.label || ''), label: l.label || '' }));
  if (!strikes.length) return null;
  const ks = strikes.map(s => s.strike);
  const hasEM = em > 0;
  let lo = Math.min(...ks, price, hasEM ? price - em : price, low > 0 ? low : price);
  let hi = Math.max(...ks, price, hasEM ? price + em : price, high > 0 ? high : price);
  const padPts = (hi - lo) * 0.14 || 10;
  lo -= padPts; hi += padPts;
  const L = 30, R = 690, W = 720;
  const X = p => L + (p - lo) / (hi - lo) * (R - L);
  const inDom = p => p >= lo && p <= hi;

  // payoff at any price: linear interpolation between the computed points
  const pts = pay.points;
  const pnlAt = px => {
    if (px <= pts[0].price) return pts[0].pnl;
    if (px >= pts[pts.length - 1].price) return pts[pts.length - 1].pnl;
    let i = 1; while (i < pts.length && pts[i].price < px) i++;
    const a = pts[i - 1], b = pts[i];
    return a.pnl + (b.pnl - a.pnl) * ((px - a.price) / ((b.price - a.price) || 1));
  };
  const maxP = pay.maxProfit, maxL = pay.maxLoss;
  const COLS = 180, colW = (R - L) / COLS;
  const cells = [];
  for (let i = 0; i < COLS; i++) {
    const px = lo + (hi - lo) * (i + 0.5) / COLS;
    const v = pnlAt(px);
    let fill, op;
    if (pay.shapeOnly) { fill = '#6e7681'; op = 0.25 + 0.5 * ((v - maxL) / ((maxP - maxL) || 1)); }
    else if (v >= 0) { fill = '#2ea043'; op = 0.30 + 0.62 * (maxP > 0 ? v / maxP : 0); }
    else { fill = '#da3633'; op = 0.22 + 0.55 * (maxL < 0 ? v / maxL : 0); }
    cells.push(<rect key={i} x={(L + i * colW).toFixed(2)} y="26" width={(colW + 0.4).toFixed(2)} height="26" fill={fill} fillOpacity={Math.max(0, Math.min(1, op)).toFixed(2)} />);
  }
  const money = v => (v >= 0 ? '+' : '−') + '$' + Math.abs(Math.round(v)).toLocaleString('en-US');
  const bes = pay.shapeOnly ? [] : (pay.breakevens || []).filter(b => isFinite(b) && inDom(b));
  // profit label sits in the widest green run
  let profitMid = null;
  if (!pay.shapeOnly && maxP > 0) {
    let best = null, run = null;
    for (let i = 0; i < COLS; i++) {
      const pos = pnlAt(lo + (hi - lo) * (i + 0.5) / COLS) > 0;
      if (pos) { run = run ? { s: run.s, e: i } : { s: i, e: i }; if (!best || run.e - run.s > best.e - best.s) best = { ...run }; }
      else run = null;
    }
    if (best) profitMid = L + ((best.s + best.e + 1) / 2) * colW;
  }
  // Keep the max-profit label off the price line: slide it to whichever side of
  // price still sits inside the green run.
  let profitRunS = null, profitRunE = null;
  if (profitMid != null) {
    const labelW = (`Max profit ${money(maxP)}`.length) * 6.9;
    const pxNow = X(price);
    let s0 = profitMid, e0 = profitMid;
    while (s0 - colW > L && pnlAt(lo + (hi - lo) * ((s0 - colW - L) / (R - L))) > 0) s0 -= colW;
    while (e0 + colW < R && pnlAt(lo + (hi - lo) * ((e0 + colW - L) / (R - L))) > 0) e0 += colW;
    profitRunS = s0; profitRunE = e0;
    if (Math.abs(profitMid - pxNow) < labelW / 2 + 6) {
      const right = pxNow + labelW / 2 + 8, left = pxNow - labelW / 2 - 8;
      if (right + labelW / 2 <= e0 + colW) profitMid = right;
      else if (left - labelW / 2 >= s0 - colW) profitMid = left;
      else profitMid = (pxNow - s0 > e0 - pxNow) ? Math.max(L + labelW / 2, left) : Math.min(R - labelW / 2, right);
    }
  }
  const leftLoss = !pay.shapeOnly && pnlAt(lo) < 0 ? pnlAt(lo) : null;
  const rightLoss = !pay.shapeOnly && pnlAt(hi) < 0 ? pnlAt(hi) : null;

  // strike labels: stagger neighbours that would collide
  const sorted = strikes.slice().sort((a, b) => a.strike - b.strike);
  let lastX = -1e9, row = 0;
  const labels = sorted.map(s => {
    const x = X(s.strike);
    row = (x - lastX < 52) ? 1 - row : 0;
    lastX = x;
    return { ...s, x, y: row ? 22 : 12 };
  });

  // axis ticks on a round step
  const span = hi - lo;
  const step = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000].find(s => span / s <= 7) || 1000;
  const ticks = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) ticks.push(t);

  const pxX = X(price);
  const pillW = Math.max(46, String(Math.round(price)).length * 8 + 14);
  const T = { fontFamily: 'JetBrains Mono,monospace' };
  const S = { fontFamily: 'DM Sans,system-ui,sans-serif' };
  return (
    <svg data-testid="price-map" viewBox={`0 0 ${W} 170`} width="100%" role="img"
      aria-label={`${underlying || 'Price'} ${Math.round(price)}; strikes ${ks.join(', ')}${bes.length ? '; breakevens ' + bes.map(Math.round).join(' and ') : ''}${hasEM ? `; expected move ±${em.toFixed(0)}` : ''}`}>
      {cells}
      {profitMid != null && <text x={profitMid} y="43.5" fill="#e6ffed" fontSize="12" fontWeight="600" textAnchor="middle"
        stroke="#0b3d1a" strokeWidth="3" paintOrder="stroke" style={S}>Max profit {money(maxP)}</text>}
      {leftLoss != null && <text x={L + 6} y="43.5" fill="#ffc1bc" fontSize="11" style={T}>{money(leftLoss)}</text>}
      {rightLoss != null && <text x={R - 6} y="43.5" fill="#ffc1bc" fontSize="11" textAnchor="end" style={T}>{money(rightLoss)}</text>}
      {pay.shapeOnly && <text x={(L + R) / 2} y="43.5" fill="#c9d1d9" fontSize="11.5" textAnchor="middle" style={S}>Enter the net to price the zones</text>}

      {labels.map((s, i) => (
        <g key={i}>
          <line x1={s.x} y1="24" x2={s.x} y2="118" stroke={s.short ? '#e6edf3' : '#8b949e'} strokeWidth={s.short ? 1.5 : 1} strokeDasharray={s.short ? undefined : '3 3'} />
          <text x={s.x} y={s.y} fill={s.short ? '#e6edf3' : '#8b949e'} fontSize="11" fontWeight={s.short ? 700 : 400} textAnchor="middle" style={T}>
            {Math.round(s.strike * 100) / 100}{s.short ? ' S' : ' L'}
          </text>
        </g>
      ))}

      {bes.map((b, i) => (
        <text key={i} x={X(b)} y="66" fill="#a8b2be" fontSize="10.5" stroke="#0d1117" strokeWidth="3" paintOrder="stroke"
          textAnchor={i === 0 && bes.length > 1 ? 'end' : bes.length > 1 ? 'start' : 'middle'} style={T}>
          {bes.length > 1 ? (i === 0 ? `BE ${Math.round(b)} ` : ` BE ${Math.round(b)}`) : `BE ${Math.round(b)}`}
        </text>
      ))}

      {hasEM && (
        <g>
          <rect x={X(price - em)} y="74" width={X(price + em) - X(price - em)} height="18" rx="9" fill="#58a6ff" fillOpacity="0.16" stroke="#58a6ff" strokeOpacity="0.5" />
          <text x={X(price - em) + 10} y="87" fill="#9ecbff" fontSize="11" style={S}>{emLabel} ±{em.toFixed(0)}</text>
        </g>
      )}

      {high > 0 && low > 0 && high >= low && (
        <g>
          <rect x={X(low)} y="100" width={Math.max(2, X(high) - X(low))} height="8" rx="4" fill="#6e7681" />
          {vwap > 0 && inDom(vwap) && <line x1={X(vwap)} y1="96" x2={X(vwap)} y2="112" stroke="#d29922" strokeWidth="2" />}
          <text x={Math.min(R - 4, X(high) + 8)} y="108" fill="#8b949e" fontSize="10.5" textAnchor={X(high) + 120 > R ? 'end' : 'start'} style={S}>
            {X(high) + 120 > R ? '' : `today's range${vwap > 0 ? ' · VWAP' : ''}`}
          </text>
        </g>
      )}

      <line x1={pxX} y1="24" x2={pxX} y2="122" stroke="#ffffff" strokeWidth="2" />
      <rect x={pxX - pillW / 2} y="120" width={pillW} height="18" rx="9" fill="#ffffff" />
      <text x={pxX} y="133" fill="#0d1117" fontSize="11.5" fontWeight="700" textAnchor="middle" style={T}>{Math.round(price)}</text>

      <line x1={L} y1="148" x2={R} y2="148" stroke="#30363d" />
      {ticks.map(t => (
        <text key={t} x={X(t)} y="164" fill="#8b949e" fontSize="10.5" textAnchor="middle" style={T}>{t}</text>
      ))}
    </svg>
  );
}

// Distance from price to the nearest short strike on each side, in units of the
// remaining expected move. Null on a side with no short strike.
function shortCushion(legs, price, em) {
  if (!(em > 0) || !(price > 0) || !Array.isArray(legs)) return null;
  const use = (legs.length === 4 && legs[0]?.label?.includes('VIX')) ? legs.slice(0, 2) : legs;
  const shorts = use.filter(l => /short|sell/i.test(l.label || '') && isFinite(l.strike)).map(l => l.strike);
  if (!shorts.length) return null;
  const below = shorts.filter(k => k <= price), above = shorts.filter(k => k > price);
  return {
    below: below.length ? (price - Math.max(...below)) / em : null,
    above: above.length ? (Math.min(...above) - price) / em : null,
  };
}

// Setup quality card: one weighted segment bar (segment width = criterion
// weight, fill = points earned) + the top point-losers sorted by cost, with
// the distance to the next grade. The full 9-row breakdown is collapsible.
function SetupQualityCard({ r, sBg, sClr }) {
  const [showDetail, setShowDetail] = useState(false);
  const crits = r.criteria || [];
  const score = r.setupScore || 0;
  // Grade thresholds: A+ 85, A 70, B 50 (matches engine grading)
  const nextUp = score >= 85 ? null
    : score >= 70 ? { pts: 85 - score, grade: 'A+' }
    : score >= 50 ? { pts: 70 - score, grade: 'A' }
    : { pts: 50 - score, grade: 'B' };
  const lost = crits
    .filter(c => (c.pts || 0) < (c.max || 0))
    .map(c => ({ ...c, lost: (c.max || 0) - (c.pts || 0) }))
    .sort((a, b) => b.lost - a.lost)
    .slice(0, 3);
  const fillColor = pct => pct >= 80 ? '#3fb950' : pct >= 50 ? '#2f81f7' : pct >= 30 ? '#d29922' : '#f85149';
  return (
    <div className="card">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-semibold text-white uppercase tracking-wider flex items-center">Setup quality<Info text="8 criteria scored out of 100: Compression (15), Move consumed (15), Tail risk / P(max loss) (10), Strategy fit (15), VWAP structure (15), VIX gap (10), ES overnight direction (10), Overnight range (5), Gamma distance (5). VWAP structure merges the former VWAP slope (10) and VWAP distance (5), which were scoring the same measurement twice. A+ = 85+, A = 70+, B = 50+, No setup = below 50. Segment width = criterion weight; fill = points earned." /></span>
        <div className="flex items-center gap-2">
          <span style={{background:sBg,color:sClr,padding:'3px 10px',borderRadius:20,fontSize:13,fontWeight:700}}>{r.setup}</span>
          <span className="mono" style={{background:sBg,color:sClr,padding:'3px 8px',borderRadius:6,fontSize:13,fontWeight:600}}>{score}/100</span>
        </div>
      </div>
      {nextUp && nextUp.pts > 0 && (
        <div style={{fontSize:12.5,color:'#a8b2be',marginBottom:6}}>{nextUp.pts} pt{nextUp.pts !== 1 ? 's' : ''} to {nextUp.grade}</div>
      )}
      {crits.length > 0 && (
        <div style={{display:'flex',gap:1,height:12,borderRadius:4,overflow:'hidden',marginBottom:4}}>
          {crits.map((c, i) => {
            const pct = c.max > 0 ? Math.round((c.pts || 0) / c.max * 100) : 0;
            return (
              <div key={i} title={`${c.label}: ${c.pts}/${c.max}`} style={{flex:c.max || 1,background:'#21262d'}}>
                <div style={{width:`${pct}%`,height:'100%',background:fillColor(pct),transition:'width 0.3s'}}/>
              </div>
            );
          })}
        </div>
      )}
      <div style={{fontSize:12,color:'#8b949e',marginBottom:8}}>Segment width = weight · fill = points earned · hover for detail</div>
      {lost.length > 0 && (
        <div style={{borderTop:'1px solid #21262d',paddingTop:6,marginBottom:2}}>
          <div style={{fontSize:12.5,color:'#a8b2be',marginBottom:3}}>Costing you the most</div>
          {lost.map((c, i) => (
            <div key={i} className="flex items-center justify-between" style={{padding:'2px 0'}}>
              <span className="text-xs text-white">{c.label}</span>
              <span className="mono text-xs" style={{color: c.lost >= c.max / 2 ? '#f85149' : '#d29922'}}>−{c.lost}</span>
            </div>
          ))}
        </div>
      )}
      <div onClick={() => setShowDetail(s => !s)}
        style={{fontSize:12.5,color:'#58a6ff',cursor:'pointer',userSelect:'none',marginTop:4}}>
        {showDetail ? 'Hide all criteria ▴' : 'Show all criteria ▾'}
      </div>
      {showDetail && (
        <div style={{marginTop:6}}>
          {crits.map((cr, i) => {
            const pct = cr.max > 0 ? Math.round((cr.pts || 0) / cr.max * 100) : 0;
            return (
              <div key={i} className="flex items-center gap-2 mb-1">
                <span className="text-xs text-white truncate" style={{flex:'0 0 160px'}}>{cr.label}</span>
                <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{background:'#21262d'}}>
                  <div style={{width:`${pct}%`,height:'100%',background:fillColor(pct),borderRadius:4,transition:'width 0.3s'}}/>
                </div>
                <span className="text-xs text-white mono" style={{flex:'0 0 36px',textAlign:'right'}}>{cr.pts}/{cr.max}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PayoffDiagram({ payoff, currentPrice, mini, targets }) {
  if (!payoff || !payoff.points || payoff.points.length < 2) return null;
  const W = mini ? 280 : 460;
  const H = mini ? 140 : 220;
  const PAD = mini ? { top: 10, right: 12, bottom: 22, left: 48 } : { top: 14, right: 15, bottom: 28, left: 55 };
  const cW = W - PAD.left - PAD.right;
  const cH = H - PAD.top - PAD.bottom;
  const pts = payoff.points;
  const prices = pts.map(p => p.price);
  const pnls = pts.map(p => p.pnl);
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const minPnl = Math.min(...pnls, 0);
  const tgts = (targets || []).filter(t => t && t.pnl > 0 && isFinite(t.pnl));
  const maxPnl = Math.max(...pnls, 0, ...tgts.map(t => t.pnl));
  const pnlRange = maxPnl - minPnl || 1;
  const x = p => PAD.left + (p - minP) / (maxP - minP) * cW;
  const y = pnl => PAD.top + cH - ((pnl - minPnl) / pnlRange) * cH;
  const zeroY = y(0);
  const fs = mini ? 9 : 11;

  // Build fill paths
  let linePath = '';
  pts.forEach((p, i) => {
    const px = x(p.price), py = y(p.pnl);
    linePath += (i === 0 ? 'M' : 'L') + px + ' ' + py + ' ';
  });

  let fillAbove = 'M' + x(pts[0].price) + ' ' + zeroY + ' ';
  let fillBelow = 'M' + x(pts[0].price) + ' ' + zeroY + ' ';
  pts.forEach(p => {
    const px = x(p.price), py = y(p.pnl);
    fillAbove += 'L' + px + ' ' + (p.pnl > 0 ? py : zeroY) + ' ';
    fillBelow += 'L' + px + ' ' + (p.pnl < 0 ? py : zeroY) + ' ';
  });
  fillAbove += 'L' + x(pts[pts.length-1].price) + ' ' + zeroY + ' Z';
  fillBelow += 'L' + x(pts[pts.length-1].price) + ' ' + zeroY + ' Z';

  // Price axis ticks
  const priceTicks = [];
  for (let i = 0; i <= 4; i++) {
    const p = minP + (maxP - minP) * (i / 4);
    priceTicks.push({ x: x(p), label: Math.round(p) });
  }

  return (
    <svg viewBox={'0 0 ' + W + ' ' + H} style={{width:'100%',height:'auto',overflow:'visible'}}>
      {/* Zero line */}
      <line x1={PAD.left} y1={zeroY} x2={W-PAD.right} y2={zeroY} stroke="#c9d1d9" strokeWidth="0.5" strokeDasharray="3,3"/>
      {/* Fill areas */}
      <path d={fillAbove} fill="#3fb950" fillOpacity="0.20" />
      <path d={fillBelow} fill="#f85149" fillOpacity="0.15" />
      {/* P&L line */}
      <path d={linePath} fill="none" stroke="#e6edf3" strokeWidth={mini ? 2 : 2.5} strokeLinejoin="round" />
      {/* Current price line */}
      {currentPrice > 0 && currentPrice >= minP && currentPrice <= maxP && (
        <>
          <line x1={x(currentPrice)} y1={PAD.top} x2={x(currentPrice)} y2={H-PAD.bottom} stroke="#2f81f7" strokeWidth="1" strokeDasharray="3,2"/>
          <text x={x(currentPrice)} y={PAD.top-2} textAnchor="middle" fill="#58a6ff" fontSize={fs} fontWeight="600">{Math.round(currentPrice)}</text>
        </>
      )}
      {/* Profit-target lines (ticket target, tastylive % of max) */}
      {tgts.map((t, i) => (
        <g key={'t' + i}>
          <line x1={PAD.left} x2={W-PAD.right} y1={y(t.pnl)} y2={y(t.pnl)} stroke={t.color || '#3fb950'} strokeWidth="1" strokeDasharray="6,3"/>
          <text x={W-PAD.right-2} y={y(t.pnl)-3} textAnchor="end" fill={t.color || '#3fb950'} fontSize={fs}>{t.label + ' $' + t.pnl.toFixed(0)}</text>
        </g>
      ))}
      {/* Breakevens */}
      {payoff.breakevens?.map((be, i) => be >= minP && be <= maxP && (
        <g key={i}>
          <circle cx={x(be)} cy={zeroY} r={mini ? 3 : 4} fill="#d29922" />
          <text x={x(be)} y={zeroY+(mini?12:14)} textAnchor="middle" fill="#f0c040" fontSize={fs} fontWeight="600">{be.toFixed(0)}</text>
        </g>
      ))}
      {/* Y-axis labels */}
      <text x={PAD.left-4} y={zeroY+4} textAnchor="end" fill="#c9d1d9" fontSize={fs}>$0</text>
      {maxPnl > 0 && <text x={PAD.left-4} y={y(maxPnl)+4} textAnchor="end" fill="#c9d1d9" fontSize={mini ? 8 : fs}>{'$' + maxPnl.toFixed(0)}</text>}
      {minPnl < 0 && <text x={PAD.left-4} y={y(minPnl)+4} textAnchor="end" fill="#c9d1d9" fontSize={mini ? 8 : fs}>{'$' + minPnl.toFixed(0)}</text>}
      {/* X-axis price labels */}
      {priceTicks.map((t, i) => (
        <text key={i} x={t.x} y={H-(mini?5:5)} textAnchor="middle" fill="#c9d1d9" fontSize={fs}>{t.label}</text>
      ))}
    </svg>
  );
}

// ProfitScale (the six % tiles) was replaced by ProfitTaker.jsx — Sep 2026.

function CreditTape({ value, low, high, max, isCredit, label }) {
  const safeMax = max || 1;
  const pct = (v) => Math.max(0, Math.min(100, (v / safeMax) * 100));
  const valuePct = pct(value);
  const lowPct = pct(low);
  const highPct = pct(high);

  let grade, gradeColor;
  if (value === 0) {
    grade = 'Enter value'; gradeColor = '#a8b2be';
  } else if (value >= low && value <= high) {
    grade = 'Fair value'; gradeColor = '#3fb950';
  } else if (isCredit && value > high) {
    grade = 'Rich \u2014 good fill'; gradeColor = '#3fb950';
  } else if (isCredit && value < low) {
    grade = 'Cheap \u2014 widen strikes?'; gradeColor = '#f85149';
  } else if (!isCredit && value < low) {
    grade = 'Cheap \u2014 good fill'; gradeColor = '#3fb950';
  } else if (!isCredit && value > high) {
    grade = 'Expensive'; gradeColor = '#f85149';
  } else {
    grade = ''; gradeColor = '#a8b2be';
  }

  return (
    <div style={{marginTop:6}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
        <span style={{fontSize:12,color:'#a8b2be'}}>{isCredit ? 'Credit received' : 'Debit paid'}</span>
        <span style={{fontSize:12,fontWeight:600,color:gradeColor}}>{grade}</span>
      </div>
      <div style={{position:'relative',height:14,borderRadius:7,overflow:'hidden',background:'#161b22'}}>
        {isCredit ? (
          <div style={{position:'absolute',top:0,left:0,width:lowPct+'%',height:'100%',background:'#f85149',opacity:0.25}} />
        ) : (
          <div style={{position:'absolute',top:0,left:highPct+'%',width:(100-highPct)+'%',height:'100%',background:'#f85149',opacity:0.25}} />
        )}
        <div style={{position:'absolute',top:0,left:lowPct+'%',width:Math.max(2,(highPct-lowPct))+'%',height:'100%',background:'#3fb950',opacity:0.35,borderRadius:2}} />
        {isCredit ? (
          <div style={{position:'absolute',top:0,left:highPct+'%',width:(100-highPct)+'%',height:'100%',background:'#3fb950',opacity:0.15}} />
        ) : (
          <div style={{position:'absolute',top:0,left:0,width:lowPct+'%',height:'100%',background:'#3fb950',opacity:0.15}} />
        )}
        <div style={{position:'absolute',top:0,left:lowPct+'%',width:2,height:'100%',background:'#3fb950',opacity:0.7}} />
        <div style={{position:'absolute',top:0,left:highPct+'%',width:2,height:'100%',background:'#3fb950',opacity:0.7}} />
        {value > 0 && (
          <div style={{position:'absolute',top:-1,left:`calc(${valuePct}% - 3px)`,width:6,height:16,borderRadius:3,background:'#fff',boxShadow:'0 0 6px rgba(0,0,0,0.6)'}} />
        )}
      </div>
      <div style={{position:'relative',height:16,marginTop:2}}>
        <span style={{position:'absolute',left:0,fontSize:11,color:'#8b949e'}}>$0</span>
        <span style={{position:'absolute',left:lowPct+'%',transform:'translateX(-50%)',fontSize:11,color:'#3fb950',fontWeight:600}}>${low.toFixed(2)}</span>
        <span style={{position:'absolute',left:highPct+'%',transform:'translateX(-50%)',fontSize:11,color:'#3fb950',fontWeight:600}}>${high.toFixed(2)}</span>
        <span style={{position:'absolute',right:0,fontSize:11,color:'#8b949e'}}>${safeMax.toFixed(1)}</span>
      </div>
    </div>
  );
}

function SpeedTape({ label, value, min, max, zones, display, sublabel }) {
  const range = max - min;
  const pct = Math.max(0, Math.min(100, ((value - min) / range) * 100));
  // Determine color at current position
  let markerColor = '#a8b2be';
  let cumPct = 0;
  for (const z of zones) {
    const zonePct = ((z.to - min) / range) * 100;
    if (pct <= zonePct) { markerColor = z.color; break; }
    markerColor = z.color;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-text-muted">{label}</span>
        <div className="flex items-center gap-2">
          <span className="text-xs mono font-bold" style={{color:markerColor}}>{display}</span>
          {sublabel && <span className="text-[12px] text-text-faint">{sublabel}</span>}
        </div>
      </div>
      <div style={{position:'relative',height:8,borderRadius:4,overflow:'hidden',background:'#21262d'}}>
        {/* Zone gradient */}
        <div style={{display:'flex',height:'100%',width:'100%'}}>
          {zones.map((z, i) => {
            const prevTo = i === 0 ? min : zones[i-1].to;
            const w = ((z.to - prevTo) / range) * 100;
            return <div key={i} style={{width:w+'%',height:'100%',background:z.color,opacity:0.25}} />;
          })}
        </div>
        {/* Filled portion */}
        <div style={{position:'absolute',top:0,left:0,height:'100%',width:pct+'%',borderRadius:4,overflow:'hidden'}}>
          <div style={{display:'flex',height:'100%',width: (100/pct*100)+'%'}}>
            {zones.map((z, i) => {
              const prevTo = i === 0 ? min : zones[i-1].to;
              const w = ((z.to - prevTo) / range) * 100;
              return <div key={i} style={{width:w+'%',height:'100%',background:z.color,opacity:0.85}} />;
            })}
          </div>
        </div>
        {/* Marker */}
        <div style={{position:'absolute',top:-1,left:`calc(${pct}% - 1px)`,width:3,height:10,borderRadius:1,background:'#fff',boxShadow:'0 0 4px rgba(0,0,0,0.5)'}} />
      </div>
    </div>
  );
}

function Info({ text }) {
  const [show, setShow] = React.useState(false);
  const [pos, setPos] = React.useState({ top: 0, left: 0, flipDown: false });
  const ref = React.useRef(null);

  const updatePos = () => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      const flipDown = rect.top < 200;
      setPos({
        top: flipDown ? rect.bottom + 8 : rect.top - 8,
        left: Math.min(Math.max(rect.left, 160), window.innerWidth - 160),
        flipDown
      });
    }
  };

  return (
    <span ref={ref} style={{position:'relative',display:'inline-block',marginLeft:5}}>
      <span
        onClick={(e) => { e.stopPropagation(); setShow(!show); if (!show) updatePos(); }}
        onMouseEnter={() => { setShow(true); updatePos(); }}
        onMouseLeave={() => setShow(false)}
        style={{display:'inline-flex',alignItems:'center',justifyContent:'center',width:15,height:15,borderRadius:'50%',background:'#21262d',color:'#a8b2be',fontSize:11,fontWeight:700,cursor:'pointer',border:'1px solid #30363d',lineHeight:1,userSelect:'none'}}>?</span>
      {show && ReactDOM.createPortal(
        <div style={{
          position:'fixed',
          top: pos.flipDown ? pos.top : 'auto',
          bottom: pos.flipDown ? 'auto' : (window.innerHeight - pos.top),
          left: pos.left,
          transform:'translateX(-50%)',
          width:300,padding:'12px 14px',
          background:'#1c2128',border:'1px solid #444c56',borderRadius:10,
          fontSize:12.5,color:'#e6edf3',lineHeight:1.6,
          zIndex:9999,boxShadow:'0 8px 24px rgba(0,0,0,0.6)',whiteSpace:'normal',
          maxWidth:'calc(100vw - 32px)',pointerEvents:'none'
        }}>
          {text}
        </div>,
        document.body
      )}
    </span>
  );
}

// ── Collapsible input-column section ──
// Pure re-layout wrapper for the INPUT column: a sticky header row (title,
// completeness badge, action buttons) over exactly the JSX that used to sit
// flat in the column. Collapse state lives in the parent so it can persist per
// mode under localStorage 'ot_engine_sections'. `pinned` renders even while
// collapsed (the TWS position picker must never hide behind a collapsed card).
// The header is sticky within the input column's scroller: bg-bg-card masks the
// inputs scrolling underneath, zIndex 5 keeps it above them (Info tooltips are
// portaled to <body> at zIndex 9999, so they are unaffected).
function InputSection({ title, info, missing, collapsed, onToggle, onExpand, actions, pinned, children }) {
  return (
    <section className="mt-4 first:mt-0">
      <div onClick={onToggle}
        className="sticky top-0 bg-bg-card flex items-center justify-between gap-2 flex-wrap cursor-pointer select-none"
        style={{ zIndex: 5, padding: '5px 0 7px' }}>
        <div className="flex items-center min-w-0">
          <span aria-hidden="true" style={{ width: 13, display: 'inline-block', fontSize: 9, color: '#a8b2be', flex: 'none' }}>{collapsed ? '▸' : '▾'}</span>
          <span className="text-[12.5px] font-semibold uppercase tracking-wider text-text-faint flex items-center whitespace-nowrap">{title}{info && <Info text={info} />}</span>
          {missing != null && (missing === 0 ? (
            <span title="All required inputs entered" style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: '#3fb950' }}>✓</span>
          ) : (
            <span onClick={e => { e.stopPropagation(); if (onExpand) onExpand(); }}
              title={missing + ' required input' + (missing === 1 ? '' : 's') + ' still blank — the decision banner reads incomplete until filled. Click to expand the section.'}
              style={{ marginLeft: 8, padding: '1px 7px', borderRadius: 9, fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap',
                background: '#1f1a0d', color: '#d29922', border: '1px solid #9e6a03', cursor: 'pointer' }}>
              {missing} missing
            </span>
          ))}
        </div>
        {actions && (
          <div className="flex items-center gap-2 flex-wrap justify-end" onClick={e => e.stopPropagation()}>{actions}</div>
        )}
      </div>
      {pinned}
      {!collapsed && children}
    </section>
  );
}

function SectionLabel({ children, white, info }) {
  return (
    <div className={`text-xs font-semibold uppercase tracking-wider mt-4 mb-2 first:mt-0 flex items-center ${white ? 'text-white' : 'text-[#c9d1d9]'}`}>
      {children}
      {info && <Info text={info} />}
    </div>
  );
}

// `manual` = you typed this and auto-fill is leaving it alone (amber, with the
// feed's value shown alongside when the two disagree). `stale` = the last pull
// did not return this field at all, so what is on screen is older than the badge
// suggests (dim, dashed). `bad` still wins over both — it means the value is wrong.
function Inp({label,value,onChange,type,bad,manual,stale,feedVal,field}) {
  const border = bad ? 'border-[#f85149]' : manual ? 'border-[#9e6a03]' : 'border-[#30363d]';
  const lblCls = bad ? 'text-[#f85149]' : manual ? 'text-[#d29922]' : 'text-[#c9d1d9]';
  const differs = manual && feedVal !== undefined && String(feedVal) !== String(value == null ? '' : value);
  const tip = manual
    ? 'Manual — you typed this, so auto-fill left it alone.' + (differs ? ' The last pull said ' + feedVal + '.' : '')
    : stale ? 'The last auto-fill did not return this field, so this value is older than the badge above.' : undefined;
  return (<div><label className={`text-[12.5px] block mb-1 ${lblCls}`} title={tip}>
      {label}{manual ? ' ✎' : ''}
      {differs && <span className="text-[#9aa4b0] font-normal"> feed {feedVal}</span>}
      {!manual && stale && <span className="text-[#9aa4b0] font-normal"> · no feed</span>}
    </label>
    <input type={type||'number'} step="any" value={value||''} onChange={e=>onChange(e.target.value)} placeholder="—" title={tip} data-field={field}
      style={(!bad && !manual && stale) ? {borderStyle:'dashed'} : undefined}
      className={`w-full px-3 py-2 bg-[#0d1117] border rounded-lg text-sm text-white mono outline-none focus:border-[#2f81f7] ${border}`}/></div>);
}
function Sel({label,value,onChange,options}) {
  return (<div><label className="text-[12.5px] text-[#c9d1d9] block mb-1">{label}</label>
    <select value={value} onChange={e=>onChange(e.target.value)}
      className="w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-sm text-white outline-none focus:border-[#2f81f7]">
      {options.map(o=>{ const v = typeof o === 'object' ? o.value : o, l = typeof o === 'object' ? o.label : o;
        return <option key={v} value={v}>{l}</option>; })}</select></div>);
}
// Inline pre-fill chip: the payoff engine computed this value and the sizing
// field is empty or disagrees. Click to copy it in — typed values are NEVER
// overwritten automatically. Win/Risk are sizing fields, outside the held/
// auto-fill contract, so filling one creates no hold.
function PrefillChip({ payoffVal, fieldVal, onFill }) {
  if (payoffVal == null || !isFinite(payoffVal) || payoffVal <= 0) return null;
  const v = Math.round(payoffVal);
  const cur = parseFloat(fieldVal);
  if (isFinite(cur) && Math.abs(cur - v) < 0.5) return null; // already matches
  return (
    <button type="button" onClick={() => onFill(String(v))}
      title="Computed from the payoff at expiry. Click to fill — your typed value is never overwritten automatically."
      style={{marginTop:3,padding:'1px 7px',borderRadius:4,border:'1px solid #1f6feb55',background:'#0d1a2e',color:'#58a6ff',fontSize:12,fontWeight:600,cursor:'pointer'}}>
      ← {v} from payoff
    </button>
  );
}

function KV({label,value,cls}) {
  return (<div className="flex justify-between py-1 border-b border-[#21262d] last:border-0">
    <span className="text-sm text-[#c9d1d9]">{label}</span>
    <span className={`text-sm font-semibold mono ${cls||'text-white'}`}>{value}</span></div>);
}
