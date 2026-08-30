import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { startServer, fixtureHome } from './helpers.js';

const srv = await startServer();
after(() => srv.close());

// The AC for S1: the count the API reports equals the count of *.jsonl files that are exactly one
// level inside a project directory. Not the recursive count — that one also sweeps up subagent
// transcripts under <sessionId>/subagents/.
function shellCount(depthArgs) {
  const out = execFileSync('/bin/sh', ['-c',
    `find "${fixtureHome}/projects" ${depthArgs} -name '*.jsonl' -type f | wc -l`]);
  return Number(out.toString().trim());
}

test('API session count equals the on-disk count of session files', async () => {
  const { total } = await srv.json('/api/sessions');
  assert.equal(total, shellCount('-mindepth 2 -maxdepth 2'));
});

test('the naive recursive count is higher, and we do not use it', () => {
  assert.ok(shellCount('') > shellCount('-mindepth 2 -maxdepth 2'),
    'the fixture must contain deeper *.jsonl noise, otherwise this AC proves nothing');
});

test('artifact directories are not indexed as sessions', async () => {
  const { sessions } = await srv.json('/api/sessions?limit=100');
  assert.equal(sessions.filter((s) => s.sessionId.startsWith('agent-')).length, 0);
  for (const s of sessions) assert.match(s.file, /\/[^/]+\/[^/]+\.jsonl$/);
});

test('rows carry project, size and mtime, and mark the project path as derived', async () => {
  const { sessions } = await srv.json('/api/sessions?limit=100');
  const one = sessions.find((s) => s.sessionId.startsWith('aaaaaaaa'));
  assert.ok(one, 'fixture session aaaaaaaa must be indexed');
  assert.equal(one.projectSlug, '-Users-demo-sources-checkout-api');
  assert.equal(one.projectPathDerived, true);
  assert.ok(one.sizeBytes > 0);
  assert.match(one.modifiedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('sessions are sorted freshest first', async () => {
  const { sessions } = await srv.json('/api/sessions?limit=100');
  const dates = sessions.map((s) => s.modifiedAt);
  assert.deepEqual(dates, [...dates].sort().reverse());
});

test('a missing Claude home renders an empty state instead of crashing', async () => {
  const { listSessions } = await import('../lib/claude/index.js');
  assert.deepEqual(listSessions({ home: '/nonexistent/claude/home' }), []);
});

test('the list page renders rows', async () => {
  const html = await srv.text('/');
  assert.match(html, /Sessions/);
  assert.match(html, /checkout\/api/);
});
