-- R-49 (Oct 2026): record which method built a ticket's strikes, the short legs'
-- live deltas and the POP they imply, so EM-built and delta-built trades can be compared.
alter table options.decisions
  add column if not exists strike_method text,
  add column if not exists short_deltas text,
  add column if not exists implied_pop text;
