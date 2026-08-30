// Claude Code adapter. Reads ~/.claude, or whatever CLAUDE_HOME points at.
//
// Layout, as it exists on disk:
//
//   ~/.claude/projects/<project-slug>/<sessionId>.jsonl   <- a session. This is what we index.
//   ~/.claude/projects/<project-slug>/<sessionId>/         <- artifacts of that session:
//                                     tool-results/*.txt   spilled tool output
//                                     subagents/*.jsonl    subagent transcripts
//                                     workflows/           workflow state
//
// The trap: `find ~/.claude/projects -name '*.jsonl'` counts the subagent transcripts too and
// reports roughly six times more sessions than exist. A session is a *.jsonl exactly one level
// inside a project directory — never deeper.

import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { registerSource } from '../sources.js';
import { sessionIdentity } from './parse.js';

export function claudeHome() {
  return process.env.CLAUDE_HOME || join(homedir(), '.claude');
}

export function projectsDir() {
  return join(claudeHome(), 'projects');
}

// Slugs are the project cwd with every "/" turned into "-". That is lossy: a directory whose own
// name contains a dash is indistinguishable from a path separator. We decode best-effort and label
// the result "derived" in the API, so nothing downstream mistakes it for a verified path.
export function decodeProjectSlug(slug) {
  const path = '/' + slug.replace(/^-+/, '').replaceAll('-', '/');
  const label = path.split('/').filter(Boolean).slice(-2).join('/') || path;
  return { path, label };
}

export function listSessions({ home = claudeHome() } = {}) {
  const dir = join(home, 'projects');
  let projects;
  try {
    projects = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const sessions = [];
  for (const project of projects) {
    const projectDir = join(dir, project.name);
    let entries;
    try {
      entries = readdirSync(projectDir, { withFileTypes: true });
    } catch {
      continue; // a project directory we cannot read is skipped, not fatal
    }
    const { path: projectPath, label: projectLabel } = decodeProjectSlug(project.name);

    for (const entry of entries) {
      // Directories here are session artifacts (tool-results, subagents, workflows), not sessions.
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const file = join(projectDir, entry.name);
      let st;
      try {
        st = statSync(file);
      } catch {
        continue; // vanished between readdir and stat
      }
      sessions.push({
        source: 'claude',
        sessionId: entry.name.slice(0, -'.jsonl'.length),
        projectSlug: project.name,
        projectLabel,
        projectPath,
        projectPathDerived: true,
        file,
        sizeBytes: st.size,
        modifiedAt: st.mtime.toISOString(),
      });
    }
  }

  sessions.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return sessions;
}

// S2 — human titles. Deliberately NOT part of listSessions(): identity costs two bounded reads
// per file, and on 340 real sessions that is 535 ms against the index's 48 ms. So the index stays
// cheap and only the rows actually on screen get enriched.
export function enrichWithIdentity(sessions) {
  return sessions.map((s) => {
    try {
      return { ...s, ...sessionIdentity(s.file) };
    } catch {
      return { ...s, title: null, titleSource: 'unreadable', firstPrompt: null, startedAt: null };
    }
  });
}

export const claude = registerSource({
  id: 'claude',
  label: 'Claude Code',
  home: claudeHome,
  listSessions,
  enrichWithIdentity,
});
