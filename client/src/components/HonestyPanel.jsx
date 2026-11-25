import React, { useMemo, useState } from 'react';
import { StoryCard, Insight, ViewTabs } from './StoryViews';
import { honesty, MIN_LOOKS, MIN_SESSIONS } from '../engine/reliability';

// Are the engine's numbers honest? (Nov 2026, review recommendation 2.) The three numbers
// on every ticket — chance of a win, chance of the full max loss, EV — against what the
// shadow verdicts went on to make. Reliability curves, skill score and the EV ranking,
// every range from a bootstrap over whole sessions. A read only: nothing changes the engine.

const C = {
  ink: 'var(--c-e6edf3)', muted: 'var(--c-a8b2be)', faint: 'var(--c-8b949e)',
  up: 'var(--c-3fb950)', down: 'var(--c-f85149)', blue: 'var(--c-58a6ff)', warn: 'var(--c-e3b341)',
  grid: 'rgba(140,140,140,0.28)',
};
const pct = v => `${Math.round(v * 100)}%`;
const signedPct = v => `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v * 100))}%`;
const usd = v => (v < 0 ? '−$' : '+$') + Math.abs(Math.round(v)).toLocaleString('en-US');
const TONE = { good: C.up, bad: C.down, warn: C.warn, muted: C.muted };

const W = 300, H = 240, L = 56, R = 14, T = 12, B = 34;

/** Said (x) vs happened (y) for a probability. Diagonal = honest. */
function ReliabilityPlot({ r, testid }) {
  const lo = r.groups.every(g => g.said >= 0.3 && g.ci.lo >= 0.3) ? 0.3 : 0;
  const peak = Math.max(0.2, ...r.groups.map(g => Math.max(g.said, g.ci.hi)));
  const tickStep = [0.05, 0.1, 0.2, 0.25].find(st => (Math.min(1, peak) - lo) / st <= 5) || 0.25;
  const top = Math.min(1, lo + Math.ceil((peak - lo) / tickStep - 1e-9) * tickStep);
  const sx = v => L + (v - lo) / (top - lo) * (W - L - R);
  const sy = v => H - B - (v - lo) / (top - lo) * (H - T - B);
  const ticks = [];
  for (let v = lo; v <= top + 1e-9; v += tickStep) ticks.push(Math.round(v * 100) / 100);
  const maxN = Math.max(...r.groups.map(g => g.n));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="What it said against how often it happened" data-testid={testid}>
      {ticks.map(v => (
        <g key={v}>
          <line x1={L} x2={W - R} y1={sy(v)} y2={sy(v)} stroke={C.grid} strokeWidth="1" />
          <text x={L - 6} y={sy(v) + 4} textAnchor="end" fontSize="11" fill={C.faint}>{pct(v)}</text>
          <text x={sx(v)} y={H - B + 16} textAnchor="middle" fontSize="11" fill={C.faint}>{pct(v)}</text>
        </g>
      ))}
      <line x1={sx(lo)} y1={sy(lo)} x2={sx(top)} y2={sy(top)} stroke={C.muted} strokeDasharray="4 4" strokeWidth="1.2" />
      {r.groups.map((g, i) => {
        const col = g.off ? C.warn : C.blue;
        return (
          <g key={i} data-testid="rel-group" data-off={g.off ? '1' : '0'}>
            <title>{`Said ${pct(g.said)} on ${g.n} tickets · happened ${g.k} (${pct(g.rate)}), 95% range ${pct(g.ci.lo)}–${pct(g.ci.hi)}`}</title>
            <line x1={sx(g.said)} x2={sx(g.said)} y1={sy(Math.min(top, g.ci.hi))} y2={sy(Math.max(lo, g.ci.lo))} stroke={col} strokeWidth="2" opacity="0.55" />
            <circle cx={sx(g.said)} cy={sy(Math.min(top, Math.max(lo, g.rate)))} r={4 + 5 * Math.sqrt(g.n / maxN)} fill={col} fillOpacity="0.85" stroke="var(--c-0d1117)" strokeWidth="1" />
          </g>
        );
      })}
      <text x={(L + W - R) / 2} y={H - 4} textAnchor="middle" fontSize="11.5" fill={C.muted}>said</text>
      <text x={11} y={(T + H - B) / 2} textAnchor="middle" fontSize="11.5" fill={C.muted} transform={`rotate(-90 11 ${(T + H - B) / 2})`}>happened</text>
    </svg>
  );
}

