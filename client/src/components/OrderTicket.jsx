import React, { useState, useEffect, useRef, useMemo } from 'react';
import { api } from '../utils/api';
import { unitsFromTicket, roundTripCommission, oneSideCommission } from '../utils/commission';
import { useCommissionRate } from '../utils/useCommissionRate';
import { fmt$, pnlColor } from '../utils/format';
import { startCloseVolSnapshot } from '../utils/volSnapshot';
import { lastSessionDate } from '../engine/session';
import {
  normalisePosition, withEntryFill, avgOfFills, targetToPrice, priceToTarget, pnlAt, ibkrLines,
  ladder, LADDER_PRESETS, rollSummary, carriedFromTws, pnlPct, snap, defaultTick, loadPlan, savePlan, round2, stopToPrice, ruleLadderPcts,
  basisFromNotes,
} from '../utils/ticketMath';
import { exitRuleFor, STOP_LOSS_PCT } from '../engine/data';
import TicketHelp, { OFFSET_TIP } from './TicketHelp';
import RollOrderPanel from './RollOrderPanel';
import { rollChain } from '../engine/rollChain';
import { checkupFor } from './Checkup45';
import { TicketHeader, PnlLadder, RollBeforeAfter } from './TicketVisual';
import { legsFromNotes } from '../utils/positionMatch';
import { comboTranches, closingFills } from '../utils/fillMatch';

// SELL ticket — modelled on the IBKR order ticket. Two jobs:
//
//   Close   scale out of ONE buy-in in tranches. Each row is a working limit
//           (qty, % of max profit ⇄ limit price ⇄ $), mark it Filled with the fill
//           price and it is written as its own row in Closes; the rest stay on the
//           ticket as the plan for next time. Replaces the one-tranche-at-a-time
//           "Partial close" toggle, which is still how the server records them.
//   Roll    45DTE: take the old legs off and put the new ones on as one combo.
//           Realises P&L on the old ticket for the rolled qty and logs a NEW
//           ticket for the new legs, linked in both notes, so the realised result
//           and the new risk are never blended into one number.
//
// Works the same for paper and TWS accounts — nothing here needs the bridge. For
// TWS accounts the fill fetch is offered alongside, as a cross-check.
//
// props: position (Journal decision row OR OpenPositions row), onClose, onDone
const inp = {
  padding: '6px 8px', borderRadius: 6, border: '1px solid #30363d', background: '#0d1117',
  color: '#e6edf3', fontSize: 13, fontFamily: 'JetBrains Mono,monospace', outline: 'none', width: '100%'
};
const lbl = { fontSize: 11.5, color: '#a8b2be', display: 'block', marginBottom: 3 };
// Accounts that never trade through TWS. PaperTrade used to be one; it trades in the
// TWS paper login now, so it reads fills like any other account (Oct 2026 — the TWS
// fills button and the closing-fill lookup were hidden for it).
const MANUAL_ACCOUNT_PREFIXES = [];


// The ticket prices off what was GOT (Oct 2026). OpenPositions rows arrive converted;
// a Journal / Decision Engine row does not carry the fills, so they are looked up
// here before the ticket is built — its ladder and stop are seeded from the entry
// at mount, so building it on the asked price first would leave them wrong.
export default function OrderTicket(props) {
  const { position } = props;
  const ready = !position || position._entryFromFills || position.avgEntry != null && position.avgEntry !== '';
  const [resolved, setResolved] = useState(() => (ready ? withEntryFill(position) : null));
  useEffect(() => {
    if (ready) { setResolved(withEntryFill(position)); return; }
    let live = true;
    const p0 = normalisePosition(position);
    const done = row => { if (live) setResolved(row); };
    if (!p0.ticketRef) { done(position); return; }
    let req;
    try { req = api.getFills(p0.account || undefined, p0.ticketRef); } catch (e) { done(position); return; }
    Promise.resolve(req)
      .then(rows => {
        const mine = (Array.isArray(rows) ? rows : []).filter(f => String(f['Ticket Ref'] ?? f.ticketRef) === String(p0.ticketRef));
        const a = avgOfFills(mine);
        done(a ? withEntryFill(position, a) : position);
      })
      .catch(() => done(position));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position]);
  if (!resolved) {
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)' }} onClick={props.onClose}>
        <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 12, padding: 20, color: '#a8b2be', fontSize: 13 }}>Loading the fills…</div>
      </div>
    );
  }
  return <OrderTicketBody {...props} position={resolved} />;
}

