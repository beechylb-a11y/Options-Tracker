import { describe, it, expect } from 'vitest';
import { emaStack, firstHour, entryWindow, creditPlan, rangeLeft } from '../engine/creditSide';

const daily = (n, f) => Array.from({ length: n }, (_, i) => [`2026${String(Math.floor(i / 28) + 1).padStart(2, '0')}${String(i % 28 + 1).padStart(2, '0')}`, 0, 0, 0, f(i)]);

describe('rangeLeft — tastylive 16Δ curve', () => {
  it('matches the read-outs', () => {
    expect(rangeLeft(0)).toBe(1);
    expect(rangeLeft(1)).toBeCloseTo(0.86, 2);
    expect(rangeLeft(2)).toBeCloseTo(0.75, 2);
    expect(rangeLeft(3.5)).toBeCloseTo(0.5, 2);
    expect(rangeLeft(6.5)).toBe(0);
  });
});

describe('emaStack', () => {
  it('reads a rising series as up and a falling one as down', () => {
    expect(emaStack(daily(120, i => 100 + i), '20991231').stack).toBe('up');
    expect(emaStack(daily(120, i => 300 - i), '20991231').stack).toBe('down');
  });
  it('leaves out today\'s forming bar and needs 60 closes', () => {
    expect(emaStack(daily(40, i => i + 1), '20991231')).toBeNull();
    const b = daily(120, i => 100 + i);
    const today = b[b.length - 1][0];
    expect(emaStack(b, today).last).toBe(b[b.length - 2][4]);
  });
});

describe('firstHour', () => {
  const bars = [
    { date: '20261110  15:30:00', open: 99, close: 99 },
    { date: '20261111  09:30:00', open: 100, close: 100.2 },
    { date: '20261111  10:00:00', open: 100.2, close: 100.4 },
    { date: '20261111  10:30:00', open: 100.4, close: 100.1 },
  ];
  it('09:30 open to the 10:00 bar close once 10:30 is in', () => {
    const f = firstHour(bars, 11 * 60);
    expect(f.done).toBe(true);
    expect(f.movePct).toBeCloseTo(0.4, 6);
    expect(f.dir).toBe('up');
  });
  it('in progress before 10:30, nothing before the open', () => {
    expect(firstHour(bars.slice(0, 3), 9 * 60 + 50).done).toBe(false);
    expect(firstHour(bars, 9 * 60)).toBeNull();
  });
  it('does not read yesterday as today', () => {
    const y = Array.from({ length: 13 }, (_, i) => ({ date: `20261110  ${String(9 + Math.floor((30 + i * 30) / 60)).padStart(2, '0')}:${(30 + i * 30) % 60 === 0 ? '00' : '30'}:00`, open: 100, close: 100 }));
    expect(firstHour(y, 10 * 60 + 45)).toBeNull();
  });
});

describe('entryWindow', () => {
  it('first hour waits, 10:30–12:30 is the window, later is late', () => {
    expect(entryWindow(9 * 60 + 45).state).toBe('first-hour');
    expect(entryWindow(11 * 60).state).toBe('window');
    expect(entryWindow(13 * 60 + 10).label).toBe('Range half gone');
    expect(entryWindow(15 * 60 + 10).state).toBe('last');
  });
});

describe('creditPlan', () => {
  const done = dir => ({ done: true, dir });
  it('up-trend leans to the call side', () => {
    expect(creditPlan({ ema: { stack: 'up' }, first: done('up') })).toMatchObject({ side: 'call', anchor: 'engine' });
  });
  it('down/mixed trend after a down first hour: puts only, further out, calls blocked', () => {
    const p = creditPlan({ ema: { stack: 'mixed' }, first: done('down') });
    expect(p.side).toBe('put');
    expect(p.anchor).toBe('em1d');
    expect(p.blocked.call).toMatch(/16%/);
  });
  it('no trend read: first hour decides; nothing at all: no lean', () => {
    expect(creditPlan({ first: done('down') }).side).toBe('put');
    expect(creditPlan({}).side).toBeNull();
  });
});
