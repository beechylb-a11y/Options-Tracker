// ── Exit plan card (Nov 2026) ──
//
// Replaces the thin exit strip on the Execution section. One card that answers "what
// do I type into TWS?":
//
//   ladder     stop · entry · target(s) · max, as prices AND dollars for the contracts
//              on the ticket — the numbers you type, big enough to read across a desk.
//   controls   the profit target, tranches and your stop, inline (ProfitTaker's card
//              variant, passed in as `editor`). "edit targets & stop" used to open a
//              drawer that held them two sections down; now they sit under the ladder.
//   TWS ticket the orders in the order you key them: the entry, then the profit
//              target(s). Your stop is listed for reference only — it is NOT sent: you
//              manage the loss yourself (decision, 14 Nov 2026) and the check-up flags it.
//   Stage      "Stage in TWS" sends the entry + profit target(s) to TWS through the
//              bridge with transmit off. They land in TWS's order window filled in;
//              nothing reaches the exchange until you click Transmit there.
//   outcomes   what each exit is worth after commission, and reward : risk.

import React, { useEffect, useState } from 'react';
import { comboTick, tickEntry, tickTarget, DEFAULT_TICK } from '../engine/ticks';
import { Clock, Copy, Check, Send } from 'lucide-react';
import { normalisePosition, pnlAt } from '../utils/ticketMath';
import { alpha } from '../utils/theme';
import { TimeRing } from './EngineVisual';

const C = { green: 'var(--c-3fb950)', green2: 'var(--c-2ea043)', red: 'var(--c-f85149)', amber: 'var(--c-d29922)', blue: 'var(--c-58a6ff)',
  grey: 'var(--c-8b949e)', soft: 'var(--c-a8b2be)', text: 'var(--c-e6edf3)', white: 'var(--c-ffffff)', line: 'var(--c-30363d)', line2: 'var(--c-21262d)',
  bg: 'var(--c-0d1117)', panel: 'var(--c-161b22)' };
const MONO = 'JetBrains Mono, SF Mono, Menlo, monospace';
const money = v => (v == null || !isFinite(v) ? '—' : (v >= 0 ? '+$' : '−$') + Math.abs(Math.round(v)).toLocaleString());
const cap = { fontSize: 11.5, letterSpacing: '.07em', textTransform: 'uppercase', color: C.grey };
const ACCT_KEY = 'stage-account-v1';
const HDR = { 'ngrok-skip-browser-warning': '1' };

/**
 * Lay labels along the ladder so they never sit on top of each other: each keeps its
 * marker's position unless that is within `gap` % of its neighbour, then it slides
 * along (the marker stays put). Clamped inside the card.
 */
export function spreadLabels(xs, gap = 12, lo = 5, hi = 95) {
  const idx = xs.map((x, i) => i).sort((a, b) => xs[a] - xs[b]);
  const out = xs.map(x => Math.max(lo, Math.min(hi, x)));
  for (let k = 1; k < idx.length; k++) {
    const a = idx[k - 1], b = idx[k];
    if (out[b] - out[a] < gap) out[b] = out[a] + gap;
  }
  if (idx.length && out[idx[idx.length - 1]] > hi) {
    out[idx[idx.length - 1]] = hi;
    for (let k = idx.length - 2; k >= 0; k--) {
      const a = idx[k], b = idx[k + 1];
      if (out[b] - out[a] < gap) out[a] = out[b] - gap;
    }
  }
  return out;
}

