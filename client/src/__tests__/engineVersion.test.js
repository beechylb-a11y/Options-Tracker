import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { engineCommit, rulesHash } from '../../engineVersion.mjs';
import { ENGINE_COMMIT, RULES_HASH, versionLine } from '../utils/engineVersion';
import { DIMENSIONS } from '../engine/calibration';

function engineDir(files) {
  const d = mkdtempSync(path.join(tmpdir(), 'eng-'));
  for (const [f, body] of Object.entries(files)) writeFileSync(path.join(d, f), body);
  return d;
}

describe('engine version stamps', () => {
  it('uses the Railway commit when the build has no git', () => {
    expect(engineCommit({ RAILWAY_GIT_COMMIT_SHA: '1dc5513abcdef0123' }, '/')).toBe('1dc5513');
  });

  it('falls back to dev outside a repo with no commit variable', () => {
    expect(engineCommit({}, tmpdir())).toMatch(/^([0-9a-f]{7}|dev)$/);
  });

  it('rules hash changes with engine code and ignores tests', () => {
    const a = rulesHash(engineDir({ 'calc0dte.js': 'export const GATE = 1.25;\n', 'calc0dte.test.js': 'x' }));
    const sameRules = rulesHash(engineDir({ 'calc0dte.js': 'export const GATE = 1.25;\r\n', 'calc0dte.test.js': 'changed test' }));
    const newRule = rulesHash(engineDir({ 'calc0dte.js': 'export const GATE = 1.5;\n' }));
    expect(a).toMatch(/^[0-9a-f]{10}$/);
    expect(sameRules).toBe(a);
    expect(newRule).not.toBe(a);
  });

  it('a file renamed is a different rule set', () => {
    expect(rulesHash(engineDir({ 'a.js': 'x' }))).not.toBe(rulesHash(engineDir({ 'b.js': 'x' })));
  });

  it('client constants fall back when the build did not define them', () => {
    expect(typeof ENGINE_COMMIT).toBe('string');
    expect(typeof RULES_HASH).toBe('string');
    expect(versionLine()).toBe(`Engine: ${ENGINE_COMMIT} · rules ${RULES_HASH}`);
  });

  it('calibration can group verdicts by engine rules', () => {
    const d = DIMENSIONS.version;
    expect(d.label).toBe('Engine version');
    expect(d.keys({ rules_hash: '3fa9c0e1b2' })).toEqual(['rules 3fa9c0e1b2']);
    expect(d.keys({})).toEqual(['before stamps']);
  });
});
