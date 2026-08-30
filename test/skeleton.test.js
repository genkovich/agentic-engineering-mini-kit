import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, fixtureHome } from './helpers.js';

const srv = await startServer();
after(() => srv.close());

test('health reports the configured Claude home and the registered sources', async () => {
  const body = await srv.json('/api/health');
  assert.equal(body.ok, true);
  assert.equal(body.claudeHome, fixtureHome);
  assert.ok(body.sources.some((s) => s.id === 'claude'), 'claude adapter must be registered');
});

test('the shell renders and declares a CSP', async () => {
  const html = await srv.text('/');
  assert.match(html, /<title>agent-ops<\/title>/);
  assert.match(html, /Content-Security-Policy/);
});
