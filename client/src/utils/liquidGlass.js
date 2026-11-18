/*!
 * Liquid Glass — refraction layer, React port (Shadowbook, Nov 2026).
 *
 * The refraction field is a port of the fragment shader in liquid-glass-js
 * (https://github.com/dashersw/liquid-glass-js) — Copyright (c) 2025 Armagan
 * Amcalar, MIT. Permission is hereby granted, free of charge, to any person
 * obtaining a copy of that software to deal in it without restriction,
 * provided this notice travels with it; it is provided "as is", without
 * warranty of any kind. Keep this header on any copy or port.
 *
 * Transcribed from stormaref/LiquidGlassSkill's Angular directive. Pair with
 * the `.liquid-glass` class (styles/glass.css):
 *
 *   const ref = useLiquidGlass();
 *   <div ref={ref} className="liquid-glass">…</div>
 *
 * Chromium only. Safari parses `backdrop-filter: url(#…)` and paints nothing,
 * so this gates on engine and does nothing elsewhere — the stylesheet's
 * blur(3px) saturate(125%) fallback stays in effect.
 */
import { useEffect, useRef } from 'react';

export const GLASS_PRESET = {
  edgeIntensity: 0.015,
  rimIntensity: 0.028,
  baseIntensity: 0.05,
  edgeDistance: 0.5,
  rimDistance: 1.7,
  baseDistance: 0.2,
  cornerBoost: 0.06,
  rippleEffect: 0.26,
  blurRadius: 2,
  warp: false, // centre warp off: text under the middle of a panel stays legible
};

const SUPERSAMPLE = 2;          // the rim lives in a 1–2px band; 1x smears it
const MAX_MAP_EDGE = 1400;      // bound the bake for wide/tall surfaces (sidebar, header)
const BLUR_STD_PER_RADIUS = 0.35;
const SVG_NS = 'http://www.w3.org/2000/svg';

const filters = new Map();      // key -> { id, node, refs }
let defs = null;
let nextId = 0;

/** SVG-referenced backdrop filters render in Chromium only. Can't feature-query it. */
export function glassSupported() {
  if (typeof navigator === 'undefined') return false;
  // Shadowbook: Settings › Glass off, or the OS asks for less transparency.
  try { if (document.documentElement.dataset.glass !== 'on') return false; } catch { /* ssr */ }
  try { if (matchMedia('(prefers-reduced-transparency: reduce)').matches) return false; } catch { /* old engine */ }
  const brands = navigator.userAgentData && navigator.userAgentData.brands;
  if (brands) return brands.some(b => /Chromium|Google Chrome|Microsoft Edge/i.test(b.brand));
  return /Chrome\//.test(navigator.userAgent);
}

function ensureDefs() {
  if (!defs || !defs.isConnected) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.position = 'fixed';
    svg.appendChild(document.createElementNS(SVG_NS, 'defs'));
    document.body.appendChild(svg);
    defs = svg;
  }
  return defs;
}

const clampByte = v => Math.max(0, Math.min(255, Math.round(v)));
const resolveRadius = (computed, w, h) => {
  const v = parseFloat(computed) || 0;
  return String(computed).trim().endsWith('%') ? (v / 100) * Math.min(w, h) : v;
};