/** EV said (x) vs $ made (y) per group, with the 95% range of what was made. */
function EvPlot({ r, testid }) {
  const xs = r.groups.map(g => g.said), ys = r.groups.map(g => g.made);
  let lo = Math.min(0, ...xs, ...ys), hi = Math.max(0, ...xs, ...ys);
  const pad = (hi - lo) * 0.25 || 50;
  lo -= pad; hi += pad;
  const sx = v => L + (v - lo) / (hi - lo) * (W - L - R);
  const sy = v => H - B - (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo) * (H - T - B);
  const step = niceStep((hi - lo) / 4);
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push(v);
  const maxN = Math.max(...r.groups.map(g => g.n));
  const short = v => (Math.abs(v) >= 1000 ? `${v < 0 ? '−' : ''}$${(Math.abs(v) / 1000).toFixed(1)}k` : `${v < 0 ? '−' : ''}$${Math.abs(v)}`);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="EV it said against what was made" data-testid={testid}>
      {ticks.map(v => (
        <g key={v}>
          <line x1={L} x2={W - R} y1={sy(v)} y2={sy(v)} stroke={v === 0 ? C.muted : C.grid} strokeWidth="1" opacity={v === 0 ? 0.6 : 1} />
          <text x={L - 6} y={sy(v) + 4} textAnchor="end" fontSize="11" fill={C.faint}>{short(v)}</text>
          <text x={sx(v)} y={H - B + 16} textAnchor="middle" fontSize="11" fill={C.faint}>{short(v)}</text>
        </g>
      ))}
      <line x1={sx(lo)} y1={sy(lo)} x2={sx(hi)} y2={sy(hi)} stroke={C.muted} strokeDasharray="4 4" strokeWidth="1.2" />
      {r.groups.map((g, i) => {
        const col = g.made >= 0 ? C.up : C.down;
        return (
          <g key={i} data-testid="ev-group">
            <title>{`EV said ${usd(g.said)} on ${g.n} tickets · made ${usd(g.made)} a contract${g.ci && g.ci.lo != null ? `, 95% range ${usd(g.ci.lo)} to ${usd(g.ci.hi)}` : ''}`}</title>
            {g.ci && g.ci.lo != null && <line x1={sx(g.said)} x2={sx(g.said)} y1={sy(g.ci.hi)} y2={sy(g.ci.lo)} stroke={col} strokeWidth="2" opacity="0.5" />}
            <circle cx={sx(g.said)} cy={sy(g.made)} r={4 + 5 * Math.sqrt(g.n / maxN)} fill={col} fillOpacity="0.85" stroke="var(--c-0d1117)" strokeWidth="1" />
          </g>
        );
      })}
      <text x={(L + W - R) / 2} y={H - 4} textAnchor="middle" fontSize="11.5" fill={C.muted}>EV said, per contract</text>
      <text x={11} y={(T + H - B) / 2} textAnchor="middle" fontSize="11.5" fill={C.muted} transform={`rotate(-90 11 ${(T + H - B) / 2})`}>made</text>
    </svg>
  );
}
function niceStep(x) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(1e-9, x))));
  const m = x / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

function Range({ ci, fmt }) {
  if (!ci || ci.lo == null || ci.hi == null) return null;
  return <span className="text-text-faint"> ({fmt(ci.lo)} to {fmt(ci.hi)})</span>;
}

function Block({ title, said, happened, plot, stat, read, n, sessions, testid, empty }) {
  return (
    <div className="honesty-block rounded-2xl border border-bg-border px-4 py-3" style={{ background: 'rgba(255,255,255,0.04)' }} data-testid={testid}>
      <div className="text-[14px] font-semibold text-text">{title}</div>
      {empty ? <div className="py-10 text-center text-[13px] text-text-faint">{empty}</div> : (
        <>
          <div className="flex items-baseline gap-4 mt-1 flex-wrap">
            <div><span className="text-[12px] text-text-muted">said </span><span className="num text-[22px] font-semibold">{said}</span></div>
            <div><span className="text-[12px] text-text-muted">happened </span><span className="num text-[22px] font-semibold">{happened}</span></div>
          </div>
          <div className="text-[12px] text-text-faint num">{n} settled · {sessions} session{sessions === 1 ? '' : 's'}</div>
          <div className="mt-2">{plot}</div>
          <div className="text-[12.5px] text-text-muted num" data-testid="honesty-stat">{stat}</div>
          <Insight><span data-testid="honesty-read" data-tone={read.tone} style={{ color: read.tone === 'muted' ? undefined : TONE[read.tone] }}>{read.text}</span></Insight>
        </>
      )}
    </div>
  );
}

