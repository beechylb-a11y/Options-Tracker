// Best-effort volatility snapshot at CLOSE, fetched from the local IBKR bridge.
// startCloseVolSnapshot() returns an object immediately and mutates it as data
// lands, so a caller can start it when the close UI opens and read whatever has
// arrived at confirm time. Every failure is silent and every missing value stays
// undefined — a close must never block on (or be delayed by) this.

const HDRS = { 'ngrok-skip-browser-warning': '1' };

// Strike increment per underlying, for rounding spot to the ATM strike.
function strikeIncrement(u) {
  return /^(SPX|NDX|RUT)$/i.test(u || '') ? 5 : 1;
}

// Numbers only, and never fake zeros: a 0 from the bridge means "no data".
function num(x) {
  const v = parseFloat(x);
  return isFinite(v) && v !== 0 ? v : null;
}

function fetchJson(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { headers: HDRS, signal: ctrl.signal })
    .then(r => r.json())
    .finally(() => clearTimeout(t));
}

// underlying: ticker string. opts.expiry: 'YYYY-MM-DD' or 'YYYYMMDD' of the
// ticket's option expiry. When absent, the IVx (option-greeks) fetch is skipped
// rather than guessed at — price/VIX/VIX1D still come back from market-data.
// Fills (when the bridge answers): closeUnderlyingPrice, closeVix, closeVix1d,
// sessionHigh, sessionLow, and closeIV (the ATM single-leg model IV = IVx proxy).
export function startCloseVolSnapshot(underlying, opts = {}) {
  const snap = {};
  try {
    const bridgeUrl = localStorage.getItem('bridgeUrl') || '';
    if (!bridgeUrl || !underlying) return snap;
    const expiry = String(opts.expiry || '').replace(/-/g, '');
    fetchJson(bridgeUrl + '/api/market-data?underlying=' + encodeURIComponent(underlying), 5000)
      .then(d => {
        if (!d || d.error) return;
        snap.closeUnderlyingPrice = num(d.price);
        snap.closeVix = num(d.vix ?? d.VIX);
        snap.closeVix1d = num(d.vix1d);
        snap.sessionHigh = num(d.high);
        snap.sessionLow = num(d.low);
        // Expiry IVx: one ATM call leg — its model IV is the expiry-IV proxy.
        // Needs a spot to round to a strike, so it chains off the price above.
        // Timeout is longer than market-data's because each bridge getSnapshot
        // waits its full ~6s window.
        const spot = snap.closeUnderlyingPrice;
        if (!expiry || !spot) return;
        const inc = strikeIncrement(underlying);
        const strike = Math.round(spot / inc) * inc;
        const legs = encodeURIComponent(JSON.stringify([{ strike, right: 'C', qty: 1 }]));
        return fetchJson(bridgeUrl + '/api/option-greeks?underlying=' + encodeURIComponent(underlying)
          + '&expiry=' + expiry + '&legs=' + legs, 8000)
          .then(g => {
            const iv = (g && Array.isArray(g.legs) && g.legs[0] && g.legs[0].greeks)
              ? num(g.legs[0].greeks.iv) : null;
            if (iv != null) snap.closeIV = iv;
          });
      })
      .catch(() => { /* bridge down / timeout — snapshot stays partial or empty */ });
  } catch (e) { /* no localStorage (private mode) — snapshot stays empty */ }
  return snap;
}
