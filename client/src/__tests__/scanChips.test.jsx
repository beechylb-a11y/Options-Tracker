/* The number on a scan name is its IV rank, and the scan's own (Nov 2026). */
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
vi.mock('../utils/api', () => ({ api: {} }));
import { MultiScanPanel } from '../pages/DecisionEngine';
import { computeScan } from '../utils/multiScan';

afterEach(() => cleanup());

describe('scan name chips', () => {
  const base = { mode: '45dte', cls: 'etf', classLabel: 'ETFs', busy: false, master: null, now: Date.now(), underlyings: ['SPY', 'QQQ'],
    why: { QQQ: 'IVR 81', SPY: 'pinned' }, onEditWatchlist: () => {}, onScan: () => {}, onScanAll: () => {}, onRecalc: () => {},
    otherScans: [], onOpenGroup: () => {}, onSelect: () => {} };
  it('before a scan: the watchlist IV rank, labelled', () => {
    render(<MultiScanPanel {...base} scan={null} />);
    expect(screen.getByTestId('scan-name-QQQ').textContent).toBe('QQQ IVR 81');
    expect(screen.getByTestId('scan-name-SPY').textContent).toBe('SPY');
  });
  it('after a scan: the scan’s IV rank, so the chip matches the table', () => {
    const data = { QQQ: { price: '658', ivr: '86.2', iv: '27', hv: '24.45' }, SPY: { price: '730', ivr: '59', iv: '20', hv: '18' } };
    const results = computeScan('45dte', ['SPY', 'QQQ'], data);
    render(<MultiScanPanel {...base} scan={{ results, meta: {}, scannedAt: new Date().toISOString(), manualData: data }} />);
    expect(screen.getByTestId('scan-name-QQQ').textContent).toBe('QQQ IVR 86');
    expect(screen.getByTestId('scan-name-SPY').textContent).toBe('SPY IVR 59');
    expect(screen.getByTestId('scan-name-QQQ').getAttribute('title')).toMatch(/IV rank 86%, from this scan/);
  });
});
