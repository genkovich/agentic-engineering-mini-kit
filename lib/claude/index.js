// Claude Code adapter. Reads ~/.claude, or whatever CLAUDE_HOME points at.
import { homedir } from 'node:os';
import { join } from 'node:path';
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

export const claude = registerSource({
  id: 'claude',
  label: 'Claude Code',
  home: claudeHome,
});
