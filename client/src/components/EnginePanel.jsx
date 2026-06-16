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
    win:'', risk:'', pop:'', hours:'6.5', netCreditDebit:'',
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
        overnightDir:'unknown', trendPattern:'unknown', wingTxt:'' };
    }
  }, [is0, i0, i45, overrideStrat]);

  // Override: calc engine generates legs for overrideStrat if set
  const isOverride = overrideStrat && overrideStrat !== r.bestStrat;
  const effectiveStrat = r.legStrat || r.bestStrat;
  const effectiveRating = isOverride ? (r.ratings.find(s => s.name === overrideStrat)?.rating || 'MARGINAL') : r.bestRating;
  const effectiveDecision = r.setup === 'No setup' ? 'No trade'
    : isOverride ? 'Trade with caution'
    : r.decision;
  const effectiveDecisionClass = r.setup === 'No setup' ? 'nogo'
    : isOverride ? 'warn'
    : r.decisionClass;

  const dcBg = effectiveDecisionClass==='go'?'#0d1f0d':effectiveDecisionClass==='warn'?'#1f1a0d':'#1f0d0d';
  const dcBorder = effectiveDecisionClass==='go'?'#238636':effectiveDecisionClass==='warn'?'#9e6a03':'#da3633';
  const dcColor = effectiveDecisionClass==='go'?'#3fb950':effectiveDecisionClass==='warn'?'#d29922':'#f85149';
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
          esEM: d.esEM || prev.esEM
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
      '.leg-short{background:#238636;color:#fff}.leg-long{background:#0d1a2e;color:#58a6ff}' +
      '.warn{font-size:12px;color:#d29922;margin:2px 0}' +
      '.timestamp{font-size:11px;color:#484f58;margin-top:24px}' +
      '@media print{body{background:#fff;color:#1a1a1a}.leg-long{color:#0d1a2e}}' +
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
                    return (<div key={i} style={{padding:'5px 12px',borderRadius:8,fontSize:13,fontWeight:700,background:isShort?'#238636':'#0d1a2e',color:isShort?'#fff':'#58a6ff',fontFamily:'JetBrains Mono,monospace'}}>
                      {l.strike} <span style={{fontSize:10,fontWeight:400,opacity:0.8}}>{l.label.replace(' (VIX)','')}</span>
                    </div>);
                  })}
                </div>
                <div style={{display:'flex',alignItems:'center',gap:8}}>
                  <span style={{fontSize:10,color:'#8b949e',width:50}}>EM(1D):</span>
                  {r.legs.slice(2,4).map((l,i) => {
                    const isShort = l.label.toLowerCase().includes('short');
                    return (<div key={i} style={{padding:'5px 12px',borderRadius:8,fontSize:13,fontWeight:700,background:isShort?'#238636':'#0d1a2e',color:isShort?'#fff':'#58a6ff',fontFamily:'JetBrains Mono,monospace'}}>
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
                  return (<div key={i} style={{padding:'5px 12px',borderRadius:8,fontSize:13,fontWeight:700,background:isShort?'#238636':'#0d1a2e',color:isShort?'#fff':'#58a6ff',fontFamily:'JetBrains Mono,monospace'}}>
                    {l.strike} <span style={{fontSize:10,fontWeight:400,opacity:0.8}}>{l.label}</span>
                  </div>);
                })}
              </div>
            )}
            {(r.wingTxt || r.strikeLine) && <div style={{fontSize:11,color:'#8b949e',marginTop:4}}>{r.wingTxt || r.strikeLine}</div>}
          </div>
        )}
        <div style={{fontSize:13,color:'#c9d1d9',marginTop:6}}>
          {!r.hardBlocker && `${is0?r.dirLabel:r.outlook||''} — max loss $${r.maxRisk?.toFixed(0)||0}`}
          {r.warnings?.length>0 && ` — ${r.warnings[0]}`}
        </div>
        {r.behaviour && <div style={{fontSize:12,color:'#c9d1d9',marginTop:6,paddingTop:6,borderTop:'1px solid #30363d',fontStyle:'italic'}}>Profit if: {r.behaviour}</div>}
        {!r.hardBlocker && effectiveDecision !== 'No trade' && effectiveDecision !== 'Enter sizing' && (
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
            <Inp label="Net credit/debit ($)" value={is0?i0.netCreditDebit:i45.netCreditDebit} onChange={v=>is0?set0('netCreditDebit',v):set45('netCreditDebit',v)}/>
            <Inp label="POP (%)" value={is0?i0.pop:i45.pop} onChange={v=>is0?set0('pop',v):set45('pop',v)}/>
            <Inp label="Win amount ($)" value={is0?i0.win:i45.win} onChange={v=>is0?set0('win',v):set45('win',v)}/>
            <Inp label="Risk / contract ($)" value={is0?i0.risk:i45.risk} onChange={v=>is0?set0('risk',v):set45('risk',v)}/>
          </div>
          {r.targetLabel && <div style={{fontSize:11,color:'#8b949e',marginTop:4,fontStyle:'italic'}}>{r.targetLabel}</div>}
          {is0 && (
            <div className="grid grid-cols-2 gap-2.5 mt-2">
              <Inp label="Hours remaining" value={i0.hours} onChange={v=>set0('hours',v)}/>
            </div>
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
            <div className="grid grid-cols-2 gap-1.5">
              <KV label="Contracts" value={r.contracts}/>
              <KV label="Adj Kelly $" value={`$${r.kellyDollar?.toFixed(0)||0}`} cls={r.kellyOverRisk?'text-red':'text-green'}/>
              <KV label="Raw Kelly" value={`${(r.rawKelly*100).toFixed(1)}%`}/>
              <KV label="Adjusted Kelly" value={`${(r.adjustedKelly*100).toFixed(1)}%`} cls={r.adjustedKelly<r.rawKelly?'text-amber':''}/>
              <KV label="Vol factor" value={`${r.volFactor?.toFixed(2)||'--'}`} cls={r.volFactor<0.5?'text-amber':r.volFactor<1?'':'text-green'}/>
              <KV label="Sharpe factor" value={`${r.sharpeFactor?.toFixed(2)||'--'} (${r.sharpeProxy?.toFixed(2)||'--'})`} cls={r.sharpeFactor<0.5?'text-amber':r.sharpeFactor<1?'':'text-green'}/>
              <KV label="POP margin" value={r.popMargin?`${r.popMargin.toFixed(2)}x`:'--'} cls={r.popMargin>=1.5?'text-green':r.popMargin>=1.0?'text-amber':'text-red'}/>
              <KV label="W/L ratio" value={r.wlRatio?.toFixed(2)||'--'}/>
              <KV label="EV / trade" value={r.ev?`$${r.ev.toFixed(0)}`:'--'} cls={r.ev>0?'text-green':r.ev<0?'text-red':''}/>
              <KV label="BE POP" value={r.bePop?`${(r.bePop*100).toFixed(1)}%`:'--'}/>
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
                {/* Theta Edge */}
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-[#c9d1d9]">Theta Edge (Θ ÷ |Δ| × ATR)</span>
                    <span className={`mono text-sm font-bold ${r.greeks.tEdge>=0.15?'text-green':r.greeks.tEdge>=0.05?'text-amber':'text-red'}`}>{r.greeks.tEdge.toFixed(3)}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${r.greeks.tEdgeSignal==='weak'?'bg-red/10 text-red':r.greeks.tEdgeSignal==='marginal'?'bg-amber/10 text-amber':'bg-green/10 text-green'}`}>{r.greeks.tEdgeSignal}</span>
                    <span className="text-[10px] text-[#8b949e]">{r.greeks.tEdgeAction}</span>
                  </div>
                </div>

                {/* Gamma Risk */}
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-[#c9d1d9]">Gamma Risk (Γ × ATR ÷ Θ)</span>
                    <span className={`mono text-sm font-bold ${r.greeks.gRisk<0.30?'text-green':r.greeks.gRisk<0.70?'text-amber':r.greeks.gRisk<1.20?'text-amber':'text-red'}`}>{r.greeks.gRisk.toFixed(3)}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${r.greeks.gRiskSignal==='low'?'bg-green/10 text-green':r.greeks.gRiskSignal==='moderate'?'bg-amber/10 text-amber':'bg-red/10 text-red'}`}>{r.greeks.gRiskSignal}</span>
                    <span className="text-[10px] text-[#8b949e]">{r.greeks.gRiskAction}</span>
                  </div>
                </div>

                {/* Max Tolerable Move */}
                <div style={{borderTop:'1px solid #21262d', paddingTop:8}}>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-[#c9d1d9]">Max tolerable move (ΔS_max)</span>
                    <div className="flex items-center gap-2">
                      <span className="mono text-sm font-bold text-white">{r.greeks.dsMax.toFixed(1)} pts</span>
                      <span className={`mono text-xs font-semibold ${r.greeks.dsATR>0.50?'text-green':r.greeks.dsATR>0.25?'text-amber':'text-red'}`}>{(r.greeks.dsATR*100).toFixed(0)}% ATR</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${r.greeks.dsSignal==='strong'||r.greeks.dsSignal==='good'?'bg-green/10 text-green':r.greeks.dsSignal==='marginal'?'bg-amber/10 text-amber':'bg-red/10 text-red'}`}>{r.greeks.dsSignal}</span>
                    <span className="text-[10px] text-[#8b949e]">{r.greeks.dsAction}</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Regime */}
          <div className="card">
            <SectionLabel white>Regime</SectionLabel>
            <div className="text-sm font-semibold text-white">{is0 ? r.regime : `${r.regime} — ${r.outlook||''}`}</div>
            <div className="text-xs text-[#c9d1d9] mt-1.5 leading-relaxed">{is0 ? `${r.regimeConds||''} — ${r.regimeCommentary||''}` : r.regimeCommentary||''}</div>
          </div>

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
  const H = mini ? 120 : 220;
  const PAD = mini ? { top: 8, right: 10, bottom: 20, left: 42 } : { top: 14, right: 15, bottom: 28, left: 55 };
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

  // Build green/red fill paths
  let greenPath = '';
  let redPath = '';
  let linePath = '';
  let prevAbove = null;
  pts.forEach((p, i) => {
    const px = x(p.price), py = y(p.pnl);
    linePath += (i === 0 ? 'M' : 'L') + px + ' ' + py + ' ';
  });

  // Simple fill: area between line and zero
  let fillAbove = 'M' + x(pts[0].price) + ' ' + zeroY + ' ';
  let fillBelow = 'M' + x(pts[0].price) + ' ' + zeroY + ' ';
  pts.forEach(p => {
    const px = x(p.price), py = y(p.pnl);
    fillAbove += 'L' + px + ' ' + (p.pnl > 0 ? py : zeroY) + ' ';
    fillBelow += 'L' + px + ' ' + (p.pnl < 0 ? py : zeroY) + ' ';
  });
  fillAbove += 'L' + x(pts[pts.length-1].price) + ' ' + zeroY + ' Z';
  fillBelow += 'L' + x(pts[pts.length-1].price) + ' ' + zeroY + ' Z';

  // Price axis labels
  const priceTicks = [];
  for (let i = 0; i <= 4; i++) {
    const p = minP + (maxP - minP) * (i / 4);
    priceTicks.push({ x: x(p), label: Math.round(p) });
  }

  return (
    <svg viewBox={'0 0 ' + W + ' ' + H} style={{width:'100%',height:'auto',overflow:'visible'}}>
      {/* Zero line */}
      <line x1={PAD.left} y1={zeroY} x2={W-PAD.right} y2={zeroY} stroke="#8b949e" strokeWidth="0.5" strokeDasharray="3,3"/>
      {/* Fill areas */}
      <path d={fillAbove} fill="#3fb950" fillOpacity="0.20" />
      <path d={fillBelow} fill="#f85149" fillOpacity="0.15" />
      {/* P&L line */}
      <path d={linePath} fill="none" stroke="#e6edf3" strokeWidth={mini ? 2 : 2.5} strokeLinejoin="round" />
      {/* Current price line */}
      {currentPrice > 0 && currentPrice >= minP && currentPrice <= maxP && (
        <>
          <line x1={x(currentPrice)} y1={PAD.top} x2={x(currentPrice)} y2={H-PAD.bottom} stroke="#2f81f7" strokeWidth="1" strokeDasharray="3,2"/>
          <text x={x(currentPrice)} y={PAD.top-1} textAnchor="middle" fill="#2f81f7" fontSize={fs} fontWeight="600">{Math.round(currentPrice)}</text>
        </>
      )}
      {/* Breakevens */}
      {payoff.breakevens?.map((be, i) => be >= minP && be <= maxP && (
        <g key={i}>
          <circle cx={x(be)} cy={zeroY} r={mini ? 2 : 3} fill="#d29922" />
          {!mini && <text x={x(be)} y={zeroY+10} textAnchor="middle" fill="#d29922" fontSize={fs} fontWeight="600">{be.toFixed(0)}</text>}
        </g>
      ))}
      {/* Max profit label */}
      {maxPnl > 0 && (() => {
        const maxPt = pts.reduce((best, p) => p.pnl > best.pnl ? p : best, pts[0]);
        return <text x={x(maxPt.price)} y={y(maxPt.pnl)-(mini?2:4)} textAnchor="middle" fill="#3fb950" fontSize={fs} fontWeight="600">{'+$' + maxPnl.toFixed(0)}</text>;
      })()}
      {/* Max loss label */}
      {minPnl < 0 && (() => {
        const minPt = pts.reduce((worst, p) => p.pnl < worst.pnl ? p : worst, pts[0]);
        return <text x={x(minPt.price)} y={y(minPt.pnl)+(mini?8:10)} textAnchor="middle" fill="#f85149" fontSize={fs} fontWeight="600">{'$' + minPnl.toFixed(0)}</text>;
      })()}
      {/* Axes */}
      <text x={PAD.left-3} y={zeroY+3} textAnchor="end" fill="#8b949e" fontSize={fs}>$0</text>
      {!mini && maxPnl > 0 && <text x={PAD.left-3} y={y(maxPnl)+3} textAnchor="end" fill="#8b949e" fontSize={fs}>${maxPnl.toFixed(0)}</text>}
      {!mini && minPnl < 0 && <text x={PAD.left-3} y={y(minPnl)+3} textAnchor="end" fill="#8b949e" fontSize={fs}>${minPnl.toFixed(0)}</text>}
      {priceTicks.map((t, i) => (
        <text key={i} x={t.x} y={H-(mini?4:5)} textAnchor="middle" fill="#8b949e" fontSize={fs}>{t.label}</text>
      ))}
    </svg>
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
