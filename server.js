import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Importing an adapter is what registers it: registerSource() runs on import, and
// lib/sessions.js only ever sees what the registry holds. Keep these imports even when nothing
// but claudeHome() is used from them, or the dashboard would come up with no sources at all.
// Import order is registration order, which is the order the badge and the Source switch list.
import { claudeHome } from './lib/claude/index.js';
import './lib/codex/index.js';
import { listSessions, getSession, PERIOD_CHOICES } from './lib/sessions.js';
import { allSources } from './lib/sources.js';
import { layout } from './views/layout.js';
import { renderSessionIndex, renderNotes } from './views/session-index.js';
import { renderEditSession } from './views/edit-session.js';
import { renderSession } from './views/session.js';
import { renderProject } from './views/project.js';
import { renderOverview } from './views/overview.js';
import { buildOverview, PERIOD_CHOICES_OVERVIEW } from './lib/analytics.js';
import { PRICING } from './lib/pricing.js';
import { readStore, updateSession } from './lib/store.js';
import { registerApiRoutes } from './lib/api-routes.js';
import { parseLimit, parseDaysFrom, parseSort, parseText, parseTag, parseFlag, parseSource, MAX_LIMIT } from './lib/query.js';

const here = dirname(fileURLToPath(import.meta.url));
export const app = express();

app.use(express.static(join(here, 'public')));
app.use(express.urlencoded({ extended: false, limit: '4kb' }));

// Every registered source with the directory it reads. `claudeHome` stays alongside them: it is
// what the endpoint answered before there was more than one source, and a script may read it.
app.get('/api/health', (req, res) => {
  res.json({ ok: true, sources: sourceHomes(), claudeHome: claudeHome() });
});

function sourceHomes() {
  return allSources().map((a) => ({ id: a.id, label: a.label, home: a.home() }));
}

const sourceIds = () => allSources().map((a) => a.id);

// The shell's source list: every registered source with its home, and the per-source session
// counts when the page has already built an index (a 404 page has none, and says nothing).
function pageShell(counts = []) {
  const byId = new Map(counts.map((c) => [c.id, c.count]));
  return sourceHomes().map((s) => ({ ...s, count: byId.get(s.id) }));
}

// The JSON endpoints and the CSV download register themselves; they read the same index the
// pages do, through the same lib/query.js parsers (lib/api-routes.js).
registerApiRoutes(app);

const parseDays = (raw) => parseDaysFrom(raw, PERIOD_CHOICES);

app.get('/', (req, res) => {
  const { limit, invalidLimitNote } = parseLimit(req.query.limit);
  const q = parseText(req.query.q, 100);
  const project = parseText(req.query.project, 300);
  const { days, invalidDaysNote } = parseDays(req.query.days);
  const { sort, invalidSortNote } = parseSort(req.query.sort);
  const tag = parseTag(req.query.tag);
  const starred = parseFlag(req.query.starred);
  const { source, invalidSourceNote } = parseSource(req.query.source, sourceIds());
  const result = listSessions({ limit, q, project, days, sort, entries: readStore(), tag, starred, source });
  res.type('html').send(layout({
    title: 'agent-ops',
    current: '/',
    sources: pageShell(result.sources),
    head: '<script src="/dashboard.js" defer></script>',
    body: `<h1>Dashboard</h1>
${renderSessionIndex(result.sessions, {
      limit,
      q,
      project,
      days,
      sort,
      tag,
      starred,
      source,
      sources: result.sources,
      invalidSourceNote,
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
      home: sourceHomes().map((h) => h.home).join(', '),
    })}`,
  }));
});

const CHART_SCRIPT = '<script src="/dashboard.js" defer></script>';

// The period overview. It reuses the index's scan (the sessions come out of listSessions with
// their stats already read and memoised) and hands them to lib/analytics.js, which knows nothing
// about where they came from. It aggregates over `result.scoped`, every session in the project
// scope, never over `result.sessions`, which is cut to the list's `limit` — a page of sums must
// describe all of them or say it does not.
app.get('/overview', (req, res) => {
  const { days, invalidDaysNote } = parseDaysFrom(req.query.days, PERIOD_CHOICES_OVERVIEW);
  const project = parseText(req.query.project, 300);
  const { source, invalidSourceNote } = parseSource(req.query.source, sourceIds());
  const result = listSessions({ limit: 1, project, days, entries: readStore(), source });
  const overview = buildOverview(result.scoped, result.projects, { days });
  const state = { days, project, projectName: result.projects.find((p) => p.projectDirName === project)?.name ?? project };
  res.type('html').send(layout({
    title: 'agent-ops',
    current: '/overview',
    sources: pageShell(result.sources),
    head: CHART_SCRIPT,
    body: renderOverview({
      overview,
      state,
      colors: result.colors,
      asOf: PRICING.asOf,
      notes: renderNotes({ invalidDaysNote, invalidSourceNote, unreadableCount: result.unreadableCount }),
    }),
  }));
});

