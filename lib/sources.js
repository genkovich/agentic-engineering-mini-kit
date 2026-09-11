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
