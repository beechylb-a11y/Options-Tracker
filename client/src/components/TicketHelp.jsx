import React, { useState } from 'react';

// Plain-English explanations for the BUY (profit taker) and SELL (scale out / roll)
// tickets. Collapsed by default; one click to open. Wording kept deliberately
// concrete — every term is explained with the numbers it produces on the ticket.

export const OFFSET_TIP =
  'TWS offset = profit-taker limit − your entry limit, in IBKR\'s signed combo price ' +
  '(debit +, credit −). When you attach a profit taker in TWS, it pre-fills the child ' +
  'order at parent price + a default offset from your order preset. If the child price ' +
  'TWS shows differs from this ticket, your preset offset is the thing to fix. A preset ' +
  'set as a % is taken of the PARENT PRICE, not of max profit, so it needs the % shown here.';

const H = ({ children }) => <div style={{ fontSize: 12.5, fontWeight: 700, color: '#e6edf3', marginTop: 10, marginBottom: 3 }}>{children}</div>;
const P = ({ children }) => <div style={{ fontSize: 12.5, color: '#a8b2be', lineHeight: 1.55, marginBottom: 4 }}>{children}</div>;
const M = ({ children }) => <span className="mono" style={{ color: '#c9d1d9' }}>{children}</span>;

function BuyHelp() {
  return (<>
    <H>What this is</H>
    <P>The check to do before you transmit in TWS: where your profit taker(s) should sit, what each one makes after commission, and whether TWS will put them there.</P>
    <H>% max</H>
    <P>Target as a percentage of the trade's <b>max profit</b> (the engine's Win). 50% on a fly with $350 max profit means close when you're up $175. For credit spreads max profit ≈ the credit, so 50% ≈ buy back at half the credit.</P>
    <H>LMT</H>
    <P>The closing limit price for that target. Type either the % or the price; the other follows. Prices snap to 0.05 for SPX/XSP, 0.01 for ETFs.</P>
    <H>The IBKR line</H>
    <P>How the order looks in TWS. A combo you <b>buy</b> has a signed price — a debit is positive (<M>BUY @ 1.50</M>), a credit is negative (<M>BUY @ −3.40</M>). The profit taker is always the opposite side (<M>SELL LMT</M>) at <M>entry + profit</M>. Credit trades also show the other way of entering it (<M>SELL combo @ 3.40 cr → BUY LMT @ 1.70 db</M>).</P>
    <H>TWS offset</H>
    <P>The gap between the profit-taker price and the entry price. It's the number to check against what TWS pre-fills when you attach a profit taker. Example, SPY fly bought at 0.28 debit, target 0.61: offset +0.33.</P>
    <P>If your TWS preset sets the offset as a <b>percentage</b>, TWS takes it of the <b>entry price</b>, not of max profit. +0.33 on a 0.28 entry is <b>118%</b> — so a "20%" preset would put the profit taker at 0.34, nowhere near the 20%-of-max target. The amber warning appears whenever those two numbers differ by more than 10 points. Credit spreads rarely trigger it; debit flies nearly always do. Check your preset once to confirm it's %-of-parent.</P>
    <H>Ladder</H>
    <P>For more than one contract: a separate target per tranche (e.g. 1 @ 25%, 1 @ 50%, 1 @ 75%). TWS attaches only one profit taker per order, so enter the others as separate closing limits after the fill.</P>
    <H>Stop loss</H>
    <P>Loss as a % of the <b>entry price</b>. Credit: 100 = buy back at 2× the credit. Debit: 50 = sell for half what you paid.</P>
    <H>Commission</H>
    <P>Per leg, per contract, one way. Net figures take off a round trip (open + close). A butterfly counts its doubled body leg twice.</P>
    <H>What happens on Log trade</H>
    <P>The plan is written into the trade notes, and the Sell ticket for this position opens with the same tranches already filled in (on this browser).</P>
  </>);
}

function SellHelp() {
  return (<>
    <H>What this is</H>
    <P>Records exits from a position you already hold — one row per tranche — so a scale-out keeps every fill instead of one blended number.</P>
    <H>Tranche rows</H>
    <P><b>Qty</b> contracts to close at <b>% max</b> (of max profit) or <b>LMT</b> (the closing price — credit for debit trades, debit for credit trades; the header says which). The IBKR line under each row is the order as TWS writes it.</P>
    <H>Working → Filled</H>
    <P>Rows start as <b>Working</b> (your plan). When one fills in TWS, click it to <b>Filled</b> and enter the actual fill price. Only Filled rows are recorded; Working rows are kept as the plan for next time you open this ticket.</P>
    <H>Record</H>
    <P>Each filled tranche is written as its own row in the Closes tab with its P&amp;L net of commission. The position stays <b>Partial</b> until the last contract is out; Banked shows what's already been taken.</P>
    <H>Save plan</H>
    <P>Keeps the Working rows without recording anything — use it after setting orders in TWS.</P>
    <H>Stop</H>
    <P>Loss as % of entry price (credit 100 = buy back at 2× credit; debit 50 = sell at half the debit). Shown for reference; not recorded unless you fill it as a tranche.</P>
    <H>Roll (45DTE)</H>
    <P>One combo in TWS, two records here. Enter the contracts, what closing the old legs costs, and what the new legs open at, then change only the strikes that move. The old ticket banks its P&amp;L on the rolled contracts; the new legs are logged as a new ticket linked back to it. <b>Net roll</b> is the combo price TWS shows; <b>cumulative basis</b> is your running credit (or debit) across every roll.</P>
  </>);
}

export default function TicketHelp({ kind }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 8 }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 12.5, color: '#58a6ff' }}>
        {open ? '▾' : '▸'} How this ticket works
      </button>
      {open && (
        <div style={{ marginTop: 6, padding: '4px 12px 10px', borderRadius: 8, background: '#0d1117', border: '1px solid #21262d' }}>
          {kind === 'buy' ? <BuyHelp /> : <SellHelp />}
        </div>
      )}
    </div>
  );
}