/** The exit plan as numbers — pure, so the tests check the arithmetic. */
export function exitNumbers({ net, win, qty, plan, maxRisk, tick = DEFAULT_TICK }) {
  const n = Number(net);
  const q = Math.max(1, Number(qty) || 1);
  if (!isFinite(n) || n === 0) return null;
  // Prices go onto the contract's tick grid, in the trader's favour (engine/ticks.js):
  // SPX combos trade in $0.05 steps and TWS rejects 22.12 with error 110.
  const credit = n > 0;
  const rawEntry = Math.abs(n);
  const entry = tickEntry(rawEntry, credit, tick) || rawEntry;
  const nT = credit ? entry : -entry;
  const pos = normalisePosition({ qty: q, qtyOpen: q, entryPrice: nT, maxProfit: win > 0 ? win * q : '', basis: plan && plan.basis });
  const priced = plan && Array.isArray(plan.priced) ? plan.priced : [];
  const targets = priced.filter(t => Number(t.qty) > 0 && isFinite(Number(t.price)))
    .map((t, i, a) => {
      const px = tickTarget(Number(t.price), credit, tick);
      return { label: a.length > 1 ? `T${i + 1}` : 'Target', pct: Number(t.pct) || 0, qty: Number(t.qty), price: px, rawPrice: Number(t.price),
        gain: pnlAt(pos, px, Number(t.qty)) };
    });
  const ticked = entry !== rawEntry || targets.some(t => t.price !== t.rawPrice);
  const targetAll = targets.reduce((a, t) => a + t.gain, 0);
  let stopPrice = plan && plan.stopPrice != null && isFinite(Number(plan.stopPrice)) ? Number(plan.stopPrice) : null;
  let stop = stopPrice != null ? pnlAt(pos, stopPrice, q) : null;
  const max = pos.isCredit ? entry * 100 * q : win > 0 ? win * q : null;
  const maxPrice = pos.isCredit ? 0 : win > 0 ? entry + win / 100 : null;
  const worst = maxRisk > 0 ? -Math.abs(maxRisk) : pos.isCredit ? null : -entry * 100 * q;
  // A stop past the most the trade can lose can never trigger (Nov 2026): on a 0DTE iron
  // fly the 100%-of-credit guide sits beyond the wings, and the card priced a −$2,250
  // stop on a trade that cannot lose more than $750. The wings are the stop: cap it at
  // the max loss and say so.
  let stopBeyondMax = false;
  if (stop != null && worst != null && stop < worst) {
    stopBeyondMax = true;
    stop = worst;
    stopPrice = pos.isCredit ? entry + Math.abs(worst) / (100 * q) : Math.max(0, entry - Math.abs(worst) / (100 * q));
  }
  const comm = plan && Number(plan.commRoundTrip) > 0 ? Number(plan.commRoundTrip) : 0;
  const risk = stop != null ? Math.abs(stop) + comm : worst != null ? Math.abs(worst) + comm : null;
  const reward = targets.length ? targetAll - comm : null;
  const rr = risk > 0 && reward != null ? reward / risk : null;
  const breakEvenWin = risk > 0 && reward > 0 ? risk / (risk + reward) : null;
  return { pos, q, entry, rawEntry, tick, ticked, isCredit: pos.isCredit, targets, targetAll, stopPrice, stop, stopBeyondMax, max, maxPrice, worst, comm, reward, risk, rr, breakEvenWin };
}

function CopyBtn({ text, label = 'Copy', testid }) {
  const [ok, setOk] = useState(false);
  const go = () => {
    try { navigator.clipboard && navigator.clipboard.writeText(String(text)); } catch { /* blocked */ }
    setOk(true); setTimeout(() => setOk(false), 1200);
  };
  return (
    <button data-testid={testid} onClick={go} title={`Copy ${text}`}
      style={{ justifySelf: 'end', display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 8, border: `1px solid ${C.line}`,
        fontSize: 12, fontWeight: 700, color: ok ? C.green : C.blue, background: 'transparent', cursor: 'pointer' }}>
      {ok ? <Check size={12} /> : <Copy size={12} />}{ok ? 'Copied' : label}
    </button>
  );
}

