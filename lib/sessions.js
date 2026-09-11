// The session index, source-agnostic. It knows the source contract (lib/sources.js) and nothing
// about any vendor: every raw record, head, project description, stats, timeline and extra comes
// from the adapter that produced it, so a second agent is a new lib/<vendor>/index.js and no edit
// here. Each session carries `source: {id, label}`, which is what the badge, the `?source=` filter
// and the JSON/CSV rows read.
//
// Rebuilt synchronously on every call (ADR-0001): no persisted state, only the per-adapter stats
// memo. Best-effort — an unreadable entry is skipped and counted, this never throws (spec §6 NFR).
import { allSources } from './sources.js';
import { EMPTY_TOKENS, addSplitTokens, intoModels } from './tokens.js';
import { estimateSessionCost } from './pricing.js';
import { sessionAnalytics } from './analytics.js';

// Newest mtime first; the session filename (sessionId) breaks ties so the order is stable
// across platforms and repeated runs, since mtime resolution alone can collide.
//
// `sort` picks the primary key: `time` (the default, unchanged), `tokens` (output tokens) or
// `cost` (the estimated spend). Both alternatives fall back to the time order for ties, so the
// list is still deterministic. The cost of a record is estimated once into a lookup rather than
// inside the comparator, which would re-price the same session on every comparison.
export function sortAndLimit(records, { limit, sort = 'time' }) {
  const byTime = (a, b) => b.mtimeMs - a.mtimeMs || a.sessionId.localeCompare(b.sessionId);
  let compare = byTime;
  if (sort === 'tokens') {
    compare = (a, b) => (b.stats?.tokens.output ?? 0) - (a.stats?.tokens.output ?? 0) || byTime(a, b);
  } else if (sort === 'cost') {
    const usd = new Map(records.map((r) => [r, estimateSessionCost(r.stats?.models ?? {}).usd]));
    compare = (a, b) => usd.get(b) - usd.get(a) || byTime(a, b);
  }
  const sorted = [...records].sort(compare);
  const totalFound = sorted.length;
  const truncated = totalFound > limit;
  return { sessions: sorted.slice(0, limit), totalFound, truncated };
}

// One raw record, read through the adapter that produced it. The vendor decides how a head is
// read and how a project is named; everything downstream sees the same shape either way.
function enrich(adapter, record) {
  const head = adapter.readHead(record.path);
  const project = adapter.describeProject(record, head);
  const stats = adapter.readStats(record.path, record.size, record.mtimeMs);
  return {
    ...record,
    source: { id: adapter.id, label: adapter.label },
    title: head.title,
    cwd: head.cwd,
    projectName: project.name,
    projectPath: project.path,
    projectDerived: project.derived,
    stats,
  };
}

// Attaches the dashboard's own fields to a session it just read, with the same empty defaults
// whether the session was ever edited or not: `label` stays null when there is no own name (so a
// page can tell "named" from "not named"), tags an empty array, the note an empty string.
function withEntry(session, entry = {}) {
  const label = entry.label ?? null;
  return {
    ...session,
    label,
    name: label ?? session.title,
    tags: entry.tags ?? [],
    note: entry.note ?? '',
    starred: Boolean(entry.starred),
    cost: estimateSessionCost(session.stats.models),
  };
}

function matchesQuery(session, q) {
  const needle = q.toLowerCase();
  return session.sessionId.toLowerCase().includes(needle)
    || (session.name !== null && session.name.toLowerCase().includes(needle))
    || (session.title !== null && session.title.toLowerCase().includes(needle))
    || session.projectName.toLowerCase().includes(needle);
}

// Every project seen in the scan, newest activity first, with its own totals.
function collectProjects(sessions) {
  const byDir = new Map();
  for (const session of sessions) {
    let p = byDir.get(session.projectDirName);
    if (!p) {
      p = { projectDirName: session.projectDirName, name: session.projectName, path: session.projectPath, derived: session.projectDerived,
        count: 0, totalSize: 0, latestMtimeMs: session.mtimeMs, turns: 0, tokens: EMPTY_TOKENS() };
      byDir.set(session.projectDirName, p);
    }
    p.count++;
    p.totalSize += session.size;
    p.turns += session.stats.turns;
    addSplitTokens(p.tokens, session.stats.tokens);
    if (session.mtimeMs > p.latestMtimeMs) {
      p.latestMtimeMs = session.mtimeMs;
      p.name = session.projectName; p.path = session.projectPath; p.derived = session.projectDerived;
    }
  }
  return [...byDir.values()].sort((a, b) => b.latestMtimeMs - a.latestMtimeMs || a.projectDirName.localeCompare(b.projectDirName));
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const PERIOD_CHOICES = [7, 30, 90];
const DEFAULT_DAYS = 30;
const COLOR_SLOTS = 6;

function dayKey(ms) { return new Date(ms).toISOString().slice(0, 10); }

// Six colors, six slots: the projects with the most sessions get a color each, in rank order,
// so two busy projects can never share one; everything else is drawn neutral. Rank is by
// session count over all time (ties by name), which moves far slower than a 30-day window.
export function assignColors(projects) {
  const ranked = [...projects].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name) || a.projectDirName.localeCompare(b.projectDirName));
  const colors = {};
  ranked.forEach((p, i) => { colors[p.projectDirName] = i < COLOR_SLOTS ? i : null; });
  return colors;
}

