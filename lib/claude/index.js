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

export const claude = registerSource({
  id: 'claude',
  label: 'Claude Code',
  home: claudeHome,
});
