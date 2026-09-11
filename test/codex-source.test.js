// T27: the source contract itself. Task 9 adds the Codex adapter; this file guards the shape it
// will have to satisfy, and that the orchestration over the registry still describes Claude
// exactly as the single-source dashboard did.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';
import { registerSource, listSources, allSources, getSource } from '../lib/sources.js';
import { listSessions } from '../lib/sessions.js';
import '../lib/claude/index.js';

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
  for (const session of result.sessions) {
    assert.deepEqual(session.source, { id: 'claude', label: 'Claude Code' });
  }
  assert.equal(listSessions({ limit: 1000, source: 'claude' }).sessions.length, result.sessions.length);
  assert.equal(listSessions({ limit: 1000, source: 'stub' }).sessions.length, 0);
});

test('T27: an unknown ?source= is a note, not an empty page', async () => {
  const all = await srv.text('/');
  const html = await srv.text('/?source=nope');
  assert.match(html, /Unknown \?source=nope, showing every source instead\./);
  const rows = (s) => (s.match(/<td class="id" data-label="Session"/g) ?? []).length;
  assert.equal(rows(html), rows(all));
  assert.ok(rows(html) > 0, 'the fixture home must render some sessions');
});