// A page that says "not here" instead of a stack trace: same shell, same wording as the rename
// 404, so a mistyped URL never looks like a crash.
function notFoundPage(res, heading, sentence) {
  res.status(404).type('html').send(layout({
    title: 'agent-ops', current: '/', sources: pageShell(),
    body: `<h1>${heading}</h1><p class="sub">${sentence} <a href="/">Back to the dashboard</a></p>`,
  }));
}

// One session. `getSession` validates the id itself and answers null for anything it cannot
// name, so the param never reaches the filesystem as a path fragment.
app.get('/sessions/:id', (req, res) => {
  const session = getSession(req.params.id, { entries: readStore() });
  if (!session) {
    notFoundPage(res, 'Session not found', 'No session with that id is in the index.');
    return;
  }
  const { colors } = listSessions({ limit: 1 });
  const back = `/sessions/${session.sessionId}`;
  res.type('html').send(layout({
    title: 'agent-ops',
    current: '/',
    sources: pageShell(),
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
  const tag = parseTag(req.query.tag);
  const starred = parseFlag(req.query.starred);
  const { source, invalidSourceNote } = parseSource(req.query.source, sourceIds());
  const result = listSessions({ limit, q, project: dir, days, sort, entries: readStore(), tag, starred, source });
  // `result.projects` is collected over every source, before the `source` scope, so a project
  // whose sessions all live in the other source still resolves: the page renders its own row
  // with an empty scoped list, which is a filter showing nothing, not a missing project.
  const project = result.projects.find((p) => p.projectDirName === dir);
  if (!project) {
    notFoundPage(res, 'Project not found', 'No project directory with that name is in the index.');
    return;
  }
  const state = { base: `/projects/${dir}`, q, project: dir, limit, days, sort, tag, starred, source };
  res.type('html').send(layout({
    title: 'agent-ops',
    current: '/',
    sources: pageShell(result.sources),
    head: CHART_SCRIPT,
    body: renderProject({
      project,
      dash: result.dashboard,
      sessions: result.sessions,
      state,
      colors: result.colors,
      asOf: PRICING.asOf,
      notes: renderNotes({ invalidLimitNote, invalidDaysNote, invalidSortNote, invalidSourceNote, unreadableCount: result.unreadableCount }),
      meta: {
        projects: result.projects,
        sources: result.sources,
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

// The dashboard's own fields for one session. `/edit` is the page; `/rename` is what step 1
// shipped and stays a working alias, so a bookmark or a script written against it keeps working.
function editPage(req, res) {
  const store = readStore();
  const session = getSession(req.params.id, { entries: store });
  if (!session) {
    notFoundPage(res, 'Session not found', 'No session with that id is in the index.');
    return;
  }
  res.type('html').send(layout({
    title: 'agent-ops',
    current: '/',
    sources: pageShell(),
    body: renderEditSession({ session, entry: store[session.sessionId] ?? {}, back: safeBack(req.query.back) }),
  }));
}

// A form that carries the hidden `form=edit` marker is authoritative about all four fields, so
// an empty box means "clear this one" and an absent checkbox means "not starred". A POST without
// the marker (the `/rename` alias) patches only the fields it actually sent, which is what keeps
// a rename from silently wiping tags it never knew about.
function applyEdit(sessionId, body) {
  if (body.clear) {
    updateSession(sessionId, { label: '', tags: [], note: '', starred: false });
    return;
  }
  const full = body.form === 'edit';
  const patch = {};
  if (full || Object.hasOwn(body, 'label')) patch.label = body.label ?? '';
  if (full || Object.hasOwn(body, 'tags')) patch.tags = body.tags ?? '';
  if (full || Object.hasOwn(body, 'note')) patch.note = body.note ?? '';
  if (full || Object.hasOwn(body, 'starred')) patch.starred = Boolean(body.starred);
  updateSession(sessionId, patch);
}

function editSubmit(req, res) {
  const session = getSession(req.params.id, { entries: readStore() });
  if (!session) { res.status(404).type('text').send('Session not found'); return; }
  const body = req.body ?? {};
  applyEdit(session.sessionId, body);
  res.redirect(303, safeBack(body.back));
}

app.get('/sessions/:id/edit', editPage);
app.post('/sessions/:id/edit', editSubmit);

// The alias. The GET moves to the new address so the URL in the bar matches the page; the POST
// stays in place, because a redirect would drop the form body.
app.get('/sessions/:id/rename', (req, res) => {
  const query = new URLSearchParams(req.query).toString();
  res.redirect(302, `/sessions/${encodeURIComponent(req.params.id)}/edit${query ? `?${query}` : ''}`);
});
app.post('/sessions/:id/rename', editSubmit);

const PORT = Number(process.env.PORT || 4180);
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(PORT, '127.0.0.1', () => {
    // Name every home it will read, so a misconfigured run is visible in the first line of output.
    const homes = sourceHomes().map((s) => `${s.label}=${s.home}`).join(', ');
    console.log(`agent-ops on http://127.0.0.1:${PORT}  (${homes})`);
  });
}
