/* Win rate and R by confidence band (Analytics › Edge): every band carries its 95%
   ranges and its sample label, and the card only says "re-weight the score" when the
   best and worst readable bands are clear of each other on 30+ trades each. */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { calibration, calibrationRead } from '../utils/tradeStory';
import { CalibrationBars, ConfidenceScatter } from '../components/StoryViews';

// n trades at score `conf`: `wins` of them at +winR, the rest at lossR.
const band = (conf, n, wins, winR, lossR) =>
  Array.from({ length: n }, (_, i) => ({ conf, r: i < wins ? winR : lossR, ref: `${conf}-${i}`, und: 'SPX', family: 'Bull put', pnl: 0 }));

// Vasa's 25 Nov card: 10 / 9 / 17 / 6 trades, 70 / 78 / 59 / 83% won.
const nov25 = [
  ...band(15, 10, 7, 0.9, -0.97),     // ≈ +0.34R
  ...band(30, 9, 7, 0.28, -1.07),     // ≈ −0.02R
  ...band(45, 17, 10, 0.5, -0.81),    // ≈ −0.04R
  ...band(55, 6, 5, 0.3, -1.14),      // ≈ +0.06R
];

describe('calibration bands', () => {
  it('adds the Wilson win range, the R range and the sample label', () => {
    const c = calibration(nov25);
    expect(c.map(x => x.n)).toEqual([10, 9, 17, 6]);
    expect(c.map(x => x.read)).toEqual(['early', 'few', 'early', 'few']);
    expect(c[0].winCI.lo).toBeCloseTo(0.397, 2);
    expect(c[0].winCI.hi).toBeCloseTo(0.892, 2);
    expect(c[0].rCI.lo).toBeLessThan(0);
    expect(c[0].rCI.hi).toBeGreaterThan(0.6);
  });

  it('does not tell Vasa to re-weight on the 25 Nov sample', () => {
    const r = calibrationRead(calibration(nov25));
    expect(r.kind).toBe('overlap');
    expect(r.text).toMatch(/No band is clearly better/);
    expect(r.text).toMatch(/2 bands under 10 trades not counted/);
    expect(r.text).not.toMatch(/Re-weight the score on its own/);
  });

  it('says too few when under two bands reach 10 trades', () => {
    const r = calibrationRead(calibration([...band(15, 12, 8, 0.5, -1), ...band(45, 5, 3, 0.5, -1)]));
    expect(r.kind).toBe('few');
    expect(r.text).toMatch(/1 of 2 bands has 10 or more/);
  });

  it('calls it early when bands are apart but under 30 trades', () => {
    const r = calibrationRead(calibration([...band(15, 15, 15, 0.6, 0), ...band(45, 15, 0, 0, -0.8)]));
    expect(r.kind).toBe('early');
    expect(r.text).toMatch(/0–24 band is clear of the 40–49 band, but it's early/);
  });

  it('says re-weight only when apart on 30+ trades each and not climbing', () => {
    const r = calibrationRead(calibration([...band(15, 30, 24, 0.6, -0.2), ...band(45, 30, 6, 0.2, -0.8)]));
    expect(r.kind).toBe('reweight');
    expect(r.text).toMatch(/Re-weight the score on its own results/);
  });

  it('says the score ranks right when it climbs and the ends are apart', () => {
    const r = calibrationRead(calibration([...band(15, 30, 6, 0.2, -0.8), ...band(45, 30, 24, 0.6, -0.2)]));
    expect(r.kind).toBe('climbs');
  });
});

describe('CalibrationBars card', () => {
  it('draws a win range per band, the R ranges and the early / too few pills', () => {
    render(<CalibrationBars trades={nov25} />);
    expect(screen.getAllByTestId('cal-win-range')).toHaveLength(4);
    const first = screen.getByTestId('cal-band-0–24');
    expect(within(first).getByTestId('cal-r-range').textContent).toMatch(/−0\.\d\d to \+0\.\d\dR/);
    expect(within(first).getByText('early')).toBeTruthy();
    expect(within(screen.getByTestId('cal-band-50+')).getByText('too few')).toBeTruthy();
    expect(screen.getByTestId('cal-read').dataset.kind).toBe('overlap');
  });
});

describe('ConfidenceScatter read-out', () => {
  it('does not call higher scores better when the ranges overlap', () => {
    const t = [...band(30, 8, 5, 0.3, -0.5), ...band(60, 6, 5, 0.4, -0.5)];
    render(<ConfidenceScatter trades={t} />);
    const txt = screen.getByText(/Read it:/).parentElement.textContent;
    expect(txt).toMatch(/ranges overlap \(a side has under 10 trades\)/);
    expect(txt).not.toMatch(/Higher scores are paying more/);
  });
});
