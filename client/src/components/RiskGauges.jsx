import React from 'react';
import { LIMITS, VEGA_SHOCK } from '../engine/greekLimits';

// Three gauges for the 45DTE book against limits set as a share of the bankroll
// (engine/greekLimits.js): daily theta, beta-weighted delta in SPY deltas, and the
// loss if implied vol rises 10 points. The 0DTE book is shown underneath, not held to
// these: it sits under the risk cap and the stress grid. (Nov 2026.)

const TONE = {
  green: 'var(--c-3fb950)', amber: 'var(--c-d29922)', red: 'var(--c-f85149)',
  low: 'var(--c-58a6ff)', none: 'var(--c-8b949e)',
};
const WORD = { green: 'inside the band', amber: 'over the line', red: 'well past the line', low: 'under target', none: '' };
const money = x => (x == null ? '—' : `${x < 0 ? '−' : ''}$${Math.round(Math.abs(x)).toLocaleString('en-US')}`);
const pct = (x, d = 2) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);

/** A ring that fills toward `max`, with tick marks at `ticks` (same scale). */
export function Gauge({ value, max, ticks = [], tone, children, testid, label }) {
  const size = 120, sw = 11, r = (size - sw) / 2, c = 2 * Math.PI * r;
  const frac = value == null || !(max > 0) ? 0 : Math.max(0, Math.min(1, value / max));
  const col = TONE[tone] || TONE.none;
  return (
    <div data-testid={testid} role="img" aria-label={label} style={{ position: 'relative', width: size, height: size, flex: 'none' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--c-21262d)" strokeWidth={sw} />
        {frac > 0 && <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={col} strokeWidth={sw} strokeLinecap="round"
          strokeDasharray={`${(c * frac).toFixed(1)} ${c.toFixed(1)}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />}
        {ticks.filter(t => t > 0 && t < max).map(t => {
          const a = (t / max) * 2 * Math.PI - Math.PI / 2;
          const x1 = size / 2 + (r - sw / 2 - 2) * Math.cos(a), y1 = size / 2 + (r - sw / 2 - 2) * Math.sin(a);
          const x2 = size / 2 + (r + sw / 2 + 2) * Math.cos(a), y2 = size / 2 + (r + sw / 2 + 2) * Math.sin(a);
          return <line key={t} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--c-e6edf3)" strokeWidth="2" strokeLinecap="round" opacity="0.85" />;
        })}
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>{children}</div>
    </div>
  );
}

function Card({ title, gauge, lines, tone, testid }) {
  return (
    <div data-testid={testid} style={{ display: 'flex', gap: 16, alignItems: 'center', minWidth: 0 }}>
      {gauge}
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--c-e6edf3)' }}>{title}</span>
        {lines.map((l, i) => <span key={i} style={{ fontSize: 12.5, color: i === 0 ? 'var(--c-e6edf3)' : 'var(--c-8b949e)' }}>{l}</span>)}
        {tone && WORD[tone] && <span data-testid={`${testid}-tone`} style={{ fontSize: 12, fontWeight: 600, color: TONE[tone] }}>{WORD[tone]}</span>}
      </div>
    </div>
  );
}

export default function RiskGauges({ lim, zero }) {
  if (!lim) return null;
  if (!lim.netLiq) {
    return <div className="text-sm" data-testid="gauges-no-bankroll" style={{ color: 'var(--c-d29922)' }}>
      Set a bankroll in Settings (or pick an account that has one) to see the book against its limits — they scale with it.</div>;
  }
  const T = LIMITS.theta, D = LIMITS.delta, V = LIMITS.vega10;
  const thetaPctAbs = lim.thetaPct == null ? null : Math.max(0, lim.thetaPct);
  return (
    <div>
      <div className="grid gap-5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(270px, 1fr))' }}>
        <Card testid="gauge-theta" title="Theta · 45DTE book" tone={lim.n ? lim.thetaTone : 'none'}
          gauge={<Gauge testid="gauge-theta-ring" label={`Theta ${pct(lim.thetaPct)} of bankroll`} value={thetaPctAbs} max={T.red} ticks={[T.floor, T.amber]} tone={lim.thetaTone}>
            <span style={{ fontSize: 22, fontWeight: 700 }}>{pct(lim.thetaPct)}</span><span style={{ fontSize: 11, color: 'var(--c-8b949e)' }}>a day</span></Gauge>}
          lines={[`${money(lim.theta)} a day of ${money(lim.netLiq)}`, `band 0.1–0.3% · ${money(lim.thetaBand.floor)}–${money(lim.thetaBand.amber)}`, `red past 0.5% (${money(lim.thetaBand.red)})`]} />
        <Card testid="gauge-delta" title="Delta · 45DTE book" tone={lim.n ? lim.deltaTone : 'none'}
          gauge={<Gauge testid="gauge-delta-ring" label={`Delta ${lim.deltaSpy == null ? 'unknown' : Math.round(lim.deltaSpy)} SPY deltas`} value={lim.deltaFrac} max={D.redX} ticks={[1]} tone={lim.deltaTone}>
            <span style={{ fontSize: 22, fontWeight: 700 }}>{lim.deltaSpy == null ? '—' : `${lim.deltaSpy > 0 ? '+' : lim.deltaSpy < 0 ? '−' : ''}${Math.round(Math.abs(lim.deltaSpy))}`}</span><span style={{ fontSize: 11, color: 'var(--c-8b949e)' }}>SPY Δ</span></Gauge>}
          lines={[lim.deltaSpy == null ? 'no SPY/SPX price yet' : `${lim.deltaSpy >= 0 ? 'long' : 'short'} · band ±${Math.round(lim.deltaBand)} (0.1% of bankroll)`,
            lim.ratio == null ? 'Δ/Θ — (needs positive theta)' : `Δ/Θ ${lim.ratio.toFixed(2)} · amber above 1`, 'red past twice the band']} />
        <Card testid="gauge-vega" title={`Vega · IV +${VEGA_SHOCK} points`} tone={lim.n ? lim.vegaTone : 'none'}
          gauge={<Gauge testid="gauge-vega-ring" label={`Loss at IV plus ${VEGA_SHOCK}: ${pct(lim.vegaLossPct, 1)} of bankroll`} value={lim.vegaLossPct} max={V.red} ticks={[V.amber]} tone={lim.vegaTone}>
            <span style={{ fontSize: 22, fontWeight: 700 }}>{pct(lim.vegaLossPct, 1)}</span><span style={{ fontSize: 11, color: 'var(--c-8b949e)' }}>loss</span></Gauge>}
          lines={[lim.vega10 == null ? 'no legs to stress' : `${lim.vega10 >= 0 ? 'makes' : 'loses'} ${money(Math.abs(lim.vega10))} if IV jumps ${VEGA_SHOCK}`, `amber past 3% (${money(lim.vegaBand.amber)})`, `red past 5% (${money(lim.vegaBand.red)})`]} />
      </div>
      <div className="text-[12.5px] mt-3" data-testid="gauges-zero" style={{ color: 'var(--c-8b949e)' }}>
        {lim.n ? `${lim.n} 45DTE position${lim.n === 1 ? '' : 's'} counted.` : 'No 45DTE positions open.'}
        {zero && zero.n > 0 ? ` 0DTE book (${zero.n}) is outside these limits — θ ${money(zero.theta)}/day, Δ ${money(zero.spxDelta1)} per 1% SPX; it sits under the risk cap and the stress test.` : ''}
      </div>
    </div>
  );
}
