// Page tabs in the Vision top row (Nov 2026). A page that has views of its own (the
// Dashboard: Overview · Open · Expiring · Activity) puts them here and the header
// draws them where the page title would be, as in the Vision design.
import { useSyncExternalStore } from 'react';

let state = null;            // { page, tabs: [[id, label]], value, onChange }
const subs = new Set();
export const topTabs = {
  get: () => state,
  set: next => { state = next; subs.forEach(f => f()); },
  clear: page => { if (!state || !page || state.page === page) { state = null; subs.forEach(f => f()); } },
  subscribe: f => { subs.add(f); return () => subs.delete(f); },
};
export const useTopTabs = () => useSyncExternalStore(topTabs.subscribe, topTabs.get, topTabs.get);
