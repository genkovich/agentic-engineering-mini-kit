// T27: the source contract itself, and T28-T32 the Codex adapter that is the first thing to
// satisfy it besides Claude — its scan, its aggregates, the two sources summed on the dashboard,
// an empty Codex home, and the source reaching the API and the CSV.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, codexFixtureHome } from './helpers.js';
import { registerSource, listSources, allSources, getSource, projectDirNameFor } from '../lib/sources.js';
import { listSessions, getSession } from '../lib/sessions.js';
import '../lib/claude/index.js';
import {
  sessionsDir,
  scanCodexSessions,
  sessionIdFromFileName,
  readCodexHead,
  readCodexStats,
  readCodexTimeline,
} from '../lib/codex/index.js';

const srv = await startServer();
after(() => srv.close());

const CONTRACT = ['home', 'scan', 'readHead', 'describeProject', 'readStats', 'readTimeline', 'readExtras'];

test('T27: an adapter missing a contract member is refused, and the Claude adapter implements all of it', () => {
  assert.throws(
    () => registerSource({ id: 'x', label: 'X', home() {} }),
    /source adapter is missing "scan"/,
  );
  assert.throws(() => registerSource({ id: 'x', label: 'X' }), /source adapter is missing "home"/);
  assert.throws(() => registerSource({ label: 'X' }), /source adapter is missing "id"/);

  const claude = getSource('claude');
  assert.equal(claude.label, 'Claude Code');
  for (const member of CONTRACT) {
    assert.equal(typeof claude[member], 'function', `claude adapter must implement ${member}()`);
  }
});

test('T27: the registry lists what registered, in registration order', () => {
  const before = allSources().map((a) => a.id);
  // A stub that scans nothing: it proves a second source registers without changing what the
  // dashboard reads. Each test file is its own process, so it never reaches another suite.
  registerSource({
    id: 'stub', label: 'Stub', home: () => '/nowhere', scan: () => [],
    readHead: () => ({ title: null, cwd: null }),
    describeProject: () => ({ name: 'stub', path: '/nowhere', derived: true }),
    readStats: () => ({}), readTimeline: () => ({ events: [], total: 0, capped: false }),
    readExtras: () => ({ subagents: [], toolResults: { count: 0, bytes: 0 } }),
  });
  assert.deepEqual(allSources().map((a) => a.id), [...before, 'stub']);
  assert.deepEqual(listSources().map((s) => s.id), [...before, 'stub']);
  assert.ok(listSources().some((s) => s.id === 'stub' && s.label === 'Stub'));
});

test('T27: every session carries its source, and the index counts the sources it read', () => {
  const result = listSessions({ limit: 1000 });
  assert.deepEqual(result.sources.find((s) => s.id === 'claude'), { id: 'claude', label: 'Claude Code', count: 6 });
  assert.ok(result.sessions.length > 0);
  const claudeOnly = listSessions({ limit: 1000, source: 'claude' });
  for (const session of claudeOnly.sessions) {
    assert.deepEqual(session.source, { id: 'claude', label: 'Claude Code' });
  }
  assert.equal(claudeOnly.sessions.length, 6);
  assert.equal(listSessions({ limit: 1000, source: 'stub' }).sessions.length, 0);
});

test('T27: projectDirNameFor encodes a working directory into a routable project key', () => {
  const ROUTABLE = /^[A-Za-z0-9._-]{1,300}$/;
  assert.equal(projectDirNameFor('/Users/demo/sources/checkout-api'), '-Users-demo-sources-checkout-api');
  assert.equal(projectDirNameFor('C:\\Users\\demo\\web-shop'), 'C--Users-demo-web-shop');
  assert.equal(projectDirNameFor('/Users/demo/my app'), '-Users-demo-my-app');
  assert.equal(projectDirNameFor(''), 'unknown-project');
  for (const cwd of ['/Users/demo/sources/checkout-api', 'C:\\Users\\demo\\web-shop', '/Users/demo/my app', '', null]) {
    assert.match(projectDirNameFor(cwd), ROUTABLE, `${cwd} must encode to a routable key`);
  }
  assert.equal(projectDirNameFor('/'.padEnd(400, 'a')).length, 300);
});