function OrderTicketBody({ position, onClose, onDone, initialTab }) {
  // A plan saved at entry carries its basis (e.g. a 0DTE fly planned on tastylive's
  // % of max profit); price its tranches on the same basis it was planned on.
  const pos = useMemo(() => {
    const p0 = normalisePosition(position);
    const sb = loadPlan(p0.timestamp)?.basis;
    return sb ? { ...p0, basis: sb } : p0;
  }, [position]);
  const tick = defaultTick(pos.underlying);
  const side = pos.isCredit ? 'db' : 'cr';                      // side the CLOSE prices on
  const isManual = MANUAL_ACCOUNT_PREFIXES.some(p => pos.account.toLowerCase().startsWith(p));
  const is45 = /45/.test(pos.engine);
  // 0DTE has nothing to roll into — the Roll tab exists only for 45DTE.
  const [tab, setTab] = useState(is45 && initialTab === 'roll' ? 'roll' : 'close');
  // Ladder presets per engine. 0DTE targets are % on entry (a fly can run +200%),
  // 45DTE targets are % of max profit (manage winners at 50%).
  const PRESETS = is45
    ? { half: { label: 'Half @ 50, runner @ 75', pcts: [50, 75] }, all50: { label: 'All @ 50', pcts: [50] } }
    : { all50: { label: 'All @ +50%', pcts: [50] }, thirds: { label: 'Thirds +25 / +50 / +100', pcts: [25, 50, 100] }, all100: { label: 'All @ +100%', pcts: [100] } };
  const pctHead = pos.basis === 'entry' || pos.isCredit ? '% on entry' : '% of max';
  // Commission per contract per side, from the account (Settings); the box in the
  // header overrides it for this ticket. Every figure below is ROUND TRIP for the
  // contracts closed — their share of the entry commission plus the close — because
  // that is what the trade cost and what the log now records. (Oct 2026.)
  const acctRate = useCommissionRate(pos.account);
  const [commission, setCommission] = useState(acctRate);
  useEffect(() => { setCommission(acctRate); }, [acctRate]);
  const units = unitsFromTicket(pos.legs, pos.strategyRaw || pos.strategy) || 1;
  // A trade that EXPIRED did not trade out, so there is no closing leg and no closing
  // commission — and it was not a target fill either. Logged as an ordinary tranche the
  // record said "T1 128% target" on a trade whose T1 was +25% and which simply ran to
  // the bell, and charged a round trip on a cash settlement. Both the SPX 7620/7660/7700
  // and the IWM 272/275/279 of 22 Oct went in that way. An expiry mislabelled as a target
  // is worse than the $2.60: it tells the exit-rule review that a rule fired when none
  // did, in the direction that flatters the rule. (Oct 2026.)
  const [expired, setExpired] = useState(false);
  const rtFees = q => roundTripCommission(units, q, commission);
  // What the contracts being recorded actually cost. The stop line below keeps the round
  // trip either way — a stop IS a trade out, so it pays both sides whatever this ticket
  // is being used for right now.
  // Real commissions where TWS has them (Oct 2026): the entry's from the Fills table,
  // the exit's from the TWS closing fills; the account rate only for what is missing.
  // IWM was charged $41.60 by the estimate and $31.66 by IBKR.
  const [entryFeeLot, setEntryFeeLot] = useState(null);   // $ per lot, from recorded fills
  const [twsClose, setTwsClose] = useState(null);          // closingFills() result
  const exitFees = q => {
    const entryPart = entryFeeLot != null ? entryFeeLot * q : oneSideCommission(units, q, commission);
    if (expired) return round2(entryPart);
    const exitPart = twsClose && twsClose.qty > 0 ? (twsClose.exitFees / twsClose.qty) * q : oneSideCommission(units, q, commission);
    return round2(entryPart + exitPart);
  };
  const [closeDate, setCloseDate] = useState(lastSessionDate());   // NY session date, not UTC
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  // On open: the entry commission actually paid, and whether TWS already closed this.
  const [twsNote, setTwsNote] = useState('');
  useEffect(() => {
    let live = true;
    if (pos.ticketRef && api.getFills) {
      Promise.resolve().then(() => api.getFills(pos.account || undefined, pos.ticketRef)).then(rows0 => {
        const mine = (Array.isArray(rows0) ? rows0 : []).filter(f => String(f['Ticket Ref'] ?? f.ticketRef) === String(pos.ticketRef));
        const q = mine.reduce((a, f) => a + (parseFloat(f['Qty Filled'] ?? f.qtyFilled) || 0), 0);
        const fe = mine.reduce((a, f) => a + (parseFloat(f['Fees ($)'] ?? f.feesUsd ?? f.fees) || 0), 0);
        if (live && q > 0 && fe > 0) setEntryFeeLot(fe / q);
      }).catch(() => {});
    }
    let bridgeUrl = '';
    try { bridgeUrl = localStorage.getItem('bridgeUrl') || ''; } catch (e) { /* private mode */ }
    if (!bridgeUrl || isManual || !(pos.qtyOpen > 0)) return () => { live = false; };
    fetch(bridgeUrl + '/api/executions?all=1', { headers: { 'ngrok-skip-browser-warning': '1' } })
      .then(r => r.json())
      .then(d => {
        const c = closingFills(comboTranches(d.fills || []), {
          underlying: pos.underlying, strikes: String(pos.legs || '').split(/[\/|,\s]+/).map(Number).filter(x => x > 0),
          isCredit: pos.isCredit, entryDate: pos.entryDate || '',
          recordedNotes: (position.closes || []).map(c0 => c0.notes || ''),
        });
        if (!live || !c) return;
        setTwsClose(c);
        // Put them on the ticket straight away — the price TWS got, not the target.
        const q = Math.min(c.qty, pos.qtyOpen);
        const px = +c.avgPrice.toFixed(2);
        const tPct = priceToTarget(pos, px);
        setRows(rs => {
          const rest = pos.qtyOpen - q;
          const out = [{ qty: q, pct: tPct != null ? round2(tPct) : '', price: px, status: 'Filled', fill: px, tws: true }];
          if (rest > 0) out.push(...rs.filter(r => r.status !== 'Filled').slice(0, 1).map(r => ({ ...r, qty: rest })));
          return out;
        });
        setTwsNote(`TWS ${pos.isCredit ? 'bought back' : 'sold'} ${c.qty} @ ${c.avgPrice.toFixed(2)} at ${c.time} ET · exit commission $${c.exitFees.toFixed(2)} — filled in below`);
      }).catch(() => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── tranche rows ────────────────────────────────────────────────────────
  // Seeded from the plan saved at entry (engine profit-taker ladder) when there is
  // one; otherwise a sensible ladder for the engine. Plans store {qty, pct}; the
  // limit is re-derived so an edited Max Profit can never leave a stale price.
  const mkRow = (qty, pct) => ({ qty, pct, price: snap(targetToPrice(pos, pct), tick), status: 'Working', fill: '' });
  const [rows, setRows] = useState(() => {
    const saved = loadPlan(pos.timestamp);
    const src = saved?.rows?.length ? saved.rows : ladder(pos.qtyOpen || 1, ruleLadderPcts(exitRuleFor(pos.engine || (is45 ? '45DTE' : '0DTE'), pos.strategy), is45 ? [50, 75] : [50]));
    // Trim the plan to what is still open. Contracts closed since the plan was
    // saved came off the FRONT of the ladder (the nearest targets fill first), so
    // skip that many from the front and keep the runners.
    const planned = saved?.rows?.length ? (saved.openAtSave ?? pos.qty) : pos.qtyOpen;
    let skip = Math.max(0, planned - (pos.qtyOpen || 0)), left = pos.qtyOpen || 0; const out = [];
    for (const r of src) {
      let q = r.qty; const s = Math.min(skip, q); skip -= s; q -= s;
      q = Math.min(q, left); if (q <= 0) continue; left -= q; out.push(mkRow(q, r.pct));
    }
    return out.length ? out : [mkRow(pos.qtyOpen || 1, 50)];
  });
  // The plan saved at entry wins; otherwise the 100%-of-premium stop guide.
  const [stopPct, setStopPct] = useState(() => { const p = loadPlan(pos.timestamp); return p && p.stopPct !== '' && p.stopPct != null ? p.stopPct : String(STOP_LOSS_PCT); });

  const setRow = (i, patch) => setRows(rs => rs.map((r, j) => j === i ? { ...r, ...patch } : r));
  const onPct = (i, v) => { const pct = parseFloat(v); setRow(i, { pct: v, price: isFinite(pct) ? snap(targetToPrice(pos, pct), tick) : '' }); };
  const onPrice = (i, v) => { const p = parseFloat(v); const t = isFinite(p) ? priceToTarget(pos, p) : null; setRow(i, { price: v, pct: t != null ? round2(t) : '' }); };
  const applyPreset = key => setRows(ladder(pos.qtyOpen || 1, PRESETS[key].pcts).map(r => mkRow(r.qty, r.pct)));

  const allocated = rows.reduce((a, r) => a + (Number(r.qty) || 0), 0);
  const overAllocated = allocated > pos.qtyOpen;
  const filled = rows.filter(r => r.status === 'Filled' && Number(r.qty) > 0);
  const rowFill = r => parseFloat(r.status === 'Filled' && r.fill !== '' ? r.fill : r.price);
  const rowNet = r => { const q = Number(r.qty) || 0, p = rowFill(r); return isFinite(p) ? pnlAt(pos, p, q) - exitFees(q) : 0; };
  const planNet = rows.reduce((a, r) => a + rowNet(r), 0);
  const filledNet = filled.reduce((a, r) => a + rowNet(r), 0);
  // Quantity-weighted average fill of the tranches being recorded, as % on entry.
  const filledQty = filled.reduce((a, r) => a + (Number(r.qty) || 0), 0);
  const filledAvgPx = filledQty ? filled.reduce((a, r) => a + (Number(r.qty) || 0) * rowFill(r), 0) / filledQty : NaN;
  const filledAvgPct = isFinite(filledAvgPx) ? pnlPct(pos, filledAvgPx) : null;
  const stopPrice = stopPct !== '' && isFinite(parseFloat(stopPct)) ? snap(stopToPrice(pos, parseFloat(stopPct)), tick) : null;

  // Vol snapshot + TWS fills, both best-effort, both started on open.
  const snapRef = useRef({});
  useEffect(() => { snapRef.current = startCloseVolSnapshot(pos.underlying, { expiry: pos.engine === '0DTE' ? pos.entryDate : '' }); // eslint-disable-next-line
  }, []);
  // A roll opens a NEW ticket, and the 45DTE check-up measures it from its entry
  // spot and ATM IV (Price / IV on the decision row) — without them it can't split
  // P&L into time / price / vol. The close snapshot above never fetched IV for a
  // 45DTE ticket and the roll never wrote one, so rolled tickets were logged with
  // neither (QQQ 699/709/755/765, 15 Oct). Read them from the same vol surface the
  // check-up compares against, started when the Roll tab opens. (Oct 2026.)
  const entrySnapRef = useRef(null);
  useEffect(() => {
    if (tab !== 'roll' || entrySnapRef.current) return;
    let bridgeUrl = '';
    try { bridgeUrl = localStorage.getItem('bridgeUrl') || ''; } catch (e) { /* private mode */ }
    if (!bridgeUrl || !pos.underlying) { entrySnapRef.current = Promise.resolve({}); return; }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 45000);
    entrySnapRef.current = fetch(bridgeUrl + '/api/vol-surface?underlying=' + encodeURIComponent(pos.underlying),
      { headers: { 'ngrok-skip-browser-warning': '1' }, signal: ctrl.signal })
      .then(r => r.json())
      .then(vs => (vs && !vs.error ? { spot: parseFloat(vs.spot) || null, iv: parseFloat(vs.iv) || null } : {}))
      .catch(() => ({}))
      .finally(() => clearTimeout(t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);
  const [fills, setFills] = useState(null);
  async function fetchFills() {
    const bridgeUrl = localStorage.getItem('bridgeUrl') || '';
    if (!bridgeUrl) { setMsg({ err: true, text: 'Set IBKR Bridge URL in Settings first.' }); return; }
    try {
      const d = await (await fetch(bridgeUrl + '/api/executions', { headers: { 'ngrok-skip-browser-warning': '1' } })).json();
      const sym = pos.underlying;
      setFills((d.fills || []).filter(f => (f.symbol || '').toUpperCase() === sym));
    } catch (e) { setMsg({ err: true, text: 'TWS fetch failed: ' + e.message }); }
  }

  function persistPlan(remaining, openAfter) {
    const rowsOut = remaining.map(r => ({ qty: Number(r.qty) || 0, pct: parseFloat(r.pct) || 0 }));
    savePlan(pos.timestamp, { rows: rowsOut, stopPct, openAtSave: openAfter });
  }

  async function recordFills() {
    if (!filled.length || overAllocated) return;
    setBusy(true); setMsg(null);
    const snapV = snapRef.current || {};
    try {
      // Sequential, never parallel: the server counts prior tranches to work out
      // what is still open, so two in flight would both see the same open qty.
      for (let i = 0; i < filled.length; i++) {
        const r = filled[i], q = Number(r.qty), p = rowFill(r);
        const fees = exitFees(q);
        const n = rows.indexOf(r) + 1;
        // An expiry has no target and no limit price to name — it has a settlement
        // value. Say that, so the exit-reason review can tell the two apart.
        const label = expired
          ? `Expired — settlement value ${isFinite(p) ? p.toFixed(2) : '—'}`
          : `T${n} ${parseFloat(r.pct).toFixed(0)}% target @ ${p.toFixed(2)} ${side}${Math.abs(p - parseFloat(r.price)) > 0.004 ? ` (limit ${parseFloat(r.price).toFixed(2)})` : ''}`
            + (r.tws && twsClose ? ` — TWS ${twsClose.date} ${twsClose.time} ET, IBKR commission [${twsClose.keys.join(' ')}]` : '');
        await api.closeTicket(pos.ticketRef, {
          closeDate, closePrice: p, qtyClosed: q, fees,
          grossPnl: pnlAt(pos, p, q),
          notes: [label, notes].filter(Boolean).join(' — '),
          account: pos.account,
          ...(i === 0 ? {
            sessionHigh: snapV.sessionHigh ?? null, sessionLow: snapV.sessionLow ?? null,
            closeVix: snapV.closeVix ?? null, closeIV: snapV.closeIV ?? null,
            closeUnderlyingPrice: snapV.closeUnderlyingPrice ?? null, closeVix1d: snapV.closeVix1d ?? null
          } : {})
        });
      }
      persistPlan(rows.filter(r => r.status !== 'Filled'), pos.qtyOpen - filled.reduce((a, r) => a + Number(r.qty), 0));
      onDone && onDone();
    } catch (e) {
      setMsg({ err: true, text: 'Close failed part-way: ' + e.message + ' — check Open positions before retrying; tranches already written stay written.' });
    }
    setBusy(false);
  }

  // ── roll ────────────────────────────────────────────────────────────────
  const oldStrikes = pos.legs.split(/[\/|,\s]+/).map(Number).filter(x => x > 0);
  const [roll, setRoll] = useState({
    qty: pos.qtyOpen || 1, closeAt: '', openAt: '', openSide: pos.isCredit ? 'cr' : 'db',
    expiry: '', strikes: oldStrikes.map(String),
    carried: '', carriedSide: pos.isCredit ? 'cr' : 'db'
  });
  const rq = Math.min(Number(roll.qty) || 0, pos.qtyOpen);
  const closeAt = parseFloat(roll.closeAt), openAtAbs = parseFloat(roll.openAt);
  const openNcd = isFinite(openAtAbs) ? (roll.openSide === 'cr' ? openAtAbs : -openAtAbs) : null;
  const newLegs = roll.strikes.join(' / ');
  const changedLegs = roll.strikes.filter((s, i) => Number(s) !== oldStrikes[i]).length;
  // Partial roll: some legs move, the rest carry across. TWS only trades the moved
  // legs, so the two prices are for those; the carried legs' entry price is needed
  // to split the result correctly between the old and new tickets (see rollSummary).
  // Rolling out in time moves every leg, strike changed or not (the order panel knows
  // the old expiry and reports it).
  const [rollShape, setRollShape] = useState({ allMoved: false, carried: null });
  const expiryMovesAll = !!roll.expiry && rollShape.allMoved;
  const partial = !expiryMovesAll && changedLegs > 0 && changedLegs < oldStrikes.length;
  const carriedStrikes = oldStrikes.filter((s, i) => Number(roll.strikes[i]) === s);
  const carriedAbs = parseFloat(roll.carried);
  const carriedNcd = partial ? (isFinite(carriedAbs) ? (roll.carriedSide === 'cr' ? carriedAbs : -carriedAbs) : null) : 0;
  // A ticket that was itself rolled carries its running basis in its notes; the
  // open-positions row doesn't have notes, so read them from its Decisions row.
  const [priorBasis, setPriorBasis] = useState(pos.priorBasis ?? null);
  // What the tickets this one was rolled from banked — part of the position's
  // result, so "Banked" shows it (it read "—" on QQQ with +$1,081 banked). (Oct 2026.)
  const [rollBanked, setRollBanked] = useState(null);
  // The ticket's Decisions row, and the 45DTE check-up for it — the same verdict, P&L
  // and price the Dashboard board shows (shared pass, one-minute cache). (Oct 2026.)
  const [decRow, setDecRow] = useState(null);
  const [check, setCheck] = useState(null);
  const [rollLegs, setRollLegs] = useState(null);
  const [rollMid, setRollMid] = useState(null);
  useEffect(() => {
    if (!pos.ticketRef || !api.getDecisions) return;
    let live = true;
    Promise.all([
      Promise.resolve().then(() => api.getDecisions()).catch(() => []),
      Promise.resolve().then(() => (api.getCloses ? api.getCloses() : [])).catch(() => []),
    ]).then(([d, cl]) => {
      const decs = Array.isArray(d) ? d : [];
      const r = decs.find(x => Number(x._rowIndex) === Number(pos.ticketRef));
      const b = basisFromNotes(r && (r.Notes || r.notes));
      if (live && b != null && pos.priorBasis == null) setPriorBasis(b);
      const c = r ? rollChain(r, { decisions: decs, closes: Array.isArray(cl) ? cl : [] }) : null;
      if (live && c) setRollBanked(c.banked);
      if (live && r) setDecRow(r);
      if (r) checkupFor(r, position).then(x => { if (live) setCheck(x); }).catch(() => {});
    }).catch(() => {});
    return () => { live = false; };
  }, [pos.ticketRef]);   // eslint-disable-line react-hooks/exhaustive-deps
  const rs = isFinite(closeAt) && openNcd != null && carriedNcd != null ? rollSummary({ ...pos, priorBasis }, rq, closeAt, openNcd, carriedNcd) : null;
  const rollFees = rtFees(rq);   // the old ticket's round trip: its entry and this close
  const [carriedMsg, setCarriedMsg] = useState('');
  async function carriedFromBridge() {
    const bridgeUrl = localStorage.getItem('bridgeUrl') || '';
    if (!bridgeUrl) { setCarriedMsg('Set the IBKR Bridge URL in Settings first.'); return; }
    setCarriedMsg('Reading TWS positions…');
    try {
      const d = await (await fetch(bridgeUrl + '/api/positions', { headers: { 'ngrok-skip-browser-warning': '1' } })).json();
      const v = carriedFromTws(d.raw || [], pos.underlying, carriedStrikes);
      if (v == null) { setCarriedMsg(`TWS has no ${pos.underlying} ${carriedStrikes.join('/')} position — type the entry price.`); return; }
      setRoll(r => ({ ...r, carried: Math.abs(v).toFixed(2), carriedSide: v >= 0 ? 'cr' : 'db' }));
      setCarriedMsg('From TWS avg cost (includes IBKR commission — use your fills if you want it exact).');
    } catch (e) { setCarriedMsg('TWS fetch failed: ' + e.message); }
  }

  async function recordRoll() {
    if (!rs || rq <= 0) return;
    setBusy(true); setMsg(null);
    const snapV = snapRef.current || {};
    const halfFees = rtFees(rq);
    // Entry spot / IV for the new ticket: whatever the vol surface has returned,
    // waiting at most 15s more — a roll must never hang on the bridge.
    const es = await Promise.race([
      Promise.resolve(entrySnapRef.current || {}),
      new Promise(r => setTimeout(() => r({}), 15000))
    ]).catch(() => ({}));
    try {
      const oldRef = pos.ticketRef;
      const carriedTxt = partial
        ? ` Carried ${carriedStrikes.join('/')} at entry ${Math.abs(carriedNcd).toFixed(2)} ${carriedNcd >= 0 ? 'cr' : 'db'}; moved legs closed @ ${closeAt.toFixed(2)} ${side}, opened @ ${openAtAbs.toFixed(2)} ${roll.openSide}.`
        : '';
      await api.closeTicket(oldRef, {
        // closeFull / openFull = the traded prices with the carried legs booked
        // through at their entry, so each ticket holds only its own P&L.
        closeDate, closePrice: rs.closeFull, qtyClosed: rq, fees: halfFees,
        grossPnl: round2(rs.realised),
        notes: [`ROLLED → ${newLegs}${roll.expiry ? ' exp ' + roll.expiry : ''} @ ${Math.abs(rs.openFull).toFixed(2)} ${rs.openFull >= 0 ? 'cr' : 'db'} (net roll ${rs.net >= 0 ? rs.net.toFixed(2) + ' cr' : Math.abs(rs.net).toFixed(2) + ' db'}).${carriedTxt}`, notes].filter(Boolean).join(' — '),
        account: pos.account,
        sessionHigh: snapV.sessionHigh ?? null, sessionLow: snapV.sessionLow ?? null,
        closeVix: snapV.closeVix ?? null, closeIV: snapV.closeIV ?? null,
        closeUnderlyingPrice: snapV.closeUnderlyingPrice ?? null, closeVix1d: snapV.closeVix1d ?? null
      });
      await api.logDecision({
        engine: pos.engine || '45DTE', underlying: pos.underlying,
        strategy: `${pos.underlying} - ${pos.strategy} - ${rq} contract${rq !== 1 ? 's' : ''}`,
        direction: 'Roll', contracts: rq, wingStrikes: newLegs, engineStrikes: newLegs,
        netCreditDebit: rs.openFull,
        // Max profit/risk are left blank on purpose: they depend on leg types and
        // widths the roll ticket does not model. Open the new legs in the engine
        // for those; % targets fall back to the entry credit meanwhile.
        notes: `Rolled from TICKET-${oldRef} (${pos.legs}, entry ${Math.abs(pos.ncd).toFixed(2)} ${pos.isCredit ? 'cr' : 'db'}). `
          + `Closed old @ ${rs.closeFull.toFixed(2)} ${side}, realised ${fmt$(rs.realised - halfFees)} on ${rq}. `
          + `Opened new @ ${Math.abs(rs.openFull).toFixed(2)} ${rs.openFull >= 0 ? 'cr' : 'db'}${roll.expiry ? ', exp ' + roll.expiry : ''}.${carriedTxt} `
          + `Net roll ${rs.net >= 0 ? rs.net.toFixed(2) + ' cr' : Math.abs(rs.net).toFixed(2) + ' db'}; cumulative basis ${rs.cumulative.toFixed(2)} ${rs.cumulative >= 0 ? 'cr' : 'db'}.`
          + (notes ? '\n\n--- My notes ---\n' + notes : ''),
        account: pos.account, timestamp: new Date().toISOString(),
        price: es.spot || snapV.closeUnderlyingPrice || '', iv: es.iv || '', vix: snapV.closeVix || '',
        dte: '45DTE', expiryDate: roll.expiry || ''
      });
      onDone && onDone();
    } catch (e) {
      setMsg({ err: true, text: 'Roll failed: ' + e.message + ' — if the old tranche was written but the new ticket was not, log the new legs from the engine.' });
    }
    setBusy(false);
  }

  const Tab = ({ id, children }) => (
    <button onClick={() => setTab(id)} style={{
      padding: '6px 14px', fontSize: 13, fontWeight: 700, cursor: 'pointer', border: 'none',
      borderBottom: `2px solid ${tab === id ? (id === 'close' ? '#f85149' : '#d29922') : 'transparent'}`,
      background: 'transparent', color: tab === id ? '#e6edf3' : '#8b949e'
    }}>{children}</button>
  );

  const noEntry = pos.ncd == null || pos.ncd === 0;
  // Live numbers from the check-up: this ticket's P&L, what it would cost to close now,
  // and the whole position with what the rolls (and any tranches) banked.
  const cm = check && check.review && check.review.metrics ? check.review.metrics : {};
  const bankedAll = (pos.realised || 0) + (rollBanked || 0);
  const ticketPnlNow = cm.pnl$ != null ? cm.pnl$ : null;
  const posPnlNow = ticketPnlNow != null ? ticketPnlNow + bankedAll : null;
  const nowClosePrice = cm.pnlShare != null && !noEntry ? Math.max(0, pos.isCredit ? Math.abs(pos.ncd) - cm.pnlShare : Math.abs(pos.ncd) + cm.pnlShare) : null;
  const titleExpiry = cm.nearExp || (() => { const l = decRow ? legsFromNotes(decRow.Notes) : null; return l && l.length ? l.map(x => String(x.expiry)).sort()[0] : null; })();
  // Roll picture: the legs held now (check-up, else the order panel's), and the same
  // legs with the moved strikes swapped in. Position entry per share includes what the
  // rolls banked; after the roll it adds the roll's mid once it is quoted.
  const legsNow = (check && check.legs) || rollLegs;
  const legsAfter = legsNow ? legsNow.map(l => { const i = oldStrikes.indexOf(Number(l.strike)); const k = i >= 0 ? Number(roll.strikes[i]) : Number(l.strike); return { ...l, strike: isFinite(k) && k > 0 ? k : Number(l.strike) }; }) : null;
  const ncdPosNow = !noEntry && pos.qtyOpen ? pos.ncd + bankedAll / (100 * pos.qtyOpen) : null;
  const rollPriced = rollMid != null ? rollMid : (rs ? rs.net : null);
  const ncdPosAfter = ncdPosNow != null && rollPriced != null && changedLegs > 0 ? ncdPosNow + rollPriced : null;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 12, padding: 20, width: 720, maxWidth: '96vw', maxHeight: '92vh', overflow: 'auto' }} onClick={e => e.stopPropagation()}>

        {/* Header — the board row: verdict, what it is, whole-position P&L (Oct 2026). */}
        <TicketHeader check={check} fallback={check === null && /45/.test(pos.engine || '') ? 'Checking…' : pos.engine || 'Open'}
          title={{ underlying: pos.underlying, strikes: oldStrikes, strategy: String(pos.strategy || '').replace(/\s*-\s*Normal\b/i, ''),
            qty: pos.qtyOpen, expiry: titleExpiry }}
          sub={<>entry <b className="mono" style={{ color: '#e6edf3' }}>{noEntry ? '—' : `${Math.abs(pos.ncd).toFixed(2)} ${pos.isCredit ? 'cr' : 'db'}`}</b>
            {' '}· max <span className="mono">{pos.maxProfitPerContract ? fmt$(pos.maxProfitPerContract) : `${fmt$(Math.abs(pos.ncd || 0) * 100)}*`}</span>/ct
            {' '}· opened {pos.entryDate || '—'} · {pos.account || 'no account'}{pos.qty !== pos.qtyOpen ? ` · ${pos.qty - pos.qtyOpen} of ${pos.qty} closed` : ''}</>}
          posPnl={posPnlNow} ticketPnl={ticketPnlNow} banked={bankedAll} onClose={onClose} />
        {!pos.maxProfitPerContract && !noEntry && (
          <div style={{ fontSize: 11.5, color: '#8b949e', marginTop: -6, marginBottom: 10 }}>
            * No Max Profit on this ticket — targets use the entry {pos.isCredit ? 'credit' : 'debit'} as the base. Right for credit spreads; understates a debit fly.
          </div>
        )}
        {noEntry && (
          <div style={{ padding: 8, borderRadius: 6, background: '#1f1a0d', border: '1px solid #9e6a03', color: '#d29922', fontSize: 12.5, marginBottom: 10 }}>
            This ticket has no Net Debit/Credit, so targets and P&L can't be derived. Enter P&L by hand via the Journal close, or re-log from the engine.
          </div>
        )}

        <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #21262d', marginBottom: 12 }}>
          <Tab id="close">Close · scale out</Tab>
          {is45 && <Tab id="roll">Roll · 45DTE</Tab>}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#a8b2be' }}>
            <span title="Per contract, each way. Set per account in Settings.">Comm / contract</span>
            <input type="number" step="0.01" value={commission} style={{ ...inp, width: 64 }}
              onChange={e => setCommission(e.target.value)} />
          </div>
        </div>

        {tab === 'close' && (<>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#8b949e' }}>Ladder:</span>
            {Object.entries(PRESETS).map(([k, p]) => (
              <button key={k} onClick={() => applyPreset(k)} style={{ fontSize: 12, padding: '3px 8px', borderRadius: 5, border: '1px solid #30363d', background: 'transparent', color: '#c9d1d9', cursor: 'pointer' }}>{p.label}</button>
            ))}
            <button onClick={() => setRows(r => [...r, mkRow(Math.max(1, pos.qtyOpen - allocated), 50)])}
              style={{ fontSize: 12, padding: '3px 8px', borderRadius: 5, border: '1px solid #2f81f7', background: 'transparent', color: '#58a6ff', cursor: 'pointer' }}>+ Tranche</button>
            {/* An expiry takes every contract still open, at once — there is no such
                thing as a partial expiry — so turning this on collapses the ladder to a
                single all-in row and asks for the settlement value instead of a fill. */}
            <button onClick={() => {
                const on = !expired;
                setExpired(on);
                if (on) setRows([{ qty: pos.qtyOpen || 1, pct: '', price: '', status: 'Filled', fill: '' }]);
                else setRows(ladder(pos.qtyOpen || 1, PRESETS[Object.keys(PRESETS)[0]].pcts).map(r => mkRow(r.qty, r.pct)));
              }}
              title="The trade ran to the bell instead of being traded out: no closing leg, no closing commission, and no target was hit."
              style={{ fontSize: 12, padding: '3px 8px', borderRadius: 5, cursor: 'pointer', fontWeight: expired ? 700 : 400,
                border: `1px solid ${expired ? '#9e6a03' : '#30363d'}`,
                background: expired ? '#1f1a0d' : 'transparent', color: expired ? '#d29922' : '#c9d1d9' }}>
              {expired ? '✓ Expired' : 'Expired'}
            </button>
            {!isManual && (
              <button onClick={fetchFills} style={{ marginLeft: 'auto', fontSize: 12, padding: '3px 8px', borderRadius: 5, border: '1px solid #2f81f7', background: '#0d1a2e', color: '#58a6ff', cursor: 'pointer' }}>⚡ TWS fills</button>
            )}
          </div>

          {expired && (
            <div style={{ padding: 8, borderRadius: 6, background: '#1f1a0d', border: '1px solid #9e6a03', color: '#d29922', fontSize: 12.5, marginBottom: 8, lineHeight: 1.5 }}>
              Recording an expiry on all {pos.qtyOpen} open. Put the structure's <b>settlement value</b> in Fill @ —
              what the legs were worth at the close, not zero unless it really expired worthless.
              Commission is the entry only; there is no closing leg to pay for.
              {' '}{/^(SPX|XSP|RUT|NDX|VIX)$/i.test(pos.underlying || '')
                ? `${pos.underlying} is cash settled, so this is the whole story.`
                : `${pos.underlying || 'This underlying'} settles into shares — any ITM leg is exercised or assigned, so check what stock position that left you holding.`}
            </div>
          )}

          {twsNote && (() => {
            const off = twsClose && rows.some(r => r.status === 'Filled' && r.fill !== '' && Math.abs(parseFloat(r.fill) - twsClose.avgPrice) > 0.004);
            return (
              <div data-testid="tws-close" style={{ padding: '8px 10px', borderRadius: 8, marginBottom: 10, fontSize: 12.5,
                background: off ? '#1f1a0d' : '#0d2818', border: `1px solid ${off ? '#9e6a03' : '#238636'}`, color: off ? '#e3b341' : '#3fb950' }}>
                ⚡ {twsNote}{off && <> — <b>a fill below differs from TWS ({twsClose.avgPrice.toFixed(2)})</b></>}
              </div>
            );
          })()}
          {!expired && !noEntry && (
            <PnlLadder pos={pos} qtyOpen={pos.qtyOpen} banked={bankedAll} stopPrice={stopPrice} nowPrice={nowClosePrice}
              targets={rows.map((r, i) => ({ label: `T${i + 1}`, price: parseFloat(r.status === 'Filled' && r.fill !== '' ? r.fill : r.price), qty: Number(r.qty) || 0, filled: r.status === 'Filled' }))} />
          )}
          <table className="w-full" style={{ fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: '#8b949e', fontSize: 11.5, textAlign: 'left' }}>
                <th style={{ padding: 4 }}>#</th><th style={{ padding: 4, width: 60 }}>Qty</th>
                <th style={{ padding: 4, width: 80 }}>{pctHead}</th><th style={{ padding: 4, width: 92 }}>{expired ? '' : `LMT ${side}`}</th>
                <th style={{ padding: 4 }}>Status</th><th style={{ padding: 4, width: 92 }}>{expired ? 'Settled @' : 'Fill @'}</th>
                <th style={{ padding: 4, textAlign: 'right' }}>P&L</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const net = rowNet(r);
                const p = parseFloat(r.price);
                const ib = isFinite(p) && !noEntry ? ibkrLines(pos, p) : null;
                // The price achieved (or targeted), as % profit/loss on what was
                // paid/received — the number you actually judge an exit by.
                const px = rowFill(r);
                const rowPct = isFinite(px) && !noEntry ? pnlPct(pos, px) : null;
                const isFilled = r.status === 'Filled';
                return (
                  <React.Fragment key={i}>
                    <tr style={{ borderTop: '1px solid #21262d' }}>
                      <td style={{ padding: 4, color: '#8b949e' }}>T{i + 1}</td>
                      <td style={{ padding: 4 }}><input type="number" min="1" value={r.qty} onChange={e => setRow(i, { qty: e.target.value })} style={inp} /></td>
                      <td style={{ padding: 4 }}><input type="number" step="5" value={r.pct} onChange={e => onPct(i, e.target.value)} style={inp} /></td>
                      <td style={{ padding: 4 }}><input type="number" step={tick} value={r.price} disabled={expired} placeholder={expired ? '—' : ''}
                        onChange={e => onPrice(i, e.target.value)} style={{ ...inp, opacity: expired ? 0.3 : 1 }} /></td>
                      <td style={{ padding: 4 }}>
                        <button onClick={() => setRow(i, { status: r.status === 'Filled' ? 'Working' : 'Filled', fill: r.fill || r.price })}
                          style={{ fontSize: 12, fontWeight: 700, padding: '4px 10px', borderRadius: 5, cursor: 'pointer', border: '1px solid',
                            borderColor: r.status === 'Filled' ? '#238636' : '#9e6a03',
                            background: r.status === 'Filled' ? '#0d2818' : '#1f1a0d',
                            color: r.status === 'Filled' ? '#3fb950' : '#d29922' }}>{r.status}</button>
                      </td>
                      <td style={{ padding: 4 }}>
                        <input type="number" step={tick} disabled={r.status !== 'Filled'} value={r.status === 'Filled' ? r.fill : ''}
                          data-testid={expired ? 'settle-value' : `fill-${i}`}
                          placeholder="—" onChange={e => setRow(i, { fill: e.target.value })} style={{ ...inp, opacity: r.status === 'Filled' ? 1 : 0.4 }} />
                      </td>
                      <td className="mono" style={{ padding: 4, textAlign: 'right', lineHeight: 1.25 }}>
                        {rowPct != null && <div style={{ fontWeight: 700, fontSize: 14, color: pnlColor(rowPct) }}>{rowPct >= 0 ? '+' : '−'}{Math.abs(rowPct).toFixed(0)}%</div>}
                        <div style={{ fontSize: 12, color: pnlColor(net) }}>{fmt$(net)}</div>
                      </td>
                      <td style={{ padding: 4 }}>
                        <button onClick={() => setRows(rs => rs.filter((_, j) => j !== i))} title="Remove tranche"
                          style={{ background: 'none', border: 'none', color: '#8b949e', cursor: 'pointer' }}>×</button>
                      </td>
                    </tr>
                    {ib && (
                      <tr><td></td><td colSpan={7} className="mono" style={{ padding: '0 4px 6px', fontSize: 11.5, color: '#8b949e' }}>
                        {isFilled
                          ? <>Achieved {px.toFixed(2)} {side} = <b style={{ color: pnlColor(rowPct) }}>{rowPct >= 0 ? '+' : '−'}{Math.abs(rowPct).toFixed(0)}%</b> on entry {Math.abs(pos.ncd).toFixed(2)}</>
                          : <span title={OFFSET_TIP} style={{ cursor: 'help' }}>TWS: {pos.isCredit ? 'BUY' : 'SELL'} LMT {p.toFixed(2)} · offset {(pos.isCredit ? Math.abs(pos.ncd) - p : p - Math.abs(pos.ncd)).toFixed(2)}</span>}
                      </td></tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginTop: 10, alignItems: 'end' }}>
            <div>
              <label style={lbl}>Stop (loss as % of entry)</label>
              <input type="number" step="25" value={stopPct} placeholder={pos.isCredit ? 'e.g. 100' : 'e.g. 50'} title={pos.isCredit ? '100 = buy back at 2x the credit' : '50 = sell at half what you paid'} onChange={e => setStopPct(e.target.value)} style={inp} />
            </div>
            <div className="mono" style={{ fontSize: 12.5, color: stopPrice != null ? '#f85149' : '#8b949e' }}>
              {/* The stop's $ is the one every screen quotes (before commission, open
                  contracts — utils/positionLines.stopOf); fees shown beside it. It said
                  −$2,021 here while the board and check-up said −$1,995. (Oct 2026.) */}
              {stopPrice != null ? <>Stop LMT {stopPrice.toFixed(2)} {side} ({(pnlPct(pos, stopPrice) ?? 0).toFixed(0)}%) · {fmt$(pnlAt(pos, stopPrice, pos.qtyOpen))} on {pos.qtyOpen}
                <span style={{ color: '#8b949e' }}> · {fmt$(pnlAt(pos, stopPrice, pos.qtyOpen) - rtFees(pos.qtyOpen))} after comm</span></> : 'No stop set'}
            </div>
            <div>
              <label style={lbl}>Close date</label>
              <input type="date" value={closeDate} onChange={e => setCloseDate(e.target.value)} style={inp} />
            </div>
          </div>

          <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: '#0d1117', border: `1px solid ${overAllocated ? '#da3633' : '#21262d'}`, display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 13 }}>
            <span>Allocated <b className="mono" style={{ color: overAllocated ? '#f85149' : '#e6edf3' }}>{allocated} / {pos.qtyOpen}</b></span>
            <span>If all fill <b className="mono" style={{ color: pnlColor(planNet) }}>{fmt$(planNet)}</b></span>
            <span>Recording now <b className="mono" style={{ color: pnlColor(filledNet) }}>{filled.length} tranche{filled.length !== 1 ? 's' : ''} · {fmt$(filledNet)}</b>
              {filledAvgPct != null && <b className="mono" style={{ color: pnlColor(filledAvgPct) }}> ({filledAvgPct >= 0 ? '+' : '−'}{Math.abs(filledAvgPct).toFixed(0)}% avg)</b>}</span>
            {overAllocated && <span style={{ color: '#f85149' }}>More contracts than are open.</span>}
          </div>

          {fills && (
            <div style={{ marginTop: 8, padding: 8, borderRadius: 6, background: '#0d1117', border: '1px solid #21262d', fontSize: 12.5 }}>
              {fills.length === 0 ? <span style={{ color: '#a8b2be' }}>No {pos.underlying} fills today.</span> : fills.map((f, i) => (
                <div key={i} className="mono" style={{ color: '#c9d1d9' }}>
                  <span style={{ color: f.side === 'BOT' ? '#3fb950' : '#f85149' }}>{f.side}</span> {f.qty}x {f.strike}{f.right} @{f.price?.toFixed(2)}
                  {f.realizedPnl && f.realizedPnl < 1e300 ? <span style={{ color: pnlColor(f.realizedPnl) }}> {fmt$(f.realizedPnl)}</span> : null}
                </div>
              ))}
            </div>
          )}
        </>)}

        {tab === 'roll' && (<>
          <RollAdvice check={check} oldStrikes={oldStrikes}
            onUse={(from, to) => setRoll(r => ({ ...r, strikes: r.strikes.map((s0, i) => { const j = from.indexOf(oldStrikes[i]); return j >= 0 ? String(to[j]) : s0; }) }))} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
            <div><label style={lbl}>Contracts to roll</label>
              <input type="number" min="1" max={pos.qtyOpen} value={roll.qty} onChange={e => setRoll(r => ({ ...r, qty: e.target.value }))} style={inp} /></div>
            <div><label style={lbl}>{partial ? `Close moved legs @ (${side})` : `Close old @ (${side})`}</label>
              <input type="number" step={tick} value={roll.closeAt} onChange={e => setRoll(r => ({ ...r, closeAt: e.target.value }))} style={inp} /></div>
            <div><label style={lbl}>{partial ? 'Open new legs @' : 'Open new @'}</label>
              <div style={{ display: 'flex', gap: 4 }}>
                <input type="number" step={tick} value={roll.openAt} onChange={e => setRoll(r => ({ ...r, openAt: e.target.value }))} style={inp} />
                <select value={roll.openSide} onChange={e => setRoll(r => ({ ...r, openSide: e.target.value }))} style={{ ...inp, width: 56 }}>
                  <option value="cr">cr</option><option value="db">db</option>
                </select>
              </div></div>
            <div><label style={lbl}>New expiry</label>
              <input type="date" value={roll.expiry} onChange={e => setRoll(r => ({ ...r, expiry: e.target.value }))} style={inp} /></div>
          </div>

          <div style={{ marginTop: 12 }}>
            <label style={lbl}>Legs — old → new ({changedLegs} moved)</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {oldStrikes.length === 0 && <span style={{ fontSize: 12.5, color: '#d29922' }}>No strikes on this ticket — type the new legs into the notes.</span>}
              {oldStrikes.map((s, i) => {
                const moved = Number(roll.strikes[i]) !== s;
                return (
                  <div key={i} style={{ background: '#0d1117', border: `1px solid ${moved ? '#d29922' : '#21262d'}`, borderRadius: 6, padding: 6, width: 110 }}>
                    <div className="mono" style={{ fontSize: 11.5, color: '#8b949e' }}>{s} →</div>
                    <input type="number" value={roll.strikes[i]} onChange={e => setRoll(r => { const st = [...r.strikes]; st[i] = e.target.value; return { ...r, strikes: st }; })}
                      style={{ ...inp, color: moved ? '#d29922' : '#e6edf3' }} />
                  </div>
                );
              })}
            </div>
          </div>

          <RollBeforeAfter oldLegs={legsNow} newLegs={changedLegs > 0 ? legsAfter : null} spot={check ? check.spot : null}
            ncdOld={ncdPosNow} ncdNew={ncdPosAfter} />

          <RollOrderPanel pos={pos} roll={roll} oldStrikes={oldStrikes} lots={rq || 1} tick={tick} onShape={setRollShape}
            onLegs={setRollLegs} onPrice={setRollMid}
            onUse={p => setRoll(r => ({ ...r, closeAt: p.closeAt, openAt: p.openAt, openSide: p.openSide }))} />

          {partial && (
            <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: '#0d1117', border: '1px solid #9e6a03' }}>
              <div style={{ fontSize: 12.5, color: '#a8b2be', lineHeight: 1.5, marginBottom: 8 }}>
                Partial roll — enter the two prices above for the <b>moved legs only</b> (what the TWS roll combo traded).
                The {carriedStrikes.join(' / ')} legs carry across, so their entry price goes here: the old ticket then banks only what the moved legs made, and the new ticket starts from the carried legs' entry plus the new credit.
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div style={{ width: 220 }}><label style={lbl}>Carried legs ({carriedStrikes.join('/')}) entry @</label>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <input type="number" step={tick} value={roll.carried} onChange={e => setRoll(r => ({ ...r, carried: e.target.value }))} style={inp} />
                    <select value={roll.carriedSide} onChange={e => setRoll(r => ({ ...r, carriedSide: e.target.value }))} style={{ ...inp, width: 56 }}>
                      <option value="cr">cr</option><option value="db">db</option>
                    </select>
                  </div></div>
                <button onClick={carriedFromBridge} type="button"
                  style={{ padding: '7px 12px', borderRadius: 6, border: '1px solid #30363d', background: 'transparent', color: '#c9d1d9', fontSize: 12.5, cursor: 'pointer' }}>From TWS</button>
              </div>
              {carriedMsg && <div style={{ fontSize: 12, color: '#8b949e', marginTop: 6 }}>{carriedMsg}</div>}
              {!isFinite(carriedAbs) && <div style={{ fontSize: 12, color: '#d29922', marginTop: 6 }}>Needed to record the roll.</div>}
            </div>
          )}

          {rs && (
            <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: '#0d1117', border: '1px solid #21262d', fontSize: 13, lineHeight: 1.7 }}>
              <div>Realised on old ({rq}): <b className="mono" style={{ color: pnlColor(rs.realised) }}>{fmt$(rs.realised - rollFees)}</b> <span style={{ color: '#8b949e' }}>after {fmt$(rollFees, 2)} comm (entry + close)</span></div>
              <div>Net roll: <b className="mono" style={{ color: rs.net >= 0 ? '#3fb950' : '#f85149' }}>{Math.abs(rs.net).toFixed(2)} {rs.net >= 0 ? 'credit' : 'debit'}</b> per share · {fmt$(rs.net * 100 * rq)} on {rq}</div>
              <div className="mono" style={{ color: '#a8b2be' }}>IBKR roll combo: {rs.net >= 0 ? `SELL @ ${rs.net.toFixed(2)}  (or BUY @ −${rs.net.toFixed(2)})` : `BUY @ ${Math.abs(rs.net).toFixed(2)}`}</div>
              <div>Old ticket closes at <b className="mono">{rs.closeFull.toFixed(2)} {side}</b> · new ticket opens at <b className="mono">{Math.abs(rs.openFull).toFixed(2)} {rs.openFull >= 0 ? 'cr' : 'db'}</b>{partial && <span style={{ color: '#8b949e' }}> (moved legs ± carried {Math.abs(carriedNcd).toFixed(2)} {carriedNcd >= 0 ? 'cr' : 'db'})</span>}</div>
              <div>Cumulative basis after roll: <b className="mono">{Math.abs(rs.cumulative).toFixed(2)} {rs.cumulative >= 0 ? 'cr' : 'db'}</b> <span style={{ color: '#8b949e' }}>({priorBasis != null ? `${Math.abs(priorBasis).toFixed(2)} ${priorBasis >= 0 ? 'cr' : 'db'} across earlier rolls` : `entry ${Math.abs(pos.ncd || 0).toFixed(2)} ${pos.isCredit ? 'cr' : 'db'}`} ± this roll)</span></div>
              {rq < pos.qtyOpen && <div style={{ color: '#d29922' }}>{pos.qtyOpen - rq} contract{pos.qtyOpen - rq > 1 ? 's' : ''} stay on the old legs.</div>}
            </div>
          )}
          <div style={{ marginTop: 10, width: 200 }}>
            <label style={lbl}>Roll date</label>
            <input type="date" value={closeDate} onChange={e => setCloseDate(e.target.value)} style={inp} />
          </div>
        </>)}

        <div style={{ marginTop: 10 }}>
          <label style={lbl}>Notes</label>
          <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder={tab === 'roll' ? 'Why roll? Tested side, delta, days left…' : 'Why this exit?'}
            style={{ ...inp, fontFamily: 'inherit', resize: 'vertical' }} />
        </div>

        <TicketHelp kind="sell" />

        {msg && <div style={{ marginTop: 8, fontSize: 12.5, color: msg.err ? '#f85149' : '#3fb950' }}>{msg.text}</div>}

        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          {tab === 'close' ? (<>
            <button onClick={recordFills} disabled={busy || !filled.length || overAllocated || noEntry}
              style={{ flex: 1, padding: '9px 16px', borderRadius: 8, border: 'none', fontWeight: 700, fontSize: 13, cursor: 'pointer', background: '#da3633', color: '#fff', opacity: busy || !filled.length || overAllocated || noEntry ? 0.45 : 1 }}>
              {busy ? 'Recording…'
                : expired ? (isFinite(rowFill(rows[0] || {})) ? `Record expiry · ${pos.qtyOpen} contract${pos.qtyOpen !== 1 ? 's' : ''} · ${fmt$(filledNet)}` : 'Enter the settlement value to record the expiry')
                : filled.length ? `Record ${filled.reduce((a, r) => a + Number(r.qty), 0)} filled of ${pos.qtyOpen} · ${fmt$(filledNet)}` : 'Mark a tranche Filled to record it'}
            </button>
            <button onClick={() => { persistPlan(rows.filter(r => r.status !== 'Filled'), pos.qtyOpen); setMsg({ text: 'Plan saved — it reopens with this ticket.' }); }}
              style={{ padding: '9px 14px', borderRadius: 8, border: '1px solid #30363d', background: 'transparent', color: '#c9d1d9', fontSize: 13, cursor: 'pointer' }}>Save plan</button>
          </>) : (
            <button onClick={recordRoll} disabled={busy || !rs || rq <= 0 || noEntry}
              style={{ flex: 1, padding: '9px 16px', borderRadius: 8, border: 'none', fontWeight: 700, fontSize: 13, cursor: 'pointer', background: '#9e6a03', color: '#fff', opacity: busy || !rs || rq <= 0 || noEntry ? 0.45 : 1 }}>
              {busy ? 'Rolling…' : rs ? `Roll ${rq} · bank ${fmt$(rs.realised - rollFees)} · new ticket ${Math.abs(rs.openFull).toFixed(2)} ${rs.openFull >= 0 ? 'cr' : 'db'}` : partial && !isFinite(carriedAbs) ? 'Enter the carried legs’ entry price' : 'Enter close and open prices'}
            </button>
          )}
          <button onClick={onClose} style={{ padding: '9px 14px', borderRadius: 8, border: '1px solid #30363d', background: 'transparent', color: '#a8b2be', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// What the check-up says about rolling this position, at the top of the Roll tab:
// its verdict and next step — "don't roll again" included — and, when it found a
// roll, the strikes and the net, with a button that puts them in the legs below.
function RollAdvice({ check, oldStrikes, onUse }) {
  const rv = check && check.review;
  if (!rv || rv.action === 'unknown') {
    return (
      <details style={{ fontSize: 12.5, color: '#a8b2be', marginBottom: 10 }}>
        <summary style={{ cursor: 'pointer', color: '#58a6ff' }}>How a roll is recorded</summary>
        <div style={{ marginTop: 6, lineHeight: 1.5 }}>One combo in TWS, two records here: the old ticket banks its P&amp;L on the rolled contracts, and the new legs open as a new ticket linked back to it. Change only the strikes that move — untested legs carry across, and their entry price is asked for so each ticket keeps only its own P&amp;L.</div>
      </details>
    );
  }
  const col = { green: '#3fb950', amber: '#e3b341', red: '#f85149' }[rv.tone] || '#a8b2be';
  const isRoll = /^roll/.test(rv.action);
  const r = check.roll;
  const sh = (rv.metrics && rv.metrics.shorts) || [];
  const oldShort = r ? sh.find(x => !x.tested && x.right === r.right) : null;
  const wing = r && oldShort && check.legs ? check.legs.filter(l => l.qty > 0 && l.right === r.right)
    .sort((a, b) => Math.abs(a.strike - oldShort.strike) - Math.abs(b.strike - oldShort.strike))[0] : null;
  const canUse = r && oldShort && wing && oldStrikes.includes(Number(oldShort.strike)) && oldStrikes.includes(Number(wing.strike));
  return (
    <div data-testid="roll-advice" style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 8, background: col + '14', border: `1px solid ${col}66` }}>
      <div style={{ fontSize: 13.5, fontWeight: 700, color: col }}>{isRoll ? '↻ ' : '⚠ '}Check-up: {rv.headline}</div>
      {rv.steps && rv.steps[0] && <div style={{ fontSize: 12.5, color: '#c9d1d9', marginTop: 4 }}>→ {rv.steps[0]}</div>}
      {r && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap', fontSize: 13 }}>
          <span>Suggested: {r.right === 'C' ? 'calls' : 'puts'} <b className="mono">{oldShort ? `${oldShort.strike}/${wing ? wing.strike : '?'} → ` : ''}{r.shortStrike}/{r.longStrike}</b>
            {r.net != null && <> for about <b className="mono" style={{ color: r.net >= 0 ? '#3fb950' : '#f85149' }}>{r.net >= 0 ? '+' : ''}{r.net.toFixed(2)}</b></>}</span>
          {canUse && <button data-testid="roll-use-suggested" onClick={() => onUse([Number(oldShort.strike), Number(wing.strike)], [r.shortStrike, r.longStrike])}
            style={{ fontSize: 12.5, padding: '4px 10px', borderRadius: 6, border: '1px solid #9e6a03', color: '#d29922', background: 'transparent', cursor: 'pointer' }}>Use these strikes</button>}
        </div>
      )}
    </div>
  );
}