/** Bake the refraction field into an R/G displacement map. Formulas 1:1 from container.js. */
export function buildDisplacementMap(w, h, radius, pageW, pageH, cfg) {
  const ss = Math.max(0.25, Math.min(SUPERSAMPLE, MAX_MAP_EDGE / Math.max(w, h)));
  const bw = Math.max(1, Math.round(w * ss));
  const bh = Math.max(1, Math.round(h * ss));
  const r = radius * ss;
  const minDim = Math.min(w, h);
  const dx = new Float32Array(bw * bh);
  const dy = new Float32Array(bw * bh);
  let maxAbs = 0;

  for (let py = 0; py < bh; py++) {
    for (let px = 0; px < bw; px++) {
      const cx = (px + 0.5) / bw;
      const cy = (py + 0.5) / bh;
      const tx = Math.abs(px + 0.5 - bw / 2) - (bw / 2 - r);
      const ty = Math.abs(py + 0.5 - bh / 2) - (bh / 2 - r);
      const outside = Math.hypot(Math.max(tx, 0), Math.max(ty, 0));
      const inside = Math.min(Math.max(tx, ty), 0);
      const distPx = Math.max(-(outside + inside - r), 0) / ss;

      const edgeFall = Math.exp(-distPx * cfg.edgeDistance);
      const rimFall = Math.exp(-distPx * cfg.rimDistance);
      const baseFall = 1 - Math.exp(-distPx * cfg.baseDistance);
      const total = (cfg.warp ? baseFall * cfg.baseIntensity : 0) + edgeFall * cfg.edgeIntensity + rimFall * cfg.rimIntensity;

      let nx = cx - 0.5, ny = cy - 0.5;
      const len = Math.hypot(nx, ny);
      if (len > 0) { nx /= len; ny /= len; }
      const corner = Math.exp(-(Math.max(Math.min(cx, 1 - cx), Math.min(cy, 1 - cy)) * minDim) * 0.3) * cfg.cornerBoost;
      const ripple = Math.sin((distPx / minDim) * 25) * cfg.rippleEffect * rimFall;

      const fx = (nx * (total + corner) - ny * ripple) * pageW;
      const fy = (ny * (total + corner) + nx * ripple) * pageH;
      const i = py * bw + px;
      dx[i] = fx; dy[i] = fy;
      maxAbs = Math.max(maxAbs, Math.abs(fx), Math.abs(fy));
    }
  }

  const scale = Math.max(maxAbs * 2, 1e-4);
  const bias = scale * (128 / 255 - 0.5); // 128 is not zero after decode — pre-subtract
  const canvas = document.createElement('canvas');
  canvas.width = bw; canvas.height = bh;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(bw, bh);
  const d = img.data;
  for (let i = 0; i < bw * bh; i++) {
    d[i * 4] = clampByte(255 * (0.5 + (dx[i] - bias) / scale));
    d[i * 4 + 1] = clampByte(255 * (0.5 + (dy[i] - bias) / scale));
    d[i * 4 + 2] = 128;
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return { mapUrl: canvas.toDataURL('image/png'), scale };
}

function acquireFilter(key, w, h, radius, pageW, pageH, cfg) {
  let entry = filters.get(key);
  if (entry && entry.node.isConnected) { entry.refs++; return entry; }
  if (entry) filters.delete(key);

  const { mapUrl, scale } = buildDisplacementMap(w, h, radius, pageW, pageH, cfg);
  const id = `liquid-glass-${nextId++}`;
  const filter = document.createElementNS(SVG_NS, 'filter');
  filter.setAttribute('id', id);
  // Region must extend past the box by the max sample offset + blur spread, or
  // the corners clip to transparent. Size it from the field, not a fixed %.
  const margin = scale / 2 + 3 * cfg.blurRadius * BLUR_STD_PER_RADIUS;
  const mx = (margin / w) * 100, my = (margin / h) * 100;
  filter.setAttribute('x', `${-mx}%`);
  filter.setAttribute('y', `${-my}%`);
  filter.setAttribute('width', `${100 + 2 * mx}%`);
  filter.setAttribute('height', `${100 + 2 * my}%`);
  filter.setAttribute('color-interpolation-filters', 'sRGB');

  const feImage = document.createElementNS(SVG_NS, 'feImage');
  feImage.setAttribute('href', mapUrl);
  feImage.setAttribute('x', '0');
  feImage.setAttribute('y', '0');
  feImage.setAttribute('width', String(w));
  feImage.setAttribute('height', String(h));
  feImage.setAttribute('preserveAspectRatio', 'none');
  feImage.setAttribute('result', 'map');

  const feDisp = document.createElementNS(SVG_NS, 'feDisplacementMap');
  feDisp.setAttribute('in', 'SourceGraphic');
  feDisp.setAttribute('in2', 'map');
  feDisp.setAttribute('scale', String(scale));
  feDisp.setAttribute('xChannelSelector', 'R');
  feDisp.setAttribute('yChannelSelector', 'G');
  feDisp.setAttribute('result', 'displaced');

  const feBlur = document.createElementNS(SVG_NS, 'feGaussianBlur');
  feBlur.setAttribute('in', 'displaced');
  feBlur.setAttribute('stdDeviation', String(cfg.blurRadius * BLUR_STD_PER_RADIUS));

  filter.append(feImage, feDisp, feBlur);
  ensureDefs().querySelector('defs').appendChild(filter);
  entry = { id, node: filter, refs: 1 };
  filters.set(key, entry);
  return entry;
}

function releaseFilter(key) {
  const entry = filters.get(key);
  if (entry && --entry.refs <= 0) { filters.delete(key); entry.node.remove(); }
}

/**
 * Attach refraction to one element. Returns a cleanup function.
 * `settleMs` debounces element resizes: Shadowbook panels change height as bridge
 * data streams in, and a 2200×600 bake is ~20–40 ms — rebaking every poll janks.
 */
export function attachLiquidGlass(el, overrides = {}, { settleMs = 120 } = {}) {
  if (!el || !glassSupported()) return () => {};
  const cfg = { ...GLASS_PRESET, ...overrides };
  const cfgKey = JSON.stringify(cfg);
  let currentKey = null, frame = 0, elTimer, winTimer;

  const rebuild = () => {
    const w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight);
    if (w < 2 || h < 2) return;
    const radius = Math.min(resolveRadius(getComputedStyle(el).borderTopLeftRadius, w, h), Math.min(w, h) / 2);
    const pageW = window.innerWidth, pageH = window.innerHeight;
    const key = [w, h, radius, pageW, pageH, cfgKey].join('|');
    if (key === currentKey) return;
    if (currentKey) releaseFilter(currentKey);
    const entry = acquireFilter(key, w, h, radius, pageW, pageH, cfg);
    currentKey = key;
    el.style.backdropFilter = `url(#${entry.id})`;
  };
  const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(rebuild); };
  const onElResize = () => { clearTimeout(elTimer); elTimer = setTimeout(schedule, settleMs); };
  const onWinResize = () => { clearTimeout(winTimer); winTimer = setTimeout(schedule, 180); };

  const ro = new ResizeObserver(onElResize);
  ro.observe(el);
  window.addEventListener('resize', onWinResize, { passive: true });
  schedule();

  return () => {
    ro.disconnect();
    window.removeEventListener('resize', onWinResize);
    clearTimeout(elTimer); clearTimeout(winTimer);
    cancelAnimationFrame(frame);
    if (currentKey) releaseFilter(currentKey);
    currentKey = null;
    el.style.backdropFilter = '';
  };
}

/**
 * React hook: `const ref = useLiquidGlass(); <div ref={ref} className="liquid-glass">`.
 * Runs outside React state — observers fire constantly and touch nothing bound.
 * Re-attaches when Settings › Glass flips (the 'glasschange' event).
 */
export function useLiquidGlass(overrides) {
  const ref = useRef(null);
  const key = overrides ? JSON.stringify(overrides) : '';
  useEffect(() => {
    let cleanup = attachLiquidGlass(ref.current, overrides);
    const onToggle = () => { cleanup(); cleanup = attachLiquidGlass(ref.current, overrides); };
    window.addEventListener('glasschange', onToggle);
    return () => { window.removeEventListener('glasschange', onToggle); cleanup(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return ref;
}
