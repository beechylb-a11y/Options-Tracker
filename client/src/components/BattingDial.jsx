import React from 'react';
import { baZone, BA_COLOURS } from '../utils/batting';

// Batting average as a dial (Nov 2026): the outer band is the scale (red under 65,
// amber 65–75, green 75+), one ring per real-money account in its colour, and the
// centre ring — in the band's colour — is all real accounts together, with its number.
// The scale runs 40–100%: below 40 the needle sits at the start.

const SWEEP = 240, LO = 40;
const scale = v => ((Math.max(LO, Math.min(100, v)) - LO) / (100 - LO)) * SWEEP;
function pt(cx, cy, r, a) { const t = ((210 - a) * Math.PI) / 180; return [cx + r * Math.cos(t), cy - r * Math.sin(t)]; }
function arc(cx, cy, r, a0, a1) {
  const [x0, y0] = pt(cx, cy, r, a0), [x1, y1] = pt(cx, cy, r, a1);
  return `M${x0.toFixed(1)},${y0.toFixed(1)} A${r},${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(1)},${y1.toFixed(1)}`;
}

export default function BattingDial({ rings = [], overall, size = 220, label = 'all real accounts' }) {
  const cx = size / 2, cy = size / 2, R = size / 2 - 14;
  const track = 'rgba(255,255,255,0.13)';
  const zone = baZone(overall && overall.ba);
  const col = zone ? BA_COLOURS[zone] : 'rgba(255,255,255,0.5)';
  const ringW = Math.max(6, Math.round(size / 30));
  const step = ringW + 4;
  let r = R - 12;
  const ringEls = rings.map((x, i) => {
    const el = (
      <g key={x.id || i}>
        <path d={arc(cx, cy, r, 0, SWEEP)} stroke={track} strokeWidth={ringW} fill="none" strokeLinecap="round" />
        {x.ba != null && x.ba > LO && <path d={arc(cx, cy, r, 0, scale(x.ba))} stroke={x.color} strokeWidth={ringW} fill="none" strokeLinecap="round">
          <title>{`${x.name}: ${Math.round(x.ba)}% of ${x.total}`}</title></path>}
      </g>
    );
    r -= step;
    return el;
  });
  const cR = r - 2, cW = ringW + 6;
  const ov = overall && overall.ba != null ? overall.ba : null;
  const needle = ov != null ? (() => { const [x0, y0] = pt(cx, cy, cR - cW, scale(ov)); const [x1, y1] = pt(cx, cy, R + 3, scale(ov)); return <line x1={x0} y1={y0} x2={x1} y2={y1} stroke="#fff" strokeWidth="2" />; })() : null;
  const h = Math.round(size * 0.86);
  return (
    <svg role="img" aria-label={ov != null ? `Batting average ${Math.round(ov)}%, ${label}` : 'Batting average: no closed trades'}
      width="100%" viewBox={`0 0 ${size} ${h}`} style={{ maxWidth: size, display: 'block' }} data-testid="batting-dial">
      {[[LO, 65, BA_COLOURS.red], [65, 75, BA_COLOURS.amber], [75, 100, BA_COLOURS.green]].map(([a, b, c]) => (
        <path key={a} d={arc(cx, cy, R, scale(a), scale(b))} stroke={c} strokeOpacity="0.85" strokeWidth="4" fill="none" />
      ))}
      {[65, 75].map(t => { const [x, y] = pt(cx, cy, R + 9, scale(t)); return <text key={t} x={x} y={y + 3} textAnchor="middle" fontSize="9.5" fill="rgba(255,255,255,0.75)">{t}</text>; })}
      {ringEls}
      <path d={arc(cx, cy, cR, 0, SWEEP)} stroke={track} strokeWidth={cW} fill="none" strokeLinecap="round" />
      {ov != null && ov > LO && <path d={arc(cx, cy, cR, 0, scale(ov))} stroke={col} strokeWidth={cW} fill="none" strokeLinecap="round" />}
      {needle}
      <text x={cx} y={cy + size * 0.06} textAnchor="middle" fontSize={size * 0.2} fontWeight="600" fill={col} style={{ fontVariantNumeric: 'tabular-nums' }}
        data-testid="batting-dial-number">{ov != null ? Math.round(ov) + '%' : '—'}</text>
      <text x={cx} y={cy + size * 0.17} textAnchor="middle" fontSize={Math.max(9, size * 0.055)} fill="rgba(255,255,255,0.8)">
        {overall && overall.total ? `${overall.total} closed` : 'no closed trades'}</text>
    </svg>
  );
}
