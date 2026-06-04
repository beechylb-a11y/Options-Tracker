import React, { useState, useMemo } from 'react';
import { calc0DTE } from '../engine/calc0dte';
import { calc45DTE } from '../engine/calc45dte';
import { UNDERLYING_LIST } from '../engine/data';

const SLOPES = ['flat', 'mild', 'strong'];
const OUTLOOKS = ['neutral', 'bullish', 'bearish'];
const TERM_BIASES = ['contango', 'flat', 'backwardation'];

export default function EnginePanel({ mode, onLogTrade }) {
  const is0 = mode === '0dte';

  const [i0, setI0] = useState({
    underlying:'SPX',price:0,high:0,low:0,vwap:0,atr:0,em:0,atr5:0,atr2h:0,
    gamStrike:0,slope:'flat',vix:0,vix1d:0,bankroll:3000,startBR:3000,
    risk:435,maxLoss:300,win:65,maxOpen:450,pop:0,theta:0,delta:0,gamma:0,hours:6.5
  });
  const [i45, setI45] = useState({
    underlying:'SPX',price:0,ivr:0,iv:0,hv:0,vix:0,ivFront:0,ivBack:0,skew:0,
    termBias:'contango',dte:45,outlook:'neutral',pop:0,win:65,risk:435,
    bankroll:3000,startBR:3000,maxLoss:300,maxOpen:450,bpr:0,theta:0,vega:0,delta:0
  });

  const set0 = (k,v) => setI0(p => ({...p,[k]:v}));
  const set45 = (k,v) => setI45(p => ({...p,[k]:v}));
  const fv = (o,k) => parseFloat(o[k]) || 0;

  const r = useMemo(() => {
    if (is0) return calc0DTE({...i0,price:fv(i0,'price'),high:fv(i0,'high'),low:fv(i0,'low'),vwap:fv(i0,'vwap'),atr:fv(i0,'atr'),em:fv(i0,'em'),atr5:fv(i0,'atr5'),atr2h:fv(i0,'atr2h'),gamStrike:fv(i0,'gamStrike'),vix:fv(i0,'vix'),vix1d:fv(i0,'vix1d'),bankroll:fv(i0,'bankroll'),startBR:fv(i0,'startBR'),risk:fv(i0,'risk'),maxLoss:fv(i0,'maxLoss'),win:fv(i0,'win'),maxOpen:fv(i0,'maxOpen'),pop:fv(i0,'pop'),theta:fv(i0,'theta'),delta:fv(i0,'delta'),gamma:fv(i0,'gamma'),hours:fv(i0,'hours'),underlying:i0.underlying,slope:i0.slope});
    else return calc45DTE({...i45,price:fv(i45,'price'),ivr:fv(i45,'ivr'),iv:fv(i45,'iv'),hv:fv(i45,'hv'),vix:fv(i45,'vix'),ivFront:fv(i45,'ivFront'),ivBack:fv(i45,'ivBack'),skew:fv(i45,'skew'),dte:fv(i45,'dte')||45,pop:fv(i45,'pop'),win:fv(i45,'win'),risk:fv(i45,'risk'),bankroll:fv(i45,'bankroll'),startBR:fv(i45,'startBR'),maxLoss:fv(i45,'maxLoss'),maxOpen:fv(i45,'maxOpen'),bpr:fv(i45,'bpr'),theta:fv(i45,'theta'),vega:fv(i45,'vega'),delta:fv(i45,'delta'),underlying:i45.underlying,termBias:i45.termBias,outlook:i45.outlook});
  }, [is0, i0, i45]);

  const dcBg = r.decisionClass==='go'?'#0d1f0d':r.decisionClass==='warn'?'#1f1a0d':'#1f0d0d';
  const dcBorder = r.decisionClass==='go'?'#238636':r.decisionClass==='warn'?'#9e6a03':'#da3633';
  const dcColor = r.decisionClass==='go'?'#3fb950':r.decisionClass==='warn'?'#d29922':'#f85149';
  const sBg = r.setupScore>=85?'#0d1f0d':r.setupScore>=70?'#0d1a2e':r.setupScore>=50?'#1f1a0d':'#1f0d0d';
  const sClr = r.setupScore>=85?'#3fb950':r.setupScore>=70?'#2f81f7':r.setupScore>=50?'#d29922':'#f85149';

  function handleLog() {
    if (!onLogTrade) return;
    const inp = is0 ? i0 : i45;
    onLogTrade({ engine:is0?'0DTE':'45DTE', underlying:inp.underlying,
      strategy:`${inp.underlying} - ${r.bestStrat} - ${r.contracts} contract${r.contracts!==1?'s':''}`,
      direction:r.decision, contracts:r.contracts, kellyDollar:`$${r.kellyDollar?.toFixed(0)||0}`,
      popMargin:r.popMargin?`${r.popMargin.toFixed(2)}x`:'', setupScore:`${r.setupScore}/100`,
      setupGrade:r.setup, regime:r.regime, wingStrikes:r.legs.map(l=>l.strike).join(' / '),
      marketBehaviour:r.behaviour, notes:'', price:fv(inp,'price'), vix:fv(inp,'vix'),
      vix1d:is0?fv(inp,'vix1d'):0, iv:is0?0:fv(inp,'iv'), ivr:is0?0:fv(inp,'ivr'),
      em:is0?fv(inp,'em'):0, timestamp:new Date().toISOString() });
  }

  return (
    <div className="space-y-3">
      {/* Decision Block */}
      <div style={{background:dcBg,border:`1px solid ${dcBorder}`,borderRadius:10,padding:'12px 16px'}}>
        <div style={{fontSize:10,fontWeight:600,color:dcColor,textTransform:'uppercase',letterSpacing:'0.05em'}}>{r.decision}</div>
        <div style={{fontSize:16,fontWeight:500,color:'#e6edf3',marginTop:2}}>
          {r.hardBlocker || `${is0?i0.underlying:i45.underlying} - ${r.bestStrat} - ${r.contracts} contract${r.contracts!==1?'s':''}`}
        </div>
        {r.legs.length > 0 && (
          <div style={{display:'flex',flexWrap:'wrap',gap:'6px 8px',marginTop:8}}>
            {r.legs.map((l,i) => {
              const isShort = l.label.toLowerCase().includes('short');
              return (<div key={i} style={{padding:'3px 10px',borderRadius:6,fontSize:11,fontWeight:600,background:isShort?'#238636':'#0d1a2e',color:isShort?'#e6edf3':'#2f81f7',fontFamily:'JetBrains Mono,monospace'}}>
                {l.strike} <span style={{fontSize:9,fontWeight:400,opacity:0.7}}>{l.label}</span>
              </div>);
            })}
            {r.wingTxt && <span style={{fontSize:10,color:'#484f58',alignSelf:'center'}}>{r.wingTxt || r.strikeLine}</span>}
          </div>
        )}
        <div style={{fontSize:11,color:'#8b949e',marginTop:4}}>
          {!r.hardBlocker && `${is0?r.dirLabel:r.outlook||''} — max loss $${r.maxRisk?.toFixed(0)||0}`}
          {r.warnings?.length>0 && ` — ${r.warnings[0]}`}
        </div>
        {r.behaviour && <div style={{fontSize:11,color:'#8b949e',marginTop:4,paddingTop:4,borderTop:'0.5px solid #30363d',fontStyle:'italic'}}>Profit if: {r.behaviour}</div>}
        {!r.hardBlocker && r.decision !== 'Enter sizing' && (
          <button onClick={handleLog} style={{marginTop:8,padding:'4px 12px',borderRadius:6,border:'0.5px solid #238636',background:'#238636',color:'#fff',fontSize:11,fontWeight:500,cursor:'pointer'}}>Log trade</button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        {/* Inputs */}
        <div className="card" style={{maxHeight:'calc(100vh - 340px)',overflowY:'auto'}}>
          <div className="text-[10px] text-text-faint uppercase tracking-wider mb-2">Market inputs</div>
          <div className="grid grid-cols-2 gap-2">
            <Sel label="Underlying" value={is0?i0.underlying:i45.underlying} onChange={v=>is0?set0('underlying',v):set45('underlying',v)} options={UNDERLYING_LIST}/>
            <Inp label="Price" value={is0?i0.price:i45.price} onChange={v=>is0?set0('price',v):set45('price',v)}/>
            {is0 ? <>
              <Inp label="Day high" value={i0.high} onChange={v=>set0('high',v)}/>
              <Inp label="Day low" value={i0.low} onChange={v=>set0('low',v)}/>
              <Inp label="VWAP" value={i0.vwap} onChange={v=>set0('vwap',v)}/>
              <Inp label="ATR" value={i0.atr} onChange={v=>set0('atr',v)}/>
              <Inp label="EM" value={i0.em} onChange={v=>set0('em',v)}/>
              <Inp label="ATR 5m" value={i0.atr5} onChange={v=>set0('atr5',v)}/>
              <Inp label="ATR 2h" value={i0.atr2h} onChange={v=>set0('atr2h',v)}/>
              <Inp label="Gamma strike" value={i0.gamStrike} onChange={v=>set0('gamStrike',v)}/>
              <Sel label="VWAP Slope (5 min)" value={i0.slope} onChange={v=>set0('slope',v)} options={SLOPES}/>
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
          <div className="text-[10px] text-text-faint uppercase tracking-wider mt-3 mb-2">Sizing</div>
          <div className="grid grid-cols-2 gap-2">
            <Inp label="Bankroll ($)" value={is0?i0.bankroll:i45.bankroll} onChange={v=>is0?set0('bankroll',v):set45('bankroll',v)}/>
            <Inp label="Risk/contract ($)" value={is0?i0.risk:i45.risk} onChange={v=>is0?set0('risk',v):set45('risk',v)}/>
            <Inp label="Win amount ($)" value={is0?i0.win:i45.win} onChange={v=>is0?set0('win',v):set45('win',v)}/>
            <Inp label="POP (%)" value={is0?i0.pop:i45.pop} onChange={v=>is0?set0('pop',v):set45('pop',v)}/>
            <Inp label="Max daily loss ($)" value={is0?i0.maxLoss:i45.maxLoss} onChange={v=>is0?set0('maxLoss',v):set45('maxLoss',v)}/>
            <Inp label="Max open risk ($)" value={is0?i0.maxOpen:i45.maxOpen} onChange={v=>is0?set0('maxOpen',v):set45('maxOpen',v)}/>
            {!is0 && <Inp label="BPR ($)" value={i45.bpr} onChange={v=>set45('bpr',v)}/>}
          </div>
          <div className="text-[10px] text-text-faint uppercase tracking-wider mt-3 mb-2">Greeks (optional)</div>
          <div className="grid grid-cols-2 gap-2">
            {is0 ? <>
              <Inp label="Theta ($)" value={i0.theta} onChange={v=>set0('theta',v)}/>
              <Inp label="Delta" value={i0.delta} onChange={v=>set0('delta',v)}/>
              <Inp label="Gamma" value={i0.gamma} onChange={v=>set0('gamma',v)}/>
              <Inp label="Hours left" value={i0.hours} onChange={v=>set0('hours',v)}/>
            </> : <>
              <Inp label="Theta ($)" value={i45.theta} onChange={v=>set45('theta',v)}/>
              <Inp label="Vega ($)" value={i45.vega} onChange={v=>set45('vega',v)}/>
              <Inp label="Delta" value={i45.delta} onChange={v=>set45('delta',v)}/>
            </>}
          </div>
        </div>

        {/* Results */}
        <div className="space-y-3" style={{maxHeight:'calc(100vh - 340px)',overflowY:'auto'}}>
          <div className="card">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] text-text-faint uppercase tracking-wider">Setup quality</span>
              <div className="flex items-center gap-2">
                <span style={{background:sBg,color:sClr,padding:'2px 8px',borderRadius:20,fontSize:11,fontWeight:600}}>{r.setup}</span>
                <span className="mono" style={{background:sBg,color:sClr,padding:'2px 6px',borderRadius:4,fontSize:10}}>{r.setupScore}/100</span>
              </div>
            </div>
            {r.criteria.map((cr,i) => {
              const pct = cr.max>0?Math.round(cr.pts/cr.max*100):0;
              const bc = pct>=80?'#3fb950':pct>=50?'#2f81f7':pct>=30?'#d29922':'#f85149';
              return (<div key={i} className="flex items-center gap-1.5 mb-0.5">
                <span className="text-[9px] text-text-muted truncate" style={{flex:'0 0 140px'}}>{cr.label}</span>
                <div className="flex-1 h-1 rounded-full overflow-hidden" style={{background:'#21262d'}}>
                  <div style={{width:`${pct}%`,height:'100%',background:bc,borderRadius:3,transition:'width 0.3s'}}/>
                </div>
                <span className="text-[9px] text-text-muted mono" style={{flex:'0 0 30px',textAlign:'right'}}>{cr.pts}/{cr.max}</span>
              </div>);
            })}
          </div>

          <div className="card">
            <div className="text-[10px] text-text-faint uppercase tracking-wider mb-2">Strategy ratings — {r.regime}</div>
            <div className="space-y-0.5">
              {r.ratings.map((s,i) => {
                const cls = s.rating==='EXCELLENT'?'badge-green':s.rating==='GOOD'?'badge-blue':s.rating==='MARGINAL'?'badge-amber':'badge-red';
                return (<div key={i} className="flex items-center justify-between py-1">
                  <span className="text-xs text-text">{s.name}</span>
                  <span className={`badge text-[9px] ${cls}`}>{s.rating}</span>
                </div>);
              })}
            </div>
          </div>

          <div className="card">
            <div className="text-[10px] text-text-faint uppercase tracking-wider mb-2">Kelly sizing</div>
            <div className="grid grid-cols-2 gap-1 text-xs">
              <KV label="Contracts" value={r.contracts}/>
              <KV label="Kelly $" value={`$${r.kellyDollar?.toFixed(0)||0}`} cls={r.kellyOverRisk?'text-red':'text-green'}/>
              <KV label="POP margin" value={r.popMargin?`${r.popMargin.toFixed(2)}x`:'--'} cls={r.popMargin>=1.5?'text-green':r.popMargin>=1.0?'text-amber':'text-red'}/>
              <KV label="W/L ratio" value={r.wlRatio?.toFixed(2)||'--'}/>
              <KV label="Full Kelly" value={`${(r.kelly*100).toFixed(1)}%`}/>
              <KV label="BE POP" value={r.bePop?`${(r.bePop*100).toFixed(1)}%`:'--'}/>
            </div>
          </div>

          <div className="card">
            <div className="text-[10px] text-text-faint uppercase tracking-wider mb-1">Regime</div>
            <div className="text-sm font-medium text-text">{is0 ? r.regime : `${r.regime} — ${r.outlook||''}`}</div>
            <div className="text-[10px] text-text-muted mt-1">{is0 ? `${r.regimeConds||''} — ${r.regimeCommentary||''}` : r.regimeCommentary||''}</div>
          </div>

          <div className="card">
            <div className="text-[10px] text-text-faint uppercase tracking-wider mb-2">Signals</div>
            <div className="grid grid-cols-2 gap-1 text-xs">
              {is0 ? <>
                <KV label="VIX1D/VIX gap" value={`${(r.vixGap*100).toFixed(1)}%`}/>
                <KV label="VIX grade" value={r.vixGrade}/>
                <KV label="Direction" value={r.dirLabel} cls={r.dirScore>0?'text-green':r.dirScore<0?'text-red':''}/>
                <KV label="RM ratio" value={r.rmRatio?`${(r.rmRatio*100).toFixed(0)}% EM`:'--'}/>
                <KV label="Compression" value={r.comp!==null?r.comp.toFixed(2):'--'}/>
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

function Inp({label,value,onChange}) {
  return (<div><label className="text-[9px] text-text-muted block mb-0.5">{label}</label>
    <input type="number" step="any" value={value||''} onChange={e=>onChange(e.target.value)}
      className="w-full px-2 py-1 bg-bg border border-bg-border rounded text-xs text-text mono outline-none focus:border-accent"/></div>);
}
function Sel({label,value,onChange,options}) {
  return (<div><label className="text-[9px] text-text-muted block mb-0.5">{label}</label>
    <select value={value} onChange={e=>onChange(e.target.value)}
      className="w-full px-2 py-1 bg-bg border border-bg-border rounded text-xs text-text outline-none focus:border-accent">
      {options.map(o=><option key={o} value={o}>{o}</option>)}</select></div>);
}
function KV({label,value,cls}) {
  return (<div className="flex justify-between py-0.5 border-b border-bg-border last:border-0">
    <span className="text-text-muted">{label}</span>
    <span className={`font-medium mono ${cls||'text-text'}`}>{value}</span></div>);
}
