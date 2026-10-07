// ================================================================
//  IBKR TWS BRIDGE — Local market data server for Options Tracker
//  Connects to TWS or IB Gateway on localhost (auto-detect), serves REST API on :3333
//  Expose via ngrok for Railway app to call
// ================================================================
import express from 'express';
import cors from 'cors';
import { IBApi, EventName, SecType, BarSizeSetting, WhatToShow } from '@stoqey/ib';
import net from 'net';
import { computeOvernight } from './esOvernight.js';
import { parseLegs, composeCombo, summarise, geometry, legKey } from './replay.js';
import { daysBetween, nyToday, addDays, nearestExpiry, fridayNear, nearestStrike, strikeForDelta,
  interpAtDelta, termBiasFromIV, ivRankStats, realisedVol, avgIV } from './volSurface.js';
import { groupIntoStructures, legPerShare } from './structures.js';

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'ngrok-skip-browser-warning']
}));

// Handle preflight explicitly
app.options('*', (req, res) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, ngrok-skip-browser-warning'
  });
  res.sendStatus(204);
});
app.use(express.json());

const PORT = process.env.BRIDGE_PORT || 3333;
const TWS_HOST = process.env.TWS_HOST || '127.0.0.1';
// Which IBKR endpoint to reach. TWS and IB Gateway speak the IDENTICAL API — only the
// socket port differs (TWS live 7496 / paper 7497; IB Gateway live 4001 / paper 4002).
//   • TWS_PORT set → use exactly that one port (explicit; no fallback, so a deliberate
//     paper port is never crossed over to live).
//   • otherwise    → try the LIVE ports first (IB_TARGET's app, then the other), then
//     the PAPER ports, so the bridge connects to whichever login is actually running —
//     live always preferred when both are up (Oct 2026: paper added; before, a paper
//     login on 7497 was never found). /api/health says which one it is on.
const TWS_LIVE = 7496, GATEWAY_LIVE = 4001, TWS_PAPER = 7497, GATEWAY_PAPER = 4002;
function candidatePorts() {
  if (process.env.TWS_PORT) return [parseInt(process.env.TWS_PORT)];
  const target = (process.env.IB_TARGET || 'tws').toLowerCase();
  return target === 'gateway'
    ? [GATEWAY_LIVE, TWS_LIVE, GATEWAY_PAPER, TWS_PAPER]
    : [TWS_LIVE, GATEWAY_LIVE, TWS_PAPER, GATEWAY_PAPER];
}
const PORT_INFO = {
  [TWS_LIVE]: { app: 'TWS', mode: 'live' }, [TWS_PAPER]: { app: 'TWS', mode: 'paper' },
  [GATEWAY_LIVE]: { app: 'IB Gateway', mode: 'live' }, [GATEWAY_PAPER]: { app: 'IB Gateway', mode: 'paper' },
};
// What the bridge is connected to right now. The account id is the real tell:
// IBKR paper accounts start with "DU", live ones with "U".
let session = { port: null, app: '', mode: '', accounts: [] };
const CLIENT_ID = parseInt(process.env.CLIENT_ID || '99');

let ib = null;
let connected = false;
let nextReqId = 1000;
const STARTED_AT = new Date().toISOString();
let lastConnectError = '';
let reconnectTimer = null;

// Drop a dead IBApi instance completely. A new connection on the same client id
// while the old socket lingers gets IBKR error 326 ("client id already in use"),
// which is what made a TWS restart need a manual bridge restart. (Oct 2026)
function resetIB() {
  if (ib) {
    try { ib.removeAllListeners(); } catch (e) {}
    try { ib.disconnect(); } catch (e) {}
  }
  ib = null;
  connected = false;
}

// Auto-reconnect after TWS goes away (IBKR's daily restart, a re-login, a crash).
// Retries every 20 s, then every 60 s after 10 minutes, until TWS answers again.
function scheduleReconnect(delayMs = 20000, startedAt = Date.now()) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (connected) return;
    try { await connectTWS(); console.log('[BRIDGE] Auto-reconnect succeeded'); }
    catch (e) {
      lastConnectError = e.message;
      const next = Date.now() - startedAt > 10 * 60 * 1000 ? 60000 : 20000;
      scheduleReconnect(next, startedAt);
    }
  }, delayMs);
}

function getReqId() { return nextReqId++; }

// Fast TCP preflight: is anything actually listening on this port? Lets us fail over
// between TWS/Gateway quickly when one is down, and — crucially — never abandon a port
// that IS up just because the API handshake is slow.
function probePort(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok) => { if (done) return; done = true; try { sock.destroy(); } catch (e) {} resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

// ── Connect to TWS / IB Gateway ──
function connectTWS() {
  return new Promise((resolve, reject) => {
    if (connected && ib) { resolve(); return; }
    const ports = candidatePorts();

    (async () => {
      // Find the first candidate port with something listening.
      let openPort = null;
      for (const p of ports) { if (await probePort(TWS_HOST, p)) { openPort = p; break; } }
      if (openPort == null) {
        reject(new Error('IBKR connection failed — nothing listening on port(s) ' + ports.join(', ')
          + '. Is TWS or IB Gateway running and logged in, with the API enabled?'));
        return;
      }

      let settled = false;
      resetIB();   // never stack a second IBApi on a stale one
      ib = new IBApi({ host: TWS_HOST, port: openPort, clientId: CLIENT_ID });
      const info = PORT_INFO[openPort] || { app: 'IBKR', mode: '' };
      const appName = info.app + (info.mode ? ' (' + info.mode + ')' : '');
      session = { port: openPort, app: info.app, mode: info.mode, accounts: [] };
      ib.on(EventName.managedAccounts, list => {
        const accts = String(list || '').split(',').map(x => x.trim()).filter(Boolean);
        const mode = accts.length ? (accts.every(a => /^DU/i.test(a)) ? 'paper' : 'live') : session.mode;
        session = { ...session, accounts: accts, mode };
        console.log('[BRIDGE] Accounts: ' + accts.join(',') + ' (' + mode + ')');
      });

      ib.on(EventName.connected, () => {
        if (settled) return;
        settled = true;
        connected = true;
        lastConnectError = '';
        console.log(`[BRIDGE] Connected to ${appName} on ${TWS_HOST}:${openPort}`);
        // FROZEN (2): with the OPRA live options subscription active, this delivers
        // REAL-TIME data during market hours and the LAST snapshot when the market is
        // closed — so model greeks / IV keep resolving after hours (delayed type 3 only
        // ticks during RTH, which is why greeks came back null after the close). (Jul 2026)
        ib.reqMarketDataType(2); // 1=live 2=frozen 3=delayed 4=delayed-frozen
        resolve();
      });

      ib.on(EventName.disconnected, () => {
        console.log('[BRIDGE] Disconnected from IBKR');
        connected = false;
        scheduleReconnect();
      });

      ib.on(EventName.error, (err, code, reqId) => {
        if (code === 2104 || code === 2106 || code === 2158) return; // info messages
        console.error('[BRIDGE] IBKR Error:', code, err?.message || err);
      });

      ib.connect();
      // Port is confirmed open, so give the API handshake a generous window before failing.
      setTimeout(() => {
        if (connected || settled) return;
        settled = true;
        reject(new Error(`IBKR API handshake timeout on ${TWS_HOST}:${openPort} — ${appName} is `
          + 'listening but did not complete the API handshake. Check "Enable ActiveX and Socket '
          + 'Clients", the trusted-IP / localhost setting, and that client id ' + CLIENT_ID + ' is free.'));
      }, 8000);
    })();
  });
}

// ── Request market data snapshot ──
function getSnapshot(contract) {
  return new Promise((resolve, reject) => {
    const reqId = getReqId();
    const data = {};
    let resolved = false;
    // Data-quality tracking: delayed field IDs (66-76) indicate TWS is serving
    // delayed (typically ~10 min lagged) data because there's no real-time
    // subscription for this instrument. marketDataType event confirms it.
    let sawDelayedField = false;
    let mdType = null; // 1=realtime, 2=frozen, 3=delayed, 4=delayed-frozen

    const onMdType = (id, type) => { if (id === reqId) mdType = type; };

    const onTick = (id, field, value) => {
      if (id !== reqId) return;
      if (value <= 0) return; // ignore -1 placeholders and zero values
      // Real-time field IDs: 1=bid, 2=ask, 4=last, 6=high, 7=low, 9=close, 14=open
      // Delayed field IDs: 66=delayed_bid, 67=delayed_ask, 68=delayed_last, 72=delayed_high, 73=delayed_low, 75=delayed_close, 76=delayed_open
      if (field >= 66 && field <= 76) sawDelayedField = true;
      if (field === 1 || field === 66) data.bid = value;
      if (field === 2 || field === 67) data.ask = value;
      if (field === 4 || field === 68) data.last = value;
      if (field === 6 || field === 72) data.high = value;
      if (field === 7 || field === 73) data.low = value;
      if (field === 9 || field === 75) data.prevClose = value;
      if (field === 14 || field === 76) data.open = value;
    };

    const onTickEnd = (id) => {
      if (id !== reqId || resolved) return;
      resolved = true;
      ib.removeListener(EventName.tickPrice, onTick);
      ib.removeListener(EventName.tickSnapshotEnd, onTickEnd);
      ib.removeListener(EventName.marketDataType, onMdType);
      data.mid = (data.bid && data.ask) ? (data.bid + data.ask) / 2 : data.last;
      data.delayed = sawDelayedField || mdType === 3 || mdType === 4;
      data.frozen = mdType === 2 || mdType === 4;
      console.log(`[BRIDGE] snap ${contract.symbol}/${contract.secType}: bid=${data.bid||0} ask=${data.ask||0} last=${data.last||0} close=${data.prevClose||0} delayed=${data.delayed}`);
      resolve(data);
    };

    ib.on(EventName.tickPrice, onTick);
    ib.on(EventName.tickSnapshotEnd, onTickEnd);
    ib.on(EventName.marketDataType, onMdType);
    ib.reqMktData(reqId, contract, '', false, false);

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        ib.removeListener(EventName.tickPrice, onTick);
        ib.removeListener(EventName.tickSnapshotEnd, onTickEnd);
        ib.removeListener(EventName.marketDataType, onMdType);
        ib.cancelMktData(reqId);
        data.mid = (data.bid && data.ask) ? (data.bid + data.ask) / 2 : data.last;
        data.delayed = sawDelayedField || mdType === 3 || mdType === 4;
        data.frozen = mdType === 2 || mdType === 4;
        console.log(`[BRIDGE] snap ${contract.symbol}/${contract.secType} (timeout): bid=${data.bid||0} ask=${data.ask||0} last=${data.last||0} close=${data.prevClose||0} delayed=${data.delayed}`);
        resolve(data);
      }
    }, 6000);
  });
}

