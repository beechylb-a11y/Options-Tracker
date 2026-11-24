// Engine version stamps (Nov 2026), computed at build time by vite.config.js.
//
// engineCommit: the git commit the app was built from. Railway passes it as
//   RAILWAY_GIT_COMMIT_SHA (the Docker build has no .git); a local build asks git.
// rulesHash: a hash of the engine's own source (client/src/engine, tests excluded).
//   It changes when a gate, threshold, model or exit rule changes and stays the same
//   across UI-only deploys, so verdicts can be grouped by the rules that made them.
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function engineCommit(env = process.env, cwd = process.cwd()) {
  const fromEnv = env.RAILWAY_GIT_COMMIT_SHA || env.GIT_COMMIT || env.SOURCE_COMMIT;
  if (fromEnv) return String(fromEnv).slice(0, 7);
  try {
    return execSync('git rev-parse --short=7 HEAD', { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'dev';
  } catch {
    return 'dev';
  }
}

/** Hash of every non-test .js file in dir, by name order; line endings normalised. */
export function rulesHash(dir) {
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.js') && !/\.test\.js$/.test(f))
    .sort();
  const h = createHash('sha256');
  for (const f of files) {
    h.update(f + '\n');
    h.update(readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n'));
    h.update('\n\0\n');
  }
  return h.digest('hex').slice(0, 10);
}
