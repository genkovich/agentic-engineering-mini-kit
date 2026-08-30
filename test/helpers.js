// Shared test plumbing: point every suite at the fixture tree, and start the app on a free port.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
export const fixtureHome = join(repoRoot, 'fixtures', 'claude-home');

process.env.CLAUDE_HOME ??= fixtureHome;

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
    close: () => new Promise((r) => server.close(r)),
  };
}
