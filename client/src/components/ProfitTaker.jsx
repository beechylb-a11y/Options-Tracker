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
const cell = { padding: '5px 6px', borderRadius: 6, border: '1px solid var(--c-30363d)', background: 'var(--c-0d1117)',
  color: 'var(--c-e6edf3)', fontSize: 13, fontFamily: 'JetBrains Mono,monospace', outline: 'none', width: '100%' };

const money = x => (x >= 0 ? '+$' : '−$') + Math.abs(x).toFixed(0);
const pctStr = x => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(0) + '%';

export default function ProfitTaker({ ncd, win, contracts, kelly = null, underlying, legs, onPlan, engine = '0DTE', commRate, strategy,
  tastyFly = null, onTastyFly, closeDte: closeDteIn = null, onCloseDte, targetOverride = null, variant = 'full' }) {
  const is0 = !/45/.test(engine);
  // Per-strategy target and basis (Oct 2026): tastylive's numbers, not one 50% for all.
  // tastyFly (0DTE long flies only; null = not offered): switch to tastylive's
  // 25–50% of MAX PROFIT instead of the % return on the debit.
  const baseRule = exitRuleFor(engine, strategy);
  // targetOverride (Oct 2026): the engine's distance-based target for 0DTE credit
  // spreads — 25% near the expected move, 50% far out of the money.
  const rule = tastyFly ? { ...baseRule, basis: 'max', target: 25, chips: [25, 35, 50],
    why: 'long fly: 25–50% of max profit' }
    : targetOverride && targetOverride.target ? { ...baseRule, target: targetOverride.target, why: targetOverride.why || baseRule.why }
    : baseRule;
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
  }, [strategy, engine, tastyFly, targetOverride && targetOverride.target]);
  // The stop starts at the 100%-of-premium guide; clear it for no stop.
  const [stopPct, setStopPct] = useState(String(STOP_LOSS_PCT));
  useEffect(() => { setRows(rs => ladder(qty, rs.length ? rs.map(r => r.pct) : [25, 50, 100])); }, [qty]);

  const priceOf = pct => snap(targetToPrice(pos, Number(pct) || 0), tick);
  const tPrice = target.price !== '' && isFinite(parseFloat(target.price)) ? parseFloat(target.price) : priceOf(target.pct);
  const effRows = split ? rows : [{ qty, pct: Number(target.pct) || 0 }];
  const stop = stopPct !== '' && isFinite(parseFloat(stopPct)) ? snap(stopToPrice(pos, parseFloat(stopPct)), tick) : null;

  // The close-by DTE (45DTE) travels with the plan, so the logged notes carry it.
  const closeBy = !is0 ? (closeDteIn || rule.closeDte || null) : null;
  // The plan carries its PRICES too (Nov 2026): the exit-plan card draws the ladder and
  // the TWS ticket from them, so the card and this block can never price differently
  // (tick-snapped, a typed LMT honoured).
  const pricedRows = effRows.map((r, i) => ({ qty: Number(r.qty) || 0, pct: Number(r.pct) || 0,
    price: !split && i === 0 ? tPrice : priceOf(r.pct) }));
  useEffect(() => {
    onPlan && onPlan({ rows: effRows.map(r => ({ qty: Number(r.qty) || 0, pct: Number(r.pct) || 0 })), stopPct: stopPct === '' ? '' : Math.abs(parseFloat(stopPct)),
      basis: pos.basis, closeDte: closeBy, closeLeg: closeBy ? (rule.closeLeg || null) : null, closeEt: is0 ? (rule.closeEt || null) : null,
      priced: pricedRows, stopPrice: stop, commRoundTrip: roundTrip(qty), isCredit: pos.isCredit, entry, tick });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(pricedRows), stopPct, stop, pos.basis, closeBy, rule.closeLeg, comm, qty, entry]);
  const [showDetail, setShowDetail] = useState(false);

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
      <div className="mono" style={{ fontSize: 12.5, color: 'var(--c-a8b2be)', lineHeight: 1.65, padding: '4px 0 6px' }}>
        <span style={{ color: 'var(--c-e6edf3)', fontWeight: 700 }}>{closeSide === 'cr' ? 'Sell' : 'Buy back'} @ {price.toFixed(2)}</span>
        {' '}= <span style={{ color: 'var(--c-3fb950)', fontWeight: 700 }}>{pctStr(pnlPct(pos, price) ?? 0)}</span> on entry
        {' '}· <span style={{ color: 'var(--c-3fb950)' }}>{money(gross)}</span> on {q}
        {' '}<span style={{ color: net >= 0 ? 'var(--c-3fb950)' : 'var(--c-f85149)' }}>({money(net)} after comm)</span>
        {/* Say where the commission comes from: a butterfly is 4 option contracts per
            unit, charged on the way in AND out, so a 16-lot is 128 contracts. It is
            easy to read $83 off a $256 target as a bug when it is the real cost. */}
        {roundTrip(q) > 0 && (
          <span style={{ color: 'var(--c-8b949e)' }}><br />
            Comm −${roundTrip(q).toFixed(2)} = {q} × {perUnit} contracts × 2 sides × ${Number(comm).toFixed(2)}
            {gross > 0 && <> · <span style={{ color: roundTrip(q) / gross > 0.2 ? 'var(--c-d29922)' : 'var(--c-8b949e)' }}>{(roundTrip(q) / gross * 100).toFixed(0)}% of the profit</span></>}
            {!pos.isCredit && <> · breakeven after comm: {(entry + roundTrip(1) / 100).toFixed(2)}</>}
          </span>
        )}
        {over && <span style={{ color: 'var(--c-f85149)' }}> — beyond max profit ({capPct.toFixed(0)}%), can't fill</span>}
        <br />{twsLine(price)}
        {!pos.isCredit && pos.basis === 'max' && Math.abs((pnlPct(pos, price) ?? 0) - Number(pct)) > 10 && (
          <span style={{ color: 'var(--c-d29922)' }}><br />{is0 ? 'These' : '45DTE'} targets are % of max profit: {pct}% of max = {pctStr(pnlPct(pos, price) ?? 0)} on what you paid. Use the offset in TWS, not {pct}%.</span>
        )}
      </div>
    );
  };

  const btn = on => ({ padding: '3px 10px', borderRadius: 5, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: '1px solid',
    borderColor: on ? 'var(--c-238636)' : 'var(--c-30363d)', background: on ? 'var(--c-0d2818)' : 'transparent', color: on ? 'var(--c-3fb950)' : 'var(--c-a8b2be)' });

  const full = (
    <div style={{ marginTop: 10, marginBottom: 4, padding: 10, borderRadius: 8, background: 'var(--c-0d1117)', border: '1px solid var(--c-21262d)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ background: 'var(--c-0d2818)', color: 'var(--c-3fb950)', borderRadius: 4, padding: '1px 7px', fontSize: 12, fontWeight: 700 }}>BUY</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--c-e6edf3)' }}>Profit taker</span>
        <span className="mono" style={{ fontSize: 12.5, color: 'var(--c-c9d1d9)' }}>
          {qty} ct <span style={{ color: 'var(--c-8b949e)' }}>{kelly == null || Number(kelly) === qty ? '(Kelly)' : `(your size · Kelly ${kelly})`}</span> @ {entry.toFixed(2)} {pos.isCredit ? 'cr' : 'db'}
        </span>
        <span className="mono" style={{ fontSize: 12, color: 'var(--c-8b949e)' }}>
          · max {win > 0 ? `$${win.toFixed(0)}/ct` : '—'}{capPct != null && win > 0 ? ` = ${pctStr(capPct)} ${basisWord}` : ''}
        </span>
      </div>

      {!split ? (<>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: 'var(--c-8b949e)', marginRight: 2 }}>Target {basisWord}</span>
          {chips.map(p => (
            <button key={p} onClick={() => setTarget({ pct: p, price: '' })} style={btn(Number(target.pct) === p && target.price === '')}>+{p}%</button>
          ))}
          <input type="number" step="5" value={target.pct} style={{ ...cell, width: 64, marginLeft: 6 }} title={`% ${basisWord}`}
            onChange={e => setTarget({ pct: e.target.value, price: '' })} />
          <span style={{ fontSize: 12, color: 'var(--c-8b949e)' }}>% ⇄ LMT</span>
          <input type="number" step={tick} style={{ ...cell, width: 80 }} value={target.price !== '' ? target.price : priceOf(target.pct)}
            onChange={e => { const p = parseFloat(e.target.value); const t = isFinite(p) ? priceToTarget(pos, p) : null; setTarget({ price: e.target.value, pct: t != null ? round2(t) : '' }); }} />
        </div>
        {tastyFly !== null && onTastyFly && (
          <button type="button" data-testid="tasty-fly-toggle-pt" onClick={() => onTastyFly(!tastyFly)}
            title="Long-fly targets: take 25–50% of MAX PROFIT, not a % of the debit"
            style={{ ...btn(!!tastyFly), marginTop: 6, borderColor: tastyFly ? 'var(--c-2f81f7)' : 'var(--c-30363d)', color: tastyFly ? 'var(--c-58a6ff)' : 'var(--c-a8b2be)', background: tastyFly ? 'var(--c-0d1a2b)' : 'transparent' }}>
            {tastyFly ? '✓ ' : ''}Long-fly targets: 25–50% of max
          </button>
        )}
        {(rule.why || !is0) && (
          <div style={{ fontSize: 12, color: 'var(--c-8b949e)', marginTop: 4 }} data-testid="exit-rule">
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
          <span style={{ fontSize: 12, color: 'var(--c-8b949e)' }}>Tranches, target {basisWord}</span>
          <button style={{ ...btn(false), borderColor: 'var(--c-2f81f7)', color: 'var(--c-58a6ff)' }} onClick={() => setRows(r => [...r, { qty: 1, pct: rule.target }])}>+ Tranche</button>
          <span className="mono" style={{ marginLeft: 'auto', fontSize: 12, color: allocated === qty ? 'var(--c-8b949e)' : 'var(--c-f85149)' }}>{allocated} / {qty} allocated</span>
        </div>
        {rows.map((r, i) => {
          const price = priceOf(r.pct);
          return (
            <div key={i} style={{ borderTop: i ? '1px solid var(--c-21262d)' : 'none', paddingTop: 4 }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--c-8b949e)', width: 22 }}>T{i + 1}</span>
                <input type="number" min="1" value={r.qty} style={{ ...cell, width: 56 }} title="contracts"
                  onChange={e => setRows(rs => rs.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))} />
                <span style={{ fontSize: 12, color: 'var(--c-8b949e)' }}>ct at +</span>
                <input type="number" step="5" value={r.pct} style={{ ...cell, width: 64 }} title={`% ${basisWord}`}
                  onChange={e => setRows(rs => rs.map((x, j) => j === i ? { ...x, pct: e.target.value } : x))} />
                <span style={{ fontSize: 12, color: 'var(--c-8b949e)' }}>%</span>
                <button onClick={() => setRows(rs => rs.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', color: 'var(--c-8b949e)', cursor: 'pointer' }}>×</button>
              </div>
              <Result q={Number(r.qty) || 0} pct={Number(r.pct) || 0} price={price} />
            </div>
          );
        })}
      </>)}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', borderTop: '1px solid var(--c-21262d)', paddingTop: 6 }}>
        {qty > 1 && (
          <button onClick={() => setSplit(s => !s)} style={{ ...btn(split), marginRight: 6 }}>
            {split ? '✓ Scaling out' : 'Scale out in tranches'}
          </button>
        )}
        <span style={{ fontSize: 12, color: 'var(--c-a8b2be)' }}>Stop</span>
        <input type="number" step="25" placeholder="% loss" title={pos.isCredit ? 'Loss as % of the credit — 100 closes at 2× credit' : 'Loss as % of the debit — 50 sells at half what you paid'} value={stopPct} onChange={e => setStopPct(e.target.value)} style={{ ...cell, width: 80 }} />
        {stop != null && (
          <span className="mono" data-testid="pt-stop" style={{ fontSize: 12, color: 'var(--c-f85149)' }}>
            @ {stop.toFixed(2)} {closeSide} = {pctStr(pnlPct(pos, stop) ?? 0)} · {money(pnlAt(pos, stop, qty))}
            {String(stopPct) === String(STOP_LOSS_PCT) && <span style={{ color: 'var(--c-8b949e)' }}> · guide: {STOP_LOSS_PCT}% of the {pos.isCredit ? 'credit' : 'debit'}</span>}
          </span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--c-a8b2be)' }} title="Per contract, each way. Set per account in Settings.">Comm / contract</span>
        <input type="number" step="0.01" value={comm} style={{ ...cell, width: 60 }}
          onChange={e => setComm(e.target.value)} />
      </div>
      {!(win > 0) && !pos.isCredit && (
        <div style={{ fontSize: 11.5, color: 'var(--c-8b949e)', marginTop: 4 }}>No Win amount entered, so the max-profit cap isn't known.</div>
      )}
      <div style={{ fontSize: 11.5, color: 'var(--c-8b949e)', marginTop: 4 }}>
        This plan is saved by the one Log trade button: targets, stop and close-by go into the trade's notes, and the Sell ticket is pre-loaded on this device.
      </div>
      <TicketHelp kind="buy" />
    </div>
  );
  if (variant !== 'card') return full;

  // ── Card variant (Nov 2026): one row of controls on the exit-plan card. The full
  // block (typed LMT, per-tranche edits, commission, long-fly and close-by options)
  // is a click away under "details" — same state, so nothing set there is lost.
  const chip = (on, tone) => ({ display: 'inline-flex', alignItems: 'center', padding: '5px 11px', borderRadius: 999, fontSize: 13, fontWeight: 700, cursor: 'pointer',
    border: `1px solid ${on ? (tone === 'red' ? 'var(--c-f85149)' : 'var(--c-3fb950)') : 'var(--c-30363d)'}`,
    background: on ? `color-mix(in srgb, ${tone === 'red' ? 'var(--c-f85149)' : 'var(--c-3fb950)'} 16%, transparent)` : 'transparent',
    color: on ? 'var(--c-ffffff)' : 'var(--c-a8b2be)' });
  const cap = { fontSize: 11.5, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--c-8b949e)' };
  const nTr = split ? rows.length : 1;
  const trancheTo = n => {
    if (n <= 1) { setSplit(false); return; }
    const up = [Number(target.pct) || rule.target, ...chips.filter(c => c > (Number(target.pct) || rule.target)), 75, 100, 150].filter((v, i, a) => a.indexOf(v) === i);
    setRows(ladder(qty, up.slice(0, n)));
    setSplit(true);
  };
  const stopOpts = pos.isCredit ? [50, 100, 200] : [25, 50, 75];
  return (
    <div data-testid="pt-card">
      <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', alignItems: 'flex-start', padding: '12px 14px', borderRadius: 12, background: 'var(--c-0d1117)', border: '1px solid var(--c-21262d)' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 240px' }}>
          <span style={cap}>Take profit at{split ? ' (T1)' : ''}</span>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {chips.map(c => (
              <button key={c} data-testid={`pt-chip-${c}`} onClick={() => { setTarget({ pct: c, price: '' }); if (split) setRows(rs => rs.map((x, j) => j === 0 ? { ...x, pct: c } : x)); }}
                style={chip(Number(target.pct) === c && target.price === '')}>{c}%</button>
            ))}
            <input type="number" step="5" aria-label="Target %" value={target.pct} onChange={e => setTarget({ pct: e.target.value, price: '' })}
              style={{ ...cell, width: 64 }} />
            {rule.why && <span style={{ fontSize: 12, color: 'var(--c-8b949e)' }}>{rule.why}</span>}
          </div>
        </div>
        {qty > 1 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: '0 1 170px' }}>
            <span style={cap}>In tranches</span>
            <div style={{ display: 'flex', gap: 6 }}>
              {[1, 2, 3].filter(n => n <= qty).map(n => (
                <button key={n} data-testid={`pt-tranches-${n}`} onClick={() => trancheTo(n)} style={chip(nTr === n)}>{n}</button>
              ))}
            </div>
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 260px' }}>
          <span style={cap}>Your stop <span style={{ textTransform: 'none', letterSpacing: 0 }}>· watched by the check-up, not sent to TWS</span></span>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {stopOpts.map(v => (
              <button key={v} data-testid={`pt-stop-${v}`} onClick={() => setStopPct(String(v))} style={chip(String(stopPct) === String(v), 'red')}>{v}%</button>
            ))}
            <button data-testid="pt-stop-none" onClick={() => setStopPct('')} style={chip(stopPct === '', 'red')}>none</button>
            <span style={{ fontSize: 12, color: 'var(--c-8b949e)' }}>of the {pos.isCredit ? 'credit' : 'debit'}</span>
          </div>
        </div>
        <button data-testid="pt-details" onClick={() => setShowDetail(v => !v)}
          style={{ alignSelf: 'center', marginLeft: 'auto', fontSize: 12.5, color: 'var(--c-58a6ff)', background: 'none', border: 0, cursor: 'pointer' }}>
          {showDetail ? 'hide details ▴' : 'details ▾'}</button>
      </div>
      {showDetail && full}
    </div>
  );
}
