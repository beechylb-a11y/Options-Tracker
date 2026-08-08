import React, { useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight, Plus, X, Save, FileText, Camera, Edit3, Zap } from 'lucide-react';
import { api } from '../utils/api';
import { fmt$, fmtDate, pnlColor, localISODate } from '../utils/format';
import { filterTracker } from '../utils/stats';
import CloseTradeModal from '../components/CloseTradeModal';
import ErrorBanner from '../components/ErrorBanner';

export default function Journal({ authenticated, account }) {
  const [journal, setJournal] = useState([]);
  const [tracker, setTracker] = useState([]);
  const [decisions, setDecisions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDay, setSelectedDay] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [noteDate, setNoteDate] = useState('');
  const [noteText, setNoteText] = useState('');
  const [reviewText, setReviewText] = useState('');
  const [closingTrade, setClosingTrade] = useState(null);
  const [savingReview, setSavingReview] = useState(false);
  const [saveError, setSaveError] = useState(null);

  function loadData() {
    Promise.all([
      api.getJournal().catch(() => []),
      api.getTracker().catch(() => []),
      api.getDecisions().catch(() => [])
    ]).then(([j, t, d]) => {
      setJournal(j);
      setTracker(t);
      if (Array.isArray(d) && d.length > 0) {
        if (d[0]._rowIndex !== undefined) {
          setDecisions(d);
        } else if (Array.isArray(d[0])) {
          const headers = d[0];
          setDecisions(d.slice(1).map((row, idx) => {
            const obj = { _rowIndex: idx + 2, _raw: row };
            headers.forEach((h, i) => { obj[h] = row[i] || ''; });
            return obj;
          }));
        }
      }
      setLoading(false);
    });
  }

  useEffect(() => {
    if (!authenticated) { setLoading(false); return; }
    loadData();
  }, [authenticated]);

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const monthName = currentDate.toLocaleString('default', { month: 'long', year: 'numeric' });
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();

  // ── Build daily stats from BOTH TradeTracker AND closed Decision tickets ──
  const filteredTracker = filterTracker(tracker, account);
  const dayStats = {};

  // 1. CSV / TradeTracker trades
  filteredTracker.forEach(t => {
    if (t.Status === 'Open') return;
    const pnl = parseFloat(t['Total P&L ($)']) || 0;
    const wl = t['W / L'];
    const closeDate = (t['Close Date'] || '').split('T')[0];
    const entryDate = (t['Entry Date'] || '').split('T')[0];
    const d = closeDate || entryDate;
    if (!d) return;
    // Skip TICKET rows (they duplicate decision engine data)
    if ((t['Order #'] || '').startsWith('TICKET-')) return;
    if (!dayStats[d]) dayStats[d] = { pnl: 0, count: 0, wins: 0, losses: 0, csvCount: 0, ticketCount: 0 };
    dayStats[d].pnl += pnl;
    dayStats[d].count++;
    dayStats[d].csvCount++;
    if (wl === 'Win') dayStats[d].wins++;
    if (wl === 'Loss') dayStats[d].losses++;
  });

  // 2. Closed decision engine tickets (filtered by account)
  const accountDecisions = (!account || account === 'all') ? decisions : decisions.filter(d => {
    const decAccount = d.Account || '';
    return decAccount === account || !decAccount;
  });
  const closedDecisions = accountDecisions.filter(d => d.Status === 'Closed' && d['Actual P&L']);
  closedDecisions.forEach(d => {
    const closeDate = (d['Close Date'] || '').split('T')[0];
    const entryDate = d.Timestamp ? d.Timestamp.split('T')[0] : '';
    const dt = closeDate || entryDate;
    if (!dt) return;
    const pnl = parseFloat(d['Actual P&L']) || 0;
    const isWin = pnl >= 0;
    if (!dayStats[dt]) dayStats[dt] = { pnl: 0, count: 0, wins: 0, losses: 0, csvCount: 0, ticketCount: 0 };
    dayStats[dt].pnl += pnl;
    dayStats[dt].count++;
    dayStats[dt].ticketCount++;
    if (isWin) dayStats[dt].wins++;
    else dayStats[dt].losses++;
  });

  // 3. Open (unmatched) decision engine entries — show on calendar with indicator
  const openDecisions = accountDecisions.filter(d => d.Status !== 'Closed');
  openDecisions.forEach(d => {
    const entryDate = d.Timestamp ? d.Timestamp.split('T')[0] : '';
    if (!entryDate) return;
    if (!dayStats[entryDate]) dayStats[entryDate] = { pnl: 0, count: 0, wins: 0, losses: 0, csvCount: 0, ticketCount: 0, openCount: 0 };
    if (!dayStats[entryDate].openCount) dayStats[entryDate].openCount = 0;
    dayStats[entryDate].openCount++;
  });

  // ── Notes from Journal sheet ──
  const notesByDate = {};
  journal.forEach(j => {
    if (j.Notes && j.Date) {
      const d = j.Date.split('T')[0];
      if (!notesByDate[d]) notesByDate[d] = '';
      notesByDate[d] += (notesByDate[d] ? '\n' : '') + j.Notes;
    }
  });

  // ── Merge ──
  const calendarData = {};
  const allDates = new Set([...Object.keys(dayStats), ...Object.keys(notesByDate)]);
  allDates.forEach(d => {
    calendarData[d] = {
      pnl: dayStats[d]?.pnl || 0,
      count: dayStats[d]?.count || 0,
      wins: dayStats[d]?.wins || 0,
      losses: dayStats[d]?.losses || 0,
      csvCount: dayStats[d]?.csvCount || 0,
      ticketCount: dayStats[d]?.ticketCount || 0,
      notes: notesByDate[d] || ''
    };
  });

  function getTradesForDate(dateStr) {
    return filteredTracker.filter(t => {
      if ((t['Order #'] || '').startsWith('TICKET-')) return false;
      const entryDate = (t['Entry Date'] || '').split('T')[0];
      const closeDate = (t['Close Date'] || '').split('T')[0];
      return entryDate === dateStr || closeDate === dateStr;
    });
  }

  function getTicketsForDate(dateStr) {
    return closedDecisions.filter(d => {
      const closeDate = (d['Close Date'] || '').split('T')[0];
      const entryDate = d.Timestamp ? d.Timestamp.split('T')[0] : '';
      return closeDate === dateStr || entryDate === dateStr;
    });
  }

  function getOpenDecisionsForDate(dateStr) {
    return accountDecisions.filter(d => {
      if (d.Status === 'Closed') return false;
      if (!d.Timestamp) return false;
      try { return localISODate(new Date(d.Timestamp)) === dateStr; }
      catch (e) { return false; }
    });
  }

  // ── Calendar grid (visual weeks) + weekly / monthly summaries ──
  const dateStrFor = d => `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const cells = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  const weekRows = [];
  for (let i = 0; i < cells.length; i += 7) weekRows.push(cells.slice(i, i + 7));

  const weekStats = weekRows.map(row => {
    const s = { pnl: 0, trades: 0, wins: 0, losses: 0 };
    row.forEach(d => {
      if (!d) return;
      const data = dayStats[dateStrFor(d)];
      if (data) { s.pnl += data.pnl; s.trades += data.count; s.wins += data.wins; s.losses += data.losses; }
    });
    return s;
  });

  const maxAbsDayPnl = Math.max(0, ...cells.filter(Boolean).map(d => Math.abs(dayStats[dateStrFor(d)]?.pnl || 0)));

  const monthPnl = weekStats.reduce((s, w) => s + w.pnl, 0);
  const monthTrades = weekStats.reduce((s, w) => s + w.trades, 0);
  const monthWins = weekStats.reduce((s, w) => s + w.wins, 0);
  const monthLosses = weekStats.reduce((s, w) => s + w.losses, 0);
  const monthDecided = monthWins + monthLosses;

  function prevMonth() { setCurrentDate(new Date(year, month - 1, 1)); setSelectedDay(null); }
  function nextMonth() { setCurrentDate(new Date(year, month + 1, 1)); setSelectedDay(null); }
  function goToday() { const now = new Date(); setCurrentDate(now); setSelectedDay(localISODate(now)); }

  async function handleAddNote() {
    if (!noteDate) return;
    setSaveError(null);
    try {
      await api.addJournalEntry({ date: noteDate, notes: noteText, dayPnl: 0, tradesCount: 0, winCount: 0, lossCount: 0 });
      const updated = await api.getJournal();
      setJournal(updated);
      setShowAdd(false);
      setNoteText('');
    } catch (e) {
      console.error(e);
      setSaveError('Failed to save note' + (e.message ? `: ${e.message}` : ''));
    }
  }

  async function handleSaveReview() {
    if (!selectedDay) return;
    setSavingReview(true);
    setSaveError(null);
    try {
      await api.addJournalEntry({ date: selectedDay, notes: reviewText, dayPnl: 0, tradesCount: 0, winCount: 0, lossCount: 0 });
      const updated = await api.getJournal();
      setJournal(updated);
      setReviewText('');
    } catch (e) {
      console.error(e);
      setSaveError('Failed to save review' + (e.message ? `: ${e.message}` : ''));
    }
    setSavingReview(false);
  }

  if (!authenticated) return (<div className="fade-in"><h2 className="font-display text-2xl font-bold mb-2">Journal</h2><p className="text-text-muted">Connect Google to view journal.</p></div>);

  const selData = selectedDay ? calendarData[selectedDay] || null : null;
  const selDayTrades = selectedDay ? getTradesForDate(selectedDay) : [];
  const selDayTickets = selectedDay ? getTicketsForDate(selectedDay) : [];
  const selDayOpenDec = selectedDay ? getOpenDecisionsForDate(selectedDay) : [];
  const allClosedOnDay = [...selDayTrades.filter(t => t.Status !== 'Open'), ...selDayTickets];
  const selDayPnl = allClosedOnDay.reduce((s, t) => s + (parseFloat(t['Total P&L ($)'] || t['Actual P&L']) || 0), 0);
  const selDayWins = allClosedOnDay.filter(t => (t['W / L'] === 'Win') || (parseFloat(t['Actual P&L']) >= 0 && t['Actual P&L'])).length;
  const selDayLosses = allClosedOnDay.filter(t => (t['W / L'] === 'Loss') || (parseFloat(t['Actual P&L']) < 0)).length;

  return (<>
    <div className="fade-in">
      <div className="flex items-center justify-between mb-6">
        <h2 className="font-display text-2xl font-bold">Journal</h2>
        <button onClick={() => { setShowAdd(!showAdd); setNoteDate(localISODate(today)); }}
          className="flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-lg transition-colors">
          <Plus size={14} /> Add note
        </button>
      </div>

      {saveError && <ErrorBanner message={saveError} />}

      {showAdd && (
        <div className="card mb-4 fade-in">
          <div className="flex items-end gap-4">
            <div>
              <label className="text-xs text-text-muted block mb-1">Date</label>
              <input type="date" value={noteDate} onChange={e => setNoteDate(e.target.value)}
                className="px-3 py-1.5 bg-bg border border-bg-border rounded-lg text-sm text-text outline-none focus:border-accent" />
            </div>
            <div className="flex-1">
              <label className="text-xs text-text-muted block mb-1">Note</label>
              <input type="text" value={noteText} onChange={e => setNoteText(e.target.value)} placeholder="Entry rationale, market observations..."
                className="w-full px-3 py-1.5 bg-bg border border-bg-border rounded-lg text-sm text-text placeholder-text-faint outline-none focus:border-accent" />
            </div>
            <button onClick={handleAddNote} className="px-4 py-1.5 bg-green-dim text-white text-sm rounded-lg hover:bg-green transition-colors">Save</button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-2">
          <div className="card mb-4">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <button onClick={goToday} className="px-3 py-1 text-xs border border-bg-border rounded-lg hover:bg-bg-hover transition-colors">Today</button>
                <button onClick={prevMonth} className="p-1 hover:bg-bg-hover rounded"><ChevronLeft size={16} /></button>
                <button onClick={nextMonth} className="p-1 hover:bg-bg-hover rounded"><ChevronRight size={16} /></button>
              </div>
              <h3 className="font-display text-lg font-semibold">{monthName}</h3>
            </div>
            <div className="grid grid-cols-8 gap-1">
              {['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'WEEK'].map(d => (
                <div key={d} className="text-center text-[10px] text-text-faint uppercase tracking-wider py-2">{d}</div>
              ))}
              {weekRows.map((row, wi) => (
                <React.Fragment key={wi}>
                  {row.map((day, di) => {
                    if (day === null) return <div key={di} className="h-16" />;
                    const dateStr = dateStrFor(day);
                    const data = calendarData[dateStr];
                    const isToday = day === today.getDate() && month === today.getMonth() && year === today.getFullYear();
                    const isSelected = selectedDay === dateStr;
                    const isWeekend = di === 0 || di === 6;
                    const hasTrades = data && data.count > 0;
                    let borderCls = 'border-bg-border';
                    let bg;
                    if (hasTrades) {
                      if (data.pnl > 0) borderCls = 'border-green/40';
                      else if (data.pnl < 0) borderCls = 'border-red/40';
                      if (data.pnl !== 0 && maxAbsDayPnl > 0) {
                        const alpha = 0.08 + 0.37 * Math.min(1, Math.abs(data.pnl) / maxAbsDayPnl);
                        bg = data.pnl > 0 ? `rgba(63,185,80,${alpha.toFixed(3)})` : `rgba(248,81,73,${alpha.toFixed(3)})`;
                      }
                    }
                    const dimmed = isWeekend && !hasTrades && !data?.notes && !data?.openCount;
                    return (
                      <div key={di} onClick={() => setSelectedDay(isSelected ? null : dateStr)}
                        style={bg ? { backgroundColor: bg } : undefined}
                        className={`h-16 px-1.5 py-1 border rounded-lg relative transition-all cursor-pointer hover:border-accent/50 ${borderCls}${hasTrades && data.pnl === 0 ? ' bg-bg-hover' : ''}${isSelected ? ' ring-2 ring-accent' : ''}${dimmed ? ' opacity-40' : ''}`}>
                        <span className={`text-[10px] ${isToday ? 'bg-accent text-white w-4 h-4 rounded-full inline-flex items-center justify-center' : 'text-text-muted'}`}>{day}</span>
                        {hasTrades && (
                          <div className="mt-0.5">
                            <div className="mono text-[12px] font-bold leading-tight" style={{ color: pnlColor(data.pnl) }}>{fmt$(data.pnl)}</div>
                            <div className="text-[10px] text-text-faint leading-tight">
                              {data.count}t · {data.wins}-{data.losses}
                              {data.ticketCount > 0 && <span className="text-amber"> ⚡{data.ticketCount}</span>}
                            </div>
                          </div>
                        )}
                        {data && !data.count && data.openCount > 0 && (
                          <div className="text-[10px] text-amber leading-tight mt-0.5">⚡{data.openCount} open</div>
                        )}
                        {data && data.count > 0 && data.openCount > 0 && (
                          <div className="absolute bottom-1 right-1"><span className="text-[8px] text-amber">⚡{data.openCount}</span></div>
                        )}
                        {data?.notes && <div className="absolute top-1 right-1"><Edit3 size={8} className="text-accent" /></div>}
                      </div>
                    );
                  })}
                  <div className="h-16 px-1.5 py-1 border border-bg-border rounded-lg bg-bg flex flex-col justify-center">
                    <div className="text-[9px] text-text-faint uppercase tracking-wider">W{wi + 1}</div>
                    {weekStats[wi].trades > 0 ? (<>
                      <div className="mono text-[12px] font-bold leading-tight" style={{ color: pnlColor(weekStats[wi].pnl) }}>{fmt$(weekStats[wi].pnl)}</div>
                      <div className="text-[10px] text-text-faint leading-tight">{weekStats[wi].trades}t</div>
                    </>) : (
                      <div className="text-[10px] text-text-faint">—</div>
                    )}
                  </div>
                </React.Fragment>
              ))}
              <div className="col-span-7 flex items-center justify-end pr-1 text-[10px] text-text-faint uppercase tracking-wider">Month</div>
              <div className="h-12 px-1.5 py-1 border border-accent/40 rounded-lg flex flex-col justify-center">
                <div className="mono text-[12px] font-bold leading-tight" style={{ color: pnlColor(monthPnl) }}>{fmt$(monthPnl)}</div>
                <div className="text-[10px] text-text-faint leading-tight">{monthTrades}t</div>
              </div>
            </div>
          </div>

          {/* Day Detail */}
          {selectedDay && (
            <div className="card fade-in">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-sm font-medium text-white">
                    {new Date(selectedDay + 'T12:00:00').toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                  </h3>
                  {allClosedOnDay.length > 0 && (
                    <div className="flex items-center gap-4 mt-1">
                      <span className="mono text-xl font-bold" style={{ color: pnlColor(selDayPnl) }}>{fmt$(selDayPnl)}</span>
                      <span className="text-sm text-[#c9d1d9]">{allClosedOnDay.length} closed</span>
                      <span className="text-sm font-medium text-green">{selDayWins}W</span>
                      <span className="text-sm font-medium text-red">{selDayLosses}L</span>
                    </div>
                  )}
                </div>
                <button onClick={() => setSelectedDay(null)} className="text-text-faint hover:text-text"><X size={16} /></button>
              </div>

              {/* CSV trades */}
              {selDayTrades.length > 0 && (
                <div className="mb-4">
                  <h4 className="text-[10px] text-text-faint uppercase tracking-wider mb-2 flex items-center gap-1.5">
                    <FileText size={10} /> CSV trades ({selDayTrades.length})
                  </h4>
                  <div className="space-y-1">
                    {selDayTrades.map((t, i) => {
                      const pnl = parseFloat(t['Total P&L ($)']) || 0;
                      const entryDate = (t['Entry Date'] || '').split('T')[0];
                      const closeDate = (t['Close Date'] || '').split('T')[0];
                      const isEntry = entryDate === selectedDay;
                      const isClose = closeDate === selectedDay;
                      return (
                        <div key={i} className="flex items-center gap-3 py-2 px-3 rounded-lg border border-bg-border">
                          <span className={`text-[10px] font-medium px-2 py-0.5 rounded ${isEntry && isClose ? 'bg-amber-bg text-amber' : isEntry ? 'bg-accent/10 text-accent' : 'bg-bg-hover text-text-muted'}`}>
                            {isEntry && isClose ? 'SAME DAY' : isEntry ? 'ENTRY' : 'CLOSE'}
                          </span>
                          <span className="text-sm font-medium text-white">{t.Underlying}</span>
                          <span className="text-xs text-[#c9d1d9] flex-1">{t['Strategy (OIC)']}</span>
                          {t.Status !== 'Open' && <span className="mono text-sm font-bold" style={{ color: pnlColor(pnl) }}>{fmt$(pnl)}</span>}
                          {t['W / L'] && <span className={`badge text-[10px] ${t['W / L'] === 'Win' ? 'badge-green' : 'badge-red'}`}>{t['W / L']}</span>}
                          <span className={`badge text-[10px] ${t.Status === 'Open' ? 'badge-blue' : t.Status === 'Assigned' ? 'badge-amber' : 'badge-green'}`}>{t.Status}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Decision engine closed tickets */}
              {selDayTickets.length > 0 && (
                <div className="mb-4">
                  <h4 className="text-[10px] text-text-faint uppercase tracking-wider mb-2 flex items-center gap-1.5">
                    <Zap size={10} className="text-amber" /> Engine tickets — closed ({selDayTickets.length})
                  </h4>
                  <div className="space-y-1">
                    {selDayTickets.map((d, i) => {
                      const pnl = parseFloat(d['Actual P&L']) || 0;
                      const isWin = pnl >= 0;
                      const stratParts = (d.Strategy || '').split(' - ');
                      const stratName = stratParts.length > 1 ? stratParts.slice(1, -1).join(' - ') : d.Strategy;
                      const isMatched = !!(d['Matched Trade'] || d._raw?.[20]);
                      return (
                        <div key={i} className="py-2 px-3 rounded-lg border border-amber/20 bg-amber/5">
                          <div className="flex items-center gap-3">
                            <span className="text-[10px] font-medium px-2 py-0.5 rounded bg-amber-bg text-amber">{d.Engine || 'Engine'}</span>
                            <span className="text-sm font-medium text-white">{d.Underlying}</span>
                            <span className="text-xs text-[#c9d1d9] flex-1">{stratName}</span>
                            <span className="mono text-sm font-bold" style={{ color: pnlColor(pnl) }}>{fmt$(pnl)}</span>
                            <span className={`badge text-[10px] ${isWin ? 'badge-green' : 'badge-red'}`}>{isWin ? 'Win' : 'Loss'}</span>
                            <span className={`badge text-[10px] ${isMatched ? 'badge-green' : 'badge-amber'}`}>{isMatched ? 'Matched' : 'Unmatched'}</span>
                          </div>
                          {d.Notes && <div className="text-[10px] text-[#8b949e] mt-1.5 whitespace-pre-line leading-relaxed">{d.Notes}</div>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Open decision entries (not yet closed) */}
              {selDayOpenDec.length > 0 && (
                <div className="mb-4">
                  <h4 className="text-[10px] text-text-faint uppercase tracking-wider mb-2 flex items-center gap-1.5">
                    <Camera size={10} /> Engine entries — open ({selDayOpenDec.length})
                  </h4>
                  <div className="space-y-1">
                    {selDayOpenDec.map((d, i) => {
                      const stratParts = (d.Strategy || '').split(' - ');
                      const stratName = stratParts.length > 1 ? stratParts.slice(1, -1).join(' - ') : d.Strategy;
                      return (
                        <div key={i} className="flex items-center gap-3 py-2 px-3 rounded-lg border border-bg-border">
                          <span className="text-[10px] font-medium px-2 py-0.5 rounded bg-accent/10 text-accent">{d.Engine || '0DTE'}</span>
                          <span className="text-sm font-medium text-white">{d.Underlying}</span>
                          <span className="text-xs text-[#c9d1d9] flex-1">{stratName}</span>
                          <span className="text-xs text-text-faint mono">{d['Setup Score']}</span>
                          <button onClick={() => setClosingTrade({ trade: d, type: 'ticket' })}
                            className="text-[10px] px-2 py-0.5 border border-[#238636] rounded text-[#3fb950] hover:bg-[#0d2818]">
                            Close
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Notes */}
              <div>
                <h4 className="text-[10px] text-text-faint uppercase tracking-wider mb-2 flex items-center gap-1.5"><Edit3 size={10} /> Daily review</h4>
                {selData?.notes && <div className="text-sm text-[#c9d1d9] mb-2 p-3 bg-bg rounded-lg whitespace-pre-wrap">{selData.notes}</div>}
                <textarea value={reviewText} onChange={e => setReviewText(e.target.value)} rows={3}
                  placeholder="What went well? What would you do differently?..."
                  className="w-full px-3 py-2 bg-bg border border-bg-border rounded-lg text-sm text-text placeholder-text-faint outline-none focus:border-accent resize-y" />
                <button onClick={handleSaveReview} disabled={savingReview || !reviewText.trim()}
                  className="mt-2 flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium bg-accent hover:bg-accent-hover text-white rounded-lg transition-colors disabled:opacity-50">
                  <Save size={12} /> {savingReview ? 'Saving...' : 'Save review'}
                </button>
              </div>

              {allClosedOnDay.length === 0 && selDayTrades.length === 0 && selDayOpenDec.length === 0 && !selData?.notes && (
                <div className="py-4 text-center text-text-faint text-sm">No trading activity on this day</div>
              )}
            </div>
          )}
        </div>

        {/* Right column */}
        <div>
          <div className="card mb-4">
            <h3 className="text-sm font-medium text-text mb-3">Month Summary</h3>
            <div className="mono text-3xl font-bold mb-3" style={{ color: pnlColor(monthPnl) }}>{fmt$(monthPnl)}</div>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="flex justify-between"><span className="text-text-muted">Trades</span><span className="mono text-white">{monthTrades}</span></div>
              <div className="flex justify-between"><span className="text-text-muted">BA (ex-scratch)</span><span className="mono text-white">{monthDecided > 0 ? Math.round(monthWins / monthDecided * 100) : 0}%</span></div>
              <div className="flex justify-between"><span className="text-green">Wins</span><span className="mono text-white">{monthWins}</span></div>
              <div className="flex justify-between"><span className="text-red">Losses</span><span className="mono text-white">{monthLosses}</span></div>
            </div>
            {monthDecided > 0 && (
              <div className="mt-3 h-2.5 rounded-full bg-bg-border overflow-hidden flex">
                <div className="bg-green h-full" style={{ width: `${(monthWins / monthDecided) * 100}%` }} />
                <div className="bg-red h-full" style={{ width: `${(monthLosses / monthDecided) * 100}%` }} />
              </div>
            )}
          </div>

          <div className="card">
            <h3 className="text-sm font-medium text-text mb-3">Weekly Results</h3>
            {weekStats.some(w => w.trades > 0) ? (
              <div className="space-y-3">
                {weekStats.map((data, wi) => {
                  if (data.trades === 0) return null;
                  const decided = data.wins + data.losses;
                  const ba = decided > 0 ? Math.round(data.wins / decided * 100) : 0;
                  return (
                    <div key={wi} className="p-3 rounded-lg border border-bg-border">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-medium text-white">W{wi + 1}</span>
                        <span className="mono text-sm font-bold" style={{ color: pnlColor(data.pnl) }}>{fmt$(data.pnl)}</span>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-text-muted">
                        <span>{data.trades}t</span>
                        <span className="text-green">{data.wins}W</span>
                        <span className="text-red">{data.losses}L</span>
                        <span>BA: {ba}%</span>
                      </div>
                      <div className="mt-2 h-1.5 rounded-full bg-bg-border overflow-hidden flex">
                        {decided > 0 && (<>
                          <div className="bg-green h-full" style={{ width: `${(data.wins / decided) * 100}%` }} />
                          <div className="bg-red h-full" style={{ width: `${(data.losses / decided) * 100}%` }} />
                        </>)}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="h-32 flex items-center justify-center text-text-faint text-sm">No data this month</div>
            )}
          </div>
        </div>
      </div>
    </div>

      {closingTrade && (
        <CloseTradeModal
          trade={closingTrade.trade}
          type={closingTrade.type}
          onClose={() => setClosingTrade(null)}
          onClosed={() => { setClosingTrade(null); loadData(); }}
        />
      )}
    </>
  );
}
