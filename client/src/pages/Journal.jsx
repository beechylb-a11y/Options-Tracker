import React, { useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight, Plus, X, Save, FileText, Camera, Edit3 } from 'lucide-react';
import { api } from '../utils/api';
import { fmt$, fmtDate, pnlColor } from '../utils/format';

export default function Journal({ authenticated }) {
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
      // Parse decisions
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

  // Index journal entries by date
  const journalMap = {};
  journal.forEach(j => {
    if (j.Date) {
      const d = j.Date.split('T')[0];
      if (!journalMap[d]) journalMap[d] = { pnl: 0, count: 0, wins: 0, losses: 0, notes: '' };
      journalMap[d].pnl += parseFloat(j['Day P&L']) || 0;
      journalMap[d].count += parseInt(j['Trades Count']) || 0;
      journalMap[d].wins += parseInt(j['Win Count']) || 0;
      journalMap[d].losses += parseInt(j['Loss Count']) || 0;
      if (j.Notes) journalMap[d].notes += (journalMap[d].notes ? '\n' : '') + j.Notes;
    }
  });

  // Get trades for a specific date
  function getTradesForDate(dateStr) {
    return tracker.filter(t => {
      const entryDate = (t['Entry Date'] || '').split('T')[0];
      const closeDate = (t['Close Date'] || '').split('T')[0];
      return entryDate === dateStr || closeDate === dateStr;
    });
  }

  // Get decision engine entries for a specific date
  function getDecisionsForDate(dateStr) {
    return decisions.filter(d => {
      if (!d.Timestamp) return false;
      const decDate = new Date(d.Timestamp).toISOString().split('T')[0];
      return decDate === dateStr;
    });
  }

  // Weekly summary
  const weeks = {};
  Object.entries(journalMap).forEach(([date, data]) => {
    const d = new Date(date);
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

  // Month totals
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
    } catch (e) { console.error(e); }
    setSavingReview(false);
  }

  if (!authenticated) {
    return (
      <div className="fade-in">
        <h2 className="font-display text-2xl font-bold mb-2">Journal</h2>
        <p className="text-text-muted">Connect Google to view your trading journal.</p>
      </div>
    );
  }

  const cells = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  // Selected day data
  const selDayData = selectedDay ? journalMap[selectedDay] : null;
  const selDayTrades = selectedDay ? getTradesForDate(selectedDay) : [];
  const selDayDecisions = selectedDay ? getDecisionsForDate(selectedDay) : [];

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
        {/* Calendar */}
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
                const data = journalMap[dateStr];
                const isToday = day === today.getDate() && month === today.getMonth() && year === today.getFullYear();
                const isSelected = selectedDay === dateStr;

                let bgColor = 'border-bg-border';
                if (data) {
                  if (data.pnl > 0) bgColor = 'border-green/40 bg-green/5';
                  else if (data.pnl < 0) bgColor = 'border-red/40 bg-red/5';
                  else bgColor = 'border-bg-border bg-bg-hover';
                }
                if (isSelected) bgColor += ' ring-2 ring-accent';

                return (
                  <div key={i}
                    onClick={() => setSelectedDay(isSelected ? null : dateStr)}
                    className={`aspect-square p-1.5 border rounded-lg relative transition-all cursor-pointer hover:border-accent/50 ${bgColor}`}>
                    <span className={`text-xs ${isToday ? 'bg-accent text-white w-5 h-5 rounded-full flex items-center justify-center' : 'text-text-muted'}`}>
                      {day}
                    </span>
                    {data && (
                      <div className="absolute bottom-1 left-1 right-1">
                        <div className="mono text-[10px] font-bold" style={{ color: pnlColor(data.pnl) }}>
                          {fmt$(data.pnl)}
                        </div>
                        {data.count > 0 && (
                          <div className="text-[9px] text-text-faint">{data.count}t {data.wins}w {data.losses}l</div>
                        )}
                      </div>
                    )}
                    {data?.notes && (
                      <div className="absolute top-1 right-1">
                        <Edit3 size={8} className="text-accent" />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Day Detail Panel */}
          {selectedDay && (
            <div className="card fade-in">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-sm font-medium text-text">
                    {new Date(selectedDay + 'T12:00:00').toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                  </h3>
                  {selDayData && (
                    <div className="flex items-center gap-4 mt-1">
                      <span className="mono text-lg font-bold" style={{ color: pnlColor(selDayData.pnl) }}>{fmt$(selDayData.pnl)}</span>
                      <span className="text-xs text-text-muted">{selDayData.count} trades</span>
                      <span className="text-xs text-green">{selDayData.wins}W</span>
                      <span className="text-xs text-red">{selDayData.losses}L</span>
                    </div>
                  )}
                </div>
                <button onClick={() => setSelectedDay(null)} className="text-text-faint hover:text-text"><X size={16} /></button>
              </div>

              {/* Trades on this day */}
              {selDayTrades.length > 0 && (
                <div className="mb-4">
                  <h4 className="text-[10px] text-text-faint uppercase tracking-wider mb-2 flex items-center gap-1.5">
                    <FileText size={10} /> Trades on this day ({selDayTrades.length})
                  </h4>
                  <div className="space-y-1">
                    {selDayTrades.map((t, i) => {
                      const pnl = parseFloat(t['Total P&L ($)']) || 0;
                      const isEntry = (t['Entry Date'] || '').split('T')[0] === selectedDay;
                      return (
                        <div key={i} className="flex items-center gap-3 py-2 px-3 rounded-lg border border-bg-border">
                          <span className={`text-[10px] font-medium px-2 py-0.5 rounded ${isEntry ? 'bg-accent/10 text-accent' : 'bg-bg-hover text-text-muted'}`}>
                            {isEntry ? 'ENTRY' : 'CLOSE'}
                          </span>
                          <span className="text-sm font-medium">{t.Underlying}</span>
                          <span className="text-xs text-text-muted flex-1">{t['Strategy (OIC)']}</span>
                          <span className="mono text-sm font-medium" style={{ color: pnlColor(pnl) }}>{fmt$(pnl)}</span>
                          {t['W / L'] && (
                            <span className={`badge text-[10px] ${t['W / L'] === 'Win' ? 'badge-green' : 'badge-red'}`}>{t['W / L']}</span>
                          )}
                          <span className={`badge text-[10px] ${t.Status === 'Open' ? 'badge-blue' : 'badge-green'}`}>{t.Status}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Decision engine entries on this day */}
              {selDayDecisions.length > 0 && (
                <div className="mb-4">
                  <h4 className="text-[10px] text-text-faint uppercase tracking-wider mb-2 flex items-center gap-1.5">
                    <Camera size={10} /> Decision engine entries ({selDayDecisions.length})
                  </h4>
                  <div className="space-y-1">
                    {selDayDecisions.map((d, i) => {
                      const stratParts = (d.Strategy || '').split(' - ');
                      const stratName = stratParts.length > 1 ? stratParts.slice(1, -1).join(' - ') : d.Strategy;
                      return (
                        <div key={i} className="flex items-center gap-3 py-2 px-3 rounded-lg border border-bg-border">
                          <span className="text-[10px] font-medium px-2 py-0.5 rounded bg-amber-bg text-amber">{d.Engine || '0DTE'}</span>
                          <span className="text-sm font-medium">{d.Underlying}</span>
                          <span className="text-xs text-text-muted flex-1">{stratName}</span>
                          <span className={`text-xs font-medium ${
                            d.Direction === 'Trade' ? 'text-green' : d.Direction === 'Trade with caution' ? 'text-amber' : 'text-red'
                          }`}>
                            {d.Direction}
                          </span>
                          <span className="text-xs text-text-faint mono">{d['Setup Score']}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Daily review notes */}
              <div>
                <h4 className="text-[10px] text-text-faint uppercase tracking-wider mb-2 flex items-center gap-1.5">
                  <Edit3 size={10} /> Daily review notes
                </h4>
                {selDayData?.notes && (
                  <div className="text-sm text-text-muted mb-2 p-3 bg-bg rounded-lg whitespace-pre-wrap">{selDayData.notes}</div>
                )}
                <textarea
                  value={reviewText}
                  onChange={e => setReviewText(e.target.value)}
                  rows={3}
                  placeholder="What went well? What would you do differently? Market observations, emotional state, lessons..."
                  className="w-full px-3 py-2 bg-bg border border-bg-border rounded-lg text-sm text-text placeholder-text-faint outline-none focus:border-accent resize-y"
                />
                <button onClick={handleSaveReview} disabled={savingReview || !reviewText.trim()}
                  className="mt-2 flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium bg-accent hover:bg-accent-hover text-white rounded-lg transition-colors disabled:opacity-50">
                  <Save size={12} /> {savingReview ? 'Saving...' : 'Save review'}
                </button>
              </div>

              {/* No data message */}
              {!selDayData && selDayTrades.length === 0 && selDayDecisions.length === 0 && (
                <div className="py-4 text-center text-text-faint text-sm">No trading activity on this day</div>
              )}
            </div>
          )}
        </div>

        {/* Right column: Weekly results + Month summary */}
        <div>
          {/* Month summary card */}
          <div className="card mb-4">
            <h3 className="text-sm font-medium text-text-muted mb-3">Month Summary</h3>
            <div className="mono text-2xl font-bold mb-2" style={{ color: pnlColor(monthPnl) }}>{fmt$(monthPnl)}</div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="flex justify-between"><span className="text-text-muted">Trades</span><span className="mono">{monthTrades}</span></div>
              <div className="flex justify-between"><span className="text-text-muted">BA</span><span className="mono">{monthTrades > 0 ? Math.round(monthWins / (monthWins + monthLosses) * 100) : 0}%</span></div>
              <div className="flex justify-between"><span className="text-green">Wins</span><span className="mono">{monthWins}</span></div>
              <div className="flex justify-between"><span className="text-red">Losses</span><span className="mono">{monthLosses}</span></div>
            </div>
            {monthTrades > 0 && (
              <div className="mt-3 h-2 rounded-full bg-bg-border overflow-hidden flex">
                <div className="bg-green h-full" style={{ width: `${(monthWins / (monthWins + monthLosses)) * 100}%` }} />
                <div className="bg-red h-full" style={{ width: `${(monthLosses / (monthWins + monthLosses)) * 100}%` }} />
              </div>
            )}
          </div>

          {/* Weekly results */}
          <div className="card">
            <h3 className="text-sm font-medium text-text-muted mb-3">Weekly Results</h3>
            {Object.entries(weeks).length > 0 ? (
              <div className="space-y-3">
                {Object.entries(weeks).sort().map(([week, data]) => {
                  const ba = data.trades > 0 ? Math.round(data.wins / data.trades * 100) : 0;
                  return (
                    <div key={week} className="p-3 rounded-lg border border-bg-border">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-medium">{week}</span>
                        <span className="mono text-sm font-bold" style={{ color: pnlColor(data.pnl) }}>{fmt$(data.pnl)}</span>
                      </div>
                      <div className="flex items-center gap-3 text-[11px] text-text-muted">
                        <span>{data.trades} trades</span>
                        <span className="text-green">{data.wins}W</span>
                        <span className="text-red">{data.losses}L</span>
                        <span>BA: {ba}%</span>
                      </div>
                      <div className="mt-2 h-1.5 rounded-full bg-bg-border overflow-hidden flex">
                        {data.trades > 0 && (
                          <>
                            <div className="bg-green h-full" style={{ width: `${(data.wins / data.trades) * 100}%` }} />
                            <div className="bg-red h-full" style={{ width: `${(data.losses / data.trades) * 100}%` }} />
                          </>
                        )}
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
