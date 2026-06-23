import React, { useState } from 'react';
import { BookOpen, CheckSquare, Layers, CreditCard, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';

// ═══════════════════════════════════════════
//  STRATEGY CARD DATA
// ═══════════════════════════════════════════
const STRATEGIES = [
  {
    name: 'Iron Condor - Normal', type: 'Credit', legs: 4, dte: '0DTE / 45DTE',
    structure: 'Four legs: buy an OTM put (lower wing), sell a closer put, sell a closer call, buy an OTM call (upper wing). Creates a profit zone between the two short strikes with defined risk at both wings.',
    setup: 'Neutral outlook, RM < 50% EM, rich or neutral VIX gap, flat VWAP slope',
    profit: 'Price stays calmly between short put and short call. Low realised movement.',
    risk: 'Large directional move through either short strike. Gap risk overnight (45DTE).',
    manage: 'Close at 50% max profit (45DTE) or let expire (0DTE). Roll tested side if breached.',
    greeks: 'Short delta-neutral, short gamma, long theta, short vega',
    tags: ['neutral', 'credit', 'defined risk']
  },
  {
    name: 'Chicken Condor', type: 'Credit', legs: 4, dte: '0DTE',
    structure: 'Four legs like an iron condor but asymmetric: the wing on the directional side is wider (more room), the opposite wing is tighter. Skews risk toward the less likely direction.',
    setup: 'Mild directional bias, RM < 50% EM, any VIX gap. Widen the threatened side.',
    profit: 'Price stays very contained inside short strikes. No late breakout.',
    risk: 'Move through the tight (directional) side. Less risk on the wide side.',
    manage: 'Close if tested. The asymmetry gives extra room on the high-conviction side.',
    greeks: 'Slightly directional delta, short gamma, long theta',
    tags: ['directional', 'credit', 'defined risk']
  },
  {
    name: 'Broken Wing Butterfly', type: 'Debit/Even', legs: 3, dte: '0DTE / 45DTE',
    structure: 'Three legs, all puts or all calls: buy one at the near wing, sell two at the body strike, buy one at a wider far wing (1.75x). The broken wing reduces cost but adds directional risk on the near side.',
    setup: 'RM 50-100% EM, compression developing, gamma strike nearby. VIX1D cheap favourable.',
    profit: 'Price moves toward body strike and stalls. Avoid fast move through the risk wing.',
    risk: 'Fast move through the broken (wider) wing. Max loss on one side only.',
    manage: 'Close at 50% of max value or if price moves past body strike aggressively.',
    greeks: 'Directional delta, long gamma near body, theta depends on position',
    tags: ['directional', 'debit', 'defined risk']
  },
  {
    name: 'Asymmetric Butterfly', type: 'Debit', legs: 3, dte: '0DTE',
    structure: 'Three legs, all same type: buy one at the near wing, sell two at the body, buy one at a 1.5x wider far wing. Moderate asymmetry between standard butterfly and BWB — directional bias with less skew.',
    setup: 'RM 75-100% EM, strong directional bias, compression. Similar to BWB but more biased.',
    profit: 'Price moves toward the profit zone body. No aggressive overshoot through risk side.',
    risk: 'Move through the narrow wing. Directional conviction must be correct.',
    manage: 'Close at target or if price reverses away from profit zone.',
    greeks: 'Directional delta, moderate gamma exposure',
    tags: ['directional', 'debit', 'defined risk']
  },
  {
    name: 'Standard Butterfly', type: 'Debit', legs: 3, dte: '0DTE / 45DTE',
    structure: 'Three legs, all same type: buy one below the body, sell two at the body strike (near ATM), buy one above. Equal wing widths create a symmetric tent-shaped payoff centered on the body strike.',
    setup: 'RM 75-100% EM, strong compression, gamma strike pinning, flat VWAP slope.',
    profit: 'Price pins near the middle short strike by expiry.',
    risk: 'Any significant move away from body strike. Loses value if price trends.',
    manage: 'Close at 50% of max value. Exit if price moves beyond wing width.',
    greeks: 'Delta-neutral at body, short gamma, long theta near expiry',
    tags: ['neutral', 'debit', 'defined risk']
  },
  {
    name: 'Long Condor - Reversed', type: 'Debit', legs: 4, dte: '0DTE',
    structure: 'Four legs: sell an OTM put (outer), buy a closer put (inner), buy a closer call (inner), sell an OTM call (outer). Opposite of iron condor — you pay a debit and profit from a large move in either direction.',
    setup: 'RM < 50% EM, expecting breakout or trend day. VIX1D cheap favourable (buying vol cheap).',
    profit: 'Price makes a large move beyond either inner long strike. Profits from breakout, trend day, or volatility expansion.',
    risk: 'Price stays range-bound between the two inner long strikes. Max loss = net debit paid.',
    manage: 'Close winning side at 50%+ profit. If range-bound near expiry, close to limit time decay.',
    greeks: 'Delta-neutral at entry, positive gamma (benefits from movement), negative theta (time decay hurts)',
    tags: ['neutral', 'debit', 'defined risk']
  },
  {
    name: 'Iron Butterfly', type: 'Credit', legs: 4, dte: '0DTE / 45DTE',
    structure: 'Four legs: buy an OTM put wing, sell a put at the money, sell a call at the money (same strike), buy an OTM call wing. Like an iron condor but with both short strikes at the same ATM price, creating maximum credit and a narrow profit peak.',
    setup: 'RM 75-100% EM, strong compression/pinning, flat VWAP, rich VIX gap.',
    profit: 'Price pins as close as possible to the central short strike within breakevens.',
    risk: 'Any move away from the body strike. Higher risk than IC due to ATM shorts.',
    manage: 'Close at 25-50% max profit. Wider breakevens than butterfly but less max profit.',
    greeks: 'Delta-neutral, very short gamma, maximum theta at body, short vega',
    tags: ['neutral', 'credit', 'defined risk']
  },
  {
    name: 'Bull Put Spread', type: 'Credit', legs: 2, dte: '0DTE / 45DTE',
    structure: 'Two legs: sell a put at a higher strike (closer to price), buy a put at a lower strike (further away). You receive a credit. The long put caps your max loss at the width between strikes minus credit received.',
    setup: 'Bullish bias, RM < 50% EM, rich VIX gap, mild-strong upward VWAP slope.',
    profit: 'Price stays above the short put. Sideways-to-higher after entry.',
    risk: 'Price drops below short put strike. Max loss = width minus credit.',
    manage: 'Close at 50% credit received or roll down if tested.',
    greeks: 'Positive delta, short gamma, long theta, short vega',
    tags: ['bullish', 'credit', 'defined risk']
  },
  {
    name: 'Bear Call Spread', type: 'Credit', legs: 2, dte: '0DTE / 45DTE',
    structure: 'Two legs: sell a call at a lower strike (closer to price), buy a call at a higher strike (further away). You receive a credit. The long call caps your max loss at the width minus credit received.',
    setup: 'Bearish bias, RM < 50% EM, rich VIX gap, mild-strong downward VWAP slope.',
    profit: 'Price stays below the short call. Sideways-to-lower after entry.',
    risk: 'Price rises above short call strike. Max loss = width minus credit.',
    manage: 'Close at 50% credit received or roll up if tested.',
    greeks: 'Negative delta, short gamma, long theta, short vega',
    tags: ['bearish', 'credit', 'defined risk']
  },
  {
    name: 'Bull Call Spread', type: 'Debit', legs: 2, dte: '0DTE / 45DTE',
    structure: 'Two legs: buy a call at a lower strike (closer to price), sell a call at a higher strike (further away). You pay a debit. Max profit is the width between strikes minus the debit paid. Needs price to rise.',
    setup: 'Bullish bias, RM < 40%, cheap VIX gap. Needs quick directional move.',
    profit: 'Price moves upward quickly through the long call toward the short call.',
    risk: 'Price stays flat or drops. Theta decay works against you.',
    manage: 'Close at 50-75% of max value. Exit quickly if direction is wrong.',
    greeks: 'Positive delta, long gamma (early), negative theta, long vega',
    tags: ['bullish', 'debit', 'defined risk']
  },
  {
    name: 'Bear Put Spread', type: 'Debit', legs: 2, dte: '0DTE / 45DTE',
    structure: 'Two legs: buy a put at a higher strike (closer to price), sell a put at a lower strike (further away). You pay a debit. Max profit is the width between strikes minus the debit paid. Needs price to fall.',
    setup: 'Bearish bias, RM < 40%, cheap VIX gap. Needs quick directional move.',
    profit: 'Price moves downward quickly through the long put toward the short put.',
    risk: 'Price stays flat or rises. Theta decay works against you.',
    manage: 'Close at 50-75% of max value. Exit quickly if direction is wrong.',
    greeks: 'Negative delta, long gamma (early), negative theta, long vega',
    tags: ['bearish', 'debit', 'defined risk']
  },
  {
    name: 'Calendar Spread', type: 'Debit', legs: 2, dte: '45DTE',
    structure: 'Two legs at the same strike but different expirations: sell the near-term option (faster decay), buy the longer-term option (slower decay). Profits from the front month decaying faster than the back month while price stays near the strike.',
    setup: 'IVR 10-30, contango term structure, neutral outlook, low skew.',
    profit: 'Price stays near the strike. Front month decays faster than back month.',
    risk: 'Large directional move or backwardation (front IV rising vs back).',
    manage: 'Close at 25-50% profit or when front month expires. Roll front month if flat.',
    greeks: 'Near delta-neutral, positive theta differential, long vega (back month)',
    tags: ['neutral', 'debit', '45dte']
  },
  {
    name: 'Diagonal Spread', type: 'Debit', legs: 2, dte: '45DTE',
    structure: 'Two legs at different strikes and expirations: buy a longer-dated call (60-90 DTE), sell a shorter-dated call (20-30 DTE) at a higher strike. Like a covered call using a LEAPS instead of stock. Profits from time spread and mild directional move.',
    setup: 'IVR moderate, contango, mild directional bias. Front month OTM short.',
    profit: 'Price drifts toward the short strike. Time spread earns theta differential.',
    risk: 'Fast move through short strike or large IV collapse in back month.',
    manage: 'Roll short leg at 50% profit or when tested. Manage like a covered call.',
    greeks: 'Mild directional delta, positive theta, mild long vega',
    tags: ['directional', 'debit', '45dte']
  },
  {
    name: 'Jade Lizard', type: 'Credit', legs: 3, dte: '45DTE',
    structure: 'Three legs: sell a naked put below price, then sell a bear call spread (short call + long call) above price. Total credit should exceed the call spread width, eliminating upside risk. Downside risk is the short put.',
    setup: 'IVR > 40, elevated skew, bullish-neutral. Total credit > call spread width.',
    profit: 'Price stays above short put. Total credit exceeds call spread width (no upside risk).',
    risk: 'Price drops below short put. Upside risk eliminated if credit > call width.',
    manage: 'Close at 50% credit. Roll put down if tested.',
    greeks: 'Positive delta, short gamma, long theta, short vega',
    tags: ['bullish', 'credit', '45dte']
  },
];

// ═══════════════════════════════════════════
//  TRADING RULES
// ═══════════════════════════════════════════
const RULES = [
  { category: 'Position sizing', rules: [
    'Never risk more than Kelly $ on a single trade',
    'Cap total open risk at max open risk setting',
    'B setups = half Kelly; A/A+ setups = full Kelly',
    'VIX > 25 = half-size override on all positions',
    'If risk per contract exceeds Kelly $, do not trade',
  ]},
  { category: 'Entry rules', rules: [
    'Only enter when decision engine shows "Trade" or "Trade with caution"',
    'Setup score must be ≥ 50 (B Setup minimum)',
    'All five scoring criteria should have data (no blanks)',
    'Confirm direction aligns with VWAP slope before entering directional trades',
    'For 0DTE: check compression ratio (ATR 5m/2h) — don\'t enter expanding markets with centred structures',
    'For 45DTE: check IVR ≥ 20 before selling premium; IVR < 20 = debit trades only',
  ]},
  { category: 'Exit rules', rules: [
    '0DTE: let winners expire or close at 80%+ of max profit',
    '45DTE: close credit trades at 50% of max profit',
    '45DTE: close debit trades at 50-75% of max value',
    'Exit losers at max loss per contract — no exceptions',
    'Close any position where gamma risk > 1.2x (0DTE)',
    'Close any position where theta edge < 0.05 (0DTE)',
  ]},
  { category: 'Portfolio rules', rules: [
    'Maximum 3 positions in the same underlying',
    'Maximum 3 positions in the same sector',
    'Keep portfolio delta within ±50',
    'Daily stop: close all positions if daily P&L hits max daily loss',
    'No new trades after 3 consecutive losses (wait for next session)',
    'Review every trade in the journal before the next trading session',
  ]},
  { category: 'Emotional rules', rules: [
    'Never revenge trade after a loss',
    'Don\'t increase size after a winning streak — reversion is coming',
    'If you feel anxious about a position, it\'s too big',
    'Walk away from the screen for 10 minutes after any emotional trade',
    'Log every decision engine entry — even if you don\'t trade',
    'Trust the system. The edge is in the process, not any single trade.',
  ]},
];

// ═══════════════════════════════════════════
//  PRE-TRADE CHECKLIST
// ═══════════════════════════════════════════
const CHECKLIST_0DTE = [
  { id: 'c01', text: 'Decision engine shows Trade or Trade with caution' },
  { id: 'c02', text: 'Setup score ≥ 50 (B Setup minimum)' },
  { id: 'c03', text: 'Confirmed VWAP slope direction aligns with strategy' },
  { id: 'c04', text: 'Checked ATR compression ratio (5m/2h)' },
  { id: 'c05', text: 'Checked VIX1D/VIX gap and VIX level' },
  { id: 'c06', text: 'Verified gamma strike distance' },
  { id: 'c07', text: 'Kelly $ ≥ risk per contract' },
  { id: 'c08', text: 'POP margin ≥ 1.0x (edge exists)' },
  { id: 'c09', text: 'Max open risk not exceeded' },
  { id: 'c10', text: 'Daily loss limit not hit' },
  { id: 'c11', text: 'No more than 3 consecutive losses today' },
  { id: 'c12', text: 'Logged the decision engine entry' },
];

const CHECKLIST_45DTE = [
  { id: 'd01', text: 'IVR ≥ 20 (or using debit strategy if IVR < 20)' },
  { id: 'd02', text: 'IV/HV ratio checked — selling premium only if IV > HV' },
  { id: 'd03', text: 'Term structure checked — no calendars in backwardation' },
  { id: 'd04', text: 'Setup score ≥ 50 (B Setup minimum)' },
  { id: 'd05', text: 'Theta efficiency ≥ 0.01 (theta/BPR)' },
  { id: 'd06', text: 'Kelly $ ≥ risk per contract' },
  { id: 'd07', text: 'POP margin ≥ 1.0x (edge exists)' },
  { id: 'd08', text: 'Not correlated with existing open positions' },
  { id: 'd09', text: 'Exit plan defined: take profit at __% and stop at __' },
  { id: 'd10', text: 'Logged the decision engine entry' },
];

// ═══════════════════════════════════════════
//  REGIME QUICK REFERENCE
// ═══════════════════════════════════════════
const REGIMES_0DTE = [
  { band: 'RM < 25%', colour: '#3fb950', strategies: 'Iron Condor, Chicken Condor, Credit spreads', note: 'Trend can still develop. Directional bias strong.' },
  { band: 'RM 25-50%', colour: '#3fb950', strategies: 'Iron Condor, Chicken Condor, Credit spreads, BWB', note: 'Neutral zone. Confirm direction before selecting.' },
  { band: 'RM 50-75%', colour: '#2f81f7', strategies: 'Long Condor, BWB, Asymmetric Butterfly', note: 'Transition zone. Mean reversion probability rising.' },
  { band: 'RM 75-100%', colour: '#d29922', strategies: 'Standard Butterfly, BWB, Iron Butterfly', note: 'Stabilization. Butterfly structures excel.' },
  { band: 'RM >100% compress', colour: '#a371f7', strategies: 'Standard Butterfly, BWB', note: 'EM exceeded + compression. Strong pin setup.' },
  { band: 'RM >100% expand', colour: '#f85149', strategies: 'Chicken Condor, BWB only', note: 'EM exceeded + expanding. Avoid centred structures.' },
];

export default function Knowledgebase() {
  const [section, setSection] = useState('strategies');
  const [checks0, setChecks0] = useState({});
  const [checks45, setChecks45] = useState({});
  const [expandedCard, setExpandedCard] = useState(null);
  const [filter, setFilter] = useState('all');

  const SECTIONS = [
    { id: 'strategies', label: 'Strategy cards', icon: CreditCard },
    { id: 'rules', label: 'Trading rules', icon: AlertTriangle },
    { id: 'checklist', label: 'Pre-trade checklist', icon: CheckSquare },
    { id: 'regimes', label: 'Regime reference', icon: Layers },
  ];

  const filteredStrategies = filter === 'all' ? STRATEGIES
    : STRATEGIES.filter(s => s.tags.includes(filter));

  return (
    <div className="fade-in">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="font-display text-2xl font-bold">Knowledgebase</h2>
          <p className="text-text-muted text-sm mt-0.5">Strategy reference, trading rules & checklists</p>
        </div>
        <div className="flex border border-bg-border rounded-lg overflow-hidden">
          {SECTIONS.map(s => (
            <button key={s.id} onClick={() => setSection(s.id)}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors ${section === s.id ? 'bg-accent text-white' : 'text-text-muted hover:text-text hover:bg-bg-hover'}`}>
              <s.icon size={12} /> {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── STRATEGY CARDS ── */}
      {section === 'strategies' && (
        <div>
          <div className="flex gap-2 mb-4 flex-wrap">
            {['all', 'credit', 'debit', 'neutral', 'bullish', 'bearish', 'defined risk', '45dte'].map(f => (
              <button key={f} onClick={() => setFilter(f)}
                className={`px-3 py-1 text-xs rounded-lg border transition-colors ${filter === f ? 'border-accent bg-accent/10 text-accent' : 'border-bg-border text-text-muted hover:bg-bg-hover'}`}>
                {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3">
            {filteredStrategies.map((s, i) => {
              const expanded = expandedCard === i;
              return (
                <div key={i} className="card cursor-pointer hover:border-accent/30 transition-colors"
                  onClick={() => setExpandedCard(expanded ? null : i)}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-medium text-text">{s.name}</h3>
                      <span className={`badge text-[9px] ${s.type === 'Credit' ? 'badge-green' : s.type === 'Debit' ? 'badge-red' : 'badge-amber'}`}>{s.type}</span>
                      <span className="text-[10px] text-text-faint">{s.legs} legs</span>
                    </div>
                    {expanded ? <ChevronUp size={14} className="text-text-faint" /> : <ChevronDown size={14} className="text-text-faint" />}
                  </div>

                  <div className="text-xs text-text-muted mb-2">{s.structure}</div>

                  <div className="flex gap-1 mb-2">
                    {s.tags.map(t => (
                      <span key={t} className="text-[9px] px-1.5 py-0.5 rounded bg-bg-hover text-text-faint">{t}</span>
                    ))}
                  </div>

                  {expanded && (
                    <div className="space-y-2 pt-2 border-t border-bg-border fade-in">
                      <div className="flex gap-4">
                        <div className="flex-1 space-y-2">
                          <CardRow label="When to use" value={s.setup} />
                          <CardRow label="Profit if" value={s.profit} cls="text-green" />
                          <CardRow label="Risk" value={s.risk} cls="text-red" />
                          <CardRow label="Management" value={s.manage} />
                          <CardRow label="Greeks profile" value={s.greeks} cls="text-accent" />
                          <div className="text-[10px] text-text-faint mt-1">DTE: {s.dte}</div>
                        </div>
                        <div style={{flex:'0 0 180px'}}>
                          <StrategyDiagram name={s.name} type={s.type} />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── TRADING RULES ── */}
      {section === 'rules' && (
        <div className="space-y-4">
          {RULES.map((group, i) => (
            <div key={i} className="card">
              <h3 className="text-sm font-medium text-text mb-3 flex items-center gap-2">
                <AlertTriangle size={14} className="text-amber" />
                {group.category}
              </h3>
              <div className="space-y-2">
                {group.rules.map((rule, j) => (
                  <div key={j} className="flex items-start gap-2.5">
                    <div className="w-5 h-5 rounded flex items-center justify-center bg-bg-hover text-text-faint text-[10px] font-medium flex-shrink-0 mt-0.5">
                      {j + 1}
                    </div>
                    <span className="text-sm text-text-muted">{rule}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── PRE-TRADE CHECKLIST ── */}
      {section === 'checklist' && (
        <div className="grid grid-cols-2 gap-4">
          <div className="card">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-text flex items-center gap-2">
                <CheckSquare size={14} className="text-accent" /> 0DTE Pre-Trade Checklist
              </h3>
              <button onClick={() => setChecks0({})} className="text-[10px] text-text-faint hover:text-text">Reset</button>
            </div>
            <div className="space-y-1">
              {CHECKLIST_0DTE.map(c => (
                <label key={c.id} className="flex items-center gap-2.5 py-1.5 cursor-pointer hover:bg-bg-hover rounded px-1 -mx-1 transition-colors">
                  <input type="checkbox" checked={!!checks0[c.id]}
                    onChange={() => setChecks0(prev => ({ ...prev, [c.id]: !prev[c.id] }))}
                    className="w-4 h-4 rounded border-bg-border accent-accent" />
                  <span className={`text-sm ${checks0[c.id] ? 'text-text-faint line-through' : 'text-text'}`}>{c.text}</span>
                </label>
              ))}
            </div>
            <ChecklistSummary checks={checks0} total={CHECKLIST_0DTE.length} />
          </div>

          <div className="card">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-medium text-text flex items-center gap-2">
                <CheckSquare size={14} className="text-accent" /> 45DTE Pre-Trade Checklist
              </h3>
              <button onClick={() => setChecks45({})} className="text-[10px] text-text-faint hover:text-text">Reset</button>
            </div>
            <div className="space-y-1">
              {CHECKLIST_45DTE.map(c => (
                <label key={c.id} className="flex items-center gap-2.5 py-1.5 cursor-pointer hover:bg-bg-hover rounded px-1 -mx-1 transition-colors">
                  <input type="checkbox" checked={!!checks45[c.id]}
                    onChange={() => setChecks45(prev => ({ ...prev, [c.id]: !prev[c.id] }))}
                    className="w-4 h-4 rounded border-bg-border accent-accent" />
                  <span className={`text-sm ${checks45[c.id] ? 'text-text-faint line-through' : 'text-text'}`}>{c.text}</span>
                </label>
              ))}
            </div>
            <ChecklistSummary checks={checks45} total={CHECKLIST_45DTE.length} />
          </div>
        </div>
      )}

      {/* ── REGIME REFERENCE ── */}
      {section === 'regimes' && (
        <div className="space-y-4">
          <div className="card">
            <h3 className="text-sm font-medium text-text mb-3 flex items-center gap-2">
              <Layers size={14} className="text-accent" /> 0DTE Regime Quick Reference
            </h3>
            <div className="space-y-2">
              {REGIMES_0DTE.map((r, i) => (
                <div key={i} className="flex items-start gap-3 py-2.5 border-b border-bg-border last:border-0">
                  <div className="flex-shrink-0 w-36">
                    <span className="text-xs font-medium px-2 py-1 rounded" style={{ background: r.colour + '15', color: r.colour, border: `0.5px solid ${r.colour}40` }}>
                      {r.band}
                    </span>
                  </div>
                  <div className="flex-1">
                    <div className="text-sm text-text">{r.strategies}</div>
                    <div className="text-xs text-text-muted mt-0.5">{r.note}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <h3 className="text-sm font-medium text-text mb-3 flex items-center gap-2">
              <Layers size={14} className="text-accent" /> 45DTE IVR Regime Quick Reference
            </h3>
            <div className="space-y-2">
              {[
                { band: 'IVR < 20', colour: '#f85149', strategies: 'Bull call, Bear put, Calendar, Diagonal', note: 'Premium cheap — debit trades or time spreads only.' },
                { band: 'IVR 20-40', colour: '#d29922', strategies: 'Calendar, Diagonal, Iron Condor, Credit spreads', note: 'Neutral environment — balanced approach.' },
                { band: 'IVR 40-60', colour: '#3fb950', strategies: 'Iron Condor, Credit spreads, BWB, Jade lizard', note: 'Premium rich — ideal for selling premium.' },
                { band: 'IVR > 60', colour: '#3fb950', strategies: 'Iron Condor, Jade lizard, BWB, Iron butterfly', note: 'Very rich — excellent premium selling. Check event risk.' },
                { band: 'Backwardation', colour: '#f85149', strategies: 'Defined risk credit spreads only', note: 'Term structure inverted — avoid calendars, reduce size.' },
              ].map((r, i) => (
                <div key={i} className="flex items-start gap-3 py-2.5 border-b border-bg-border last:border-0">
                  <div className="flex-shrink-0 w-36">
                    <span className="text-xs font-medium px-2 py-1 rounded" style={{ background: r.colour + '15', color: r.colour, border: `0.5px solid ${r.colour}40` }}>
                      {r.band}
                    </span>
                  </div>
                  <div className="flex-1">
                    <div className="text-sm text-text">{r.strategies}</div>
                    <div className="text-xs text-text-muted mt-0.5">{r.note}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <h3 className="text-sm font-medium text-text mb-3">VIX1D / VIX Gap Reference</h3>
            <div className="space-y-2">
              {[
                { band: '< -10% (cheap)', colour: '#f85149', note: 'Short-term vol cheap. Favour long gamma: BWB, Asymmetric, Long Condor.' },
                { band: '-10% to +10% (neutral)', colour: '#8b949e', note: 'Balanced. BWB, Asymmetric, Chicken Condor all viable.' },
                { band: '+10% to +25% (rich)', colour: '#3fb950', note: 'Short-term vol rich. Iron Condor, Iron Butterfly, Chicken Condor favoured.' },
                { band: '> +25% (very rich)', colour: '#d29922', note: 'Extremely rich — excellent premium selling but check for event risk.' },
              ].map((r, i) => (
                <div key={i} className="flex items-start gap-3 py-2.5 border-b border-bg-border last:border-0">
                  <div className="flex-shrink-0 w-44">
                    <span className="text-xs font-medium px-2 py-1 rounded" style={{ background: r.colour + '15', color: r.colour, border: `0.5px solid ${r.colour}40` }}>
                      {r.band}
                    </span>
                  </div>
                  <div className="text-sm text-text-muted">{r.note}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ───
function StrategyDiagram({ name, type }) {
  const W = 180, H = 100;
  const z = 50; // zero line Y
  const g = '#3fb950', r = '#f85149', gr = '#8b949e';

  // Each strategy has a characteristic payoff shape
  const shapes = {
    'Iron Condor - Normal': {
      // Flat loss left, slope up, flat profit, slope down, flat loss right
      path: 'M10 75 L40 75 L55 30 L125 30 L140 75 L170 75',
      fill: 'M55 50 L55 30 L125 30 L125 50 Z',
      fillLoss: 'M10 50 L10 75 L40 75 L55 50 Z,M125 50 L140 75 L170 75 L170 50 Z'
    },
    'Chicken Condor': {
      path: 'M10 75 L35 75 L50 30 L130 30 L145 75 L170 75',
      fill: 'M50 50 L50 30 L130 30 L130 50 Z',
      fillLoss: 'M10 50 L10 75 L35 75 L50 50 Z,M130 50 L145 75 L170 75 L170 50 Z'
    },
    'Broken wing butterfly': {
      // Asymmetric tent: steep left loss, peak, gradual right loss
      path: 'M10 70 L50 70 L90 15 L130 50 L170 70',
      fill: 'M50 50 L90 15 L130 50 Z',
      fillLoss: 'M10 50 L10 70 L50 70 L50 50 Z'
    },
    'Asymmetric butterfly': {
      path: 'M10 65 L45 65 L90 15 L135 65 L170 65',
      fill: 'M45 50 L90 15 L135 50 Z',
      fillLoss: 'M10 50 L10 65 L45 65 L45 50 Z'
    },
    'Standard butterfly': {
      // Symmetric tent
      path: 'M10 65 L50 65 L90 15 L130 65 L170 65',
      fill: 'M50 50 L90 15 L130 50 Z',
      fillLoss: 'M10 50 L10 65 L50 65 L50 50 Z,M130 50 L130 65 L170 65 L170 50 Z'
    },
    'Iron butterfly': {
      // V shape inverted - credit structure, profit at centre
      path: 'M10 75 L45 75 L90 15 L135 75 L170 75',
      fill: 'M45 50 L90 15 L135 50 Z',
      fillLoss: 'M10 50 L10 75 L45 75 L45 50 Z,M135 50 L135 75 L170 75 L170 50 Z'
    },
    'Long Condor - Reversed': {
      // Inverted iron condor - profit on wings, loss in middle
      path: 'M10 25 L40 25 L55 70 L125 70 L140 25 L170 25',
      fill: 'M10 50 L10 25 L40 25 L55 50 Z,M125 50 L140 25 L170 25 L170 50 Z',
      fillLoss: 'M55 50 L55 70 L125 70 L125 50 Z'
    },
    'Bull put spread': {
      // Flat loss left, slope up, flat profit right
      path: 'M10 75 L60 75 L110 25 L170 25',
      fill: 'M110 50 L110 25 L170 25 L170 50 Z',
      fillLoss: 'M10 50 L10 75 L60 75 L85 50 Z'
    },
    'Bear call spread': {
      // Flat profit left, slope down, flat loss right
      path: 'M10 25 L60 25 L110 75 L170 75',
      fill: 'M10 50 L10 25 L60 25 L85 50 Z',
      fillLoss: 'M110 50 L110 75 L170 75 L170 50 Z'
    },
    'Bull call spread': {
      // Flat loss left, slope up, flat profit right (debit)
      path: 'M10 65 L60 65 L110 20 L170 20',
      fill: 'M85 50 L110 20 L170 20 L170 50 Z',
      fillLoss: 'M10 50 L10 65 L60 65 L85 50 Z'
    },
    'Bear put spread': {
      // Flat profit left, slope down, flat loss right (debit)
      path: 'M10 20 L60 20 L110 65 L170 65',
      fill: 'M10 50 L10 20 L60 20 L85 50 Z',
      fillLoss: 'M85 50 L110 65 L170 65 L170 50 Z'
    },
  };

  // Find matching shape (partial match)
  let shape = null;
  for (const [key, val] of Object.entries(shapes)) {
    if (name.toLowerCase().includes(key.toLowerCase()) || key.toLowerCase().includes(name.toLowerCase().replace(' - reversed','').replace(' - normal',''))) {
      shape = val;
      break;
    }
  }
  if (!shape) {
    // Default: try to match by type
    if (type === 'Credit') shape = shapes['Iron Condor - Normal'];
    else shape = shapes['Standard butterfly'];
  }

  const lossPaths = (shape.fillLoss || '').split(',').filter(Boolean);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{width:'100%',height:'auto'}}>
      <text x={W/2} y={10} textAnchor="middle" fill="#8b949e" fontSize="8" fontWeight="600">Payoff at expiry</text>
      {/* Zero line */}
      <line x1="10" y1={z} x2="170" y2={z} stroke="#484f58" strokeWidth="0.5" strokeDasharray="2,2"/>
      <text x="6" y={z+3} textAnchor="end" fill="#484f58" fontSize="7">$0</text>
      {/* Green profit fill */}
      {shape.fill && <path d={shape.fill} fill={g} fillOpacity="0.2" />}
      {/* Red loss fill */}
      {lossPaths.map((lp, i) => <path key={i} d={lp} fill={r} fillOpacity="0.15" />)}
      {/* P&L line */}
      <path d={shape.path} fill="none" stroke="#e6edf3" strokeWidth="2" strokeLinejoin="round" />
      {/* Labels */}
      <text x="10" y={H-2} fill="#484f58" fontSize="7">Lower</text>
      <text x={W-10} y={H-2} textAnchor="end" fill="#484f58" fontSize="7">Higher</text>
      <text x={W/2} y={H-2} textAnchor="middle" fill="#484f58" fontSize="7">Price →</text>
    </svg>
  );
}

function CardRow({ label, value, cls }) {
  return (
    <div>
      <span className="text-[10px] text-text-faint uppercase tracking-wider">{label}</span>
      <div className={`text-xs mt-0.5 ${cls || 'text-text-muted'}`}>{value}</div>
    </div>
  );
}

function ChecklistSummary({ checks, total }) {
  const done = Object.values(checks).filter(Boolean).length;
  const pct = total > 0 ? Math.round(done / total * 100) : 0;
  const allDone = done === total;
  return (
    <div className="mt-3 pt-3 border-t border-bg-border">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-text-muted">{done}/{total} completed</span>
        <span className={`text-xs font-medium ${allDone ? 'text-green' : pct >= 80 ? 'text-amber' : 'text-text-faint'}`}>
          {allDone ? '✓ Ready to trade' : `${pct}%`}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-bg-border overflow-hidden">
        <div className={`h-full rounded-full transition-all ${allDone ? 'bg-green' : 'bg-accent'}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
