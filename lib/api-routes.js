// The machine-readable half of the dashboard: three JSON endpoints and one CSV download,
// registered on the app by `server.js`. They live here rather than in `server.js` because they
// are the same numbers the pages already show, expressed twice would be a bug waiting to happen:
// each one goes through the same `listSessions` / `buildOverview` call the page does.
//
// Two rules hold everywhere in this file. Every response body is built from explicitly named
// fields (`toApiSession`, the column lists below) — a session record is never spread into a
// response, so no journal field can reach a client by accident (AGENTS.md §Межі). And every
// response is `Cache-Control: no-store`: the index is rebuilt per request and a stale copy in a
// proxy would be a lie about what is on disk.
import { listSessions, getSession, PERIOD_CHOICES } from './claude/index.js';
import { buildOverview, PERIOD_CHOICES_OVERVIEW } from './analytics.js';
import { readStore } from './store.js';
import { toApiSession } from './api.js';
import { toCsv } from './csv.js';
import { PRICING } from './pricing.js';
import { parseLimit, parseDaysFrom, parseSort, parseText, parseTag, parseFlag } from './query.js';

function noStore(res) {
  res.set('Cache-Control', 'no-store');
  return res;
}

// The project rows the API returns: the same explicit-pick rule as a session.
function toApiProject(p) {
  return {
    projectDirName: p.projectDirName,
    name: p.name,
    path: p.path,
    derived: p.derived,
    count: p.count,
    turns: p.turns,
    tokens: {
      input: p.tokens.input,
      output: p.tokens.output,
      cacheRead: p.tokens.cacheRead,
      cacheWrite: p.tokens.cacheWrite,
    },
  };
}

/* ---- CSV tables --------------------------------------------------------------------------- */

// The allow-list. A `?table=` outside it is a 400, never a guess: the key decides both the
// columns and the rows, so an unknown key has no meaning to fall back to.
const TABLES = {
  projects: {
    columns: [
      { key: 'project', header: 'project' },
      { key: 'path', header: 'path' },
      { key: 'sessions', header: 'sessions' },
      { key: 'turns', header: 'turns' },
      { key: 'outputTokens', header: 'output_tokens' },
      { key: 'cost', header: 'est_cost_usd' },
    ],
    rows: (overview) => overview.projects.map((p) => ({
      project: p.name,
      path: p.path,
      sessions: p.sessions,
      turns: p.turns,
      outputTokens: p.tokens.output,
      cost: p.cost.usd,
    })),
  },
  models: {
    columns: [
      { key: 'model', header: 'model' },
      { key: 'turns', header: 'turns' },
      { key: 'sessions', header: 'sessions' },
      { key: 'outputTokens', header: 'output_tokens' },
      { key: 'inputTokens', header: 'input_tokens' },
      { key: 'cost', header: 'est_cost_usd' },
      { key: 'priced', header: 'priced' },
    ],
    rows: (overview) => overview.models.map((m) => ({
      model: m.model,
      turns: m.turns,
      sessions: m.sessions,
      outputTokens: m.tokens.output,
      inputTokens: m.tokens.input,
      cost: m.priced ? m.cost.usd : null,
      priced: m.priced,
    })),
  },
  tools: {
    columns: [
      { key: 'tool', header: 'tool' },
      { key: 'calls', header: 'calls' },
      { key: 'errors', header: 'errors' },
      { key: 'errorRate', header: 'error_rate' },
      { key: 'sessions', header: 'sessions' },
    ],
    rows: (overview) => overview.tools.map((t) => ({
      tool: t.name,
      calls: t.calls,
      errors: t.errors,
      errorRate: t.errorRate,
      sessions: t.sessions,
    })),
  },
  sessions: {
    columns: [
      { key: 'sessionId', header: 'session_id' },
      { key: 'name', header: 'name' },
      { key: 'project', header: 'project' },
      { key: 'turns', header: 'turns' },
      { key: 'outputTokens', header: 'output_tokens' },
      { key: 'cost', header: 'est_cost_usd' },
      { key: 'durationMs', header: 'duration_ms' },
    ],
    // The sessions that were actually active in the window, not every session in the scope:
    // the same set the totals above the table are built from.
    rows: (overview, scoped) => scoped
      .filter((s) => Object.keys(s.stats.days).some((day) => day >= overview.window.start && day <= overview.window.end))
      .map((s) => ({
        sessionId: s.sessionId,
        name: s.name ?? '',
        project: s.projectName,
        turns: s.stats.turns,
        outputTokens: s.stats.tokens.output,
        cost: s.cost.priced || s.cost.usd > 0 ? s.cost.usd : null,
        durationMs: s.stats.firstTs !== null && s.stats.lastTs !== null ? s.stats.lastTs - s.stats.firstTs : null,
      }))
      .sort((a, b) => b.outputTokens - a.outputTokens || a.sessionId.localeCompare(b.sessionId)),
  },
};

export function registerApiRoutes(app) {
  app.get('/api/sessions', (req, res) => {
    const { limit } = parseLimit(req.query.limit);
    const { days } = parseDaysFrom(req.query.days, PERIOD_CHOICES);
    const { sort } = parseSort(req.query.sort);
    const result = listSessions({
      limit,
      q: parseText(req.query.q, 100),
      project: parseText(req.query.project, 300),
      days,
      sort,
      entries: readStore(),
      tag: parseTag(req.query.tag),
      starred: parseFlag(req.query.starred),
    });
    noStore(res).json({
      sessions: result.sessions.map(toApiSession),
      totalFound: result.totalFound,
      truncated: result.truncated,
      projects: result.projects.map(toApiProject),
      generatedAt: new Date().toISOString(),
    });
  });

  app.get('/api/sessions/:id', (req, res) => {
    const session = getSession(req.params.id, { entries: readStore() });
    if (!session) {
      noStore(res).status(404).json({ error: 'not found' });
      return;
    }
    noStore(res).json({
      ...toApiSession(session),
      timeline: {
        events: session.timeline.events,
        total: session.timeline.total,
        capped: session.timeline.capped,
      },
      analytics: session.analytics,
      extras: session.extras,
    });
  });

  app.get('/api/overview', (req, res) => {
    const { days } = parseDaysFrom(req.query.days, PERIOD_CHOICES_OVERVIEW);
    const project = parseText(req.query.project, 300);
    const result = listSessions({ limit: 1, project, days, entries: readStore() });
    noStore(res).json({ ...buildOverview(result.scoped, result.projects, { days }), asOf: PRICING.asOf });
  });

  app.get('/overview.csv', (req, res) => {
    const table = typeof req.query.table === 'string' ? req.query.table : 'projects';
    const spec = Object.hasOwn(TABLES, table) ? TABLES[table] : null;
    if (!spec) {
      res.status(400).type('text').send(`Unknown ?table=${table}. Choose one of ${Object.keys(TABLES).join(', ')}.`);
      return;
    }
    const { days } = parseDaysFrom(req.query.days, PERIOD_CHOICES_OVERVIEW);
    const project = parseText(req.query.project, 300);
    const result = listSessions({ limit: 1, project, days, entries: readStore() });
    const overview = buildOverview(result.scoped, result.projects, { days });
    noStore(res)
      .type('text/csv; charset=utf-8')
      .set('Content-Disposition', `attachment; filename="overview-${table}-${days}d.csv"`)
      .send(toCsv(spec.columns, spec.rows(overview, result.scoped)));
  });
}
