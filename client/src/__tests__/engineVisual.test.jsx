/* Decision Engine verdict and order card (Oct 2026): one title line, one edge row
   with one name per number, and the exit plan visible before logging. */
import React from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { VerdictTitle, EdgeRow, ExitPlanStrip, MoreMenu } from '../components/EngineVisual';

afterEach(cleanup);

describe('engine verdict and order card', () => {
  it('title line: verdict badge, then the trade on one line', () => {
    render(<VerdictTitle word="Take the trade" tone="#3fb950" underlying="SPX" strikes={[7350, 7370]} strategy="Bull put spread" qty={2} expiry="20261027" />);
    expect(screen.getByTestId('verdict').textContent).toBe('Take the trade');
    expect(screen.getByTestId('verdict-title').textContent).toBe('SPX 7350/7370Bull put spread2 ct27 Oct');
  });
  it('edge row names each number once', () => {
    render(<EdgeRow ev={86} pml={0.159} pop={80} kellyCt={1} kellyDollar={3886} />);
    expect(screen.getByTestId('edge-ev').textContent).toMatch(/Expected value\+\$86/);
    expect(screen.getByTestId('edge-pml').textContent).toMatch(/Max-loss chance15\.9%/);
    expect(screen.getByTestId('edge-pop').textContent).toMatch(/Win chance80%/);
    expect(screen.getByTestId('edge-kelly').textContent).toMatch(/Kelly size1 ct\$3,886/);
  });
  it('exit plan: stop, target and max in $ for the ticket, and when it closes', () => {
    render(<ExitPlanStrip net={2.45} win={245} qty={1} plan={{ rows: [{ qty: 1, pct: 50 }], stopPct: 100 }} when={{ label: 'close by 20 Nov (21 DTE)', days: 24 }} />);
    expect(screen.getByTestId('exit-stop').textContent).toBe('stop @4.90 −$245');
    expect(screen.getByTestId('exit-targets').textContent).toBe('Target @1.23 = +$123');
    expect(screen.getByTestId('exit-when').textContent).toMatch(/24d.*close by 20 Nov/);
  });
  it('secondary actions sit behind ⋯', () => {
    const print = vi.fn();
    render(<MoreMenu items={[{ label: 'Print summary', testid: 'print-summary', onClick: print }, false]} />);
    expect(screen.queryByTestId('print-summary')).toBeNull();
    fireEvent.click(screen.getByTestId('engine-more'));
    fireEvent.click(screen.getByTestId('print-summary'));
    expect(print).toHaveBeenCalled();
  });
});