test('T27: a source that throws is counted and skipped, never a 500', () => {
  const before = listSessions({ limit: 1000 });
  registerSource({
    id: 'boom', label: 'Boom', home: () => '/nowhere',
    scan() { throw new Error('this adapter is broken'); },
    readHead: () => ({ title: null, cwd: null }),
    describeProject: () => ({ name: 'boom', path: '/nowhere', derived: true }),
    readStats: () => ({}), readTimeline: () => ({ events: [], total: 0, capped: false }),
    readExtras: () => ({ subagents: [], toolResults: { count: 0, bytes: 0 } }),
  });
  const broken = listSessions({ limit: 1000 });
  assert.equal(broken.sessions.length, before.sessions.length, 'the Claude sessions still render');
  assert.equal(broken.unreadableCount, before.unreadableCount + 1);
  assert.deepEqual(broken.sources.find((s) => s.id === 'boom'), { id: 'boom', label: 'Boom', count: 0 });
  assert.equal(getSession('aaaaaaaa-1111-4111-8111-111111111111')?.source.id, 'claude');
});

test('T27: a record whose stats throw is skipped and counted, the rest of the source survives', () => {
  const before = listSessions({ limit: 1000 });
  registerSource({
    id: 'halfbroken', label: 'Half broken', home: () => '/nowhere',
    scan: () => [{ sessionId: 'eeeeeeee-9999-4999-8999-999999999999', projectDirName: 'x', size: 1, mtimeMs: 1, path: '/nowhere/x.jsonl' }],
    readHead: () => ({ title: null, cwd: null }),
    describeProject: () => ({ name: 'x', path: '/nowhere', derived: true }),
    readStats() { throw new Error('unreadable journal'); },
    readTimeline: () => ({ events: [], total: 0, capped: false }),
    readExtras: () => ({ subagents: [], toolResults: { count: 0, bytes: 0 } }),
  });
  const after = listSessions({ limit: 1000 });
  assert.equal(after.sessions.length, before.sessions.length, 'the broken record never reaches the list');
  assert.equal(after.unreadableCount, before.unreadableCount + 1);
  assert.deepEqual(after.sources.find((s) => s.id === 'halfbroken'), { id: 'halfbroken', label: 'Half broken', count: 0 });
  assert.equal(getSession('eeeeeeee-9999-4999-8999-999999999999'), null, 'an unreadable session is null, not a throw');
});

test('T27: an unknown ?source= is a note, not an empty page', async () => {
  const all = await srv.text('/');
  const html = await srv.text('/?source=nope');
  assert.match(html, /Unknown \?source=nope, showing every source instead\./);
  const rows = (s) => (s.match(/<td class="id" data-label="Session"/g) ?? []).length;
  assert.equal(rows(html), rows(all));
  assert.ok(rows(html) > 0, 'the fixture home must render some sessions');
});

test('T27: the project page takes ?source= too', async () => {
  const scoped = await srv.get('/projects/-Users-demo-sources-checkout-api?source=claude');
  assert.equal(scoped.status, 200);
  const unknown = await srv.get('/projects/-Users-demo-sources-checkout-api?source=nope');
  assert.equal(unknown.status, 200);
  assert.match(await unknown.text(), /Unknown \?source=nope, showing every source instead\./);
});

// -- Task 9: the Codex adapter itself ------------------------------------------------------

test('T28: the scan walks sessions/YYYY/MM/DD and keys each rollout by its uuid and working directory', () => {
  const records = scanCodexSessions(sessionsDir());
  assert.equal(records.length, 3, 'three synthetic rollouts across three days');
  assert.deepEqual(records.map((r) => r.sessionId).sort(), [
    'c0de0001-aa01-4a01-8a01-0000000000c1',
    'c0de0002-aa02-4a02-8a02-0000000000c2',
    'c0de0003-aa03-4a03-8a03-0000000000c3',
  ], 'the id is the uuid out of rollout-<timestamp>-<uuid>.jsonl, not the whole filename');
  const byProject = {};
  for (const r of records) byProject[r.projectDirName] = (byProject[r.projectDirName] ?? 0) + 1;
  assert.deepEqual(byProject, {
    // Derived from `cwd` with projectDirNameFor, which is the same key Claude Code writes on
    // disk — that is what merges the two sources into one project row.
    '-Users-demo-sources-checkout-api': 2,
    '-Users-demo-sources-cli-tools': 1,
  });
  assert.equal(sessionIdFromFileName('rollout-2026-08-21T09-12-03-c0de0001-aa01-4a01-8a01-0000000000c1.jsonl'),
    'c0de0001-aa01-4a01-8a01-0000000000c1');
  assert.equal(sessionIdFromFileName('no-uuid-here.jsonl'), 'no-uuid-here', 'an unusual name keeps its stem');
  // The scan must never reach outside the home it was pointed at.
  for (const r of records) assert.ok(r.path.startsWith(codexFixtureHome), `${r.path} escaped the fixture home`);
});

