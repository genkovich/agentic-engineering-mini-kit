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
export function scanRawSessions(projectsDir, homeDir = dirname(projectsDir)) {
  const records = [];
  let projectEntries;
  try { projectEntries = readdirSync(projectsDir); } catch { return records; }
  let realHomeDir;
  try { realHomeDir = realpathSync(homeDir); } catch { realHomeDir = homeDir; }
  const scannedRealPaths = new Set();
  for (const projectDirName of projectEntries) {
    const projectPath = join(projectsDir, projectDirName);
    let projectStat;
    try { projectStat = lstatSync(projectPath); } catch { continue; }
    let realProjectPath = projectPath;
    if (projectStat.isSymbolicLink()) {
      let real;
      try { real = realpathSync(projectPath); } catch { continue; }
      if (real !== realHomeDir && !real.startsWith(realHomeDir + sep)) continue;
      let realStat;
      try { realStat = statSync(real); } catch { continue; }
      if (!realStat.isDirectory()) continue;
      realProjectPath = real;
    } else if (!projectStat.isDirectory()) {
      continue;
    }
    if (scannedRealPaths.has(realProjectPath)) continue;
    scannedRealPaths.add(realProjectPath);
    let sessionEntries;
    try { sessionEntries = readdirSync(realProjectPath); } catch { continue; }
    for (const name of sessionEntries) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(realProjectPath, name);
      let st;
      try { st = lstatSync(path); } catch { continue; }
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

export const claude = registerSource({
  id: 'claude',
  label: 'Claude Code',
  home: claudeHome,
});
