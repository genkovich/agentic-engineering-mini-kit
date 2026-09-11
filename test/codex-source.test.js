// T27: the source contract itself. Task 9 adds the Codex adapter; this file guards the shape it
// will have to satisfy, and that the orchestration over the registry still describes Claude
// exactly as the single-source dashboard did.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';
import { registerSource, listSources, allSources, getSource, projectDirNameFor } from '../lib/sources.js';
import { listSessions, getSession } from '../lib/sessions.js';
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
