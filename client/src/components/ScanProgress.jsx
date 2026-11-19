import React, { useEffect, useState } from 'react';
import { useScanStatus, summarise, etaText, stopScan, scanStore } from '../utils/scanStatus';

// What a running scan looks like (Nov 2026): a progress pill in place of the Scan
// button (with Stop), a bubble per name on the scan panel, a line across the top of
// the app, a badge on the Engine icon and a chip in the header — so it is obvious
// from any page that a scan is going, how far it has got, and which name it is on.

function useTick(on, ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => { if (!on) return; const h = setInterval(() => set(x => x + 1), ms); return () => clearInterval(h); }, [on, ms]);
}

const BLUE = '#3d82f0';

function Ring({ frac, size = 30 }) {
  const r = size / 2 - 3, c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className="shrink-0">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="3" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round"
        strokeDasharray={`${Math.max(0.04, frac) * c} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
    </svg>
  );
}

/** The Scan button while a scan runs. */
export function ScanPill() {
  const p = useScanStatus();
  useTick(!!(p && p.running));
  if (!p || !p.running) return null;
  const s = summarise(p);
  const pct = Math.round(s.overall * 100);
  return (
    <div data-testid="scan-pill" role="status" aria-live="polite"
      className="scan-pill flex items-center gap-3 pl-2 pr-1.5 py-1.5 rounded-full text-white"
      style={{ background: `linear-gradient(90deg, ${BLUE} ${pct}%, rgba(61,130,240,0.55) ${pct}%)`, boxShadow: '0 10px 28px -12px rgba(61,130,240,0.9)' }}>
      <Ring frac={s.overall} />
      <div className="leading-tight min-w-0">
        <div className="text-[13.5px] font-bold whitespace-nowrap">
          Scanning {p.label} · {s.position || 1} of {s.n}{p.master ? <span className="font-medium opacity-90"> · group {p.master.i}/{p.master.n}</span> : null}
        </div>
        <div className="text-[12px] opacity-90 whitespace-nowrap truncate">
          {s.current ? `${s.current} · ${s.currentStage || 'starting'}` : 'starting'}{s.stalled ? ' · waiting on TWS' : ''}{s.eta != null ? ` · ${etaText(s.eta)}` : ''}
        </div>
      </div>
      <button type="button" onClick={stopScan} data-testid="scan-stop"
        className="ml-1 px-3 py-1 rounded-full text-[12.5px] font-semibold" style={{ background: 'rgba(0,0,0,0.25)', color: '#fff' }}>
        Stop
      </button>
    </div>
  );
}

/** One bubble per name with its stage — on the scan panel. */
export function ScanBubbles() {
  const p = useScanStatus();
  useTick(!!(p && p.running));
  if (!p || !p.running) return null;
  const s = summarise(p);
  const now = Date.now();
  return (
    <div className="card mb-3" data-testid="scan-bubbles">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="text-[15px] font-semibold">Scanning {p.label}</div>
        <div className="text-[12.5px] text-text-muted">Each name: {p.stages.join(' → ')} → score. Two at a time (TWS pacing).</div>
      </div>
      <div className="flex flex-wrap gap-4 mt-4 mb-2">
        {p.order.map(u => {
          const t = p.tickers[u];
          const slow = t.status === 'work' && t.since && now - t.since > 20000;
          const ring = t.status === 'work' ? (slow ? '2px solid #ffd479' : `2px solid ${BLUE}`)
            : t.status === 'done' ? '2px solid rgba(126,226,160,0.85)' : t.status === 'error' ? '2px solid rgba(255,163,154,0.9)' : '2px dashed rgba(140,140,140,0.5)';
          const label = t.status === 'done' ? 'Done' : t.status === 'error' ? 'No data' : t.status === 'work' ? `${p.stages[t.stage] || 'Starting'}${slow ? ' · slow' : ''}` : 'Waiting';
          return (
            <div key={u} className="flex flex-col items-center gap-1.5 w-[92px]" data-testid={'scan-bubble-' + u} data-status={t.status} title={t.error || ''}>
              <div className={`w-14 h-14 rounded-full grid place-items-center text-[12px] font-bold ${t.status === 'work' ? 'scan-bubble-work' : ''}`}
                style={{ border: ring, background: t.status === 'queue' ? 'rgba(140,140,140,0.15)' : '#f1e4d6', color: t.status === 'queue' ? 'var(--c-a8b2be)' : '#2a2622' }}>{u}</div>
              <div className="text-[12px] text-center leading-tight" style={{ color: t.status === 'queue' ? 'var(--c-8b949e)' : 'var(--c-e6edf3)', fontWeight: t.status === 'queue' ? 400 : 600 }}>{label}</div>
            </div>
          );
        })}
      </div>
      <div className="h-2.5 rounded-full overflow-hidden flex" style={{ background: 'rgba(140,140,140,0.2)' }}>
        <div style={{ width: `${(s.done + s.err) / Math.max(1, s.n) * 100}%`, background: 'rgba(126,226,160,0.85)' }} />
        <div style={{ width: `${Math.max(0, s.frac - (s.done + s.err) / Math.max(1, s.n)) * 100}%`, background: BLUE }} />
      </div>
      <div className="flex justify-between text-[12px] text-text-muted mt-1.5 flex-wrap gap-2">
        <span>{s.done} done · {s.work} working · {s.queue} waiting{s.err ? ` · ${s.err} no data` : ''}</span>
        <span>{s.eta != null ? etaText(s.eta) : 'timing…'} · started {new Date(p.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
      </div>
    </div>
  );
}

/** A hairline across the top of the app that fills as the scan runs. */
export function ScanHairline() {
  const p = useScanStatus();
  useTick(!!(p && p.running), 500);
  if (!p || !p.running) return null;
  const s = summarise(p);
  return (
    <div data-testid="scan-hairline" aria-hidden="true" style={{ position: 'fixed', left: 0, right: 0, top: 0, height: 3, zIndex: 60, background: 'rgba(255,255,255,0.10)' }}>
      <div style={{ width: `${Math.max(3, s.overall * 100)}%`, height: '100%', background: `linear-gradient(90deg, ${BLUE}, #6aa8ff)`, boxShadow: '0 0 10px #6aa8ff', transition: 'width 400ms ease' }} />
    </div>
  );
}

/** "3/5" — for the rail and sidebar. Null when no scan runs. */
export function useScanBadge() {
  const p = useScanStatus();
  if (!p || !p.running) return null;
  const s = summarise(p);
  return `${s.position || 1}/${s.n}`;
}

/** Header chip: "● Scanning 3/5" — click goes to the engine. */
export function ScanChip({ onOpen }) {
  const p = useScanStatus();
  if (!p || !p.running) return null;
  const s = summarise(p);
  return (
    <button type="button" onClick={onOpen} data-testid="scan-chip" className="scan-chip inline-flex items-center gap-2 px-3 py-1 rounded-full text-[12.5px] font-semibold"
      style={{ background: 'rgba(61,130,240,0.22)', color: 'var(--c-e6edf3)', border: '1px solid rgba(106,168,255,0.45)' }}>
      <span className="scan-dot" style={{ width: 8, height: 8, borderRadius: '50%', background: '#6aa8ff' }} />
      Scanning {s.position || 1}/{s.n}
    </button>
  );
}

/** When a scan finishes: a card for eight seconds, from any page. */
export function ScanDoneToast({ onOpen }) {
  const p = useScanStatus();
  const [shown, setShown] = useState(null);
  useEffect(() => {
    if (p && !p.running && p.finishedAt && p.summary && shown !== p.finishedAt) {
      setShown(p.finishedAt);
      const h = setTimeout(() => setShown(x => (x === p.finishedAt ? -1 : x)), 8000);
      return () => clearTimeout(h);
    }
  }, [p, shown]);
  if (!p || p.running || !p.summary || shown !== p.finishedAt) return null;
  const m = p.summary;
  return (
    <div data-testid="scan-done" role="status" className="fixed z-[70] right-6 bottom-6 rounded-3xl px-4 py-3 flex items-center gap-3 shadow-2xl border"
      style={{ background: 'rgba(52,50,47,0.94)', borderColor: 'rgba(255,255,255,0.18)', color: '#fff', backdropFilter: 'blur(20px)', maxWidth: 420 }}>
      <div className="w-10 h-10 rounded-full grid place-items-center text-[16px] font-bold shrink-0" style={{ background: m.stopped ? '#ffd479' : '#7ee2a0', color: '#123' }}>{m.stopped ? '■' : '✓'}</div>
      <div className="min-w-0">
        <div className="font-semibold text-[14px]">{m.stopped ? 'Scan stopped' : 'Scan done'} · {m.names} name{m.names === 1 ? '' : 's'} in {m.secs} s</div>
        <div className="text-[12.5px] opacity-85">{m.best ? `Best ${m.best}` : 'No setup scored'}{m.needs ? ` · ${m.needs}` : ''}</div>
      </div>
      {onOpen && <button type="button" onClick={() => { setShown(-1); onOpen(); }} className="px-3 py-1 rounded-full text-[12.5px] font-semibold" style={{ background: BLUE }}>Show results</button>}
      <button type="button" onClick={() => setShown(-1)} aria-label="Dismiss" className="px-2 py-1 rounded-full text-[12.5px] opacity-80 hover:opacity-100">✕</button>
    </div>
  );
}

export { scanStore };
