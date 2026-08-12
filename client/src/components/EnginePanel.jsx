import React, { useState, useMemo, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import { calc0DTE } from '../engine/calc0dte';
import { calc45DTE } from '../engine/calc45dte';
import { UNDERLYING_LIST, resolveCashType } from '../engine/data';

const OUTLOOKS = ['neutral', 'bullish', 'bearish'];
const TERM_BIASES = ['contango', 'flat', 'backwardation'];

// ── Fields the TWS auto-fill owns (Aug 2026) ──
// Anything here can arrive from the bridge, so it is also something you can
// override by hand and expect the override to SURVIVE the next pull. Sizing
// fields (bankroll, max loss, win/risk, net credit) are never fed and so are
// deliberately absent: typing one of those is not an override of anything.
const MKT_0 = ['price','high','low','vwap5','vwap5_30','vwap15','vwap15_30','em',
  'atr','atr5','atr2h','vix','vix1d','esOvernightHigh','esOvernightLow','esClose',
  'priorDayClose','cashOpen','esEM'];
const MKT_45 = ['price','vix'];
// 45DTE fields Fetch Greeks can fill from the bridge's per-leg model IVs.
// Same override contract as MKT_45: type one by hand and later fetches skip it.
const GREEKS_45 = ['iv','skew'];

const clockOf = ts => {
  if (!ts) return '';
  const d = new Date(ts);
  return isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-AU', { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
};
const agoOf = (ts, now) => {
  if (!ts) return '';
  const t = new Date(ts).getTime();
  if (!isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? s + 's ago' : s < 3600 ? Math.round(s / 60) + 'm ago' : Math.round(s / 3600) + 'h ago';
};

// ── Composite score ──
// Blends setup quality (market conditions) with sizing metrics (trade edge).
// Each metric normalized to 0-100, then averaged: 40% setup quality + 60% sizing
// (Kelly, Vol, Sharpe, POP, EV). EV is normalised by CAPITAL AT RISK, not
// absolute dollars (Jul 2026): +8% of risk = 100, 0 = 40, −5.3% = 0; falls back
// to the old "$200 = perfect" anchor when no risk base exists. Pure function of
// a calc result so the structure-comparison table scores alternative strategies
// with EXACTLY the formula the banner uses.
function compositeScoreOf(res) {
  const setupNorm = res.setupScore || 0;
  if (res.missingSize) return setupNorm; // only setup quality when no sizing entered
  const kellyNorm = Math.min(100, ((res.adjustedKelly || 0) / 0.25) * 100); // 25% = perfect
  const volNorm = Math.min(100, (res.volFactor || 0) * 100); // 1.0 = perfect
  const sharpeNorm = Math.min(100, (res.sharpeFactor || 0) * 100); // 1.0 = perfect
  const popNorm = Math.min(100, ((res.popMargin || 0) / 2.0) * 100); // 2.0x = perfect
  const evRiskBase = res.evBasis?.maxLoss || 0;
  const evPerRisk = evRiskBase > 0 ? (res.ev || 0) / evRiskBase : 0;
  const evNorm = evRiskBase > 0
    ? Math.max(0, Math.min(100, 40 + (evPerRisk / 0.08) * 60))
    : (res.ev > 0 ? Math.min(100, (res.ev / 200) * 100) : 0); // fallback: old anchor
  const sizingAvg = (kellyNorm + volNorm + sharpeNorm + popNorm + evNorm) / 5;
  return Math.round(setupNorm * 0.40 + sizingAvg * 0.60);
}

// Seed a fresh input bag from a multi-scan row. Only the market fields the scan
// actually resolved are taken; sizing and defaults are left as they are.
function applySeed(base, seed, keys) {
  if (!seed) return base;
  const out = { ...base };
  if (seed.underlying) out.underlying = seed.underlying;
  keys.forEach(k => {
    const v = seed[k];
    if (v != null && v !== '' && v !== 0) out[k] = String(v);
  });
  if (seed.emSource) out.emSource = seed.emSource;
  if (seed.straddleCall) out.straddleCall = String(seed.straddleCall);
  if (seed.straddlePut) out.straddlePut = String(seed.straddlePut);
  return out;
}

export default function EnginePanel({ mode, onLogTrade, accountConfig, strategyHistory, seed, initialState, onStateChange, toast, onOpenInTab }) {
  const is0 = mode === '0dte';
  const acfg = accountConfig || {};
  // Notices go through the parent's toast (top-right, auto-dismiss). Falls back
  // to alert only if no toast prop was wired, so the panel never fails silently.
  const notify = (msg, type) => { if (toast) toast(msg, type || 'error'); else window.alert(msg); };
  const defBankroll = acfg.bankroll || 3000;
  const defMaxLoss = acfg.maxDailyLoss || 300;
  const defMaxOpen = acfg.maxOpenRisk || 450;
  const init = initialState || null;
  const [overrideStrat, setOverrideStrat] = useState(init?.overrideStrat ?? null);
  const [autoFilling, setAutoFilling] = useState(false);
  const [dataFresh, setDataFresh] = useState(init?.dataFresh ?? (seed?._meta || null)); // market-data freshness (live vs last close) + when it was pulled
  const [esContract, setEsContract] = useState(init?.esContract ?? ''); // ES front-month label from bridge
  const [fetchingGreeks, setFetchingGreeks] = useState(false);
  const [greeksFresh, setGreeksFresh] = useState(init?.greeksFresh ?? null); // option-feed freshness (real-time/delayed) + asOf
  // Market fields you have typed by hand. Auto-fill will not overwrite these;
  // they render amber with the feed's value alongside so the override is visible.
  const [held, setHeld] = useState(init?.held ?? {});
  // The last raw bridge pull: what it gave us, what it did not, and when. This is
  // what lets a re-fill say "these three did not come back" instead of quietly
  // leaving stale numbers behind a LIVE badge.
  const [feed, setFeed] = useState(init?.feed ?? null);
  const [justRefreshed, setJustRefreshed] = useState(false);
  const [tick, setTick] = useState(() => Date.now());

  // One slow clock for every relative age on the panel, so "2m ago" is true
  // rather than however old the last keystroke was.
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);
  const [showWhatIf, setShowWhatIf] = useState(false);
  const [showRiskBudget, setShowRiskBudget] = useState(false);
  // Inline log-note input (replaces the old window.prompt on Log trade).
  const [logNoteOpen, setLogNoteOpen] = useState(false);
  const [logNote, setLogNote] = useState('');
  const [loadingTws, setLoadingTws] = useState(false);
  const [twsStructures, setTwsStructures] = useState(null); // picker list when >1
  const [twsLegs, setTwsLegs] = useState(null); // exact legs from a loaded TWS position

  const [i0, setI0] = useState(() => {
    const base = {
    underlying:'SPX', price:'', high:'', low:'', vwap5:'', vwap5_30:'', vwap15:'', vwap15_30:'',
    em:'', atr5:'', atr2h:'', atr:'',
    vix:'', vix1d:'',
    esOvernightHigh:'', esOvernightLow:'', esClose:'', priorDayClose:'', cashOpen:'', esEM:'',
    win:'', risk:'', pop:'', hours:'', netCreditDebit:'',
    theta:'', delta:'', gamma:'', gamStrike:'',
    lowerWingDelta:'', upperWingDelta:'',
    emSource:'', straddleCall:'', straddlePut:'', straddleHaircut:'1.2533',
    bankroll:defBankroll, startBR:defBankroll, maxLoss:defMaxLoss, maxOpen:defMaxOpen
    };
    if (init?.i0) return { ...base, ...init.i0 };
    return applySeed(base, seed, MKT_0);
  });

  // Auto-calculate hours remaining on mount
  useEffect(() => {
    if (!is0) return;
    const now = new Date();
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const marketClose = new Date(et);
    marketClose.setHours(15, 0, 0, 0);
    const hoursLeft = Math.max(0, (marketClose - et) / 3600000);
    const hoursRounded = Math.round(hoursLeft * 10) / 10;
    if (hoursRounded > 0 && !i0.hours) {
      setI0(prev => ({ ...prev, hours: hoursRounded }));
    }
  }, [is0]);

  // A multi-scan pick no longer merges into whatever ticket happens to be open —
  // it opens its own tab, and this panel is seeded at mount (see applySeed above).

  const [i45, setI45] = useState(() => {
    const base = {
    underlying:'SPX', price:'', ivr:'', iv:'', hv:'', vix:'',
    ivFront:'', ivBack:'', skew:'', termBias:'contango', dte:'45',
    outlook:'neutral', pop:'', win:'', risk:'', netCreditDebit:'',
    bankroll:defBankroll, startBR:defBankroll, maxLoss:defMaxLoss, maxOpen:defMaxOpen,
    bpr:'', theta:'', vega:'', delta:'', lowerWingDelta:'', upperWingDelta:''
    };
    if (init?.i45) return { ...base, ...init.i45 };
    return applySeed(base, seed, MKT_45);
  });

  // ── Manual holds ──
  // Typing into a market field marks it held for THIS engine (0DTE and 45DTE keep
  // separate holds — they share field names but not meaning). Held fields survive
  // auto-fill; everything else is genuinely refetched.
  const bag = is0 ? '0' : '45';
  const markHeld = (b, k) => setHeld(h => (h[b + ':' + k] ? h : { ...h, [b + ':' + k]: true }));
  const set0 = (k,v) => { setI0(p => ({...p,[k]:v})); if (MKT_0.includes(k)) markHeld('0', k); };
  const set45 = (k,v) => { setI45(p => ({...p,[k]:v})); if (MKT_45.includes(k) || GREEKS_45.includes(k)) markHeld('45', k); };
  const fv = (o,k) => parseFloat(o[k]) || 0;

  const isHeld = k => !!held[bag + ':' + k];
  const feedValOf = k => (feed && feed.values ? feed.values[k] : undefined);
  const notFed = k => !!feed && Array.isArray(feed.missing) && feed.missing.indexOf(k) >= 0;
  const heldKeys = Object.keys(held).filter(x => x.indexOf(bag + ':') === 0);
  // Render props for one market input.
  const mk = k => ({ manual: isHeld(k), feedVal: feedValOf(k), stale: notFed(k) && !isHeld(k) });

  // ── Collapsible input sections ──
  // Collapse state per mode, persisted. Default: everything expanded (an absent
  // key reads as expanded, so a fresh browser shows the full column).
  const [collapsedSections, setCollapsedSections] = useState(() => {
    try { return JSON.parse(localStorage.getItem('ot_engine_sections')) || {}; } catch (e) { return {}; }
  });
  const isCollapsed = id => !!(collapsedSections[mode] && collapsedSections[mode][id]);
  const setSectionCollapsed = (id, val) => setCollapsedSections(prev => {
    const next = { ...prev, [mode]: { ...(prev[mode] || {}), [id]: val } };
    try { localStorage.setItem('ot_engine_sections', JSON.stringify(next)); } catch (e) { /* private mode */ }
    return next;
  });
  const toggleSection = id => setSectionCollapsed(id, !isCollapsed(id));
  const expandSection = id => { if (isCollapsed(id)) setSectionCollapsed(id, false); };

  // Banner zone-4 warning chips: which chip's "why" explanation is expanded (key or null)
  const [expandedWarning, setExpandedWarning] = useState(null);

  // ── Section completeness ──
  // "Required" mirrors the exact gates behind the banner's incomplete states:
  // calc0dte sets hardBlocker ('Enter underlying price…') when price <= 0 and
  // missingSize → the 'Enter sizing' banner when win/risk/pop <= 0; calc45dte
  // sets hardBlocker ('Enter IV…', hasVol = iv > 0) when iv <= 0 plus the same
  // missingSize gate. Nothing else blanks the banner, so nothing else counts.
  const secBag = is0 ? i0 : i45;
  const missingOf = keys => keys.reduce((n, k) => n + (fv(secBag, k) > 0 ? 0 : 1), 0);
  const secMissing = {
    market: missingOf(['price']),
    vol: is0 ? null : missingOf(['iv']),
    sizing: missingOf(['win', 'risk', 'pop'])
  };

  // Drop every hold on this engine and take the feed's value back where we have
  // one. The escape hatch for "I typed that by mistake" — without it a held field
  // could never return to the feed short of reloading the page.
  function releaseHolds() {
    if (!heldKeys.length) return;
    setHeld(h => { const o = { ...h }; heldKeys.forEach(k => { delete o[k]; }); return o; });
    if (feed && feed.values) {
      const apply = prev => {
        const out = { ...prev };
        heldKeys.forEach(x => {
          const k = x.slice(bag.length + 1);
          if (feed.values[k] !== undefined) out[k] = feed.values[k];
        });
        return out;
      };
      if (is0) setI0(apply); else setI45(apply);
    }
  }

  // Hand the whole candidate up so the parent can label its tab and persist it.
  // Through a ref so an unstable parent callback cannot re-trigger the effect.
  const oscRef = useRef(onStateChange);
  oscRef.current = onStateChange;
  useEffect(() => {
    if (oscRef.current) oscRef.current({ i0, i45, overrideStrat, dataFresh, esContract, greeksFresh, held, feed });
  }, [i0, i45, overrideStrat, dataFresh, esContract, greeksFresh, held, feed]);

  // SPX VWAP fix: if underlying is SPX and values look like SPY, scale x10
  function scaleVWAP(val) {
    const price = fv(i0, 'price');
    const v = parseFloat(val) || 0;
    if (i0.underlying === 'SPX' && price > 1000 && v > 0 && v < price * 0.3) return v * 10;
    return v;
  }
  const vwapScaled = is0 && i0.underlying === 'SPX';
  const vwapFromIWM = is0 && i0.underlying === 'RUT';

  // The 0DTE argument object, built once so the what-if toggle can re-run the whole
  // engine at the OTHER vol estimate without duplicating twenty input mappings.
  const mk0 = (over) => ({
          price:fv(i0,'price'), high:fv(i0,'high'), low:fv(i0,'low'),
          vwap5:scaleVWAP(i0.vwap5), vwap5_30:scaleVWAP(i0.vwap5_30),
          vwap15:scaleVWAP(i0.vwap15), vwap15_30:scaleVWAP(i0.vwap15_30),
          atr:fv(i0,'atr'), em:fv(i0,'em'), atr5:fv(i0,'atr5'), atr2h:fv(i0,'atr2h'),
          gamStrike:fv(i0,'gamStrike'), vix:fv(i0,'vix'), vix1d:fv(i0,'vix1d'),
          esOvernightHigh:fv(i0,'esOvernightHigh'), esOvernightLow:fv(i0,'esOvernightLow'),
          esClose:fv(i0,'esClose'), priorDayClose:fv(i0,'priorDayClose'), cashOpen:fv(i0,'cashOpen'), esEM:fv(i0,'esEM'),
          bankroll:fv(i0,'bankroll'), startBR:fv(i0,'startBR'),
          risk:fv(i0,'risk'), maxLoss:fv(i0,'maxLoss'), win:fv(i0,'win'),
        netCreditDebit:fv(i0,'netCreditDebit'),
          maxOpen:fv(i0,'maxOpen'), pop:fv(i0,'pop'), theta:fv(i0,'theta'),
          delta:fv(i0,'delta'), gamma:fv(i0,'gamma'), hours:fv(i0,'hours'),
          underlying:i0.underlying,
          overrideStrategy: overrideStrat,
          historyByStrategy: strategyHistory || null,
          wingDeltas: (i0.lowerWingDelta !== '' || i0.upperWingDelta !== '') ? {
            lowerAbsDelta: i0.lowerWingDelta !== '' ? Math.abs(parseFloat(i0.lowerWingDelta)) : null,
            upperAbsDelta: i0.upperWingDelta !== '' ? Math.abs(parseFloat(i0.upperWingDelta)) : null
          } : null,
          emSource: i0.emSource || '',
          straddleCall: i0.straddleCall !== '' ? parseFloat(i0.straddleCall) : null,
          straddlePut: i0.straddlePut !== '' ? parseFloat(i0.straddlePut) : null,
          straddleHaircut: i0.straddleHaircut !== '' ? parseFloat(i0.straddleHaircut) : 1.2533,
          ...(over || {})
  });

  // The 45DTE argument object, same shape/purpose as mk0: built once so the
  // structure-comparison table can re-run the engine at a different strategy
  // without duplicating the input mapping.
  const mk45 = (over) => ({
          price:fv(i45,'price'), ivr:fv(i45,'ivr'), iv:fv(i45,'iv'),
          hv:fv(i45,'hv'), vix:fv(i45,'vix'), ivFront:fv(i45,'ivFront'),
          ivBack:fv(i45,'ivBack'), skew:fv(i45,'skew'), dte:fv(i45,'dte')||45,
          pop:fv(i45,'pop'), win:fv(i45,'win'), risk:fv(i45,'risk'),
          bankroll:fv(i45,'bankroll'), startBR:fv(i45,'startBR'),
          maxLoss:fv(i45,'maxLoss'), maxOpen:fv(i45,'maxOpen'), bpr:fv(i45,'bpr'),
          theta:fv(i45,'theta'), vega:fv(i45,'vega'), delta:fv(i45,'delta'),
          underlying:i45.underlying, termBias:i45.termBias, outlook:i45.outlook,
          overrideStrategy: overrideStrat,
          historyByStrategy: strategyHistory || null,
          wingDeltas: (i45.lowerWingDelta !== '' || i45.upperWingDelta !== '') ? {
            lowerAbsDelta: i45.lowerWingDelta !== '' ? Math.abs(parseFloat(i45.lowerWingDelta)) : null,
            upperAbsDelta: i45.upperWingDelta !== '' ? Math.abs(parseFloat(i45.upperWingDelta)) : null
          } : null,
          ...(over || {})
  });

  const r = useMemo(() => {
    try {
      if (is0) {
        return calc0DTE(mk0());
      } else {
        return calc45DTE(mk45());
      }
    } catch (e) {
      console.error('Calc engine error:', e);
      return { decision:'Error', decisionClass:'nogo', hardBlocker:'Calculation error: ' + e.message,
        setup:'No setup', setupScore:0, criteria:[], ratings:[], legs:[], warnings:[], blockers:[],
        bestStrat:'', bestRating:'POOR', legStrat:'', kelly:0, rawKelly:0, adjustedKelly:0,
        kellyDollar:0, contracts:1, maxRisk:0, popMargin:0, bePop:0, wlRatio:0, ev:0,
        volFactor:1, sharpeFactor:1, sharpeProxy:0, kellyOverRisk:false, missingSize:true,
        vixGap:0, vixGrade:'', dirScore:0, dirLabel:'', regime:'', behaviour:'',
        comp:null, rmRatio:0, moveConsumed:0, volRemaining:1, payoff:null, greeks:null,
        vwapDistPctEM:0, vwapOverextended:false, confirmed:false, diverges:false,
        slope5:{}, slope15:{}, slope:'flat', slopeDirection:'unknown',
        overnightDir:'unknown', trendPattern:'unknown', wingTxt:'',
        targetCredit:null, targetLabel:'', targetLow:0, targetHigh:0, targetMax:0, targetIsCredit:true,
        fairValueScore:0, fairValueGrade:'', volScore:0, volGrade:'', structScore:0, structGrade:'',
        regimeScore:0, regimeGrade:'', ivHvRatio:0 };
    }
  }, [is0, i0, i45, overrideStrat, strategyHistory]);

  // What-if vol: re-run the engine on the other vol estimate and show the delta.
  // Which "other" depends on what is driving EM now. Straddle -> the VIX1D model;
  // manual -> the VIX1D model; model-only -> plain VIX (the 30-day number) instead
  // of VIX1D. Nothing here changes the live result; it is a second, parallel run.
  const altVol = useMemo(() => {
    if (!is0 || r.decision === 'Error') return null;
    let over = null, label = '', short = '';
    if (r.emIsStraddle) {
      over = { straddleCall: null, straddlePut: null, emSource: 'vix', em: 0 };
      label = 'the VIX1D model'; short = 'VIX1D';
    } else if (i0.emSource === 'manual') {
      over = { em: 0, emSource: 'vix', straddleCall: null, straddlePut: null };
      label = 'the VIX1D model'; short = 'VIX1D';
    } else if (fv(i0, 'vix') > 0 && fv(i0, 'vix1d') > 0) {
      over = { vix1d: fv(i0, 'vix') };
      label = `VIX ${fv(i0,'vix').toFixed(1)} (30-day) rather than VIX1D`; short = 'VIX 30d';
    }
    if (!over) return null;
    let a;
    try { a = calc0DTE(mk0(over)); } catch (e) { return null; }
    const pct = v => v == null ? '--' : `${(v*100).toFixed(0)}%`;
    const p1  = v => v == null ? '--' : `${(v*100).toFixed(1)}%`;
    const num = v => v == null || !isFinite(v) ? '--' : v.toFixed(1);
    const dol = v => v == null || !isFinite(v) ? '--' : `$${Math.round(v)}`;
    const rows = [
      { k:'EM session',     now:`${num(r.emSession)} pts`, alt:`${num(a.emSession)} pts` },
      { k:'Move consumed',  now:pct(r.moveConsumed),       alt:pct(a.moveConsumed) },
      { k:'Regime',         now:r.regime || '--',          alt:a.regime || '--' },
      { k:'Best strategy',  now:r.bestStrat || '--',       alt:a.bestStrat || '--' },
      { k:'P(max loss)',    now:p1(r.pMaxLoss),            alt:p1(a.pMaxLoss) },
      { k:'EV / contract',  now:dol(r.ev),                 alt:dol(a.ev) },
      { k:'Confidence',     now:num(r.tradeConfidence),    alt:num(a.tradeConfidence) }
    ];
    return { label, short, rows, changed: rows.filter(x => x.now !== x.alt).length };
  }, [is0, i0, r, overrideStrat, strategyHistory]);

  // Override: calc engine generates legs for overrideStrat if set
  const isOverride = overrideStrat && overrideStrat !== r.bestStrat;
  const effectiveStrat = r.legStrat || r.bestStrat;

  // ── Net credit/debit pre-fills from the engine's TARGET for the structure in
  // front of you. A fresh ticket -- and every structure opened in its own tab --
  // is therefore scoreable immediately instead of showing nothing until you have
  // typed a number you do not have yet.
  //
  // It is a TARGET, not a fill. That distinction now matters more than it used to:
  // the debit is written to the Decisions log (column AH), so an untouched target
  // left in the box would be recorded as if it were a real price. The chip beside
  // the label says which one you are looking at and disappears the instant the
  // value differs from what was auto-filled.
  //
  // Fills once per (engine, structure). Clearing the box by hand keeps it clear --
  // the ref remembers the key, not the emptiness. (Aug 2026.)
  const netAutoRef = useRef({ key: null, value: '' });
  const netKey = bag + '|' + (effectiveStrat || '');
  const netTarget = (r && r.targetCredit != null && isFinite(r.targetCredit)) ? r.targetCredit : null;
  useEffect(() => {
    if (netTarget == null) return;
    if (netAutoRef.current.key === netKey) return;
    const cur = is0 ? i0.netCreditDebit : i45.netCreditDebit;
    if (cur !== '' && cur != null) { netAutoRef.current = { key: netKey, value: '' }; return; }
    const v = netTarget.toFixed(2);
    netAutoRef.current = { key: netKey, value: v };
    if (is0) setI0(p => ({ ...p, netCreditDebit: v }));
    else setI45(p => ({ ...p, netCreditDebit: v }));
  }, [netKey, netTarget]);
  const netCur = is0 ? i0.netCreditDebit : i45.netCreditDebit;
  const netIsTarget = netCur !== '' && netCur != null && netAutoRef.current.value === netCur;

  // ── Structure comparison opens its pick in a new tab.
  // Session & sizing is the one block that does NOT travel: max profit, max loss,
  // POP and the fill you got all describe the legs in front of you, so carrying
  // them into a different structure would score the new one on the old one's
  // numbers. Hours re-derives itself on mount, and net credit/debit re-fills from
  // the new structure's own target. Everything else -- market data, vol, ES,
  // greeks, which fields you typed by hand, feed provenance -- is a property of
  // the session, and comes across untouched. (Aug 2026.)
  const SIZING_KEYS = ['win', 'risk', 'pop', 'hours', 'netCreditDebit'];
  function openStructureInTab(name) {
    const nextOverride = name === r.bestStrat ? null : name;
    if (!onOpenInTab) { setOverrideStrat(nextOverride); return; }   // fallback: old in-place behaviour
    const strip = o => {
      const c = { ...o };
      SIZING_KEYS.forEach(k => { if (k in c) c[k] = ''; });
      return c;
    };
    onOpenInTab({
      i0: strip(i0), i45: strip(i45),
      overrideStrat: nextOverride,
      dataFresh, esContract, greeksFresh, held, feed
    }, mode, name);
    if (toast) toast(name + ' opened in a new tab \u2014 re-enter win/risk/POP from your broker preview');
  }
  const ticketNet = is0 ? i0.netCreditDebit : i45.netCreditDebit;
  const cashType = resolveCashType(effectiveStrat, ticketNet); // 'credit' | 'debit' | 'varies'
  const effectiveRating = isOverride ? (r.ratings.find(s => s.name === overrideStrat)?.rating || 'MARGINAL') : r.bestRating;
  // ── Composite banner score ── (formula extracted to compositeScoreOf, module
  // scope, so the structure-comparison table scores alternatives identically)
  const missingInputs = r.missingSize;
  const hasBlocker = !!r.hardBlocker;
  const compositeScore = compositeScoreOf(r);

  // ── Structure comparison ──
  // The calc engines are pure functions of their inputs (no fetches, no clocks,
  // no module state), so alternative structures can be scored by re-running the
  // SAME inputs with a different overrideStrategy. Current selection first,
  // then the next-best rated strategies — 3 columns total. Cost: two extra
  // engine runs, memoized on the same deps as the live result (the engine
  // already runs on every keystroke, so 3× is fine).
  const stratCompare = useMemo(() => {
    if (r.decision === 'Error' || !Array.isArray(r.ratings) || r.ratings.length < 2) return null;
    const cur = r.legStrat || r.bestStrat;
    if (!cur) return null;
    const names = [cur];
    for (const s of r.ratings) {
      if (names.length >= 3) break;
      if (!names.includes(s.name)) names.push(s.name);
    }
    return names.map(name => {
      const rating = r.ratings.find(s => s.name === name)?.rating || '';
      if (name === cur) return { name, rating, res: r, current: true };
      try {
        const res = is0 ? calc0DTE(mk0({ overrideStrategy: name }))
                        : calc45DTE(mk45({ overrideStrategy: name }));
        return res ? { name, rating, res, current: false } : null;
      } catch (e) { return null; }
    }).filter(Boolean);
  }, [is0, i0, i45, r, overrideStrat, strategyHistory]);

  let bannerTitle, bannerGrade;
  if (hasBlocker) {
    bannerTitle = r.hardBlocker;
    bannerGrade = 'weak';
  } else if (compositeScore >= 75) {
    bannerTitle = 'Strong setup';
    bannerGrade = 'strong';
  } else if (compositeScore >= 55) {
    bannerTitle = 'Decent setup';
    bannerGrade = 'decent';
  } else if (compositeScore >= 35) {
    bannerTitle = 'Marginal setup';
    bannerGrade = 'marginal';
  } else {
    bannerTitle = 'Weak setup';
    bannerGrade = 'weak';
  }
  if (missingInputs && !hasBlocker) bannerTitle = 'Enter sizing';
  if (isOverride && bannerGrade !== 'weak') bannerTitle += ' (override)';

  const effectiveDecision = bannerTitle;

  // Banner zone-3 thesis: skewNote trimmed to a clause (trailing period stripped,
  // leading char lowercased unless it starts an acronym/ticker). Empty → omitted.
  const skewClause = (() => {
    const s = (r.skewNote || '').trim().replace(/\.\s*$/, '');
    if (!s) return '';
    return /^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
  })();

  const dcBg = bannerGrade==='strong'?'#0d1f0d':bannerGrade==='decent'?'#0d1a0d':bannerGrade==='marginal'?'#1f1a0d':'#1f0d0d';
  const dcBorder = bannerGrade==='strong'?'#238636':bannerGrade==='decent'?'#4d8c2a':bannerGrade==='marginal'?'#9e6a03':'#da3633';
  const dcColor = bannerGrade==='strong'?'#3fb950':bannerGrade==='decent'?'#7bc74d':bannerGrade==='marginal'?'#d29922':'#f85149';
  const sBg = r.setupScore>=85?'#0d1f0d':r.setupScore>=70?'#0d1a2e':r.setupScore>=50?'#1f1a0d':'#1f0d0d';
  const sClr = r.setupScore>=85?'#3fb950':r.setupScore>=70?'#2f81f7':r.setupScore>=50?'#d29922':'#f85149';
  // ── Trade Confidence colours (gated metric from the engine) ──
  const tc = r.tradeConfidence;
  const confClr = tc==null?'#8b949e':tc>=70?'#3fb950':tc>=50?'#7bc74d':tc>=30?'#d29922':tc>=15?'#e3833c':'#f85149';
  const confBg  = tc==null?'#161b22':tc>=70?'#0d1f0d':tc>=50?'#0d1a0d':tc>=30?'#1f1a0d':'#1f0d0d';

  // Show VWAP scaling notice (vwapScaled defined above)

  async function handleFetchGreeks() {
    setFetchingGreeks(true);
    try {
      const bridgeUrl = localStorage.getItem('bridgeUrl') || '';
      if (!bridgeUrl) { notify('Set IBKR Bridge URL in Settings first'); setFetchingGreeks(false); return; }
      const underlying = is0 ? i0.underlying : i45.underlying;
      const legsSrc = r?.legs || [];
      if (!legsSrc.length) { notify('No strikes computed yet — fill in the setup first.'); setFetchingGreeks(false); return; }

      // Derive expiry (YYYYMMDD). 0DTE = today (ET); 45DTE = today + DTE input.
      const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
      let expDate = nowET;
      if (!is0) {
        const dte = parseInt(i45.dte, 10);
        if (dte > 0) { expDate = new Date(nowET); expDate.setDate(expDate.getDate() + dte); }
      }
      const yyyymmdd = expDate.getFullYear().toString()
        + String(expDate.getMonth() + 1).padStart(2, '0')
        + String(expDate.getDate()).padStart(2, '0');

      // Build legs: right from label (put/call), signed qty from long/short (+x2 body).
      const legs = legsSrc.map(l => {
        const lbl = (l.label || '').toLowerCase();
        const right = lbl.includes('put') ? 'P' : 'C';
        const isShort = lbl.includes('short');
        const isBody = lbl.includes('body') || lbl.includes('x2');
        const mag = isBody ? 2 : 1;
        return { strike: l.strike, right, qty: (isShort ? -mag : mag) };
      });

      const url = bridgeUrl + '/api/option-greeks?underlying=' + underlying
        + '&expiry=' + yyyymmdd + '&legs=' + encodeURIComponent(JSON.stringify(legs));
      const resp = await fetch(url, { headers: { 'ngrok-skip-browser-warning': '1' } });
      const d = await resp.json();
      if (d.error) { notify('Bridge error: ' + d.error); setFetchingGreeks(false); return; }
      if (d.notSubscribed || (!d.net && d.message)) {
        notify(d.message || 'TWS returned no Greeks — options market data not subscribed. Enter Greeks manually.');
        setFetchingGreeks(false); return;
      }
      if (!d.net) { notify('No Greeks returned — TWS may lack option data permissions, or the expiry/strikes are invalid. You can enter Greeks manually.'); setFetchingGreeks(false); return; }

      // Feed freshness (real-time / delayed / frozen) + the underlying price the model used.
      setGreeksFresh(d.dataType ? { dataType: d.dataType, label: d.dataTypeLabel || '', asOf: d.asOf, undPrice: d.undPrice,
        greekSource: d.greekSource, greeksMixed: !!d.greeksMixed } : null);
      const freshPx = (d.undPrice != null && d.undPrice > 0) ? String(d.undPrice) : null;

      // Net position greeks. gamStrike (pin magnet) ~ the body strike for flies.
      const bodyLeg = legsSrc.find(l => (l.label || '').toLowerCase().includes('body'));
      // Outer wing deltas for the skew-aware P(max loss) cross-check: pick the
      // lowest- and highest-strike legs from the per-leg greeks the bridge returned.
      let lowerWD = '', upperWD = '';
      if (Array.isArray(d.legs) && d.legs.length > 1) {
        const withGreeks = d.legs.filter(l => l.greeks && l.greeks.delta != null);
        if (withGreeks.length > 1) {
          const sorted = [...withGreeks].sort((a, b) => a.strike - b.strike);
          lowerWD = String(Math.abs(sorted[0].greeks.delta));
          upperWD = String(Math.abs(sorted[sorted.length - 1].greeks.delta));
        }
      }
      if (is0) {
        setI0(prev => ({
          ...prev,
          price: freshPx || prev.price,
          theta: d.net.theta ? String(d.net.theta) : prev.theta,
          delta: d.net.delta != null ? String(d.net.delta) : prev.delta,
          gamma: d.net.gamma != null ? String(d.net.gamma) : prev.gamma,
          gamStrike: bodyLeg ? String(bodyLeg.strike) : prev.gamStrike,
          lowerWingDelta: lowerWD || prev.lowerWingDelta,
          upperWingDelta: upperWD || prev.upperWingDelta
        }));
      } else {
        // The bridge's model greeks carry a per-leg implied vol (%, generic tick
        // 106). Average the legs that returned one for the IV input; when the
        // outer legs are a put and a call (condor-style), put-wing IV minus
        // call-wing IV fills Skew in vol points. Same-right structures (flies)
        // have no put/call skew to read, so Skew is left alone there. Held
        // fields are skipped — same override contract as auto-fill.
        let avgIV = '', skewIV = '';
        if (Array.isArray(d.legs)) {
          const withIV = d.legs.filter(l => l.greeks && l.greeks.iv != null && l.greeks.iv > 0);
          if (withIV.length) avgIV = String(+(withIV.reduce((s, l) => s + l.greeks.iv, 0) / withIV.length).toFixed(2));
          if (withIV.length > 1) {
            const byStrike = [...withIV].sort((a, b) => a.strike - b.strike);
            const loLeg = byStrike[0], hiLeg = byStrike[byStrike.length - 1];
            if (String(loLeg.right).toUpperCase() === 'P' && String(hiLeg.right).toUpperCase() === 'C') {
              skewIV = String(+(loLeg.greeks.iv - hiLeg.greeks.iv).toFixed(2));
            }
          }
        }
        setI45(prev => ({
          ...prev,
          price: freshPx || prev.price,
          theta: d.net.theta ? String(d.net.theta) : prev.theta,
          delta: d.net.delta != null ? String(d.net.delta) : prev.delta,
          vega: d.net.vega != null ? String(d.net.vega) : prev.vega,
          iv: avgIV && !held['45:iv'] ? avgIV : prev.iv,
          skew: skewIV && !held['45:skew'] ? skewIV : prev.skew,
          lowerWingDelta: lowerWD || prev.lowerWingDelta,
          upperWingDelta: upperWD || prev.upperWingDelta
        }));
      }
    } catch (e) {
      notify('Fetch Greeks failed: ' + e.message);
    }
    setFetchingGreeks(false);
  }

  // Load an option structure from TWS open positions into the ticket, then
  // chain the market-data auto-fill. Auto-loads if one structure, else picker.
  async function handleLoadFromTWS() {
    setLoadingTws(true);
    setTwsStructures(null);
    try {
      const bridgeUrl = localStorage.getItem('bridgeUrl') || '';
      if (!bridgeUrl) { notify('Set IBKR Bridge URL in Settings first'); setLoadingTws(false); return; }
      const resp = await fetch(bridgeUrl + '/api/positions', { headers: { 'ngrok-skip-browser-warning': '1' } });
      const d = await resp.json();
      if (d.error) { notify('Bridge error: ' + d.error); setLoadingTws(false); return; }
      const structs = d.structures || [];
      if (structs.length === 0) {
        notify('No open option positions in TWS. For paper trades, enter the strikes, contracts and net credit/debit manually — the ticket fields below mirror what a fetch would fill.');
        setLoadingTws(false); return;
      }
      if (structs.length === 1) {
        await applyTwsStructure(structs[0]);
      } else {
        // Several open structures — show a picker.
        setTwsStructures(structs);
      }
    } catch (e) {
      notify('Load from TWS failed: ' + e.message);
    }
    setLoadingTws(false);
  }

  // Apply a chosen structure to the ticket fields, then fetch market data.
  async function applyTwsStructure(s) {
    setTwsStructures(null);
    const underlying = s.underlying || (is0 ? i0.underlying : i45.underlying);
    // Net credit/debit per contract → dollars (×100). isCredit true = credit.
    const netDollars = Math.round((s.netCreditDebit || 0) * 100);
    const patch = {
      underlying,
      contracts: s.contracts || 1,
      netCreditDebit: netDollars ? String(netDollars) : '',
    };
    if (is0) setI0(prev => ({ ...prev, ...patch }));
    else setI45(prev => ({ ...prev, ...patch }));
    // Stash the legs so Fetch Greeks / payoff can use exact strikes.
    setTwsLegs(s.legs || []);
    // Chain the market-data auto-fill so price/EM/VIX populate too.
    await handleAutoFill();
  }

  async function handleAutoFill() {
    setAutoFilling(true);
    try {
      const bridgeUrl = localStorage.getItem('bridgeUrl') || '';
      if (!bridgeUrl) { notify('Set IBKR Bridge URL in Settings first'); setAutoFilling(false); return; }
      const underlying = is0 ? i0.underlying : i45.underlying;
      const resp = await fetch(bridgeUrl + '/api/market-data?underlying=' + underlying, { headers: { 'ngrok-skip-browser-warning': '1' } });
      const d = await resp.json();
      if (d.error) { notify('Bridge error: ' + d.error); setAutoFilling(false); return; }
      // Data-freshness flag from the bridge (realtime | frozen | delayed | ...).
      // pulledAt is OUR clock at the moment of the pull; asOf is the feed's own
      // stamp. They answer different questions — "how old is this screen" vs
      // "how old is the quote" — so both are kept.
      const pulledAt = new Date().toISOString();
      setDataFresh({ isLive: !!d.isLive, label: d.dataTypeLabel || d.dataType || '', dataType: d.dataType || '', asOf: d.asOf || d.timestamp || pulledAt, pulledAt });
      if (d.esContractLabel || d.esContractMonth) setEsContract(d.esContractLabel || d.esContractMonth);

      // Fetch the straddle EM separately, with a short timeout so a slow/after-
      // hours option fetch can't hang the essential price+VIX auto-fill.
      let straddle = null;
      if (is0) {
        try {
          const today = new Date().toLocaleString('en-CA', { timeZone: 'America/New_York' }).split(',')[0].replace(/-/g, '');
          const hc = parseFloat(i0.straddleHaircut) || 1.2533;  // 1 SD = straddle x 1.2533
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 7000);
          const sResp = await fetch(bridgeUrl + '/api/atm-straddle?underlying=' + underlying + '&expiry=' + today + '&haircut=' + hc, { headers: { 'ngrok-skip-browser-warning': '1' }, signal: ctrl.signal });
          clearTimeout(t);
          const sData = await sResp.json();
          if (sData && sData.source === 'straddle' && sData.expectedMove > 0) straddle = sData;
        } catch (e) { /* straddle optional — VIX EM stands */ }
      }

      // ── What the feed actually returned ──
      // A field the bridge answers with 0, null or '' has NOT been refreshed — it
      // has failed. The old code wrote `d.x || prev.x`, which silently kept the
      // stale number under a fresh LIVE badge and looked identical to a successful
      // pull. Now the failures are recorded and shown on the field itself.
      const fields = is0 ? MKT_0 : MKT_45;
      const vals = {}, missing = [];
      fields.forEach(k => {
        let v = d[k];
        if (is0 && k === 'em' && straddle) v = straddle.expectedMove; // straddle beats the VIX model
        if (v == null || v === '' || v === 0) missing.push(k); else vals[k] = String(v);
      });
      setFeed({ at: pulledAt, values: vals, missing });
      setJustRefreshed(true);
      setTimeout(() => setJustRefreshed(false), 6000);

      if (is0) {
        // Calculate hours remaining until 3pm ET (15:00 New York)
        const now = new Date();
        const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const marketClose = new Date(et);
        marketClose.setHours(15, 0, 0, 0);
        const hoursLeft = Math.max(0, (marketClose - et) / 3600000);
        const hoursRounded = Math.round(hoursLeft * 10) / 10;

        setI0(prev => {
          const out = { ...prev };
          MKT_0.forEach(k => { if (!held['0:' + k] && vals[k] !== undefined) out[k] = vals[k]; });
          // EM's provenance travels with EM: only restate it if EM itself refreshed.
          if (!held['0:em'] && vals.em !== undefined) {
            out.emSource = straddle ? 'straddle' : 'vix';
            out.straddleCall = straddle ? String(straddle.callPrice) : '';
            out.straddlePut = straddle ? String(straddle.putPrice) : '';
          }
          out.esDelayed = !!d.esDelayed;
          out.priceDelayed = !!d.priceDelayed;
          out.hours = hoursRounded > 0 ? hoursRounded : prev.hours;
          return out;
        });
      } else {
        // 45DTE: fill the market fields the feed provides (price, VIX). IV and
        // Skew auto-fill from Fetch Greeks (per-leg model IVs). IVR, HV, IV Front
        // and IV Back have NO bridge source and stay manual — their labels say so.
        // Freshness tag (dataFresh) is set above for both engines.
        setI45(prev => {
          const out = { ...prev };
          MKT_45.forEach(k => { if (!held['45:' + k] && vals[k] !== undefined) out[k] = vals[k]; });
          return out;
        });
      }
    } catch (e) {
      notify('Auto-fill failed: ' + e.message);
    }
    setAutoFilling(false);
  }

  function handlePrint() {
    const g = r.greeks;
    const underlying = is0 ? i0.underlying : i45.underlying;

    const legsHtml = r.legs.map(function(l) {
      var isShort = l.label.toLowerCase().includes('short');
      var cls = isShort ? 'leg-short' : 'leg-long';
      return '<span class="leg ' + cls + '">' + l.strike + ' <span style="font-size:10px;font-weight:400;opacity:0.8">' + l.label + '</span></span>';
    }).join('');

    const criteriaHtml = r.criteria.map(function(c) {
      var pct = c.max > 0 ? Math.round(c.pts / c.max * 100) : 0;
      var col = pct >= 80 ? '#3fb950' : pct >= 50 ? '#2f81f7' : pct >= 30 ? '#d29922' : '#f85149';
      return '<div class="row"><span class="label">' + c.label + '</span><span class="value" style="color:' + col + '">' + c.pts + '/' + c.max + '</span></div>';
    }).join('');

    const warningsHtml = (r.warnings || []).map(function(w) {
      return '<div class="warn">\u26A0 ' + w + '</div>';
    }).join('');

    var greeksHtml = '';
    if (g) {
      var teCol = g.tEdge >= 0.15 ? 'green' : g.tEdge >= 0.05 ? 'amber' : 'red';
      var grCol = g.gRisk < 0.30 ? 'green' : g.gRisk < 0.70 ? 'amber' : 'red';
      var dsCol = g.dsATR > 0.50 ? 'green' : g.dsATR > 0.25 ? 'amber' : 'red';
      greeksHtml = '<div class="section"><div class="section-title">Trade Survivability</div>' +
        '<div class="row"><span class="label">Theta Edge</span><span class="value ' + teCol + '">' + g.tEdge.toFixed(3) + ' \u2014 ' + g.tEdgeSignal + '</span></div>' +
        '<div class="row"><span class="label">Gamma Risk</span><span class="value ' + grCol + '">' + g.gRisk.toFixed(3) + ' \u2014 ' + g.gRiskSignal + '</span></div>' +
        '<div class="row"><span class="label">Max tolerable move</span><span class="value ' + dsCol + '">' + g.dsMax.toFixed(1) + ' pts (' + (g.dsATR * 100).toFixed(0) + '% ATR) \u2014 ' + g.dsSignal + '</span></div>' +
        (g.sweetSpot ? '<div style="margin-top:6px;font-size:11px;color:#3fb950;font-weight:600">\uD83C\uDFAF SWEET SPOT</div>' : '') +
        '</div>';
    }

    var signalsHtml = '';
    if (is0) {
      signalsHtml = '<div class="row"><span class="label">Direction</span><span class="value ' + (r.dirScore > 0 ? 'green' : r.dirScore < 0 ? 'red' : 'white') + '">' + r.dirLabel + '</span></div>' +
        '<div class="row"><span class="label">Move consumed</span><span class="value white">' + (r.moveConsumed !== undefined ? (r.moveConsumed * 100).toFixed(0) + '%' : '--') + '</span></div>' +
        '<div class="row"><span class="label">Regime</span><span class="value white">' + r.regime + '</span></div>' +
        '<div class="row"><span class="label">VIX gap</span><span class="value white">' + (r.vixGap * 100).toFixed(1) + '% \u2014 ' + r.vixGrade + '</span></div>' +
        '<div class="row"><span class="label">Compression</span><span class="value white">' + (r.comp !== null ? r.comp.toFixed(2) : '--') + '</span></div>';
    } else {
      signalsHtml = '<div class="row"><span class="label">IVR</span><span class="value white">' + (r.ivrBand || '--') + '</span></div>' +
        '<div class="row"><span class="label">IV/HV</span><span class="value white">' + (r.ivhvRatio ? r.ivhvRatio.toFixed(2) : '--') + '</span></div>' +
        '<div class="row"><span class="label">Regime</span><span class="value white">' + r.regime + '</span></div>';
    }

    var html = '<!DOCTYPE html><html><head><title>Trade Summary</title>' +
      '<style>' +
      'body{font-family:-apple-system,sans-serif;max-width:700px;margin:40px auto;color:#e6edf3;background:#0d1117;padding:20px}' +
      'h1{font-size:22px;margin-bottom:4px}' +
      'h2{font-size:14px;color:#8b949e;font-weight:400;margin-top:0}' +
      '.decision{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:' + dcColor + ';margin-bottom:4px}' +
      '.override{display:inline-block;font-size:10px;font-weight:600;padding:2px 8px;border-radius:4px;background:#9e6a03;color:#fff;margin-left:8px}' +
      '.section{margin-top:20px;padding-top:12px;border-top:1px solid #21262d}' +
      '.section-title{font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#8b949e;margin-bottom:8px}' +
      '.row{display:flex;justify-content:space-between;padding:3px 0;font-size:13px}' +
      '.row .label{color:#8b949e}.row .value{font-weight:600;font-family:monospace}' +
      '.green{color:#3fb950}.red{color:#f85149}.amber{color:#d29922}.white{color:#e6edf3}' +
      '.leg{display:inline-block;padding:4px 10px;border-radius:6px;font-size:12px;font-weight:700;font-family:monospace;margin:2px 4px 2px 0}' +
      '.leg-short{background:#8b2025;color:#f85149}.leg-long{background:#0d2818;color:#3fb950}' +
      '.warn{font-size:12px;color:#d29922;margin:2px 0}' +
      '.timestamp{font-size:11px;color:#484f58;margin-top:24px}' +
      '@media print{body{background:#fff;color:#1a1a1a}.leg-long{color:#1a7f37}.leg-short{color:#cf222e}}' +
      '</style></head><body>' +
      '<div class="decision">' + effectiveDecision + (isOverride ? '<span class="override">MANUAL OVERRIDE</span>' : '') + '</div>' +
      '<h1>' + underlying + ' \u2014 ' + effectiveStrat + ' \u2014 ' + r.contracts + ' contract' + (r.contracts !== 1 ? 's' : '') + '</h1>' +
      '<h2>' + (is0 ? r.dirLabel : r.outlook || '') + ' \u2014 max loss $' + (r.maxRisk ? r.maxRisk.toFixed(0) : '0') + '</h2>' +
      (r.tradeConfidence != null ?
        '<div style="margin-top:12px;padding:12px 16px;border-radius:8px;background:' + confBg + ';border:1px solid ' + confClr + '">' +
          '<div style="display:flex;align-items:center;gap:12px">' +
            '<span style="font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#8b949e">Trade Confidence</span>' +
            '<span style="font-size:22px;font-weight:800;font-family:monospace;color:' + confClr + '">' + r.tradeConfidence + '<span style="font-size:12px;color:#8b949e">/100</span></span>' +
            '<span style="font-size:11px;font-weight:700;padding:2px 10px;border-radius:10px;background:' + confClr + ';color:#0d1117;text-transform:uppercase;letter-spacing:0.04em">' + r.confidenceTier + '</span>' +
          '</div>' +
          '<div style="font-size:12px;color:#c9d1d9;margin-top:5px">' + r.confidenceDriver + '</div>' +
          ((r.confConflicts && r.confConflicts.length) ?
            '<div style="margin-top:7px;display:flex;flex-wrap:wrap;gap:6px">' +
            r.confConflicts.map(function(c){
              return '<span title="' + c.label.replace(/"/g,'') + '" style="font-size:10px;font-weight:600;padding:2px 8px;border-radius:4px;background:' + (c.severity==='high'?'#3d1418':'#2a2410') + ';color:' + (c.severity==='high'?'#f85149':'#d29922') + '">\u26a0 ' + c.tag + '</span>';
            }).join('') + '</div>' : '') +
        '</div>' : '') +
      '<div style="display:flex;gap:20px;margin-top:8px;font-size:12px">' +
        '<div style="padding:6px 12px;border-radius:6px;background:' + sBg + ';border:1px solid ' + sClr + '">' +
          '<span style="color:#8b949e">Setup Quality</span> <span style="color:' + sClr + ';font-weight:700;font-family:monospace">' + r.setup + ' ' + r.setupScore + '/100</span>' +
        '</div>' +
        '<div style="padding:6px 12px;border-radius:6px;background:#161b22;border:1px solid #30363d">' +
          '<span style="color:#8b949e">Adj Kelly</span> <span style="color:' + (r.kellyOverRisk ? '#f85149' : '#3fb950') + ';font-weight:700;font-family:monospace">$' + (r.kellyDollar ? r.kellyDollar.toFixed(0) : '0') + ' (' + (r.adjustedKelly ? (r.adjustedKelly*100).toFixed(1) : '0') + '%)</span>' +
        '</div>' +
        '<div style="padding:6px 12px;border-radius:6px;background:#161b22;border:1px solid #30363d">' +
          '<span style="color:#8b949e">Fair Value</span> <span style="color:' + (r.fairValueScore >= 80 ? '#3fb950' : r.fairValueScore >= 70 ? '#d29922' : '#f85149') + ';font-weight:700;font-family:monospace">' + r.fairValueScore + '/100 ' + r.fairValueGrade + '</span>' +
        '</div>' +
        '<div style="padding:6px 12px;border-radius:6px;background:#161b22;border:1px solid #30363d">' +
          '<span style="color:#8b949e">Score</span> <span style="color:' + dcColor + ';font-weight:700;font-family:monospace">' + compositeScore + '/100</span>' +
        '</div>' +
      '</div>' +
      (warningsHtml ? '<div style="margin-top:10px;padding:8px 12px;background:#1f1a0d;border:1px solid #9e6a03;border-radius:6px">' + warningsHtml + '</div>' : '') +
      '<div style="margin-top:12px">' + legsHtml + '</div>' +
      (r.wingTxt ? '<div style="font-size:11px;color:#8b949e;margin-top:4px">' + r.wingTxt + '</div>' : '') +
      (is0 && r.holdToExpiry ? '<div style="font-size:11px;color:#8b949e;margin-top:4px"><b>Expiry:</b> ' + r.holdToExpiry.label + ' — ' + r.holdToExpiry.note + '</div>' : '') +
      (r.behaviour ? '<div style="font-size:12px;color:#8b949e;margin-top:8px;font-style:italic">Profit if: ' + r.behaviour + '</div>' : '') +
      '<div class="section"><div class="section-title">Setup Quality</div>' + criteriaHtml + '</div>' +
      (r.payoff ? '<div class="section"><div class="section-title">Payoff at Expiry</div>' +
      '<div class="row"><span class="label">Max profit</span><span class="value green">$' + r.payoff.maxProfit.toFixed(0) + '</span></div>' +
      '<div class="row"><span class="label">Max loss</span><span class="value red">$' + r.payoff.maxLoss.toFixed(0) + '</span></div>' +
      '<div class="row"><span class="label">Breakeven(s)</span><span class="value white">' + (r.payoff.breakevens.length > 0 ? r.payoff.breakevens.map(function(b){return b.toFixed(1)}).join(', ') : '--') + '</span></div>' +
      '<div class="row"><span class="label">Profit band</span><span class="value white">' + (r.payoff.profitBandWidth > 0 ? r.payoff.profitBandLow.toFixed(0) + '\u2013' + r.payoff.profitBandHigh.toFixed(0) + ' (' + r.payoff.profitBandWidth.toFixed(0) + ' pts)' : '--') + '</span></div>' +
      '</div>' : '') +
      '<div class="section"><div class="section-title">Sizing (Sharpe-Adjusted Kelly)</div>' +
      '<div class="row"><span class="label">Contracts</span><span class="value white">' + r.contracts + '</span></div>' +
      '<div class="row"><span class="label">Adj Kelly $</span><span class="value ' + (r.kellyOverRisk ? 'red' : 'green') + '">$' + (r.kellyDollar ? r.kellyDollar.toFixed(0) : '0') + '</span></div>' +
      '<div class="row"><span class="label">Raw Kelly</span><span class="value white">' + (r.rawKelly ? (r.rawKelly*100).toFixed(1) : '0') + '%</span></div>' +
      '<div class="row"><span class="label">Vol factor</span><span class="value white">' + (r.volFactor ? r.volFactor.toFixed(2) : '--') + '</span></div>' +
      '<div class="row"><span class="label">Sharpe factor</span><span class="value white">' + (r.sharpeFactor ? r.sharpeFactor.toFixed(2) : '--') + '</span></div>' +
      '<div class="row"><span class="label">EV / trade' + (r.evBasis ? ' <span style="opacity:0.6;font-size:9px">(' + (r.evBasis.mode==='measured'?'measured':'est') + ')</span>' : '') + '</span><span class="value ' + (r.ev > 0 ? 'green' : 'red') + '">$' + (r.ev ? r.ev.toFixed(0) : '0') + '</span></div>' +
      '<div class="row"><span class="label">POP margin</span><span class="value ' + (r.popMargin >= 1.5 ? 'green' : r.popMargin >= 1.0 ? 'amber' : 'red') + '">' + (r.popMargin ? r.popMargin.toFixed(2) : '--') + 'x</span></div>' +
      '</div>' +
      greeksHtml +
      '<div class="section"><div class="section-title">Fair Value Score — ' + r.fairValueScore + '/100 (' + r.fairValueGrade + ')</div>' +
      '<div class="row"><span class="label">Volatility (IV/HV)</span><span class="value white">' + r.volScore + '/100 — ' + r.volGrade + '</span></div>' +
      '<div class="row"><span class="label">Structure</span><span class="value white">' + r.structScore + '/100 — ' + r.structGrade + '</span></div>' +
      '<div class="row"><span class="label">Regime</span><span class="value white">' + r.regimeScore + '/100 — ' + r.regimeGrade + '</span></div>' +
      '</div>' +
      '<div class="section"><div class="section-title">Signals</div>' + signalsHtml + '</div>' +
      '<div class="timestamp">Generated ' + new Date().toLocaleString('en-AU') + ' \u2014 Options Tracker Decision Engine</div>' +
      '</body></html>';

    var win = window.open('', '_blank');
    if (win) {
      win.document.write(html);
      win.document.close();
      win.focus();
      setTimeout(function() { win.print(); }, 500);
    }
  }

  // Build a condensed plain-text summary of the engine's analysis for the notes
  // field — captures what the setup looked like at trade time.
  function buildTradeSummary() {
    const inp = is0 ? i0 : i45;
    const ncd = parseFloat(inp.netCreditDebit) || 0;
    const lines = [];
    lines.push(`${inp.underlying} — ${effectiveStrat} — ${r.contracts}x  [${is0?'0DTE':'45DTE'}]`);
    lines.push(`Setup: ${r.setup} ${r.setupScore}/100 · Composite ${compositeScore}/100 · FV ${r.fairValueScore}/100 (${r.fairValueGrade})`);
    if (r.tradeConfidence != null) {
      lines.push(`Confidence: ${r.tradeConfidence}/100 (${r.confidenceTier}) — ${r.confidenceDriver}`);
      if (r.confConflicts?.length) lines.push(`Conflicts: ${r.confConflicts.map(c=>c.tag).join(', ')}`);
    }
    if (isOverride) lines.push(`Override: engine picked ${r.bestStrat}, logged ${effectiveStrat}`);
    lines.push(`Strikes: ${r.legs.map(l=>`${l.strike} ${l.label}`).join(' | ')}`);
    if (r.skewNote) lines.push(r.skewNote);
    if (is0 && r.holdToExpiry) lines.push(`Expiry: ${r.holdToExpiry.label} — ${r.holdToExpiry.note}`);
    lines.push(`${ncd>0?`Credit $${ncd.toFixed(2)}`:ncd<0?`Debit $${Math.abs(ncd).toFixed(2)}`:''} · POP ${inp.pop||'--'}% · Win $${inp.win||'--'} · Risk $${inp.risk||'--'}`);
    lines.push(`Sizing: Kelly ${(r.adjustedKelly*100).toFixed(1)}% · ${r.contracts} contract${r.contracts!==1?'s':''} · EV $${r.ev?.toFixed(0)||0}${r.ev<0?' (negative)':''}`);
    if (r.evBasis?.pMaxLoss != null) lines.push(`P(max loss): ${(r.evBasis.pMaxLoss*100).toFixed(1)}% (${r.evBasis.pMaxLossSource||'model'})`);
    if (r.evBasis?.winBreakeven != null) lines.push(`Win needed for EV=0: $${r.evBasis.winBreakeven}`);
    // Key signals
    if (is0) {
      lines.push(`Signals: ${r.dirLabel} · ${r.trendPattern||'--'} · Regime ${r.regime} · Move ${r.moveConsumed!==undefined?(r.moveConsumed*100).toFixed(0)+'%':'--'} · VIX gap ${(r.vixGap*100).toFixed(1)}%`);
    } else {
      lines.push(`Signals: IVR ${r.ivrBand||'--'} · IV/HV ${r.ivhvRatio?r.ivhvRatio.toFixed(2):'--'} · Regime ${r.regime}`);
    }
    if (r.greeks) lines.push(`Survivability: ${r.greeks.thetaPaid ? 'Decay cost' : 'Theta edge'} ${r.greeks.tEdge.toFixed(2)} (${r.greeks.tEdgeSignal}) · Gamma ${r.greeks.gRisk.toFixed(2)}${r.greeks.thetaPaid ? ' · PAYS decay' : ''}`);
    if (r.warnings?.length) lines.push(`Warnings: ${r.warnings.join('; ')}`);
    return lines.filter(Boolean).join('\n');
  }

  // Log flow (Aug 2026): the old window.prompt is now an inline note input next
  // to the Log button. Confirm (button or Enter) logs the trade with the note;
  // Cancel or Escape closes the input and nothing is logged — the same abort
  // semantics the prompt's Cancel had, but without a blocking modal, and the
  // half-typed note is only lost, never the ticket.
  function handleLog() {
    if (!onLogTrade) return;
    if (!accountConfig?.id) {
      notify('Please select a specific account in the sidebar before logging a trade.');
      return;
    }
    setLogNote('');
    setLogNoteOpen(true);
  }
  function confirmLog() {
    const inp = is0 ? i0 : i45;
    const engineSummary = buildTradeSummary();
    const fullNotes = engineSummary
      + '\n\n--- My notes ---\n'
      + (logNote.trim() || '(none)');
    setLogNoteOpen(false);
    onLogTrade({ engine:is0?'0DTE':'45DTE', underlying:inp.underlying,
      strategy:`${inp.underlying} - ${effectiveStrat} - ${r.contracts} contract${r.contracts!==1?'s':''}`,
      direction:effectiveDecision, contracts:r.contracts, kellyDollar:`$${r.kellyDollar?.toFixed(0)||0}`,
      popMargin:r.popMargin?`${r.popMargin.toFixed(2)}x`:'', setupScore:`${r.setupScore}/100`,
      setupGrade:r.setup, regime:r.regime, wingStrikes:r.legs.map(l=>l.strike).join(' / '),
      marketBehaviour:r.behaviour,
      notes: fullNotes,
      price:fv(inp,'price'), vix:fv(inp,'vix'),
      vix1d:is0?fv(inp,'vix1d'):0, iv:is0?0:fv(inp,'iv'), ivr:is0?0:fv(inp,'ivr'),
      em:is0?fv(inp,'em'):0, timestamp:new Date().toISOString(),
      account: accountConfig?.id || '',
      // Open position greeks (already populated by Fetch Greeks or entered manually)
      delta:fv(inp,'delta'), theta:fv(inp,'theta'),
      gamma:fv(inp,'gamma'), vega:fv(inp,'vega'),
      // The trade as priced, and the engine's own verdict on it. Logged so a month of
      // reviews is a query rather than a stack of ticket PDFs. (Aug 2026.)
      netCreditDebit: fv(inp, 'netCreditDebit'),
      maxRisk: r.maxRisk ?? '',
      maxProfit: (r.contracts && fv(inp, 'win')) ? r.contracts * fv(inp, 'win') : '',
      ev: r.ev != null ? Math.round(r.ev) : '',
      confidence: r.tradeConfidence != null ? `${r.tradeConfidence}/100 ${r.confidenceTier}` : '',
      pMaxLoss: r.pMaxLoss != null ? `${(r.pMaxLoss * 100).toFixed(1)}%` : '',
      pMaxLossBasis: r.pMaxLossBasis
        ? `${r.pMaxLossBasis.emSrc} EM ${r.pMaxLossBasis.em.toFixed(1)} \u2192 \u03c3 ${r.pMaxLossBasis.sigma.toFixed(1)}`
        : '',
      cushionEM: r.holdToExpiry?.cushionEM != null ? r.holdToExpiry.cushionEM.toFixed(2) : '',
      // Expiry info for tracking
      dte: is0 ? '0DTE' : '45DTE',
      expiryDate: is0 ? new Date().toISOString().split('T')[0] : '' // 0DTE expires today
    });
  }

  // ES overnight reference-date labels (ET). ES trades ~23h, so "close"/"open" are
  // reference times, not real session boundaries: prior close = prior weekday 16:00,
  // pre-open = today 08:45.
  const _nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const _esPreDate = _nowET;
  const _esPriorDate = new Date(_nowET);
  _esPriorDate.setDate(_esPriorDate.getDate() - 1);
  const _pdow = _esPriorDate.getDay();
  if (_pdow === 0) _esPriorDate.setDate(_esPriorDate.getDate() - 2);
  else if (_pdow === 6) _esPriorDate.setDate(_esPriorDate.getDate() - 1);
  const _fmtDM = (dt) => dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  const esPriorCloseLabel = `ES ${_fmtDM(_esPriorDate)} 16:00`;
  const esPreOpenLabel = `ES ${_fmtDM(_esPreDate)} 08:45`;

  return (
    <div className="space-y-4">
      {/* Decision Block */}
      <div style={{background:dcBg,border:`1px solid ${dcBorder}`,borderRadius:12,padding:'16px 20px'}}>
        <div style={{display:'flex',gap:20,alignItems:'flex-start'}}>
          {/* Left: strategy info */}
          <div style={{flex:'1 1 auto',minWidth:0}}>
            {/* Zone 1 — identity row: status pill · title · badges */}
            <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
              <span style={{fontSize:12,fontWeight:700,padding:'2px 10px',borderRadius:999,
                color:(missingInputs && !hasBlocker)?'#d29922':dcColor,
                border:`1px solid ${(missingInputs && !hasBlocker)?'#9e6a03':dcBorder}`,
                background:'rgba(255,255,255,0.04)',textTransform:'uppercase',letterSpacing:'0.06em'}}>{effectiveDecision}</span>
              <span style={{fontSize:16,fontWeight:600,color:'#fff'}}>
                {r.hardBlocker || `${is0?i0.underlying:i45.underlying} · ${effectiveStrat}${missingInputs ? '' : ` · ${r.contracts}x`}`}
              </span>
              {isOverride && <span style={{fontSize:10,fontWeight:600,padding:'2px 8px',borderRadius:4,background:'#9e6a03',color:'#fff'}}>MANUAL OVERRIDE</span>}
              {(() => {
                const net = parseFloat(ticketNet);
                const hasNet = !isNaN(net) && net !== 0;
                const label = cashType === 'credit' ? 'CREDIT' : cashType === 'debit' ? 'DEBIT' : 'CREDIT / DEBIT';
                const bg = cashType === 'credit' ? '#0d2818' : cashType === 'debit' ? '#2d1a0d' : '#1c2128';
                const fg = cashType === 'credit' ? '#3fb950' : cashType === 'debit' ? '#e3a008' : '#8b949e';
                const hint = hasNet ? ` ${net > 0 ? '+' : '−'}$${Math.abs(net).toFixed(0)}` : '';
                return <span title={cashType==='varies' ? 'This structure can be credit or debit — enter the net to resolve' : (cashType==='credit'?'You collect premium at entry':'You pay premium at entry')}
                  style={{fontSize:10,fontWeight:700,padding:'2px 8px',borderRadius:4,background:bg,color:fg,letterSpacing:'0.04em'}}>{label}{hint}</span>;
              })()}
              {r.tradeConfidence != null && (
                <span title={r.confidenceDriver} style={{fontSize:10,fontWeight:700,padding:'2px 8px',borderRadius:4,background:confBg,border:`1px solid ${confClr}`,color:confClr,letterSpacing:'0.04em'}}>
                  CONF {r.tradeConfidence} · {r.confidenceTier.toUpperCase()}
                </span>
              )}
            </div>
        {/* Zone 1b — strike chips (compact mono) with wing-distance appended inline */}
        {r.legs.length > 0 && (
          <div style={{marginTop:8}}>
            {r.legs.length === 4 && r.legs[0]?.label?.includes('VIX') ? (
              // Dual EM suggestions for spreads
              <div style={{display:'flex',flexDirection:'column',gap:6}}>
                <div style={{display:'flex',alignItems:'center',gap:8}}>
                  <span style={{fontSize:10,color:'#8b949e',width:50}}>EM(VIX):</span>
                  {r.legs.slice(0,2).map((l,i) => {
                    const isShort = l.label.toLowerCase().includes('short');
                    return (<div key={i} style={{padding:'3px 10px',borderRadius:8,fontSize:12,fontWeight:700,background:isShort?'#8b2025':'#0d2818',color:isShort?'#f85149':'#3fb950',fontFamily:'JetBrains Mono,monospace'}}>
                      {l.strike} <span style={{fontSize:10,fontWeight:400,opacity:0.8}}>{l.label.replace(' (VIX)','')}</span>
                    </div>);
                  })}
                </div>
                <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
                  <span style={{fontSize:10,color:'#8b949e',width:50}}>EM(1D):</span>
                  {r.legs.slice(2,4).map((l,i) => {
                    const isShort = l.label.toLowerCase().includes('short');
                    return (<div key={i} style={{padding:'3px 10px',borderRadius:8,fontSize:12,fontWeight:700,background:isShort?'#8b2025':'#0d2818',color:isShort?'#f85149':'#3fb950',fontFamily:'JetBrains Mono,monospace'}}>
                      {l.strike} <span style={{fontSize:10,fontWeight:400,opacity:0.8}}>{l.label.replace(' (VIX1D)','')}</span>
                    </div>);
                  })}
                  {(r.wingTxt || r.strikeLine) && <span style={{fontSize:11,color:'#8b949e'}}>{r.wingTxt || r.strikeLine}</span>}
                </div>
              </div>
            ) : (
              // Standard leg display — wing distance appended inline, muted
              <div style={{display:'flex',flexWrap:'wrap',gap:'6px 8px',alignItems:'center'}}>
                {r.legs.map((l,i) => {
                  const isShort = l.label.toLowerCase().includes('short');
                  return (<div key={i} style={{padding:'3px 10px',borderRadius:8,fontSize:12,fontWeight:700,background:isShort?'#8b2025':'#0d2818',color:isShort?'#f85149':'#3fb950',fontFamily:'JetBrains Mono,monospace'}}>
                    {l.strike} <span style={{fontSize:10,fontWeight:400,opacity:0.8}}>{l.label}</span>
                  </div>);
                })}
                {(r.wingTxt || r.strikeLine) && <span style={{fontSize:11,color:'#8b949e'}}>{r.wingTxt || r.strikeLine}</span>}
              </div>
            )}
          </div>
        )}
        {/* Zone 2 — stat tiles: Score · P(max loss) · EV · Kelly. The detailed
            P(max loss) breakdown box stays in the input column; this is the headline.
            EV/Kelly gate on missingInputs (r.missingSize); P(max loss) on r.pMaxLoss==null. */}
        {!r.hardBlocker && (() => {
          const tile = (label, value, dim) => (
            <div style={{background:'rgba(255,255,255,0.04)',borderRadius:8,padding:'8px 10px',opacity:dim?0.55:1}}>
              <div style={{fontSize:11,color:'#8b949e',letterSpacing:'0.04em'}}>{label}</div>
              {value}
            </div>
          );
          const needs = txt => <div style={{fontSize:12,color:'#8b949e',marginTop:3}}>{txt}</div>;
          const val = (node) => <div style={{fontSize:19,fontWeight:700,fontFamily:'JetBrains Mono,monospace',marginTop:1}}>{node}</div>;
          return (
            <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8,marginTop:10}}>
              {tile('SCORE', val(<span style={{color:dcColor}}>{compositeScore}/100</span>), false)}
              {tile('P(MAX LOSS)', r.pMaxLoss==null ? needs('needs greeks')
                : val(<span style={{color: r.pMaxLoss<=0.15?'#3fb950':r.pMaxLoss<=0.30?'#d29922':'#f85149'}}>{(r.pMaxLoss*100).toFixed(1)}%</span>),
                r.pMaxLoss==null)}
              {tile('EV', missingInputs ? needs('needs sizing')
                : val(<><span style={{color: r.ev>0?'#3fb950':r.ev<0?'#f85149':'#8b949e'}}>{r.ev?`$${r.ev.toFixed(0)}`:'--'}</span>
                  {r.evBasis && <span style={{fontSize:10,fontWeight:400,color:'#8b949e'}}> {r.evBasis.mode==='measured'?'meas':'est'}</span>}</>),
                missingInputs)}
              {tile('KELLY', missingInputs ? needs('needs sizing')
                : val(<span style={{color: r.kellyOverRisk?'#f85149':'#3fb950'}}>{r.contracts}x · ${r.kellyDollar?.toFixed(0)||0}</span>),
                missingInputs)}
            </div>
          );
        })()}
        {/* Zone 3 — thesis line: direction/trend · skew clause · profit-if */}
        {!r.hardBlocker && (
          <div style={{marginTop:8}}>
            <span style={{fontSize:14,fontWeight:700,color:'#fff'}}>{`${is0?r.dirLabel:'—'} — ${r.trendPattern||'—'}`}</span>
            <span style={{fontSize:13,color:'#8b949e'}}>
              {skewClause ? ` — ${skewClause}.` : ''}
              {r.behaviour ? ` Profit if: ${r.behaviour}` : ''}
            </span>
          </div>
        )}
        {!r.hardBlocker && r.tradeConfidence != null && (
          <div style={{marginTop:6,fontSize:12,color:'#8b949e'}}>
            <span style={{color:confClr,fontWeight:600}}>Confidence {r.tradeConfidence}/100 · {r.confidenceTier}</span>
            {' — '}{r.confidenceDriver}
            {r.confConflicts && r.confConflicts.length > 0 && (
              <span style={{display:'inline-flex',flexWrap:'wrap',gap:6,marginLeft:8,verticalAlign:'middle'}}>
                {r.confConflicts.map((c,i) => (
                  <span key={i} title={c.label} style={{fontSize:10,fontWeight:600,padding:'1px 7px',borderRadius:4,
                    background:c.severity==='high'?'#3d1418':'#2a2410',color:c.severity==='high'?'#f85149':'#d29922'}}>⚠ {c.tag}</span>
                ))}
              </span>
            )}
          </div>
        )}
        {/* Zone 4 — warning chips: hold-to-expiry verdict, expandable "why" */}
        {is0 && r.holdToExpiry && (() => {
          const h = r.holdToExpiry;
          const bg = h.verdict==='hold'?'#0d2818':h.verdict==='watch'?'#1f1a0d':'#2d0f11';
          const fg = h.verdict==='hold'?'#3fb950':h.verdict==='watch'?'#d29922':'#f85149';
          return (
            <div style={{marginTop:8}}>
              <div style={{display:'inline-flex',alignItems:'center',gap:8,borderRadius:6,padding:'4px 10px',fontSize:12,background:bg,color:fg}}>
                <span>Expiry · {h.label} · cushion {h.cushionEM.toFixed(2)} EM (need {h.needed.toFixed(2)}) · {h.isCashSettled?'cash-settled':'settles into shares'}</span>
                <span onClick={()=>setExpandedWarning(expandedWarning==='expiry'?null:'expiry')}
                  style={{textDecoration:'underline',cursor:'pointer',opacity:0.85}}>why</span>
              </div>
              {expandedWarning==='expiry' && (
                <div style={{fontSize:11,color:'#8b949e',marginTop:4}}>{h.note}</div>
              )}
            </div>
          );
        })()}
        {!r.hardBlocker && bannerGrade !== 'weak' && !missingInputs && (
          <button onClick={handleLog} style={{marginTop:10,padding:'6px 16px',borderRadius:8,border:'none',background:'#238636',color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>Log trade</button>
        )}
        {isOverride && (
          <button onClick={() => setOverrideStrat(null)} style={{marginTop:10,marginLeft:8,padding:'6px 16px',borderRadius:8,border:'1px solid #30363d',background:'transparent',color:'#8b949e',fontSize:12,cursor:'pointer'}}>Clear override</button>
        )}
        {logNoteOpen && (
          <div style={{marginTop:10,display:'flex',gap:6,alignItems:'center',maxWidth:560}}>
            <input autoFocus type="text" value={logNote}
              onChange={e=>setLogNote(e.target.value)}
              onKeyDown={e=>{ if (e.key==='Enter') { e.preventDefault(); confirmLog(); } else if (e.key==='Escape') { setLogNoteOpen(false); } }}
              placeholder="Add a note for this trade (optional) — your rationale, plan, or anything to remember"
              style={{flex:1,padding:'7px 10px',borderRadius:8,border:'1px solid #30363d',background:'#0d1117',color:'#e6edf3',fontSize:12,outline:'none'}} />
            <button onClick={confirmLog} style={{padding:'6px 14px',borderRadius:8,border:'none',background:'#238636',color:'#fff',fontSize:12,fontWeight:600,cursor:'pointer'}}>Log</button>
            <button onClick={()=>setLogNoteOpen(false)} title="Abort logging (nothing is written)"
              style={{padding:'6px 12px',borderRadius:8,border:'1px solid #30363d',background:'transparent',color:'#8b949e',fontSize:12,cursor:'pointer'}}>Cancel</button>
          </div>
        )}
          </div>
          {/* Right rail: mini payoff · BE/max caption · print */}
          <div style={{flex:'0 0 180px',display:'flex',flexDirection:'column',gap:6}}>
            {r.payoff && r.payoff.points.length > 0 && (
              <PayoffDiagram payoff={r.payoff} currentPrice={is0?fv(i0,'price'):fv(i45,'price')} mini />
            )}
            {r.payoff && (() => {
              const bes = (r.payoff.breakevens || []).filter(Number.isFinite);
              const mp = r.payoff.maxProfit;
              const parts = [];
              if (bes.length) parts.push(`BE ${bes.map(b => Math.round(b)).join(' / ')}`);
              if (Number.isFinite(mp)) parts.push(`max +$${mp >= 1000 ? (mp/1000).toFixed(1).replace(/\.0$/,'') + 'k' : Math.round(mp)}`);
              return parts.length > 0 ? (
                <div style={{fontFamily:'JetBrains Mono,monospace',fontSize:11,color:'#8b949e',textAlign:'center'}}>{parts.join(' · ')}</div>
              ) : null;
            })()}
            <button onClick={handlePrint} style={{padding:'6px 16px',borderRadius:8,border:'1px solid #30363d',background:'transparent',color:'#c9d1d9',fontSize:12,cursor:'pointer'}}>Print summary</button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* ── INPUTS PANEL ── */}
        <div className="card" style={{maxHeight:'calc(100vh - 360px)',overflowY:'auto'}}>

          {/* Source legend — the SAME colours the per-field states already use:
              green = the feed / LIVE badge, amber = Inp's manual (held) state,
              dim grey = Inp's stale (not returned by the last pull) state. */}
          <div style={{display:'flex',alignItems:'center',gap:14,flexWrap:'wrap',fontSize:10,color:'#8b949e',lineHeight:1,marginBottom:2}}>
            <span style={{display:'inline-flex',alignItems:'center',gap:4}}><span style={{width:6,height:6,borderRadius:'50%',background:'#3fb950',display:'inline-block'}}/>live feed</span>
            <span style={{display:'inline-flex',alignItems:'center',gap:4}}><span style={{width:6,height:6,borderRadius:'50%',background:'#d29922',display:'inline-block'}}/>manual ✎</span>
            <span style={{display:'inline-flex',alignItems:'center',gap:4}}><span style={{width:6,height:6,borderRadius:'50%',background:'#6e7681',display:'inline-block'}}/>stale</span>
          </div>

          {/* Market Data */}
          <InputSection
            title="Market data"
            info="Price, high, low from your chart or auto-filled from IBKR. VWAP 5 and 15 with 30-min ago values for slope calculation. SPX uses SPY VWAP ×10 automatically."
            missing={secMissing.market}
            collapsed={isCollapsed('market')}
            onToggle={() => toggleSection('market')}
            onExpand={() => expandSection('market')}
            actions={<>
              {dataFresh && (
                <span title={(dataFresh.label || '') + (dataFresh.asOf ? ' \u00b7 quote stamped ' + new Date(dataFresh.asOf).toLocaleString('en-AU') : '')
                  + (feed && feed.missing && feed.missing.length ? '\n' + feed.missing.length + ' field(s) not returned by this pull: ' + feed.missing.join(', ') : '')}
                  style={{padding:'2px 8px',borderRadius:4,fontSize:10,fontWeight:700,letterSpacing:'0.04em',whiteSpace:'nowrap',
                    background: dataFresh.isLive ? '#0d2818' : '#161b22',
                    color: dataFresh.isLive ? '#3fb950' : '#8b949e',
                    border: '1px solid ' + (dataFresh.isLive ? '#238636' : '#30363d')}}>
                  {dataFresh.isLive ? '\u25cf LIVE' : '\u25cb LAST CLOSE'}
                  {(dataFresh.pulledAt || dataFresh.asOf) && <span style={{fontWeight:600}}> {clockOf(dataFresh.pulledAt || dataFresh.asOf)}</span>}
                  <span style={{fontWeight:400,opacity:0.75}}> · {agoOf(dataFresh.pulledAt || dataFresh.asOf, tick)}</span>
                </span>
              )}
              {justRefreshed && (
                <span style={{padding:'2px 8px',borderRadius:4,fontSize:10,fontWeight:700,letterSpacing:'0.04em',whiteSpace:'nowrap',
                  background:'#0d2818',color:'#3fb950',border:'1px solid #238636'}}>
                  ✓ REFRESHED{feed && feed.missing && feed.missing.length ? ' · ' + feed.missing.length + ' missing' : ''}
                </span>
              )}
              {heldKeys.length > 0 && (
                <button onClick={releaseHolds}
                  title={'You are holding ' + heldKeys.length + ' hand-typed market field(s); auto-fill leaves them alone. Click to release them and take the last feed value back.'}
                  style={{padding:'2px 8px',borderRadius:4,fontSize:10,fontWeight:700,letterSpacing:'0.04em',whiteSpace:'nowrap',
                    background:'#2d1a0d',color:'#d29922',border:'1px solid #5a3a1a',cursor:'pointer'}}>
                  ✎ {heldKeys.length} MANUAL
                </button>
              )}
              <button onClick={handleLoadFromTWS} disabled={loadingTws}
                title="Load an open option position from TWS into the ticket, then pull market data"
                style={{padding:'3px 10px',borderRadius:6,border:'1px solid #30363d',background:loadingTws?'#161b22':'transparent',color:loadingTws?'#8b949e':'#3fb950',fontSize:11,fontWeight:600,cursor:'pointer'}}>
                {loadingTws ? 'Loading…' : '📥 Load position (TWS)'}
              </button>
              <button onClick={handleAutoFill} disabled={autoFilling}
                style={{padding:'3px 10px',borderRadius:6,border:'1px solid #30363d',background:autoFilling?'#161b22':'transparent',color:autoFilling?'#8b949e':'#2f81f7',fontSize:11,fontWeight:600,cursor:'pointer'}}>
                {autoFilling ? 'Fetching...' : '⚡ Auto-fill'}
              </button>
            </>}
            pinned={twsStructures && twsStructures.length > 1 && (
            <div style={{border:'1px solid #30363d',borderRadius:8,padding:10,marginBottom:8,background:'#0d1117'}}>
              <div style={{fontSize:12,color:'#8b949e',marginBottom:6}}>Multiple open positions in TWS — pick one:</div>
              {twsStructures.map((s, i) => (
                <button key={i} onClick={() => applyTwsStructure(s)}
                  style={{display:'block',width:'100%',textAlign:'left',padding:'6px 8px',marginBottom:4,borderRadius:6,border:'1px solid #30363d',background:'transparent',color:'#c9d1d9',fontSize:12,cursor:'pointer'}}>
                  <b>{s.underlying}</b> {s.shape} · {s.legCount} legs · strikes {s.strikes.join('/')} · {s.isCredit ? 'credit' : 'debit'} ${Math.abs(Math.round((s.netCreditDebit||0)*100))} · exp {s.expiry}
                </button>
              ))}
              <button onClick={() => setTwsStructures(null)}
                style={{marginTop:4,padding:'3px 8px',borderRadius:5,border:'none',background:'transparent',color:'#8b949e',fontSize:11,cursor:'pointer'}}>Cancel</button>
            </div>
          )}>
          <div className="grid grid-cols-2 gap-2.5">
            <Sel label="Underlying" value={is0?i0.underlying:i45.underlying} onChange={v=>is0?set0('underlying',v):set45('underlying',v)} options={UNDERLYING_LIST}/>
            <Inp label="Price" {...mk('price')} value={is0?i0.price:i45.price} onChange={v=>is0?set0('price',v):set45('price',v)}/>
            {is0 ? <>
              <Inp label="Day high" {...mk('high')} value={i0.high} onChange={v=>set0('high',v)}/>
              <Inp label="Day low" {...mk('low')} value={i0.low} onChange={v=>set0('low',v)}/>
              <Inp label={`VWAP 5${vwapScaled ? ' (SPY→x10)' : ''}`} {...mk('vwap5')} value={i0.vwap5} onChange={v=>set0('vwap5',v)}/>
              <Inp label={`VWAP 5 -30min${vwapScaled ? ' (x10)' : ''}`} {...mk('vwap5_30')} value={i0.vwap5_30} onChange={v=>set0('vwap5_30',v)}/>
              <Inp label={`VWAP 15${vwapScaled ? ' (x10)' : ''}`} {...mk('vwap15')} value={i0.vwap15} onChange={v=>set0('vwap15',v)}/>
              <Inp label={`VWAP 15 -30min${vwapScaled ? ' (x10)' : ''}`} {...mk('vwap15_30')} value={i0.vwap15_30} onChange={v=>set0('vwap15_30',v)}/>
              <Inp label="EM" {...mk('em')} value={i0.em} onChange={v=>{setI0(prev=>({...prev, em:v, emSource:'manual', straddleCall:'', straddlePut:''})); markHeld('0','em');}}/>
              <Inp label="ATR 1 Day" {...mk('atr')} value={i0.atr} onChange={v=>set0('atr',v)}/>
              <Inp label="ATR 5m" {...mk('atr5')} value={i0.atr5} onChange={v=>set0('atr5',v)}/>
              <Inp label="ATR 2h" {...mk('atr2h')} value={i0.atr2h} onChange={v=>set0('atr2h',v)}/>
              <Inp label="VIX" {...mk('vix')} value={i0.vix} onChange={v=>set0('vix',v)}/>
              <Inp label="VIX1D" {...mk('vix1d')} value={i0.vix1d} onChange={v=>set0('vix1d',v)}/>
            </> : <>
              <Inp label="VIX" {...mk('vix')} value={i45.vix} onChange={v=>set45('vix',v)}/>
            </>}
          </div>

          {/* EM: source + BOTH rulers. Remaining drives strikes/POP; session drives
              move-consumed, regime and every "% EM" score. One number used to do both. */}
          {is0 && r.emDetail && (
            <div style={{marginTop:6,padding:'7px 10px',borderRadius:8,background:'#0d1117',border:`1px solid ${r.emDisagree ? '#5a3a1a' : '#21262d'}`}}>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:8}}>
                <div style={{fontSize:12,lineHeight:1.4,color: r.emIsStraddle ? '#3fb950' : i0.emSource==='manual' ? '#58a6ff' : '#e3a008'}}>
                  <b>EM {r.emIsStraddle ? '(straddle)' : i0.emSource==='manual' ? '(manual)' : '(VIX model)'}:</b><Info text="Expected move - how far the market is priced to travel, in points. The engine keeps TWO rulers and uses both. REMAINING (now to the close) sets strikes, breakevens and POP. SESSION (open to close) sets move-consumed, regime and every '% EM' score. They differ by sqrt(fraction of session left), so Remaining is always the smaller number - that is scale, not disagreement. SOURCE: straddle (green) = ATM call + put x 1.2533, the market's own priced move with skew and events baked in - preferred. VIX model (amber) = VIX1D / sqrt(252) x the cash open, the fallback when option data is not subscribed. Manual (blue) = your number, always read as a SESSION EM. SD mult converts a straddle to 1 SD: straddle = 0.7979 x S x sigma x sqrt(T), so 1 SD = straddle x 1.2533. Leave it at 1.2533. The line underneath cross-checks the two sources like-for-like by putting the straddle back on the session ruler and comparing its implied session vol against VIX1D; more than 15% apart reads DISAGREE and raises a warning. 'Single source - no cross-check available' means only one source is live, so nothing is validating it. What-if re-runs every EM-driven reading off the other volatility input, so you can see which numbers actually depend on the EM source and which do not." /> {r.emDetail}
                </div>
                <div style={{display:'flex',alignItems:'center',gap:5}}>
                  <span style={{fontSize:11,color:'#8b949e'}} title="Straddle to 1 SD. Black-Scholes ATM identity: straddle = 0.7979 x S x sigma x sqrt(T), so 1 SD = straddle x 1.2533. Leave at 1.2533 unless you know why you're changing it.">SD mult</span>
                  <input type="number" step="0.01" value={i0.straddleHaircut}
                    onChange={e=>set0('straddleHaircut', e.target.value)}
                    style={{width:60,padding:'3px 6px',borderRadius:5,border:'1px solid #30363d',background:'#0d1117',color:'#e6edf3',fontSize:12,fontFamily:'JetBrains Mono,monospace'}} />
                </div>
              </div>
              {(r.emRemainingDetail || r.emSessionDetail) && (
                <div style={{display:'flex',gap:16,flexWrap:'wrap',marginTop:6,fontSize:11,lineHeight:1.5,fontFamily:'JetBrains Mono,monospace',color:'#e6edf3'}}>
                  <div><span style={{color:'#8b949e'}}>Remaining</span> (strikes, POP, breakevens): {r.emRemainingDetail}</div>
                  <div><span style={{color:'#8b949e'}}>Session</span> (move-consumed, regime, % EM): {r.emSessionDetail}</div>
                </div>
              )}
              {r.emAgreeDetail && (
                <div style={{marginTop:4,fontSize:11,lineHeight:1.4,color: r.emDisagree ? '#e3a008' : '#8b949e'}}>
                  {r.emDisagree ? '\u26a0 ' : ''}{r.emAgreeDetail}
                </div>
              )}
              {r.emScaleShift != null && Math.abs(r.emScaleShift - 1) > 0.08 && r.moveConsumedLegacy != null && (
                <div style={{marginTop:4,fontSize:11,lineHeight:1.4,color:'#8b949e'}}>
                  Scale fix: move-consumed reads {(r.moveConsumed*100).toFixed(0)}% on the session ruler
                  (old build showed {(r.moveConsumedLegacy*100).toFixed(0)}%).
                </div>
              )}
              {altVol && (
                <div style={{marginTop:7,paddingTop:6,borderTop:'1px solid #21262d'}}>
                  <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8,flexWrap:'wrap'}}>
                    <div style={{fontSize:11,color:'#8b949e',lineHeight:1.4}}>
                      What if EM came from <b style={{color:'#e6edf3'}}>{altVol.label}</b>?
                      {altVol.changed === 0
                        ? ' \u2014 nothing changes.'
                        : ` \u2014 ${altVol.changed} of ${altVol.rows.length} readings move.`}
                    </div>
                    <button onClick={()=>setShowWhatIf(v=>!v)}
                      style={{padding:'3px 9px',borderRadius:5,border:'1px solid #30363d',background:showWhatIf?'#1f2937':'#0d1117',
                        color:'#8b949e',fontSize:11,cursor:'pointer',whiteSpace:'nowrap'}}>
                      {showWhatIf ? 'Hide' : 'Show'} what-if
                    </button>
                  </div>
                  {showWhatIf && (
                    <div style={{marginTop:6,display:'grid',gridTemplateColumns:'auto 1fr 1fr',gap:'3px 12px',
                      fontSize:11,fontFamily:'JetBrains Mono,monospace',alignItems:'baseline'}}>
                      <div style={{color:'#8b949e'}} />
                      <div style={{color:'#8b949e',textAlign:'right'}}>now</div>
                      <div style={{color:'#8b949e',textAlign:'right'}}>{altVol.short}</div>
                      {altVol.rows.flatMap((row, ix) => {
                        const moved = row.now !== row.alt;
                        return [
                          <div key={ix+'k'} style={{color:'#8b949e'}}>{row.k}</div>,
                          <div key={ix+'n'} style={{textAlign:'right',color:'#e6edf3'}}>{row.now}</div>,
                          <div key={ix+'a'} style={{textAlign:'right',color:moved?'#e3a008':'#484f58',
                            fontWeight:moved?600:400}}>{row.alt}</div>
                        ];
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          </InputSection>

          {/* Vol surface (45DTE only) */}
          {!is0 && (
            <InputSection
              title="Vol surface"
              info="Implied-vol surface inputs. IV drives EM45 and the strikes — a blank IV blocks the decision. IVR, HV, IV Front and IV Back have no bridge source and stay manual; IV and Skew can auto-fill from Fetch Greeks (per-leg model IVs)."
              missing={secMissing.vol}
              collapsed={isCollapsed('vol')}
              onToggle={() => toggleSection('vol')}
              onExpand={() => expandSection('vol')}>
              <div className="grid grid-cols-2 gap-2.5">
                <Inp label="IV Rank (%) — manual" value={i45.ivr} onChange={v=>set45('ivr',v)}/>
                <Inp label="IV (%)" {...mk('iv')} value={i45.iv} onChange={v=>set45('iv',v)}/>
                <Inp label="HV (%) — manual" value={i45.hv} onChange={v=>set45('hv',v)}/>
                <Inp label="IV Front — manual" value={i45.ivFront} onChange={v=>set45('ivFront',v)}/>
                <Inp label="IV Back — manual" value={i45.ivBack} onChange={v=>set45('ivBack',v)}/>
                <Inp label="Skew (%)" {...mk('skew')} value={i45.skew} onChange={v=>set45('skew',v)}/>
                <Sel label="Term bias" value={i45.termBias} onChange={v=>set45('termBias',v)} options={TERM_BIASES}/>
              </div>
            </InputSection>
          )}

          {/* Trade setup (45DTE only) */}
          {!is0 && (
            <InputSection
              title="Trade setup"
              info="Days to expiry and directional outlook — these steer strategy selection and the 21-DTE exit maths. DTE defaults to 45 when blank."
              collapsed={isCollapsed('setup')}
              onToggle={() => toggleSection('setup')}
              onExpand={() => expandSection('setup')}>
              <div className="grid grid-cols-2 gap-2.5">
                <Inp label="DTE" value={i45.dte} onChange={v=>set45('dte',v)}/>
                <Sel label="Outlook" value={i45.outlook} onChange={v=>set45('outlook',v)} options={OUTLOOKS}/>
              </div>
            </InputSection>
          )}

          {/* ES Overnight (0DTE only) */}
          {is0 && (
            <InputSection
              title={<>ES overnight{esContract && ` \u00b7 ${esContract}`}</>}
              info="ES futures data for overnight analysis. Prior Close = yesterday's 4pm settle. Pre-open = current ES price. Overnight High/Low = session range. ES EM = expected move for ES. Used for move consumed and continuation/reversal detection."
              collapsed={isCollapsed('es')}
              onToggle={() => toggleSection('es')}
              onExpand={() => expandSection('es')}>
              {i0.esDelayed && (
                <div style={{margin:'2px 0 8px',padding:'5px 9px',borderRadius:6,background:'#2d1a0d',border:'1px solid #5a3a1a',fontSize:11,color:'#e3a008',lineHeight:1.4}}>
                  ⚠ ES data is <b>delayed ~10 min</b> — no CME real-time subscription. Overnight range, move-consumed and continuation/reversal detection may be stale. Subscribe to CME Real-Time in IBKR for live ES.
                </div>
              )}
              <div className="grid grid-cols-2 gap-2.5">
                <Inp label={esPriorCloseLabel} {...mk('priorDayClose')} value={i0.priorDayClose} onChange={v=>set0('priorDayClose',v)}/>
                <Inp label={esPreOpenLabel} {...mk('esClose')} value={i0.esClose} onChange={v=>set0('esClose',v)}/>
                <Inp label="ES Overnight High" {...mk('esOvernightHigh')} value={i0.esOvernightHigh} onChange={v=>set0('esOvernightHigh',v)} bad={r.onSwapped}/>
                <Inp label="ES Overnight Low" {...mk('esOvernightLow')} value={i0.esOvernightLow} onChange={v=>set0('esOvernightLow',v)} bad={r.onSwapped}/>
                <Inp label="ES EM" {...mk('esEM')} value={i0.esEM} onChange={v=>set0('esEM',v)}/>
                <Inp label={i0.underlying + ' Open'} {...mk('cashOpen')} value={i0.cashOpen} onChange={v=>set0('cashOpen',v)}/>
              </div>
              {r.onSwapped && (
                <div style={{margin:'8px 0 0',padding:'5px 9px',borderRadius:6,background:'#3d1418',border:'1px solid #7d2b2b',fontSize:11,color:'#f85149',lineHeight:1.4}}>
                  ⚠ <b>High is below Low</b> — these two look swapped. Scoring has been corrected to a {(r.onHigh-r.onLow).toFixed(1)} pt range, but fix the inputs: an inverted range distorts move-consumed, the regime and the strategy pick.
                  <button type="button" onClick={()=>setI0(prev=>({...prev, esOvernightHigh:prev.esOvernightLow, esOvernightLow:prev.esOvernightHigh}))}
                    style={{marginLeft:8,padding:'1px 7px',borderRadius:4,border:'1px solid #7d2b2b',background:'#5a1e22',color:'#ffb4b4',cursor:'pointer'}}>Swap</button>
                </div>
              )}
            </InputSection>
          )}

          {/* Session & sizing */}
          <InputSection
            title={is0 ? 'Session & sizing' : 'Sizing'}
            info="Net credit/debit pre-fills from the engine's TARGET for this structure and is flagged as such until you change it — replace it with your broker's actual fill, because this is the number written to the trade log. Positive for credit, negative for debit. Label and box colour change automatically. POP = probability of profit (red if below breakeven POP). Win = max profit, Risk = max loss per contract (red if exceeds Kelly $). Credit/debit tape shows where your fill sits vs target range. Profit targets show TWS limit order values at 25/30/40/50/75/100%. Butterfly debit blocked above 55% of wing width."
            missing={secMissing.sizing}
            collapsed={isCollapsed('sizing')}
            onToggle={() => toggleSection('sizing')}
            onExpand={() => expandSection('sizing')}>
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="text-xs block mb-1" style={{ fontWeight: 600, color: (() => {
                const v = parseFloat(is0?i0.netCreditDebit:i45.netCreditDebit);
                const t = (!isNaN(v) && v !== 0) ? (v > 0 ? 'credit' : 'debit') : cashType;
                return t === 'credit' ? '#3fb950' : t === 'debit' ? '#f85149' : '#8b949e';
              })() }}>{(() => {
                const v = parseFloat(is0?i0.netCreditDebit:i45.netCreditDebit);
                const t = (!isNaN(v) && v !== 0) ? (v > 0 ? 'credit' : 'debit') : cashType;
                return t === 'credit' ? 'Net credit ($) — expected'
                  : t === 'debit' ? 'Net debit ($) — expected'
                  : 'Net credit/debit ($)';
              })()}{netIsTarget && (
                <span title="Pre-filled from the engine's target for this structure — not a fill. Overwrite it with your actual price; this number is logged."
                  style={{marginLeft:6,padding:'1px 6px',borderRadius:4,fontSize:9,fontWeight:700,
                    letterSpacing:'0.04em',background:'#3a2d00',color:'#e3b341',verticalAlign:'1px'}}>
                  TARGET — REPLACE WITH FILL
                </span>
              )}</label>
              <input type="number" step="any"
                value={is0?i0.netCreditDebit:i45.netCreditDebit}
                onChange={e=>is0?set0('netCreditDebit',e.target.value):set45('netCreditDebit',e.target.value)}
                placeholder="—"
                style={{
                  width:'100%', padding:'8px 12px', borderRadius:8, fontSize:14, fontFamily:'JetBrains Mono,monospace',
                  outline:'none', border:'1px solid',
                  borderColor: (is0?i0.netCreditDebit:i45.netCreditDebit)
                    ? (parseFloat(is0?i0.netCreditDebit:i45.netCreditDebit) > 0 ? '#238636' : parseFloat(is0?i0.netCreditDebit:i45.netCreditDebit) < 0 ? '#da3633' : '#30363d')
                    : '#30363d',
                  background: (is0?i0.netCreditDebit:i45.netCreditDebit)
                    ? (parseFloat(is0?i0.netCreditDebit:i45.netCreditDebit) > 0 ? '#0d2818' : parseFloat(is0?i0.netCreditDebit:i45.netCreditDebit) < 0 ? '#2d0f0f' : '#0d1117')
                    : '#0d1117',
                  color: (is0?i0.netCreditDebit:i45.netCreditDebit)
                    ? (parseFloat(is0?i0.netCreditDebit:i45.netCreditDebit) > 0 ? '#3fb950' : parseFloat(is0?i0.netCreditDebit:i45.netCreditDebit) < 0 ? '#f85149' : '#c9d1d9')
                    : '#c9d1d9'
                }}
              />
            </div>
            <div>
              <label className="text-xs text-text-muted block mb-1">POP (%)</label>
              <input type="number" step="any"
                value={is0?i0.pop:i45.pop}
                onChange={e=>is0?set0('pop',e.target.value):set45('pop',e.target.value)}
                placeholder="—"
                style={{
                  width:'100%', padding:'8px 12px', borderRadius:8, fontSize:14, fontFamily:'JetBrains Mono,monospace',
                  outline:'none', border:'1px solid',
                  borderColor: (() => {
                    const pop = parseFloat(is0?i0.pop:i45.pop) || 0;
                    const bePop = (r.bePop || 0) * 100;
                    if (!pop) return '#30363d';
                    return pop >= bePop ? '#238636' : '#da3633';
                  })(),
                  background: (() => {
                    const pop = parseFloat(is0?i0.pop:i45.pop) || 0;
                    const bePop = (r.bePop || 0) * 100;
                    if (!pop) return '#0d1117';
                    return pop >= bePop ? '#0d2818' : '#2d0f0f';
                  })(),
                  color: (() => {
                    const pop = parseFloat(is0?i0.pop:i45.pop) || 0;
                    const bePop = (r.bePop || 0) * 100;
                    if (!pop) return '#c9d1d9';
                    return pop >= bePop ? '#3fb950' : '#f85149';
                  })()
                }}
              />
              {r.bePop > 0 && <div style={{fontSize:9,color:'#8b949e',marginTop:2}}>Min POP: {(r.bePop*100).toFixed(1)}%</div>}
            </div>
            <div>
              <Inp label="Win amount ($)" value={is0?i0.win:i45.win} onChange={v=>is0?set0('win',v):set45('win',v)}/>
              <PrefillChip payoffVal={r.payoff?.maxProfit} fieldVal={is0?i0.win:i45.win}
                onFill={v=>is0?set0('win',v):set45('win',v)}/>
            </div>
            <div>
              <label className="text-xs text-text-muted block mb-1">Risk / contract ($)</label>
              <input type="number" step="any"
                value={is0?i0.risk:i45.risk}
                onChange={e=>is0?set0('risk',e.target.value):set45('risk',e.target.value)}
                placeholder="—"
                style={{
                  width:'100%', padding:'8px 12px', borderRadius:8, fontSize:14, fontFamily:'JetBrains Mono,monospace',
                  outline:'none', border:'1px solid',
                  borderColor: (() => {
                    const riskVal = parseFloat(is0?i0.risk:i45.risk) || 0;
                    const kellyDol = r.kellyDollar || 0;
                    if (!riskVal) return '#30363d';
                    return riskVal <= kellyDol ? '#238636' : '#da3633';
                  })(),
                  background: (() => {
                    const riskVal = parseFloat(is0?i0.risk:i45.risk) || 0;
                    const kellyDol = r.kellyDollar || 0;
                    if (!riskVal) return '#0d1117';
                    return riskVal <= kellyDol ? '#0d2818' : '#2d0f0f';
                  })(),
                  color: (() => {
                    const riskVal = parseFloat(is0?i0.risk:i45.risk) || 0;
                    const kellyDol = r.kellyDollar || 0;
                    if (!riskVal) return '#c9d1d9';
                    return riskVal <= kellyDol ? '#3fb950' : '#f85149';
                  })()
                }}
              />
              {r.kellyDollar > 0 && <div style={{fontSize:9,color:'#8b949e',marginTop:2}}>Adj Kelly $: {r.kellyDollar.toFixed(0)}</div>}
              <PrefillChip payoffVal={r.payoff?.maxLoss} fieldVal={is0?i0.risk:i45.risk}
                onFill={v=>is0?set0('risk',v):set45('risk',v)}/>
            </div>
          </div>
          {/* Risk budget — the account limits Kelly sizing is computed against.
              These fields have no inputs on the panel (they seed from the account
              config), so without this line the denominator was un-auditable. */}
          {(() => {
            const b = is0 ? i0 : i45;
            return (
              <div style={{marginTop:6,fontSize:11,color:'#8b949e',lineHeight:1.5}}>
                <span onClick={()=>setShowRiskBudget(v=>!v)} style={{cursor:'pointer',userSelect:'none'}}
                  title="What Kelly sizing is computed against — click to expand">
                  {showRiskBudget ? '▾' : '▸'} Risk budget: bankroll ${fv(b,'bankroll').toFixed(0)} · max loss/trade ${fv(b,'maxLoss').toFixed(0)} · max open ${fv(b,'maxOpen').toFixed(0)}
                </span>
                {showRiskBudget && (
                  <div style={{marginTop:2,paddingLeft:14,color:'#6e7681'}}>
                    Start-of-day bankroll ${fv(b,'startBR').toFixed(0)} · account {acfg.id || 'default'} — seeded from account settings
                    (bankroll / max daily loss / max open risk). Adj Kelly $ and the contract cap are computed against these numbers.
                  </div>
                )}
              </div>
            );
          })()}
          {r.targetMax > 0 && (() => {
            const ncdVal = parseFloat(is0?i0.netCreditDebit:i45.netCreditDebit) || 0;
            const actualIsCredit = ncdVal >= 0;
            return <CreditTape
              value={Math.abs(ncdVal)}
              low={r.targetLow}
              high={r.targetHigh}
              max={r.targetMax}
              isCredit={actualIsCredit}
              label={r.targetLabel}
            />;
          })()}
          {r.targetLabel && !r.targetMax && <div style={{fontSize:11,color:'#8b949e',marginTop:4,fontStyle:'italic'}}>{r.targetLabel}</div>}
          {is0 && (
            <div className="grid grid-cols-2 gap-2.5 mt-2">
              <div>
                <label className="text-xs text-text-muted block mb-1">Hours remaining</label>
                <input type="number" step="0.1"
                  value={i0.hours}
                  onChange={e=>set0('hours',e.target.value)}
                  style={{
                    width:'100%', padding:'8px 12px', borderRadius:8, fontSize:14,
                    fontFamily:'JetBrains Mono,monospace', outline:'none',
                    border:'1px solid #30363d', background:'#0d1117', color:'#c9d1d9'
                  }}
                />
                <div style={{fontSize:9,color:'#484f58',marginTop:2}}>Auto: 3pm ET minus current time</div>
              </div>
            </div>
          )}

          {/* Profit target scale */}
          {(parseFloat(is0?i0.netCreditDebit:i45.netCreditDebit) || 0) !== 0 && (
            <ProfitScale netCreditDebit={parseFloat(is0?i0.netCreditDebit:i45.netCreditDebit)} isCredit={parseFloat(is0?i0.netCreditDebit:i45.netCreditDebit) > 0} win={parseFloat(is0?i0.win:i45.win) || 0} />
          )}

          </InputSection>

          {/* Greeks & tail risk */}
          <InputSection
            title="Greeks & tail risk"
            info="Enter from your broker's position Greeks, or fetch live from TWS. Theta = daily dollar decay, SIGNED: positive if the position collects decay, negative if it pays it (a long butterfly or debit spread before the body is reached). Fetching from TWS fills the sign for you; entering by hand, keep the minus sign - the survivability read inverts on it. Delta = price sensitivity. Gamma = delta acceleration. Gamma strike = price where gamma is highest (pin magnet). Used for trade survivability analysis (Directional Edge). UNITS: Theta, Delta, Gamma and Vega are POSITION-level (per-share greek x contracts x 100), so Delta 4.68 means the position gains $4.68 per 1 point of underlying. Wing |Δ| below is the opposite — a PER-SHARE delta between 0 and 1. Two different scales, and TWS fills both correctly; a position delta near 5 alongside a wing delta near 0.2 is not an import error. Wing |Δ|: enter the absolute delta of the lowest- and highest-strike long legs (put OR call — the engine converts each by its right) for the skew-aware P(max loss) cross-check. All Greeks are optional — nothing here blocks the decision."
            collapsed={isCollapsed('greeks')}
            onToggle={() => toggleSection('greeks')}
            onExpand={() => expandSection('greeks')}
            actions={<>
              {greeksFresh && (() => {
                const rt = greeksFresh.dataType === 'realtime';
                const dl = greeksFresh.dataType === 'delayed';
                const age = greeksFresh.asOf ? Math.max(0, Math.round((Date.now() - new Date(greeksFresh.asOf).getTime()) / 1000)) : null;
                const txt = rt ? 'REAL-TIME' : dl ? 'DELAYED ~15m' : greeksFresh.dataType === 'frozen' ? 'FROZEN' : (greeksFresh.label || '—').toUpperCase();
                const ageTxt = age == null ? '' : age < 60 ? ' \u00b7 ' + age + 's ago' : ' \u00b7 ' + Math.round(age/60) + 'm ago';
                // Net greeks are only a valid sum when every leg came off the same
                // computation. Amber the badge and name the source when they did not.
                const mixed = !!greeksFresh.greeksMixed;
                const srcTxt = mixed ? ' \u00b7 ' + String(greeksFresh.greekSource || 'non-model').toUpperCase() : '';
                return <span title={(greeksFresh.label || '') + (greeksFresh.undPrice ? ' \u00b7 model px ' + greeksFresh.undPrice : '')
                    + (mixed ? ' \u00b7 not model greeks: legs served by ' + greeksFresh.greekSource + ' computation, so the net sum is unreliable - refetch' : '')}
                  style={{fontSize:10,fontWeight:700,letterSpacing:'0.04em',padding:'2px 8px',borderRadius:4,
                    background: mixed ? '#2d1e0a' : rt ? '#0d2818' : '#161b22',
                    color: mixed ? '#e3a008' : rt ? '#3fb950' : dl ? '#e3a008' : '#8b949e',
                    border: '1px solid ' + (mixed ? '#9e6a03' : rt ? '#238636' : '#30363d')}}>{txt}{ageTxt}{srcTxt}</span>;
              })()}
              <button onClick={handleFetchGreeks} disabled={fetchingGreeks}
                title="Pull fresh model Greeks + underlying price for the current strikes — use right before entry"
                style={{padding:'3px 10px',borderRadius:6,border:'1px solid #30363d',background:fetchingGreeks?'#161b22':'transparent',color:fetchingGreeks?'#8b949e':'#2f81f7',fontSize:11,fontWeight:600,cursor:'pointer'}}>
                {fetchingGreeks ? 'Fetching…' : '🔄 Refresh (live)'}
              </button>
            </>}>
          <div className="grid grid-cols-2 gap-2.5">
            {is0 ? <>
              <Inp label="Theta ($/day, position)" value={i0.theta} onChange={v=>set0('theta',v)}/>
              <Inp label="Delta ($ per 1 pt, position)" value={i0.delta} onChange={v=>set0('delta',v)}/>
              <Inp label="Gamma (Δ$ per 1 pt, position)" value={i0.gamma} onChange={v=>set0('gamma',v)}/>
              <Inp label="Gamma strike" value={i0.gamStrike} onChange={v=>set0('gamStrike',v)}/>
              <Inp label="Lower wing |Δ| (lowest strike)" value={i0.lowerWingDelta} onChange={v=>set0('lowerWingDelta',v)}/>
              <Inp label="Upper wing |Δ| (highest strike)" value={i0.upperWingDelta} onChange={v=>set0('upperWingDelta',v)}/>
            </> : <>
              <Inp label="Theta ($/day, position)" value={i45.theta} onChange={v=>set45('theta',v)}/>
              <Inp label="Vega ($ per 1 vol pt, position)" value={i45.vega} onChange={v=>set45('vega',v)}/>
              <Inp label="Delta ($ per 1 pt, position)" value={i45.delta} onChange={v=>set45('delta',v)}/>
              {!is0 && <Inp label="BPR ($)" value={i45.bpr} onChange={v=>set45('bpr',v)}/>}
              <Inp label="Lower wing |Δ| (lowest strike)" value={i45.lowerWingDelta} onChange={v=>set45('lowerWingDelta',v)}/>
              <Inp label="Upper wing |Δ| (highest strike)" value={i45.upperWingDelta} onChange={v=>set45('upperWingDelta',v)}/>
            </>}
          </div>
          {r.pMaxLoss != null && (
            <div style={{marginTop:8,padding:'10px 12px',borderRadius:8,background:'#0d1117',border:'1px solid #21262d',fontSize:13,lineHeight:1.5,color:'#c9d1d9'}}>
              <span style={{color:'#fff',fontWeight:700,fontSize:14}}>P(max loss): {(r.pMaxLoss*100).toFixed(1)}%</span>
              <span style={{marginLeft:8,padding:'2px 7px',borderRadius:4,fontSize:10,fontWeight:600,
                background: r.pMaxLossSource==='blend'?'#0d2818':r.pMaxLossSource==='delta'?'#1f1a0d':'#161b22',
                color: r.pMaxLossSource==='blend'?'#3fb950':r.pMaxLossSource==='delta'?'#d29922':'#8b949e'}}>
                {r.pMaxLossSource==='blend'?'MODEL + DELTA':r.pMaxLossSource==='delta'?'DELTA (skew)':'MODEL (flat vol)'}
              </span>
              <div style={{marginTop:6,color:'#e6edf3'}}>
                {r.pMaxLossModel!=null && <>Model {(r.pMaxLossModel*100).toFixed(1)}% ({is0?'VIX1D':`${i45.dte||45}d IV`}, flat)</>}
                {r.pMaxLossDelta!=null && <> · Delta {(r.pMaxLossDelta*100).toFixed(1)}% (real IV + skew)</>}
                {r.pMaxLossDelta==null && <> · enter |Δ| of each outer long leg above (put or call — the engine converts by right) for the skew-aware cross-check</>}
              </div>
              {r.pMaxLossLow!=null && r.pMaxLossHigh!=null && (
                <div style={{marginTop:3,color:'#8b949e'}}>Down tail {(r.pMaxLossLow*100).toFixed(1)}% · Up tail {(r.pMaxLossHigh*100).toFixed(1)}%</div>
              )}
            </div>
          )}
          </InputSection>
        </div>

        {/* ── RESULTS PANEL ── */}
        <div className="space-y-4" style={{maxHeight:'calc(100vh - 360px)',overflowY:'auto'}}>
          {/* Setup quality — weighted bar + points-lost list (full rows collapsible) */}
          <SetupQualityCard r={r} sBg={sBg} sClr={sClr} />

          {/* Strategy ratings */}
          <div className="card">
            <div className="flex items-center justify-between mb-1">
              <SectionLabel white info="Each strategy rated EXCELLENT, GOOD, MARGINAL, or POOR based on current regime, direction strength, and move consumed. Every row is clickable - including POOR - so you can override the engine and push any structure through; the rating stays on the ticket as information, not as a gate. BWB preferred for strong direction, Asymmetric for mild, Standard butterfly for neutral.">Strategy ratings — {r.regime}</SectionLabel>
              {isOverride && <span style={{fontSize:10,color:'#d29922'}}>Override active</span>}
            </div>
            {r.runnerUp && !isOverride && (
              <div style={{fontSize:11,color:'#8b949e',marginBottom:6,lineHeight:1.5}}>
                {r.tiebreakApplied ? <>Tiebreak: chose <b style={{color:'#c9d1d9'}}>{r.bestStrat}</b> over </> : <>Also {r.runnerUp.rating.toLowerCase()}: </>}
                <span onClick={()=>setOverrideStrat(r.runnerUp.name)} title="Switch to this structure"
                  style={{color:'#58a6ff',cursor:'pointer',textDecoration:'underline'}}>{r.runnerUp.name}</span>
                {r.tiebreakApplied ? <> (closer regime fit) · click to switch</> : <> · click to switch</>}
              </div>
            )}
            <div className="space-y-0.5">
              {r.ratings.map((s,i) => {
                const cls = s.rating==='EXCELLENT'?'badge-green':s.rating==='GOOD'?'badge-blue':s.rating==='MARGINAL'?'badge-amber':'badge-red';
                // Every strategy is selectable, POOR included. The rating is
                // information about the structure, not permission to trade it -
                // a discretionary ticket can always be pushed through and logged
                // against its real rating. (Jul 2026.)
                const clickable = true;
                const isSelected = overrideStrat === s.name;
                return (<div key={i}
                  onClick={() => { if (clickable) setOverrideStrat(isSelected ? null : s.name); }}
                  className={`flex items-center justify-between py-1.5 rounded px-1 -mx-1 transition-colors ${clickable ? 'cursor-pointer hover:bg-[#161b22]' : 'opacity-50'} ${isSelected ? 'bg-[#1f1a0d] ring-1 ring-[#9e6a03]' : ''}`}>
                  <span className="text-sm text-white">{s.name}
                    {(() => {
                      const ct = resolveCashType(s.name, null);
                      const t = ct === 'credit' ? 'CR' : ct === 'debit' ? 'DR' : 'CR/DR';
                      const c = ct === 'credit' ? '#3fb950' : ct === 'debit' ? '#e3a008' : '#6e7681';
                      return <span title={ct==='credit'?'Credit — collect premium':ct==='debit'?'Debit — pay premium':'Credit or debit'}
                        style={{marginLeft:6,fontSize:9,fontWeight:700,color:c,letterSpacing:'0.03em'}}>{t}</span>;
                    })()}
                  </span>
                  <div className="flex items-center gap-2">
                    {isSelected && <span style={{fontSize:9,color:'#d29922',fontWeight:600}}>SELECTED</span>}
                    <span className={`badge text-[10px] ${cls}`}>{s.rating}</span>
                  </div>
                </div>);
              })}
            </div>
          </div>

          {/* Structure comparison — current pick vs the next-best rated structures,
              each a FULL engine re-run on the same inputs (the calc is pure). */}
          {stratCompare && stratCompare.length > 1 && (
            <div className="card">
              <SectionLabel white info="Side-by-side FULL engine runs for the top structures on the SAME market inputs — only the strategy differs. Composite, EV, P(max loss) and Kelly are complete engine outputs, not the rating shortcut. Net cr/dr is the engine's TARGET fill for that structure. Click a column header to open that structure in its OWN tab, carrying this ticket's market data, vol and greeks — only Session & sizing is cleared, because max profit, max loss, POP and your fill belong to the legs you were looking at. This ticket is left exactly as it is, so both stay on screen.">Structure comparison</SectionLabel>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr>
                      <th className="text-left py-1.5 px-1"></th>
                      {stratCompare.map((c, i) => (
                        <th key={i} onClick={() => { if (!c.current) openStructureInTab(c.name); }}
                          title={c.current ? 'Selected structure' : 'Open this structure in its own tab \u2014 same market data, sizing cleared'}
                          className="text-center py-1.5 px-2 cursor-pointer hover:bg-[#161b22]"
                          style={{minWidth:104,borderRadius:6}}>
                          <div style={{fontSize:11,fontWeight:700,color:c.current?'#fff':'#c9d1d9'}}>{c.name}</div>
                          <div style={{fontSize:8,fontWeight:600,marginTop:1,letterSpacing:'0.04em',
                            color: c.current ? (isOverride ? '#d29922' : '#3fb950') : '#6e7681'}}>
                            {c.current ? (isOverride ? '✓ OVERRIDE' : '✓ ENGINE PICK') : c.rating}
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { label: 'Composite', render: c => { const s = compositeScoreOf(c.res);
                          const col = s>=75?'#3fb950':s>=55?'#7bc74d':s>=35?'#d29922':'#f85149';
                          return <span style={{color:col,fontWeight:700}}>{s}/100</span>; } },
                      { label: 'EV / trade', render: c => c.res.ev
                          ? <span style={{color: c.res.ev>0?'#3fb950':'#f85149'}}>${c.res.ev.toFixed(0)}</span>
                          : '--' },
                      { label: 'P(max loss)', render: c => c.res.pMaxLoss != null
                          ? <span style={{color: c.res.pMaxLoss<=0.15?'#3fb950':c.res.pMaxLoss<=0.30?'#d29922':'#f85149'}}>{(c.res.pMaxLoss*100).toFixed(1)}%</span>
                          : '--' },
                      { label: 'Net cr/dr (target)', render: c => c.res.targetCredit != null
                          ? <span style={{color: c.res.targetCredit>=0?'#3fb950':'#e3a008'}}>{c.res.targetCredit>=0?'cr':'dr'} ${Math.abs(c.res.targetCredit).toFixed(2)}</span>
                          : '--' },
                      { label: 'Breakevens', render: c => c.res.payoff?.breakevens?.length
                          ? c.res.payoff.breakevens.map(b=>b.toFixed(0)).join(' / ')
                          : '--' },
                      { label: 'Kelly', render: c =>
                          <span style={{color: c.res.kellyOverRisk?'#f85149':'#e6edf3'}}>{c.res.contracts}x · ${c.res.kellyDollar?.toFixed(0)||0}</span> },
                    ].map((row, ri) => (
                      <tr key={ri} className="border-t border-[#21262d]">
                        <td className="py-1.5 px-1 text-[#8b949e]">{row.label}</td>
                        {stratCompare.map((c, i) => (
                          <td key={i} className="py-1.5 px-2 text-center mono">{row.render(c)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Payoff diagram — full width */}
          {r.payoff && r.payoff.points.length > 0 && (
            <div className="card">
              <SectionLabel white info="P&L diagram at expiration across price range. Green zone = profit, red zone = loss. White line = payoff curve. Blue dashed = current price. Yellow dots = breakeven prices. Calculated from leg structure and net credit/debit entered.">Payoff at expiry</SectionLabel>
              <PayoffDiagram payoff={r.payoff} currentPrice={is0?fv(i0,'price'):fv(i45,'price')} />
              <div className="grid grid-cols-2 gap-1.5 mt-3">
                <KV label="Max profit" value={'$' + (r.payoff.maxProfit?.toFixed(0)||0)} cls="text-green"/>
                <KV label="Max loss" value={'$' + (r.payoff.maxLoss?.toFixed(0)||0)} cls="text-red"/>
                <KV label="Breakeven(s)" value={r.payoff.breakevens?.map(b=>b.toFixed(1)).join(', ')||'--'}/>
                <KV label="Profit band" value={r.payoff.profitBandWidth>0?(r.payoff.profitBandLow.toFixed(0)+'\u2013'+r.payoff.profitBandHigh.toFixed(0)+' ('+r.payoff.profitBandWidth.toFixed(0)+' pts)'):'--'}/>
              </div>
            </div>
          )}

          {/* Sharpe-adjusted Kelly sizing */}
          <div className="card">
            <SectionLabel white info="Position sizing using 4-factor adjusted Kelly: Raw Kelly × Vol Factor (VIX level) × Sharpe Factor (EV/risk edge) × Strategy Modifier (tail risk per strategy). Vol Factor: VIX <12 = 1.0, 12-18 = 0.75, 18-25 = 0.50, >25 = 0.25. Sharpe Factor: based on EV/risk ratio. Strategy Modifier: butterflies 1.0, IC/credit spreads 0.85, BWB 0.80, reversed condor 0.70. Adj Kelly $ = max recommended risk. Risk per contract turns red if it exceeds Kelly $. POP turns red if below breakeven POP.">Sizing (Sharpe-adjusted Kelly)</SectionLabel>
            <div className="grid grid-cols-2 gap-1.5 mb-3">
              <KV label="Contracts" value={r.contracts}/>
              <KV label="Adj Kelly $" value={`$${r.kellyDollar?.toFixed(0)||0}`} cls={r.kellyOverRisk?'text-red':'text-green'}/>
              <KV label="Raw Kelly" value={`${(r.rawKelly*100).toFixed(1)}%`}/>
              <KV label="Adjusted Kelly" value={`${(r.adjustedKelly*100).toFixed(1)}%`} cls={r.adjustedKelly<r.rawKelly?'text-amber':''}/>
            </div>
            <div className="space-y-3">
              <SpeedTape label="Vol factor" value={r.volFactor||0} min={0} max={1}
                zones={[{to:0.25,color:'#f85149'},{to:0.50,color:'#d29922'},{to:0.75,color:'#e3b341'},{to:1.0,color:'#3fb950'}]}
                display={r.volFactor?.toFixed(2)||'--'}
                sublabel={r.volFactor>=1?'VIX <12':r.volFactor>=0.75?'VIX 12-18':r.volFactor>=0.50?'VIX 18-25':'VIX >25'} />
              <SpeedTape label="Sharpe factor" value={r.sharpeFactor||0} min={0} max={1}
                zones={[{to:0.25,color:'#f85149'},{to:0.50,color:'#d29922'},{to:0.75,color:'#e3b341'},{to:1.0,color:'#3fb950'}]}
                display={`${r.sharpeFactor?.toFixed(2)||'--'} (${r.sharpeProxy?.toFixed(2)||'--'})`}
                sublabel={r.sharpeProxy>0.30?'Strong edge':r.sharpeProxy>0.15?'Decent edge':r.sharpeProxy>0.05?'Marginal edge':r.sharpeProxy>0?'Weak edge':'Negative EV'} />
              <SpeedTape label="Strategy modifier" value={r.stratModifier||1} min={0.5} max={1}
                zones={[{to:0.70,color:'#f85149'},{to:0.85,color:'#d29922'},{to:0.95,color:'#e3b341'},{to:1.0,color:'#3fb950'}]}
                display={`${r.stratModifier?.toFixed(2)||'--'}`}
                sublabel={r.stratModReason||''} />
              <SpeedTape label="POP margin" value={Math.min(r.popMargin||0, 2.5)} min={0} max={2.5}
                zones={[{to:0.8,color:'#f85149'},{to:1.0,color:'#d29922'},{to:1.5,color:'#e3b341'},{to:2.5,color:'#3fb950'}]}
                display={r.popMargin?`${r.popMargin.toFixed(2)}x`:'--'}
                sublabel={r.popMargin>=1.5?'Strong':r.popMargin>=1.0?'Breakeven+':'Below breakeven'} />
              <SpeedTape label="EV / trade" value={Math.max(Math.min(r.ev||0, 500), -200)} min={-200} max={500}
                zones={[{to:-50,color:'#f85149'},{to:0,color:'#d29922'},{to:100,color:'#e3b341'},{to:500,color:'#3fb950'}]}
                display={r.ev?`$${r.ev.toFixed(0)}`:'--'}
                sublabel={(r.evBasis?.mode==='measured'
                  ? `Measured · ${r.evBasis.historyTrades} trades`
                  : `Est. · ${r.evBasis?.historyTrades||0}/${r.evBasis?.threshold||50}`)
                  + (r.ev>100?' · Excellent':r.ev>50?' · Good':r.ev>0?' · Marginal':' · No edge')} />
              {r.evBasis && (
                <div style={{fontSize:'13px',lineHeight:'1.5',color:'#e6edf3',margin:'4px 0 12px',paddingLeft:'2px',whiteSpace:'normal'}}>
                  {r.evBasis.mode==='measured'
                    ? `EV from realized history: ${(r.evBasis.winP*100).toFixed(0)}% × $${r.evBasis.avgWin.toFixed(0)} − ${((1-r.evBasis.winP)*100).toFixed(0)}% × $${r.evBasis.avgLoss.toFixed(0)}`
                    : `EV estimated (capture ${(r.evBasis.winCap*100).toFixed(0)}%/${(r.evBasis.lossCap*100).toFixed(0)}% of max): ${(r.evBasis.winP*100).toFixed(0)}% × $${r.evBasis.avgWin.toFixed(0)} − ${((1-r.evBasis.winP)*100).toFixed(0)}% × $${r.evBasis.avgLoss.toFixed(0)}`}
                  {r.evBasis.pMaxLoss != null && (
                    <div style={{marginTop:4,color:'#c9d1d9'}}>
                      P(max loss) used in sizing: <b style={{color:'#fff'}}>{(r.evBasis.pMaxLoss*100).toFixed(1)}%</b>
                      <span style={{marginLeft:5,fontSize:10,fontWeight:600,color:r.evBasis.pMaxLossSource==='blend'?'#3fb950':r.evBasis.pMaxLossSource==='delta'?'#d29922':'#8b949e'}}>
                        ({r.evBasis.pMaxLossSource==='blend'?'model+delta':r.evBasis.pMaxLossSource==='delta'?'delta/skew':'model'})
                      </span>
                    </div>
                  )}
                  {r.evBasis.winBreakeven != null && (
                    <div style={{marginTop:2,color:'#c9d1d9'}}>
                      Win needed for EV = 0: <b style={{color: r.ev>=0 ? '#3fb950' : '#e3a008'}}>${r.evBasis.winBreakeven}</b>
                      {r.ev < 0 && r.evBasis.maxWin>0 && <span style={{color:'#8b949e',fontSize:11}}> (currently ${r.evBasis.maxWin.toFixed(0)} max — need +${Math.max(0, r.evBasis.winBreakeven - r.evBasis.maxWin)})</span>}
                    </div>
                  )}
                </div>
              )}
              <SpeedTape label="W/L ratio" value={Math.min(r.wlRatio||0, 3)} min={0} max={3}
                zones={[{to:0.5,color:'#f85149'},{to:1.0,color:'#d29922'},{to:1.5,color:'#e3b341'},{to:3.0,color:'#3fb950'}]}
                display={r.wlRatio?.toFixed(2)||'--'}
                sublabel={r.wlRatio>=1.5?'Wins dominate':r.wlRatio>=1.0?'Balanced':r.wlRatio>=0.5?'POP compensates':'Check sizing'} />
            </div>
            <div className="grid grid-cols-2 gap-1.5 mt-3" style={{paddingTop:8,borderTop:'1px solid #21262d'}}>
              <KV label="BE POP" value={r.bePop?`${(r.bePop*100).toFixed(1)}%`:'--'}/>
              <KV label="Max risk" value={r.maxRisk?`$${r.maxRisk.toFixed(0)}`:'--'}/>
            </div>
          </div>

          {/* Directional Edge prompt — always visible so the feature is discoverable */}
          {!r.greeks && (
            <div className="card" style={{borderStyle:'dashed',borderColor:'#30363d'}}>
              <div className="flex items-center justify-between mb-1">
                <SectionLabel white info="Directional Edge compares how much price movement can still benefit the position (delta × remaining expected move) against remaining time decay (theta pressure). Enter Greeks — or fetch them from TWS — to unlock the survivability gauges and Edge Ratio.">Trade survivability · Directional Edge</SectionLabel>
              </div>
              <div style={{fontSize:12,color:'#8b949e',lineHeight:1.5}}>
                Enter <span style={{color:'#c9d1d9'}}>Delta</span> and <span style={{color:'#c9d1d9'}}>Theta</span>{is0 && <> (and optionally Gamma)</>} above to compute Directional Edge — the metric that tells you whether expected price movement still outweighs time decay.
                <button onClick={handleFetchGreeks} disabled={fetchingGreeks}
                  style={{marginLeft:8,padding:'2px 8px',borderRadius:5,border:'1px solid #30363d',background:'transparent',color:'#2f81f7',fontSize:11,fontWeight:600,cursor:'pointer'}}>
                  {fetchingGreeks ? 'Fetching…' : '⚡ Fetch from TWS'}
                </button>
              </div>
            </div>
          )}

          {/* Greeks Analysis — Theta Edge, Gamma Risk, Max Move */}
          {is0 && r.greeks && (
            <div className="card">
              <div className="flex items-center justify-between mb-2">
                <SectionLabel white info="Three survivability gauges plus Directional Edge. Theta Edge = theta earned per unit of directional risk (0.15-0.40 sweet spot). Gamma Risk = how fast delta changes vs theta (< 0.70 safe). Max Tolerable Move = furthest price can move before theta consumed. Directional Edge = remaining expected move × delta vs remaining theta. For credit strategies, lower Edge Ratio is better (theta dominates). For debit strategies, higher is better (move dominates). Butterfly strategies transition through three phases: Approach (need movement to body), Transition (balanced), Collection (theta collecting). Thresholds tighten through the day as gamma accelerates. SIGNED THETA: if the position PAYS decay (negative theta - a long butterfly before the body is reached, a debit spread) every gauge inverts. Theta Edge becomes Decay Cost and small is good, Gamma Risk becomes Gamma Offset and large is good, Max Tolerable Move disappears because there is no theta cushion to consume, and Edge Ratio wants to be HIGH whatever the strategy name says - only the move can pay the decay bill.">Trade survivability</SectionLabel>
                {r.greeks.sweetSpot && <span style={{fontSize:10,fontWeight:600,padding:'2px 8px',borderRadius:4,background:'#0d1f0d',color:'#3fb950'}}>🎯 SWEET SPOT</span>}
              </div>
              <div className="space-y-3">
                {/* Both gauges invert when the position PAYS decay: a small theta ratio
                    means time is cheap rather than that theta cannot defend you, and gamma
                    is the compensation you bought rather than the thing that kills you. Same
                    numbers, mirrored colour zones, renamed labels. (Jul 2026.) */}
                <SpeedTape label={r.greeks.thetaPaid ? 'Decay cost (|Θ| ÷ |Δ| × ATR)' : 'Theta Edge (Θ ÷ |Δ| × ATR)'} value={Math.min(r.greeks.tEdge, 0.6)} min={0} max={0.6}
                  zones={r.greeks.thetaPaid
                    ? [{to:0.05,color:'#3fb950'},{to:0.15,color:'#e3b341'},{to:0.30,color:'#d29922'},{to:0.6,color:'#f85149'}]
                    : [{to:0.05,color:'#f85149'},{to:0.15,color:'#d29922'},{to:0.30,color:'#e3b341'},{to:0.6,color:'#3fb950'}]}
                  display={r.greeks.tEdge.toFixed(3)}
                  sublabel={r.greeks.tEdgeSignal + ' — ' + r.greeks.tEdgeAction} />
                <SpeedTape label={r.greeks.thetaPaid ? 'Gamma offset (Γ × ATR ÷ |Θ|)' : 'Gamma Risk (Γ × ATR ÷ Θ)'} value={Math.min(r.greeks.gRisk, 1.5)} min={0} max={1.5}
                  zones={r.greeks.thetaPaid
                    ? [{to:0.30,color:'#f85149'},{to:0.70,color:'#d29922'},{to:1.20,color:'#e3b341'},{to:1.5,color:'#3fb950'}]
                    : [{to:0.30,color:'#3fb950'},{to:0.70,color:'#e3b341'},{to:1.20,color:'#d29922'},{to:1.5,color:'#f85149'}]}
                  display={r.greeks.gRisk.toFixed(3)}
                  sublabel={r.greeks.gRiskSignal + ' — ' + r.greeks.gRiskAction} />
                {r.greeks.thetaPaid ? (
                  <div className="text-[10px] text-[#8b949e]" style={{padding:'6px 8px',borderRadius:4,background:'#0d1117',border:'1px solid #21262d'}}>
                    <b style={{color:'#e3a008'}}>Position pays decay</b> · {r.greeks.dsAction}
                  </div>
                ) : (
                <SpeedTape label="Max tolerable move (ΔS_max)" value={Math.min(r.greeks.dsATR * 100, 200)} min={0} max={200}
                  zones={[{to:25,color:'#f85149'},{to:50,color:'#d29922'},{to:100,color:'#e3b341'},{to:200,color:'#3fb950'}]}
                  display={`${r.greeks.dsMax.toFixed(1)} pts (${(r.greeks.dsATR*100).toFixed(0)}% ATR)`}
                  sublabel={r.greeks.dsSignal + ' — ' + r.greeks.dsAction} />
                )}

                {/* Directional Edge */}
                {r.greeks.edgeRatio !== undefined && (
                  <div style={{marginTop:12,paddingTop:10,borderTop:'1px solid #21262d'}}>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs text-white font-semibold">Directional Edge</span>
                      <span className="text-[10px] px-2 py-0.5 rounded font-semibold" style={{
                        background: r.greeks.edgeSignal==='excellent'?'#0d2818':r.greeks.edgeSignal==='good'?'#0d1a0d':r.greeks.edgeSignal==='marginal'?'#1f1a0d':'#1f0d0d',
                        color: r.greeks.edgeSignal==='excellent'?'#3fb950':r.greeks.edgeSignal==='good'?'#7bc74d':r.greeks.edgeSignal==='marginal'?'#d29922':'#f85149'
                      }}>{r.greeks.edgePhase}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 mb-2">
                      <div className="text-center p-2 rounded" style={{background:'#0d1117'}}>
                        <div className="text-[9px] text-[#8b949e]">Directional $</div>
                        <div className="mono text-sm font-bold text-white">${r.greeks.directionalGain?.toFixed(0)}</div>
                        <div className="text-[8px] text-[#484f58]">{r.greeks.remainingMove?.toFixed(1)} pts left</div>
                      </div>
                      <div className="text-center p-2 rounded" style={{background:'#0d1117'}}>
                        <div className="text-[9px] text-[#8b949e]">{r.greeks.thetaPaid ? 'Decay $ paid' : 'Theta $'}</div>
                        <div className="mono text-sm font-bold" style={{color: r.greeks.thetaPaid ? '#e3a008' : '#fff'}}>{r.greeks.thetaPaid ? '-' : ''}${r.greeks.thetaPressure?.toFixed(0)}</div>
                        <div className="text-[8px] text-[#484f58]">to planned exit</div>
                      </div>
                      <div className="text-center p-2 rounded" style={{background: r.greeks.edgeSignal==='excellent'?'#0d2818':r.greeks.edgeSignal==='good'?'#0d1a0d':r.greeks.edgeSignal==='marginal'?'#1f1a0d':'#1f0d0d'}}>
                        <div className="text-[9px] text-[#8b949e]">Edge Ratio</div>
                        <div className="mono text-lg font-bold" style={{color: r.greeks.edgeSignal==='excellent'?'#3fb950':r.greeks.edgeSignal==='good'?'#7bc74d':r.greeks.edgeSignal==='marginal'?'#d29922':'#f85149'}}>{r.greeks.edgeRatio?.toFixed(2)}</div>
                      </div>
                    </div>
                    {/* A position paying decay always wants the move to dominate, whatever
                        its strategy label says - so it takes the higher-is-better zones. */}
                    <SpeedTape label="Move / Theta" value={Math.min(r.greeks.edgeRatio, 4)} min={0} max={4}
                      zones={r.greeks.isCreditStrat && !r.greeks.thetaPaid
                        ? [{to:0.7,color:'#3fb950'},{to:1.0,color:'#e3b341'},{to:1.5,color:'#d29922'},{to:4,color:'#f85149'}]
                        : [{to:0.7,color:'#f85149'},{to:1.0,color:'#d29922'},{to:1.5,color:'#e3b341'},{to:4,color:'#3fb950'}]
                      }
                      display={r.greeks.edgeRatio?.toFixed(2)}
                      sublabel={r.greeks.edgeAction} />
                    <div className="text-[9px] text-[#484f58] mt-1">Time threshold: {r.greeks.edgeThreshold?.toFixed(1)} | {r.greeks.thetaPaid ? 'Paying decay: higher = better' : r.greeks.isCreditStrat ? 'Credit: lower = better' : r.greeks.isBflyCondor ? 'Butterfly: transitions through phases' : 'Debit: higher = better'}</div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 45DTE Directional Edge */}
          {!is0 && r.greeks && r.greeks.edgeRatio !== undefined && (
            <div className="card">
              <SectionLabel white info="Directional Edge for 45DTE trades. Compares expected directional P&L (delta × remaining expected move) against total theta earned over the holding period to 21 DTE exit. Remaining EM = price × IV × √(remaining DTE / 365). Credit sellers (IC, spreads): want Edge Ratio < 0.5 (theta strongly dominates over the holding period). Debit directional (bull call, calendars): want Edge Ratio > 2.0 (move potential exceeds decay). Theta efficiency = daily theta as % of buying power reduction. Vega/Theta = IV sensitivity per unit of decay — high ratio means IV changes matter more than time. If theta is NEGATIVE the position pays decay over the hold, and the Edge Ratio wants to be high regardless of strategy class — only the move can cover the bill.">Directional Edge (45DTE)</SectionLabel>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-[#8b949e]">Holding: {r.greeks.daysToExit} days to 21 DTE exit | Remaining EM: {r.greeks.remainingEM?.toFixed(1)} pts</span>
                <span className="text-[10px] px-2 py-0.5 rounded font-semibold" style={{
                  background: r.greeks.edgeSignal==='excellent'?'#0d2818':r.greeks.edgeSignal==='good'?'#0d1a0d':r.greeks.edgeSignal==='marginal'?'#1f1a0d':'#1f0d0d',
                  color: r.greeks.edgeSignal==='excellent'?'#3fb950':r.greeks.edgeSignal==='good'?'#7bc74d':r.greeks.edgeSignal==='marginal'?'#d29922':'#f85149'
                }}>{r.greeks.edgePhase}</span>
              </div>
              <div className="grid grid-cols-3 gap-2 mb-2">
                <div className="text-center p-2 rounded" style={{background:'#0d1117'}}>
                  <div className="text-[9px] text-[#8b949e]">Directional $</div>
                  <div className="mono text-sm font-bold text-white">${r.greeks.directionalGain?.toFixed(0)}</div>
                </div>
                <div className="text-center p-2 rounded" style={{background:'#0d1117'}}>
                  <div className="text-[9px] text-[#8b949e]">{r.greeks.thetaPaid ? 'Decay $ paid' : 'Theta $'} ({r.greeks.daysToExit}d)</div>
                  <div className="mono text-sm font-bold" style={{color: r.greeks.thetaPaid ? '#e3a008' : '#fff'}}>{r.greeks.thetaPaid ? '-' : ''}${r.greeks.thetaPressure?.toFixed(0)}</div>
                </div>
                <div className="text-center p-2 rounded" style={{background: r.greeks.edgeSignal==='excellent'?'#0d2818':'#0d1117'}}>
                  <div className="text-[9px] text-[#8b949e]">Edge Ratio</div>
                  <div className="mono text-lg font-bold" style={{color: r.greeks.edgeSignal==='excellent'?'#3fb950':r.greeks.edgeSignal==='good'?'#7bc74d':r.greeks.edgeSignal==='marginal'?'#d29922':'#f85149'}}>{r.greeks.edgeRatio?.toFixed(2)}</div>
                </div>
              </div>
              <SpeedTape label="Move / Theta" value={Math.min(r.greeks.edgeRatio, 4)} min={0} max={4}
                zones={r.greeks.isCreditStrat && !r.greeks.thetaPaid
                  ? [{to:0.5,color:'#3fb950'},{to:0.8,color:'#e3b341'},{to:1.2,color:'#d29922'},{to:4,color:'#f85149'}]
                  : [{to:0.8,color:'#f85149'},{to:1.2,color:'#d29922'},{to:2.0,color:'#e3b341'},{to:4,color:'#3fb950'}]
                }
                display={r.greeks.edgeRatio?.toFixed(2)}
                sublabel={r.greeks.edgeAction} />
              <div className="grid grid-cols-2 gap-1.5 mt-3">
                <KV label="Theta efficiency" value={r.greeks.tEff ? (r.greeks.tEff * 100).toFixed(2) + '%' : '--'} />
                <KV label="Vega/Theta" value={r.greeks.tvRatio?.toFixed(2) || '--'} />
              </div>
            </div>
          )}

          {/* Regime */}
          <div className="card">
            <SectionLabel white info="Current market regime based on realised move as % of expected move (RM ratio) and ATR compression. Determines which strategies are favoured. Butterfly zone = >60% consumed + compressing. Each regime has different strategy ratings.">Regime</SectionLabel>
            <div className="text-sm font-semibold text-white">{is0 ? r.regime : `${r.regime} — ${r.outlook||''}`}</div>
            <div className="text-xs text-[#c9d1d9] mt-1.5 leading-relaxed">{is0 ? `${r.regimeConds||''} — ${r.regimeCommentary||''}` : r.regimeCommentary||''}</div>
          </div>

          {/* Fair Value Score */}
          {is0 && r.fairValueScore !== undefined && (
            <div className="card">
              <div className="flex items-center justify-between mb-2">
                <SectionLabel white info="Strategy-specific score: is this trade cheap, fair, or expensive? Volatility Score = IV/HV ratio (credit sellers want rich, debit buyers want cheap). Structure Score = credit/debit ratio and greeks quality. Regime Score = do conditions suit this strategy? Weights vary by strategy type.">Fair Value Score</SectionLabel>
                <div className="flex items-center gap-2">
                  <span className="mono text-lg font-bold" style={{color: r.fairValueScore>=90?'#3fb950':r.fairValueScore>=80?'#7bc74d':r.fairValueScore>=70?'#d29922':'#f85149'}}>{r.fairValueScore}/100</span>
                  <span className="text-xs px-2 py-0.5 rounded font-semibold" style={{
                    background: r.fairValueScore>=90?'#0d1f0d':r.fairValueScore>=80?'#0d1a0d':r.fairValueScore>=70?'#1f1a0d':'#1f0d0d',
                    color: r.fairValueScore>=90?'#3fb950':r.fairValueScore>=80?'#7bc74d':r.fairValueScore>=70?'#d29922':'#f85149'
                  }}>{r.fairValueGrade}</span>
                </div>
              </div>
              <div className="space-y-3">
                <SpeedTape label="Volatility (IV/HV)" value={r.volScore} min={0} max={100}
                  zones={[{to:30,color:'#f85149'},{to:60,color:'#d29922'},{to:80,color:'#e3b341'},{to:100,color:'#3fb950'}]}
                  display={`${r.volScore}/100 — ${r.volGrade}`}
                  sublabel={r.ivHvRatio?`IV/HV ${r.ivHvRatio.toFixed(2)}`:''} />
                <SpeedTape label="Structure (credit/debit ratio)" value={r.structScore} min={0} max={100}
                  zones={[{to:30,color:'#f85149'},{to:60,color:'#d29922'},{to:80,color:'#e3b341'},{to:100,color:'#3fb950'}]}
                  display={`${r.structScore}/100 — ${r.structGrade}`}
                  sublabel={r.greeks?'Includes theta/gamma':'Enter credit/debit + Greeks for full score'} />
                <SpeedTape label="Regime (conditions)" value={r.regimeScore} min={0} max={100}
                  zones={[{to:30,color:'#f85149'},{to:60,color:'#d29922'},{to:80,color:'#e3b341'},{to:100,color:'#3fb950'}]}
                  display={`${r.regimeScore}/100 — ${r.regimeGrade}`}
                  sublabel={`Move ${(r.moveConsumed*100).toFixed(0)}% consumed, comp ${r.comp?.toFixed(2)||'--'}`} />
              </div>
              <div className="mt-3 pt-2 text-xs text-[#8b949e]" style={{borderTop:'1px solid #21262d'}}>
                Weights ({r.legStrat||'--'}): Vol {((r.fvWeightVol||0.3)*100).toFixed(0)}% + Structure {((r.fvWeightStruct||0.3)*100).toFixed(0)}% + Regime {((r.fvWeightRegime||0.4)*100).toFixed(0)}%
              </div>
            </div>
          )}

          {/* Signals */}
          <div className="card">
            <SectionLabel white info="All derived market signals: direction and trend pattern, move consumed breakdown (directional vs range), overnight ES analysis, VWAP slope with 15m confirmation, VIX gap grade, compression ratio, gamma distance. These feed into the setup quality scoring.">Signals</SectionLabel>
            <div className="grid grid-cols-2 gap-1.5">
              {is0 ? <>
                <KV label="Direction" value={r.dirLabel} cls={r.dirScore>0?'text-green':r.dirScore<0?'text-red':''}/>
                <KV label="Move consumed" value={r.moveConsumed!==undefined?`${(r.moveConsumed*100).toFixed(0)}% (dir ${(r.moveConsumedDir*100).toFixed(0)}% / range ${(r.moveConsumedRange*100).toFixed(0)}%)`:'--'} cls={r.moveConsumed>0.80?'text-amber':r.moveConsumed>0.60?'text-amber':''}/>
                <KV label="Vol remaining" value={r.volRemaining!==undefined?`${(r.volRemaining*100).toFixed(0)}%`:'--'} cls={r.volRemaining<0.30?'text-amber':''}/>
                <KV label="Trend pattern" value={r.trendPattern||'--'} cls={r.trendPattern==='continuation'?'text-green':r.trendPattern==='reversal'?'text-amber':''}/>
                <KV label="ES overnight" value={r.overnightDir!=='unknown'?`${r.overnightDir} (${r.overnightDirMove>0?'+':''}${r.overnightDirMove?.toFixed(1)||0} pts)`:'--'} cls={r.overnightDir==='bullish'?'text-green':r.overnightDir==='bearish'?'text-red':''}/>
                <KV label="Cash move" value={r.cashDirMove!==undefined?`${r.cashDirMove>0?'+':''}${r.cashDirMove?.toFixed(1)||0} pts (${r.cashDir})`:'--'} cls={r.cashDir==='bullish'?'text-green':r.cashDir==='bearish'?'text-red':''}/>
                <KV label="Overnight range" value={r.overnightRangePct>0?`${(r.overnightRangePct*100).toFixed(0)}% EM`:'--'}/>
                <KV label="VWAP 5 slope" value={`${r.slope5?.strength||'--'} (${r.slope5?.direction||'--'})`} cls={r.slope5?.direction==='rising'?'text-green':r.slope5?.direction==='falling'?'text-red':''}/>
                <KV label="VWAP 15 slope" value={`${r.slope15?.strength||'--'} (${r.slope15?.direction||'--'})`} cls={r.slope15?.direction==='rising'?'text-green':r.slope15?.direction==='falling'?'text-red':''}/>
                <KV label="15m confirms" value={r.confirmed?'Yes ✓':r.diverges?'Diverges ✗':'—'} cls={r.confirmed?'text-green':r.diverges?'text-amber':''}/>
                <KV label="VIX1D/VIX gap" value={`${(r.vixGap*100).toFixed(1)}%`}/>
                <KV label="VIX grade" value={r.vixGrade}/>
                <KV label="RM ratio" value={r.rmRatio?`${(r.rmRatio*100).toFixed(0)}% EM`:'--'}/>
                <KV label="Compression" value={r.comp!==null?r.comp.toFixed(2):'--'}/>
                <KV label="VWAP distance" value={r.vwapDistPctEM>0?`${(r.vwapDistPctEM*100).toFixed(0)}% EM`:'--'} cls={r.vwapOverextended?'text-amber':''}/>
                <KV label="Gamma dist" value={r.gamDist!==null?`${r.gamDist.toFixed(2)}x ATR`:'--'}/>
                <KV label={`EM active${r.emIsStraddle?' (straddle)':i0.emSource==='manual'?' (manual)':' (VIX1D)'}`} value={`${fv(i0,'em').toFixed(1)} pts`}/>
                <KV label="EM(VIX) ref" value={`${r.emVIX} pts`}/>
                <KV label="EM(VIX1D) ref" value={`${r.emV1D} pts`}/>
              </> : <>
                <KV label="IVR" value={`${fv(i45,'ivr').toFixed(0)}% — ${r.ivrBand}`}/>
                <KV label="IV/HV" value={r.ivhvRatio?`${r.ivhvRatio.toFixed(2)} — ${r.ivhvLabel}`:'--'}/>
                <KV label="EM45" value={r.em45?`${r.em45.toFixed(1)} pts`:'--'}/>
                <KV label="Term" value={r.termLabel}/>
              </>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Setup quality card: one weighted segment bar (segment width = criterion
// weight, fill = points earned) + the top point-losers sorted by cost, with
// the distance to the next grade. The full 9-row breakdown is collapsible.
function SetupQualityCard({ r, sBg, sClr }) {
  const [showDetail, setShowDetail] = useState(false);
  const crits = r.criteria || [];
  const score = r.setupScore || 0;
  // Grade thresholds: A+ 85, A 70, B 50 (matches engine grading)
  const nextUp = score >= 85 ? null
    : score >= 70 ? { pts: 85 - score, grade: 'A+' }
    : score >= 50 ? { pts: 70 - score, grade: 'A' }
    : { pts: 50 - score, grade: 'B' };
  const lost = crits
    .filter(c => (c.pts || 0) < (c.max || 0))
    .map(c => ({ ...c, lost: (c.max || 0) - (c.pts || 0) }))
    .sort((a, b) => b.lost - a.lost)
    .slice(0, 3);
  const fillColor = pct => pct >= 80 ? '#3fb950' : pct >= 50 ? '#2f81f7' : pct >= 30 ? '#d29922' : '#f85149';
  return (
    <div className="card">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-semibold text-white uppercase tracking-wider flex items-center">Setup quality<Info text="9 criteria scored out of 100: Compression (20), Move consumed (20), Strategy fit (15), VWAP slope + 15m confirm (10), VIX gap (10), ES overnight direction (10), Overnight range (5), VWAP distance (5), Gamma distance (5). A+ = 85+, A = 70+, B = 50+, No setup = below 50. Segment width = criterion weight; fill = points earned." /></span>
        <div className="flex items-center gap-2">
          <span style={{background:sBg,color:sClr,padding:'3px 10px',borderRadius:20,fontSize:13,fontWeight:700}}>{r.setup}</span>
          <span className="mono" style={{background:sBg,color:sClr,padding:'3px 8px',borderRadius:6,fontSize:12,fontWeight:600}}>{score}/100</span>
        </div>
      </div>
      {nextUp && nextUp.pts > 0 && (
        <div style={{fontSize:11,color:'#8b949e',marginBottom:6}}>{nextUp.pts} pt{nextUp.pts !== 1 ? 's' : ''} to {nextUp.grade}</div>
      )}
      {crits.length > 0 && (
        <div style={{display:'flex',gap:1,height:12,borderRadius:4,overflow:'hidden',marginBottom:4}}>
          {crits.map((c, i) => {
            const pct = c.max > 0 ? Math.round((c.pts || 0) / c.max * 100) : 0;
            return (
              <div key={i} title={`${c.label}: ${c.pts}/${c.max}`} style={{flex:c.max || 1,background:'#21262d'}}>
                <div style={{width:`${pct}%`,height:'100%',background:fillColor(pct),transition:'width 0.3s'}}/>
              </div>
            );
          })}
        </div>
      )}
      <div style={{fontSize:10,color:'#484f58',marginBottom:8}}>Segment width = weight · fill = points earned · hover for detail</div>
      {lost.length > 0 && (
        <div style={{borderTop:'1px solid #21262d',paddingTop:6,marginBottom:2}}>
          <div style={{fontSize:11,color:'#8b949e',marginBottom:3}}>Costing you the most</div>
          {lost.map((c, i) => (
            <div key={i} className="flex items-center justify-between" style={{padding:'2px 0'}}>
              <span className="text-xs text-white">{c.label}</span>
              <span className="mono text-xs" style={{color: c.lost >= c.max / 2 ? '#f85149' : '#d29922'}}>−{c.lost}</span>
            </div>
          ))}
        </div>
      )}
      <div onClick={() => setShowDetail(s => !s)}
        style={{fontSize:11,color:'#58a6ff',cursor:'pointer',userSelect:'none',marginTop:4}}>
        {showDetail ? 'Hide all criteria ▴' : 'Show all criteria ▾'}
      </div>
      {showDetail && (
        <div style={{marginTop:6}}>
          {crits.map((cr, i) => {
            const pct = cr.max > 0 ? Math.round((cr.pts || 0) / cr.max * 100) : 0;
            return (
              <div key={i} className="flex items-center gap-2 mb-1">
                <span className="text-xs text-white truncate" style={{flex:'0 0 160px'}}>{cr.label}</span>
                <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{background:'#21262d'}}>
                  <div style={{width:`${pct}%`,height:'100%',background:fillColor(pct),borderRadius:4,transition:'width 0.3s'}}/>
                </div>
                <span className="text-xs text-white mono" style={{flex:'0 0 36px',textAlign:'right'}}>{cr.pts}/{cr.max}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PayoffDiagram({ payoff, currentPrice, mini }) {
  if (!payoff || !payoff.points || payoff.points.length < 2) return null;
  const W = mini ? 280 : 460;
  const H = mini ? 140 : 220;
  const PAD = mini ? { top: 10, right: 12, bottom: 22, left: 48 } : { top: 14, right: 15, bottom: 28, left: 55 };
  const cW = W - PAD.left - PAD.right;
  const cH = H - PAD.top - PAD.bottom;
  const pts = payoff.points;
  const prices = pts.map(p => p.price);
  const pnls = pts.map(p => p.pnl);
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const minPnl = Math.min(...pnls, 0);
  const maxPnl = Math.max(...pnls, 0);
  const pnlRange = maxPnl - minPnl || 1;
  const x = p => PAD.left + (p - minP) / (maxP - minP) * cW;
  const y = pnl => PAD.top + cH - ((pnl - minPnl) / pnlRange) * cH;
  const zeroY = y(0);
  const fs = mini ? 9 : 11;

  // Build fill paths
  let linePath = '';
  pts.forEach((p, i) => {
    const px = x(p.price), py = y(p.pnl);
    linePath += (i === 0 ? 'M' : 'L') + px + ' ' + py + ' ';
  });

  let fillAbove = 'M' + x(pts[0].price) + ' ' + zeroY + ' ';
  let fillBelow = 'M' + x(pts[0].price) + ' ' + zeroY + ' ';
  pts.forEach(p => {
    const px = x(p.price), py = y(p.pnl);
    fillAbove += 'L' + px + ' ' + (p.pnl > 0 ? py : zeroY) + ' ';
    fillBelow += 'L' + px + ' ' + (p.pnl < 0 ? py : zeroY) + ' ';
  });
  fillAbove += 'L' + x(pts[pts.length-1].price) + ' ' + zeroY + ' Z';
  fillBelow += 'L' + x(pts[pts.length-1].price) + ' ' + zeroY + ' Z';

  // Price axis ticks
  const priceTicks = [];
  for (let i = 0; i <= 4; i++) {
    const p = minP + (maxP - minP) * (i / 4);
    priceTicks.push({ x: x(p), label: Math.round(p) });
  }

  return (
    <svg viewBox={'0 0 ' + W + ' ' + H} style={{width:'100%',height:'auto',overflow:'visible'}}>
      {/* Zero line */}
      <line x1={PAD.left} y1={zeroY} x2={W-PAD.right} y2={zeroY} stroke="#c9d1d9" strokeWidth="0.5" strokeDasharray="3,3"/>
      {/* Fill areas */}
      <path d={fillAbove} fill="#3fb950" fillOpacity="0.20" />
      <path d={fillBelow} fill="#f85149" fillOpacity="0.15" />
      {/* P&L line */}
      <path d={linePath} fill="none" stroke="#e6edf3" strokeWidth={mini ? 2 : 2.5} strokeLinejoin="round" />
      {/* Current price line */}
      {currentPrice > 0 && currentPrice >= minP && currentPrice <= maxP && (
        <>
          <line x1={x(currentPrice)} y1={PAD.top} x2={x(currentPrice)} y2={H-PAD.bottom} stroke="#2f81f7" strokeWidth="1" strokeDasharray="3,2"/>
          <text x={x(currentPrice)} y={PAD.top-2} textAnchor="middle" fill="#58a6ff" fontSize={fs} fontWeight="600">{Math.round(currentPrice)}</text>
        </>
      )}
      {/* Breakevens */}
      {payoff.breakevens?.map((be, i) => be >= minP && be <= maxP && (
        <g key={i}>
          <circle cx={x(be)} cy={zeroY} r={mini ? 3 : 4} fill="#d29922" />
          <text x={x(be)} y={zeroY+(mini?12:14)} textAnchor="middle" fill="#f0c040" fontSize={fs} fontWeight="600">{be.toFixed(0)}</text>
        </g>
      ))}
      {/* Y-axis labels */}
      <text x={PAD.left-4} y={zeroY+4} textAnchor="end" fill="#c9d1d9" fontSize={fs}>$0</text>
      {maxPnl > 0 && <text x={PAD.left-4} y={y(maxPnl)+4} textAnchor="end" fill="#c9d1d9" fontSize={mini ? 8 : fs}>{'$' + maxPnl.toFixed(0)}</text>}
      {minPnl < 0 && <text x={PAD.left-4} y={y(minPnl)+4} textAnchor="end" fill="#c9d1d9" fontSize={mini ? 8 : fs}>{'$' + minPnl.toFixed(0)}</text>}
      {/* X-axis price labels */}
      {priceTicks.map((t, i) => (
        <text key={i} x={t.x} y={H-(mini?5:5)} textAnchor="middle" fill="#c9d1d9" fontSize={fs}>{t.label}</text>
      ))}
    </svg>
  );
}

function ProfitScale({ netCreditDebit, isCredit, win }) {
  const ncd = Math.abs(netCreditDebit);
  const pcts = [25, 30, 40, 50, 75, 100];
  const multiplier = 100; // options multiplier
  // Profit targets are a % of MAX PROFIT (the Win amount), NOT a % of the entry
  // debit/credit. For credit trades max profit ≈ the credit, so the two coincide;
  // for debit butterflies they diverge — 100% must mean the FULL max profit
  // (close at the wing width), not a 100% return on the debit. Falls back to the
  // old entry-based figure only when no Win amount has been entered.
  const maxProfit = win > 0 ? win : ncd * multiplier;

  // For credit trades: profit target = close for LESS than credit received
  //   e.g. sold for $2.00 credit, 50% profit = buy back at $1.00 (debit $1.00)
  //   TWS entry: limit debit = credit × (1 - target%)
  // For debit trades: profit target = close for MORE than debit paid
  //   e.g. bought for $1.50 debit, 50% profit = sell at $2.25 ($1.50 + 50% of $1.50)
  //   TWS entry: limit credit = debit × (1 + target%)
  //   Actually for butterflies: 50% of max profit, not 50% of debit
  //   Simpler: profit $ = ncd × target%, close price = ncd ± profit

  return (
    <div style={{marginTop:8,marginBottom:4}}>
      <div style={{fontSize:10,color:'#8b949e',marginBottom:6,fontWeight:600}}>
        Profit targets — TWS limit order values
      </div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(6, 1fr)',gap:4}}>
        {pcts.map(pct => {
          const profitDollars = maxProfit * (pct / 100);
          const profitPerShare = profitDollars / multiplier;
          let closePrice, closeType;
          if (isCredit || netCreditDebit > 0) {
            // Credit: buy back cheaper — close price = credit - profit
            closePrice = ncd - profitPerShare;
            closeType = 'debit';
          } else {
            // Debit: sell higher — close price = |debit| + profit
            closePrice = ncd + profitPerShare;
            closeType = 'credit';
          }
          const highlight = pct === 50;
          return (
            <div key={pct} style={{
              background: highlight ? '#0d2818' : '#161b22',
              border: `1px solid ${highlight ? '#238636' : '#21262d'}`,
              borderRadius: 6, padding: '6px 4px', textAlign: 'center'
            }}>
              <div style={{fontSize:12,fontWeight:700,color: highlight ? '#3fb950' : '#c9d1d9'}}>{pct}%</div>
              <div style={{fontSize:16,fontWeight:700,color:'#fff',fontFamily:'JetBrains Mono,monospace',marginTop:3}}>
                ${closePrice.toFixed(2)}
              </div>
              <div style={{fontSize:10,color:'#8b949e',marginTop:2}}>{closeType}</div>
              <div style={{fontSize:12,fontWeight:600,color: highlight ? '#3fb950' : '#c9d1d9',marginTop:2}}>+${profitDollars.toFixed(0)}</div>
            </div>
          );
        })}
      </div>
      <div style={{fontSize:9,color:'#484f58',marginTop:4}}>
        {isCredit || netCreditDebit > 0
          ? `Sold at $${ncd.toFixed(2)} credit — enter limit debit to close`
          : `Bought at $${ncd.toFixed(2)} debit — enter limit credit to close`}
      </div>
    </div>
  );
}

function CreditTape({ value, low, high, max, isCredit, label }) {
  const safeMax = max || 1;
  const pct = (v) => Math.max(0, Math.min(100, (v / safeMax) * 100));
  const valuePct = pct(value);
  const lowPct = pct(low);
  const highPct = pct(high);

  let grade, gradeColor;
  if (value === 0) {
    grade = 'Enter value'; gradeColor = '#8b949e';
  } else if (value >= low && value <= high) {
    grade = 'Fair value'; gradeColor = '#3fb950';
  } else if (isCredit && value > high) {
    grade = 'Rich \u2014 good fill'; gradeColor = '#3fb950';
  } else if (isCredit && value < low) {
    grade = 'Cheap \u2014 widen strikes?'; gradeColor = '#f85149';
  } else if (!isCredit && value < low) {
    grade = 'Cheap \u2014 good fill'; gradeColor = '#3fb950';
  } else if (!isCredit && value > high) {
    grade = 'Expensive'; gradeColor = '#f85149';
  } else {
    grade = ''; gradeColor = '#8b949e';
  }

  return (
    <div style={{marginTop:6}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4}}>
        <span style={{fontSize:10,color:'#8b949e'}}>{isCredit ? 'Credit received' : 'Debit paid'}</span>
        <span style={{fontSize:10,fontWeight:600,color:gradeColor}}>{grade}</span>
      </div>
      <div style={{position:'relative',height:14,borderRadius:7,overflow:'hidden',background:'#161b22'}}>
        {isCredit ? (
          <div style={{position:'absolute',top:0,left:0,width:lowPct+'%',height:'100%',background:'#f85149',opacity:0.25}} />
        ) : (
          <div style={{position:'absolute',top:0,left:highPct+'%',width:(100-highPct)+'%',height:'100%',background:'#f85149',opacity:0.25}} />
        )}
        <div style={{position:'absolute',top:0,left:lowPct+'%',width:Math.max(2,(highPct-lowPct))+'%',height:'100%',background:'#3fb950',opacity:0.35,borderRadius:2}} />
        {isCredit ? (
          <div style={{position:'absolute',top:0,left:highPct+'%',width:(100-highPct)+'%',height:'100%',background:'#3fb950',opacity:0.15}} />
        ) : (
          <div style={{position:'absolute',top:0,left:0,width:lowPct+'%',height:'100%',background:'#3fb950',opacity:0.15}} />
        )}
        <div style={{position:'absolute',top:0,left:lowPct+'%',width:2,height:'100%',background:'#3fb950',opacity:0.7}} />
        <div style={{position:'absolute',top:0,left:highPct+'%',width:2,height:'100%',background:'#3fb950',opacity:0.7}} />
        {value > 0 && (
          <div style={{position:'absolute',top:-1,left:`calc(${valuePct}% - 3px)`,width:6,height:16,borderRadius:3,background:'#fff',boxShadow:'0 0 6px rgba(0,0,0,0.6)'}} />
        )}
      </div>
      <div style={{position:'relative',height:16,marginTop:2}}>
        <span style={{position:'absolute',left:0,fontSize:9,color:'#484f58'}}>$0</span>
        <span style={{position:'absolute',left:lowPct+'%',transform:'translateX(-50%)',fontSize:9,color:'#3fb950',fontWeight:600}}>${low.toFixed(2)}</span>
        <span style={{position:'absolute',left:highPct+'%',transform:'translateX(-50%)',fontSize:9,color:'#3fb950',fontWeight:600}}>${high.toFixed(2)}</span>
        <span style={{position:'absolute',right:0,fontSize:9,color:'#484f58'}}>${safeMax.toFixed(1)}</span>
      </div>
    </div>
  );
}

function SpeedTape({ label, value, min, max, zones, display, sublabel }) {
  const range = max - min;
  const pct = Math.max(0, Math.min(100, ((value - min) / range) * 100));
  // Determine color at current position
  let markerColor = '#8b949e';
  let cumPct = 0;
  for (const z of zones) {
    const zonePct = ((z.to - min) / range) * 100;
    if (pct <= zonePct) { markerColor = z.color; break; }
    markerColor = z.color;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-text-muted">{label}</span>
        <div className="flex items-center gap-2">
          <span className="text-xs mono font-bold" style={{color:markerColor}}>{display}</span>
          {sublabel && <span className="text-[10px] text-text-faint">{sublabel}</span>}
        </div>
      </div>
      <div style={{position:'relative',height:8,borderRadius:4,overflow:'hidden',background:'#21262d'}}>
        {/* Zone gradient */}
        <div style={{display:'flex',height:'100%',width:'100%'}}>
          {zones.map((z, i) => {
            const prevTo = i === 0 ? min : zones[i-1].to;
            const w = ((z.to - prevTo) / range) * 100;
            return <div key={i} style={{width:w+'%',height:'100%',background:z.color,opacity:0.25}} />;
          })}
        </div>
        {/* Filled portion */}
        <div style={{position:'absolute',top:0,left:0,height:'100%',width:pct+'%',borderRadius:4,overflow:'hidden'}}>
          <div style={{display:'flex',height:'100%',width: (100/pct*100)+'%'}}>
            {zones.map((z, i) => {
              const prevTo = i === 0 ? min : zones[i-1].to;
              const w = ((z.to - prevTo) / range) * 100;
              return <div key={i} style={{width:w+'%',height:'100%',background:z.color,opacity:0.85}} />;
            })}
          </div>
        </div>
        {/* Marker */}
        <div style={{position:'absolute',top:-1,left:`calc(${pct}% - 1px)`,width:3,height:10,borderRadius:1,background:'#fff',boxShadow:'0 0 4px rgba(0,0,0,0.5)'}} />
      </div>
    </div>
  );
}

function Info({ text }) {
  const [show, setShow] = React.useState(false);
  const [pos, setPos] = React.useState({ top: 0, left: 0, flipDown: false });
  const ref = React.useRef(null);

  const updatePos = () => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      const flipDown = rect.top < 200;
      setPos({
        top: flipDown ? rect.bottom + 8 : rect.top - 8,
        left: Math.min(Math.max(rect.left, 160), window.innerWidth - 160),
        flipDown
      });
    }
  };

  return (
    <span ref={ref} style={{position:'relative',display:'inline-block',marginLeft:5}}>
      <span
        onClick={(e) => { e.stopPropagation(); setShow(!show); if (!show) updatePos(); }}
        onMouseEnter={() => { setShow(true); updatePos(); }}
        onMouseLeave={() => setShow(false)}
        style={{display:'inline-flex',alignItems:'center',justifyContent:'center',width:15,height:15,borderRadius:'50%',background:'#21262d',color:'#8b949e',fontSize:9,fontWeight:700,cursor:'pointer',border:'1px solid #30363d',lineHeight:1,userSelect:'none'}}>?</span>
      {show && ReactDOM.createPortal(
        <div style={{
          position:'fixed',
          top: pos.flipDown ? pos.top : 'auto',
          bottom: pos.flipDown ? 'auto' : (window.innerHeight - pos.top),
          left: pos.left,
          transform:'translateX(-50%)',
          width:300,padding:'12px 14px',
          background:'#1c2128',border:'1px solid #444c56',borderRadius:10,
          fontSize:11,color:'#e6edf3',lineHeight:1.6,
          zIndex:9999,boxShadow:'0 8px 24px rgba(0,0,0,0.6)',whiteSpace:'normal',
          maxWidth:'calc(100vw - 32px)',pointerEvents:'none'
        }}>
          {text}
        </div>,
        document.body
      )}
    </span>
  );
}

// ── Collapsible input-column section ──
// Pure re-layout wrapper for the INPUT column: a sticky header row (title,
// completeness badge, action buttons) over exactly the JSX that used to sit
// flat in the column. Collapse state lives in the parent so it can persist per
// mode under localStorage 'ot_engine_sections'. `pinned` renders even while
// collapsed (the TWS position picker must never hide behind a collapsed card).
// The header is sticky within the input column's scroller: bg-bg-card masks the
// inputs scrolling underneath, zIndex 5 keeps it above them (Info tooltips are
// portaled to <body> at zIndex 9999, so they are unaffected).
function InputSection({ title, info, missing, collapsed, onToggle, onExpand, actions, pinned, children }) {
  return (
    <section className="mt-4 first:mt-0">
      <div onClick={onToggle}
        className="sticky top-0 bg-bg-card flex items-center justify-between gap-2 flex-wrap cursor-pointer select-none"
        style={{ zIndex: 5, padding: '5px 0 7px' }}>
        <div className="flex items-center min-w-0">
          <span aria-hidden="true" style={{ width: 13, display: 'inline-block', fontSize: 9, color: '#8b949e', flex: 'none' }}>{collapsed ? '▸' : '▾'}</span>
          <span className="text-[11px] font-semibold uppercase tracking-wider text-text-faint flex items-center whitespace-nowrap">{title}{info && <Info text={info} />}</span>
          {missing != null && (missing === 0 ? (
            <span title="All required inputs entered" style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: '#3fb950' }}>✓</span>
          ) : (
            <span onClick={e => { e.stopPropagation(); if (onExpand) onExpand(); }}
              title={missing + ' required input' + (missing === 1 ? '' : 's') + ' still blank — the decision banner reads incomplete until filled. Click to expand the section.'}
              style={{ marginLeft: 8, padding: '1px 7px', borderRadius: 9, fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap',
                background: '#1f1a0d', color: '#d29922', border: '1px solid #9e6a03', cursor: 'pointer' }}>
              {missing} missing
            </span>
          ))}
        </div>
        {actions && (
          <div className="flex items-center gap-2 flex-wrap justify-end" onClick={e => e.stopPropagation()}>{actions}</div>
        )}
      </div>
      {pinned}
      {!collapsed && children}
    </section>
  );
}

function SectionLabel({ children, white, info }) {
  return (
    <div className={`text-xs font-semibold uppercase tracking-wider mt-4 mb-2 first:mt-0 flex items-center ${white ? 'text-white' : 'text-[#c9d1d9]'}`}>
      {children}
      {info && <Info text={info} />}
    </div>
  );
}

// `manual` = you typed this and auto-fill is leaving it alone (amber, with the
// feed's value shown alongside when the two disagree). `stale` = the last pull
// did not return this field at all, so what is on screen is older than the badge
// suggests (dim, dashed). `bad` still wins over both — it means the value is wrong.
function Inp({label,value,onChange,type,bad,manual,stale,feedVal}) {
  const border = bad ? 'border-[#f85149]' : manual ? 'border-[#9e6a03]' : 'border-[#30363d]';
  const lblCls = bad ? 'text-[#f85149]' : manual ? 'text-[#d29922]' : 'text-[#c9d1d9]';
  const differs = manual && feedVal !== undefined && String(feedVal) !== String(value == null ? '' : value);
  const tip = manual
    ? 'Manual — you typed this, so auto-fill left it alone.' + (differs ? ' The last pull said ' + feedVal + '.' : '')
    : stale ? 'The last auto-fill did not return this field, so this value is older than the badge above.' : undefined;
  return (<div><label className={`text-[11px] block mb-1 ${lblCls}`} title={tip}>
      {label}{manual ? ' ✎' : ''}
      {differs && <span className="text-[#6e7681] font-normal"> feed {feedVal}</span>}
      {!manual && stale && <span className="text-[#6e7681] font-normal"> · no feed</span>}
    </label>
    <input type={type||'number'} step="any" value={value||''} onChange={e=>onChange(e.target.value)} placeholder="—" title={tip}
      style={(!bad && !manual && stale) ? {borderStyle:'dashed'} : undefined}
      className={`w-full px-3 py-2 bg-[#0d1117] border rounded-lg text-sm text-white mono outline-none focus:border-[#2f81f7] ${border}`}/></div>);
}
function Sel({label,value,onChange,options}) {
  return (<div><label className="text-[11px] text-[#c9d1d9] block mb-1">{label}</label>
    <select value={value} onChange={e=>onChange(e.target.value)}
      className="w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-sm text-white outline-none focus:border-[#2f81f7]">
      {options.map(o=><option key={o} value={o}>{o}</option>)}</select></div>);
}
// Inline pre-fill chip: the payoff engine computed this value and the sizing
// field is empty or disagrees. Click to copy it in — typed values are NEVER
// overwritten automatically. Win/Risk are sizing fields, outside the held/
// auto-fill contract, so filling one creates no hold.
function PrefillChip({ payoffVal, fieldVal, onFill }) {
  if (payoffVal == null || !isFinite(payoffVal) || payoffVal <= 0) return null;
  const v = Math.round(payoffVal);
  const cur = parseFloat(fieldVal);
  if (isFinite(cur) && Math.abs(cur - v) < 0.5) return null; // already matches
  return (
    <button type="button" onClick={() => onFill(String(v))}
      title="Computed from the payoff at expiry. Click to fill — your typed value is never overwritten automatically."
      style={{marginTop:3,padding:'1px 7px',borderRadius:4,border:'1px solid #1f6feb55',background:'#0d1a2e',color:'#58a6ff',fontSize:10,fontWeight:600,cursor:'pointer'}}>
      ← {v} from payoff
    </button>
  );
}

function KV({label,value,cls}) {
  return (<div className="flex justify-between py-1 border-b border-[#21262d] last:border-0">
    <span className="text-sm text-[#c9d1d9]">{label}</span>
    <span className={`text-sm font-semibold mono ${cls||'text-white'}`}>{value}</span></div>);
}
