import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveProjectLabel, scanRawSessions, sortAndLimit } from '../lib/claude/index.js';
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

test('T3: a project-dir symlink resolving outside CLAUDE_HOME contributes zero sessions', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'session-index-t3-home-'));
  const outside = mkdtempSync(join(tmpdir(), 'session-index-t3-outside-'));
  try {
    const projectsPath = join(home, 'projects');
    mkdirSync(projectsPath, { recursive: true });
    const outsideProject = join(outside, '-outside-proj');
    mkdirSync(outsideProject, { recursive: true });
    writeFileSync(join(outsideProject, '22222222-2222-4222-8222-222222222222.jsonl'), '{}\n');
    try {
      symlinkSync(outsideProject, join(projectsPath, '-linked-outside'));
    } catch {
      t.skip('symlink creation unavailable on this platform');
      return;
    }
    const raw = scanRawSessions(projectsPath);
    assert.equal(raw.length, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('T3: two symlinks resolving to the same inside directory contribute its sessions exactly once, in finite time', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'session-index-t3-dup-'));
  try {
    const projectsPath = join(home, 'projects');
    const realProject = join(home, 'real-proj');
    mkdirSync(projectsPath, { recursive: true });
    mkdirSync(realProject, { recursive: true });
    writeFileSync(join(realProject, '33333333-3333-4333-8333-333333333333.jsonl'), '{}\n');
    try {
      symlinkSync(realProject, join(projectsPath, '-link-a'));
      symlinkSync(realProject, join(projectsPath, '-link-b'));
    } catch {
      t.skip('symlink creation unavailable on this platform');
      return;
    }
    const raw = scanRawSessions(projectsPath);
    assert.equal(raw.length, 1);
    assert.equal(raw[0].sessionId, '33333333-3333-4333-8333-333333333333');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
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

test('T4: sessions with distinct mtimes sort newest-first', () => {
  const records = [
    { sessionId: 'a', mtimeMs: 100 },
    { sessionId: 'b', mtimeMs: 300 },
    { sessionId: 'c', mtimeMs: 200 },
  ];
  const { sessions } = sortAndLimit(records, { limit: 50 });
  assert.deepEqual(sessions.map((s) => s.sessionId), ['b', 'c', 'a']);
});

test('T4: two sessions with equal mtime order by session filename as a tie-break', () => {
  const records = [
    { sessionId: 'zzzz', mtimeMs: 100 },
    { sessionId: 'aaaa', mtimeMs: 100 },
  ];
  const { sessions } = sortAndLimit(records, { limit: 50 });
  assert.deepEqual(sessions.map((s) => s.sessionId), ['aaaa', 'zzzz']);
});

test('T4: a set above the limit is truncated, totalFound and truncated reflect the pre-truncation count', () => {
  const records = Array.from({ length: 55 }, (_, i) => ({ sessionId: String(i).padStart(3, '0'), mtimeMs: i }));
  const { sessions, totalFound, truncated } = sortAndLimit(records, { limit: 50 });
  assert.equal(sessions.length, 50);
  assert.equal(totalFound, 55);
  assert.equal(truncated, true);
  assert.equal(sessions[0].sessionId, '054');
});

test('T4: a set within the limit is not marked truncated', () => {
  const records = [{ sessionId: 'a', mtimeMs: 1 }];
  const { sessions, totalFound, truncated } = sortAndLimit(records, { limit: 50 });
  assert.equal(sessions.length, 1);
  assert.equal(totalFound, 1);
  assert.equal(truncated, false);
});
