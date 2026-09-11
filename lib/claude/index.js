// Claude Code adapter. Reads ~/.claude, or whatever CLAUDE_HOME points at.
import { homedir } from 'node:os';
import { join, dirname, sep, basename } from 'node:path';
import { readdirSync, lstatSync, realpathSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { registerSource } from '../sources.js';
import {
  readSessionStats,
  readSessionTimeline,
  readSessionExtras,
  pruneStatsMemo,
} from './journal.js';

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

// The adapter object: this vendor's half of the source contract (lib/sources.js). Everything
// above stays an ordinary export too, so the functions that steps 1-2 shipped keep their names
// and their tests. `describeProject` is adapted to the contract's (record, head) shape here,
// because decoding a project directory name is Claude's own convention, not a shared one.
export const claude = registerSource({
  id: 'claude',
  label: 'Claude Code',
  home: claudeHome,
  scan: (stats) => scanRawSessions(projectsDir(), claudeHome(), stats),
  readHead: readSessionHead,
  describeProject: (record, head) => describeProject(record.projectDirName, head.cwd),
  readStats: readSessionStats,
  readTimeline: readSessionTimeline,
  readExtras: (record) => readSessionExtras(dirname(record.path), record.sessionId),
  pruneStatsMemo,
});

// The index and the single-session read moved to lib/sessions.js, which orchestrates over every
// registered source. They are re-exported here so the imports written against this module in
// steps 1-4 keep working; new callers should import them from '../sessions.js' directly.
export {
  listSessions,
  getSession,
  buildDashboard,
  sortAndLimit,
  assignColors,
  groupByProject,
  PERIOD_CHOICES,
} from '../sessions.js';

