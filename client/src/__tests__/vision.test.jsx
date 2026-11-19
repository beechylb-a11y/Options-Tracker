/* Vision (Nov 2026), step 1: a third Surfaces choice. It turns glass on as well, adds
   data-vision, puts the page title in the header as a large text tab, and its colours
   hold 4.5:1 on the vision card. */
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('../utils/api', () => ({
  api: { getTracker: async () => [], getDecisions: async () => [], getStats: async () => ({ config: {} }), getOpenPositions: async () => [] },
  clearApiCache: () => {},
}));
import { glassPref, setGlassPref, applyGlass } from '../utils/theme';
import { GlassChoice, useGlassOn, useVisionOn } from '../components/ThemeToggle';
import HeaderStrip from '../components/HeaderStrip';

const html = document.documentElement;
afterEach(() => { cleanup(); localStorage.clear(); html.removeAttribute('data-glass'); html.removeAttribute('data-vision'); });

describe('the Vision choice', () => {
  it('sets data-glass and data-vision, is remembered, and Solid clears both', () => {
    setGlassPref('vision');
    expect(glassPref()).toBe('vision');
    expect(localStorage.getItem('glass')).toBe('vision');
    expect(html.getAttribute('data-glass')).toBe('on');
    expect(html.getAttribute('data-vision')).toBe('on');
    setGlassPref('on');
    expect(html.hasAttribute('data-vision')).toBe(false);
    expect(html.getAttribute('data-glass')).toBe('on');
    setGlassPref('off');
    expect(html.hasAttribute('data-glass')).toBe(false);
  });
  it('an unknown stored value reads as Solid', () => {
    localStorage.setItem('glass', 'sparkly');
    expect(glassPref()).toBe('off');
    applyGlass();
    expect(html.hasAttribute('data-glass')).toBe(false);
  });
  it('Settings offers Solid / Glass / Vision; Vision counts as glass on', () => {
    function Probe() { return <span data-testid="probe">{`${useGlassOn()}/${useVisionOn()}`}</span>; }
    render(<><GlassChoice /><Probe /></>);
    expect(screen.getByTestId('probe').textContent).toBe('false/false');
    fireEvent.click(screen.getByTestId('glass-vision'));
    expect(screen.getByTestId('glass-vision').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('glass-on').getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('probe').textContent).toBe('true/true');
  });
});

describe('the header in Vision', () => {
  it('shows the page title as a text tab and drops the bar', async () => {
    const { rerender } = render(<HeaderStrip authenticated accounts={[]} account="all" onAccountChange={() => {}} title="Dashboard" />);
    expect(screen.queryByTestId('vision-title')).toBeNull();
    act(() => setGlassPref('vision'));
    rerender(<HeaderStrip authenticated accounts={[]} account="all" onAccountChange={() => {}} title="Dashboard" />);
    await waitFor(() => expect(screen.getByTestId('vision-title').textContent).toBe('Dashboard'));
    const strip = screen.getByTestId('header-strip');
    expect(strip.className).toContain('vis-top');
    expect(strip.className).not.toContain('liquid-glass');
    expect(strip.style.backdropFilter || '').toBe('');
  });
});

