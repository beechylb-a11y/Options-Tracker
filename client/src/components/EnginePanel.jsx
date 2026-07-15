import React, { useState, useMemo, useEffect } from 'react';
import ReactDOM from 'react-dom';
import { calc0DTE } from '../engine/calc0dte';
import { calc45DTE } from '../engine/calc45dte';
import { UNDERLYING_LIST, resolveCashType } from '../engine/data';

const OUTLOOKS = ['neutral', 'bullish', 'bearish'];
const TERM_BIASES = ['contango', 'flat', 'backwardation'];

export default function EnginePanel({ mode, onLogTrade, accountConfig, prefillData, onPrefillConsumed, strategyHistory }) {
  const is0 = mode === '0dte';
  const acfg = accountConfig || {};
  const defBankroll = acfg.bankroll || 3000;
  const defMaxLoss = acfg.maxDailyLoss || 300;
  const defMaxOpen = acfg.maxOpenRisk || 450;
  const [overrideStrat, setOverrideStrat] = useState(null);
  const [autoFilling, setAutoFilling] = useState(false);
  const [fetchingGreeks, setFetchingGreeks] = useState(false);
  const [loadingTws, setLoadingTws] = useState(false);
  const [twsStructures, setTwsStructures] = useState(null); // picker list when >1
  const [twsLegs, setTwsLegs] = useState(null); // exact legs from a loaded TWS position

  const [i0, setI0] = useState({
    underlying:'SPX', price:'', high:'', low:'', vwap5:'', vwap5_30:'', vwap15:'', vwap15_30:'',
    em:'', atr5:'', atr2h:'', atr:'',
    vix:'', vix1d:'',
    esOvernightHigh:'', esOvernightLow:'', esClose:'', priorDayClose:'', cashOpen:'', esEM:'',
    win:'', risk:'', pop:'', hours:'', netCreditDebit:'',
    theta:'', delta:'', gamma:'', gamStrike:'',
    lowerWingDelta:'', upperWingDelta:'',
    bankroll:defBankroll, startBR:defBankroll, maxLoss:defMaxLoss, maxOpen:defMaxOpen
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

  // Apply prefillData from multi-scan
  useEffect(() => {
    if (!prefillData || !is0) return;
    setI0(prev => ({
      ...prev,
      underlying: prefillData.underlying || prev.underlying,
      price: prefillData.price || prev.price,
      high: prefillData.high || prev.high,
      low: prefillData.low || prev.low,
      vwap5: prefillData.vwap5 || prev.vwap5,
      vwap5_30: prefillData.vwap5_30 || prev.vwap5_30,
      vwap15: prefillData.vwap15 || prev.vwap15,
      vwap15_30: prefillData.vwap15_30 || prev.vwap15_30,
      em: prefillData.em || prev.em,
      atr: prefillData.atr || prev.atr,
      atr5: prefillData.atr5 || prev.atr5,
      atr2h: prefillData.atr2h || prev.atr2h,
      vix: prefillData.vix || prev.vix,
      vix1d: prefillData.vix1d || prev.vix1d,
      esOvernightHigh: prefillData.esOvernightHigh || prev.esOvernightHigh,
      esOvernightLow: prefillData.esOvernightLow || prev.esOvernightLow,
      esClose: prefillData.esClose || prev.esClose,
      priorDayClose: prefillData.priorDayClose || prev.priorDayClose,
      cashOpen: prefillData.cashOpen || prev.cashOpen,
      esEM: prefillData.esEM || prev.esEM,
    }));
    setOverrideStrat(null);
    if (onPrefillConsumed) onPrefillConsumed();
  }, [prefillData]);

  const [i45, setI45] = useState({
    underlying:'SPX', price:'', ivr:'', iv:'', hv:'', vix:'',
    ivFront:'', ivBack:'', skew:'', termBias:'contango', dte:'45',
    outlook:'neutral', pop:'', win:'', risk:'', netCreditDebit:'',
    bankroll:defBankroll, startBR:defBankroll, maxLoss:defMaxLoss, maxOpen:defMaxOpen,
    bpr:'', theta:'', vega:'', delta:''
  });

  const set0 = (k,v) => setI0(p => ({...p,[k]:v}));
  const set45 = (k,v) => setI45(p => ({...p,[k]:v}));
  const fv = (o,k) => parseFloat(o[k]) || 0;

  // SPX VWAP fix: if underlying is SPX and values look like SPY, scale x10
  function scaleVWAP(val) {
    const price = fv(i0, 'price');
    const v = parseFloat(val) || 0;
    if (i0.underlying === 'SPX' && price > 1000 && v > 0 && v < price * 0.3) return v * 10;
    return v;
  }
  const vwapScaled = is0 && i0.underlying === 'SPX';
  const vwapFromIWM = is0 && i0.underlying === 'RUT';

  const r = useMemo(() => {
    try {
      if (is0) {
        return calc0DTE({
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
          } : null
        });
      } else {
        return calc45DTE({
          price:fv(i45,'price'), ivr:fv(i45,'ivr'), iv:fv(i45,'iv'),
          hv:fv(i45,'hv'), vix:fv(i45,'vix'), ivFront:fv(i45,'ivFront'),
          ivBack:fv(i45,'ivBack'), skew:fv(i45,'skew'), dte:fv(i45,'dte')||45,
          pop:fv(i45,'pop'), win:fv(i45,'win'), risk:fv(i45,'risk'),
          bankroll:fv(i45,'bankroll'), startBR:fv(i45,'startBR'),
          maxLoss:fv(i45,'maxLoss'), maxOpen:fv(i45,'maxOpen'), bpr:fv(i45,'bpr'),
          theta:fv(i45,'theta'), vega:fv(i45,'vega'), delta:fv(i45,'delta'),
          underlying:i45.underlying, termBias:i45.termBias, outlook:i45.outlook,
          overrideStrategy: overrideStrat,
          historyByStrategy: strategyHistory || null
        });
      }
    } catch (e) {
      console.error('Calc engine error:', e);
      return { decision:'Error', decisionClass:'nogo', hardBlocker:'Calculation error: ' + e.message,
        setup:'No setup', setupScore:0, criteria:[], ratings:[], legs:[], warnings:[], blockers:[],
        bestStrat:'', bestRating:'NO TRADE', legStrat:'', kelly:0, rawKelly:0, adjustedKelly:0,
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

  // Override: calc engine generates legs for overrideStrat if set
  const isOverride = overrideStrat && overrideStrat !== r.bestStrat;
  const effectiveStrat = r.legStrat || r.bestStrat;
  const ticketNet = is0 ? i0.netCreditDebit : i45.netCreditDebit;
  const cashType = resolveCashType(effectiveStrat, ticketNet); // 'credit' | 'debit' | 'varies'
  const effectiveRating = isOverride ? (r.ratings.find(s => s.name === overrideStrat)?.rating || 'MARGINAL') : r.bestRating;
  // ── Composite banner score ──
  // Blends setup quality (market conditions) with sizing metrics (trade edge)
  // Each metric normalized to 0-100, then averaged
  const kellyPct = r.adjustedKelly || 0;
  const missingInputs = r.missingSize;
  const hasBlocker = !!r.hardBlocker;

  // Setup quality: already 0-100
  const setupNorm = r.setupScore || 0;

  // Sizing metrics normalized to 0-100
  const kellyNorm = Math.min(100, (kellyPct / 0.25) * 100); // 25% = perfect
  const volNorm = Math.min(100, (r.volFactor || 0) * 100); // 1.0 = perfect
  const sharpeNorm = Math.min(100, (r.sharpeFactor || 0) * 100); // 1.0 = perfect
  const popNorm = Math.min(100, ((r.popMargin || 0) / 2.0) * 100); // 2.0x = perfect
  const evNorm = r.ev > 0 ? Math.min(100, (r.ev / 200) * 100) : 0; // $200 = perfect

  // Composite: 40% setup quality + 60% sizing (Kelly, Vol, Sharpe, POP, EV)
  const sizingAvg = missingInputs ? 50 : (kellyNorm + volNorm + sharpeNorm + popNorm + evNorm) / 5;
  const compositeScore = missingInputs
    ? setupNorm // only setup quality when no sizing entered
    : Math.round(setupNorm * 0.40 + sizingAvg * 0.60);

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

  const dcBg = bannerGrade==='strong'?'#0d1f0d':bannerGrade==='decent'?'#0d1a0d':bannerGrade==='marginal'?'#1f1a0d':'#1f0d0d';
  const dcBorder = bannerGrade==='strong'?'#238636':bannerGrade==='decent'?'#4d8c2a':bannerGrade==='marginal'?'#9e6a03':'#da3633';
  const dcColor = bannerGrade==='strong'?'#3fb950':bannerGrade==='decent'?'#7bc74d':bannerGrade==='marginal'?'#d29922':'#f85149';
  const sBg = r.setupScore>=85?'#0d1f0d':r.setupScore>=70?'#0d1a2e':r.setupScore>=50?'#1f1a0d':'#1f0d0d';
  const sClr = r.setupScore>=85?'#3fb950':r.setupScore>=70?'#2f81f7':r.setupScore>=50?'#d29922':'#f85149';

  // Show VWAP scaling notice (vwapScaled defined above)

  async function handleFetchGreeks() {
    setFetchingGreeks(true);
    try {
      const bridgeUrl = localStorage.getItem('bridgeUrl') || '';
      if (!bridgeUrl) { alert('Set IBKR Bridge URL in Settings first'); setFetchingGreeks(false); return; }
      const underlying = is0 ? i0.underlying : i45.underlying;
      const legsSrc = r?.legs || [];
      if (!legsSrc.length) { alert('No strikes computed yet — fill in the setup first.'); setFetchingGreeks(false); return; }

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
      if (d.error) { alert('Bridge error: ' + d.error); setFetchingGreeks(false); return; }
      if (d.notSubscribed || (!d.net && d.message)) {
        alert(d.message || 'TWS returned no Greeks — options market data not subscribed. Enter Greeks manually.');
        setFetchingGreeks(false); return;
      }
      if (!d.net) { alert('No Greeks returned — TWS may lack option data permissions, or the expiry/strikes are invalid. You can enter Greeks manually.'); setFetchingGreeks(false); return; }

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
          theta: d.net.theta ? String(Math.abs(d.net.theta)) : prev.theta,
          delta: d.net.delta != null ? String(d.net.delta) : prev.delta,
          gamma: d.net.gamma != null ? String(d.net.gamma) : prev.gamma,
          gamStrike: bodyLeg ? String(bodyLeg.strike) : prev.gamStrike,
          lowerWingDelta: lowerWD || prev.lowerWingDelta,
          upperWingDelta: upperWD || prev.upperWingDelta
        }));
      } else {
        setI45(prev => ({
          ...prev,
          theta: d.net.theta ? String(Math.abs(d.net.theta)) : prev.theta,
          delta: d.net.delta != null ? String(d.net.delta) : prev.delta,
          vega: d.net.vega != null ? String(d.net.vega) : prev.vega
        }));
      }
    } catch (e) {
      alert('Fetch Greeks failed: ' + e.message);
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
      if (!bridgeUrl) { alert('Set IBKR Bridge URL in Settings first'); setLoadingTws(false); return; }
      const resp = await fetch(bridgeUrl + '/api/positions', { headers: { 'ngrok-skip-browser-warning': '1' } });
      const d = await resp.json();
      if (d.error) { alert('Bridge error: ' + d.error); setLoadingTws(false); return; }
      const structs = d.structures || [];
      if (structs.length === 0) {
        alert('No open option positions in TWS. For paper trades, enter the strikes, contracts and net credit/debit manually — the ticket fields below mirror what a fetch would fill.');
        setLoadingTws(false); return;
      }
      if (structs.length === 1) {
        await applyTwsStructure(structs[0]);
      } else {
        // Several open structures — show a picker.
        setTwsStructures(structs);
      }
    } catch (e) {
      alert('Load from TWS failed: ' + e.message);
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
      if (!bridgeUrl) { alert('Set IBKR Bridge URL in Settings first'); setAutoFilling(false); return; }
      const underlying = is0 ? i0.underlying : i45.underlying;
      const resp = await fetch(bridgeUrl + '/api/market-data?underlying=' + underlying, { headers: { 'ngrok-skip-browser-warning': '1' } });
      const d = await resp.json();
      if (d.error) { alert('Bridge error: ' + d.error); setAutoFilling(false); return; }
      if (is0) {
        // Calculate hours remaining until 3pm ET (15:00 New York)
        const now = new Date();
        const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const marketClose = new Date(et);
        marketClose.setHours(15, 0, 0, 0);
        const hoursLeft = Math.max(0, (marketClose - et) / 3600000);
        const hoursRounded = Math.round(hoursLeft * 10) / 10;

        setI0(prev => ({
          ...prev,
          price: d.price || prev.price,
          high: d.high || prev.high,
          low: d.low || prev.low,
          vwap5: d.vwap5 || prev.vwap5,
          vwap5_30: d.vwap5_30 || prev.vwap5_30,
          vwap15: d.vwap15 || prev.vwap15,
          vwap15_30: d.vwap15_30 || prev.vwap15_30,
          em: d.em || prev.em,
          atr: d.atr || prev.atr,
          atr5: d.atr5 || prev.atr5,
          atr2h: d.atr2h || prev.atr2h,
          vix: d.vix || prev.vix,
          vix1d: d.vix1d || prev.vix1d,
          esOvernightHigh: d.esOvernightHigh || prev.esOvernightHigh,
          esOvernightLow: d.esOvernightLow || prev.esOvernightLow,
          esClose: d.esClose || prev.esClose,
          priorDayClose: d.priorDayClose || prev.priorDayClose,
          cashOpen: d.cashOpen || prev.cashOpen,
          esEM: d.esEM || prev.esEM,
          hours: hoursRounded > 0 ? hoursRounded : prev.hours
        }));
      }
    } catch (e) {
      alert('Auto-fill failed: ' + e.message);
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

  function handleLog() {
    if (!onLogTrade) return;
    if (!accountConfig?.id) {
      alert('Please select a specific account in the sidebar before logging a trade.');
      return;
    }
    const inp = is0 ? i0 : i45;
    const ncd = parseFloat(inp.netCreditDebit) || 0;
    onLogTrade({ engine:is0?'0DTE':'45DTE', underlying:inp.underlying,
      strategy:`${inp.underlying} - ${effectiveStrat} - ${r.contracts} contract${r.contracts!==1?'s':''}`,
      direction:effectiveDecision, contracts:r.contracts, kellyDollar:`$${r.kellyDollar?.toFixed(0)||0}`,
      popMargin:r.popMargin?`${r.popMargin.toFixed(2)}x`:'', setupScore:`${r.setupScore}/100`,
      setupGrade:r.setup, regime:r.regime, wingStrikes:r.legs.map(l=>l.strike).join(' / '),
      marketBehaviour:r.behaviour,
      notes: [
        isOverride ? `Override: engine=${r.bestStrat}, selected=${effectiveStrat}` : '',
        `Score ${compositeScore}/100 | FV ${r.fairValueScore}/100 (${r.fairValueGrade})`,
        `Kelly ${(r.adjustedKelly*100).toFixed(1)}% | Vol ${r.volFactor?.toFixed(2)} | Sharpe ${r.sharpeFactor?.toFixed(2)} | Strat ${r.stratModifier?.toFixed(2)}`,
        ncd > 0 ? `Credit $${ncd.toFixed(2)}` : ncd < 0 ? `Debit $${Math.abs(ncd).toFixed(2)}` : '',
        `POP ${inp.pop||'--'}% | Win $${inp.win||'--'} | Risk $${inp.risk||'--'}`,
        r.legs.map(l => `${l.strike} ${l.label}`).join(' | ')
      ].filter(Boolean).join('\n'),
      price:fv(inp,'price'), vix:fv(inp,'vix'),
      vix1d:is0?fv(inp,'vix1d'):0, iv:is0?0:fv(inp,'iv'), ivr:is0?0:fv(inp,'ivr'),
      em:is0?fv(inp,'em'):0, timestamp:new Date().toISOString(),
      account: accountConfig?.id || '',
      // Expiry info for tracking
      dte: is0 ? '0DTE' : '45DTE',
      expiryDate: is0 ? new Date().toISOString().split('T')[0] : '' // 0DTE expires today
    });
  }

  return (
    <div className="space-y-4">
      {/* Decision Block */}
      <div style={{background:dcBg,border:`1px solid ${dcBorder}`,borderRadius:12,padding:'16px 20px'}}>
        <div style={{display:'flex',gap:20,alignItems:'flex-start'}}>
          {/* Left: strategy info */}
          <div style={{flex:'1 1 auto',minWidth:0}}>
            <div style={{display:'flex',alignItems:'center',gap:8}}>
              <div style={{fontSize:12,fontWeight:700,color:dcColor,textTransform:'uppercase',letterSpacing:'0.06em'}}>{effectiveDecision}</div>
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
            </div>
            <div style={{fontSize:18,fontWeight:600,color:'#fff',marginTop:4}}>
              {r.hardBlocker || `${is0?i0.underlying:i45.underlying} — ${effectiveStrat} — ${r.contracts} contract${r.contracts!==1?'s':''}`}
            </div>
        {r.legs.length > 0 && (
          <div style={{marginTop:10}}>
            {r.legs.length === 4 && r.legs[0]?.label?.includes('VIX') ? (
              // Dual EM suggestions for spreads
              <div style={{display:'flex',flexDirection:'column',gap:6}}>
                <div style={{display:'flex',alignItems:'center',gap:8}}>
                  <span style={{fontSize:10,color:'#8b949e',width:50}}>EM(VIX):</span>
                  {r.legs.slice(0,2).map((l,i) => {
                    const isShort = l.label.toLowerCase().includes('short');
                    return (<div key={i} style={{padding:'5px 12px',borderRadius:8,fontSize:13,fontWeight:700,background:isShort?'#8b2025':'#0d2818',color:isShort?'#f85149':'#3fb950',fontFamily:'JetBrains Mono,monospace'}}>
                      {l.strike} <span style={{fontSize:10,fontWeight:400,opacity:0.8}}>{l.label.replace(' (VIX)','')}</span>
                    </div>);
                  })}
                </div>
                <div style={{display:'flex',alignItems:'center',gap:8}}>
                  <span style={{fontSize:10,color:'#8b949e',width:50}}>EM(1D):</span>
                  {r.legs.slice(2,4).map((l,i) => {
                    const isShort = l.label.toLowerCase().includes('short');
                    return (<div key={i} style={{padding:'5px 12px',borderRadius:8,fontSize:13,fontWeight:700,background:isShort?'#8b2025':'#0d2818',color:isShort?'#f85149':'#3fb950',fontFamily:'JetBrains Mono,monospace'}}>
                      {l.strike} <span style={{fontSize:10,fontWeight:400,opacity:0.8}}>{l.label.replace(' (VIX1D)','')}</span>
                    </div>);
                  })}
                </div>
              </div>
            ) : (
              // Standard leg display
              <div style={{display:'flex',flexWrap:'wrap',gap:'8px'}}>
                {r.legs.map((l,i) => {
                  const isShort = l.label.toLowerCase().includes('short');
                  return (<div key={i} style={{padding:'5px 12px',borderRadius:8,fontSize:13,fontWeight:700,background:isShort?'#8b2025':'#0d2818',color:isShort?'#f85149':'#3fb950',fontFamily:'JetBrains Mono,monospace'}}>
                    {l.strike} <span style={{fontSize:10,fontWeight:400,opacity:0.8}}>{l.label}</span>
                  </div>);
                })}
              </div>
            )}
            {(r.wingTxt || r.strikeLine) && <div style={{fontSize:11,color:'#8b949e',marginTop:4}}>{r.wingTxt || r.strikeLine}</div>}
          </div>
        )}
        <div style={{fontSize:13,color:'#c9d1d9',marginTop:6}}>
          {!r.hardBlocker && `${is0?r.dirLabel:'—'} — ${r.trendPattern||'—'} — Adj Kelly $${r.kellyDollar?.toFixed(0)||0} — Score ${compositeScore}/100`}
        </div>
        {r.behaviour && <div style={{fontSize:12,color:'#c9d1d9',marginTop:6,paddingTop:6,borderTop:'1px solid #30363d',fontStyle:'italic'}}>Profit if: {r.behaviour}</div>}
        {!r.hardBlocker && bannerGrade !== 'weak' && !missingInputs && (
          <button onClick={handleLog} style={{marginTop:10,padding:'6px 16px',borderRadius:8,border:'none',background:'#238636',color:'#fff',fontSize:13,fontWeight:600,cursor:'pointer'}}>Log trade</button>
        )}
        <button onClick={handlePrint} style={{marginTop:10,marginLeft:8,padding:'6px 16px',borderRadius:8,border:'1px solid #30363d',background:'transparent',color:'#c9d1d9',fontSize:12,cursor:'pointer'}}>Print summary</button>
        {isOverride && (
          <button onClick={() => setOverrideStrat(null)} style={{marginTop:10,marginLeft:8,padding:'6px 16px',borderRadius:8,border:'1px solid #30363d',background:'transparent',color:'#8b949e',fontSize:12,cursor:'pointer'}}>Clear override</button>
        )}
          </div>
          {/* Right: mini payoff diagram */}
          {r.payoff && r.payoff.points.length > 0 && (
            <div style={{flex:'0 0 280px',minWidth:240}}>
              <PayoffDiagram payoff={r.payoff} currentPrice={is0?fv(i0,'price'):fv(i45,'price')} mini />
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        {/* ── INPUTS PANEL ── */}
        <div className="card" style={{maxHeight:'calc(100vh - 360px)',overflowY:'auto'}}>

          {/* Market Data */}
          <div className="flex items-center justify-between">
            <SectionLabel info="Price, high, low from your chart or auto-filled from IBKR. VWAP 5 and 15 with 30-min ago values for slope calculation. SPX uses SPY VWAP ×10 automatically.">Market data</SectionLabel>
            <div className="flex items-center gap-2">
              <button onClick={handleLoadFromTWS} disabled={loadingTws}
                title="Load an open option position from TWS into the ticket, then pull market data"
                style={{padding:'3px 10px',borderRadius:6,border:'1px solid #30363d',background:loadingTws?'#161b22':'transparent',color:loadingTws?'#8b949e':'#3fb950',fontSize:11,fontWeight:600,cursor:'pointer'}}>
                {loadingTws ? 'Loading…' : '📥 Load position (TWS)'}
              </button>
              {is0 && (
                <button onClick={handleAutoFill} disabled={autoFilling}
                  style={{padding:'3px 10px',borderRadius:6,border:'1px solid #30363d',background:autoFilling?'#161b22':'transparent',color:autoFilling?'#8b949e':'#2f81f7',fontSize:11,fontWeight:600,cursor:'pointer'}}>
                  {autoFilling ? 'Fetching...' : '⚡ Auto-fill'}
                </button>
              )}
            </div>
          </div>
          {twsStructures && twsStructures.length > 1 && (
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
          )}
          <div className="grid grid-cols-2 gap-2.5">
            <Sel label="Underlying" value={is0?i0.underlying:i45.underlying} onChange={v=>is0?set0('underlying',v):set45('underlying',v)} options={UNDERLYING_LIST}/>
            <Inp label="Price" value={is0?i0.price:i45.price} onChange={v=>is0?set0('price',v):set45('price',v)}/>
            {is0 ? <>
              <Inp label="Day high" value={i0.high} onChange={v=>set0('high',v)}/>
              <Inp label="Day low" value={i0.low} onChange={v=>set0('low',v)}/>
              <Inp label={`VWAP 5${vwapScaled ? ' (SPY→x10)' : ''}`} value={i0.vwap5} onChange={v=>set0('vwap5',v)}/>
              <Inp label={`VWAP 5 -30min${vwapScaled ? ' (x10)' : ''}`} value={i0.vwap5_30} onChange={v=>set0('vwap5_30',v)}/>
              <Inp label={`VWAP 15${vwapScaled ? ' (x10)' : ''}`} value={i0.vwap15} onChange={v=>set0('vwap15',v)}/>
              <Inp label={`VWAP 15 -30min${vwapScaled ? ' (x10)' : ''}`} value={i0.vwap15_30} onChange={v=>set0('vwap15_30',v)}/>
              <Inp label="EM" value={i0.em} onChange={v=>set0('em',v)}/>
              <Inp label="ATR 1 Day" value={i0.atr} onChange={v=>set0('atr',v)}/>
              <Inp label="ATR 5m" value={i0.atr5} onChange={v=>set0('atr5',v)}/>
              <Inp label="ATR 2h" value={i0.atr2h} onChange={v=>set0('atr2h',v)}/>
              <Inp label="VIX" value={i0.vix} onChange={v=>set0('vix',v)}/>
              <Inp label="VIX1D" value={i0.vix1d} onChange={v=>set0('vix1d',v)}/>
            </> : <>
              <Inp label="IV Rank (%)" value={i45.ivr} onChange={v=>set45('ivr',v)}/>
              <Inp label="IV (%)" value={i45.iv} onChange={v=>set45('iv',v)}/>
              <Inp label="HV (%)" value={i45.hv} onChange={v=>set45('hv',v)}/>
              <Inp label="VIX" value={i45.vix} onChange={v=>set45('vix',v)}/>
              <Inp label="IV Front" value={i45.ivFront} onChange={v=>set45('ivFront',v)}/>
              <Inp label="IV Back" value={i45.ivBack} onChange={v=>set45('ivBack',v)}/>
              <Inp label="Skew (%)" value={i45.skew} onChange={v=>set45('skew',v)}/>
              <Sel label="Term bias" value={i45.termBias} onChange={v=>set45('termBias',v)} options={TERM_BIASES}/>
              <Inp label="DTE" value={i45.dte} onChange={v=>set45('dte',v)}/>
              <Sel label="Outlook" value={i45.outlook} onChange={v=>set45('outlook',v)} options={OUTLOOKS}/>
            </>}
          </div>

          {/* ES Overnight (0DTE only) */}
          {is0 && (
            <>
              <SectionLabel info="ES futures data for overnight analysis. Prior Close = yesterday's 4pm settle. Pre-open = current ES price. Overnight High/Low = session range. ES EM = expected move for ES. Used for move consumed and continuation/reversal detection.">ES Overnight</SectionLabel>
              <div className="grid grid-cols-2 gap-2.5">
                <Inp label="ES Prior Close" value={i0.priorDayClose} onChange={v=>set0('priorDayClose',v)}/>
                <Inp label="ES Pre-open" value={i0.esClose} onChange={v=>set0('esClose',v)}/>
                <Inp label="ES Overnight High" value={i0.esOvernightHigh} onChange={v=>set0('esOvernightHigh',v)}/>
                <Inp label="ES Overnight Low" value={i0.esOvernightLow} onChange={v=>set0('esOvernightLow',v)}/>
                <Inp label="ES EM" value={i0.esEM} onChange={v=>set0('esEM',v)}/>
                <Inp label={i0.underlying + ' Open'} value={i0.cashOpen} onChange={v=>set0('cashOpen',v)}/>
              </div>
            </>
          )}

          {/* Sizing */}
          <SectionLabel info="Net credit/debit from your broker order preview — positive for credit, negative for debit. Label and box colour change automatically. POP = probability of profit (red if below breakeven POP). Win = max profit, Risk = max loss per contract (red if exceeds Kelly $). Credit/debit tape shows where your fill sits vs target range. Profit targets show TWS limit order values at 25/30/40/50/75/100%. Butterfly debit blocked above 55% of wing width.">Trade sizing</SectionLabel>
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="text-xs text-text-muted block mb-1">{(() => {
                const v = parseFloat(is0?i0.netCreditDebit:i45.netCreditDebit);
                if (v > 0) return 'Net credit ($)';
                if (v < 0) return 'Net debit ($)';
                // No value yet — hint from the strategy's expected type.
                return cashType === 'credit' ? 'Net credit ($) — expected'
                  : cashType === 'debit' ? 'Net debit ($) — expected'
                  : 'Net credit/debit ($)';
              })()}</label>
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
            <Inp label="Win amount ($)" value={is0?i0.win:i45.win} onChange={v=>is0?set0('win',v):set45('win',v)}/>
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
            </div>
          </div>
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
            <ProfitScale netCreditDebit={parseFloat(is0?i0.netCreditDebit:i45.netCreditDebit)} isCredit={parseFloat(is0?i0.netCreditDebit:i45.netCreditDebit) > 0} />
          )}

          {/* Greeks */}
          <div className="flex items-center justify-between">
            <SectionLabel info="Enter from your broker's position Greeks, or fetch live from TWS. Theta = daily dollar decay. Delta = price sensitivity. Gamma = delta acceleration. Gamma strike = price where gamma is highest (pin magnet). Used for trade survivability analysis (Directional Edge).">Greeks (optional)</SectionLabel>
            <button onClick={handleFetchGreeks} disabled={fetchingGreeks}
              title="Fetch model Greeks for the computed strikes from TWS via the bridge"
              style={{padding:'3px 10px',borderRadius:6,border:'1px solid #30363d',background:fetchingGreeks?'#161b22':'transparent',color:fetchingGreeks?'#8b949e':'#2f81f7',fontSize:11,fontWeight:600,cursor:'pointer'}}>
              {fetchingGreeks ? 'Fetching…' : '⚡ Fetch Greeks (TWS)'}
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            {is0 ? <>
              <Inp label="Theta ($)" value={i0.theta} onChange={v=>set0('theta',v)}/>
              <Inp label="Delta" value={i0.delta} onChange={v=>set0('delta',v)}/>
              <Inp label="Gamma" value={i0.gamma} onChange={v=>set0('gamma',v)}/>
              <Inp label="Gamma strike" value={i0.gamStrike} onChange={v=>set0('gamStrike',v)}/>
              <Inp label="Lower wing Δ" value={i0.lowerWingDelta} onChange={v=>set0('lowerWingDelta',v)}/>
              <Inp label="Upper wing Δ" value={i0.upperWingDelta} onChange={v=>set0('upperWingDelta',v)}/>
            </> : <>
              <Inp label="Theta ($)" value={i45.theta} onChange={v=>set45('theta',v)}/>
              <Inp label="Vega ($)" value={i45.vega} onChange={v=>set45('vega',v)}/>
              <Inp label="Delta" value={i45.delta} onChange={v=>set45('delta',v)}/>
              {!is0 && <Inp label="BPR ($)" value={i45.bpr} onChange={v=>set45('bpr',v)}/>}
            </>}
          </div>
          {is0 && r.pMaxLoss != null && (
            <div style={{marginTop:8,padding:'8px 10px',borderRadius:8,background:'#0d1117',border:'1px solid #21262d',fontSize:11,lineHeight:1.5,color:'#8b949e'}}>
              <span style={{color:'#c9d1d9',fontWeight:600}}>P(max loss): {(r.pMaxLoss*100).toFixed(1)}%</span>
              <span style={{marginLeft:6,padding:'1px 6px',borderRadius:4,fontSize:9,fontWeight:600,
                background: r.pMaxLossSource==='blend'?'#0d2818':r.pMaxLossSource==='delta'?'#1f1a0d':'#161b22',
                color: r.pMaxLossSource==='blend'?'#3fb950':r.pMaxLossSource==='delta'?'#d29922':'#8b949e'}}>
                {r.pMaxLossSource==='blend'?'MODEL + DELTA':r.pMaxLossSource==='delta'?'DELTA (skew)':'MODEL (flat vol)'}
              </span>
              <div style={{marginTop:4}}>
                {r.pMaxLossModel!=null && <>Model {(r.pMaxLossModel*100).toFixed(1)}% (VIX1D, flat)</>}
                {r.pMaxLossDelta!=null && <> · Delta {(r.pMaxLossDelta*100).toFixed(1)}% (real IV + skew)</>}
                {r.pMaxLossDelta==null && <> · enter wing Δ above for skew-aware cross-check</>}
              </div>
              {r.pMaxLossLow!=null && r.pMaxLossHigh!=null && (
                <div style={{marginTop:2,color:'#6e7681'}}>Down tail {(r.pMaxLossLow*100).toFixed(1)}% · Up tail {(r.pMaxLossHigh*100).toFixed(1)}%</div>
              )}
            </div>
          )}
        </div>

        {/* ── RESULTS PANEL ── */}
        <div className="space-y-4" style={{maxHeight:'calc(100vh - 360px)',overflowY:'auto'}}>
          {/* Setup quality */}
          <div className="card">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold text-white uppercase tracking-wider flex items-center">Setup quality<Info text="9 criteria scored out of 100: Compression (20), Move consumed (20), Strategy fit (15), VWAP slope + 15m confirm (10), VIX gap (10), ES overnight direction (10), Overnight range (5), VWAP distance (5), Gamma distance (5). A+ = 85+, A = 70+, B = 50+, No setup = below 50." /></span>
              <div className="flex items-center gap-2">
                <span style={{background:sBg,color:sClr,padding:'3px 10px',borderRadius:20,fontSize:13,fontWeight:700}}>{r.setup}</span>
                <span className="mono" style={{background:sBg,color:sClr,padding:'3px 8px',borderRadius:6,fontSize:12,fontWeight:600}}>{r.setupScore}/100</span>
              </div>
            </div>
            {r.criteria.map((cr,i) => {
              const pct = cr.max>0?Math.round(cr.pts/cr.max*100):0;
              const bc = pct>=80?'#3fb950':pct>=50?'#2f81f7':pct>=30?'#d29922':'#f85149';
              return (<div key={i} className="flex items-center gap-2 mb-1">
                <span className="text-xs text-white truncate" style={{flex:'0 0 160px'}}>{cr.label}</span>
                <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{background:'#21262d'}}>
                  <div style={{width:`${pct}%`,height:'100%',background:bc,borderRadius:4,transition:'width 0.3s'}}/>
                </div>
                <span className="text-xs text-white mono" style={{flex:'0 0 36px',textAlign:'right'}}>{cr.pts}/{cr.max}</span>
              </div>);
            })}
          </div>

          {/* Strategy ratings */}
          <div className="card">
            <div className="flex items-center justify-between mb-1">
              <SectionLabel white info="Each strategy rated EXCELLENT, GOOD, MARGINAL, or NO TRADE based on current regime, direction strength, and move consumed. Click any MARGINAL+ strategy to override the engine recommendation. BWB preferred for strong direction, Asymmetric for mild, Standard butterfly for neutral.">Strategy ratings — {r.regime}</SectionLabel>
              {isOverride && <span style={{fontSize:10,color:'#d29922'}}>Override active</span>}
            </div>
            <div className="space-y-0.5">
              {r.ratings.map((s,i) => {
                const cls = s.rating==='EXCELLENT'?'badge-green':s.rating==='GOOD'?'badge-blue':s.rating==='MARGINAL'?'badge-amber':'badge-red';
                const clickable = s.rating !== 'NO TRADE';
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
                <div style={{fontSize:'10px',lineHeight:'1.4',color:'#8b949e',margin:'2px 0 10px',paddingLeft:'2px',whiteSpace:'normal'}}>
                  {r.evBasis.mode==='measured'
                    ? `EV from realized history: ${(r.evBasis.winP*100).toFixed(0)}% × $${r.evBasis.avgWin.toFixed(0)} − ${((1-r.evBasis.winP)*100).toFixed(0)}% × $${r.evBasis.avgLoss.toFixed(0)}`
                    : `EV estimated (capture ${(r.evBasis.winCap*100).toFixed(0)}%/${(r.evBasis.lossCap*100).toFixed(0)}% of max): ${(r.evBasis.winP*100).toFixed(0)}% × $${r.evBasis.avgWin.toFixed(0)} − ${((1-r.evBasis.winP)*100).toFixed(0)}% × $${r.evBasis.avgLoss.toFixed(0)}`}
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
                <SectionLabel white info="Three survivability gauges plus Directional Edge. Theta Edge = theta earned per unit of directional risk (0.15-0.40 sweet spot). Gamma Risk = how fast delta changes vs theta (< 0.70 safe). Max Tolerable Move = furthest price can move before theta consumed. Directional Edge = remaining expected move × delta vs remaining theta. For credit strategies, lower Edge Ratio is better (theta dominates). For debit strategies, higher is better (move dominates). Butterfly strategies transition through three phases: Approach (need movement to body), Transition (balanced), Collection (theta collecting). Thresholds tighten through the day as gamma accelerates.">Trade survivability</SectionLabel>
                {r.greeks.sweetSpot && <span style={{fontSize:10,fontWeight:600,padding:'2px 8px',borderRadius:4,background:'#0d1f0d',color:'#3fb950'}}>🎯 SWEET SPOT</span>}
              </div>
              <div className="space-y-3">
                <SpeedTape label="Theta Edge (Θ ÷ |Δ| × ATR)" value={Math.min(r.greeks.tEdge, 0.6)} min={0} max={0.6}
                  zones={[{to:0.05,color:'#f85149'},{to:0.15,color:'#d29922'},{to:0.30,color:'#e3b341'},{to:0.6,color:'#3fb950'}]}
                  display={r.greeks.tEdge.toFixed(3)}
                  sublabel={r.greeks.tEdgeSignal + ' — ' + r.greeks.tEdgeAction} />
                <SpeedTape label="Gamma Risk (Γ × ATR ÷ Θ)" value={Math.min(r.greeks.gRisk, 1.5)} min={0} max={1.5}
                  zones={[{to:0.30,color:'#3fb950'},{to:0.70,color:'#e3b341'},{to:1.20,color:'#d29922'},{to:1.5,color:'#f85149'}]}
                  display={r.greeks.gRisk.toFixed(3)}
                  sublabel={r.greeks.gRiskSignal + ' — ' + r.greeks.gRiskAction} />
                <SpeedTape label="Max tolerable move (ΔS_max)" value={Math.min(r.greeks.dsATR * 100, 200)} min={0} max={200}
                  zones={[{to:25,color:'#f85149'},{to:50,color:'#d29922'},{to:100,color:'#e3b341'},{to:200,color:'#3fb950'}]}
                  display={`${r.greeks.dsMax.toFixed(1)} pts (${(r.greeks.dsATR*100).toFixed(0)}% ATR)`}
                  sublabel={r.greeks.dsSignal + ' — ' + r.greeks.dsAction} />

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
                        <div className="text-[9px] text-[#8b949e]">Theta $</div>
                        <div className="mono text-sm font-bold text-white">${r.greeks.thetaPressure?.toFixed(0)}</div>
                        <div className="text-[8px] text-[#484f58]">to planned exit</div>
                      </div>
                      <div className="text-center p-2 rounded" style={{background: r.greeks.edgeSignal==='excellent'?'#0d2818':r.greeks.edgeSignal==='good'?'#0d1a0d':r.greeks.edgeSignal==='marginal'?'#1f1a0d':'#1f0d0d'}}>
                        <div className="text-[9px] text-[#8b949e]">Edge Ratio</div>
                        <div className="mono text-lg font-bold" style={{color: r.greeks.edgeSignal==='excellent'?'#3fb950':r.greeks.edgeSignal==='good'?'#7bc74d':r.greeks.edgeSignal==='marginal'?'#d29922':'#f85149'}}>{r.greeks.edgeRatio?.toFixed(2)}</div>
                      </div>
                    </div>
                    <SpeedTape label="Move / Theta" value={Math.min(r.greeks.edgeRatio, 4)} min={0} max={4}
                      zones={r.greeks.isCreditStrat
                        ? [{to:0.7,color:'#3fb950'},{to:1.0,color:'#e3b341'},{to:1.5,color:'#d29922'},{to:4,color:'#f85149'}]
                        : [{to:0.7,color:'#f85149'},{to:1.0,color:'#d29922'},{to:1.5,color:'#e3b341'},{to:4,color:'#3fb950'}]
                      }
                      display={r.greeks.edgeRatio?.toFixed(2)}
                      sublabel={r.greeks.edgeAction} />
                    <div className="text-[9px] text-[#484f58] mt-1">Time threshold: {r.greeks.edgeThreshold?.toFixed(1)} | {r.greeks.isCreditStrat ? 'Credit: lower = better' : r.greeks.isBflyCondor ? 'Butterfly: transitions through phases' : 'Debit: higher = better'}</div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 45DTE Directional Edge */}
          {!is0 && r.greeks && r.greeks.edgeRatio !== undefined && (
            <div className="card">
              <SectionLabel white info="Directional Edge for 45DTE trades. Compares expected directional P&L (delta × remaining expected move) against total theta earned over the holding period to 21 DTE exit. Remaining EM = price × IV × √(remaining DTE / 365). Credit sellers (IC, spreads): want Edge Ratio < 0.5 (theta strongly dominates over the holding period). Debit directional (bull call, calendars): want Edge Ratio > 2.0 (move potential exceeds decay). Theta efficiency = daily theta as % of buying power reduction. Vega/Theta = IV sensitivity per unit of decay — high ratio means IV changes matter more than time.">Directional Edge (45DTE)</SectionLabel>
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
                  <div className="text-[9px] text-[#8b949e]">Theta $ ({r.greeks.daysToExit}d)</div>
                  <div className="mono text-sm font-bold text-white">${r.greeks.thetaPressure?.toFixed(0)}</div>
                </div>
                <div className="text-center p-2 rounded" style={{background: r.greeks.edgeSignal==='excellent'?'#0d2818':'#0d1117'}}>
                  <div className="text-[9px] text-[#8b949e]">Edge Ratio</div>
                  <div className="mono text-lg font-bold" style={{color: r.greeks.edgeSignal==='excellent'?'#3fb950':r.greeks.edgeSignal==='good'?'#7bc74d':r.greeks.edgeSignal==='marginal'?'#d29922':'#f85149'}}>{r.greeks.edgeRatio?.toFixed(2)}</div>
                </div>
              </div>
              <SpeedTape label="Move / Theta" value={Math.min(r.greeks.edgeRatio, 4)} min={0} max={4}
                zones={r.greeks.isCreditStrat
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
                <KV label="EM(VIX)" value={`${r.emVIX} pts`}/>
                <KV label="EM(VIX1D)" value={`${r.emV1D} pts`}/>
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

function ProfitScale({ netCreditDebit, isCredit }) {
  const ncd = Math.abs(netCreditDebit);
  const pcts = [25, 30, 40, 50, 75, 100];
  const multiplier = 100; // options multiplier

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
          const profitPerShare = ncd * (pct / 100);
          const profitDollars = profitPerShare * multiplier;
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
              <div style={{fontSize:10,fontWeight:700,color: highlight ? '#3fb950' : '#c9d1d9'}}>{pct}%</div>
              <div style={{fontSize:12,fontWeight:700,color:'#e6edf3',fontFamily:'JetBrains Mono,monospace',marginTop:2}}>
                ${closePrice.toFixed(2)}
              </div>
              <div style={{fontSize:8,color:'#8b949e',marginTop:1}}>{closeType}</div>
              <div style={{fontSize:8,color: highlight ? '#3fb950' : '#8b949e',marginTop:1}}>+${profitDollars.toFixed(0)}</div>
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

function SectionLabel({ children, white, info }) {
  return (
    <div className={`text-xs font-semibold uppercase tracking-wider mt-4 mb-2 first:mt-0 flex items-center ${white ? 'text-white' : 'text-[#c9d1d9]'}`}>
      {children}
      {info && <Info text={info} />}
    </div>
  );
}

function Inp({label,value,onChange,type}) {
  return (<div><label className="text-[11px] text-[#c9d1d9] block mb-1">{label}</label>
    <input type={type||'number'} step="any" value={value||''} onChange={e=>onChange(e.target.value)} placeholder="—"
      className="w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-sm text-white mono outline-none focus:border-[#2f81f7]"/></div>);
}
function Sel({label,value,onChange,options}) {
  return (<div><label className="text-[11px] text-[#c9d1d9] block mb-1">{label}</label>
    <select value={value} onChange={e=>onChange(e.target.value)}
      className="w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-sm text-white outline-none focus:border-[#2f81f7]">
      {options.map(o=><option key={o} value={o}>{o}</option>)}</select></div>);
}
function KV({label,value,cls}) {
  return (<div className="flex justify-between py-1 border-b border-[#21262d] last:border-0">
    <span className="text-sm text-[#c9d1d9]">{label}</span>
    <span className={`text-sm font-semibold mono ${cls||'text-white'}`}>{value}</span></div>);
}
