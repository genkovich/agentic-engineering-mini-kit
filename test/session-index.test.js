import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveProjectLabel, scanRawSessions } from '../lib/claude/index.js';
import { fixtureHome } from './helpers.js';
import { sessionFiles } from './oracle.js';

const fixtureProjectsDir = join(fixtureHome, 'projects');

test('T1: an encoded project directory name decodes to a readable path, marked as derived', () => {
  const result = deriveProjectLabel('-Users-demo-sources-checkout-api');
  assert.equal(result.label, '/Users/demo/sources/checkout/api');
  assert.equal(result.derived, true);
});

test('T1: a directory name that is not path-like falls back to itself, still marked as derived', () => {
  const result = deriveProjectLabel('notes-cache');
  assert.equal(result.label, 'notes-cache');
  assert.equal(result.derived, true);
});

test('T2: the raw scan finds exactly the session files two levels deep, not the nested subagent transcripts', () => {
  const expected = sessionFiles(fixtureProjectsDir, { exactDepth: 2 }).sort();
  const raw = scanRawSessions(fixtureProjectsDir);
  assert.equal(raw.length, 6);
  const actualPaths = raw.map((r) => r.path).sort();
  assert.deepEqual(actualPaths, expected);
});

test('T2: each raw session record carries sessionId, project dir name, size and mtime read from disk', () => {
  const raw = scanRawSessions(fixtureProjectsDir);
  const record = raw.find((r) => r.sessionId === 'cccccccc-3333-4333-8333-333333333333');
  assert.ok(record, 'expected the fixture session to be present');
  assert.equal(record.projectDirName, '-Users-demo-sources-checkout-api');
  const st = statSync(record.path);
  assert.equal(record.size, st.size);
  assert.equal(record.mtimeMs, st.mtimeMs);
});

test('T2: a session-level symlink is not considered a session', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'session-index-t2-'));
  try {
    const projectDir = join(tmp, 'projects', '-tmp-proj');
    mkdirSync(projectDir, { recursive: true });
    const realFile = join(tmp, 'real-session.jsonl');
    writeFileSync(realFile, '{}\n');
    symlinkSync(realFile, join(projectDir, '11111111-1111-4111-8111-111111111111.jsonl'));
    const raw = scanRawSessions(join(tmp, 'projects'));
    assert.equal(raw.length, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
