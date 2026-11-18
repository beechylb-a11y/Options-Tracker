import React from 'react';
import { useLiquidGlass } from '../utils/liquidGlass';
import { useGlassOn } from './ThemeToggle';

// One modal for every pop-up (Nov 2026): Close, Edit ticket, Fill reconcile, the order
// ticket and trade details used to draw their own overlay. With Settings › Glass on
// it is the modal tier — frosted panel on a blurred scrim, refraction in Chromium;
// off, it is exactly the old solid panel on a 60% black overlay.
export default function Modal({ onClose, width, testid, zIndex = 9999, padding = 20, maxWidth = '96vw', maxHeight = '92vh', panelStyle, children }) {
  const glass = useGlassOn();
  const ref = useLiquidGlass();
  return (
    <div data-testid="modal-scrim" className={glass ? 'liquid-glass-scrim' : undefined} onClick={onClose}
      style={glass ? { zIndex } : { position: 'fixed', inset: 0, zIndex, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)' }}>
      <div ref={ref} data-testid={testid} role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}
        className={glass ? 'liquid-glass liquid-glass--modal' : undefined}
        style={{ ...(glass ? {} : { background: 'var(--c-161b22)', border: '1px solid var(--c-30363d)', borderRadius: 12 }),
          padding, width, maxWidth, maxHeight, overflow: 'auto', ...panelStyle }}>
        {children}
      </div>
    </div>
  );
}
