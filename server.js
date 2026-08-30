import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeHome } from './lib/claude/index.js';
import { listSources } from './lib/sources.js';
import { layout, empty } from './views/layout.js';

const here = dirname(fileURLToPath(import.meta.url));
export const app = express();

app.use(express.static(join(here, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, sources: listSources(), claudeHome: claudeHome() });
});

app.get('/', (req, res) => {
  res.type('html').send(layout({
    title: 'agent-ops',
    body: `<h1>agent-ops</h1>
<p class="sub">Reading ${claudeHome()}</p>
${empty('No slice is wired up yet.')}`,
  }));
});

const PORT = Number(process.env.PORT || 4180);
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`agent-ops on http://127.0.0.1:${PORT}  (CLAUDE_HOME=${claudeHome()})`);
  });
}
