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
import { renderOverview } from './views/overview.js';
import { buildOverview, PERIOD_CHOICES_OVERVIEW } from './lib/analytics.js';
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
// falls back to the default window and says so, instead of failing the request. The choices
// differ per page (the overview offers a year on top of the dashboard's three), so they are a
// parameter; the fallback and the wording are not.
function parseDaysFrom(raw, choices, fallback = DEFAULT_DAYS) {
  if (raw === undefined) return { days: fallback, invalidDaysNote: null };
  const n = Number(raw);
  if (!choices.includes(n)) {
    return {
      days: fallback,
      invalidDaysNote: `Invalid ?days=${raw}, showing ${fallback} days instead.`,
    };
  }
  return { days: n, invalidDaysNote: null };
}

function parseDays(raw) {
  return parseDaysFrom(raw, PERIOD_CHOICES);
}

// The three orderings the session list offers. Anything else is a typo, so the list falls back
// to the newest-first order the page has always had, and says why.
const SORT_CHOICES = ['time', 'tokens', 'cost'];
const DEFAULT_SORT = 'time';

function parseSort(raw) {
  if (raw === undefined) return { sort: DEFAULT_SORT, invalidSortNote: null };
  if (SORT_CHOICES.includes(raw)) return { sort: raw, invalidSortNote: null };
  return { sort: DEFAULT_SORT, invalidSortNote: `Invalid ?sort=${raw}, sorting by time instead.` };
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
  const { sort, invalidSortNote } = parseSort(req.query.sort);
  const labels = readLabels();
  const result = listSessions({ limit, q, project, days, sort, labels });
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
      sort,
      asOf: PRICING.asOf,
      projects: result.projects,
      colors: result.colors,
      totalSessions: result.totalSessions,
      dashboard: result.dashboard,
      invalidLimitNote,
      invalidDaysNote,
      invalidSortNote,
      truncated: result.truncated,
      totalFound: result.totalFound,
      unreadableCount: result.unreadableCount,
      home: claudeHome(),
    })}`,
  }));
});

const CHART_SCRIPT = '<script src="/dashboard.js" defer></script>';

// The period overview. It reuses the index's scan (the sessions come out of listSessions with
// their stats already read and memoised) and hands them to lib/analytics.js, which knows nothing
// about where they came from. `limit: 0` would hide the list, so the scan is asked for every
// session and only the aggregates are used.
app.get('/overview', (req, res) => {
  const { days, invalidDaysNote } = parseDaysFrom(req.query.days, PERIOD_CHOICES_OVERVIEW);
  const project = parseText(req.query.project, 300);
  const result = listSessions({ limit: MAX_LIMIT, project, days, labels: readLabels() });
  const overview = buildOverview(result.sessions, result.projects, { days });
  const state = { days, project, projectName: result.projects.find((p) => p.projectDirName === project)?.name ?? project };
  res.type('html').send(layout({
    title: 'agent-ops',
    current: '/overview',
    source: claude.label,
    home: claudeHome(),
    head: CHART_SCRIPT,
    body: renderOverview({
      overview,
      state,
      colors: result.colors,
      asOf: PRICING.asOf,
      notes: renderNotes({ invalidDaysNote, unreadableCount: result.unreadableCount }),
    }),
  }));
});

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
  const { sort, invalidSortNote } = parseSort(req.query.sort);
  if (!PROJECT_DIR.test(dir)) {
    notFoundPage(res, 'Project not found', 'No project directory with that name is in the index.');
    return;
  }
  const result = listSessions({ limit, q, project: dir, days, sort, labels: readLabels() });
  const project = result.projects.find((p) => p.projectDirName === dir);
  if (!project) {
    notFoundPage(res, 'Project not found', 'No project directory with that name is in the index.');
    return;
  }
  const state = { base: `/projects/${dir}`, q, project: dir, limit, days, sort };
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
      asOf: PRICING.asOf,
      notes: renderNotes({ invalidLimitNote, invalidDaysNote, invalidSortNote, unreadableCount: result.unreadableCount }),
      meta: {
        projects: result.projects,
        colors: result.colors,
        totalSessions: result.totalSessions,
        totalFound: result.totalFound,
        truncated: result.truncated,
        asOf: PRICING.asOf,
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
