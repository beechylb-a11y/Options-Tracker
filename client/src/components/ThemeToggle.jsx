import React, { useState, useEffect } from 'react';
import { Sun, Moon, Monitor, Sparkles, Square, Gem } from 'lucide-react';
import { themePref, resolvedTheme, setThemePref, glassPref, setGlassPref } from '../utils/theme';

// Day / night switch (Nov 2026). The header button flips day ↔ night; Settings also
// offers "Auto", which follows the computer's own setting.
function usePref() {
  const [pref, setPref] = useState(themePref());
  useEffect(() => {
    const on = () => setPref(themePref());
    window.addEventListener('themechange', on);
    return () => window.removeEventListener('themechange', on);
  }, []);
  return pref;
}

export default function ThemeToggle() {
  const pref = usePref();
  const day = resolvedTheme(pref) === 'light';
  return (
    <button data-testid="theme-toggle" onClick={() => setThemePref(day ? 'dark' : 'light')}
      title={day ? 'Switch to night mode' : 'Switch to day mode'} aria-label={day ? 'Night mode' : 'Day mode'}
      className="flex items-center justify-center w-7 h-7 rounded-lg border border-bg-border text-text-muted hover:text-text hover:bg-bg-hover transition-colors">
      {day ? <Moon size={14} /> : <Sun size={14} />}
    </button>
  );
}

export function ThemeChoice() {
  const pref = usePref();
  const opts = [['light', 'Day', Sun], ['dark', 'Night', Moon], ['auto', 'Auto', Monitor]];
  return (
    <div className="inline-flex rounded-lg border border-bg-border overflow-hidden" role="radiogroup" aria-label="Theme">
      {opts.map(([v, label, Icon]) => (
        <button key={v} role="radio" aria-checked={pref === v} data-testid={`theme-${v}`} onClick={() => setThemePref(v)}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors ${pref === v ? 'bg-accent text-white' : 'text-text-muted hover:text-text hover:bg-bg-hover'}`}>
          <Icon size={13} />{label}
        </button>
      ))}
    </div>
  );
}

function useGlassPref() {
  const [pref, setPref] = useState(() => glassPref());
  useEffect(() => {
    const f = () => setPref(glassPref());
    window.addEventListener('glasschange', f);
    return () => window.removeEventListener('glasschange', f);
  }, []);
  return pref;
}

/** True while Settings › Surfaces is Glass or Vision; follows the switch live. */
export function useGlassOn() {
  const p = useGlassPref();
  return p === 'on' || p === 'vision';
}

/** True while Settings › Surfaces is Vision. */
export function useVisionOn() {
  return useGlassPref() === 'vision';
}

export function GlassChoice() {
  const pref = useGlassPref();
  const opts = [['off', 'Solid', Square], ['on', 'Glass', Sparkles], ['vision', 'Vision', Gem]];
  return (
    <div className="inline-flex rounded-lg border border-bg-border overflow-hidden" role="radiogroup" aria-label="Surfaces">
      {opts.map(([v, label, Icon]) => {
        const sel = pref === v;
        return (
          <button key={v} role="radio" aria-checked={sel} data-testid={`glass-${v}`} onClick={() => setGlassPref(v)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors ${sel ? 'bg-accent text-white' : 'text-text-muted hover:text-text hover:bg-bg-hover'}`}>
            <Icon size={13} />{label}
          </button>
        );
      })}
    </div>
  );
}