test('T29: Codex stats and timeline carry the numbers and the tool names, and no conversation text', () => {
  const record = scanCodexSessions(sessionsDir()).find((r) => r.sessionId.endsWith('c1'));
  const stats = readCodexStats(record.path, record.size, record.mtimeMs);
  // Two assistant `message` response_items; the user turn is counted once, from the
  // `user_message` event, though the rollout also persists it as a user `response_item`.
  assert.equal(stats.turns, 2);
  assert.equal(stats.prompts, 1);
  // Each token_count's `last_token_usage` is a delta: (1200-200)+(1500-500) non-cached input,
  // 200+500 cached, 100 cache-write, 300+250 output.
  assert.deepEqual(stats.tokens, { input: 2000, output: 550, cacheRead: 700, cacheWrite: 100 });
  assert.deepEqual(Object.keys(stats.models), ['gpt-5-codex'], 'the model comes from turn_context');
  assert.deepEqual(stats.tools, { shell: { calls: 1, errors: 0 }, apply_patch: { calls: 1, errors: 1 } });
  assert.deepEqual(stats.compacts, { count: 1, preTokens: 0, postTokens: 0 });
  assert.deepEqual(Object.keys(stats.days), ['2026-08-21']);

  const timeline = readCodexTimeline(record.path, record.size, record.mtimeMs);
  assert.deepEqual(timeline.events.map((e) => e.kind), ['prompt', 'turn', 'result', 'turn', 'result', 'compact']);
  const [firstTurn] = timeline.events.filter((e) => e.kind === 'turn');
  assert.equal(firstTurn.model, 'gpt-5-codex');
  assert.deepEqual(firstTurn.tools, [{ id: 'call_x1', name: 'shell' }]);
  assert.deepEqual(firstTurn.tokens, { input: 1000, output: 300, cacheRead: 200, cacheWrite: 100 });
  assert.deepEqual(timeline.events.filter((e) => e.kind === 'result').map((e) => [e.name, e.ok]),
    [['shell', true], ['apply_patch', false]]);

  // A `local_shell_call` is named `shell`, and a `custom_tool_call` keeps its own name.
  const shellSession = scanCodexSessions(sessionsDir()).find((r) => r.sessionId.endsWith('c2'));
  assert.deepEqual(Object.keys(readCodexStats(shellSession.path, shellSession.size, shellSession.mtimeMs).tools), ['shell']);
  const planSession = scanCodexSessions(sessionsDir()).find((r) => r.sessionId.endsWith('c3'));
  assert.deepEqual(Object.keys(readCodexStats(planSession.path, planSession.size, planSession.mtimeMs).tools), ['update_plan']);

  // Every text field in the fixtures is the placeholder "x": none of it may reach an aggregate.
  const placeholder = `${String.fromCharCode(34)}x${String.fromCharCode(34)}`;
  assert.ok(!JSON.stringify(stats).includes(placeholder), 'no message text reached the stats');
  assert.ok(!JSON.stringify(timeline).includes(placeholder), 'no message text reached the timeline');
  assert.equal(readCodexHead(record.path).title, null, 'Codex generates no session title');
  assert.equal(readCodexHead(record.path).cwd, '/Users/demo/sources/checkout-api');
});

