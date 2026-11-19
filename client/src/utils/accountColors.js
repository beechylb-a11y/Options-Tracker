// ── Account colours (Nov 2026) ──
//
// With several accounts on one screen, each gets its own colour: it rings the ticker,
// tints the account tag, the account's risk bar and its ring on the monthly target.
// Picked in Settings (stored on the account as `color`); an account without one takes
// the palette slot of its position in the list, so colours are stable and distinct
// before anyone picks.
//
// The accounts list also lives here as a tiny store, so the boards can name and colour
// an account without threading the list through every page.

import { useSyncExternalStore } from 'react';

export const ACCOUNT_PALETTE = ['#6aa8ff', '#ffa657', '#c39bff', '#3fd0b6', '#ff8fb8', '#d6c656'];

let list = [];
const subs = new Set();
export function setAccountsList(accounts) {
  list = Array.isArray(accounts) ? accounts : [];
  subs.forEach(f => f());
}
export function getAccountsList() { return list; }
export function useAccountsList() {
  return useSyncExternalStore(f => { subs.add(f); return () => subs.delete(f); }, () => list, () => list);
}

const okHex = c => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);

/** The account's colour: its own pick, else its palette slot. */
export function accountColor(idOrAcct, accounts = list) {
  const id = typeof idOrAcct === 'object' && idOrAcct ? idOrAcct.id : idOrAcct;
  const all = Array.isArray(accounts) ? accounts : [];
  const i = all.findIndex(a => a.id === id);
  const a = i >= 0 ? all[i] : (typeof idOrAcct === 'object' ? idOrAcct : null);
  if (a && okHex(a.color)) return a.color;
  if (i < 0) return 'var(--c-8b949e)';
  return ACCOUNT_PALETTE[i % ACCOUNT_PALETTE.length];
}

export function accountName(id, accounts = list) {
  const a = (Array.isArray(accounts) ? accounts : []).find(x => x.id === id);
  return a ? a.name : (id || '');
}
