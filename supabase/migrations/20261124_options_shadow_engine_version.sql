-- Engine version stamps (Nov 2026): the build (git commit) and the engine-rules hash
-- behind each shadow verdict, so calibration can be split by the rules that made it.
-- The server writes these only once both columns exist (see shadowVersionColsReady in
-- server/db.js), so this can be applied before or after the app deploy.
alter table options.shadow_verdicts
  add column if not exists engine_commit text,
  add column if not exists rules_hash text;
create index if not exists shadow_verdicts_rules_hash_idx on options.shadow_verdicts (rules_hash);
