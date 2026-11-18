/* Vision rail (Nov 2026): the brand badge at the top, every page as an icon with a
   hover label (name + shortcut), Settings and sign-out at the foot. */
import React from 'react';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { LayoutDashboard, Brain, BookOpen, Settings } from 'lucide-react';
import VisionRail from '../components/VisionRail';

afterEach(() => cleanup());
const groups = [
  { label: 'Trade', tabs: [{ id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, key: '1' }, { id: 'decision', label: 'Decision Engine', icon: Brain, key: '2' }] },
  { label: 'Reference', tabs: [{ id: 'journal', label: 'Journal', icon: BookOpen, key: '4' }, { id: 'settings', label: 'Settings', icon: Settings, key: '0' }] },
];

describe('vision rail', () => {
  it('shows the brand badge, not a letter', () => {
    render(<VisionRail groups={groups} tab="dashboard" onTab={() => {}} onSignOut={() => {}} />);
    const brand = screen.getByTestId('rail-brand');
    const img = within(brand).getByRole('img');
    expect(img.getAttribute('alt')).toBe('Shadowbook');
    expect(img.getAttribute('src')).toMatch(/shadowbook-mark/);
    expect(brand.textContent).not.toMatch(/^S$/);
  });
  it('every icon carries a hover label with its name and shortcut, and no slow native tooltip', () => {
    render(<VisionRail groups={groups} tab="decision" onTab={() => {}} onSignOut={() => {}} userEmail="v@x.com" />);
    const eng = screen.getByTestId('rail-decision');
    expect(eng.getAttribute('aria-label')).toBe('Decision Engine');
    expect(eng.hasAttribute('title')).toBe(false);
    const label = eng.querySelector('.vis-rail-label');
    expect(label.getAttribute('aria-hidden')).toBe('true');
    expect(label.textContent).toBe('Decision Engine2');
    expect(label.querySelector('kbd').textContent).toBe('2');
    expect(eng.getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('rail-dashboard').hasAttribute('aria-current')).toBe(false);
    expect(screen.getByTestId('rail-signout').querySelector('.vis-rail-label').textContent).toBe('Sign out · v@x.com');
  });
  it('Settings sits at the foot after the pages, and clicks switch tabs or sign out', () => {
    const onTab = vi.fn(), onSignOut = vi.fn();
    render(<VisionRail groups={groups} tab="dashboard" onTab={onTab} onSignOut={onSignOut} />);
    const ids = [...screen.getByTestId('sidebar').querySelectorAll('[data-testid^="rail-"]')].map(e => e.dataset.testid);
    expect(ids).toEqual(['rail-brand', 'rail-dashboard', 'rail-decision', 'rail-journal', 'rail-settings', 'rail-signout']);
    fireEvent.click(screen.getByTestId('rail-journal'));
    expect(onTab).toHaveBeenCalledWith('journal');
    fireEvent.click(screen.getByTestId('rail-signout'));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});