export default function HonestyPanel({ rows }) {
  const engines = useMemo(() => ['0DTE', '45DTE'].filter(e => (rows || []).some(r => r.engine === e)), [rows]);
  const [engine, setEngine] = useState(null);
  const eng = engine && engines.includes(engine) ? engine : engines[0];
  const h = useMemo(() => (eng ? honesty(rows, eng) : null), [rows, eng]);
  if (!h) return null;
  const outcomeWord = h.outcome === 'held' ? 'held to the close' : 'at the managed exit';
  const pendingMax = eng === '45DTE' ? 'No 45DTE ticket has reached expiry yet.' : 'No settled tickets with a max-loss chance yet.';
  return (
    <StoryCard testid="honesty-panel" eyebrow="Are the engine's numbers honest?" title="What it said vs what happened"
      sub={`Every verdict the engine recorded, ${outcomeWord}. A dot on the dashed line means the number was right; the lines through the dots are 95% ranges. Ranges resample whole sessions, because one day's tickets move together.`}
      right={engines.length > 1 ? <ViewTabs value={eng} onChange={setEngine} options={engines.map(e => [e, e])} testid="honesty-engine" /> : null}>
      <div className="grid gap-3 lg:grid-cols-3">
        {h.win ? (
          <Block testid="honesty-win" title="Chance of a win" said={pct(h.win.said)} happened={pct(h.win.rate)}
            n={h.win.n} sessions={h.win.sessions} read={h.win.read}
            plot={<ReliabilityPlot r={h.win} testid="rel-win" />}
            stat={h.win.enough && h.win.skill != null ? <>Skill vs quoting {pct(h.win.rate)} every time: {signedPct(h.win.skill)}<Range ci={h.win.ci && h.win.ci.skill} fmt={signedPct} /></> : `Scores read from ${MIN_LOOKS} settled over ${MIN_SESSIONS} sessions.`} />
        ) : <Block testid="honesty-win" title="Chance of a win" empty="No settled tickets with a win chance yet." />}
        {h.maxLoss ? (
          <Block testid="honesty-maxloss" title="Chance of the full max loss" said={pct(h.maxLoss.said)} happened={pct(h.maxLoss.rate)}
            n={h.maxLoss.n} sessions={h.maxLoss.sessions} read={h.maxLoss.read}
            plot={<ReliabilityPlot r={h.maxLoss} testid="rel-maxloss" />}
            stat={h.maxLoss.enough && h.maxLoss.skill != null ? <>Skill vs quoting {pct(h.maxLoss.rate)} every time: {signedPct(h.maxLoss.skill)}<Range ci={h.maxLoss.ci && h.maxLoss.ci.skill} fmt={signedPct} /></> : `Scores read from ${MIN_LOOKS} settled over ${MIN_SESSIONS} sessions.`} />
        ) : <Block testid="honesty-maxloss" title="Chance of the full max loss" empty={pendingMax} />}
        {h.ev ? (
          <Block testid="honesty-ev" title="EV per contract" said={usd(h.ev.said)} happened={usd(h.ev.made)}
            n={h.ev.n} sessions={h.ev.sessions} read={h.ev.read}
            plot={<EvPlot r={h.ev} testid="ev-plot" />}
            stat={h.ev.enough && h.ev.rho != null ? <>Does a higher EV make more? Rank correlation {h.ev.rho >= 0 ? '+' : '−'}{Math.abs(h.ev.rho).toFixed(2)}<Range ci={h.ev.ci && h.ev.ci.rho} fmt={v => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`} /></> : `Scores read from ${MIN_LOOKS} settled over ${MIN_SESSIONS} sessions.`} />
        ) : <Block testid="honesty-ev" title="EV per contract" empty="No settled tickets with an EV yet." />}
      </div>
      <p className="mt-3 text-[12px] text-text-faint">
        Skill: how much closer the engine's chances land than quoting the overall rate on every ticket (0% = no better, negative = worse).
        Max loss counts a ticket that lost 95% or more of its max loss held to expiry. Dots are equal-count groups; amber: what it said sits outside the 95% range of what happened.
      </p>
    </StoryCard>
  );
}
