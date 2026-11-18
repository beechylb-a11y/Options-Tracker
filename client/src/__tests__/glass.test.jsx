/* Liquid glass, phase 5 (Nov 2026): a Settings switch (off by default) puts the
   sidebar, header strip, verdict band, manage strip and every pop-up on glass; off,
   each is exactly the solid surface it was. */
import React, { createRef } from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { glassPref, setGlassPref, applyGlass } from '../utils/theme';
import { GlassChoice, useGlassOn } from '../components/ThemeToggle';
import Modal from '../components/Modal';
import GlassSurface from '../components/GlassSurface';
import { glassSupported } from '../utils/liquidGlass';

afterEach(() => { cleanup(); localStorage.clear(); document.documentElement.removeAttribute('data-glass'); });

describe('the switch', () => {
  it('is off by default and sets data-glass on <html>, remembered per browser', () => {
    expect(glassPref()).toBe('off');
    applyGlass();
    expect(document.documentElement.hasAttribute('data-glass')).toBe(false);
    const heard = vi.fn();
    window.addEventListener('glasschange', heard);
    setGlassPref('on');
    expect(document.documentElement.getAttribute('data-glass')).toBe('on');
    expect(localStorage.getItem('glass')).toBe('on');
    expect(heard).toHaveBeenCalledTimes(1);
    setGlassPref('off');
    expect(document.documentElement.hasAttribute('data-glass')).toBe(false);
    window.removeEventListener('glasschange', heard);
  });
  it('Settings offers Solid / Glass and follows the choice live', () => {
    function Probe() { return <span data-testid="probe">{useGlassOn() ? 'on' : 'off'}</span>; }
    render(<><GlassChoice /><Probe /></>);
    expect(screen.getByTestId('glass-off').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByTestId('glass-on'));
    expect(screen.getByTestId('probe').textContent).toBe('on');
    expect(screen.getByTestId('glass-on').getAttribute('aria-checked')).toBe('true');
  });
  it('refraction only in Chromium with glass on (jsdom is neither)', () => {
    expect(glassSupported()).toBe(false);
  });
});

describe('one modal for every pop-up', () => {
  it('off: the old 60% overlay and solid panel; clicking outside closes, inside does not', () => {
    const onClose = vi.fn();
    render(<Modal onClose={onClose} width={560} testid="m"><button>inside</button></Modal>);
    const scrim = screen.getByTestId('modal-scrim');
    expect(scrim.style.background).toMatch(/rgba\(0, 0, 0, 0\.6\)/);
    expect(screen.getByTestId('m').className).toBe('');
    expect(screen.getByTestId('m').style.width).toBe('560px');
    fireEvent.click(screen.getByText('inside'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it('on: the glass scrim and the modal tier', () => {
    setGlassPref('on');
    render(<Modal onClose={() => {}} testid="m">x</Modal>);
    expect(screen.getByTestId('modal-scrim').className).toBe('liquid-glass-scrim');
    expect(screen.getByTestId('m').className).toBe('liquid-glass liquid-glass--modal');
    expect(screen.getByTestId('m').getAttribute('role')).toBe('dialog');
  });
});

describe('glass surfaces', () => {
  it('are unchanged with glass off, and take the glass class and style with it on', () => {
    const ref = createRef();
    render(<GlassSurface ref={ref} data-testid="s" className="card" style={{ padding: 4 }} glassStyle={{ borderRadius: 22 }}>hi</GlassSurface>);
    const el = screen.getByTestId('s');
    expect(ref.current).toBe(el);
    expect(el.className).toBe('card');
    expect(el.style.borderRadius).toBe('');
    act(() => setGlassPref('on'));
    expect(el.className).toBe('liquid-glass card');
    expect(el.style.borderRadius).toBe('22px');
    expect(el.style.padding).toBe('4px');
  });
});
