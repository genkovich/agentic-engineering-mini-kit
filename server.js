import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claude, claudeHome, listSessions, getSession, PERIOD_CHOICES } from './lib/claude/index.js';
import { listSources } from './lib/sources.js';
import { layout } from './views/layout.js';
import { renderSessionIndex, renderNotes } from './views/session-index.js';
import { renderRename } from './views/rename.js';
import { renderSession } from './views/session.js';
import { renderProject } from './views/project.js';
import { PRICING } from './lib/pricing.js';
import { readLabels, setLabel } from './lib/store.js';

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

const DEFAULT_DAYS = 30;

// Same contract as parseLimit: a hand-typed ?days= that is not one of the offered periods
// falls back to the default window and says so, instead of failing the request.
function parseDays(raw) {
  if (raw === undefined) return { days: DEFAULT_DAYS, invalidDaysNote: null };
  const n = Number(raw);
  if (!PERIOD_CHOICES.includes(n)) {
    return {
      days: DEFAULT_DAYS,
      invalidDaysNote: `Invalid ?days=${raw}, showing ${DEFAULT_DAYS} days instead.`,
    };
  }
  return { days: n, invalidDaysNote: null };
}

app.use(express.static(join(here, 'public')));
app.use(express.urlencoded({ extended: false, limit: '4kb' }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, sources: listSources(), claudeHome: claudeHome() });
});

// Free-text filters typed by the developer: trimmed, capped, and only ever used for matching.
function parseText(raw, max) {
  return typeof raw === 'string' ? raw.trim().slice(0, max) : '';
}

app.get('/', (req, res) => {
  const { limit, invalidLimitNote } = parseLimit(req.query.limit);
  const q = parseText(req.query.q, 100);
  const project = parseText(req.query.project, 300);
  const { days, invalidDaysNote } = parseDays(req.query.days);
  const labels = readLabels();
  const result = listSessions({ limit, q, project, days, labels });
  res.type('html').send(layout({
    title: 'agent-ops',
    current: '/',
    source: claude.label,
    home: claudeHome(),
    head: '<script src="/dashboard.js" defer></script>',
    body: `<h1>Dashboard</h1>
${renderSessionIndex(result.sessions, {
      limit,
      q,
      project,
      days,
      projects: result.projects,
      colors: result.colors,
      totalSessions: result.totalSessions,
      dashboard: result.dashboard,
      invalidLimitNote,
      invalidDaysNote,
      truncated: result.truncated,
      totalFound: result.totalFound,
      unreadableCount: result.unreadableCount,
      home: claudeHome(),
    })}`,
  }));
});

const CHART_SCRIPT = '<script src="/dashboard.js" defer></script>';

// A page that says "not here" instead of a stack trace: same shell, same wording as the rename
// 404, so a mistyped URL never looks like a crash.
function notFoundPage(res, heading, sentence) {
  res.status(404).type('html').send(layout({
    title: 'agent-ops', current: '/', source: claude.label, home: claudeHome(),
    body: `<h1>${heading}</h1><p class="sub">${sentence} <a href="/">Back to the dashboard</a></p>`,
  }));
}

// One session. `getSession` validates the id itself and answers null for anything it cannot
// name, so the param never reaches the filesystem as a path fragment.
app.get('/sessions/:id', (req, res) => {
  const session = getSession(req.params.id, { labels: readLabels() });
  if (!session) {
    notFoundPage(res, 'Session not found', 'No session with that id is in the index.');
    return;
  }
  const { colors } = listSessions({ limit: 1 });
  const back = `/sessions/${session.sessionId}`;
  res.type('html').send(layout({
    title: 'agent-ops',
    current: '/',
    source: claude.label,
    home: claudeHome(),
    head: CHART_SCRIPT,
    body: renderSession({ session, colors, back, asOf: PRICING.asOf }),
  }));
});

// A project directory name as it sits on disk. It is matched against the names the scan already
// found rather than joined into a path, so no value from the URL ever addresses the filesystem.
const PROJECT_DIR = /^[A-Za-z0-9._-]{1,300}$/;

app.get('/projects/:dir', (req, res) => {
  const dir = req.params.dir;
  const { limit, invalidLimitNote } = parseLimit(req.query.limit);
  const q = parseText(req.query.q, 100);
  const { days, invalidDaysNote } = parseDays(req.query.days);
  if (!PROJECT_DIR.test(dir)) {
    notFoundPage(res, 'Project not found', 'No project directory with that name is in the index.');
    return;
  }
  const result = listSessions({ limit, q, project: dir, days, labels: readLabels() });
  const project = result.projects.find((p) => p.projectDirName === dir);
  if (!project) {
    notFoundPage(res, 'Project not found', 'No project directory with that name is in the index.');
    return;
  }
  const state = { base: `/projects/${dir}`, q, project: dir, limit, days };
  res.type('html').send(layout({
    title: 'agent-ops',
    current: '/',
    source: claude.label,
    home: claudeHome(),
    head: CHART_SCRIPT,
    body: renderProject({
      project,
      dash: result.dashboard,
      sessions: result.sessions,
      state,
      colors: result.colors,
      notes: renderNotes({ invalidLimitNote, invalidDaysNote, unreadableCount: result.unreadableCount }),
      meta: {
        projects: result.projects,
        colors: result.colors,
        totalSessions: result.totalSessions,
        totalFound: result.totalFound,
        truncated: result.truncated,
      },
    }),
  }));
});

// Only a same-origin path is accepted as the place to return to, so the redirect can never
// leave the dashboard.
function safeBack(raw) {
  return typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
}

app.get('/sessions/:id/rename', (req, res) => {
  const session = getSession(req.params.id, { labels: readLabels() });
  if (!session) {
    notFoundPage(res, 'Session not found', 'No session with that id is in the index.');
    return;
  }
  const back = safeBack(req.query.back);
  res.type('html').send(layout({
    title: 'agent-ops',
    current: '/',
    source: claude.label,
    home: claudeHome(),
    body: renderRename({ session, label: readLabels()[session.sessionId] ?? null, back }),
  }));
});

app.post('/sessions/:id/rename', (req, res) => {
  const session = getSession(req.params.id, { labels: readLabels() });
  if (!session) { res.status(404).type('text').send('Session not found'); return; }
  const body = req.body ?? {};
  setLabel(session.sessionId, body.clear ? '' : body.label);
  res.redirect(303, safeBack(body.back));
});

const PORT = Number(process.env.PORT || 4180);
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`agent-ops on http://127.0.0.1:${PORT}  (CLAUDE_HOME=${claudeHome()})`);
  });
}
