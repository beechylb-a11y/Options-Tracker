// Postmortem packs.
//
// The point of this file is to end the screenshot habit. Everything a postmortem
// argues from — what the structure was really worth through the hold, where spot sat
// relative to the body, what the spread cost, what the engine thought at entry — is
// already available; it was just never collected into one artefact. A pack is that
// artefact: one JSON, dropped into the TradePrints folder alongside the engine PDF.
//
// The series comes from the bridge's /api/trade-replay, which rebuilds the value
// curve from per-leg BID/ASK bars. A TWS COMBO chart cannot be used for this: its
// quote is synthesised from the legs and prints a range many times the real one.
// (Sep 2026 — see bridge/replay.js.)

const pad = n => String(n).padStart(2, '0');
export const yyyymmdd = iso => (iso || '').slice(0, 10).replace(/-/g, '');

// "759 / 763 / 768" + a strategy name → signed leg ratios.
//
// Ratios are NOT stored on the decision row, so they are inferred from the strike
// count and the structure. That inference is the weakest link here and it is
// deliberately visible in the pack as `legsInferred`: the 29 Sep SPY ticket was
// printed as a 1.5x upper wing and traded 1/-2/+1, and nothing in the log could
// have told them apart. Override with the real legs whenever they are known.
export function inferLegs(wingStrikes, strategy, right) {
  const ks = String(wingStrikes || '').split(/[\s/,]+/).map(Number).filter(n => n > 0);
  if (ks.length !== 3) return null;
  const s = String(strategy || '').toLowerCase();
  const r = right || (s.includes('put') ? 'P' : 'C');
  const [a, b, c] = ks.slice().sort((x, y) => x - y);
  // Body is the strike the other two sit either side of; for these structures the
  // engine always writes lower / body / upper, but sorting makes it order-proof.
  const body = b;
  const lower = a, upper = c;
  return {
    legs: [
      { strike: lower, right: r, ratio: 1 },
      { strike: body, right: r, ratio: -2 },
      { strike: upper, right: r, ratio: 1 },
    ],
    note: 'inferred 1/-2/+1 from three strikes — confirm against the fill',
  };
}

export const legsParam = legs =>
  legs.map(l => `${l.strike}${l.right}:${l.ratio > 0 ? '+' : ''}${l.ratio}`).join(',');

// Pull the series from the bridge. Long timeout on purpose: seven paced IBKR
// requests is slow, and a pack that times out at 10s is a pack that never exists.
export async function fetchReplay(bridgeUrl, { underlying, expiry, date, legs, entry, exit, barSize }) {
  const q = new URLSearchParams({
    underlying, expiry, date, legs: legsParam(legs),
    ...(barSize ? { barSize } : {}),
    ...(entry ? { entry } : {}),
    ...(exit ? { exit } : {}),
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch(`${bridgeUrl}/api/trade-replay?${q}`, {
      headers: { 'ngrok-skip-browser-warning': '1' }, signal: ctrl.signal,
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `bridge ${r.status}`);
    return data;
  } finally { clearTimeout(timer); }
}

// The pack: the replay, plus everything the app already knows about the ticket.
export function buildPack({ decision, closes, replay, legsInferred }) {
  return {
    kind: 'options-tracker-postmortem-pack',
    version: 1,
    generatedAt: new Date().toISOString(),
    ticket: decision ? {
      ref: decision.__row ?? null,
      timestamp: decision.Timestamp,
      engine: decision.Engine,
      underlying: decision.Underlying,
      strategy: decision.Strategy,
      wingStrikes: decision['Wing Strikes'],
      contracts: decision.Contracts,
      netDebitCredit: decision['Net Debit/Credit'],
      maxRisk: decision['Max Risk'],
      maxProfit: decision['Max Profit'],
      ev: decision.EV,
      confidence: decision.Confidence,
      pMaxLoss: decision['P(max loss)'],
      em: decision.EM,
      emBasis: decision['EM Basis'],
      vix1d: decision.VIX1D,
      priceAtEntry: decision.Price,
      setupScore: decision['Setup Score'],
      account: decision.Account,
      status: decision.Status,
    } : null,
    tranches: (closes || []).map(c => ({
      closeId: c['Close ID'], date: c['Close Date'], qty: c['Qty Closed'],
      price: c['Close Price'], pnl: c['P&L ($)'], fees: c['Fees ($)'], notes: c.Notes,
    })),
    legsInferred: legsInferred || null,
    replay: replay || null,
    // Stated plainly so a reader of the pack knows which numbers are measured and
    // which are reconstructed.
    provenance: {
      series: replay ? replay.source : 'unavailable',
      legs: legsInferred ? legsInferred.note : 'legs supplied explicitly',
      fills: 'not captured — paper account, or no IBKR executions matched',
    },
  };
}

export function packFilename(pack) {
  const t = pack.ticket || {};
  const d = (t.timestamp || pack.generatedAt).slice(0, 10);
  const u = t.underlying || pack.replay?.underlying || 'trade';
  const k = (t.strategy || '').toLowerCase().includes('butterfly') ? 'fly' : 'trade';
  return `${u} ${k} replay — ${d}.json`;
}

// Hand the file to the browser. Same habit as the engine PDF: it lands in Downloads
// and gets dropped into the TradePrints folder.
export function downloadPack(pack) {
  const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = packFilename(pack);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
