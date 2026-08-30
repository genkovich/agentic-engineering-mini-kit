import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

const srv = await startServer();
after(() => srv.close());

const bySessionPrefix = (sessions, prefix) => sessions.find((s) => s.sessionId.startsWith(prefix));

test('a session with an ai-title record shows that title', async () => {
  const { sessions } = await srv.json('/api/sessions?limit=100');
  const s = bySessionPrefix(sessions, 'aaaaaaaa');
  assert.equal(s.title, 'Idempotency key test fix');
  assert.equal(s.titleSource, 'ai-title');
});

test('a session without one falls back to the first prompt, and says so', async () => {
  const { sessions } = await srv.json('/api/sessions?limit=100');
  const s = bySessionPrefix(sessions, 'bbbbbbbb');
  assert.equal(s.titleSource, 'first prompt');
  assert.equal(s.title, 'Підніми локальний postgres і прогони міграції');
});

test('the first prompt is a human prompt, not a tool_result or an interrupt notice', async () => {
  const { sessions } = await srv.json('/api/sessions?limit=100');
  for (const s of sessions) {
    if (!s.firstPrompt) continue;
    assert.doesNotMatch(s.firstPrompt, /^\[Request interrupted/);
    assert.doesNotMatch(s.firstPrompt, /^<command-name>/);
  }
});

test('identity costs at most two bounded reads per file', async () => {
  const { sessions } = await srv.json('/api/sessions?limit=100');
  for (const s of sessions) assert.ok(s.reads <= 2, `${s.sessionId} took ${s.reads} reads`);
});

test('?titles=0 returns the bare S1 index with no identity fields', async () => {
  const { sessions } = await srv.json('/api/sessions?limit=100&titles=0');
  assert.ok(sessions.length > 0);
  for (const s of sessions) assert.equal(s.title, undefined);
});

test('the list page shows human titles, not raw ids', async () => {
  const html = await srv.text('/');
  assert.match(html, /Idempotency key test fix/);
  assert.match(html, /Підніми локальний postgres/);
});
