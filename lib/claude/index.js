// Claude Code adapter. Reads ~/.claude, or whatever CLAUDE_HOME points at.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdirSync, lstatSync } from 'node:fs';
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
export function scanRawSessions(projectsDir) {
  const records = [];
  let projectEntries;
  try { projectEntries = readdirSync(projectsDir); } catch { return records; }
  for (const projectDirName of projectEntries) {
    const projectPath = join(projectsDir, projectDirName);
    let projectStat;
    try { projectStat = lstatSync(projectPath); } catch { continue; }
    if (!projectStat.isDirectory()) continue;
    let sessionEntries;
    try { sessionEntries = readdirSync(projectPath); } catch { continue; }
    for (const name of sessionEntries) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(projectPath, name);
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
