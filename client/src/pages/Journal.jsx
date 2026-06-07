import React, { useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight, Plus, X, Save, FileText, Camera, Edit3 } from 'lucide-react';
import { api } from '../utils/api';
import { fmt$, fmtDate, pnlColor, filterByAccount } from '../utils/format';

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
  const [savingReview, setSavingReview] = useState(false);

  useEffect(() => {
    if (!authenticated) { setLoading(false); return; }
    Promise.all([
      api.getJournal().catch(() => []),
      api.getTracker().catch(() => []),
      api.getDecisions().catch(() => [])
    ]).then(([j, t, d]) => {
      setJournal(j);
      setTracker(t);
      if (d && d.length > 1) {
        const headers = d[0];
        setDecisions(d.slice(1).map(row => {
          const obj = {};
          headers.forEach((h, i) => { obj[h] = row[i] || ''; });
          return obj;
        }));
      }
      setLoading(false);
    });
  }, [authenticated]);

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const monthName = currentDate.toLocaleString('default', { month: 'long', year: 'numeric' });
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();

  // ── Build daily stats from TradeTracker ──
  const filteredTracker = filterByAccount(tracker, account);
  const dayStats = {};
  filteredTracker.forEach(t => {
    if (t.Status === 'Open') return; // skip open trades
    const pnl = parseFloat(t['Total P&L ($)']) || 0;
    const wl = t['W / L'];
    // Attribute P&L to close date (when realised), or entry date if no close
    const closeDate = (t['Close Date'] || '').split('T')[0];
    const entryDate = (t['Entry Date'] || '').split('T')[0];
    const d = closeDate || entryDate;
    if (!d) return;
    if (!dayStats[d]) dayStats[d] = { pnl: 0, count: 0, wins: 0, losses: 0 };
    dayStats[d].pnl += pnl;
    dayStats[d].count++;
    if (wl === 'Win') dayStats[d].wins++;
    if (wl === 'Loss') dayStats[d].losses++;
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
      notes: notesByDate[d] || ''
    };
  });

  function getTradesForDate(dateStr) {
    return filteredTracker.filter(t => {
      const entryDate = (t['Entry Date'] || '').split('T')[0];
      const closeDate = (t['Close Date'] || '').split('T')[0];
      return entryDate === dateStr || closeDate === dateStr;
    });
  }

  function getDecisionsForDate(dateStr) {
    return decisions.filter(d => {
      if (!d.Timestamp) return false;
      try { return new Date(d.Timestamp).toISOString().split('T')[0] === dateStr; }
      catch (e) { return false; }
    });
  }

  // ── Weekly + monthly summaries ──
  const weeks = {};
  Object.entries(dayStats).forEach(([date, data]) => {
    const d = new Date(date + 'T12:00:00');
    if (d.getMonth() === month && d.getFullYear() === year) {
      const weekNum = Math.ceil(d.getDate() / 7);
      const key = `W${weekNum}`;
      if (!weeks[key]) weeks[key] = { pnl: 0, trades: 0, wins: 0, losses: 0 };
      weeks[key].pnl += data.pnl;
      weeks[key].trades += data.count;
      weeks[key].wins += data.wins;
      weeks[key].losses += data.losses;
    }
  });

  const monthPnl = Object.values(weeks).reduce((s, w) => s + w.pnl, 0);
  const monthTrades = Object.values(weeks).reduce((s, w) => s + w.trades, 0);
  const monthWins = Object.values(weeks).reduce((s, w) => s + w.wins, 0);
  const monthLosses = Object.values(weeks).reduce((s, w) => s + w.losses, 0);

  function prevMonth() { setCurrentDate(new Date(year, month - 1, 1)); setSelectedDay(null); }
  function nextMonth() { setCurrentDate(new Date(year, month + 1, 1)); setSelectedDay(null); }
  function goToday() { setCurrentDate(new Date()); setSelectedDay(null); }

  async function handleAddNote() {
    if (!noteDate) return;
    try {
      await api.addJournalEntry({ date: noteDate, notes: noteText, dayPnl: 0, tradesCount: 0, winCount: 0, lossCount: 0 });
      const updated = await api.getJournal();
      setJournal(updated);
      setShowAdd(false);
      setNoteText('');
    } catch (e) { console.error(e); }
  }

  async function handleSaveReview() {
    if (!selectedDay) return;
    setSavingReview(true);
    try {
      await api.addJournalEntry({ date: selectedDay, notes: reviewText, dayPnl: 0, tradesCount: 0, winCount: 0, lossCount: 0 });
      const updated = await api.getJournal();
      setJournal(updated);
      setReviewText('');
    } catch (e) { console.error(e); }
    setSavingReview(false);
  }

  if (!authenticated) return (<div className="fade-in"><h2 className="font-display text-2xl font-bold mb-2">Journal</h2><p className="text-text-muted">Connect Google to view journal.</p></div>);

  const cells = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const selData = selectedDay ? calendarData[selectedDay] || null : null;
  const selDayTrades = selectedDay ? getTradesForDate(selectedDay) : [];
  const selDayDecisions = selectedDay ? getDecisionsForDate(selectedDay) : [];
  // Calculate day P&L from visible trades (in case calendarData misses some)
  const selDayPnl = selDayTrades.filter(t => t.Status !== 'Open').reduce((s, t) => s + (parseFloat(t['Total P&L ($)']) || 0), 0);
  const selDayWins = selDayTrades.filter(t => t['W / L'] === 'Win').length;
  const selDayLosses = selDayTrades.filter(t => t['W / L'] === 'Loss').length;
  const selDayClosed = selDayTrades.filter(t => t.Status !== 'Open').length;

  return (
    <div className="fade-in">
      <div className="flex items-center justify-between mb-6">
        <h2 className="font-display text-2xl font-bold">Journal</h2>
        <button onClick={() => { setShowAdd(!showAdd); setNoteDate(today.toISOString().split('T')[0]); }}
          className="flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-lg transition-colors">
          <Plus size={14} /> Add note
        </button>
      </div>

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

            <div className="grid grid-cols-7 gap-1">
              {['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'].map(d => (
                <div key={d} className="text-center text-[10px] text-text-faint uppercase tracking-wider py-2">{d}</div>
              ))}
              {cells.map((day, i) => {
                if (day === null) return <div key={i} className="aspect-square" />;
                const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                const data = calendarData[dateStr];
                const isToday = day === today.getDate() && month === today.getMonth() && year === today.getFullYear();
                const isSelected = selectedDay === dateStr;
                let bgColor = 'border-bg-border';
                if (data && data.count > 0) {
                  if (data.pnl > 0) bgColor = 'border-green/40 bg-green/5';
                  else if (data.pnl < 0) bgColor = 'border-red/40 bg-red/5';
                  else bgColor = 'border-bg-border bg-bg-hover';
                }
                if (isSelected) bgColor += ' ring-2 ring-accent';
                return (
                  <div key={i} onClick={() => setSelectedDay(isSelected ? null : dateStr)}
                    className={`aspect-square p-1.5 border rounded-lg relative transition-all cursor-pointer hover:border-accent/50 ${bgColor}`}>
                    <span className={`text-xs ${isToday ? 'bg-accent text-white w-5 h-5 rounded-full flex items-center justify-center' : 'text-text-muted'}`}>{day}</span>
                    {data && data.count > 0 && (
                      <div className="absolute bottom-1 left-1 right-1">
                        <div className="mono text-[10px] font-bold" style={{ color: pnlColor(data.pnl) }}>{fmt$(data.pnl)}</div>
                        <div className="text-[9px] text-text-faint">{data.count}t {data.wins}w {data.losses}l</div>
                      </div>
                    )}
                    {data?.notes && <div className="absolute top-1 right-1"><Edit3 size={8} className="text-accent" /></div>}
                  </div>
                );
              })}
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
                  {selDayClosed > 0 && (
                    <div className="flex items-center gap-4 mt-1">
                      <span className="mono text-xl font-bold" style={{ color: pnlColor(selDayPnl) }}>{fmt$(selDayPnl)}</span>
                      <span className="text-sm text-[#c9d1d9]">{selDayClosed} closed</span>
                      <span className="text-sm font-medium text-green">{selDayWins}W</span>
                      <span className="text-sm font-medium text-red">{selDayLosses}L</span>
                    </div>
                  )}
                </div>
                <button onClick={() => setSelectedDay(null)} className="text-text-faint hover:text-text"><X size={16} /></button>
              </div>

              {selDayTrades.length > 0 && (
                <div className="mb-4">
                  <h4 className="text-[10px] text-text-faint uppercase tracking-wider mb-2 flex items-center gap-1.5">
                    <FileText size={10} /> Trades ({selDayTrades.length})
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
                          {t.Status !== 'Open' && (
                            <span className="mono text-sm font-bold" style={{ color: pnlColor(pnl) }}>{fmt$(pnl)}</span>
                          )}
                          {t['W / L'] && (
                            <span className={`badge text-[10px] ${t['W / L'] === 'Win' ? 'badge-green' : 'badge-red'}`}>{t['W / L']}</span>
                          )}
                          <span className={`badge text-[10px] ${t.Status === 'Open' ? 'badge-blue' : t.Status === 'Assigned' ? 'badge-amber' : 'badge-green'}`}>{t.Status}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {selDayDecisions.length > 0 && (
                <div className="mb-4">
                  <h4 className="text-[10px] text-text-faint uppercase tracking-wider mb-2 flex items-center gap-1.5">
                    <Camera size={10} /> Decision engine ({selDayDecisions.length})
                  </h4>
                  <div className="space-y-1">
                    {selDayDecisions.map((d, i) => {
                      const stratParts = (d.Strategy || '').split(' - ');
                      const stratName = stratParts.length > 1 ? stratParts.slice(1, -1).join(' - ') : d.Strategy;
                      return (
                        <div key={i} className="flex items-center gap-3 py-2 px-3 rounded-lg border border-bg-border">
                          <span className="text-[10px] font-medium px-2 py-0.5 rounded bg-amber-bg text-amber">{d.Engine || '0DTE'}</span>
                          <span className="text-sm font-medium text-white">{d.Underlying}</span>
                          <span className="text-xs text-[#c9d1d9] flex-1">{stratName}</span>
                          <span className={`text-xs font-medium ${d.Direction === 'Trade' ? 'text-green' : d.Direction === 'Trade with caution' ? 'text-amber' : 'text-red'}`}>{d.Direction}</span>
                          <span className="text-xs text-text-faint mono">{d['Setup Score']}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div>
                <h4 className="text-[10px] text-text-faint uppercase tracking-wider mb-2 flex items-center gap-1.5">
                  <Edit3 size={10} /> Daily review
                </h4>
                {selData?.notes && <div className="text-sm text-[#c9d1d9] mb-2 p-3 bg-bg rounded-lg whitespace-pre-wrap">{selData.notes}</div>}
                <textarea value={reviewText} onChange={e => setReviewText(e.target.value)} rows={3}
                  placeholder="What went well? What would you do differently? Market observations, emotional state, lessons..."
                  className="w-full px-3 py-2 bg-bg border border-bg-border rounded-lg text-sm text-text placeholder-text-faint outline-none focus:border-accent resize-y" />
                <button onClick={handleSaveReview} disabled={savingReview || !reviewText.trim()}
                  className="mt-2 flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium bg-accent hover:bg-accent-hover text-white rounded-lg transition-colors disabled:opacity-50">
                  <Save size={12} /> {savingReview ? 'Saving...' : 'Save review'}
                </button>
              </div>

              {selDayClosed === 0 && selDayTrades.length === 0 && selDayDecisions.length === 0 && !selData?.notes && (
                <div className="py-4 text-center text-text-faint text-sm">No trading activity on this day</div>
              )}
            </div>
          )}
        </div>

        {/* Right column */}
        <div>
          {/* Month summary */}
          <div className="card mb-4">
            <h3 className="text-sm font-medium text-[#c9d1d9] mb-3">Month Summary</h3>
            <div className="mono text-3xl font-bold mb-3" style={{ color: pnlColor(monthPnl) }}>{fmt$(monthPnl)}</div>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="flex justify-between"><span className="text-[#8b949e]">Trades</span><span className="mono text-white">{monthTrades}</span></div>
              <div className="flex justify-between"><span className="text-[#8b949e]">BA</span><span className="mono text-white">{monthTrades > 0 ? Math.round(monthWins / (monthWins + monthLosses) * 100) : 0}%</span></div>
              <div className="flex justify-between"><span className="text-green">Wins</span><span className="mono text-white">{monthWins}</span></div>
              <div className="flex justify-between"><span className="text-red">Losses</span><span className="mono text-white">{monthLosses}</span></div>
            </div>
            {monthTrades > 0 && (
              <div className="mt-3 h-2.5 rounded-full bg-bg-border overflow-hidden flex">
                <div className="bg-green h-full" style={{ width: `${(monthWins / (monthWins + monthLosses)) * 100}%` }} />
                <div className="bg-red h-full" style={{ width: `${(monthLosses / (monthWins + monthLosses)) * 100}%` }} />
              </div>
            )}
          </div>

          {/* Weekly results */}
          <div className="card">
            <h3 className="text-sm font-medium text-[#c9d1d9] mb-3">Weekly Results</h3>
            {Object.entries(weeks).length > 0 ? (
              <div className="space-y-3">
                {Object.entries(weeks).sort().map(([week, data]) => {
                  const ba = data.trades > 0 ? Math.round(data.wins / data.trades * 100) : 0;
                  return (
                    <div key={week} className="p-3 rounded-lg border border-bg-border">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-medium text-white">{week}</span>
                        <span className="mono text-sm font-bold" style={{ color: pnlColor(data.pnl) }}>{fmt$(data.pnl)}</span>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-[#8b949e]">
                        <span>{data.trades} trades</span>
                        <span className="text-green">{data.wins}W</span>
                        <span className="text-red">{data.losses}L</span>
                        <span>BA: {ba}%</span>
                      </div>
                      <div className="mt-2 h-1.5 rounded-full bg-bg-border overflow-hidden flex">
                        {data.trades > 0 && (<>
                          <div className="bg-green h-full" style={{ width: `${(data.wins / data.trades) * 100}%` }} />
                          <div className="bg-red h-full" style={{ width: `${(data.losses / data.trades) * 100}%` }} />
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
  );
}
