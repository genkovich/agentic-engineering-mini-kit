// Claude Code adapter. Reads ~/.claude, or whatever CLAUDE_HOME points at.
import { homedir } from 'node:os';
import { join, dirname, sep, basename } from 'node:path';
import { readdirSync, lstatSync, realpathSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { registerSource } from '../sources.js';
import {
  EMPTY_TOKENS,
  addTokens,
  addSplitTokens,
  readSessionStats,
  readSessionTimeline,
  readSessionExtras,
  sessionAnalytics,
  pruneStatsMemo,
} from './journal.js';
import { estimateSessionCost } from '../pricing.js';

// The journal layer is part of this adapter's surface: re-exported so callers keep one import.
export {
  readSessionStats,
  readSessionTimeline,
  readSessionExtras,
  sessionAnalytics,
  MAX_TIMELINE_EVENTS,
  timelineMemoSize,
  pruneStatsMemo,
  statsMemoSize,
} from './journal.js';

export function claudeHome() {
  return process.env.CLAUDE_HOME || join(homedir(), '.claude');
}

export function projectsDir() {
  return join(claudeHome(), 'projects');
}

// The project directory name is the working directory path with every `/` replaced by `-`.
// That encoding is lossy (a literal `-` in a path segment is indistinguishable from a separator),
// so the decode below is a best-effort derivation, never an exact restore.
export function deriveProjectLabel(dirName) {
  if (dirName.startsWith('-')) {
    return { label: dirName.replace(/-/g, '/'), derived: true };
  }
  return { label: dirName, derived: true };
}

// Walks projects/ exactly two levels deep: project directories, then session files directly
// inside them. Nested subagent transcripts and tool results live deeper and are never visited.
// A session-level symlink is not a session (lstat, not stat, so it never passes isFile()).
//
// A project-dir entry may itself be a symlink (ADR-0002): resolve it with realpathSync, which
// also detects cycles by throwing (treated as unreadable, so it never hangs). A target outside
// homeDir is hidden entirely — not counted, not reported. A target already scanned through
// another symlink is deduped by its realpath, so it contributes its sessions exactly once.
// `stats.unreadableCount` is incremented for every entry that exists but couldn't be read
// (permission denied, a broken symlink cycle) — never for a missing projects/ (that's the
// empty state, not an error) and never for a symlink that resolves outside homeDir (that
// target is hidden entirely, not reported as unreadable either).
export function scanRawSessions(projectsDir, homeDir = dirname(projectsDir), stats = { unreadableCount: 0 }) {
  const records = [];
  let projectEntries;
  try {
    projectEntries = readdirSync(projectsDir);
  } catch (err) {
    if (err.code !== 'ENOENT') stats.unreadableCount++;
    return records;
  }
  let realHomeDir;
  try { realHomeDir = realpathSync(homeDir); } catch { realHomeDir = homeDir; }
  const scannedRealPaths = new Set();
  for (const projectDirName of projectEntries) {
    const projectPath = join(projectsDir, projectDirName);
    let projectStat;
    try { projectStat = lstatSync(projectPath); } catch { stats.unreadableCount++; continue; }
    let realProjectPath = projectPath;
    if (projectStat.isSymbolicLink()) {
      let real;
      try { real = realpathSync(projectPath); } catch { stats.unreadableCount++; continue; }
      if (real !== realHomeDir && !real.startsWith(realHomeDir + sep)) continue;
      let realStat;
      try { realStat = statSync(real); } catch { stats.unreadableCount++; continue; }
      if (!realStat.isDirectory()) continue;
      realProjectPath = real;
    } else if (!projectStat.isDirectory()) {
      continue;
    }
    if (scannedRealPaths.has(realProjectPath)) continue;
    scannedRealPaths.add(realProjectPath);
    let sessionEntries;
    try { sessionEntries = readdirSync(realProjectPath); } catch { stats.unreadableCount++; continue; }
    for (const name of sessionEntries) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(realProjectPath, name);
      let st;
      try { st = lstatSync(path); } catch { stats.unreadableCount++; continue; }
      if (!st.isFile()) continue;
      records.push({
        sessionId: name.slice(0, -'.jsonl'.length),
        projectDirName,
        size: st.size,
        mtimeMs: st.mtimeMs,
        path,
      });
    }
  }
  return records;
}

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

