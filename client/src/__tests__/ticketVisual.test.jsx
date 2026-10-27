/* Sell / Roll ticket, visual first (Oct 2026): the board's header on the ticket, the
   whole-position P&L ladder, and the strikes before/after a roll. */
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import { TicketHeader, PnlLadder, RollBeforeAfter } from '../components/TicketVisual';

const pos = { ncd: 3.99, isCredit: true, maxProfitPerContract: 399 };
afterEach(cleanup);

describe('ticket header', () => {
  it('title line, whole-position P&L and the check-up verdict', () => {
    const check = { review: { action: 'watch', tone: 'amber', headline: 'Narrow condor — both shorts near the money' } };
    render(<TicketHeader check={check} title={{ underlying: 'QQQ', strikes: [699, 709, 735, 745], strategy: 'Iron Condor', qty: 5, expiry: '20261120' }}
      sub="entry 3.99 cr" posPnl={-124} ticketPnl={-1205} banked={1080.5} />);
    expect(screen.getByTestId('ticket-title').textContent).toBe('QQQ 699/709/735/745Iron Condor5 ct20 Nov');
    expect(screen.getByTestId('ticket-pnl').textContent).toMatch(/−\$124ticket −\$1,205 \+ banked \+\$1,081/);
    expect(screen.getByTestId('checkup-action').textContent).toMatch(/Watch/);
    expect(screen.getByTestId('ticket-headline').textContent).toMatch(/Narrow condor/);
  });
});

describe('P&L ladder', () => {
  it('marks stop, entry, targets and max in whole-position $, with now', () => {
    render(<PnlLadder pos={pos} qtyOpen={5} banked={1080.5} stopPrice={7.98} nowPrice={6.4}
      targets={[{ label: 'T1', price: 2, qty: 3 }, { label: 'T2', price: 1, qty: 2 }]} />);
    expect(screen.getByTestId('ladder-stop').textContent).toMatch(/STOP @7\.98.*−\$914/);
    expect(screen.getByTestId('ladder-entry').textContent).toMatch(/ENTRY @3\.99.*\+\$1,081/);
    expect(screen.getByTestId('ladder-T1').textContent).toMatch(/@2\.00.*\+\$2,076/);
    expect(screen.getByTestId('ladder-max').textContent).toMatch(/MAX @0\.00.*\+\$3,076/);
    expect(screen.getByTestId('ladder-now').textContent).toMatch(/now @6\.40 −\$124/);
  });
});

describe('roll before / after', () => {
  it('shows how each break-even moves', () => {
    const now = [[699, 'P', 1], [709, 'P', -1], [735, 'C', -1], [745, 'C', 1]].map(([strike, right, qty]) => ({ strike, right, qty }));
    const after = now.map(l => (l.right === 'C' ? { ...l, strike: l.strike - 10 } : l));
    const ncd = 3.99 + 1080.5 / 500;
    render(<RollBeforeAfter oldLegs={now} newLegs={after} spot={714.5} ncdOld={ncd} ncdNew={ncd + 0.7} />);
    const t = screen.getByTestId('roll-moves').textContent;
    expect(t).toMatch(/low break-even 703 → 702 \(more room below/);
    expect(t).toMatch(/high break-even 741 → 732 \(less room above/);
  });
});
