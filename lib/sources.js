// Registry of telemetry sources. One adapter per agent vendor.
//
// The dashboard never imports an adapter directly — it asks the registry. That is what keeps a
// second adapter (Codex, Cursor) a matter of writing lib/<vendor>/index.js and calling
// registerSource() from it, with nothing in lib/sessions.js, server.js or the views to change.
//
// The contract. Every member is required, and every one but `id` and `label` is a function:
//
//   id                              string, unique, used as `?source=` and as `session.source.id`
//   label                           string, what the badge and the filter show
//   home()                          → string, the directory this source reads
//   scan(stats)                     → raw records [{ sessionId, projectDirName, size, mtimeMs, path }].
//                                     The adapter decides how to walk its home; it increments
//                                     `stats.unreadableCount` for every entry it had to skip.
//   readHead(path)                  → { title, cwd }, both nullable
//   describeProject(record, head)   → { name, path, derived } — how this vendor names the project
//                                     a session belongs to (Claude decodes the directory name,
//                                     another agent may only have `head.cwd`)
//   readStats(path, size, mtimeMs)  → { turns, prompts, tokens, models, days, tools, compacts,
//                                       firstTs, lastTs }
//   readTimeline(path, size, mtimeMs) → { events, total, capped }
//   readExtras(record)              → { subagents, toolResults }
//
// Optional member: `pruneStatsMemo(livePaths)`, called by the orchestrator after each scan so an
// adapter that memoises its stats can drop what the scan can no longer see (ADR-0006).
//
// `projectDirName` is the cross-source project key. Every aggregate is grouped by it —
// collectProjects, assignColors, the dashboard's per-day byProject shares, groupByProject — and
// `/projects/:dir` addresses a project by it, so two sessions with the same working directory
// merge into one project row whichever agent produced them. Two rules follow:
//   * it must match ^[A-Za-z0-9._-]{1,300}$, because the route validates the URL segment with
//     exactly that pattern before matching it against what the scan found;
//   * an adapter with no native project directory of its own must derive it from the session's
//     working directory with projectDirNameFor(cwd) below, which is the encoding Claude Code
//     already writes on disk. Deriving it any other way would split one project in two.
//
// Session ids are unique within a source and UUID-shaped, so store keys and `/sessions/:id` stay
// plain ids; the route resolves across sources in registration order and takes the first match.
// A collision between two sources is an accepted, documented risk (roadmap step 5).

const REQUIRED_TEXT = ['id', 'label'];
const REQUIRED_FUNCTIONS = ['home', 'scan', 'readHead', 'describeProject', 'readStats', 'readTimeline', 'readExtras'];

const sources = new Map();

export function registerSource(adapter) {
  for (const field of REQUIRED_TEXT) {
    if (typeof adapter?.[field] !== 'string' || !adapter[field]) throw new Error(`source adapter is missing "${field}"`);
  }
  for (const field of REQUIRED_FUNCTIONS) {
    if (typeof adapter?.[field] !== 'function') throw new Error(`source adapter is missing "${field}"`);
  }
  sources.set(adapter.id, adapter);
  return adapter;
}

export function getSource(id) {
  const adapter = sources.get(id);
  if (!adapter) throw new Error(`unknown source "${id}"`);
  return adapter;
}

// The adapters themselves, in registration order. `lib/sessions.js` iterates this; a page that
// only needs the names asks listSources() instead.
export function allSources() {
  return [...sources.values()];
}

export function listSources() {
  return [...sources.values()].map(({ id, label }) => ({ id, label }));
}

// The project key for a source that has no project directory of its own: the working directory
// with every separator turned into `-`, which is the encoding Claude Code uses for its own
// project directory names. Anything outside the key's charset becomes `-` too, so a drive letter
// or a space can never produce a name the `/projects/:dir` route would refuse. A session with no
// working directory at all gets one shared bucket rather than a name that cannot be routed.
const PROJECT_KEY_MAX = 300;

export function projectDirNameFor(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) return 'unknown-project';
  return cwd.trim().replace(/[^A-Za-z0-9._-]/g, '-').slice(0, PROJECT_KEY_MAX);
}
