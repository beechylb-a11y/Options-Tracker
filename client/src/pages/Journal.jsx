import React, { useState, useEffect } from 'react';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { api } from '../utils/api';
import { fmt$, pnlColor } from '../utils/format';

export default function Journal({ authenticated }) {
  const [journal, setJournal] = useState([]);
  const [loading, setLoading] = useState(true);
  const [currentDate, setCurrentDate] = useState(new Date());
  const [showAdd, setShowAdd] = useState(false);
  const [noteDate, setNoteDate] = useState('');
  const [noteText, setNoteText] = useState('');

  useEffect(() => {
    if (!authenticated) { setLoading(false); return; }
    api.getJournal().then(setJournal).catch(() => {}).finally(() => setLoading(false));
  }, [authenticated]);

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const monthName = currentDate.toLocaleString('default', { month: 'long', year: 'numeric' });

  // Build calendar grid
  const firstDay = new Date(year, month, 1).getDay(); // 0=Sun
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
      if (j.Notes) journalMap[d].notes = j.Notes;
    }
  });

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

  function prevMonth() { setCurrentDate(new Date(year, month - 1, 1)); }
  function nextMonth() { setCurrentDate(new Date(year, month + 1, 1)); }
  function goToday() { setCurrentDate(new Date()); }

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

  if (!authenticated) {
    return (
      <div className="fade-in">
        <h2 className="font-display text-2xl font-bold mb-2">Journal</h2>
        <p className="text-text-muted">Connect Google to view your trading journal.</p>
      </div>
    );
  }

  // Calendar cells
  const cells = [];
  for (let i = 0; i < firstDay; i++) cells.push(null); // empty cells before month start
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

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
        <div className="col-span-2 card">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <button onClick={goToday} className="px-3 py-1 text-xs border border-bg-border rounded-lg hover:bg-bg-hover transition-colors">Today</button>
              <button onClick={prevMonth} className="p-1 hover:bg-bg-hover rounded"><ChevronLeft size={16} /></button>
              <button onClick={nextMonth} className="p-1 hover:bg-bg-hover rounded"><ChevronRight size={16} /></button>
            </div>
            <h3 className="font-display text-lg font-semibold">{monthName}</h3>
          </div>

          <div className="grid grid-cols-7 gap-px">
            {['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'].map(d => (
              <div key={d} className="text-center text-[10px] text-text-faint uppercase tracking-wider py-2">{d}</div>
            ))}
            {cells.map((day, i) => {
              if (day === null) return <div key={i} className="aspect-square" />;
              const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
              const data = journalMap[dateStr];
              const isToday = day === today.getDate() && month === today.getMonth() && year === today.getFullYear();

              let bgColor = '';
              if (data) {
                if (data.pnl > 0) bgColor = 'bg-green/10 border-green/30';
                else if (data.pnl < 0) bgColor = 'bg-red/10 border-red/30';
                else bgColor = 'bg-bg-hover border-bg-border';
              }

              return (
                <div key={i} className={`aspect-square p-1.5 border border-bg-border rounded-lg relative transition-colors hover:border-accent/40 ${bgColor}`}>
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
                </div>
              );
            })}
          </div>
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
                    {/* Mini bar */}
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

          {/* Month summary */}
          {Object.keys(weeks).length > 0 && (
            <div className="mt-4 pt-4 border-t border-bg-border">
              <div className="text-xs text-text-faint uppercase tracking-wider mb-2">Month Total</div>
              <div className="mono text-lg font-bold" style={{ color: pnlColor(Object.values(weeks).reduce((s, w) => s + w.pnl, 0)) }}>
                {fmt$(Object.values(weeks).reduce((s, w) => s + w.pnl, 0))}
              </div>
              <div className="text-xs text-text-muted mt-1">
                {Object.values(weeks).reduce((s, w) => s + w.trades, 0)} trades &nbsp;|&nbsp;
                {Object.values(weeks).reduce((s, w) => s + w.wins, 0)}W {Object.values(weeks).reduce((s, w) => s + w.losses, 0)}L
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
