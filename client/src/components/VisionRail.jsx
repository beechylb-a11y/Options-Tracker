import React from 'react';
import { LogOut } from 'lucide-react';
import mark from '../assets/shadowbook-mark.png';
import { useScanBadge } from './ScanProgress';

// Vision icon rail (Nov 2026). Each icon shows its name in a glass label as soon as
// the pointer is on it (or it has keyboard focus), with the 1–0 shortcut beside it.
// The native title tooltip waited about a second and looked like the OS, so it's gone;
// aria-label still names every button for screen readers.
function RailLabel({ text, hint }) {
  return (
    <span className="vis-rail-label" aria-hidden="true">
      {text}{hint ? <kbd>{hint}</kbd> : null}
    </span>
  );
}

export default function VisionRail({ groups, tab, onTab, onSignOut, userEmail }) {
  const scanBadge = useScanBadge();
  const btn = t => {
    const Icon = t.icon;
    const active = tab === t.id;
    return (
      <button key={t.id} type="button" onClick={() => onTab(t.id)} className="vis-rail-btn" data-testid={`rail-${t.id}`}
        aria-current={active ? 'page' : undefined} aria-label={t.label}>
        <Icon size={20} strokeWidth={1.8} />
        {t.id === 'decision' && scanBadge && <>
          <span className="vis-rail-spin" aria-hidden="true" />
          <span className="vis-rail-badge" data-testid="rail-scan-badge">{scanBadge}</span>
        </>}
        <RailLabel text={t.id === 'decision' && scanBadge ? `${t.label} · scanning ${scanBadge}` : t.label} hint={t.key} />
      </button>
    );
  };
  const all = groups.flatMap(g => g.tabs);
  const settings = all.find(t => t.id === 'settings');
  return (
    <nav className="vis-rail" aria-label="Pages" data-testid="sidebar">
      <div className="vis-rail-brand" data-testid="rail-brand">
        <img src={mark} alt="Shadowbook" width="52" height="52" draggable="false" />
        <RailLabel text="Shadowbook" />
      </div>
      {groups.map((g, gi) => (
        <React.Fragment key={g.label}>
          {gi > 0 && <div className="vis-rail-gap" aria-hidden="true" />}
          {g.tabs.filter(t => t.id !== 'settings').map(btn)}
        </React.Fragment>
      ))}
      <div className="flex-1" />
      {settings && btn(settings)}
      <button type="button" onClick={onSignOut} className="vis-rail-btn" aria-label="Sign out" data-testid="rail-signout">
        <LogOut size={18} strokeWidth={1.8} />
        <RailLabel text={userEmail ? `Sign out · ${userEmail}` : 'Sign out'} />
      </button>
    </nav>
  );
}