// The dashboard aggregates over the sessions it is given (all of them, or one project's).
// `now` is injectable so the window is testable; when nothing happened inside the window it
// slides back to end on the latest activity, so a quiet home still shows its history.
export function buildDashboard(sessions, projects, now = Date.now(), days = DEFAULT_DAYS) {
  const span = PERIOD_CHOICES.includes(days) ? days : DEFAULT_DAYS;
  const lastActivity = sessions.reduce((max, s) => Math.max(max, s.stats.lastTs ?? s.mtimeMs), 0);
  let windowEnd = now;
  const slid = lastActivity > 0 && now - lastActivity > span * DAY_MS;
  if (slid) windowEnd = lastActivity;
  const buckets = [];
  const dayIndex = new Map();
  for (let i = span - 1; i >= 0; i--) {
    const key = dayKey(windowEnd - i * DAY_MS);
    dayIndex.set(key, buckets.length);
    buckets.push({ day: key, turns: 0, tokens: EMPTY_TOKENS(), sessions: 0, byProject: {} });
  }
  const period = { sessions: 0, turns: 0, tokens: EMPTY_TOKENS(), activeDays: 0 };
  const models = {};
  const total = { sessions: sessions.length, turns: 0, tokens: EMPTY_TOKENS() };
  // Two `stats.models`-shaped accumulators, so the whole period is priced with one estimate
  // each instead of once per session (ADR-0007: both sums are estimates and say so on the page).
  const periodModels = {};
  const totalModels = {};
  for (const s of sessions) {
    total.turns += s.stats.turns;
    addSplitTokens(total.tokens, s.stats.tokens);
    let inWindow = false;
    for (const [day, d] of Object.entries(s.stats.days)) {
      const idx = dayIndex.get(day);
      if (idx === undefined) continue;
      inWindow = true;
      const bucket = buckets[idx];
      bucket.turns += d.turns;
      addSplitTokens(bucket.tokens, d.tokens);
      if (!bucket.byProject[s.projectDirName]) bucket.byProject[s.projectDirName] = { sessions: 0, turns: 0, output: 0 };
      const share = bucket.byProject[s.projectDirName];
      share.sessions++;
      share.turns += d.turns;
      share.output += d.tokens.output;
      bucket.sessions++;
      period.turns += d.turns;
      addSplitTokens(period.tokens, d.tokens);
      for (const [model, entry] of Object.entries(d.byModel ?? {})) intoModels(periodModels, model, entry);
    }
    if (inWindow) period.sessions++;
    for (const [model, m] of Object.entries(s.stats.models)) {
      if (!models[model]) models[model] = { model, turns: 0, tokens: EMPTY_TOKENS(), sessions: 0 };
      models[model].turns += m.turns;
      models[model].sessions++;
      addSplitTokens(models[model].tokens, m.tokens);
      intoModels(totalModels, model, m);
    }
  }
  period.activeDays = buckets.filter((d) => d.turns > 0).length;
  const priceOf = (map) => { const c = estimateSessionCost(map); return { usd: c.usd, priced: c.priced }; };
  period.cost = priceOf(periodModels);
  total.cost = priceOf(totalModels);
  return {
    span,
    windowStart: buckets[0].day,
    windowEnd: buckets[buckets.length - 1].day,
    windowSlid: slid,
    days: buckets,
    period,
    total,
    models: Object.values(models).sort((a, b) => b.tokens.output - a.tokens.output || a.model.localeCompare(b.model)),
    projects,
  };
}

// Groups an already sorted list by project, keeping the order of first appearance, so the
// group whose newest session is most recent comes first.
export function groupByProject(sessions) {
  const groups = new Map();
  for (const session of sessions) {
    let group = groups.get(session.projectDirName);
    if (!group) {
      group = {
        projectDirName: session.projectDirName,
        name: session.projectName,
        path: session.projectPath,
        derived: session.projectDerived,
        sessions: [],
        totalSize: 0,
        latestMtimeMs: session.mtimeMs,
      };
      groups.set(session.projectDirName, group);
    }
    group.sessions.push(session);
    group.totalSize += session.size;
    if (session.mtimeMs > group.latestMtimeMs) group.latestMtimeMs = session.mtimeMs;
  }
  return [...groups.values()];
}

