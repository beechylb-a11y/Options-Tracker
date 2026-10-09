import React, { useState, useEffect, useMemo } from 'react';
import { api } from '../utils/api';
import { comboTranches, matchTranches, fillPayload, manualFillPayload, ticketSide, positionForTicket } from '../utils/fillMatch';
import { fillStats } from '../engine/fills';

// Reconcile working orders against what TWS actually filled.
//
// WHY THIS EXISTS. A 45DTE four-leg order rests, and with size it comes back in
// pieces at different prices. Reading those prices off a TWS screen and typing a
// per-contract net is the arithmetic that goes wrong at 11pm, so the bridge's
// executions are grouped back into the combo that was sent and offered for
// confirmation. Nothing is written until the button is pressed: the matching is a
// suggestion, and a wrong fill price is worse than no fill price. (Oct 2026.)
//
// props: positions (open-positions rows), account, onClose, onDone
const CELL = { padding: '6px 8px', fontSize: 12.5 };
const inp = {
  padding: '4px 6px', borderRadius: 5, border: '1px solid #30363d', background: '#0d1117',
  color: '#e6edf3', fontSize: 12.5, fontFamily: 'JetBrains Mono,monospace', outline: 'none', width: 72,
};

const n = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
const money = v => (v >= 0 ? '+$' : '−$') + Math.abs(v).toFixed(0);

