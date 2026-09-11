// Runs the app on the bundled fixtures, regardless of inherited shell settings.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const fixtureHome = join(repoRoot, 'fixtures', 'claude-home');

export function demoEnvironment(inherited = process.env) {
  // Names given in the demo land in a temp directory, not in the developer's ~/.agent-ops.
  return { ...inherited, CLAUDE_HOME: fixtureHome, AGENT_OPS_HOME: join(tmpdir(), 'agent-ops-demo'), PORT: '4180' };
}

export async function startDemo() {
  const env = demoEnvironment();
  process.env.CLAUDE_HOME = env.CLAUDE_HOME;
  process.env.PORT = env.PORT;
  process.env.AGENT_OPS_HOME = env.AGENT_OPS_HOME;
  // Set the environment before loading the adapter or application.
  const { app } = await import('../server.js');
  return app.listen(Number(env.PORT), '127.0.0.1', (error) => {
    if (error) {
      console.error(`Demo failed to listen on 127.0.0.1:${env.PORT}: ${error.code || error.message}`);
      process.exitCode = 1;
      return;
    }
    console.log(`agent-ops on http://127.0.0.1:${env.PORT}  (CLAUDE_HOME=${env.CLAUDE_HOME})`);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startDemo();
}
