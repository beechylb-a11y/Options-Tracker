import React, { forwardRef, useCallback } from 'react';
import { useLiquidGlass } from '../utils/liquidGlass';
import { useGlassOn } from './ThemeToggle';

// A surface that is liquid glass (panel tier + refraction in Chromium) while
// Settings › Glass is on, and exactly its normal self while off (Nov 2026).
//   glassClass / glassStyle apply only when on; className / style always.
// The refraction mounts with the element, so it works for surfaces that appear
// after sign-in or when a ticket fills in.
const GlassSurface = forwardRef(function GlassSurface({ as: Tag = 'div', className = '', style, glassClass = '', glassStyle, children, ...rest }, outer) {
  const on = useGlassOn();
  const glassRef = useLiquidGlass();
  const ref = useCallback(el => {
    glassRef.current = el;
    if (typeof outer === 'function') outer(el); else if (outer) outer.current = el;
  }, [outer]);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Tag ref={ref} {...rest} data-glass-surface={on ? 'on' : undefined}
      className={on ? ['liquid-glass', glassClass, className].filter(Boolean).join(' ') : className}
      style={on ? { ...style, ...glassStyle } : style}>
      {children}
    </Tag>
  );
});
export default GlassSurface;
