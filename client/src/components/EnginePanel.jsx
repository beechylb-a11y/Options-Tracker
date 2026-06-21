import React, { useState, useMemo, useEffect } from 'react';
import { calc0DTE } from '../engine/calc0dte';
import { calc45DTE } from '../engine/calc45dte';
import { UNDERLYING_LIST } from '../engine/data';

const OUTLOOKS = ['neutral', 'bullish', 'bearish'];
const TERM_BIASES = ['contango', 'flat', 'backwardation'];

export default function EnginePanel({ mode, onLogTrade, accountConfig, prefillData, onPrefillConsumed }) {
  const is0 = mode === '0dte';
  const acfg = accountConfig || {};
  const defBankroll = acfg.bankroll || 3000;
  const defMaxLoss = acfg.maxDailyLoss || 300;
  const defMaxOpen = acfg.maxOpenRisk || 450;
  const [overrideStrat, setOverrideStrat] = useState(null);
  const [autoFilling, setAutoFilling] = useState(false);

  const [i0, setI0] = useState({
    underlying:'SPX', price:'', high:'', low:'', vwap5:'', vwap5_30:'', vwap15:'', vwap15_30:'',
    em:'', atr5:'', atr2h:'', atr:'',
    vix:'', vix1d:'',
    esOvernightHigh:'', esOvernightLow:'', esClose:'', priorDayClose:'', cashOpen:'', esEM:'',
    win:'', risk:'', pop:'', hours:'', netCreditDebit:'',
    theta:'', delta:'', gamma:'', gamStrike:'',
    bankroll:defBankroll, startBR:defBankroll, maxLoss:defMaxLoss, maxOpen:defMaxOpen
  });

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
          overrideStrategy: overrideStrat
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
          overrideStrategy: overrideStrat
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
  }, [is0, i0, i45, overrideStrat]);

  // Override: calc engine generates legs for overrideStrat if set
  const isOverride = overrideStrat && overrideStrat !== r.bestStrat;
  const effectiveStrat = r.legStrat || r.bestStrat;
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
        // Calculate hours remaining until 4pm ET (16:00 New York)
        const now = new Date();
        const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const marketClose = new Date(et);
        marketClose.setHours(16, 0, 0, 0);
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
      '<h2>' + (is0 ? r.dirLabel : r.outlook || '') + ' \u2014 max loss $' + (r.maxRisk ? r.maxRisk.toFixed(0) : '0') + ' \u2014 ' + r.setup + ' (' + r.setupScore + '/100)</h2>' +
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
      '<div class="row"><span class="label">EV / trade</span><span class="value ' + (r.ev > 0 ? 'green' : 'red') + '">$' + (r.ev ? r.ev.toFixed(0) : '0') + '</span></div>' +
      '<div class="row"><span class="label">POP margin</span><span class="value ' + (r.popMargin >= 1.5 ? 'green' : r.popMargin >= 1.0 ? 'amber' : 'red') + '">' + (r.popMargin ? r.popMargin.toFixed(2) : '--') + 'x</span></div>' +
      '</div>' +
      greeksHtml +
      '<div class="section"><div class="section-title">Fair Value Score — ' + r.fairValueScore + '/100 (' + r.fairValueGrade + ')</div>' +
      '<div class="row"><span class="label">Volatility (IV/HV)</span><span class="value white">' + r.volScore + '/100 — ' + r.volGrade + '</span></div>' +
      '<div class="row"><span class="label">Structure</span><span class="value white">' + r.structScore + '/100 — ' + r.structGrade + '</span></div>' +
      '<div class="row"><span class="label">Regime</span><span class="value white">' + r.regimeScore + '/100 — ' + r.regimeGrade + '</span></div>' +
      '</div>' +
      '<div class="section"><div class="section-title">Signals</div>' + signalsHtml + '</div>' +
      (warningsHtml ? '<div class="section"><div class="section-title">Warnings</div>' + warningsHtml + '</div>' : '') +
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
    const inp = is0 ? i0 : i45;
    onLogTrade({ engine:is0?'0DTE':'45DTE', underlying:inp.underlying,
      strategy:`${inp.underlying} - ${effectiveStrat} - ${r.contracts} contract${r.contracts!==1?'s':''}`,
      direction:effectiveDecision, contracts:r.contracts, kellyDollar:`$${r.kellyDollar?.toFixed(0)||0}`,
      popMargin:r.popMargin?`${r.popMargin.toFixed(2)}x`:'', setupScore:`${r.setupScore}/100`,
      setupGrade:r.setup, regime:r.regime, wingStrikes:r.legs.map(l=>l.strike).join(' / '),
      marketBehaviour:r.behaviour, notes:isOverride ? `Manual override: engine recommended ${r.bestStrat}, user selected ${effectiveStrat}` : '',
      price:fv(inp,'price'), vix:fv(inp,'vix'),
      vix1d:is0?fv(inp,'vix1d'):0, iv:is0?0:fv(inp,'iv'), ivr:is0?0:fv(inp,'ivr'),
      em:is0?fv(inp,'em'):0, timestamp:new Date().toISOString() });
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
            <SectionLabel>Market data</SectionLabel>
            {is0 && (
              <button onClick={handleAutoFill} disabled={autoFilling}
                style={{padding:'3px 10px',borderRadius:6,border:'1px solid #30363d',background:autoFilling?'#161b22':'transparent',color:autoFilling?'#8b949e':'#2f81f7',fontSize:11,fontWeight:600,cursor:'pointer'}}>
                {autoFilling ? 'Fetching...' : '⚡ Auto-fill'}
              </button>
            )}
          </div>
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
              <SectionLabel>ES Overnight</SectionLabel>
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
          <SectionLabel>Trade sizing</SectionLabel>
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="text-xs text-text-muted block mb-1">{r.targetIsCredit ? 'Net credit ($)' : 'Net debit ($)'}</label>
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
          {r.targetMax > 0 && (
            <CreditTape
              value={Math.abs(parseFloat(is0?i0.netCreditDebit:i45.netCreditDebit)||0)}
              low={r.targetLow}
              high={r.targetHigh}
              max={r.targetMax}
              isCredit={r.targetIsCredit}
              label={r.targetLabel}
            />
          )}
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
                <div style={{fontSize:9,color:'#484f58',marginTop:2}}>Auto: 4pm ET minus current time</div>
              </div>
            </div>
          )}

          {/* Profit target scale */}
          {(parseFloat(is0?i0.netCreditDebit:i45.netCreditDebit) || 0) !== 0 && (
            <ProfitScale netCreditDebit={parseFloat(is0?i0.netCreditDebit:i45.netCreditDebit)} isCredit={r.targetIsCredit} />
          )}

          {/* Greeks */}
          <SectionLabel>Greeks (optional)</SectionLabel>
          <div className="grid grid-cols-2 gap-2.5">
            {is0 ? <>
              <Inp label="Theta ($)" value={i0.theta} onChange={v=>set0('theta',v)}/>
              <Inp label="Delta" value={i0.delta} onChange={v=>set0('delta',v)}/>
              <Inp label="Gamma" value={i0.gamma} onChange={v=>set0('gamma',v)}/>
              <Inp label="Gamma strike" value={i0.gamStrike} onChange={v=>set0('gamStrike',v)}/>
            </> : <>
              <Inp label="Theta ($)" value={i45.theta} onChange={v=>set45('theta',v)}/>
              <Inp label="Vega ($)" value={i45.vega} onChange={v=>set45('vega',v)}/>
              <Inp label="Delta" value={i45.delta} onChange={v=>set45('delta',v)}/>
              {!is0 && <Inp label="BPR ($)" value={i45.bpr} onChange={v=>set45('bpr',v)}/>}
            </>}
          </div>
        </div>

        {/* ── RESULTS PANEL ── */}
        <div className="space-y-4" style={{maxHeight:'calc(100vh - 360px)',overflowY:'auto'}}>
          {/* Setup quality */}
          <div className="card">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold text-white uppercase tracking-wider">Setup quality</span>
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
              <SectionLabel white>Strategy ratings — {r.regime}</SectionLabel>
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
                  <span className="text-sm text-white">{s.name}</span>
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
              <SectionLabel white>Payoff at expiry</SectionLabel>
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
            <SectionLabel white>Sizing (Sharpe-adjusted Kelly)</SectionLabel>
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
                sublabel={r.ev>100?'Excellent':r.ev>50?'Good':r.ev>0?'Marginal':'No edge'} />
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

          {/* Greeks Analysis — Theta Edge, Gamma Risk, Max Move */}
          {is0 && r.greeks && (
            <div className="card">
              <div className="flex items-center justify-between mb-2">
                <SectionLabel white>Trade survivability</SectionLabel>
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
              </div>
            </div>
          )}

          {/* Regime */}
          <div className="card">
            <SectionLabel white>Regime</SectionLabel>
            <div className="text-sm font-semibold text-white">{is0 ? r.regime : `${r.regime} — ${r.outlook||''}`}</div>
            <div className="text-xs text-[#c9d1d9] mt-1.5 leading-relaxed">{is0 ? `${r.regimeConds||''} — ${r.regimeCommentary||''}` : r.regimeCommentary||''}</div>
          </div>

          {/* Fair Value Score */}
          {is0 && r.fairValueScore !== undefined && (
            <div className="card">
              <div className="flex items-center justify-between mb-2">
                <SectionLabel white>Fair Value Score</SectionLabel>
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
            <SectionLabel white>Signals</SectionLabel>
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

function SectionLabel({ children, white }) {
  return <div className={`text-xs font-semibold uppercase tracking-wider mt-4 mb-2 first:mt-0 ${white ? 'text-white' : 'text-[#c9d1d9]'}`}>{children}</div>;
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
