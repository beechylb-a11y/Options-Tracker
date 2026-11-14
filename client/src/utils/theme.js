// ── Day / night theme (Nov 2026) ──
//
// Colours are CSS variables (index.css). The theme is one attribute on <html>:
// data-theme="light" for day mode, absent for night. The choice is remembered per
// browser; "auto" follows the computer's own light/dark setting.

const KEY = 'theme';
const mq = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null);

export function themePref() {
  try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' || v === 'auto' ? v : 'dark'; } catch { return 'dark'; }
}

/** The theme actually showing: 'light' | 'dark'. */
export function resolvedTheme(pref = themePref()) {
  if (pref === 'auto') { const m = mq(); return m && m.matches ? 'light' : 'dark'; }
  return pref;
}

export function applyTheme(pref = themePref()) {
  if (typeof document === 'undefined') return;
  const t = resolvedTheme(pref);
  if (t === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
}

export function setThemePref(pref) {
  try { localStorage.setItem(KEY, pref); } catch { /* private window: still applies for this visit */ }
  applyTheme(pref);
  try { window.dispatchEvent(new CustomEvent('themechange', { detail: pref })); } catch { /* old browser */ }
}

/** Follow the computer's setting while on "auto". Call once at start-up. */
export function watchSystemTheme() {
  const m = mq();
  if (!m || !m.addEventListener) return;
  m.addEventListener('change', () => { if (themePref() === 'auto') applyTheme('auto'); });
}

/**
 * A colour with transparency. Colours used to be hex, and the code appended two hex
 * digits for alpha (col + '22'); a CSS variable can't take that, so mix it instead.
 */
export function alpha(c, aa) {
  const s = String(c || '');
  if (/^#[0-9a-f]{6}$/i.test(s)) return s + aa;
  const pct = Math.round(parseInt(aa, 16) / 2.55);
  return `color-mix(in srgb, ${s} ${pct}%, transparent)`;
}

/**
 * The current colour values as a :root block — for a pop-up window (printed report,
 * exported table) whose HTML is written by hand and has no stylesheet of its own.
 */
export function themeVarsCss() {
  if (typeof document === 'undefined' || typeof getComputedStyle === 'undefined') return '';
  const out = [];
  try {
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch { continue; }
      for (const r of rules) {
        if (r.selectorText !== ':root' || !r.style) continue;
        for (const name of r.style) if (name.startsWith('--c-')) out.push(name);
      }
    }
  } catch { /* fall through with what we have */ }
  const cs = getComputedStyle(document.documentElement);
  return ':root{' + [...new Set(out)].map(n => `${n}:${cs.getPropertyValue(n).trim()}`).join(';') + '}';
}