test('T30: the dashboard sums both sources, and ?source= narrows to one', async () => {
  const result = listSessions({ limit: 1000 });
  // The T27 cases above register stub adapters into this same process, so compare the two real
  // sources rather than the whole registry — their relative order is the registration order.
  const real = result.sources.filter((s) => s.id === 'claude' || s.id === 'codex');
  assert.deepEqual(real, [
    { id: 'claude', label: 'Claude Code', count: 6 },
    { id: 'codex', label: 'Codex CLI', count: 3 },
  ], 'registration order: claude, then codex');
  assert.equal(result.totalSessions, 9);
  // The shared working directory merges three Claude sessions and two Codex ones into one project.
  const checkout = result.projects.find((p) => p.projectDirName === '-Users-demo-sources-checkout-api');
  assert.equal(checkout.count, 5);

  const codexOnly = listSessions({ limit: 1000, source: 'codex' });
  assert.equal(codexOnly.sessions.length, 3);
  for (const s of codexOnly.sessions) assert.deepEqual(s.source, { id: 'codex', label: 'Codex CLI' });

  const html = await srv.text('/?source=codex');
  for (const id of ['c0de0001-aa01-4a01-8a01-0000000000c1', 'c0de0003-aa03-4a03-8a03-0000000000c3']) {
    assert.ok(html.includes(id), `?source=codex must list ${id}`);
  }
  assert.ok(!html.includes('ffffffff-6666-4666-8666-666666666666'), 'no Claude session on the codex-scoped page');
  // The badge names both sources with their counts, and each row says which source it came from.
  const all = await srv.text('/');
  assert.match(all, /<span class="source" title="[^"]*claude-home">Claude Code <span class="dim">6<\/span><\/span>/);
  assert.match(all, /<span class="source" title="[^"]*codex-home">Codex CLI <span class="dim">3<\/span><\/span>/);
  assert.match(all, /class="chip chip-source"[^>]*>Codex CLI</);
  assert.match(all, /class="chip chip-source"[^>]*>Claude Code</);
});

test('T31: an empty CODEX_HOME leaves the source visible with nothing in it, and the page still works', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'codex-home-empty-'));
  const previous = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = empty;
    const result = listSessions({ limit: 1000 });
    assert.deepEqual(result.sources.find((s) => s.id === 'codex'), { id: 'codex', label: 'Codex CLI', count: 0 });
    assert.equal(result.totalSessions, 6, 'only the Claude fixtures are left');
    const page = await srv.get('/');
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes('ffffffff-6666-4666-8666-666666666666'), 'the six Claude sessions still render');
    assert.match(html, /<span class="source" title="[^"]*codex-home-empty[^"]*">Codex CLI <span class="dim">0<\/span><\/span>/);
  } finally {
    process.env.CODEX_HOME = previous;
    rmSync(empty, { recursive: true, force: true });
  }
});

test('T32: the API, the health endpoint and the CSV all carry the source', async () => {
  const api = await srv.json('/api/sessions?limit=1000');
  // Same process, same registry: the stub adapters from T27 are filtered out here too.
  assert.deepEqual(api.sources.filter((s) => s.id === 'claude' || s.id === 'codex'), [
    { id: 'claude', label: 'Claude Code', count: 6 },
    { id: 'codex', label: 'Codex CLI', count: 3 },
  ]);
  for (const item of api.sessions) {
    assert.ok(item.source && typeof item.source.id === 'string', 'every API session names its source');
  }
  assert.deepEqual([...new Set(api.sessions.map((s) => s.source.id))].sort(), ['claude', 'codex']);

  const health = await srv.json('/api/health');
  const homes = health.sources.filter((s) => s.id === 'claude' || s.id === 'codex');
  assert.deepEqual(homes.map((s) => s.id), ['claude', 'codex']);
  assert.ok(homes[0].home.endsWith(join('fixtures', 'claude-home')), 'health names the Claude home it reads');
  assert.ok(homes[1].home.endsWith(join('fixtures', 'codex-home')), 'health names the Codex home it reads');

  const csv = await srv.text('/overview.csv?table=sessions');
  const [header, ...rows] = csv.trim().split('\r\n');
  const column = header.split(',').indexOf('source');
  assert.ok(column >= 0, 'the sessions CSV has a source column');
  const values = new Set(rows.map((r) => r.split(',')[column]));
  assert.ok(values.has('claude') && values.has('codex'), `both sources in the CSV, saw ${[...values]}`);
});