// Rebuilds the index synchronously on every call (ADR-0001): no persisted state; the only
// in-memory memo is the per-journal stats keyed by size + mtime. Best-effort — an unreadable
// entry is skipped and counted, this never throws (spec §6 NFR). Every scanned session is
// enriched (head + stats) because the dashboard aggregates over all of them; `project` narrows
// the list to one project directory and `q` matches title, project name or session id.
// `entries` maps sessionId → the dashboard's own workspace entry (lib/store.js): `{ label, tags,
// note, starred }`, all optional. The label wins over the journal title as `name`, and `label`
// keeps the raw value so the page can say which one it shows; the other three are attached with
// their empty defaults so every session has the same shape whether or not it was ever edited.
// `tag` and `starred` narrow the list the same way `q` does — after the project scope, never
// before it, so `scoped` and the aggregates built from it still describe the whole project.
export function listSessions({ limit = 50, project = '', q = '', days = DEFAULT_DAYS, sort = 'time', now = Date.now(), entries = {}, tag = '', starred = false, source = '' } = {}) {
  const stats = { unreadableCount: 0 };
  const all = [];
  const sourceCounts = [];
  for (const adapter of allSources()) {
    const raw = adapter.scan(stats);
    // ADR-0006: the stats memo is bounded by what the scan can still see, so a deleted or renamed
    // journal stops holding memory. Pruning before enrich also keeps the memo from being measured
    // mid-refill. Keys are `path \0 size \0 mtime`; only the path decides.
    adapter.pruneStatsMemo?.(raw.map((r) => r.path));
    for (const record of raw) all.push(withEntry(enrich(adapter, record), entries[record.sessionId]));
    sourceCounts.push({ id: adapter.id, label: adapter.label, count: raw.length });
  }
  const projects = collectProjects(all);
  const colors = assignColors(projects);
  // The source filter comes first: it is a scope, like `project`, so the aggregates below
  // describe the sources the page is actually showing.
  const inSource = source ? all.filter((r) => r.source.id === source) : all;
  const scoped = project ? inSource.filter((r) => r.projectDirName === project) : inSource;
  const dashboard = buildDashboard(scoped, projects, now, days);
  let candidates = scoped;
  const query = q.trim();
  if (query) candidates = candidates.filter((s) => matchesQuery(s, query));
  const wanted = typeof tag === 'string' ? tag.trim().toLowerCase() : '';
  if (wanted) candidates = candidates.filter((s) => s.tags.some((t) => t.toLowerCase() === wanted));
  if (starred) candidates = candidates.filter((s) => s.starred);
  const { sessions, totalFound, truncated } = sortAndLimit(candidates, { limit, sort });
  // `sessions` is what the list shows: filtered by `q` and cut to `limit`. `scoped` is what the
  // aggregates are built from: narrowed to `project` and nothing else, so an aggregate can never
  // silently describe only the newest `limit` journals. `buildDashboard` already uses it, and
  // any other page-wide aggregation (the overview, and Task 7's API and CSV) must use it too.
  // `sources` counts every session a source contributed, before any filter — it labels the
  // badge and the Source switch, which must keep saying what is there while a filter is on.
  return { sessions, scoped, totalFound, truncated, unreadableCount: stats.unreadableCount, projects, colors, totalSessions: all.length, dashboard, sources: sourceCounts };
}

const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/;

// One session on its own. The scan is the same cheap metadata walk the index does, but only the
// matching record is enriched, so the other journals are never opened. On top of what a
// `listSessions` session carries it adds the ordered `timeline`, the `extras` found in the
// session's own directory, and the derived `analytics`. An id that could not name a session file
// is rejected before any disk work, and an unknown id is null rather than an error.
export function getSession(sessionId, { entries = {} } = {}) {
  if (!SESSION_ID.test(sessionId)) return null;
  // Sources are searched in registration order and the first match wins. Ids are unique inside a
  // source and UUID-shaped, so a collision across two sources is an accepted documented risk.
  for (const adapter of allSources()) {
    const record = adapter.scan({ unreadableCount: 0 }).find((r) => r.sessionId === sessionId);
    if (!record) continue;
    const session = withEntry(enrich(adapter, record), entries[sessionId]);
    const timeline = adapter.readTimeline(record.path, record.size, record.mtimeMs);
    return {
      ...session,
      timeline,
      extras: adapter.readExtras(record),
      analytics: sessionAnalytics(session.stats, timeline),
    };
  }
  return null;
}