// The only JSONL fields the index is allowed to read (AGENTS.md §Межі): the record `type`, the
// generated `aiTitle` of an `ai-title` record, and the working directory `cwd`. Nothing under
// `message` is ever looked at. Only the head of the file is scanned: both fields are written
// with the first turn, and reading a whole multi-megabyte transcript would defeat the index.
const HEAD_BYTES = 64 * 1024;

export function readSessionHead(path) {
  const head = { title: null, cwd: null };
  let fd;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(HEAD_BYTES);
    const bytesRead = readSync(fd, buffer, 0, HEAD_BYTES, 0);
    const lines = buffer.toString('utf8', 0, bytesRead).split('\n');
    for (const line of lines) {
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (!record || typeof record !== 'object') continue;
      if (head.title === null && record.type === 'ai-title' && typeof record.aiTitle === 'string' && record.aiTitle.trim()) {
        head.title = record.aiTitle.trim();
      }
      if (head.cwd === null && typeof record.cwd === 'string' && record.cwd) {
        head.cwd = record.cwd;
      }
      if (head.title !== null && head.cwd !== null) break;
    }
  } catch {
    // Unreadable or truncated head: the session keeps its metadata-only shape.
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
  }
  return head;
}

// A project's display name is the last segment of its real working directory when the journal
// records one, otherwise the tail of the derived path; the full path stays available for tooltips.
export function describeProject(projectDirName, cwd) {
  if (cwd) {
    return { name: basename(cwd) || cwd, path: cwd, derived: false };
  }
  const { label } = deriveProjectLabel(projectDirName);
  const tail = label.split('/').filter(Boolean).pop() || label;
  return { name: tail, path: label, derived: true };
}