// ── Request option model Greeks (delta/gamma/theta/vega/IV) ──
// Greeks only exist for a specific option contract. We request generic tick
// 106 which enables modelGreeks, then listen for tickOptionComputation.
// tickType 13 = model option computation (IBKR's theoretical greeks).
function getOptionGreeks(contract) {
  return new Promise((resolve) => {
    const reqId = getReqId();
    let resolved = false;
    let notSubscribed = false;
    let mdType = null; // IBKR feed type: 1 real-time, 2 frozen, 3 delayed, 4 delayed-frozen
    let fallback = null;   // best non-model computation seen, used only if 13 never lands
    let graceTimer = null; // short wait for the model tick once a fallback exists
    let hardTimer = null;
    // The same reqMktData that carries the greeks already carries the quote; we
    // were throwing it away. Keeping it is what lets the app price the SPREAD of a
    // structure rather than only its mid, which is the difference between knowing
    // a trade is likely to win and knowing whether winning pays for the execution.
    // (Sep 2026.) Fields: 1/2 real-time bid/ask, 66/67 the delayed equivalents.
    const quote = { bid: null, ask: null };
    const done = (data) => {
      if (resolved) return;
      resolved = true;
      if (data && typeof data === 'object' && !data.notSubscribed) {
        data.bid = quote.bid; data.ask = quote.ask;
      }
      if (graceTimer) clearTimeout(graceTimer);
      if (hardTimer) clearTimeout(hardTimer);
      ib.removeListener(EventName.tickOptionComputation, onGreeks);
      ib.removeListener(EventName.tickPrice, onPrice);
      ib.removeListener(EventName.tickSnapshotEnd, onEnd);
      ib.removeListener(EventName.marketDataType, onMdType);
      ib.removeListener(EventName.error, onErr);
      try { ib.cancelMktData(reqId); } catch (e) {}
      resolve(data);
    };
    // @stoqey/ib 1.3.x tickOptionComputation args (10):
    // (reqId, tickType, impliedVol, delta, optPrice, pvDividend, gamma, vega, theta, undPrice)
    // tickType 13 = MODEL greeks; 10/11/12 = bid/ask/last computations.
    //
    // Only 13 comes off IB's own model with one consistent vol surface. The bid and
    // ask computations back an IV out of a single side of the quote, so they are not
    // comparable with each other or with the model - and this handler used to resolve
    // on whichever tick arrived first. Legs of the same structure could therefore be
    // served by different computations, which makes the SUM meaningless: on a butterfly
    // the body is weighted x2 and net delta sits near zero, so one bid-computation leg
    // is enough to flip the sign of the whole structure. That is exactly the engine-vs-TWS
    // disagreement seen on the 738/742/746 fly.
    //
    // So: take 13 the moment it lands. If a one-sided computation arrives first, hold it
    // aside and give the model tick a 1.5s grace period before settling for it - bounded
    // extra latency, and the payload says which computation actually served the leg.
    // (Jul 2026.)
    const TICK_RANK = { 13: 3, 12: 2, 11: 1, 10: 1 };
    const onGreeks = (id, tickType, impliedVol, delta, optPrice, pvDividend, gamma, vega, theta, undPrice) => {
      if (id !== reqId) return;
      if (delta == null || Number.isNaN(delta)) return; // skip empty ticks (feed not subscribed)
      const g = {
        iv: impliedVol && impliedVol > 0 ? +(impliedVol * 100).toFixed(2) : null,
        delta: +Number(delta).toFixed(4),
        gamma: gamma != null ? +Number(gamma).toFixed(5) : null,
        theta: theta != null ? +Number(theta).toFixed(4) : null,
        vega: vega != null ? +Number(vega).toFixed(4) : null,
        optPrice: optPrice != null && optPrice > 0 ? +Number(optPrice).toFixed(2) : null,
        undPrice: undPrice != null && undPrice > 0 ? +Number(undPrice).toFixed(2) : null,
        tickType, mdType
      };
      if (tickType === 13) { done(g); return; }
      if (!fallback || (TICK_RANK[tickType] || 0) > (TICK_RANK[fallback.tickType] || 0)) fallback = g;
      if (!graceTimer) graceTimer = setTimeout(() => done(fallback), 1500);
    };
    const onPrice = (id, field, value) => {
      if (id !== reqId || value == null || !(value >= 0)) return;
      if (field === 1 || field === 66) quote.bid = +Number(value).toFixed(2);
      else if (field === 2 || field === 67) quote.ask = +Number(value).toFixed(2);
    };
    const onEnd = (id) => { if (id === reqId) done(fallback); };
    const onMdType = (id, type) => { if (id === reqId) mdType = type; };
    // Market-data-not-subscribed errors (scoped to THIS request).
    const onErr = (err, code, id) => {
      if (id !== reqId) return;
      if ([10089, 10090, 10091, 10167, 10168, 354, 10197].includes(code)) notSubscribed = true;
    };
    ib.on(EventName.error, onErr);
    ib.on(EventName.tickOptionComputation, onGreeks);
    ib.on(EventName.tickPrice, onPrice);
    ib.on(EventName.tickSnapshotEnd, onEnd);
    ib.on(EventName.marketDataType, onMdType);
    // genericTickList '106' = implied vol / model greeks; snapshot=false because
    // greeks stream after a short delay, so we time out ourselves.
    ib.reqMktData(reqId, contract, '106', false, false);
    hardTimer = setTimeout(() => done(fallback || (notSubscribed ? { notSubscribed: true } : null)), 7000);
  });
}

// Build an OCC-style option contract for a leg.
function buildOptionContract(underlying, expiry, strike, right) {
  // expiry: 'YYYYMMDD'; right: 'C' | 'P'
  const u = underlying.toUpperCase();
  const isIndex = ['SPX', 'RUT', 'VIX', 'NDX', 'XSP'].includes(u);
  return {
    symbol: u,
    secType: SecType.OPT,
    currency: 'USD',
    exchange: isIndex ? 'CBOE' : 'SMART',
    lastTradeDateOrContractMonth: expiry,
    strike: Number(strike),
    right: right.toUpperCase().startsWith('P') ? 'P' : 'C',
    multiplier: '100',
    tradingClass: (u === 'SPX') ? 'SPXW' : undefined  // 0DTE SPX uses weeklys
  };
}
// `endDateTime` was hardcoded to '' (meaning "now"), so bars could only ever be pulled
// as a trailing window from the present. Walking backwards needs an explicit end, in
// IBKR's "yyyymmdd hh:mm:ss" form — that is what lets /api/history chunk a long span
// into requests small enough that IBKR will actually serve them.
// useRTH 0 = include the overnight (Globex) session; formatDate 2 = epoch seconds,
// which is timezone-proof (formatDate 1 comes back in TWS's LOGIN timezone, which
// here is Melbourne, not New York). Defaults keep every existing caller unchanged.
function getHistoricalBars(contract, duration, barSize, whatToShow = WhatToShow.TRADES, endDateTime = '', useRTH = 1, formatDate = 1) {
  return new Promise((resolve, reject) => {
    const reqId = getReqId();
    const bars = [];
    let resolved = false;

    const onBar = (id, date, open, high, low, close, volume, count, WAP) => {
      if (id !== reqId) return;
      // IBKR signals the end of a series by emitting a final row whose date is
      // "finished-<start>-<end>" rather than a timestamp. @stoqey/ib delivers it through
      // the same historicalData event as real bars, so it was being pushed into the
      // array: one junk row per chunk, inflating the count and making the reported date
      // range nonsense. Downstream parsers that require a leading yyyymmdd drop it
      // silently, which is exactly why it survived unnoticed.
      if (typeof date === 'string' && date.startsWith('finished')) return;
      if (bars.length === 0) console.log('[BRIDGE] BAR DATA: date=' + date + ' o=' + open + ' h=' + high + ' l=' + low + ' c=' + close + ' v=' + volume);
      bars.push({ date, open, high, low, close, volume: volume || 0, count, WAP });
    };

    const onEnd = (id) => {
      if (id !== reqId || resolved) return;
      resolved = true;
      ib.removeListener(EventName.historicalData, onBar);
      ib.removeListener(EventName.historicalDataEnd, onEnd);
      resolve(bars);
    };

    ib.on(EventName.historicalData, onBar);
    ib.on(EventName.historicalDataEnd, onEnd);
    ib.reqHistoricalData(reqId, contract, endDateTime, duration, barSize, whatToShow, useRTH, formatDate, false);

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        ib.removeListener(EventName.historicalData, onBar);
        ib.removeListener(EventName.historicalDataEnd, onEnd);
        resolve(bars);
      }
    }, 8000);
  });
}

// ── Contract definitions ──
const contracts = {
  SPX: { symbol: 'SPX', secType: SecType.IND, exchange: 'CBOE', currency: 'USD' },
  XSP: { symbol: 'XSP', secType: SecType.IND, exchange: 'CBOE', currency: 'USD' },
  RUT: { symbol: 'RUT', secType: SecType.IND, exchange: 'RUSSELL', currency: 'USD' },
  SPY: { symbol: 'SPY', secType: SecType.STK, exchange: 'SMART', primaryExch: 'ARCA', currency: 'USD' },
  QQQ: { symbol: 'QQQ', secType: SecType.STK, exchange: 'SMART', primaryExch: 'NASDAQ', currency: 'USD' },
  IWM: { symbol: 'IWM', secType: SecType.STK, exchange: 'SMART', primaryExch: 'ARCA', currency: 'USD' },
  VIX: { symbol: 'VIX', secType: SecType.IND, exchange: 'CBOE', currency: 'USD' },
  VIX1D: { symbol: 'VIX1D', secType: SecType.IND, exchange: 'CBOE', currency: 'USD' },
  // 3-month VIX: VIX / VIX3M above 1 is index-level backwardation (Oct 2026).
  VIX3M: { symbol: 'VIX3M', secType: SecType.IND, exchange: 'CBOE', currency: 'USD' },
  ES: { symbol: 'ES', secType: SecType.FUT, exchange: 'CME', currency: 'USD', lastTradeDateOrContractMonth: '' },
};
// Any other ticker (AAPL, NVDA, TSLA, AMD, DIA ...) is a US stock or ETF on SMART.
// Before Oct 2026 an unknown symbol silently fell back to SPX, so a stock scan came
// back with SPX's numbers under AAPL's name.
function contractOf(underlying) {
  const u = String(underlying || '').toUpperCase();
  if (contracts[u]) return contracts[u];
  if (/^[A-Z][A-Z.]{0,5}$/.test(u)) return { symbol: u, secType: SecType.STK, exchange: 'SMART', currency: 'USD' };
  return null;
}

// Get front-month ES contract
function getESContract() {
  const now = new Date();
  const month = now.getMonth(); // 0-11
  const year = now.getFullYear();
  // ES quarterly months: Mar(2), Jun(5), Sep(8), Dec(11)
  const qMonths = [2, 5, 8, 11];
  let nextQ = qMonths.find(m => m > month);
  if (nextQ === undefined) { nextQ = 2; } // wrap to March next year
  let contractYear = nextQ <= month ? year + 1 : year;
  // If we're in the expiry month, check if past 3rd Friday
  if (qMonths.includes(month)) {
    const thirdFri = new Date(year, month, 1);
    while (thirdFri.getDay() !== 5) thirdFri.setDate(thirdFri.getDate() + 1);
    thirdFri.setDate(thirdFri.getDate() + 14);
    if (now <= thirdFri) {
      nextQ = month;
      contractYear = year;
    }
  }
  const ym = contractYear.toString() + String(nextQ + 1).padStart(2, '0');
  console.log('[BRIDGE] ES contract month:', ym);
  return {
    symbol: 'ES',
    secType: SecType.FUT,
    exchange: 'CME',
    currency: 'USD',
    lastTradeDateOrContractMonth: ym
  };
}

