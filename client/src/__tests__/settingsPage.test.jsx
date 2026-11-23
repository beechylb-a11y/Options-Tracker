/* Settings, grouped by job (23 Nov 2026): contents bar, bridge health strip, account
   cards with a stale-bankroll fix, risk rows edited in place, TWS accounts linked
   from what the bridge sees, an editor panel and a danger zone that asks for the name. */
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

const saveAccounts = vi.fn(() => Promise.resolve({ ok: true }));
const getAccounts = vi.fn(() => Promise.reject(new Error('use the list saved')));
const backfillAccount = vi.fn(() => Promise.resolve({ updated: 4 }));
vi.mock('../utils/api', () => ({ api: { saveAccounts: (...a) => saveAccounts(...a), getAccounts: () => getAccounts(), backfillAccount: (...a) => backfillAccount(...a) } }));
import SettingsPage, { sizingPreview, DEVICE_CACHES } from '../pages/Settings';

const ACCTS = [
  { id: 'papertrade-1', name: 'PaperTrade', startingBankroll: 10000, realisedPnl: 2801, bankroll: 12801, cvarPct: 15 },
  { id: 'live-1', name: 'Live', startingBankroll: 40000, realisedPnl: 0, bankroll: 40000 },
];
const HEALTH = { ok: true, connected: true, app: 'TWS', mode: 'paper', port: 7497, accounts: ['DUQ739754'], startedAt: '2026-11-23T06:19:36Z',
  commit: '8e0fdde', headOnDisk: 'eb7583a', canRestart: true, recentErrors: [] };
const SUMMARY = { accounts: { DUQ739754: { account: 'DUQ739754', netLiq: 32367, paper: true, accountType: 'INDIVIDUAL' }, U2223334: { account: 'U2223334', netLiq: 15420 } }, at: 'x' };

beforeEach(() => {
  localStorage.setItem('bridgeUrl', 'https://bridge.test');
  saveAccounts.mockClear(); backfillAccount.mockClear();
  window.fetch = vi.fn(async url => {
    const body = /health/.test(url) ? HEALTH : /account-summary/.test(url) ? SUMMARY : {};
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  });
});
afterEach(() => { cleanup(); localStorage.clear(); });

const mount = (accounts = ACCTS) => { const onAccountsChange = vi.fn(); render(<SettingsPage authenticated accounts={accounts} onAccountsChange={onAccountsChange} userEmail="v@x" onLogin={() => {}} />); return onAccountsChange; };

describe('Settings page', () => {
  it('contents bar, bridge strip with pulled-but-not-loaded code', async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId('bridge-state').textContent).toBe('Bridge connected'));
    expect(screen.getByTestId('bridge-code').textContent).toMatch(/8e0fdde loaded, eb7583a pulled: restart/);
    expect(screen.getByTestId('nav-accounts').textContent).toMatch(/2 · 2 need a look/);   // Live unlinked, paper stale
    expect(screen.getByTestId('nav-connection').textContent).toMatch(/bridge connected/);
  });

  it('a stale bankroll offers "use net liq", which sets the start so bankroll = net liq', async () => {
    mount();
    await waitFor(() => screen.getByTestId('stale-papertrade-1'));
    expect(screen.getByTestId('acct-gap-papertrade-1').textContent).toBe('+153%');
    fireEvent.click(screen.getByTestId('use-netliq-papertrade-1'));
    await waitFor(() => expect(saveAccounts).toHaveBeenCalled());
    const saved = saveAccounts.mock.calls[0][0].find(a => a.id === 'papertrade-1');
    expect(saved.startingBankroll).toBe(32367 - 2801);
  });

  it('risk row saves only when changed, with a sizing preview', async () => {
    mount();
    expect(screen.getByTestId('risk-preview-papertrade-1').textContent).toMatch(/About 5 of a 5-wide, 1 of a 25-wide/);
    expect(screen.queryByTestId('risk-save-live-1')).toBeNull();
    fireEvent.change(screen.getByTestId('risk-live-1-cvarPct'), { target: { value: '3' } });
    fireEvent.click(screen.getByTestId('risk-save-live-1'));
    await waitFor(() => expect(saveAccounts).toHaveBeenCalled());
    expect(saveAccounts.mock.calls[0][0].find(a => a.id === 'live-1').cvarPct).toBe(3);
  });

  it('links a TWS account the bridge sees, and moves a link off another account', async () => {
    mount([...ACCTS.slice(0, 1), { ...ACCTS[1], twsAccount: 'U9999999' }]);
    await waitFor(() => screen.getByTestId('link-U2223334'));
    expect(screen.getByTestId('link-DUQ739754').textContent).toMatch(/linked \(the one paper account\)/);
    fireEvent.change(screen.getByTestId('link-select-U2223334'), { target: { value: 'live-1' } });
    await waitFor(() => expect(saveAccounts).toHaveBeenCalled());
    expect(saveAccounts.mock.calls[0][0].find(a => a.id === 'live-1').twsAccount).toBe('U2223334');
  });

  it('the editor panel creates an account', async () => {
    mount();
    fireEvent.click(screen.getByTestId('add-account'));
    const panel = screen.getByTestId('account-panel');
    fireEvent.change(panel.querySelector('input'), { target: { value: 'Account 3' } });
    fireEvent.click(screen.getByTestId('panel-save'));
    await waitFor(() => expect(saveAccounts).toHaveBeenCalled());
    const list = saveAccounts.mock.calls[0][0];
    expect(list).toHaveLength(3);
    expect(list[2]).toMatchObject({ name: 'Account 3', cvarPct: 2 });
  });

  it('the danger zone waits for the account name', async () => {
    mount();
    expect(screen.getByTestId('danger-delete').disabled).toBe(true);
    fireEvent.change(screen.getByTestId('danger-account'), { target: { value: 'live-1' } });
    fireEvent.change(screen.getByTestId('danger-confirm'), { target: { value: 'Live' } });
    expect(screen.getByTestId('danger-delete').disabled).toBe(false);
    fireEvent.click(screen.getByTestId('danger-delete'));
    await waitFor(() => expect(saveAccounts).toHaveBeenCalled());
    expect(saveAccounts.mock.calls[0][0].map(a => a.id)).toEqual(['papertrade-1']);
  });

  it('sizing preview and device caches', () => {
    expect(sizingPreview(12801, 15, 40)).toEqual({ cap: 1920, open: 5120, five: 5, twentyFive: 1 });
    expect(DEVICE_CACHES).toContain('sb.marklog.v1');
  });
});
