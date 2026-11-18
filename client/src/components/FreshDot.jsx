import React from 'react';
import { FRESH_LABEL, ageText } from '../live/liveStore';

// One dot that says how live a number is (Nov 2026). Green live, blue market closed
// (last value), amber delayed or stale, grey not live. The tooltip says why and how old.
const TONE = {
  live: 'var(--c-3fb950)', frozen: 'var(--c-58a6ff)', delayed: 'var(--c-d29922)',
  stale: 'var(--c-d29922)', off: 'var(--c-6e7681)',
};

export default function FreshDot({ state = 'off', ts, size = 7, title, className = '' }) {
  const c = TONE[state] || TONE.off;
  const tip = title || [FRESH_LABEL[state] || '', ts ? `updated ${ageText(ts)}` : ''].filter(Boolean).join(' · ');
  return (
    <span role="img" aria-label={tip} title={tip} data-testid="fresh-dot" data-state={state} className={className}
      style={{ display: 'inline-block', width: size, height: size, borderRadius: '50%', background: c, flex: 'none',
        boxShadow: state === 'live' ? `0 0 0 3px color-mix(in srgb, ${c} 22%, transparent)` : 'none' }} />
  );
}
