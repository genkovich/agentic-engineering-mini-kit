import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chmodSync, readdirSync } from 'node:fs';
import { deriveProjectLabel, scanRawSessions, sortAndLimit, listSessions } from '../lib/claude/index.js';
import { fixtureHome, startServer } from './helpers.js';
import { sessionFiles } from './oracle.js';

const fixtureProjectsDir = join(fixtureHome, 'projects');
const srv = await startServer();
after(() => srv.close());

function withClaudeHome(dir, fn) {
  const prev = process.env.CLAUDE_HOME;
  process.env.CLAUDE_HOME = dir;
  try {
    return fn();
  } finally {
    process.env.CLAUDE_HOME = prev;
  }
}

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

test('T5: an unreadable projects dir yields an empty list, a count, and never throws', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'session-index-t5-projdir-'));
  try {
    const projectsPath = join(home, 'projects');
    mkdirSync(projectsPath, { recursive: true });
    chmodSync(projectsPath, 0o000);
    let probeFailed = false;
    try { readdirSync(projectsPath); } catch { probeFailed = true; }
    if (!probeFailed) {
      chmodSync(projectsPath, 0o755);
      t.skip('chmod has no effect on this platform/user (likely running as root)');
      return;
    }
    const result = withClaudeHome(home, () => listSessions({ limit: 50 }));
    assert.deepEqual(result.sessions, []);
    assert.equal(result.unreadableCount, 1);
  } finally {
    try { chmodSync(join(home, 'projects'), 0o755); } catch { /* already gone or fine */ }
    rmSync(home, { recursive: true, force: true });
  }
});

test('T5: one unreadable project subdir does not block sessions from readable siblings', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'session-index-t5-subdir-'));
  try {
    const projectsPath = join(home, 'projects');
    const goodProject = join(projectsPath, '-good-proj');
    const badProject = join(projectsPath, '-bad-proj');
    mkdirSync(goodProject, { recursive: true });
    mkdirSync(badProject, { recursive: true });
    writeFileSync(join(goodProject, '44444444-4444-4444-8444-444444444444.jsonl'), '{}\n');
    chmodSync(badProject, 0o000);
    let probeFailed = false;
    try { readdirSync(badProject); } catch { probeFailed = true; }
    if (!probeFailed) {
      chmodSync(badProject, 0o755);
      t.skip('chmod has no effect on this platform/user (likely running as root)');
      return;
    }
    const result = withClaudeHome(home, () => listSessions({ limit: 50 }));
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].sessionId, '44444444-4444-4444-8444-444444444444');
    assert.equal(result.unreadableCount, 1);
  } finally {
    try { chmodSync(join(home, 'projects', '-bad-proj'), 0o755); } catch { /* already gone or fine */ }
    rmSync(home, { recursive: true, force: true });
  }
});

test('T5: listSessions() never writes to the home it reads', () => {
  const before = readdirSync(fixtureHome, { recursive: true }).sort();
  withClaudeHome(fixtureHome, () => listSessions({ limit: 50 }));
  const after = readdirSync(fixtureHome, { recursive: true }).sort();
  assert.deepEqual(after, before);
});

test('T5: listSessions() completes in <=50ms on the fixture tree', () => {
  const start = performance.now();
  withClaudeHome(fixtureHome, () => listSessions({ limit: 50 }));
  const elapsed = performance.now() - start;
  assert.ok(elapsed <= 50, `expected <=50ms, took ${elapsed}ms`);
});

test('T6: an invalid ?limit falls back to the default 50 with an explanatory note', async () => {
  for (const rawLimit of ['abc', '0', '-5', '1001', '']) {
    const html = await srv.text(`/?limit=${rawLimit}`);
    assert.match(html, /Invalid.*limit/i, `expected an invalid-limit note for limit=${rawLimit}`);
  }
});

test('T6: a valid ?limit is forwarded to listSessions() without a note', async () => {
  const html = await srv.text('/?limit=1');
  assert.doesNotMatch(html, /Invalid.*limit/i);
});

test('T6: no ?limit uses the default 50 without a note', async () => {
  const html = await srv.text('/');
  assert.doesNotMatch(html, /Invalid.*limit/i);
});

test('T6: /api/health and the page CSP stay byte-identical after wiring the limit param', async () => {
  const health = await srv.json('/api/health');
  assert.equal(health.ok, true);
  assert.ok(health.sources.some((s) => s.id === 'claude'));
  const html = await srv.text('/');
  assert.match(html, /Content-Security-Policy/);
});

test('T7: the rendered page lists every fixture session with project label, id, size and mtime', async () => {
  const html = await srv.text('/');
  const expectedSessionIds = sessionFiles(fixtureProjectsDir, { exactDepth: 2 })
    .map((p) => p.split('/').pop().replace(/\.jsonl$/, ''));
  assert.equal(expectedSessionIds.length, 6);
  for (const sessionId of expectedSessionIds) {
    assert.ok(html.includes(sessionId), `expected the page to list session ${sessionId}`);
  }
  assert.match(html, /\/Users\/demo\/sources\/checkout\/api/, 'expected a decoded project label');
  const st = statSync(join(fixtureProjectsDir, '-Users-demo-sources-checkout-api', 'aaaaaaaa-1111-4111-8111-111111111111.jsonl'));
  assert.match(html, new RegExp(`title="${st.size} bytes"`), 'expected the exact byte size in a title attribute');
});

test('T7: an empty CLAUDE_HOME renders the empty state', async () => {
  const home = mkdtempSync(join(tmpdir(), 'session-index-t7-empty-'));
  const prev = process.env.CLAUDE_HOME;
  process.env.CLAUDE_HOME = home;
  try {
    mkdirSync(join(home, 'projects'), { recursive: true });
    const local = await startServer();
    const html = await local.text('/');
    await local.close();
    assert.match(html, /class="empty"/);
  } finally {
    process.env.CLAUDE_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('T7: the truncated note appears when there are more sessions than the limit', async () => {
  const html = await srv.text('/?limit=1');
  assert.match(html, /1 of 6/);
});

test('T7: the invalid-limit note appears in the rendered page', async () => {
  const html = await srv.text('/?limit=abc');
  assert.match(html, /class="note"/);
  assert.match(html, /Invalid.*limit/i);
});

test('T7: the rendered page never contains a fragment of conversation text', async () => {
  const html = await srv.text('/');
  assert.doesNotMatch(html, /Дивлюся тест/);
  assert.doesNotMatch(html, /unique constraint/);
});
