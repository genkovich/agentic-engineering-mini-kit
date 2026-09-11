// The dashboard's own storage: the one place the app writes to, and it is never inside the
// agent's home (AGENTS.md §Межі). One JSON file of session labels, rewritten whole on every
// change through a temp file + rename, so a crash mid-write never leaves a half file behind.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';

const MAX_LABEL = 120;

export function agentOpsHome() {
  return process.env.AGENT_OPS_HOME || join(homedir(), '.agent-ops');
}

export function labelsFile() {
  return join(agentOpsHome(), 'labels.json');
}

// Missing or unreadable file means "no labels yet"; a corrupt file is treated the same way
// rather than taking the page down, and is overwritten by the next successful write.
export function readLabels() {
  let text;
  try { text = readFileSync(labelsFile(), 'utf8'); } catch { return {}; }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const labels = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value.trim()) labels[id] = value.trim().slice(0, MAX_LABEL);
    }
    return labels;
  } catch {
    return {};
  }
}

export function normalizeLabel(raw) {
  return typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ').slice(0, MAX_LABEL) : '';
}

// An empty label removes the entry, so "clear the name" and "never named" look the same.
export function setLabel(sessionId, rawLabel) {
  const labels = readLabels();
  const label = normalizeLabel(rawLabel);
  if (label) labels[sessionId] = label;
  else delete labels[sessionId];
  mkdirSync(agentOpsHome(), { recursive: true });
  const target = labelsFile();
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(labels, null, 2) + '\n');
  renameSync(tmp, target);
  return label || null;
}