function enrich(record) {
  const head = readSessionHead(record.path);
  const project = describeProject(record.projectDirName, head.cwd);
  const stats = readSessionStats(record.path, record.size, record.mtimeMs);
  return {
    ...record,
    title: head.title,
    cwd: head.cwd,
    projectName: project.name,
    projectPath: project.path,
    projectDerived: project.derived,
    stats,
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
    addTokens(p.tokens, { input_tokens: session.stats.tokens.input, output_tokens: session.stats.tokens.output,
      cache_read_input_tokens: session.stats.tokens.cacheRead, cache_creation_input_tokens: session.stats.tokens.cacheWrite });
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
  const intoModels = (map, model, entry) => {
    if (!map[model]) map[model] = { turns: 0, tokens: EMPTY_TOKENS() };
    map[model].turns += entry.turns;
    addSplitTokens(map[model].tokens, entry.tokens);
  };
  for (const s of sessions) {
    total.turns += s.stats.turns;
    addTokens(total.tokens, { input_tokens: s.stats.tokens.input, output_tokens: s.stats.tokens.output,
      cache_read_input_tokens: s.stats.tokens.cacheRead, cache_creation_input_tokens: s.stats.tokens.cacheWrite });
    let inWindow = false;
    for (const [day, d] of Object.entries(s.stats.days)) {
      const idx = dayIndex.get(day);
      if (idx === undefined) continue;
      inWindow = true;
      const bucket = buckets[idx];
      bucket.turns += d.turns;
      addTokens(bucket.tokens, { input_tokens: d.tokens.input, output_tokens: d.tokens.output,
        cache_read_input_tokens: d.tokens.cacheRead, cache_creation_input_tokens: d.tokens.cacheWrite });
      if (!bucket.byProject[s.projectDirName]) bucket.byProject[s.projectDirName] = { sessions: 0, turns: 0, output: 0 };
      const share = bucket.byProject[s.projectDirName];
      share.sessions++;
      share.turns += d.turns;
      share.output += d.tokens.output;
      bucket.sessions++;
      period.turns += d.turns;
      addTokens(period.tokens, { input_tokens: d.tokens.input, output_tokens: d.tokens.output,
        cache_read_input_tokens: d.tokens.cacheRead, cache_creation_input_tokens: d.tokens.cacheWrite });
      for (const [model, entry] of Object.entries(d.byModel ?? {})) intoModels(periodModels, model, entry);
    }
    if (inWindow) period.sessions++;
    for (const [model, m] of Object.entries(s.stats.models)) {
      if (!models[model]) models[model] = { model, turns: 0, tokens: EMPTY_TOKENS(), sessions: 0 };
      models[model].turns += m.turns;
      models[model].sessions++;
      addTokens(models[model].tokens, { input_tokens: m.tokens.input, output_tokens: m.tokens.output,
        cache_read_input_tokens: m.tokens.cacheRead, cache_creation_input_tokens: m.tokens.cacheWrite });
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
// `labels` maps sessionId → the developer's own name (lib/store.js); it wins over the journal
// title as `name`, and `label` keeps the raw value so the page can say which one it shows.
export function listSessions({ limit = 50, project = '', q = '', days = DEFAULT_DAYS, sort = 'time', now = Date.now(), labels = {} } = {}) {
  const stats = { unreadableCount: 0 };
  const raw = scanRawSessions(projectsDir(), claudeHome(), stats);
  // ADR-0006: the stats memo is bounded by what the scan can still see, so a deleted or renamed
  // journal stops holding memory. Pruning before enrich also keeps the memo from being measured
  // mid-refill. Keys are `path \0 size \0 mtime`; only the path decides.
  pruneStatsMemo(raw.map((r) => r.path));
  const all = raw.map(enrich).map((s) => {
    const label = Object.hasOwn(labels, s.sessionId) ? labels[s.sessionId] : null;
    return { ...s, label, name: label ?? s.title, cost: estimateSessionCost(s.stats.models) };
  });
  const projects = collectProjects(all);
  const colors = assignColors(projects);
  const scoped = project ? all.filter((r) => r.projectDirName === project) : all;
  const dashboard = buildDashboard(scoped, projects, now, days);
  let candidates = scoped;
  const query = q.trim();
  if (query) candidates = candidates.filter((s) => matchesQuery(s, query));
  const { sessions, totalFound, truncated } = sortAndLimit(candidates, { limit, sort });
  return { sessions, totalFound, truncated, unreadableCount: stats.unreadableCount, projects, colors, totalSessions: all.length, dashboard };
}

export const claude = registerSource({
  id: 'claude',
  label: 'Claude Code',
  home: claudeHome,
});

const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/;

// One session on its own. The scan is the same cheap metadata walk the index does, but only the
// matching record is enriched, so the other journals are never opened. On top of what a
// `listSessions` session carries it adds the ordered `timeline`, the `extras` found in the
// session's own directory, and the derived `analytics`. An id that could not name a session file
// is rejected before any disk work, and an unknown id is null rather than an error.
export function getSession(sessionId, { labels = {} } = {}) {
  if (!SESSION_ID.test(sessionId)) return null;
  const record = scanRawSessions(projectsDir(), claudeHome()).find((r) => r.sessionId === sessionId);
  if (!record) return null;
  const session = enrich(record);
  const label = Object.hasOwn(labels, sessionId) ? labels[sessionId] : null;
  const timeline = readSessionTimeline(record.path, record.size, record.mtimeMs);
  return {
    ...session,
    label,
    name: label ?? session.title,
    timeline,
    extras: readSessionExtras(dirname(record.path), sessionId),
    analytics: sessionAnalytics(session.stats, timeline),
  };
}