// ── Calculate ATR from bars ──
function calcATR(bars, period) {
  if (!bars || bars.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const prev = bars[i - 1];
    // @stoqey/ib returns bars as array-like objects with numeric keys
    // Format: {0: date, 1: open, 2: high, 3: low, 4: close, 5: volume, 6: WAP, 7: count}
    const h = b.high ?? b[2] ?? 0;
    const l = b.low ?? b[3] ?? 0;
    const pc = prev.close ?? prev[4] ?? 0;
    if (h > 0 && l > 0 && pc > 0) {
      trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
  }
  if (trs.length === 0) return 0;
  const n = Math.min(period, trs.length);
  return trs.slice(-n).reduce((s, v) => s + v, 0) / n;
}

// ── Bar field accessors (bars arrive as objects or as positional arrays) ──
const barTyp = b => (((b.high ?? b[2] ?? 0) + (b.low ?? b[3] ?? 0) + (b.close ?? b[4] ?? 0)) / 3);
const barVol = b => (b.volume ?? b[5] ?? 0);
const barClose = b => (b.close ?? b[4] ?? 0);

// ── Cumulative (anchored) session VWAP, one value per bar ──
// This is the classic "VWAP line" and is the right ruler for PRICE POSITION
// (above/below, distance). It is the WRONG ruler for trend: its rate of change is
// (volume in the window / cumulative volume) x (window price - VWAP), and that
// leading fraction decays through the session, so the same tape reads "strong" at
// 10:00 and "flat" from 11:30 to the close. Use vwapWindow() for trend instead.
function calcVWAP(bars) {
  let cumVP = 0, cumV = 0;
  const vwaps = [];
  bars.forEach(b => {
    const vol = barVol(b);
    cumVP += barTyp(b) * vol;
    cumV += vol;
    vwaps.push(cumV > 0 ? cumVP / cumV : barClose(b));
  });
  return vwaps;
}

// ── Rolling-window VWAP over bars[from, to) ──
// Not anchored to the open, so its value does not depend on how much of the
// session has already elapsed. Comparing two adjacent windows gives a trend
// reading whose statistical distribution is constant all day. (Aug 2026)
function vwapWindow(bars, from, to) {
  if (from < 0 || to > bars.length || to - from <= 0) return 0;
  let vp = 0, v = 0;
  for (let i = from; i < to; i++) { const vol = barVol(bars[i]); vp += barTyp(bars[i]) * vol; v += vol; }
  if (v > 0) return vp / v;
  // Zero-volume slice (thin index feed): fall back to an unweighted mean so the
  // window still returns a usable level rather than 0, which would read as a
  // gigantic false slope downstream.
  let s = 0; for (let i = from; i < to; i++) s += barTyp(bars[i]);
  return s / (to - from);
}

// ── VWAP acceptance: share of the last `len` bars that CLOSED above session VWAP ──
// Returns 0..1 (1 = every bar closed above). Aggregates the sign of `len` bars
// rather than the magnitude of one shift, so it is far less noise-dominated than
// any single slope reading, and it distinguishes "flat because balanced" from
// "flat because the VWAP line has gone inert" — which a slope alone cannot.
function calcAcceptance(bars, vwaps, len) {
  const n = Math.min(len, bars.length, vwaps.length);
  if (n <= 0) return -1;               // -1 = unavailable (0 is a real reading)
  let above = 0;
  for (let i = bars.length - n; i < bars.length; i++) {
    const c = barClose(bars[i]);
    const v = vwaps[i];
    if (c > 0 && v > 0 && c > v) above++;
  }
  return above / n;
}

const SQRT252 = Math.sqrt(252);

// ================================================================
//  MAIN ENDPOINT — GET /api/market-data?underlying=SPX
// ================================================================
app.get('/api/market-data', async (req, res) => {
  try {
    await connectTWS();
    // Delayed(3): keeps real-time where we're entitled but falls back to delayed for
    // instruments we're NOT subscribed to (VIX/VIX1D indices, ES futures). Frozen(2)
    // returns nothing for those, which is why VIX and the ES rows came back blank.
    try { ib.reqMarketDataType(3); } catch (e) {}
    const underlying = (req.query.underlying || 'SPX').toUpperCase();
    const usesSPYVwap = underlying === 'SPX' || underlying === 'XSP';
    const usesIWMVwap = underlying === 'RUT';

    // 1. Get snapshots in parallel
    const mainContract = contractOf(underlying);
    if (!mainContract) return res.status(400).json({ error: `Unknown underlying ${underlying}` });
    const esContract = getESContract();
    const vwapContract = usesSPYVwap ? contracts.SPY : mainContract;

    const [mainSnap, vixSnap, vix1dSnap, esSnap] = await Promise.all([
      getSnapshot(mainContract),
      getSnapshot(contracts.VIX),
      getSnapshot(contracts.VIX1D).catch(() => ({})),
      getSnapshot(esContract)
    ]);

    // Price chain: mid → last → session close (prevClose). ETFs on a delayed-
    // frozen feed (reqMarketDataType 3) often deliver ONLY the close tick with no
    // streaming bid/ask/last, so without the close fallback price came back 0 for
    // SPY/QQQ/IWM. SPX was masked from this because it also derives price from
    // SPY bars ×10 below.
    let priceSource = 'mid';
    let price = (mainSnap.mid && mainSnap.mid > 0) ? mainSnap.mid : 0;
    if (!price && mainSnap.last > 0) { price = mainSnap.last; priceSource = 'last'; }
    if (!price && mainSnap.prevClose > 0) { price = mainSnap.prevClose; priceSource = 'close(prevClose — stale)'; }
    if (price) console.log(`[BRIDGE] ${underlying} price=${price} via ${priceSource}`);
    const high = mainSnap.high > 0 ? mainSnap.high : 0;
    const low = mainSnap.low > 0 ? mainSnap.low : 0;
    const cashOpen = mainSnap.open > 0 ? mainSnap.open : 0;
    const vix = vixSnap.mid || vixSnap.last || 0;
    const vix1d = vix1dSnap.mid || vix1dSnap.last || 0;

    // ES overnight data — from 5-min Globex bars when they arrive, so the values
    // are the same whatever time Auto-fill is clicked (see esOvernight.js). The
    // snapshot is the fallback only: its close flips at the session end, its mid is
    // "now" rather than 08:45, and its high/low span the whole session.
    let esClose = esSnap.last || esSnap.mid || 0;
    let esPrevClose = esSnap.prevClose || 0;
    let esHigh = esSnap.high || 0;
    let esLow = esSnap.low || 0;
    let esOn = null, esSource = 'snapshot';
    try {
      const esBars = await getHistoricalBars(esContract, '5 D', BarSizeSetting.MINUTES_FIVE, WhatToShow.TRADES, '', 0, 2);
      esOn = computeOvernight(esBars, Date.now() / 1000);
      console.log('[BRIDGE] ES bars=' + esBars.length + ' overnight=' + JSON.stringify(esOn));
    } catch (e) { console.log('[BRIDGE] ES bars error:', e.message); }
    if (esOn) {
      esClose = esOn.preOpen; esPrevClose = esOn.priorClose;
      esHigh = esOn.overnightHigh; esLow = esOn.overnightLow;
      esSource = 'bars';
    }
    // ES trades above cash by carry until expiry (~60 pts in late Sep for Dec), so
    // an SPX chart and the ES fields never line up without it. Latest ES vs latest
    // cash; both are last/close after hours, so it holds then too.
    const esNow = esSnap.last || esSnap.mid || 0;
    const esBasis = (esNow > 0 && price > 0 && (underlying === 'SPX' || underlying === 'XSP'))
      ? Math.round((esNow - price * (underlying === 'XSP' ? 10 : 1)) * 100) / 100 : null;

    // 2. Calculate EM — VIX/√252 model estimate (fast, always available).
    // The straddle EM (market-priced, preferred) is fetched SEPARATELY by the
    // client via /api/atm-straddle so a slow/after-hours option fetch never
    // blocks this essential price+VIX response.
    const em = price > 0 && vix > 0 ? Math.round(price * (vix / 100) / SQRT252 * 10) / 10 : 0;
    const emVix = em;
    const esEM = esClose > 0 && vix > 0 ? Math.round(esClose * (vix / 100) / SQRT252 * 10) / 10 : 0;

    // 3. Get historical bars for ATR calculations
    // SPX index has no MIDPOINT historical data — use SPY bars and scale ×10
    // RUT index — use IWM bars and scale by RUT/IWM ratio
    const histContract = (underlying === 'SPX' || underlying === 'XSP') ? contracts.SPY : (underlying === 'RUT') ? contracts.IWM : mainContract;
    const histWhat = (histContract.secType === SecType.IND) ? WhatToShow.MIDPOINT : WhatToShow.TRADES;
    // XSP mirrors SPX (SPY bars as proxy), but SPY trades ~0.3-0.5% below XSP
    // (dividend drift) and a constant offset corrupts the VWAP-distance signal,
    // so XSP starts at 1 and switches to a dynamic xspSpot/spyRef ratio below
    // once the SPY bars arrive.
    let atrScale = (underlying === 'SPX') ? 10 : (underlying === 'RUT') ? 1 : 1;
    console.log('[BRIDGE] Requesting historical bars for', underlying, 'using', histContract.symbol, 'scale:', atrScale);
    const [bars1D, bars5m, bars2h] = await Promise.all([
      getHistoricalBars(histContract, '20 D', BarSizeSetting.DAYS_ONE, histWhat).catch(e => { console.log('[BRIDGE] bars1D error:', e.message); return []; }),
      getHistoricalBars(histContract, '1 D', BarSizeSetting.MINUTES_FIVE, histWhat).catch(e => { console.log('[BRIDGE] bars5m error:', e.message); return []; }),
      getHistoricalBars(histContract, '5 D', BarSizeSetting.HOURS_TWO, histWhat).catch(e => { console.log('[BRIDGE] bars2h error:', e.message); return []; })
    ]);
    console.log('[BRIDGE] Bars received: 1D=' + bars1D.length + ' 5m=' + bars5m.length + ' 2h=' + bars2h.length);
    if (underlying === 'XSP') {
      const spyRef = (bars5m.length > 0 ? bars5m[bars5m.length - 1].close : 0) ||
                     (bars1D.length > 0 ? bars1D[bars1D.length - 1].close : 0) || 0;
      if (price > 0 && spyRef > 0) {
        atrScale = price / spyRef;
        console.log('[BRIDGE] XSP dynamic scale: xspSpot=' + price + ' / spyRef=' + spyRef + ' = ' + atrScale.toFixed(5));
      } else {
        console.log('[BRIDGE] XSP: no spot/SPY reference (spot=' + price + ' spyRef=' + spyRef + ') — returning RAW SPY-derived values (~0.5% low, degraded)');
      }
    }
    if (bars1D.length > 0) {
      const b = bars1D[0];
      console.log('[BRIDGE] Bar sample: date=' + (b[0]||b.date) + ' open=' + (b[1]||b.open) + ' high=' + (b[2]||b.high) + ' low=' + (b[3]||b.low) + ' close=' + (b[4]||b.close));
    }

    const atr1d = calcATR(bars1D, 14) * atrScale;
    const atr5m = calcATR(bars5m, 14) * atrScale;
    const atr2h = calcATR(bars2h, 14) * atrScale;
    console.log('[BRIDGE] ATR calculated: 1d=' + atr1d.toFixed(2) + ' 5m=' + atr5m.toFixed(4) + ' 2h=' + atr2h.toFixed(2));

    // Derive Open from first 5m bar if not available from snapshot
    let derivedOpen = cashOpen;
    if (!derivedOpen && bars5m.length > 0) {
      derivedOpen = (bars5m[0].open || 0) * atrScale;
    }

    // 4. Fallback prices — start with snapshot, override later if needed
    let finalPrice = price;
    let finalHigh = high;
    let finalLow = low;

    // Derive from ATR bars if snapshot was 0
    if (!finalPrice && bars5m.length > 0) {
      const lastBar = bars5m[bars5m.length - 1];
      const barClose = (lastBar.close || 0) * atrScale;
      if (barClose > 0) {
        finalPrice = barClose;
        console.log('[BRIDGE] Price derived from last 5m bar:', finalPrice);
      }
    }
    if (!finalHigh && bars1D.length > 0) {
      const barHigh = (bars1D[bars1D.length - 1].high || 0) * atrScale;
      if (barHigh > 0) finalHigh = barHigh;
    }
    if (!finalLow && bars1D.length > 0) {
      const barLow = (bars1D[bars1D.length - 1].low || 0) * atrScale;
      if (barLow > 0) finalLow = barLow;
    }

    // 5. VWAP from 5-min bars
    // Indices need SPY/QQQ for volume. If unavailable, skip VWAP.
    // vwap5      = cumulative session VWAP now          (position / distance)
    // vwap5_30   = cumulative session VWAP 30 min ago   (reference only)
    // vwapRoll30 = VWAP of the last 30 min              (trend, time-invariant)
    // vwapRoll30Prior = VWAP of the 30 min before that  (trend, time-invariant)
    // vwapAccept = share of last 12 bars closing above session VWAP, -1 = n/a
    // vwap15/vwap15_30 are GONE (Aug 2026): they were assigned `= vwap5` and
    // `= vwap5_30`, so the engine's "15m confirmation" compared a series with
    // itself — `diverges` could never fire and `confirmed` was always true,
    // handing every non-flat day a free conviction bump.
    let vwap5 = 0, vwap5_30 = 0, vwapRoll30 = 0, vwapRoll30Prior = 0, vwapAccept = -1;
    try {
      // For VWAP we need volume data — use stocks directly, skip for indices if subscription missing
      const vwapContract = usesSPYVwap ? contracts.SPY : usesIWMVwap ? contracts.IWM : mainContract;
      const vwapWhat = (vwapContract.secType === SecType.IND) ? WhatToShow.BID_ASK : WhatToShow.TRADES;
      const vwapBars = await getHistoricalBars(vwapContract, '1 D', BarSizeSetting.MINUTES_FIVE, vwapWhat);
      if (vwapBars.length > 0) {
        const todayBars = vwapBars;
        const vwaps = calcVWAP(todayBars);

        const nb = todayBars.length;
        vwap5 = vwaps.length > 0 ? vwaps[vwaps.length - 1] : 0;
        vwap5_30 = vwaps.length > 6 ? vwaps[vwaps.length - 7] : vwap5;

        // Two adjacent 30-minute windows (6 five-minute bars each). Needs 12 bars
        // of session, i.e. valid from ~10:30 ET. Before that both stay 0 and the
        // engine degrades to a neutral trend reading rather than a wrong one.
        if (nb >= 12) {
          vwapRoll30      = vwapWindow(todayBars, nb - 6, nb);
          vwapRoll30Prior = vwapWindow(todayBars, nb - 12, nb - 6);
        }
        vwapAccept = calcAcceptance(todayBars, vwaps, 12);

        // Derive price from last VWAP bar close if snapshot failed
        if (!finalPrice || finalPrice <= 0) {
          const lastVwapBar = todayBars[todayBars.length - 1];
          const vwapClose = lastVwapBar.close || 0;
          if (vwapClose > 0) {
            finalPrice = vwapClose;
            console.log('[BRIDGE] Price derived from VWAP bar close:', finalPrice);
          }
        }
        // Derive high/low from today's VWAP bars
        if (!finalHigh || finalHigh <= 0) {
          const highs = todayBars.map(b => b.high || 0).filter(v => v > 0);
          if (highs.length > 0) finalHigh = Math.max(...highs);
        }
        if (!finalLow || finalLow <= 0) {
          const lows = todayBars.map(b => b.low || 0).filter(v => v > 0);
          if (lows.length > 0) finalLow = Math.min(...lows);
        }
      }
    } catch (e) {
      console.error('[BRIDGE] VWAP calc error:', e.message);
    }

    // XSP: SPX sends RAW SPY VWAPs and the client rescales ×10 client-side; the
    // client does NOT rescale XSP, so scale to index points here bridge-side.
    // vwapAccept is a 0..1 ratio, never a price — it is deliberately not scaled.
    if (underlying === 'XSP' && atrScale !== 1) {
      vwap5 *= atrScale; vwap5_30 *= atrScale;
      vwapRoll30 *= atrScale; vwapRoll30Prior *= atrScale;
    }

    // Data freshness, derived from the main price snapshot's IBKR market-data type
    // (1=real-time, 2=frozen, 3/4=delayed). Lets a caller tell at a glance whether
    // `price` is a live tick or the last close (e.g. outside US market hours).
    const _frozen = !!mainSnap.frozen, _delayed = !!mainSnap.delayed;
    const _gotPrice = (Math.round(finalPrice * 100) / 100) > 0;
    let dataType, dataTypeLabel;
    if (_delayed && _frozen) { dataType = 'delayed-frozen'; dataTypeLabel = 'Delayed, frozen (last close)'; }
    else if (_delayed)       { dataType = 'delayed';        dataTypeLabel = 'Delayed (~10-15 min lag)'; }
    else if (_frozen)        { dataType = 'frozen';         dataTypeLabel = 'Frozen \u2014 last close (market closed)'; }
    else if (_gotPrice)      { dataType = 'realtime';       dataTypeLabel = 'Real-time'; }
    else                     { dataType = 'unknown';        dataTypeLabel = 'No live tick (market closed / no data)'; }
    const isLive = dataType === 'realtime';

    // 6. Return all data
    const result = {
      underlying,
      price: Math.round(finalPrice * 100) / 100,
      high: Math.round(finalHigh * 100) / 100,
      low: Math.round(finalLow * 100) / 100,
      cashOpen: Math.round((derivedOpen || cashOpen) * 100) / 100,
      vix: Math.round(vix * 100) / 100,
      vix1d: Math.round(vix1d * 100) / 100,
      em: Math.round(em * 10) / 10,
      atr: Math.round(atr1d * 100) / 100,
      atr5: Math.round(atr5m * 100) / 100,
      atr2h: Math.round(atr2h * 100) / 100,
      // VWAP (SPY values for SPX — engine handles x10 scaling)
      vwap5: Math.round(vwap5 * 100) / 100,
      vwap5_30: Math.round(vwap5_30 * 100) / 100,
      // Rolling 30-min windows for the trend read (see block above)
      vwapRoll30: Math.round(vwapRoll30 * 100) / 100,
      vwapRoll30Prior: Math.round(vwapRoll30Prior * 100) / 100,
      // Ratio 0..1, or -1 when unavailable. NOT price-scaled.
      vwapAccept: vwapAccept < 0 ? -1 : Math.round(vwapAccept * 1000) / 1000,
      // ES overnight
      esClose: Math.round(esClose * 100) / 100,
      priorDayClose: Math.round(esPrevClose * 100) / 100,
      esOvernightHigh: Math.round(esHigh * 100) / 100,
      esOvernightLow: Math.round(esLow * 100) / 100,
      esEM: Math.round(esEM * 10) / 10,
      // Where the four ES values came from and what time each one is.
      esSource,                                   // 'bars' | 'snapshot'
      esPriorCloseLabel: esOn?.priorCloseLabel || '',
      esPreOpenLabel: esOn?.preOpenLabel || '',
      esPreOpenFinal: esOn ? esOn.preOpenFinal : null,
      esOvernightLabel: esOn?.overnightLabel || '',
      // The RTH session these overnight values belong to. esOvernight resolves it as
      // "the session whose 08:45 pre-open has passed", so after the close it is the
      // session just traded — correct for what this block measures, and NOT the
      // session a ticket built at that hour is for. The client compares the two.
      esSessionDate: esOn?.sessionDate || '',
      esNow: Math.round(esNow * 100) / 100,
      esBasis,                                    // ES − cash (index points), SPX/XSP only
      // Which ES futures contract these overnight values come from (e.g. "Sep 2026")
      esContractMonth: esContract.lastTradeDateOrContractMonth || '',
      esContractLabel: (() => { const _y = esContract.lastTradeDateOrContractMonth || ''; const _M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; return _y.length === 6 ? (_M[parseInt(_y.slice(4,6),10)-1] + ' ' + _y.slice(0,4)) : _y; })(),
      // Data-quality flags: true = TWS served delayed (~10 min) data, meaning no
      // real-time subscription for that instrument. ES needs CME real-time;
      // SPX/index needs its own real-time feed.
      esDelayed: !!esSnap.delayed,
      priceDelayed: !!mainSnap.delayed,
      vixDelayed: !!vixSnap.delayed,
      emVix, // VIX-derived EM estimate
      // Meta
      timestamp: new Date().toISOString(),
      source: 'IBKR TWS',
      // Data-freshness indicator (see derivation above)
      dataType,        // realtime | frozen | delayed | delayed-frozen | unknown
      dataTypeLabel,   // human-readable
      isLive,          // true only when price is a live real-time tick
      asOf: new Date().toISOString(),
      spyVwap: usesSPYVwap
    };

    console.log(`[BRIDGE] ${underlying}: price=${result.price} vix=${result.vix} em=${result.em} atr=${result.atr}`);
    res.json(result);
  } catch (err) {
    console.error('[BRIDGE] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Health check
// ── Historical intraday bars, for backtesting ────────────────────────────────
// GET /api/history?underlying=QQQ&barSize=5%20mins&months=3
//
// IBKR will not serve a long span of intraday bars in one request — the duration it
// accepts shrinks as the bar size does, and asking for too much returns an error or a
// pacing violation rather than a short answer. So this walks backwards in one-month
// chunks and merges. Pacing matters too: IBKR allows roughly 6 historical requests per
// 2 seconds and 60 per 10 minutes, so there is a deliberate delay between chunks.
//
// Bars come back with formatDate=1 and useRTH=1: "yyyymmdd  hh:mm:ss" strings in the
// INSTRUMENT's timezone (US/Eastern for QQQ), regular hours only. That is already the
// timezone the engines reason in, so no conversion — but it does mean these timestamps
// are exchange-local, not UTC, and must not be parsed as if they were.
app.get('/api/history', async (req, res) => {
  try {
    await connectTWS();
    if (!connected) return res.status(503).json({ error: 'Not connected to TWS' });

    const underlying = (req.query.underlying || 'QQQ').toUpperCase();
    const barSize = req.query.barSize || '5 mins';
    const months = Math.max(1, Math.min(12, parseInt(req.query.months || '3', 10)));
    const contract = contractOf(underlying);
    if (!contract) return res.status(400).json({ error: `Unknown underlying ${underlying}` });
    const whatToShow = (contract.secType === SecType.IND) ? WhatToShow.MIDPOINT : WhatToShow.TRADES;

    const pad = n => String(n).padStart(2, '0');
    const stamp = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

    const seen = new Set();
    const all = [];
    const errors = [];
    let end = new Date();

    for (let i = 0; i < months; i++) {
      try {
        const chunk = await getHistoricalBars(contract, '1 M', barSize, whatToShow, stamp(end));
        console.log(`[BRIDGE] history chunk ${i + 1}/${months} ending ${stamp(end)}: ${chunk.length} bars`);
        // Chunks overlap at the seams; dedupe on the timestamp rather than assuming.
        for (const b of chunk) { if (!seen.has(b.date)) { seen.add(b.date); all.push(b); } }
        if (!chunk.length) { errors.push(`chunk ending ${stamp(end)} returned no bars`); break; }
      } catch (e) {
        errors.push(`chunk ending ${stamp(end)}: ${e.message}`);
      }
      end = new Date(end.getTime() - 30 * 24 * 3600 * 1000);
      if (i < months - 1) await new Promise(r => setTimeout(r, 2000));  // IBKR pacing
    }

    all.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    res.json({
      underlying, barSize, months, bars: all, count: all.length,
      first: all[0]?.date || null, last: all[all.length - 1]?.date || null,
      // Partial results are returned WITH their errors rather than thrown away — a short
      // history is usable for a backtest as long as you know it is short.
      errors: errors.length ? errors : undefined,
      timezone: 'exchange-local (US/Eastern for US equities), RTH only',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Trade replay ──────────────────────────────────────────────────────────
// GET /api/trade-replay?underlying=SPY&expiry=20260930&legs=759C:1,763C:-2,768C:1
//                      &date=20260929[&barSize=5 mins][&entry=11:35][&exit=15:35]
//
// Returns the structure's own value series, rebuilt from per-leg BID and ASK bars
// rather than from TWS's synthetic COMBO quote — see bridge/replay.js for why that
// distinction is the whole point of this endpoint.
//
// IBKR serves historical data for an option only while the contract lives. Once it
// expires the bars are gone, so this is a same-day / pre-expiry tool: pull the
// replay when the trade closes, not next week.
app.get('/api/trade-replay', async (req, res) => {
  try {
    await connectTWS();
    if (!connected) return res.status(503).json({ error: 'Not connected to TWS' });

    const underlying = (req.query.underlying || '').toUpperCase();
    const expiry = String(req.query.expiry || '');
    const date = String(req.query.date || '');
    const barSize = req.query.barSize || '5 mins';
    if (!contractOf(underlying)) return res.status(400).json({ error: `Unknown underlying ${underlying}` });
    if (!/^\d{8}$/.test(expiry)) return res.status(400).json({ error: 'expiry must be YYYYMMDD' });
    if (!/^\d{8}$/.test(date)) return res.status(400).json({ error: 'date must be YYYYMMDD' });

    let legs;
    try { legs = parseLegs(req.query.legs); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    if (!legs.length) return res.status(400).json({ error: 'legs required, e.g. 759C:1,763C:-2,768C:1' });
    if (legs.length > 6) return res.status(400).json({ error: 'at most 6 legs' });

    // End of the session being replayed, in IBKR's local-exchange form.
    const endDateTime = `${date} 16:00:00`;
    const warnings = [];

    // IBKR paces historical requests hard (roughly 6 in 2 seconds, 60 in 10 min).
    // Two requests per leg plus the underlying, spaced, is well inside that.
    const pace = () => new Promise(r => setTimeout(r, 1100));
    const pull = async (contract, what, label) => {
      const bars = await getHistoricalBars(contract, '1 D', barSize, what, endDateTime, 1, 2);
      if (!bars.length) warnings.push(`${label} ${what}: no bars returned`);
      await pace();
      return bars;
    };

    const legBars = {};
    for (const l of legs) {
      const c = buildOptionContract(underlying, expiry, l.strike, l.right);
      const k = legKey(l);
      legBars[k] = {
        bid: await pull(c, WhatToShow.BID, k),
        ask: await pull(c, WhatToShow.ASK, k),
      };
    }
    const und = await pull(contractOf(underlying),
      contractOf(underlying).secType === SecType.IND ? WhatToShow.MIDPOINT : WhatToShow.TRADES,
      underlying);

    const { bars, dropped } = composeCombo(legs, legBars, und);
    if (dropped) warnings.push(`${dropped} bars dropped — a leg was unquoted or crossed at those times`);
    if (!bars.length) {
      return res.status(502).json({
        error: 'No aligned bars. If the expiry has passed, IBKR no longer serves this contract.',
        warnings, legs, underlying, expiry, date
      });
    }

    // Optional entry/exit clock times (ET, HH:MM) mark the hold inside the session.
    const clockToEpoch = (hhmm) => {
      if (!/^\d{1,2}:\d{2}$/.test(hhmm || '')) return null;
      const [h, m] = hhmm.split(':').map(Number);
      // Bars carry epoch seconds; find the bar whose ET wall clock matches.
      const want = h * 60 + m;
      let best = null, bestGap = Infinity;
      for (const b of bars) {
        const d = new Date(b.t * 1000);
        const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const gap = Math.abs(et.getHours() * 60 + et.getMinutes() - want);
        if (gap < bestGap) { bestGap = gap; best = b.t; }
      }
      return best;
    };
    const entryEpoch = clockToEpoch(req.query.entry);
    const exitEpoch = clockToEpoch(req.query.exit);

    res.json({
      underlying, expiry, date, barSize,
      legs: legs.map(l => ({ ...l, key: legKey(l) })),
      geometry: geometry(legs),
      summary: summarise(legs, bars, { entryEpoch, exitEpoch }),
      bars,
      dropped,
      warnings: warnings.length ? warnings : undefined,
      source: 'per-leg BID/ASK historical bars, summed by ratio — not the TWS COMBO quote',
      pulledAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[BRIDGE] trade-replay error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Debug view of the ES overnight derivation: what the bars say vs the snapshot.
app.get('/api/es-overnight', async (req, res) => {
  try {
    await connectTWS();
    try { ib.reqMarketDataType(3); } catch (e) {}
    const esContract = getESContract();
    const [snap, bars] = await Promise.all([
      getSnapshot(esContract),
      getHistoricalBars(esContract, '5 D', BarSizeSetting.MINUTES_FIVE, WhatToShow.TRADES, '', 0, 2).catch(() => [])
    ]);
    res.json({
      contract: esContract.lastTradeDateOrContractMonth,
      bars: bars.length,
      firstBar: bars[0]?.date ? new Date(Number(bars[0].date) * 1000).toISOString() : null,
      lastBar: bars.length ? new Date(Number(bars[bars.length - 1].date) * 1000).toISOString() : null,
      fromBars: computeOvernight(bars, Date.now() / 1000),
      snapshot: { last: snap.last, mid: snap.mid, bid: snap.bid, ask: snap.ask, close: snap.prevClose, high: snap.high, low: snap.low, delayed: !!snap.delayed }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, connected, timestamp: new Date().toISOString(),
    startedAt: STARTED_AT, lastError: connected ? '' : lastConnectError,
    reconnecting: !!reconnectTimer, canRestart: true,
    app: connected ? session.app : '', mode: connected ? session.mode : '',
    port: connected ? session.port : null, accounts: connected ? session.accounts : [] });
});

// ── Control from the app (Oct 2026) ──
// Reconnect: throw away the IBKR connection and make a fresh one — the fix for
// "Bridge up, TWS not connected" after TWS restarts or re-logs in.
app.post('/api/reconnect', async (req, res) => {
  resetIB();
  try { await connectTWS(); res.json({ ok: true, connected }); }
  catch (e) { lastConnectError = e.message; scheduleReconnect(); res.json({ ok: false, connected: false, error: e.message }); }
});

// Restart: exit the process. The LaunchAgent has KeepAlive=true, so launchd
// starts it again within ~10 s — running whatever code is now on disk, which is
// what a `launchctl unload/load` after a git pull was for. Answers first, then exits.
app.post('/api/restart', (req, res) => {
  res.json({ ok: true, restarting: true });
  console.log('[BRIDGE] Restart requested from the app');
  setTimeout(() => { resetIB(); process.exit(0); }, 400);
});

// ── Fetch model Greeks for one or more option legs ──
// GET /api/option-greeks?underlying=SPX&expiry=YYYYMMDD&strike=7480&right=C
// For multi-leg positions, pass legs as JSON: ?legs=[{strike,right},...]
// Returns single-leg greeks, and (if multiple legs) net position greeks.
app.get('/api/option-greeks', async (req, res) => {
  try {
    await connectTWS();
    if (!connected) return res.status(503).json({ error: 'Not connected to TWS' });
    // Frozen(2) for options: real-time via OPRA in RTH, last snapshot after hours.
    try { ib.reqMarketDataType(2); } catch (e) {}
    const underlying = (req.query.underlying || 'SPX').toUpperCase();
    const expiry = req.query.expiry; // YYYYMMDD
    if (!expiry) return res.status(400).json({ error: 'expiry (YYYYMMDD) required' });

    // Parse legs: either a single strike/right, or a legs=[...] array with qty.
    let legs;
    if (req.query.legs) {
      legs = JSON.parse(req.query.legs); // [{ strike, right, qty }]
    } else {
      legs = [{ strike: Number(req.query.strike), right: req.query.right || 'C', qty: 1 }];
    }

    const results = [];
    let anyNotSubscribed = false;
    for (const leg of legs) {
      // A leg may carry its own expiry (calendars and diagonals); the query's
      // expiry is the default for every other structure. (Oct 2026.)
      const legExp = /^\d{8}$/.test(String(leg.expiry || '')) ? String(leg.expiry) : expiry;
      const contract = buildOptionContract(underlying, legExp, leg.strike, leg.right);
      const g = await getOptionGreeks(contract);
      if (g && g.notSubscribed) { anyNotSubscribed = true; results.push({ strike: leg.strike, right: leg.right, expiry: legExp, qty: leg.qty || 1, greeks: null }); }
      else results.push({ strike: leg.strike, right: leg.right, expiry: legExp, qty: leg.qty || 1, greeks: g });
    }

    // Net position greeks (sum of qty × per-contract greek). For a butterfly the
    // engine mainly wants |delta|, theta, gamma of the whole structure.
    const net = { delta: 0, gamma: 0, theta: 0, vega: 0 };
    let haveAny = false;
    for (const r of results) {
      if (!r.greeks) continue;
      haveAny = true;
      const q = r.qty || 1;
      net.delta += (r.greeks.delta || 0) * q * 100; // ×100 → position dollars per $1 move
      net.gamma += (r.greeks.gamma || 0) * q * 100;
      net.theta += (r.greeks.theta || 0) * q * 100; // per-day position theta ($)
      net.vega  += (r.greeks.vega  || 0) * q * 100;
    }
    // Theta keeps its sign. q above is signed (+ long, - short) and IB reports
    // per-contract theta negative, so the sum is already in the engine's convention:
    // POSITIVE = the structure collects decay, NEGATIVE = it pays decay. Absing it
    // here handed the engine a decay-EARNED number for every position, including the
    // ones bleeding theta every hour - which is how a long fly came back looking like
    // a premium seller. (Jul 2026.)
    // Combo bid/ask from the per-leg quotes. Buying a spread pays the ask on the
    // legs you are long and receives the bid on the ones you are short; selling it
    // is the mirror. Reproduces the TWS combo quote to the cent on flies, verticals
    // and condors. Null unless EVERY leg quoted - a partial sum is a wrong number,
    // not an approximate one. (Sep 2026.)
    let comboBid = 0, comboAsk = 0, comboOk = results.length > 0;
    for (const r of results) {
      const b = r.greeks && r.greeks.bid, a = r.greeks && r.greeks.ask, q = r.qty || 1;
      if (b == null || a == null || !isFinite(b) || !isFinite(a)) { comboOk = false; break; }
      comboAsk += q > 0 ? q * a : q * b;
      comboBid += q > 0 ? q * b : q * a;
    }
    const netOut = haveAny ? {
      delta: +net.delta.toFixed(2),
      gamma: +net.gamma.toFixed(2),
      theta: +net.theta.toFixed(2),
      vega: +net.vega.toFixed(2),
      bid: comboOk ? +comboBid.toFixed(2) : null,
      ask: comboOk ? +comboAsk.toFixed(2) : null
    } : null;

    // Feed freshness: which IBKR data type actually served these greeks, plus the
    // underlying price the model used — lets the app show real-time vs delayed.
    // Which computation actually served each leg. A net position greek is only a
    // valid sum when every leg came off the same one; say so when it did not.
    const _tt = results.filter(r => r.greeks).map(r => r.greeks.tickType);
    const _TTLBL = { 13: 'model', 12: 'last', 11: 'ask', 10: 'bid' };
    const greekSource = _tt.length === 0 ? null
      : _tt.every(t => t === 13) ? 'model'
      : new Set(_tt).size > 1 ? 'mixed'
      : (_TTLBL[_tt[0]] || 'non-model');
    const greeksMixed = greekSource != null && greekSource !== 'model';

    const _leg0 = results.find(r => r.greeks);
    const _md = _leg0 && _leg0.greeks ? _leg0.greeks.mdType : null;
    const _MDLBL = { 1: 'Real-time', 2: 'Frozen (last)', 3: 'Delayed ~15m', 4: 'Delayed-frozen' };
    const dataType = _md === 1 ? 'realtime' : _md === 2 ? 'frozen' : _md === 3 ? 'delayed' : _md === 4 ? 'delayed-frozen' : 'unknown';
    res.json({ underlying, expiry, legs: results, net: netOut,
      greekSource, greeksMixed,
      dataType, dataTypeLabel: _MDLBL[_md] || 'Unknown',
      undPrice: _leg0 && _leg0.greeks ? _leg0.greeks.undPrice : null,
      asOf: new Date().toISOString(),
      notSubscribed: anyNotSubscribed && !netOut,
      message: (anyNotSubscribed && !netOut)
        ? 'TWS returned no Greeks — your IBKR account is not subscribed to options market data for ' + underlying + '. Enable the OPRA / US options data subscription in IBKR Account Management, or enter Greeks manually.'
        : undefined });
  } catch (err) {
    console.log('[BRIDGE] option-greeks error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── ATM straddle expected move ──
// EM ≈ (ATM call mid + ATM put mid) × haircut. This is the market's own priced
// expected move to the given expiry — bakes in skew, events, term structure —
// far better than annualised-VIX/√252. Returns the leg prices used so the UI
// can show them. Needs OPRA option-data subscription (like /api/option-greeks).
app.get('/api/atm-straddle', async (req, res) => {
  try {
    await connectTWS();
    if (!connected) return res.status(503).json({ error: 'Not connected to TWS' });
    // Frozen(2) for options: real-time via OPRA in RTH, last snapshot after hours.
    try { ib.reqMarketDataType(2); } catch (e) {}
    const underlying = (req.query.underlying || 'SPX').toUpperCase();
    const expiry = req.query.expiry; // YYYYMMDD
    // Straddle -> 1 SD. Black-Scholes ATM identity: straddle ~= 0.7979 * S * sigma * sqrt(T),
    // so 1 SD = straddle * 1/0.7979 = straddle * 1.2533. The old 0.85 default was an
    // inverted haircut that landed on 0.68 SD, roughly half the true expected move.
    const haircut = req.query.haircut ? Number(req.query.haircut) : 1.2533;
    if (!expiry) return res.status(400).json({ error: 'expiry (YYYYMMDD) required' });

    // 1) Spot: use a caller-supplied hint when present, else the index/stock
    // snapshot. The multi-scan passes its resolved VWAP-fallback price as ?spot=,
    // which lets the straddle price even when the live STK snapshot returns nothing
    // (SPY/QQQ/IWM) and skips a ~6s snapshot when spot is already known.
    const spotContract = contractOf(underlying) || { symbol: underlying, secType: SecType.IND, exchange: 'CBOE', currency: 'USD' };
    const spotHint = req.query.spot ? Number(req.query.spot) : 0;
    let spot = spotHint > 0 ? spotHint : 0;
    if (!spot) {
      const spotSnap = await getSnapshot(spotContract);
      spot = spotSnap.mid || spotSnap.last || spotSnap.prevClose;  // close = last-resort anchor
      if (!spot || spot <= 0) {
        console.log(`[BRIDGE] atm-straddle ${underlying}: no spot (mid=${spotSnap.mid||0} last=${spotSnap.last||0} close=${spotSnap.prevClose||0})`);
        return res.status(502).json({ error: 'Could not read spot price' });
      }
    }

    // 2) Nearest strike. Strike increments differ by product.
    const inc = (underlying === 'SPX' || underlying === 'NDX') ? 5
      : (underlying === 'RUT') ? 5
      : 1; // SPY/QQQ/IWM = 1
    const atmStrike = Math.round(spot / inc) * inc;

    // 3) Fetch ATM call and put mids for the expiry.
    const callC = buildOptionContract(underlying, expiry, atmStrike, 'C');
    const putC  = buildOptionContract(underlying, expiry, atmStrike, 'P');
    const [callSnap, putSnap] = await Promise.all([getSnapshot(callC), getSnapshot(putC)]);
    const callPrice = callSnap.mid || callSnap.last || callSnap.prevClose;  // close = prior settle
    const putPrice  = putSnap.mid  || putSnap.last  || putSnap.prevClose;
    console.log(`[BRIDGE] atm-straddle ${underlying} spot=${spot} atm=${atmStrike} inc=${inc}: call=${callPrice||0} put=${putPrice||0}`);

    if (!callPrice || !putPrice || callPrice <= 0 || putPrice <= 0) {
      return res.json({ notSubscribed: true, error: 'No option prices — check OPRA/options market-data subscription', spot, atmStrike });
    }

    const straddle = callPrice + putPrice;
    // For SPX the straddle price IS in index points (EM in points). For ETFs the
    // option price is in $, which for a $1-multiplier equals points too.
    const expectedMove = straddle * haircut;
    res.json({
      spot: +spot.toFixed(2),
      atmStrike,
      expiry,
      callPrice: +callPrice.toFixed(2),
      putPrice: +putPrice.toFixed(2),
      straddle: +straddle.toFixed(2),
      haircut,
      expectedMove: +expectedMove.toFixed(2),
      source: 'straddle'
    });
  } catch (err) {
    console.log('[BRIDGE] atm-straddle error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
//  VOL SURFACE — GET /api/vol-surface?underlying=SPX&expiry=YYYYMMDD[&spot=]
//  Fills the 45DTE Vol Surface panel (Oct 2026). Everything comes off TWS:
//    iv       ATM model IV at the trade's expiry (mean of call + put)
//    ivFront  ATM model IV at the listed expiry nearest 30 DTE
//    ivBack   ATM model IV at the listed expiry nearest 90 DTE
//    termBias derived from ivFront / ivBack (same ratio as VIX/VIX3M)
//    skew     25Δ put IV − 25Δ call IV at the trade's expiry, vol points
//    ivr      IV Rank off IB's 1-year daily OPTION_IMPLIED_VOLATILITY series
//    hv       IB's 30-day HISTORICAL_VOLATILITY (close-to-close fallback)
//  Each piece is fetched independently; whatever fails is listed in `missing`
//  and the rest still returns, so one dead leg never blanks the panel.
// ================================================================
const vsCache = { chain: {}, hist: {} };
const HIST_TTL_MS = 30 * 60 * 1000;   // IVR/HV move slowly; 30 min keeps the pull cheap

function getConId(contract) {
  return new Promise((resolve) => {
    const reqId = getReqId();
    let conId = null, done = false;
    const finish = () => {
      if (done) return; done = true;
      ib.removeListener(EventName.contractDetails, onDet);
      ib.removeListener(EventName.contractDetailsEnd, onEnd);
      resolve(conId);
    };
    const onDet = (id, det) => { if (id === reqId && !conId && det && det.contract) conId = det.contract.conId; };
    const onEnd = (id) => { if (id === reqId) finish(); };
    ib.on(EventName.contractDetails, onDet);
    ib.on(EventName.contractDetailsEnd, onEnd);
    ib.reqContractDetails(reqId, contract);
    setTimeout(finish, 6000);
  });
}

// Listed expirations + strikes for the trading class the app trades
// (SPXW for SPX, RUTW for RUT, the symbol itself for ETFs). Cached per NY day.
async function getOptionChain(underlying) {
  const key = underlying + ':' + nyToday();
  if (vsCache.chain[key]) return vsCache.chain[key];
  const base = contractOf(underlying);
  if (!base) return null;
  const conId = await getConId(base);
  if (!conId) return null;
  const want = underlying === 'SPX' ? 'SPXW' : underlying === 'RUT' ? 'RUTW' : underlying;
  const rows = await new Promise((resolve) => {
    const reqId = getReqId();
    const out = []; let done = false;
    const finish = () => {
      if (done) return; done = true;
      ib.removeListener(EventName.securityDefinitionOptionParameter, onRow);
      ib.removeListener(EventName.securityDefinitionOptionParameterEnd, onEnd);
      resolve(out);
    };
    const onRow = (id, exchange, uConId, tradingClass, multiplier, expirations, strikes) => {
      if (id === reqId) out.push({ exchange, tradingClass, expirations: [...(expirations || [])], strikes: [...(strikes || [])] });
    };
    const onEnd = (id) => { if (id === reqId) finish(); };
    ib.on(EventName.securityDefinitionOptionParameter, onRow);
    ib.on(EventName.securityDefinitionOptionParameterEnd, onEnd);
    ib.reqSecDefOptParams(reqId, base.symbol, '', base.secType, conId);
    setTimeout(finish, 8000);
  });
  const mine = rows.filter(r => r.tradingClass === want);
  const pick = mine.length ? mine : rows;
  if (!pick.length) return null;
  const exps = [...new Set(pick.flatMap(r => r.expirations))].sort();
  const strikes = [...new Set(pick.flatMap(r => r.strikes))].sort((a, b) => a - b);
  const chain = { tradingClass: mine.length ? want : (pick[0].tradingClass || undefined), expirations: exps, strikes };
  vsCache.chain[key] = chain;
  console.log(`[BRIDGE] chain ${underlying}/${chain.tradingClass}: ${exps.length} expiries, ${strikes.length} strikes`);
  return chain;
}

// IB's own daily vol series for the underlying, as % (it sends decimals).
async function getVolHistory(underlying) {
  const hit = vsCache.hist[underlying];
  if (hit && Date.now() - hit.at < HIST_TTL_MS) return hit;
  const c = contractOf(underlying);
  const pct = bars => bars.map(b => barClose(b)).filter(x => x > 0).map(x => x * 100);
  let iv = [], hv = [], closes = [], daily = [];
  try { iv = pct(await getHistoricalBars(c, '1 Y', '1 day', WhatToShow.OPTION_IMPLIED_VOLATILITY)); } catch (e) { console.log('[BRIDGE] vol-surface IV history:', e.message); }
  try { hv = pct(await getHistoricalBars(c, '3 M', '1 day', WhatToShow.HISTORICAL_VOLATILITY)); } catch (e) { console.log('[BRIDGE] vol-surface HV history:', e.message); }
  // Daily OHLC for the 45DTE trend read (SMA 20/50, ADX 14, stretch, HV10/HV60).
  // Indices have no TRADES history here, so SPX/XSP read SPY and RUT reads IWM —
  // every trend number is a ratio or a %, so the proxy's scale does not matter.
  const dailySource = (underlying === 'SPX' || underlying === 'XSP') ? 'SPY' : underlying === 'RUT' ? 'IWM' : underlying;
  try {
    const bars = await getHistoricalBars(contracts[dailySource] || c, '1 Y', '1 day', WhatToShow.TRADES);
    daily = bars.filter(b => b && b.close > 0 && b.high > 0 && b.low > 0)
      .map(b => [String(b.date).slice(0, 8), +b.open || +b.close, +b.high, +b.low, +b.close]);
  } catch (e) { console.log('[BRIDGE] vol-surface daily bars:', e.message); }
  if (!hv.length) {
    closes = daily.length ? daily.map(b => b[4]) : [];
    if (!closes.length) {
      try { closes = (await getHistoricalBars(c, '3 M', '1 day', WhatToShow.TRADES)).map(barClose); } catch (e) { /* fallback only */ }
    }
  }
  const out = { at: Date.now(), iv, hv, closes, daily, dailySource };
  if (iv.length || hv.length || closes.length || daily.length) vsCache.hist[underlying] = out;
  return out;
}

// Listed expiries (and strikes) for an underlying, so the app can offer the real
// near/far dates for a calendar or diagonal instead of guessing. Future expiries
// within ~14 months; cached per NY day by getOptionChain. (Oct 2026.)
app.get('/api/option-chain', async (req, res) => {
  try {
    await connectTWS();
    if (!connected) return res.status(503).json({ error: 'Not connected to TWS' });
    const underlying = (req.query.underlying || 'SPX').toUpperCase();
    if (!contractOf(underlying)) return res.status(400).json({ error: `No option chain for ${underlying}` });
    const chain = await getOptionChain(underlying);
    if (!chain) return res.status(502).json({ error: 'TWS returned no option chain' });
    const today = nyToday();
    const limit = addDays(today, 430);
    res.json({
      underlying, tradingClass: chain.tradingClass || null, today,
      expirations: chain.expirations.filter(e => e > today && e <= limit),
      strikes: chain.strikes
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Strikes listed for ONE expiry, calls and puts apart (Oct 2026). The chain above is
// the union over every expiry, which hides that e.g. QQQ 20 Nov lists puts every $1
// but calls every $5 that far out. reqContractDetails with no strike returns every
// contract of the expiry. Cached per NY day.
const listedCache = {};
function getListedStrikes(underlying, expiry) {
  const key = underlying + ':' + expiry + ':' + nyToday();
  if (listedCache[key]) return Promise.resolve(listedCache[key]);
  const base = buildOptionContract(underlying, expiry, 0, 'C');
  delete base.strike; delete base.right;
  if (underlying === 'RUT') base.tradingClass = 'RUTW';
  return new Promise((resolve) => {
    const reqId = getReqId();
    const C = new Set(), P = new Set();
    let done = false, rows = 0;
    // complete = TWS said contractDetailsEnd. A timeout returns what arrived but is
    // never cached, and the app will not fit strikes to it.
    const finish = (complete) => {
      if (done) return; done = true;
      ib.removeListener(EventName.contractDetails, onDet);
      ib.removeListener(EventName.contractDetailsEnd, onEnd);
      const out = { calls: [...C].sort((a, b) => a - b), puts: [...P].sort((a, b) => a - b), complete: !!complete, rows };
      if (complete && out.calls.length && out.puts.length) listedCache[key] = out;
      console.log(`[BRIDGE] listed ${underlying} ${expiry}: ${rows} contracts, ${out.puts.length} puts, ${out.calls.length} calls${complete ? '' : ' (TIMED OUT)'}`);
      resolve(out);
    };
    const onDet = (id, det) => {
      if (id !== reqId || !det || !det.contract) return;
      rows++;
      const k = Number(det.contract.strike), r = String(det.contract.right || '').toUpperCase();
      if (!(k > 0)) return;
      if (r.startsWith('C')) C.add(k); else if (r.startsWith('P')) P.add(k);
    };
    const onEnd = (id) => { if (id === reqId) finish(true); };
    ib.on(EventName.contractDetails, onDet);
    ib.on(EventName.contractDetailsEnd, onEnd);
    ib.reqContractDetails(reqId, base);
    setTimeout(() => finish(false), 30000);
  });
}

app.get('/api/listed-strikes', async (req, res) => {
  try {
    await connectTWS();
    if (!connected) return res.status(503).json({ error: 'Not connected to TWS' });
    const underlying = (req.query.underlying || 'SPX').toUpperCase();
    const expiry = String(req.query.expiry || '');
    if (!/^\d{8}$/.test(expiry)) return res.status(400).json({ error: 'expiry (YYYYMMDD) required' });
    const out = await getListedStrikes(underlying, expiry);
    if (!out.calls.length && !out.puts.length) return res.status(404).json({ error: `No listed strikes for ${underlying} ${expiry}` });
    res.json({ underlying, expiry, ...out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/vol-surface', async (req, res) => {
  try {
    await connectTWS();
    if (!connected) return res.status(503).json({ error: 'Not connected to TWS' });
    try { ib.reqMarketDataType(2); } catch (e) {}
    const underlying = (req.query.underlying || 'SPX').toUpperCase();
    if (!contractOf(underlying) || ['VIX', 'VIX1D', 'ES'].includes(underlying)) {
      return res.status(400).json({ error: `Vol surface not supported for ${underlying}` });
    }
    const today = nyToday();
    const reqExpiry = /^\d{8}$/.test(req.query.expiry || '') ? req.query.expiry : addDays(today, 45);
    const missing = [], notes = [];

    // History runs alongside the option pulls — it is the slow, cacheable half.
    const histP = getVolHistory(underlying).catch(() => ({ iv: [], hv: [], closes: [], daily: [] }));
    const lvl = s => (s && (s.mid > 0 ? s.mid : s.last > 0 ? s.last : s.prevClose > 0 ? s.prevClose : 0)) || 0;
    const vixP = Promise.all([getSnapshot(contracts.VIX).catch(() => null), getSnapshot(contracts.VIX3M).catch(() => null)])
      .then(([a, b]) => ({ vix: lvl(a), vix3m: lvl(b) }));

    // 1) Spot
    let spot = Number(req.query.spot) || 0;
    if (!(spot > 0)) {
      const s = await getSnapshot(contractOf(underlying));
      spot = s.mid || s.last || s.prevClose || 0;
    }

    // 2) Expiries off the real chain; Friday-nearest if the chain lookup fails.
    const chain = await getOptionChain(underlying).catch(() => null);
    if (!chain) notes.push('Option chain lookup failed — expiries snapped to the nearest Friday');
    const pickExp = (target, minDte) => chain
      ? nearestExpiry(chain.expirations, target, today, minDte)
      : fridayNear(target);
    const tradeExp = pickExp(reqExpiry, 1);
    const frontExp = pickExp(addDays(today, 30), 14);
    let backExp = pickExp(addDays(today, 90), 45);
    if (backExp && frontExp && backExp <= frontExp) backExp = null;
    const inc = ['SPX', 'NDX', 'RUT'].includes(underlying) ? 5 : 1;

    const opt = (exp, strike, right) => {
      const c = buildOptionContract(underlying, exp, strike, right);
      if (chain && chain.tradingClass) c.tradingClass = chain.tradingClass;
      return c;
    };
    const atmIV = async (exp) => {
      if (!exp || !(spot > 0)) return null;
      const k = nearestStrike(chain && chain.strikes, spot, inc);
      const [c, p] = await Promise.all([getOptionGreeks(opt(exp, k, 'C')), getOptionGreeks(opt(exp, k, 'P'))]);
      const iv = avgIV(c && c.iv, p && p.iv);
      return { expiry: exp, dte: daysBetween(today, exp), strike: k, iv: iv != null ? +iv.toFixed(2) : null,
        callIV: c && c.iv, putIV: p && p.iv, mdType: (c && c.mdType) || (p && p.mdType) || null,
        notSubscribed: !!((c && c.notSubscribed) && (p && p.notSubscribed)) };
    };

    // 3) ATM IV at the three expiries, in parallel (6 market-data lines).
    const [tradeAtm, frontAtm, backAtm] = spot > 0
      ? await Promise.all([atmIV(tradeExp), atmIV(frontExp), atmIV(backExp)])
      : [null, null, null];
    if (!(spot > 0)) notes.push('No spot price — option IVs skipped');

    // 4) 25Δ skew at the trade expiry. Two strikes per side bracket the real 25Δ
    // (skew pushes it past the flat-vol estimate), then interpolate in delta.
    let skew = null, skewDetail = null;
    if (tradeAtm && tradeAtm.iv > 0) {
      const sig = tradeAtm.iv / 100, T = Math.max(tradeAtm.dte, 1) / 365, step = 0.25 * sig * Math.sqrt(T) * spot;
      const kP = strikeForDelta(spot, sig, T, 'P'), kC = strikeForDelta(spot, sig, T, 'C');
      const ks = {
        P: [nearestStrike(chain && chain.strikes, kP, inc), nearestStrike(chain && chain.strikes, kP - step, inc)],
        C: [nearestStrike(chain && chain.strikes, kC, inc), nearestStrike(chain && chain.strikes, kC - step, inc)],
      };
      const legs = [['P', ks.P[0]], ['P', ks.P[1]], ['C', ks.C[0]], ['C', ks.C[1]]];
      const got = await Promise.all(legs.map(([r, k]) => getOptionGreeks(opt(tradeExp, k, r))));
      const pts = r => legs.map((l, i) => l[0] === r && got[i] ? { strike: l[1], iv: got[i].iv, delta: got[i].delta } : null);
      const p25 = interpAtDelta(pts('P')), c25 = interpAtDelta(pts('C'));
      if (p25 && c25) {
        skew = +(p25.iv - c25.iv).toFixed(2);
        skewDetail = {
          put: { strike: Math.round(p25.strike), delta: +p25.delta.toFixed(3), iv: +p25.iv.toFixed(2), interpolated: p25.interpolated },
          call: { strike: Math.round(c25.strike), delta: +c25.delta.toFixed(3), iv: +c25.iv.toFixed(2), interpolated: c25.interpolated },
        };
        if (!p25.interpolated || !c25.interpolated) notes.push('25Δ not bracketed on one side — skew read off the nearest fetched delta');
      }
    }

    // 5) IVR + HV from history.
    const hist = await histP;
    const ivStats = ivRankStats(hist.iv);
    let hv = hist.hv.length ? +hist.hv[hist.hv.length - 1].toFixed(2) : null, hvSource = hv != null ? 'ib-30d' : null;
    if (hv == null) { hv = realisedVol(hist.closes, 30); if (hv != null) hvSource = 'close-to-close-30d'; }

    const term = termBiasFromIV(frontAtm && frontAtm.iv, backAtm && backAtm.iv);
    const out = {
      underlying, spot: spot > 0 ? +spot.toFixed(2) : null, today,
      expiries: { requested: reqExpiry, trade: tradeExp, front: frontExp, back: backExp,
        tradeDte: tradeExp ? daysBetween(today, tradeExp) : null,
        frontDte: frontExp ? daysBetween(today, frontExp) : null,
        backDte: backExp ? daysBetween(today, backExp) : null },
      iv: tradeAtm ? tradeAtm.iv : null, atm: tradeAtm,
      ivFront: frontAtm ? frontAtm.iv : null, ivBack: backAtm ? backAtm.iv : null,
      termBias: term.bias || null, termRatio: term.ratio,
      skew, skewDetail,
      ivr: ivStats ? ivStats.rank : null, ivPctl: ivStats ? ivStats.pctl : null,
      iv30: ivStats ? +ivStats.current.toFixed(2) : null,
      iv52wLow: ivStats ? +ivStats.low.toFixed(2) : null, iv52wHigh: ivStats ? +ivStats.high.toFixed(2) : null,
      hv, hvSource,
      // Daily bars [yyyymmdd, o, h, l, c] (last ~260) for the client's trend read.
      daily: (hist.daily || []).slice(-260), dailySource: hist.dailySource || null,
      asOf: new Date().toISOString(),
    };
    const vx = await vixP;
    out.vix = vx.vix > 0 ? +vx.vix.toFixed(2) : null;
    out.vix3m = vx.vix3m > 0 ? +vx.vix3m.toFixed(2) : null;
    out.vixTermRatio = out.vix && out.vix3m ? +(out.vix / out.vix3m).toFixed(3) : null;
    ['iv', 'ivFront', 'ivBack', 'skew', 'ivr', 'hv'].forEach(k => { if (out[k] == null) missing.push(k); });
    if (!term.bias) missing.push('termBias');
    const md = (tradeAtm && tradeAtm.mdType) || (frontAtm && frontAtm.mdType) || null;
    out.dataType = md === 1 ? 'realtime' : md === 2 ? 'frozen' : md === 3 ? 'delayed' : md === 4 ? 'delayed-frozen' : 'unknown';
    out.notSubscribed = !!(tradeAtm && tradeAtm.notSubscribed && out.iv == null);
    out.missing = missing; out.notes = notes;
    console.log(`[BRIDGE] vol-surface ${underlying} ${tradeExp}: iv=${out.iv} front=${out.ivFront} back=${out.ivBack} (${out.termBias}) skew=${skew} ivr=${out.ivr} hv=${hv} missing=${missing.join(',') || '-'}`);
    res.json(out);
  } catch (err) {
    console.log('[BRIDGE] vol-surface error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Fetch today's executions (fills) from TWS ──
app.get('/api/executions', async (req, res) => {
  try {
    await connectTWS();
  } catch (e) {
    return res.status(503).json({ error: 'Not connected to TWS' });
  }
  if (!connected) return res.status(503).json({ error: 'Not connected to TWS' });

  const reqId = nextReqId++;
  const executions = [];
  const commissions = {};

  try {
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ib.removeListener(EventName.execDetails, onExec);
        ib.removeListener(EventName.execDetailsEnd, onEnd);
        ib.removeListener(EventName.commissionReport, onComm);
        resolve(executions);
      }, 10000);

      function onExec(rId, contract, execution) {
        if (rId !== reqId) return;
        executions.push({
          execId: execution.execId,
          time: execution.time,
          account: execution.acctNumber,
          symbol: contract.symbol,
          secType: contract.secType,
          exchange: contract.exchange,
          side: execution.side, // BOT or SLD
          qty: execution.shares || execution.filledQuantity,
          price: execution.price,
          avgPrice: execution.avgPrice,
          orderId: execution.orderId,
          orderRef: execution.orderRef || '',
          // Option details
          strike: contract.strike || 0,
          right: contract.right || '', // C or P
          expiry: contract.lastTradeDateOrContractMonth || '',
          multiplier: contract.multiplier || '100',
          realizedPnl: execution.realizedPNL || 0
        });
      }

      function onComm(report) {
        if (report.execId) {
          commissions[report.execId] = {
            commission: report.commission,
            realizedPnl: report.realizedPNL,
            yield: report.yield
          };
        }
      }

      function onEnd(rId) {
        if (rId !== reqId) return;
        clearTimeout(timeout);
        ib.removeListener(EventName.execDetails, onExec);
        ib.removeListener(EventName.execDetailsEnd, onEnd);
        // Wait a moment for commission reports to arrive
        setTimeout(() => {
          ib.removeListener(EventName.commissionReport, onComm);
          resolve(executions);
        }, 1000);
      }

      ib.on(EventName.execDetails, onExec);
      ib.on(EventName.execDetailsEnd, onEnd);
      ib.on(EventName.commissionReport, onComm);

      // Request executions — empty filter gets all for today
      // Request executions — empty filter gets all for today
      const today = new Date();
      const timeStr = today.getFullYear() + ('0'+(today.getMonth()+1)).slice(-2) + ('0'+today.getDate()).slice(-2) + '-00:00:00';
      const filter = { clientId: 0, acctCode: '', time: timeStr, symbol: '', secType: '', exchange: '', side: '' };
      ib.reqExecutions(reqId, filter);
    });

    // Merge commissions with executions
    const merged = executions.map(e => ({
      ...e,
      commission: commissions[e.execId]?.commission || 0,
      realizedPnl: commissions[e.execId]?.realizedPnl || e.realizedPnl || 0
    }));

    // Group by orderId to get net positions
    const orderGroups = {};
    merged.forEach(e => {
      const key = e.orderId || e.execId;
      if (!orderGroups[key]) orderGroups[key] = { fills: [], symbol: e.symbol, side: e.side, totalQty: 0, totalCommission: 0, realizedPnl: 0 };
      orderGroups[key].fills.push(e);
      orderGroups[key].totalQty += e.qty;
      orderGroups[key].totalCommission += e.commission;
      if (e.realizedPnl && e.realizedPnl !== 1.7976931348623157e+308) {
        orderGroups[key].realizedPnl += e.realizedPnl;
      }
    });

    console.log(`[BRIDGE] Executions: ${merged.length} fills, ${Object.keys(orderGroups).length} orders`);
    res.json({
      fills: merged,
      orders: Object.values(orderGroups),
      count: merged.length,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('[BRIDGE] Executions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Current open option positions, grouped into multi-leg structures ──
// GET /api/positions  → { structures: [...], raw: [...] }
// Each structure groups legs by underlying+expiry so the Decision Engine can
// pre-fill strikes/qty/right. Net price sign: negative = net debit paid,
// positive = net credit received (per contract, ×100 for dollars).
app.get('/api/positions', async (req, res) => {
  try {
    await connectTWS();
    if (!connected) return res.status(503).json({ error: 'Not connected to TWS' });

    const positions = [];
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        ib.removeListener(EventName.position, onPos);
        ib.removeListener(EventName.positionEnd, onEnd);
        try { ib.cancelPositions(); } catch (e) {}
        resolve();
      }, 8000);

      function onPos(account, contract, pos, avgCost) {
        // Only option legs with a live position
        if (contract.secType !== 'OPT' || !pos) return;
        positions.push({
          account,
          underlying: contract.symbol,
          expiry: contract.lastTradeDateOrContractMonth || '',
          strike: contract.strike || 0,
          right: contract.right || '',      // C or P
          qty: pos,                          // signed: + long, - short
          avgCost: avgCost || 0,             // per contract incl. multiplier
          multiplier: Number(contract.multiplier) || 100,
          perShare: legPerShare(avgCost, contract.multiplier, 'contract')
        });
      }
      function onEnd() {
        clearTimeout(timeout);
        ib.removeListener(EventName.position, onPos);
        ib.removeListener(EventName.positionEnd, onEnd);
        try { ib.cancelPositions(); } catch (e) {}
        resolve();
      }
      ib.on(EventName.position, onPos);
      ib.on(EventName.positionEnd, onEnd);
      ib.reqPositions();
    });

    res.json(groupIntoStructures(positions));
  } catch (err) {
    console.log('[BRIDGE] positions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Working orders not yet filled (so a ticket can pre-fill before the fill) ──
// GET /api/open-orders → { structures: [...], raw: [...] }
app.get('/api/open-orders', async (req, res) => {
  try {
    await connectTWS();
    if (!connected) return res.status(503).json({ error: 'Not connected to TWS' });

    const legs = [];
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        ib.removeListener(EventName.openOrder, onOrder);
        ib.removeListener(EventName.openOrderEnd, onEnd);
        resolve();
      }, 8000);

      function onOrder(orderId, contract, order, orderState) {
        if (contract.secType !== 'OPT') return;
        // BUY → +qty (long leg), SELL → -qty (short leg)
        const signedQty = (order.action === 'SELL' ? -1 : 1) * (order.totalQuantity || 0);
        legs.push({
          orderId,
          underlying: contract.symbol,
          expiry: contract.lastTradeDateOrContractMonth || '',
          strike: contract.strike || 0,
          right: contract.right || '',
          qty: signedQty,
          avgCost: order.lmtPrice || 0,     // limit price for a working order
          multiplier: Number(contract.multiplier) || 100,
          perShare: legPerShare(order.lmtPrice, contract.multiplier, 'share'),
          status: orderState?.status || '',
          lmtPrice: order.lmtPrice || 0
        });
      }
      function onEnd() {
        clearTimeout(timeout);
        ib.removeListener(EventName.openOrder, onOrder);
        ib.removeListener(EventName.openOrderEnd, onEnd);
        resolve();
      }
      ib.on(EventName.openOrder, onOrder);
      ib.on(EventName.openOrderEnd, onEnd);
      ib.reqAllOpenOrders();
    });

    res.json(groupIntoStructures(legs));
  } catch (err) {
    console.log('[BRIDGE] open-orders error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Group option legs by underlying+expiry into structures the engine can read.
// Infers a strategy shape and a net price (credit +, debit −) per contract.
// groupIntoStructures lives in ./structures.js (pure, tested).

// Disconnect
app.post('/api/disconnect', (req, res) => {
  if (ib) { ib.disconnect(); connected = false; }
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`[BRIDGE] IB Bridge running on http://localhost:${PORT}`);
  console.log(`[BRIDGE] Target: ${TWS_HOST} ports ${candidatePorts().join('/')} (TWS/IB Gateway auto-detect)...`);
  connectTWS().catch(e => { lastConnectError = e.message; console.error('[BRIDGE] Initial connect failed:', e.message); scheduleReconnect(); });
});
