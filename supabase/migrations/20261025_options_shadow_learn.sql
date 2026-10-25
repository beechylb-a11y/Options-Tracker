-- Shadow verdicts, step 4 (Oct 2026): what the loop learns from each 0DTE session —
-- the verdict's own legs closed at 25% / 50% / held, a counterfactual grid of credit
-- spreads at the ½ VIX1D / IVX / VIX1D anchors (put and call side, each exit), and the
-- regime at entry. See client/src/engine/learn.js.
alter table options.shadow_verdicts
  add column if not exists learn jsonb,
  add column if not exists learned_at timestamptz;
