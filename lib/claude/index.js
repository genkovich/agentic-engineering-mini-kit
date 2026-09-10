// Claude Code adapter. Reads ~/.claude, or whatever CLAUDE_HOME points at.
import { homedir } from 'node:os';
import { join, dirname, sep } from 'node:path';
import { readdirSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { registerSource } from '../sources.js';

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
export function sortAndLimit(records, { limit }) {
  const sorted = [...records].sort((a, b) => b.mtimeMs - a.mtimeMs || a.sessionId.localeCompare(b.sessionId));
  const totalFound = sorted.length;
  const truncated = totalFound > limit;
  return { sessions: sorted.slice(0, limit), totalFound, truncated };
}

// Rebuilds the index synchronously on every call (ADR-0001): no cache, no persisted state.
// Best-effort — an unreadable entry is skipped and counted, this never throws (spec §6 NFR).
export function listSessions({ limit = 50 } = {}) {
  const stats = { unreadableCount: 0 };
  const raw = scanRawSessions(projectsDir(), claudeHome(), stats);
  const { sessions, totalFound, truncated } = sortAndLimit(raw, { limit });
  return { sessions, totalFound, truncated, unreadableCount: stats.unreadableCount };
}

export const claude = registerSource({
  id: 'claude',
  label: 'Claude Code',
  home: claudeHome,
});