function Ladder({ N }) {
  const pts = [];
  if (N.stop != null) pts.push({ key: 'stop', v: N.stop, price: N.stopPrice, cap: 'Your stop', col: C.red, ring: true });
  else if (N.worst != null) pts.push({ key: 'worst', v: N.worst, price: null, cap: 'Worst', col: C.red, dot: true });
  pts.push({ key: 'entry', v: 0, price: N.entry, cap: 'Entry', col: C.soft, tick: true });
  N.targets.forEach((t, i) => pts.push({ key: 't' + i, v: t.gain * (N.q / Math.max(1, t.qty)), shown: t.gain, price: t.price,
    cap: `${t.label} ${t.pct ? Math.round(t.pct) + '%' : ''}${N.targets.length > 1 ? ` ×${t.qty}` : ''}`, col: C.green, ring: true }));
  if (N.max != null) pts.push({ key: 'max', v: N.max, price: N.maxPrice, cap: 'Max', col: C.green2, dot: true });
  const lo = Math.min(...pts.map(p => p.v), 0), hi = Math.max(...pts.map(p => p.v), 1);
  const P = v => ((v - lo) / Math.max(1, hi - lo)) * 100;
  const xs = pts.map(p => P(p.v));
  const lx = spreadLabels(xs);
  const z = P(0);
  return (
    <div data-testid="exit-ladder" style={{ position: 'relative', height: 100, margin: '18px 8px 4px' }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 42, height: 10, borderRadius: 5,
        background: `linear-gradient(90deg, ${C.red} 0%, ${alpha(C.red, '55')} ${z}%, ${alpha(C.green, '55')} ${z}%, ${C.green} 100%)` }} />
      {pts.map((p, i) => (
        <React.Fragment key={p.key}>
          {p.tick && <div style={{ position: 'absolute', left: `${xs[i]}%`, top: 34, width: 2, height: 26, marginLeft: -1, background: C.soft }} />}
          {p.ring && <div style={{ position: 'absolute', left: `${xs[i]}%`, top: 38, width: 18, height: 18, marginLeft: -9, borderRadius: '50%', border: `3.5px solid ${p.col}`, background: C.panel }} />}
          {p.dot && <div style={{ position: 'absolute', left: `${xs[i]}%`, top: 41, width: 12, height: 12, marginLeft: -6, borderRadius: '50%', background: p.col }} />}
          <div data-testid={`ladder-${p.key}`} style={{ position: 'absolute', left: `${lx[i]}%`, top: 0, transform: 'translateX(-50%)', textAlign: 'center', whiteSpace: 'nowrap' }}>
            <div style={{ ...cap, color: p.key === 'entry' ? C.grey : p.col, fontWeight: 800 }}>{p.cap}</div>
            <div style={{ fontFamily: MONO, fontSize: 20, fontWeight: 800, color: p.col, lineHeight: 1.15 }}>{p.price != null ? p.price.toFixed(2) : '—'}</div>
          </div>
          <div style={{ position: 'absolute', left: `${lx[i]}%`, top: 66, transform: 'translateX(-50%)', whiteSpace: 'nowrap',
            fontFamily: MONO, fontSize: p.key === 'entry' ? 13 : 15, fontWeight: p.key === 'entry' ? 500 : 800, color: p.key === 'entry' ? C.grey : p.col }}>
            {p.key === 'entry' ? '$0' : money(p.shown != null ? p.shown : p.v)}
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}

const ROW = { display: 'grid', gridTemplateColumns: '28px 74px minmax(0,1fr) 128px minmax(0,230px) 82px', alignItems: 'center', gap: 10,
  padding: '10px 14px', borderBottom: `1px solid ${C.line2}` };
const Num = ({ n, col }) => <span style={{ width: 24, height: 24, borderRadius: '50%', display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 800, color: '#fff', background: col }}>{n}</span>;
const note = { fontSize: 12.5, color: C.grey, lineHeight: 1.45, minWidth: 0 };

/**
 * @param head        { underlying, strikes:[..], strategy, expiryLabel }
 * @param net         signed per share, + credit
 * @param win         max profit per contract ($), 0 if unknown
 * @param qty         contracts on the ticket
 * @param plan        ProfitTaker's onPlan (priced, stopPrice, commRoundTrip …)
 * @param maxRisk     $ for the ticket, worst case at expiry
 * @param when        { label, days|hours, sub }
 * @param stageLegs   [{ strike, right, qty (signed per lot), expiry }]  — null: can't stage
 * @param stageWhyNot text shown instead of the button when staging is not possible
 * @param tif         'DAY' | 'GTC' for the profit target(s)
 * @param entryTif    'CUTOFF' | 'GTC' | 'DAY' for the entry — 0DTE CUTOFF: a DAY order the bridge cancels at
 *                    12:30 ET if unfilled (TWS rejects GTD on SPX-type combos); 45DTE GTC
 * @param orderRef    tag on the TWS orders
 * @param editor      the inline controls (ProfitTaker variant="card")
 * @param onStaged    called after TWS accepted the staged orders
 */
const fmtSigned = v => { const n = Number(v); return !isFinite(n) ? '—' : `${Math.abs(n).toFixed(2)} ${n >= 0 ? 'cr' : 'db'}`; };

export default function ExitPlanCard({ head = {}, net, win, qty, plan, maxRisk, when, stageLegs, stageWhyNot, tif = 'DAY', entryTif = 'DAY', orderRef, editor, onStaged }) {
  const N = exitNumbers({ net, win, qty, plan, maxRisk, tick: comboTick(head.underlying) });
  const [health, setHealth] = useState(null);
  const [acct, setAcct] = useState(() => { try { return localStorage.getItem(ACCT_KEY) || ''; } catch { return ''; } });
  const [st, setSt] = useState({ s: 'idle' });
  let bridgeUrl = '';
  try { bridgeUrl = localStorage.getItem('bridgeUrl') || ''; } catch { /* private */ }

  useEffect(() => {
    if (!bridgeUrl) return;
    let dead = false;
    fetch(`${bridgeUrl}/api/health`, { headers: HDR }).then(r => r.json()).then(h => { if (!dead) setHealth(h); }).catch(() => { if (!dead) setHealth({ connected: false }); });
    return () => { dead = true; };
  }, [bridgeUrl]);
  const accounts = (health && Array.isArray(health.accounts)) ? health.accounts : [];
  useEffect(() => { if (accounts.length && !accounts.includes(acct)) setAcct(accounts[0]); }, [accounts.join(','), acct]); // eslint-disable-line react-hooks/exhaustive-deps
  // A changed plan makes an earlier "staged" stale.
  const sig = N ? JSON.stringify([N.entry, N.q, N.targets.map(t => [t.qty, t.price])]) : '';
  useEffect(() => { setSt(s => (s.s === 'ok' || s.s === 'err' ? { s: 'idle' } : s)); }, [sig]);

  if (!N) {
    return <div data-testid="exit-plan" style={{ fontSize: 12.5, color: C.grey }}>Exit plan appears once the net credit/debit is in.</div>;
  }
  const cr = N.isCredit;
  const openAct = cr ? 'SELL' : 'BUY', closeAct = cr ? 'BUY' : 'SELL';
  const sideTag = cr ? 'CR' : 'DB';
  const strikes = (head.strikes || []).join(' / ');
  const desc = [head.underlying, head.expiryLabel, strikes].filter(Boolean).join(' ');
  const paper = health && health.mode === 'paper';
  const cutoff = entryTif === 'CUTOFF' || entryTif === 'GTD';
  const entryTifLabel = cutoff ? 'DAY · cancels 12:30 ET' : entryTif;

  async function stage() {
    if (!bridgeUrl || !stageLegs) return;
    setSt({ s: 'busy' });
    try {
      const body = { underlying: head.underlying, legs: stageLegs, lots: N.q, side: cr ? 'credit' : 'debit', entry: N.entry,
        targets: N.targets.map(t => ({ qty: t.qty, price: t.price })), tif, entryTif, account: acct || undefined, orderRef };
      const r = await fetch(`${bridgeUrl}/api/stage-order`, { method: 'POST', headers: { ...HDR, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      let j = null; try { j = await r.json(); } catch { j = null; }
      if (!r.ok || !j || !j.staged) throw new Error((j && j.error) || (r.status === 404 ? 'The bridge is on old code — git pull on the Mac and restart it' : `bridge said ${r.status}`));
      setSt({ s: 'ok', summary: j.summary || [], account: j.account, midAtSend: j.midAtSend, spreadAtSend: j.spreadAtSend, entry: N.entry * (cr ? 1 : -1) });
      onStaged && onStaged(j);
    } catch (e) {
      setSt({ s: 'err', msg: e.message || String(e) });
    }
  }

  const tile = (k, v, sub, col, tone) => (
    <div data-testid={`exit-out-${tone}`} style={{ flex: '1 1 190px', padding: '12px 14px', borderRadius: 12, minWidth: 0,
      border: `1px solid ${col && tone !== 'rr' && tone !== 'worst' ? alpha(col, '88') : C.line}`, background: col && tone !== 'rr' && tone !== 'worst' ? alpha(col, '14') : 'transparent' }}>
      <div style={cap}>{k}</div>
      <div style={{ fontFamily: MONO, fontSize: 26, fontWeight: 800, color: col || C.text, lineHeight: 1.2 }}>{v}</div>
      <div style={note}>{sub}</div>
    </div>
  );

  return (
    <div data-testid="exit-plan" style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', minWidth: 0 }}>
          <span style={{ ...cap, fontSize: 12.5, fontWeight: 800, color: C.white }}>Exit plan</span>
          <span style={{ fontFamily: MONO, fontSize: 14, color: C.soft }}>
            {[desc, head.strategy, `${N.q} ct`].filter(Boolean).join(' · ')} · entry <b style={{ color: cr ? C.green : C.text }}>{N.entry.toFixed(2)} {cr ? 'cr' : 'db'}</b>
          </span>
        </div>
        {when && (
          <div data-testid="exit-when" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <TimeRing days={when.days} hours={when.hours} />
            <div style={{ fontSize: 12.5, color: C.soft, lineHeight: 1.35 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}><Clock size={12} /> {when.label}</div>
              {when.sub && <div style={{ color: C.amber }}>{when.sub}</div>}
            </div>
          </div>
        )}
      </div>

      <Ladder N={N} />

      {editor && <div style={{ marginTop: 12 }}>{editor}</div>}

      {/* TWS ticket */}
      <div data-testid="tws-ticket" style={{ marginTop: 16, border: `1px solid ${C.line}`, borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '10px 14px', background: C.bg, borderBottom: `1px solid ${C.line2}`, flexWrap: 'wrap' }}>
          <span style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <span style={{ ...cap, fontWeight: 800, color: C.white }}>TWS ticket</span>
            <span style={note}>in the order you key it · entry + profit target{N.targets.length > 1 ? 's' : ''}, nothing else</span>
          </span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: 640 }}>
            <div data-testid="tws-row-entry" style={ROW}>
              <Num n={1} col={C.blue} />
              <span style={{ fontWeight: 800, fontSize: 13, letterSpacing: '.04em', color: cr ? C.red : C.green }}>{openAct} {N.q}</span>
              <span style={{ fontFamily: MONO, fontSize: 14, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {desc} <span style={{ color: C.soft }}>{head.strategy || ''}</span></span>
              <span><span style={cap}>LMT</span> <span style={{ fontFamily: MONO, fontSize: 20, fontWeight: 800 }}>{N.entry.toFixed(2)}</span>{' '}
                <span style={{ fontSize: 11, fontWeight: 800, padding: '2px 6px', borderRadius: 5, color: cr ? C.green : C.soft, border: `1px solid ${cr ? C.green : C.line}` }}>{sideTag}</span></span>
              <span data-testid="entry-tif" style={note}>opening order · {entryTifLabel}</span>
              <CopyBtn text={N.entry.toFixed(2)} testid="copy-entry" />
            </div>
            {N.targets.length ? N.targets.map((t, i) => (
              <div key={i} data-testid={`tws-row-target-${i}`} style={ROW}>
                <Num n={2 + i} col={C.green} />
                <span style={{ fontWeight: 800, fontSize: 13, letterSpacing: '.04em', color: C.green }}>{closeAct} {t.qty}</span>
                <span style={{ fontFamily: MONO, fontSize: 14 }}>{N.targets.length > 1 ? t.label + ' · ' : ''}Profit taker <span style={{ color: C.grey }}>· attached</span></span>
                <span><span style={cap}>LMT</span> <span style={{ fontFamily: MONO, fontSize: 20, fontWeight: 800, color: C.green }}>{t.price.toFixed(2)}</span></span>
                <span style={{ ...note, fontFamily: MONO }}>{money(t.gain)} · offset {(t.price - N.entry >= 0 ? '+' : '−') + Math.abs(t.price - N.entry).toFixed(2)} · {tif}</span>
                <CopyBtn text={t.price.toFixed(2)} testid={`copy-target-${i}`} />
              </div>
            )) : (
              <div style={{ ...ROW, gridTemplateColumns: '1fr' }}><span style={note}>No profit target set — pick one above.</span></div>
            )}
            {/* Your stop: reference only, never sent. */}
            <div data-testid="tws-row-stop" style={{ ...ROW, opacity: 0.85, background: alpha(C.red, '0a'), borderBottomStyle: 'dashed' }}>
              <span style={{ width: 24, height: 24, borderRadius: '50%', border: `1.5px dashed ${C.red}` }} />
              <span style={{ fontWeight: 800, fontSize: 12, letterSpacing: '.04em', color: C.red }}>YOURS</span>
              <span style={{ fontSize: 13.5, color: C.soft }}>{N.stopBeyondMax ? <>Stop is past the max loss — the wings cap it at <b style={{ fontFamily: MONO, color: C.red }}>{money(N.stop)}</b></> : <>Stop {N.stopPrice != null ? <>at <b style={{ fontFamily: MONO, color: C.red }}>{N.stopPrice.toFixed(2)}</b> {money(N.stop)}</> : '— none set'}</>}</span>
              <span style={{ ...cap, color: C.red, fontWeight: 800 }}>not sent</span>
              <span style={{ ...note, gridColumn: 'span 2' }}>you manage the loss; the check-up flags this level</span>
            </div>
            {when && (
              <div data-testid="tws-row-time" style={{ ...ROW, borderBottom: 0, background: alpha(C.amber, '12') }}>
                <span style={{ width: 24, height: 24, borderRadius: '50%', display: 'grid', placeItems: 'center', background: C.amber, color: '#fff' }}><Clock size={13} /></span>
                <span style={{ fontWeight: 800, fontSize: 12.5, letterSpacing: '.04em', color: C.amber }}>TIME</span>
                <span style={{ fontSize: 13.5, gridColumn: 'span 3' }}>{when.label}{when.sub ? <span style={{ color: C.grey }}> · {when.sub}</span> : null}</span>
                <span />
              </div>
            )}
          </div>
        </div>
        {/* Stage */}
        <div data-testid="stage-bar" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '12px 14px', background: C.bg, borderTop: `1px solid ${C.line2}` }}>
          {stageLegs && bridgeUrl && N.targets.length > 0 ? (
            <>
              <button data-testid="stage-btn" onClick={stage} disabled={st.s === 'busy' || (health && health.connected === false)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 14px', borderRadius: 9, fontSize: 13.5, fontWeight: 800, cursor: 'pointer',
                  border: `1px solid ${C.blue}`, background: alpha(C.blue, '22'), color: C.white, opacity: st.s === 'busy' ? 0.6 : 1 }}>
                <Send size={14} /> {st.s === 'busy' ? 'Staging…' : 'Stage in TWS'}
              </button>
              {health && health.mode ? (
                <span data-testid="stage-mode" style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.06em', padding: '3px 8px', borderRadius: 6,
                  color: paper ? C.blue : C.amber, border: `1px solid ${paper ? C.blue : C.amber}` }}>{paper ? 'PAPER' : 'LIVE'}</span>
              ) : null}
              {accounts.length > 1 ? (
                <select data-testid="stage-account" value={acct} onChange={e => { setAcct(e.target.value); try { localStorage.setItem(ACCT_KEY, e.target.value); } catch { /* */ } }}
                  style={{ padding: '6px 8px', borderRadius: 8, border: `1px solid ${C.line}`, background: C.panel, color: C.text, fontFamily: MONO, fontSize: 12.5 }}>
                  {accounts.map(a => <option key={a} value={a}>{a}</option>)}
                </select>
              ) : accounts.length === 1 ? <span style={{ fontFamily: MONO, fontSize: 12.5, color: C.soft }}>{accounts[0]}</span> : null}
              <span style={note}>
                {health && health.connected === false ? 'TWS is not connected to the bridge.'
                  : <>Sends {openAct} {N.q} @ {N.entry.toFixed(2)} + {N.targets.length > 1 ? `${N.targets.length} profit targets` : `the profit target @ ${N.targets[0].price.toFixed(2)}`} with <b>transmit off</b>. Entry is {cutoff ? <><b>DAY</b>, and the bridge <b>cancels it at 12:30 ET if nothing has filled</b> (TWS won’t take a timed order on this combo)</> : entryTifLabel}. Nothing trades until you click Transmit in TWS. No stop is sent.</>}
                {N.ticked && <span data-testid="tick-note" style={{ display: 'block', marginTop: 4 }}>
                  {head.underlying || 'This'} combos trade in ${N.tick.toFixed(2)} steps, so the prices above are rounded your way:
                  {' '}entry {N.entry.toFixed(2)} (ticket {N.rawEntry.toFixed(2)}){N.targets.filter(t => t.price !== t.rawPrice).map((t, i) => <span key={i}>, {t.label.toLowerCase()} {t.price.toFixed(2)} ({t.rawPrice.toFixed(2)})</span>)}.
                </span>}
              </span>
            </>
          ) : (
            <span data-testid="stage-off" style={note}>
              {!bridgeUrl ? 'Set the bridge URL to stage this in TWS — or key the rows above.'
                : !N.targets.length ? 'Pick a profit target to stage the order.'
                  : (stageWhyNot || 'This ticket can’t be staged — key the rows above.')}
            </span>
          )}
        </div>
        {st.s === 'ok' && (
          <div data-testid="stage-ok" style={{ padding: '10px 14px', background: alpha(C.green, '18'), borderTop: `1px solid ${alpha(C.green, '66')}`, fontSize: 13, color: C.text, lineHeight: 1.5 }}>
            <b style={{ color: C.green }}>Staged in TWS — not transmitted.</b> Check it in TWS’s order window{st.account ? ` (${st.account})` : ''}, then click <b>Transmit</b> on the {openAct.toLowerCase()} order; the profit target goes with it.
            {st.summary && st.summary.length ? <div style={{ fontFamily: MONO, fontSize: 12, color: C.soft, marginTop: 4 }}>{st.summary.join('  ·  ')}</div> : null}
            {st.midAtSend != null ? (
              <div data-testid="stage-mid" style={{ fontFamily: MONO, fontSize: 12, color: C.soft, marginTop: 2 }}>
                Market when staged: mid {fmtSigned(st.midAtSend)}{st.spreadAtSend != null ? ` · spread ${Number(st.spreadAtSend).toFixed(2)}` : ''} · your limit {fmtSigned(st.entry)} — recorded on the ticket so the fill can be checked against it.
              </div>
            ) : null}
          </div>
        )}
        {st.s === 'err' && (
          <div data-testid="stage-err" style={{ padding: '10px 14px', background: alpha(C.red, '14'), borderTop: `1px solid ${alpha(C.red, '66')}`, fontSize: 13, color: C.text }}>
            <b style={{ color: C.red }}>Not staged.</b> {st.msg}
          </div>
        )}
      </div>

      {/* outcomes */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
        {tile(N.targets.length > 1 ? `If all ${N.targets.length} targets fill` : 'If the target fills', N.reward != null ? money(N.reward) : '—',
          N.reward != null ? `${money(N.targetAll)} less $${N.comm.toFixed(2)} commission` : 'no target set', C.green, 'target')}
        {tile('If you take your stop', N.stop != null ? money(N.stop - N.comm) : '—',
          N.stop != null ? (N.stopBeyondMax ? `capped at the max loss — the wings are the stop` : `${money(N.stop)} less $${N.comm.toFixed(2)} · not in TWS`) : 'no stop set', C.red, 'stop')}
        {tile('Worst case at expiry', N.worst != null ? money(N.worst) : '—', N.worst != null ? 'if nothing is closed' : 'needs max risk', C.red, 'worst')}
        {tile(N.stop != null ? 'Reward : risk to your stop' : 'Reward : risk to worst case', N.rr != null ? `${N.rr.toFixed(2)} : 1` : '—',
          N.breakEvenWin != null ? `needs ~${Math.round(N.breakEvenWin * 100)}% wins to break even` : '', null, 'rr')}
      </div>
    </div>
  );
}
