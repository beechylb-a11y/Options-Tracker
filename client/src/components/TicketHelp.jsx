import React, { useState } from 'react';

// Plain-English explanations for the BUY (profit taker) and SELL (scale out / roll)
// tickets. Collapsed by default; one click to open. Wording kept deliberately
// concrete — every term is explained with the numbers it produces on the ticket.

export const OFFSET_TIP =
  'Offset = the profit per share you are asking for: target price minus entry price ' +
  '(entry minus target for a credit). It is the number to type into a TWS profit taker ' +
  'set by amount. A TWS profit taker set by PERCENTAGE takes that % of the entry price — ' +
  'so on a 0DTE ticket (targets are % on entry) the two are the same number.';

const H = ({ children }) => <div style={{ fontSize: 12.5, fontWeight: 700, color: '#e6edf3', marginTop: 10, marginBottom: 3 }}>{children}</div>;
const P = ({ children }) => <div style={{ fontSize: 12.5, color: '#a8b2be', lineHeight: 1.55, marginBottom: 4 }}>{children}</div>;
const M = ({ children }) => <span className="mono" style={{ color: '#c9d1d9' }}>{children}</span>;

function BuyHelp() {
  return (<>
    <H>What this is</H>
    <P>The profit taker to attach in TWS before you transmit: the price, what it makes, and what to type.</P>
    <H>Contracts</H>
    <P>The engine's Kelly size. Change contracts on the engine and the ticket follows.</P>
    <H>Target — 0DTE</H>
    <P>A % <b>return on entry</b>. Bought at 0.64 debit: +50% = sell at <M>0.96</M>, +100% = <M>1.28</M>. For a credit, +50% = buy back at half the credit. The header shows the most the structure can make as a % (a fly might top out at +500%); targets beyond that can't fill.</P>
    <H>Target — 45DTE</H>
    <P>A % of <b>max profit</b>, the usual "manage winners at 50%". For credit trades that's the same as % on entry. For a debit structure it isn't, and the ticket spells out the on-entry equivalent.</P>
    <H>TWS line</H>
    <P>The closing order (<M>SELL LMT 0.96</M>), the <b>offset</b> — profit per share, entry to target (+0.32) — and the % to use if your TWS profit-taker preset is set as a percentage. TWS takes that % of the entry price, so for 0DTE it is simply your target %.</P>
    <H>Scale out in tranches</H>
    <P>Optional, for more than one contract: a separate target per tranche. TWS attaches one profit taker per order, so enter the others as separate closing limits after the fill.</P>
    <H>Stop</H>
    <P>Loss as a % of entry. Debit: 50 = sell at half what you paid. Credit: 100 = buy back at 2× the credit.</P>
    <H>Commission</H>
    <P>Per leg, per contract, one way. "After comm" takes off a round trip; a butterfly's doubled body counts twice.</P>
  </>);
}

function SellHelp() {
  return (<>
    <H>What this is</H>
    <P>Records exits from a position you hold, one row per tranche, so scaling out keeps every fill.</P>
    <H>Tranche rows</H>
    <P><b>Qty</b> to close at a <b>target %</b> (0DTE: % on entry; 45DTE: % of max profit) or a <b>LMT</b> price — type either. The <b>P&amp;L</b> column shows the result as <b>% on entry</b> and dollars after commission.</P>
    <H>Working → Filled</H>
    <P>Rows start as <b>Working</b>. When one fills in TWS, click it to <b>Filled</b> and enter the fill price; the row then shows the price achieved as % profit/loss on entry. Only Filled rows are recorded; Working rows stay as the plan.</P>
    <H>Record</H>
    <P>Each filled tranche becomes its own row in the Closes tab. The position stays <b>Partial</b> until the last contract is out; <b>Banked</b> shows what's already taken.</P>
    <H>Roll (45DTE only)</H>
    <P>One combo in TWS, two records here: the old ticket banks its P&amp;L on the rolled contracts, the new legs open as a new linked ticket. <b>Net roll</b> is the combo price; <b>cumulative basis</b> is your running credit (or debit) across rolls.</P>
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
