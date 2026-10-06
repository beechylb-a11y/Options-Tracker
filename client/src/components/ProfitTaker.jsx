import React, { useState, useEffect, useMemo } from 'react';
import {
  normalisePosition, targetToPrice, priceToTarget, pnlAt, ladder, snap, defaultTick,
  round2, stopToPrice, maxTargetPct, pnlPct, ruleLadderPcts
} from '../utils/ticketMath';
import { exitRuleFor, STOP_LOSS_PCT } from '../engine/data';
import TicketHelp from './TicketHelp';
import { unitsFromLegs, DEFAULT_COMMISSION } from '../utils/commission';

// BUY ticket — the profit taker to attach in TWS before you transmit.
//
// Sep 2026 rework, after using it on a 0DTE fly:
//   * Contracts are the engine's Kelly size, stated as such.
//   * ONE target by default. Scaling out in tranches is an option, not the layout.
//   * 0DTE targets are % RETURN ON ENTRY: bought at 0.64, +50% = sell at 0.96. That
//     is how 0DTE P&L is thought about, and it is exactly what a TWS percentage
//     profit-taker preset computes, so the two can never disagree.
//   * 45DTE targets stay % of MAX PROFIT (manage winners at 50%). For credit trades
//     that is the same number as % on entry; only debit structures differ, and the
//     ticket says so in plain words instead of an "offset = 130% of entry" line.
//
// props: ncd (per-share, + credit / − debit), win (max profit $/contract),
//        contracts (Kelly), underlying, legs, engine ('0DTE'|'45DTE'), onPlan(plan)
const cell = { padding: '5px 6px', borderRadius: 6, border: '1px solid #30363d', background: '#0d1117',
  color: '#e6edf3', fontSize: 13, fontFamily: 'JetBrains Mono,monospace', outline: 'none', width: '100%' };

const money = x => (x >= 0 ? '+$' : '−$') + Math.abs(x).toFixed(0);
const pctStr = x => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(0) + '%';