export default function FillReconcile({ positions, account, onClose, onDone }) {
  const [phase, setPhase] = useState('pull');        // pull | review | writing | done
  const [err, setErr] = useState(null);
  const [tranches, setTranches] = useState([]);
  const [seen, setSeen] = useState([]);
  const [history, setHistory] = useState(null);
  // { [trancheKey]: { ref, qty, price } } — what the user has confirmed, keyed by
  // tranche so one TWS fill can never be written against two tickets at once.
  const [pick, setPick] = useState({});
  const [result, setResult] = useState(null);
  // Fills typed by hand, per ticket: { [ticketRef]: { qty, price, side, date, time } }.
  const [manual, setManual] = useState({});
  // How many executions TWS sent back, and the positions it holds — so an empty
  // screen can say why, and a fill from an earlier session can come off the position.
  const [execCount, setExecCount] = useState(null);
  const [twsStructures, setTwsStructures] = useState([]);

  // Only tickets that are still waiting on contracts can take an entry fill. A
  // fully filled position has nothing to reconcile, and offering it invites a
  // duplicate entry nobody would notice until the P&L was wrong.
  const waiting = useMemo(() => (positions || []).filter(p => {
    const qty = n(p.qty) || 0;
    const filled = p.qtyFilled === '' || p.qtyFilled == null ? null : n(p.qtyFilled);
    return filled != null && filled < qty;
  }), [positions]);

  useEffect(() => { pull(); /* eslint-disable-next-line */ }, []);

  async function pull() {
    setPhase('pull'); setErr(null);
    let bridgeUrl = '';
    try { bridgeUrl = localStorage.getItem('bridgeUrl') || ''; } catch (e) { /* private mode */ }
    if (!bridgeUrl) { setErr('Set the IBKR Bridge URL in Settings first — reconciling needs the TWS executions.'); setPhase('review'); return; }
    try {
      // all=1: everything TWS still holds, not just "today" by some clock (Oct 2026).
      const r = await fetch(bridgeUrl + '/api/executions?all=1', { headers: { 'ngrok-skip-browser-warning': '1' } });
      const txt = await r.text();
      let data;
      try { data = JSON.parse(txt); } catch (e) { throw new Error('the bridge returned a web page, not JSON — check the URL and that the bridge is running'); }
      if (!r.ok) throw new Error(data.error || `bridge ${r.status}`);
      setTranches(comboTranches(data.fills || []));
      setExecCount((data.fills || []).length);
      // Best effort: the positions, for fills TWS no longer lists.
      fetch(bridgeUrl + '/api/positions', { headers: { 'ngrok-skip-browser-warning': '1' } })
        .then(x => x.json()).then(d => setTwsStructures(Array.isArray(d && d.structures) ? d.structures : []))
        .catch(() => setTwsStructures([]));
      // Fills already recorded, so a second run shows them as done rather than
      // offering them again.
      const existing = await api.getFills(account).catch(() => []);
      setSeen((existing || []).map(f => f['Fill ID']).filter(Boolean));
      setHistory(fillStats((positions || []).map(p => ({
        qty: p.qty, qtyFilled: p.qtyFilled, limitPrice: p.limitPrice,
        slippageVsMid: p.entrySlippage,
      }))));
      setPhase('review');
    } catch (e) {
      setErr(e.message || 'the bridge did not answer');
      setPhase('review');
    }
  }

  const matched = useMemo(() => matchTranches(waiting, tranches, seen), [waiting, tranches, seen]);

  const chosen = Object.entries(pick).filter(([, v]) => v && v.ref);
  // A hand entry counts once it has a quantity inside what is still resting and a price.
  const outstandingOf = ref => { const r = matched.rows.find(x => String(x.ticket.ticketRef) === String(ref)); return r ? r.outstanding : 0; };
  const manualReady = Object.entries(manual).filter(([ref, m]) => {
    const q = n(m.qty), p = n(m.price);
    return q > 0 && q <= outstandingOf(ref) && p != null && Math.abs(p) > 0;
  });
  const nWrite = chosen.length + manualReady.length;
  const openManual = t => setManual(m => ({ ...m, [t.ticketRef]: m[t.ticketRef] || {
    qty: String(outstandingOf(t.ticketRef) || ''), price: t.limitPrice !== '' && t.limitPrice != null ? String(Math.abs(n(t.limitPrice)) || '') : '',
    side: ticketSide(t), date: new Date().toISOString().slice(0, 10), time: '' } }));
  const editManual = (ref, patch) => setManual(m => ({ ...m, [ref]: { ...m[ref], ...patch } }));
  const dropManual = ref => setManual(m => { const x = { ...m }; delete x[ref]; return x; });

  async function write() {
    setPhase('writing');
    const wrote = [], failed = [];
    for (const [key, v] of chosen) {
      const tr = tranches.find(t => t.key === key);
      const ticket = waiting.find(p => String(p.ticketRef) === String(v.ref));
      if (!tr || !ticket) continue;
      try {
        const res = await api.addFill(fillPayload(ticket, tr, { qty: v.qty, price: v.price }));
        wrote.push({ key, ref: v.ref, qty: res.qtyFilledTotal, remaining: res.qtyRemaining });
      } catch (e) {
        failed.push({ key, ref: v.ref, error: /already recorded/i.test(e.message) ? 'already recorded' : e.message });
      }
    }
    for (const [ref, m] of manualReady) {
      const ticket = waiting.find(p => String(p.ticketRef) === String(ref));
      const payload = ticket ? manualFillPayload(ticket, m) : null;
      if (!payload) continue;
      try {
        const res = await api.addFill(payload);
        wrote.push({ key: 'manual-' + ref, ref, qty: res.qtyFilledTotal, remaining: res.qtyRemaining, manual: true });
      } catch (e) {
        failed.push({ key: 'manual-' + ref, ref, error: e.message });
      }
    }
    setResult({ wrote, failed });
    setPhase('done');
    if (wrote.length && onDone) onDone();
  }

  const toggle = (tr, ref) => setPick(p => {
    const next = { ...p };
    if (next[tr.key] && next[tr.key].ref === ref) delete next[tr.key];
    else next[tr.key] = { ref, qty: String(tr.lots), price: String(tr.netPrice) };
    return next;
  });
  const edit = (key, patch) => setPick(p => (p[key] ? { ...p, [key]: { ...p[key], ...patch } } : p));

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 12, padding: 20, width: 860, maxWidth: '96vw', maxHeight: '92vh', overflow: 'auto' }} onClick={e => e.stopPropagation()}>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#e6edf3' }}>Reconcile entry fills</div>
            <div style={{ fontSize: 12.5, color: '#a8b2be', marginTop: 4 }}>
              TWS executions (all it still holds — usually the current session), grouped back into the combos that were sent. Tick what belongs to which ticket, or enter a fill by hand if it filled another day — nothing is written until you confirm.
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#a8b2be', cursor: 'pointer', fontSize: 18 }}>×</button>
        </div>

        {phase === 'pull' && <div style={{ color: '#a8b2be', fontSize: 13 }}>Asking TWS for its executions…</div>}

        {err && (
          <div style={{ background: '#2d0f11', border: '1px solid #6e2427', borderRadius: 8, padding: '8px 12px', color: '#f85149', fontSize: 12.5, marginBottom: 12 }}>
            {err}
          </div>
        )}

        {phase === 'done' && result && (
          <div style={{ fontSize: 13, color: '#e6edf3' }}>
            <div style={{ background: '#0d2818', border: '1px solid #238636', borderRadius: 8, padding: '10px 12px', marginBottom: 10 }}>
              {result.wrote.length
                ? `${result.wrote.length} fill${result.wrote.length === 1 ? '' : 's'} recorded.`
                : 'Nothing was written.'}
              {result.wrote.map(w => (
                <div key={w.key} className="mono" style={{ fontSize: 12.5, color: '#a8b2be', marginTop: 4 }}>
                  ticket {w.ref} — {w.qty} filled{w.remaining !== '' && w.remaining != null ? `, ${w.remaining} still resting` : ''}{w.manual ? ' (by hand)' : ''}
                </div>
              ))}
            </div>
            {result.failed.length > 0 && (
              <div style={{ background: '#1f1a0d', border: '1px solid #9e6a03', borderRadius: 8, padding: '10px 12px', color: '#d29922', fontSize: 12.5 }}>
                {result.failed.map(f => <div key={f.key}>ticket {f.ref}: {f.error}</div>)}
              </div>
            )}
            <button onClick={onClose} style={{ marginTop: 12, padding: '8px 16px', borderRadius: 8, border: 'none', background: '#238636', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Done</button>
          </div>
        )}

        {(phase === 'review' || phase === 'writing') && (
          <>
            {!waiting.length ? (
              <div style={{ color: '#a8b2be', fontSize: 13 }}>
                No ticket is waiting on contracts. Entry fills are only tracked for orders logged as working —
                tick <b>Order sent, not filled yet</b> on the engine's log button when you rest a limit.
              </div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <tbody>
                  {matched.rows.map(({ ticket, outstanding, candidates }) => (
                    <React.Fragment key={ticket.ticketRef}>
                      <tr style={{ borderTop: '1px solid #21262d' }}>
                        <td colSpan={7} style={{ ...CELL, paddingTop: 12 }}>
                          <b style={{ color: '#e6edf3', fontSize: 13.5 }}>{ticket.underlying}</b>
                          <span style={{ color: '#a8b2be' }}> {ticket.strategy} · ticket {ticket.ticketRef}</span>
                          <span className="mono" style={{ color: '#8b949e', marginLeft: 8 }}>
                            {ticket.legs} · {outstanding} of {ticket.qty} still resting
                            {ticket.limitPrice !== '' && ticket.limitPrice != null && ` · asked ${ticket.limitPrice}`}
                          </span>
                        </td>
                      </tr>
                      {!candidates.length && (
                        <tr><td colSpan={7} style={{ ...CELL, color: '#8b949e' }}>
                          {execCount === 0
                            ? 'TWS returned no executions — it keeps only the current session\'s, so an earlier fill has to come from the position or by hand.'
                            : `Nothing in the ${execCount ?? ''} executions TWS returned matches these strikes.`}
                        </td></tr>
                      )}
                      {(() => {
                        // The position TWS holds at these strikes, offered as the fill when
                        // no execution matches in full (Oct 2026).
                        if (candidates.some(c => c.match === 'full') || manual[ticket.ticketRef]) return null;
                        const pos = positionForTicket(ticket, twsStructures);
                        if (!pos) return null;
                        const q = Math.min(pos.qty, outstanding);
                        return (
                          <tr><td colSpan={7} style={{ ...CELL, paddingTop: 2 }}>
                            <div data-testid="position-offer" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '8px 10px',
                              borderRadius: 8, background: '#0f2417', border: '1px solid #23863655', fontSize: 12.5, color: '#c9d1d9' }}>
                              <span>
                                TWS holds <b className="mono">{pos.qty}</b> at these strikes{pos.expiry ? ` (${pos.expiry})` : ''}, average{' '}
                                <b className="mono">{pos.price.toFixed(2)} {pos.side === 'cr' ? 'credit' : 'debit'}</b>
                                <span style={{ color: '#8b949e' }}> — IB's average cost, commission included</span>
                              </span>
                              <button type="button" data-testid="position-use" disabled={phase === 'writing' || !(q > 0)}
                                onClick={() => setManual(m => ({ ...m, [ticket.ticketRef]: { qty: String(q), price: String(pos.price), side: pos.side,
                                  date: new Date().toISOString().slice(0, 10), time: '', notes: 'From the TWS position (IB average cost, commission included)' } }))}
                                style={{ padding: '3px 10px', borderRadius: 6, border: '1px solid #238636', background: '#23863622', color: '#3fb950', fontSize: 12.5, cursor: 'pointer' }}>
                                Use as the fill
                              </button>
                              <span style={{ flexBasis: '100%', fontSize: 12, color: '#8b949e' }}>Fills the entry below for you to check — set the date it filled; nothing is written until you confirm.</span>
                            </div>
                          </td></tr>
                        );
                      })()}
                      {/* By hand (Oct 2026): TWS only reports today's executions, so an
                          order that filled on another day, or away from TWS, is typed here. */}
                      <tr><td colSpan={7} style={{ ...CELL, paddingTop: 2 }}>
                        {!manual[ticket.ticketRef] ? (
                          <button type="button" data-testid="manual-open" onClick={() => openManual(ticket)} disabled={phase === 'writing'}
                            style={{ padding: 0, border: 'none', background: 'none', color: '#58a6ff', fontSize: 12.5, textDecoration: 'underline', cursor: 'pointer' }}>
                            Enter a fill by hand
                          </button>
                        ) : (() => {
                          const m = manual[ticket.ticketRef];
                          const q = n(m.qty), over = q > outstanding;
                          const pill = on => ({ padding: '3px 8px', borderRadius: 5, fontSize: 12, cursor: 'pointer',
                            border: `1px solid ${on ? '#58a6ff' : '#30363d'}`, background: on ? '#58a6ff22' : 'transparent', color: on ? '#e6edf3' : '#a8b2be' });
                          return (
                            <div data-testid="manual-row" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '8px 10px',
                              borderRadius: 8, background: '#0d1a2e', border: '1px solid #1f6feb55' }}>
                              <span style={{ color: '#a8b2be', fontSize: 12.5 }}>By hand:</span>
                              <input style={{ ...inp, width: 52 }} value={m.qty} onChange={e => editManual(ticket.ticketRef, { qty: e.target.value })} aria-label="Contracts filled (by hand)" />
                              <span style={{ color: '#8b949e', fontSize: 12.5 }}>ct @</span>
                              <input style={inp} value={m.price} onChange={e => editManual(ticket.ticketRef, { price: e.target.value })} aria-label="Fill price per contract (by hand)" placeholder="5.75" />
                              <button type="button" style={pill(m.side === 'cr')} onClick={() => editManual(ticket.ticketRef, { side: 'cr' })}>credit</button>
                              <button type="button" style={pill(m.side === 'db')} onClick={() => editManual(ticket.ticketRef, { side: 'db' })}>debit</button>
                              <input type="date" style={{ ...inp, width: 130 }} value={m.date} onChange={e => editManual(ticket.ticketRef, { date: e.target.value })} aria-label="Fill date" />
                              <input style={{ ...inp, width: 64 }} value={m.time} onChange={e => editManual(ticket.ticketRef, { time: e.target.value })} aria-label="Fill time (optional)" placeholder="hh:mm" />
                              <button type="button" onClick={() => dropManual(ticket.ticketRef)}
                                style={{ padding: 0, border: 'none', background: 'none', color: '#8b949e', fontSize: 12.5, cursor: 'pointer' }}>remove</button>
                              <span style={{ flexBasis: '100%', fontSize: 12, color: over ? '#d29922' : '#8b949e' }}>
                                {over ? `Only ${outstanding} still resting on this ticket.`
                                  : 'Net per contract for the whole combo, as TWS shows it. Time is optional. Saved as typed by hand.'}
                              </span>
                            </div>
                          );
                        })()}
                      </td></tr>
                      {candidates.map(c => {
                        const sel = pick[c.key];
                        const mine = sel && String(sel.ref) === String(ticket.ticketRef);
                        const takenElsewhere = sel && !mine;
                        return (
                          <tr key={ticket.ticketRef + c.key} style={{ background: mine ? '#0d1a2e' : 'transparent', opacity: c.recorded || takenElsewhere ? 0.45 : 1 }}>
                            <td style={{ ...CELL, width: 28 }}>
                              <input type="checkbox" checked={!!mine} disabled={c.recorded || takenElsewhere || phase === 'writing'}
                                onChange={() => toggle(c, ticket.ticketRef)}
                                title={c.recorded ? 'Already in the Fills table' : takenElsewhere ? 'Already assigned to another ticket above' : 'Record this fill against this ticket'} />
                            </td>
                            <td style={{ ...CELL, color: '#a8b2be', whiteSpace: 'nowrap' }} className="mono">
                              {c.time || c.date || '—'}
                            </td>
                            <td style={{ ...CELL, color: '#8b949e' }} className="mono">
                              {c.legs.map(l => `${l.side === 'SLD' ? '−' : '+'}${l.qty} ${l.strike}${l.right}`).join(' / ')}
                            </td>
                            <td style={{ ...CELL, textAlign: 'right' }} className="mono">
                              {mine
                                ? <input style={inp} value={sel.qty} onChange={e => edit(c.key, { qty: e.target.value })} aria-label="Contracts filled" />
                                : <>{c.lots}</>}
                            </td>
                            <td style={{ ...CELL, textAlign: 'right' }} className="mono">
                              {mine
                                ? <input style={inp} value={sel.price} onChange={e => edit(c.key, { price: e.target.value })} aria-label="Fill price" />
                                : <span style={{ color: c.netPrice >= 0 ? '#3fb950' : '#f85149' }}>{c.netPrice.toFixed(2)}</span>}
                            </td>
                            <td style={{ ...CELL, textAlign: 'right', color: '#a8b2be' }} className="mono">
                              {c.vsLimit == null ? '—'
                                : <span title="Ask minus got, signed so worse is always less money to you"
                                  style={{ color: c.vsLimit > 0.004 ? '#d29922' : c.vsLimit < -0.004 ? '#3fb950' : '#a8b2be' }}>
                                  {c.vsLimit > 0 ? '+' : ''}{c.vsLimit.toFixed(2)}
                                </span>}
                            </td>
                            <td style={{ ...CELL, color: '#8b949e' }}>
                              {c.recorded ? 'recorded'
                                : c.overOutstanding ? <span style={{ color: '#d29922' }}>more than this ticket is waiting on</span>
                                : c.match === 'partial' ? 'some strikes only'
                                : ''}
                              {c.fees > 0 && <span className="mono"> · ${c.fees.toFixed(2)} fees</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            )}

            {matched.unmatched.length > 0 && (
              <div style={{ marginTop: 14, borderTop: '1px solid #21262d', paddingTop: 10 }}>
                <div style={{ fontSize: 12.5, color: '#a8b2be', marginBottom: 4 }}>
                  TWS filled these and no working ticket wanted them — a close, or an entry logged nowhere.
                </div>
                {matched.unmatched.map(t => (
                  <div key={t.key} className="mono" style={{ fontSize: 12, color: '#8b949e' }}>
                    {t.time} {t.underlying} {t.strikes.join('/')} · {t.lots} @ {t.netPrice.toFixed(2)}
                  </div>
                ))}
              </div>
            )}

            {history && history.worked > 0 && (
              <div style={{ marginTop: 14, borderTop: '1px solid #21262d', paddingTop: 10, fontSize: 12.5, color: '#a8b2be' }}>
                <b style={{ color: '#e6edf3' }}>Resting at mid, so far</b>{' '}
                {history.filled} of {history.worked} worked order{history.worked === 1 ? '' : 's'} filled
                {history.avgSlippage != null && ` · average ${history.avgSlippage > 0 ? '' : '+'}${(-history.avgSlippage).toFixed(3)} against the mid`}
                {history.totalSlippageDollars !== 0 && ` · ${money(-history.totalSlippageDollars)} to the spread`}
              </div>
            )}

            <div style={{ marginTop: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
              <button onClick={write} disabled={!nWrite || phase === 'writing'} data-testid="record-fills"
                style={{
                  padding: '9px 16px', borderRadius: 8, border: 'none', fontSize: 13.5, fontWeight: 700,
                  background: nWrite ? '#238636' : '#1c2128', color: nWrite ? '#fff' : '#8b949e',
                  cursor: nWrite && phase !== 'writing' ? 'pointer' : 'default',
                }}>
                {phase === 'writing' ? 'Recording…'
                  : nWrite ? `Record ${nWrite} fill${nWrite === 1 ? '' : 's'}` : 'Record fills'}
              </button>
              <button onClick={pull} disabled={phase === 'writing'}
                style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #30363d', background: 'transparent', color: '#a8b2be', fontSize: 13, cursor: 'pointer' }}>
                Pull again
              </button>
              <span style={{ fontSize: 12, color: '#8b949e' }}>
                Times are as TWS reported them.
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