describe('vision.css contrast', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../styles/vision.css'), 'utf8');
  const lum = hex => {
    const v = hex.replace('#', '').match(/../g).map(h => parseInt(h, 16) / 255)
      .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const val = name => (css.match(new RegExp(`--c-${name}:\\s*(#[0-9a-f]{6})`)) || [])[1];
  const CARD = '#4d4a46';
  it('text and status colours hold 4.5:1 on the vision card', () => {
    for (const n of ['e6edf3', 'a8b2be', '8b949e', '3fb950', 'f85149', 'd29922', '2f81f7', 'bc8cff', '58a6ff', '39c5cf', 'f0883e', '6e7681']) {
      expect(val(n), n).toBeTruthy();
      expect(ratio(val(n), CARD), n).toBeGreaterThanOrEqual(4.5);
    }
  });
  it('text on an accent chip uses the dark on-accent colour, which holds 4.5:1 on every pastel', () => {
    expect(css).toMatch(/--c-on-accent:\s*#1c1b19/);
    for (const n of ['3fb950', 'f85149', 'd29922', '2f81f7', '8b949e']) expect(ratio('#1c1b19', val(n)), n).toBeGreaterThanOrEqual(4.5);
  });
  it('white button text holds 4.5:1 on the deeper filled-button shades', () => {
    for (const fill of ['#2a6cd6', '#2f6fd8', '#237f3b', '#c33a36']) {
      expect(css).toContain(fill);
      expect(ratio('#ffffff', fill), fill).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('vision.css step 2: controls', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../styles/vision.css'), 'utf8');
  const root = postcss.parse(css);   // throws on an unclosed comment or string
  const rules = [];
  root.walkRules(r => rules.push(r));
  const find = re => rules.filter(r => re.test(r.selector));
  it('parses, and every rule is gated on Vision', () => {
    expect(rules.length).toBeGreaterThan(40);
    for (const r of rules) {
      if (r.parent && r.parent.type === 'atrule' && /keyframes/.test(r.parent.name)) continue;
      expect(r.selector, r.selector).toMatch(/:root\[data-vision="on"\]:not\(#_\)/);
    }
  });
  it('bordered label buttons become pills; buttons holding blocks keep their card shape', () => {
    const pill = find(/:is\(button, label\.cursor-pointer\)/).find(r => r.nodes.some(d => d.prop === 'border-radius' && d.value === '999px'));
    expect(pill).toBeTruthy();
    expect(pill.selector).toContain(':not(:has(div, p, table))');
    const neutral = find(/\.border-bg-border$/).find(r => r.selector.includes('label.cursor-pointer'));
    expect(neutral.nodes.find(d => d.prop === 'background-color').value).toMatch(/rgba\(255, 255, 255/);
  });
  it('segmented tracks: the chosen segment is a near-white pill with dark text', () => {
    const on = find(/\[aria-checked="true"\]/)[0];
    expect(on.selector).toContain('[role="radiogroup"]');
    expect(on.nodes.find(d => d.prop === 'color').value).toBe('#1c1b19');
  });
  it('inputs are wells, except the header account picker', () => {
    const well = find(/select, textarea\):not\(\.hdr-select\)$/)[0];
    expect(well).toBeTruthy();
    expect(well.nodes.find(d => d.prop === 'border-radius').value).toMatch(/12px/);
  });
});

describe('vision.css step 3: no solid insides', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../styles/vision.css'), 'utf8');
  const rules = []; postcss.parse(css).walkRules(r => rules.push(r));
  const decl = (r, prop) => (r.nodes.find(d => d.prop === prop) || {}).value;
  const top = rules.find(r => r.selector === ':root[data-vision="on"]:not(#_)');
  it('the page and well colours are see-through washes', () => {
    expect(decl(top, '--c-0d1117')).toMatch(/^rgba\(0, 0, 0, 0\.1\d\)/);
    expect(decl(top, '--c-010409')).toMatch(/^rgba\(0, 0, 0,/);
    const bg = rules.find(r => /\.bg-bg$/.test(r.selector) && !r.selector.includes(':is('));
    expect(decl(bg, 'background-color')).toMatch(/^rgba\(0, 0, 0,/);
  });
  it('floating layers and charts re-declare the surfaces opaque', () => {
    const scope = rules.find(r => r.nodes.some(d => d.prop === '--c-0d1117') && r !== top);
    for (const s of ['.absolute', '.fixed', '[role="tooltip"]', '[role="menu"]', '[role="dialog"]', 'svg']) expect(scope.selector).toContain(s);
    for (const v of ['--c-0d1117', '--c-161b22', '--c-1c2128', '--c-30363d']) expect(decl(scope, v), v).toMatch(/^#[0-9a-f]{6}$/);
  });
  it('bordered boxes in a card take 18px corners; glass surfaces and split halves keep theirs', () => {
    const inline = rules.find(r => r.selector.startsWith(':root[data-vision="on"]:not(#_) div[style*="border"][style*="border-radius"]'));
    const rad = inline.nodes.find(d => d.prop === 'border-radius');
    expect(rad.value).toBe('18px');
    expect(rad.important).toBe(true);
    expect(inline.selector).toContain(':not([style*="px 0"])');
    expect(inline.selector).toContain(':not(.liquid-glass)');
  });
});

describe('vision.css step 4: layouts', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../styles/vision.css'), 'utf8');
  const rules = []; postcss.parse(css).walkRules(r => rules.push(r));
  it("each page's own heading steps aside for the top-row title", () => {
    const r = rules.find(x => x.selector.endsWith(' .page-title'));
    expect(r.nodes.find(d => d.prop === 'display').value).toBe('none');
  });
  it('every page heading carries the page-title class', () => {
    const dir = path.resolve(__dirname, '../pages');
    for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.jsx'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      const all = (src.match(/<h2 className="[^"]*(font-display text-2xl|text-2xl font-display)[^"]*"/g) || []);
      for (const h of all) expect(h, f).toContain('page-title');
    }
  });
  it('the engine stats sit in a 2×2 grid at headline size', () => {
    const grid = rules.find(x => x.selector.endsWith('[data-testid="edge-row"]'));
    expect(grid.nodes.find(d => d.prop === 'grid-template-columns').value).toBe('repeat(2, minmax(0, 1fr))');
    const num = rules.find(x => x.selector.endsWith('[data-testid="edge-row"] > div > div.mono'));
    expect(num.nodes.find(d => d.prop === 'font-size').value).toBe('26px');
  });
});

describe('vision.css step 5: the other tabs', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../styles/vision.css'), 'utf8');
  const rules = []; postcss.parse(css).walkRules(r => rules.push(r));
  const decl = (r, p) => (r.nodes.find(d => d.prop === p) || {}).value;
  it('a card holding a table is a denser data panel; column heads in sentence case', () => {
    const panel = rules.find(r => r.selector.endsWith(':is(.card, .kpi):has(table)'));
    expect(decl(panel, 'background')).toMatch(/rgba\(6\d, 5\d, 5\d, 0\.6\d\)/);
    const th = rules.find(r => r.selector.endsWith(' table th'));
    expect(decl(th, 'text-transform')).toBe('none');
  });
  it('print keeps white paper and dark text, with no rail or top row', () => {
    const inPrint = rules.filter(r => r.parent.type === 'atrule' && r.parent.name === 'media' && r.parent.params === 'print');
    expect(inPrint.some(r => r.selector.includes('.vis-rail') && decl(r, 'display') === 'none')).toBe(true);
    expect(inPrint.some(r => r.selector.includes('.vis-main *') && /#1f2328/.test(decl(r, 'color')))).toBe(true);
    expect(inPrint.some(r => r.selector.includes(':is(.card, .kpi, .liquid-glass)') && /#fff/.test(decl(r, 'background')))).toBe(true);
  });
});