export default function ProfitTaker({ ncd, win, contracts, underlying, legs, onPlan, engine = '0DTE', commRate, strategy,
  tastyFly = null, onTastyFly, closeDte: closeDteIn = null, onCloseDte }) {
  const is0 = !/45/.test(engine);
  // Per-strategy target and basis (Oct 2026): tastylive's numbers, not one 50% for all.
  // tastyFly (0DTE long flies only; null = not offered): switch to tastylive's
  // 25–50% of MAX PROFIT instead of the % return on the debit.
  const baseRule = exitRuleFor(engine, strategy);
  const rule = tastyFly ? { ...baseRule, basis: 'max', target: 25, chips: [25, 35, 50],
    why: 'tastylive long-fly guidance: 25–50% of max profit' } : baseRule;
  const qty = Math.max(1, Number(contracts) || 1);
  const pos = useMemo(() => normalisePosition({
    qty, qtyOpen: qty, entryPrice: ncd, maxProfit: win > 0 ? win * qty : '', underlying,
    basis: rule.basis
  }), [ncd, win, qty, underlying, rule.basis]);
  const tick = defaultTick(underlying);
  // Contracts per unit, "x2" bodies counted twice (a fly is 4). The rate is the
  // account's (Settings); the box below overrides it for this ticket only.
  const perUnit = unitsFromLegs(legs) || 1;
  const [comm, setComm] = useState(() => commRate ?? DEFAULT_COMMISSION);
  useEffect(() => { if (commRate != null) setComm(commRate); }, [commRate]);
  const roundTrip = q => round2(q * perUnit * (Number(comm) || 0) * 2);

  const entry = Math.abs(pos.ncd || 0);
  const capPct = maxTargetPct(pos);            // e.g. 517% for a 0.64 fly with 3.31 max
  const chips = rule.chips || (is0 ? (pos.isCredit ? [25, 50, 75] : [25, 50, 75, 100, 150, 200]) : [25, 50, 75]);
  const ladderPcts = ruleLadderPcts(rule, [25, 50, 100]);

  const [target, setTarget] = useState({ pct: rule.target, price: '' });
  const [split, setSplit] = useState(false);
  const [rows, setRows] = useState(() => ladder(qty, ladderPcts));
  // Switching structure moves the default target with it.
  useEffect(() => {
    setTarget({ pct: rule.target, price: '' });
    setRows(ladder(qty, ladderPcts));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategy, engine, tastyFly]);
  // The stop starts at the 100%-of-premium guide; clear it for no stop.
  const [stopPct, setStopPct] = useState(String(STOP_LOSS_PCT));
  useEffect(() => { setRows(rs => ladder(qty, rs.length ? rs.map(r => r.pct) : [25, 50, 100])); }, [qty]);

  const priceOf = pct => snap(targetToPrice(pos, Number(pct) || 0), tick);
  const tPrice = target.price !== '' && isFinite(parseFloat(target.price)) ? parseFloat(target.price) : priceOf(target.pct);
  const effRows = split ? rows : [{ qty, pct: Number(target.pct) || 0 }];
  const stop = stopPct !== '' && isFinite(parseFloat(stopPct)) ? snap(stopToPrice(pos, parseFloat(stopPct)), tick) : null;

  useEffect(() => {
    onPlan && onPlan({ rows: effRows.map(r => ({ qty: Number(r.qty) || 0, pct: Number(r.pct) || 0 })), stopPct: stopPct === '' ? '' : Math.abs(parseFloat(stopPct)),
      basis: pos.basis });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(effRows), stopPct, pos.basis]);

  const closeSide = pos.isCredit ? 'db' : 'cr';
  const basisWord = pos.isCredit ? 'on entry' : pos.basis === 'max' ? 'of max profit' : is0 ? 'on entry' : 'of the debit';
  const allocated = rows.reduce((a, r) => a + (Number(r.qty) || 0), 0);

  // What to type in TWS for a given closing price — in words, one line.
  const twsLine = price => {
    const onEntry = pnlPct(pos, price);
    const off = pos.isCredit ? entry - price : price - entry;   // profit per share = the TWS offset
    const pre = `TWS: ${pos.isCredit ? 'BUY' : 'SELL'} LMT ${price.toFixed(2)}`
      + ` · profit-taker offset ${off >= 0 ? '+' : '−'}${Math.abs(off).toFixed(2)}`;
    if (onEntry == null) return pre;
    return pre + ` · as a TWS % preset: ${onEntry.toFixed(0)}%`;
  };

  const Result = ({ q, pct, price }) => {
    const gross = pnlAt(pos, price, q), net = gross - roundTrip(q);
    const over = capPct != null && Number(pct) > capPct + 0.5;
    return (
      <div className="mono" style={{ fontSize: 12.5, color: '#a8b2be', lineHeight: 1.65, padding: '4px 0 6px' }}>
        <span style={{ color: '#e6edf3', fontWeight: 700 }}>{closeSide === 'cr' ? 'Sell' : 'Buy back'} @ {price.toFixed(2)}</span>
        {' '}= <span style={{ color: '#3fb950', fontWeight: 700 }}>{pctStr(pnlPct(pos, price) ?? 0)}</span> on entry
        {' '}· <span style={{ color: '#3fb950' }}>{money(gross)}</span> on {q}
        {' '}<span style={{ color: net >= 0 ? '#3fb950' : '#f85149' }}>({money(net)} after comm)</span>
        {/* Say where the commission comes from: a butterfly is 4 option contracts per
            unit, charged on the way in AND out, so a 16-lot is 128 contracts. It is
            easy to read $83 off a $256 target as a bug when it is the real cost. */}
        {roundTrip(q) > 0 && (
          <span style={{ color: '#8b949e' }}><br />
            Comm −${roundTrip(q).toFixed(2)} = {q} × {perUnit} contracts × 2 sides × ${Number(comm).toFixed(2)}
            {gross > 0 && <> · <span style={{ color: roundTrip(q) / gross > 0.2 ? '#d29922' : '#8b949e' }}>{(roundTrip(q) / gross * 100).toFixed(0)}% of the profit</span></>}
            {!pos.isCredit && <> · breakeven after comm: {(entry + roundTrip(1) / 100).toFixed(2)}</>}
          </span>
        )}
        {over && <span style={{ color: '#f85149' }}> — beyond max profit ({capPct.toFixed(0)}%), can't fill</span>}
        <br />{twsLine(price)}
        {!pos.isCredit && pos.basis === 'max' && Math.abs((pnlPct(pos, price) ?? 0) - Number(pct)) > 10 && (
          <span style={{ color: '#d29922' }}><br />{is0 ? 'These' : '45DTE'} targets are % of max profit: {pct}% of max = {pctStr(pnlPct(pos, price) ?? 0)} on what you paid. Use the offset in TWS, not {pct}%.</span>
        )}
      </div>
    );
  };

  const btn = on => ({ padding: '3px 10px', borderRadius: 5, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: '1px solid',
    borderColor: on ? '#238636' : '#30363d', background: on ? '#0d2818' : 'transparent', color: on ? '#3fb950' : '#a8b2be' });

  return (
    <div style={{ marginTop: 10, marginBottom: 4, padding: 10, borderRadius: 8, background: '#0d1117', border: '1px solid #21262d' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ background: '#0d2818', color: '#3fb950', borderRadius: 4, padding: '1px 7px', fontSize: 12, fontWeight: 700 }}>BUY</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#e6edf3' }}>Profit taker</span>
        <span className="mono" style={{ fontSize: 12.5, color: '#c9d1d9' }}>
          {qty} ct <span style={{ color: '#8b949e' }}>(Kelly)</span> @ {entry.toFixed(2)} {pos.isCredit ? 'cr' : 'db'}
        </span>
        <span className="mono" style={{ fontSize: 12, color: '#8b949e' }}>
          · max {win > 0 ? `$${win.toFixed(0)}/ct` : '—'}{capPct != null && win > 0 ? ` = ${pctStr(capPct)} ${basisWord}` : ''}
        </span>
      </div>

      {!split ? (<>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#8b949e', marginRight: 2 }}>Target {basisWord}</span>
          {chips.map(p => (
            <button key={p} onClick={() => setTarget({ pct: p, price: '' })} style={btn(Number(target.pct) === p && target.price === '')}>+{p}%</button>
          ))}
          <input type="number" step="5" value={target.pct} style={{ ...cell, width: 64, marginLeft: 6 }} title={`% ${basisWord}`}
            onChange={e => setTarget({ pct: e.target.value, price: '' })} />
          <span style={{ fontSize: 12, color: '#8b949e' }}>% ⇄ LMT</span>
          <input type="number" step={tick} style={{ ...cell, width: 80 }} value={target.price !== '' ? target.price : priceOf(target.pct)}
            onChange={e => { const p = parseFloat(e.target.value); const t = isFinite(p) ? priceToTarget(pos, p) : null; setTarget({ price: e.target.value, pct: t != null ? round2(t) : '' }); }} />
        </div>
        {tastyFly !== null && onTastyFly && (
          <button type="button" data-testid="tasty-fly-toggle-pt" onClick={() => onTastyFly(!tastyFly)}
            title="tastylive's long-fly guidance: take 25–50% of MAX PROFIT, not a % of the debit"
            style={{ ...btn(!!tastyFly), marginTop: 6, borderColor: tastyFly ? '#2f81f7' : '#30363d', color: tastyFly ? '#58a6ff' : '#a8b2be', background: tastyFly ? '#0d1a2b' : 'transparent' }}>
            {tastyFly ? '✓ ' : ''}tastylive targets: 25–50% of max
          </button>
        )}
        {(rule.why || !is0) && (
          <div style={{ fontSize: 12, color: '#8b949e', marginTop: 4 }} data-testid="exit-rule">
            {rule.why}{rule.why && !is0 ? ' · ' : ''}{!is0 && (closeDteIn || rule.closeDte) ? `close by ${closeDteIn || rule.closeDte} DTE${rule.closeLeg ? ' on the ' + rule.closeLeg : ''} whatever the P&L` : ''}
            {!is0 && Array.isArray(rule.closeOptions) && onCloseDte && (
              <span style={{ marginLeft: 8, display: 'inline-flex', gap: 4 }}>
                {rule.closeOptions.map(c => (
                  <button key={c} type="button" onClick={() => onCloseDte(c)} style={btn((closeDteIn || rule.closeDte) === c)}>{c} DTE</button>
                ))}
              </span>
            )}
          </div>
        )}
        <Result q={qty} pct={Number(target.pct) || 0} price={tPrice} />
      </>) : (<>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 12, color: '#8b949e' }}>Tranches, target {basisWord}</span>
          <button style={{ ...btn(false), borderColor: '#2f81f7', color: '#58a6ff' }} onClick={() => setRows(r => [...r, { qty: 1, pct: rule.target }])}>+ Tranche</button>
          <span className="mono" style={{ marginLeft: 'auto', fontSize: 12, color: allocated === qty ? '#8b949e' : '#f85149' }}>{allocated} / {qty} allocated</span>
        </div>
        {rows.map((r, i) => {
          const price = priceOf(r.pct);
          return (
            <div key={i} style={{ borderTop: i ? '1px solid #21262d' : 'none', paddingTop: 4 }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: '#8b949e', width: 22 }}>T{i + 1}</span>
                <input type="number" min="1" value={r.qty} style={{ ...cell, width: 56 }} title="contracts"
                  onChange={e => setRows(rs => rs.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))} />
                <span style={{ fontSize: 12, color: '#8b949e' }}>ct at +</span>
                <input type="number" step="5" value={r.pct} style={{ ...cell, width: 64 }} title={`% ${basisWord}`}
                  onChange={e => setRows(rs => rs.map((x, j) => j === i ? { ...x, pct: e.target.value } : x))} />
                <span style={{ fontSize: 12, color: '#8b949e' }}>%</span>
                <button onClick={() => setRows(rs => rs.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', color: '#8b949e', cursor: 'pointer' }}>×</button>
              </div>
              <Result q={Number(r.qty) || 0} pct={Number(r.pct) || 0} price={price} />
            </div>
          );
        })}
      </>)}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', borderTop: '1px solid #21262d', paddingTop: 6 }}>
        {qty > 1 && (
          <button onClick={() => setSplit(s => !s)} style={{ ...btn(split), marginRight: 6 }}>
            {split ? '✓ Scaling out' : 'Scale out in tranches'}
          </button>
        )}
        <span style={{ fontSize: 12, color: '#a8b2be' }}>Stop</span>
        <input type="number" step="25" placeholder="% loss" title={pos.isCredit ? 'Loss as % of the credit — 100 closes at 2× credit' : 'Loss as % of the debit — 50 sells at half what you paid'} value={stopPct} onChange={e => setStopPct(e.target.value)} style={{ ...cell, width: 80 }} />
        {stop != null && (
          <span className="mono" data-testid="pt-stop" style={{ fontSize: 12, color: '#f85149' }}>
            @ {stop.toFixed(2)} {closeSide} = {pctStr(pnlPct(pos, stop) ?? 0)} · {money(pnlAt(pos, stop, qty))}
            {String(stopPct) === String(STOP_LOSS_PCT) && <span style={{ color: '#8b949e' }}> · guide: {STOP_LOSS_PCT}% of the {pos.isCredit ? 'credit' : 'debit'}</span>}
          </span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#a8b2be' }} title="Per contract, each way. Set per account in Settings.">Comm / contract</span>
        <input type="number" step="0.01" value={comm} style={{ ...cell, width: 60 }}
          onChange={e => setComm(e.target.value)} />
      </div>
      {!(win > 0) && !pos.isCredit && (
        <div style={{ fontSize: 11.5, color: '#8b949e', marginTop: 4 }}>No Win amount entered, so the max-profit cap isn't known.</div>
      )}
      <div style={{ fontSize: 11.5, color: '#8b949e', marginTop: 4 }}>
        Log trade writes this into the notes and pre-loads the Sell ticket.
      </div>
      <TicketHelp kind="buy" />
    </div>
  );
}
