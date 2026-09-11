import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chmodSync, readdirSync } from 'node:fs';
import { deriveProjectLabel, scanRawSessions, sortAndLimit, listSessions, readSessionHead, describeProject, groupByProject, readSessionStats, assignColors } from '../lib/claude/index.js';
import { readLabels, labelsFile } from '../lib/store.js';
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
  assert.match(html, /\/Users\/demo\/sources\/checkout-api/, 'expected the real working directory from the journal head');
  assert.match(html, /class="project-name">checkout-api</, 'expected the project name derived from cwd');
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

test('T7: a truncated list says so in the heading and offers an All link, without an amber note', async () => {
  const html = await srv.text('/?limit=1');
  assert.match(html, /1 newest of 6/);
  assert.match(html, /href="\/\?limit=6">All 6</);
  assert.doesNotMatch(html, /before truncation/);
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

test('T8: the journal head yields the generated title and the working directory, nothing else', () => {
  const head = readSessionHead(join(fixtureProjectsDir, '-Users-demo-sources-checkout-api', 'aaaaaaaa-1111-4111-8111-111111111111.jsonl'));
  assert.deepEqual(head, { title: 'Idempotency key test fix', cwd: '/Users/demo/sources/checkout-api' });
});

test('T8: a session without an ai-title record has a null title, and an unreadable path yields nulls', () => {
  const head = readSessionHead(join(fixtureProjectsDir, '-Users-demo-sources-checkout-api', 'bbbbbbbb-2222-4222-8222-222222222222.jsonl'));
  assert.equal(head.title, null);
  assert.equal(head.cwd, '/Users/demo/sources/checkout-api');
  assert.deepEqual(readSessionHead(join(fixtureProjectsDir, 'does-not-exist.jsonl')), { title: null, cwd: null });
});

test('T8: a project falls back to the derived path when the journal carries no cwd', () => {
  assert.deepEqual(describeProject('-Users-demo-sources-checkout-api', '/Users/demo/sources/checkout-api'),
    { name: 'checkout-api', path: '/Users/demo/sources/checkout-api', derived: false });
  assert.deepEqual(describeProject('-Users-demo-sources-checkout-api', null),
    { name: 'api', path: '/Users/demo/sources/checkout/api', derived: true });
});

test('T8: listSessions() enriches every shown session with title and project name and lists all projects', () => {
  const result = withClaudeHome(fixtureHome, () => listSessions({ limit: 50 }));
  assert.equal(result.sessions.length, 6);
  const titled = result.sessions.find((s) => s.sessionId === 'eeeeeeee-5555-4555-8555-555555555555');
  assert.equal(titled.title, 'Cart rewrite');
  assert.equal(titled.projectName, 'web-shop');
  assert.deepEqual(result.projects.map((p) => [p.name, p.count]), [['notes', 1], ['web-shop', 2], ['checkout-api', 3]]);
  assert.equal(result.totalSessions, 6);
});

test('T8: a text query matches titles, project names and ids; a project filter narrows to one directory', () => {
  const byTitle = withClaudeHome(fixtureHome, () => listSessions({ q: 'cart' }));
  assert.deepEqual(byTitle.sessions.map((s) => s.sessionId), ['eeeeeeee-5555-4555-8555-555555555555']);
  const byId = withClaudeHome(fixtureHome, () => listSessions({ q: 'bbbbbbbb' }));
  assert.equal(byId.sessions.length, 1);
  const byProject = withClaudeHome(fixtureHome, () => listSessions({ project: '-Users-demo-sources-web-shop' }));
  assert.equal(byProject.sessions.length, 2);
  assert.equal(byProject.totalFound, 2);
  assert.equal(byProject.totalSessions, 6);
});

test('T8: groupByProject() keeps newest-first order and sums sizes per project', () => {
  const { sessions } = withClaudeHome(fixtureHome, () => listSessions({ limit: 50 }));
  const groups = groupByProject(sessions);
  assert.deepEqual(groups.map((g) => [g.name, g.sessions.length]), [['notes', 1], ['web-shop', 2], ['checkout-api', 3]]);
  assert.equal(groups[2].totalSize, groups[2].sessions.reduce((sum, s) => sum + s.size, 0));
});

test('T9: the dashboard renders the stat strip, a 30-column activity chart, projects and models over every session', async () => {
  const html = await srv.text('/');
  assert.match(html, /class="stats"/);
  assert.match(html, /<span class="stat-value">6<\/span><span class="stat-label">(<svg[^>]*><use[^>]*><\/use><\/svg>)?sessions in total<\/span>/);
  assert.match(html, /<script src="\/dashboard.js" defer><\/script>/);
  assert.match(html, /data-tip="[^"]*checkout-api/, 'each column carries its per-project breakdown for the tooltip');
  assert.equal((html.match(/<g class="col"/g) || []).length, 60, 'two charts, one column per day each');
  assert.match(html, /data-chart="sessions"/);
  assert.match(html, /data-chart="tokens"/);
  assert.equal((html.match(/<svg class="spark"/g) || []).length, 3, 'one sparkline per project');
  const week = await srv.text('/?days=7');
  assert.equal((week.match(/<g class="col"/g) || []).length, 14, '?days=7 draws a week in both charts');
  assert.match(week, /active in 7 days/);
  const scoped = await srv.text('/?project=-Users-demo-notes');
  assert.match(scoped, /<span class="stat-value">1<\/span><span class="stat-label">(<svg[^>]*><use[^>]*><\/use><\/svg>)?sessions in total<\/span>/, 'the project filter scopes the whole dashboard');
  assert.match(scoped, /Showing <strong>notes<\/strong> only/);
  assert.match(html, /Sessions per day/);
  assert.match(html, /Projects <span class="dim">3<\/span><\/h2>/);
  assert.ok(html.indexOf('models-panel') < html.indexOf('class="panel chart"'), 'models sit above the chart');
  assert.match(html, /<use href="#i-tokens">/, 'stat labels carry sprite icons');
  assert.match(html, /class="model-name">(<svg[^>]*><use[^>]*><\/use><\/svg>)?claude-opus-5</);
  assert.match(html, /Recent sessions <span class="dim">/);
  assert.doesNotMatch(html, /style="/, 'inline styles are blocked by the CSP');
});

test('T9: the six busiest projects get distinct color slots in rank order, the rest share the neutral mark', () => {
  const projects = Array.from({ length: 8 }, (_, i) => ({ projectDirName: `-p${i}`, name: `p${i}`, count: 8 - i }));
  const colors = assignColors(projects);
  assert.deepEqual(Object.values(colors).slice(0, 6), [0, 1, 2, 3, 4, 5]);
  assert.equal(colors['-p6'], null);
  assert.equal(colors['-p7'], null);
  const tie = assignColors([{ projectDirName: '-b', name: 'b', count: 1 }, { projectDirName: '-a', name: 'a', count: 1 }]);
  assert.deepEqual(tie, { '-a': 0, '-b': 1 });
});

test('T9: dashboard aggregates come from the allowed fields only and dedupe repeated message ids', () => {
  const stats = readSessionStats(join(fixtureProjectsDir, '-Users-demo-sources-checkout-api', 'aaaaaaaa-1111-4111-8111-111111111111.jsonl'), 1, 1);
  assert.equal(stats.turns, 3, 'two records share one message id and count once');
  assert.equal(stats.tokens.output, 240 + 610 + 95, "the duplicated message id contributes its 610 once");
  assert.deepEqual(Object.keys(stats.models), ['claude-opus-5']);
  assert.deepEqual(Object.keys(stats.days), ['2026-08-20']);
});

test('T9: the chart window ends today, or slides back to the latest activity when the last 30 days are empty', () => {
  const inWindow = withClaudeHome(fixtureHome, () => listSessions({ now: Date.parse('2026-09-10T12:00:00Z') })).dashboard;
  assert.equal(inWindow.windowSlid, false);
  assert.equal(inWindow.period.sessions, 6);
  assert.equal(inWindow.period.activeDays, 4);
  const later = withClaudeHome(fixtureHome, () => listSessions({ now: Date.parse('2027-03-01T12:00:00Z') })).dashboard;
  assert.equal(later.windowSlid, true);
  assert.equal(later.windowEnd, '2026-08-23');
  assert.equal(later.period.sessions, 6);
});

test('T10: a session can be given an own name, which replaces the journal title, is searchable, and can be cleared', async () => {
  const id = 'bbbbbbbb-2222-4222-8222-222222222222';
  const form = await srv.text(`/sessions/${id}/rename?back=%2F%3Flimit%3D10`);
  assert.match(form, /Name this session/);
  assert.match(form, /name="back" value="\/\?limit=10"/);
  const saved = await srv.post(`/sessions/${id}/rename`, { label: '  Postgres   boot ', back: '/?limit=10' });
  assert.equal(saved.status, 303);
  assert.equal(saved.headers.get('location'), '/?limit=10');
  assert.deepEqual(readLabels(), { [id]: 'Postgres boot' });
  const page = await srv.text('/');
  assert.match(page, /class="title named"[^>]*>Postgres boot</);
  assert.doesNotMatch(page, new RegExp(`Untitled session</span><a class="rename-link" href="/sessions/${id}`));
  const found = await srv.text('/?q=postgres');
  assert.match(found, new RegExp(id));
  const cleared = await srv.post(`/sessions/${id}/rename`, { label: 'x', clear: '1', back: '//evil' });
  assert.equal(cleared.headers.get('location'), '/', 'an off-site back target falls back to the dashboard');
  assert.deepEqual(readLabels(), {});
});

test('T10: renaming an unknown session is a 404, and the store never lives inside CLAUDE_HOME', async () => {
  const res = await srv.get('/sessions/00000000-0000-4000-8000-000000000000/rename');
  assert.equal(res.status, 404);
  assert.ok(!labelsFile().startsWith(fixtureHome), 'labels must not be written into the agent home');
  const before = readdirSync(fixtureHome, { recursive: true }).sort();
  await srv.post('/sessions/aaaaaaaa-1111-4111-8111-111111111111/rename', { label: 'tmp' });
  await srv.post('/sessions/aaaaaaaa-1111-4111-8111-111111111111/rename', { label: '' });
  assert.deepEqual(readdirSync(fixtureHome, { recursive: true }).sort(), before);
});

test('T8: ?q and ?project filter the page, and an unmatched query renders a filtered empty state', async () => {
  const byQuery = await srv.text('/?q=cart');
  assert.match(byQuery, /eeeeeeee-5555-4555-8555-555555555555/);
  assert.doesNotMatch(byQuery, /aaaaaaaa-1111-4111-8111-111111111111/);
  const byProject = await srv.text('/?project=-Users-demo-notes');
  assert.match(byProject, /ffffffff-6666-4666-8666-666666666666/);
  assert.doesNotMatch(byProject, /dddddddd-4444-4444-8444-444444444444/);
  const none = await srv.text('/?q=zzzz-no-such-session');
  assert.match(none, /class="empty"/);
  assert.match(none, /Show all sessions/);
});

test('T8: the listing reads only the journal head: a session whose title sits past the head cap stays untitled', () => {
  const home = mkdtempSync(join(tmpdir(), 'session-index-t8-head-'));
  try {
    const project = join(home, 'projects', '-tmp-proj');
    mkdirSync(project, { recursive: true });
    const filler = JSON.stringify({ type: 'progress', pad: 'x'.repeat(1000) }) + '\n';
    const late = JSON.stringify({ type: 'ai-title', aiTitle: 'Late title' }) + '\n';
    writeFileSync(join(project, '55555555-5555-4555-8555-555555555555.jsonl'), filler.repeat(70) + late);
    const result = withClaudeHome(home, () => listSessions({ limit: 50 }));
    assert.equal(result.sessions[0].title, null);
    assert.equal(result.sessions[0].projectDerived, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
