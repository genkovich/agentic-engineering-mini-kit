// Shared test plumbing: point every suite at the fixture tree, and start the app on a free port.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
export const fixtureHome = join(repoRoot, 'fixtures', 'claude-home');

// Tests must never inherit a caller's personal Claude directory.
process.env.CLAUDE_HOME = fixtureHome;
// The dashboard's own store (session labels) goes to a throwaway directory per test run.
export const storeHome = mkdtempSync(join(tmpdir(), 'agent-ops-store-'));
process.env.AGENT_OPS_HOME = storeHome;

export async function startServer() {
  const { app } = await import('../server.js');
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    get: (path) => fetch(base + path),
    json: async (path) => (await fetch(base + path)).json(),
    text: async (path) => (await fetch(base + path)).text(),
    post: (path, fields) => fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
      redirect: 'manual',
    }),
    close: () => new Promise((r) => server.close(r)),
  };
}
