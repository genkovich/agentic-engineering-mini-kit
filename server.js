import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeHome, listSessions } from './lib/claude/index.js';
import { listSources } from './lib/sources.js';
import { layout, empty, esc } from './views/layout.js';

const here = dirname(fileURLToPath(import.meta.url));
export const app = express();

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;

// A query param the developer typed by hand is expected to sometimes be wrong; falling back to
// the default (with an explanation) keeps the page usable instead of failing the whole request.
function parseLimit(rawLimit) {
  if (rawLimit === undefined) return { limit: DEFAULT_LIMIT, invalidLimitNote: null };
  const n = Number(rawLimit);
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIMIT) {
    return {
      limit: DEFAULT_LIMIT,
      invalidLimitNote: `Invalid ?limit=${rawLimit}, showing the default ${DEFAULT_LIMIT} instead.`,
    };
  }
  return { limit: n, invalidLimitNote: null };
}

app.use(express.static(join(here, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, sources: listSources(), claudeHome: claudeHome() });
});

app.get('/', (req, res) => {
  const { limit, invalidLimitNote } = parseLimit(req.query.limit);
  const result = listSessions({ limit });
  res.type('html').send(layout({
    title: 'agent-ops',
    body: `<h1>agent-ops</h1>
<p class="sub">Reading ${claudeHome()}</p>
${invalidLimitNote ? `<p class="note">${esc(invalidLimitNote)}</p>` : ''}
${empty(`Sessions found: ${result.sessions.length} (of ${result.totalFound})`)}`,
  }));
});

const PORT = Number(process.env.PORT || 4180);
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`agent-ops on http://127.0.0.1:${PORT}  (CLAUDE_HOME=${claudeHome()})`);
  });
}
