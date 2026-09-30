// Where a structure's value actually arrives in time.
//
// WHY THIS EXISTS. On 29 Sep a SPY 759/763/768 fly was held 11:35 → 15:35 and showed
// almost nothing. Nothing was wrong with the setup: that window is worth about a
// TENTH of the value the structure accrues over its life, because a butterfly is a
// terminal-value trade — it converges on its payoff only as the distribution of
// expiry prices collapses onto the body, and 57% of that happens in the last two
// hours of expiry day. The table below is computable at entry from the strikes, EM
// and time to expiry, so the holding plan can be a decision rather than a discovery.
//
// Display only. This touches no score, no gate and no sizing. (Sep 2026.)

const SESSION_HOURS = 6.5;      // 09:30–16:00
const SESSIONS_PER_YEAR = 252;

const cnd = x => {
  // Abramowitz & Stegun 7.1.26 via erf; accurate to ~1e-7, which is far past what
  // any of this is claiming.
  const s = x < 0 ? -1 : 1, z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + s * y);
};

export function bsPrice(S, K, T, sig, right) {
  if (!(S > 0 && K > 0 && sig > 0)) return NaN;
  if (T <= 0) return right === 'P' ? Math.max(K - S, 0) : Math.max(S - K, 0);
  const v = sig * Math.sqrt(T);
  const d1 = (Math.log(S / K) + 0.5 * sig * sig * T) / v, d2 = d1 - v;
  return right === 'P'
    ? K * cnd(-d2) - S * cnd(-d1)
    : S * cnd(d1) - K * cnd(d2);
}

// Legs: [{ strike, right:'C'|'P', ratio }] — ratio signed. Value per share.
export function structureValue(legs, S, sessionsLeft, sigAnnual) {
  const T = Math.max(0, sessionsLeft) / SESSIONS_PER_YEAR;
  return legs.reduce((a, l) => a + l.ratio * bsPrice(S, l.strike, T, sigAnnual, l.right), 0);
}

export function intrinsicValue(legs, S) {
  return legs.reduce((a, l) => a + l.ratio *
    (l.right === 'P' ? Math.max(l.strike - S, 0) : Math.max(S - l.strike, 0)), 0);
}

// The best the structure can ever be worth: its highest intrinsic, which for a pin
// structure sits at the body.
export function ceiling(legs) {
  const strikes = [...new Set(legs.map(l => l.strike))].sort((a, b) => a - b);
  let best = { strike: strikes[0] ?? null, value: -Infinity };
  for (const K of strikes) {
    const v = intrinsicValue(legs, K);
    if (v > best.value) best = { strike: K, value: v };
  }
  return best;
}

// Annualised sigma implied by a session expected move, in the underlying's points.
export const sigmaFromEM = (em, price) =>
  (em > 0 && price > 0) ? (em / price) * Math.sqrt(SESSIONS_PER_YEAR) : NaN;

// Sessions remaining until expiry. `hoursLeftToday` is hours to the 16:00 bell of the
// current session; `extraSessions` is whole sessions after it (0 for a 0DTE, 1 for a
// trade on tomorrow's expiry).
export const sessionsToExpiry = (hoursLeftToday, extraSessions = 0) =>
  Math.max(0, (hoursLeftToday || 0) / SESSION_HOURS) + Math.max(0, extraSessions);

// Checkpoints from now to expiry, coarse near the start and fine at the end — which
// is where a pin structure does nearly all of its work.
function checkpoints(sessionsLeft) {
  const marks = [1.70, 1.35, 1.00, 0.75, 0.50, 0.31, 0.15, 0.08, 0.02]
    .filter(m => m < sessionsLeft - 1e-6);
  return [sessionsLeft, ...marks, 0];
}

// Label a remaining-sessions figure as a clock time when it falls inside the final
// session; otherwise say how many sessions are left.
function label(sessions) {
  if (sessions <= 0) return 'expiry';
  if (sessions >= 1) return `${sessions.toFixed(2)} sessions left`;
  const minsLeft = sessions * SESSION_HOURS * 60;
  const mins = 16 * 60 - minsLeft;
  const h = Math.floor(mins / 60), m = Math.round(mins - h * 60);
  return `expiry day ${String(h).padStart(2, '0')}:${String(m % 60 === 0 && m !== 0 ? 0 : m).padStart(2, '0')} ET`;
}

// The table.
//
// `atBody` is the best case — spot pinned on the body the whole way — and is the
// right column for planning, because it isolates the TIME question from the
// direction question. `atSpot` holds spot where it is now, which is what happens if
// the underlying does nothing.
export function accrualTable({ legs, spot, em, sessionsLeft, sigAnnual }) {
  const sig = sigAnnual || sigmaFromEM(em, spot);
  if (!legs?.length || !(sig > 0) || !(sessionsLeft > 0)) return null;
  const cap = ceiling(legs);
  const rows = checkpoints(sessionsLeft).map(s => ({
    sessions: s,
    label: label(s),
    atBody: structureValue(legs, cap.strike, s, sig),
    atSpot: structureValue(legs, spot, s, sig),
  }));

  const first = rows[0], last = rows[rows.length - 1];
  const totalBody = last.atBody - first.atBody;
  return {
    bodyStrike: cap.strike,
    maxValue: cap.value,
    sigmaAnnual: sig,
    now: { value: first.atBody, atSpot: first.atSpot,
           pctOfMax: cap.value > 0 ? 100 * first.atBody / cap.value : null },
    totalRemaining: totalBody,
    rows: rows.map((r, i) => {
      const prev = i ? rows[i - 1] : null;
      const gain = prev ? r.atBody - prev.atBody : 0;
      return {
        ...r,
        gain,
        // The number that answers "is this window worth sitting through".
        shareOfRemaining: totalBody > 0 ? 100 * gain / totalBody : null,
        pctOfMax: cap.value > 0 ? 100 * r.atBody / cap.value : null,
      };
    }),
  };
}

// What a specific holding plan captures. `exitSessionsLeft` is the sessions remaining
// at the moment you intend to be out.
export function windowShare({ legs, spot, em, sessionsLeft, exitSessionsLeft, sigAnnual }) {
  const sig = sigAnnual || sigmaFromEM(em, spot);
  if (!legs?.length || !(sig > 0) || !(sessionsLeft > 0)) return null;
  const cap = ceiling(legs);
  const v = s => structureValue(legs, cap.strike, s, sig);
  const entry = v(sessionsLeft), exit = v(Math.max(0, exitSessionsLeft)), end = v(0);
  const total = end - entry;
  return {
    captured: exit - entry,
    total,
    pct: total > 0 ? 100 * (exit - entry) / total : null,
    // Plain-language verdict. The thresholds are deliberately blunt: this is meant
    // to stop a plan that collects a tenth of the move, not to fine-tune one.
    verdict: total <= 0 ? null
      : (exit - entry) / total >= 0.6 ? 'captures most of the move'
      : (exit - entry) / total >= 0.3 ? 'captures a useful share'
      : 'leaves most of the value on the table — hold later or do not open',
  };
}
