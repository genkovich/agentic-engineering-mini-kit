// The dashboard's own storage: the one place the app writes to, and it is never inside the
// agent's home (AGENTS.md §Межі, ADR-0002). One JSON file of per-session workspace entries —
// the developer's own name, tags, a note and a star — rewritten whole on every change through
// a temp file + rename, so a crash mid-write never leaves a half file behind.
//
// `sessions.json` is the store. `labels.json` is the format step 1 shipped; it is now read-only
// legacy: when `sessions.json` does not exist yet, the entries are derived from it so an
// existing home keeps its names, and the first write creates `sessions.json` and leaves
// `labels.json` exactly where it is. A read never writes.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';

const MAX_LABEL = 120;
const MAX_NOTE = 2000;
const MAX_TAGS = 10;
// A tag is one word of letters, digits, underscore or dash, in any script. No spaces, no
// punctuation, so a tag is always safe to put in a query string and to compare case-insensitively.
const TAG = /^[\p{L}\p{N}_-]{1,32}$/u;

export function agentOpsHome() {
  return process.env.AGENT_OPS_HOME || join(homedir(), '.agent-ops');
}

// The legacy file. Still the answer to "where did step 1 keep the names", and still outside
// the agent home, which is what the tests assert.
export function labelsFile() {
  return join(agentOpsHome(), 'labels.json');
}

export function sessionsFile() {
  return join(agentOpsHome(), 'sessions.json');
}

function readJson(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return null; }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function normalizeLabel(raw) {
  return typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ').slice(0, MAX_LABEL) : '';
}

// Accepts what a form sends ("bug, refactor") or what JSON holds (["bug", "refactor"]).
// Case is kept as typed but deduped case-insensitively, so "Bug" and "bug" are one tag and the
// first spelling wins. Anything that is not a single tag word is dropped rather than repaired.
export function normalizeTags(raw) {
  let list;
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === 'string') list = raw.split(/[,\s]+/);
  else return [];
  const tags = [];
  const seen = new Set();
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const tag = item.trim();
    if (!TAG.test(tag)) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length === MAX_TAGS) break;
  }
  return tags;
}

export function normalizeNote(raw) {
  return typeof raw === 'string' ? raw.trim().slice(0, MAX_NOTE) : '';
}

// One entry, or null when there is nothing left to store. An entry only carries the fields it
// actually has, so "never tagged" and "tags cleared" are the same thing on disk.
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const label = normalizeLabel(raw.label);
  const tags = normalizeTags(raw.tags);
  const note = normalizeNote(raw.note);
  const starred = Boolean(raw.starred);
  if (!label && tags.length === 0 && !note && !starred) return null;
  const entry = {};
  if (label) entry.label = label;
  if (tags.length) entry.tags = tags;
  if (note) entry.note = note;
  if (starred) entry.starred = true;
  return entry;
}

// Missing or unreadable file means "nothing stored yet"; a corrupt file is treated the same way
// rather than taking the page down, and is overwritten by the next successful write. Every entry
// is normalised on read too, so a hand-edited file cannot smuggle a 10kB note into a page.
export function readStore() {
  const parsed = readJson(sessionsFile()) ?? deriveFromLabels();
  const store = {};
  for (const [id, value] of Object.entries(parsed)) {
    const entry = normalizeEntry(value);
    if (entry) store[id] = entry;
  }
  return store;
}

function deriveFromLabels() {
  const parsed = readJson(labelsFile());
  if (!parsed) return {};
  const derived = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (typeof value === 'string' && value.trim()) derived[id] = { label: value };
  }
  return derived;
}

function writeStore(store) {
  mkdirSync(agentOpsHome(), { recursive: true });
  const target = sessionsFile();
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n');
  renameSync(tmp, target);
}

// Merges `patch` into the session's entry and rewrites the store. Only the keys the patch
// actually carries are touched, so a form that sends no `tags` field leaves the tags alone;
// a form that means "clear the tags" sends an empty value. An entry with nothing left in it is
// removed, so clearing everything looks exactly like never having edited the session.
export function updateSession(sessionId, patch = {}) {
  const store = readStore();
  const merged = { ...(store[sessionId] ?? {}) };
  for (const key of ['label', 'tags', 'note', 'starred']) {
    if (Object.hasOwn(patch, key)) merged[key] = patch[key];
  }
  const entry = normalizeEntry(merged);
  if (entry) store[sessionId] = entry;
  else delete store[sessionId];
  writeStore(store);
  return entry;
}

// The step-1 surface, kept as a thin projection over the store so callers that only care about
// names (and the tests that pin them) never have to know the entry shape.
export function readLabels() {
  const labels = {};
  for (const [id, entry] of Object.entries(readStore())) {
    if (entry.label) labels[id] = entry.label;
  }
  return labels;
}

export function setLabel(sessionId, rawLabel) {
  return updateSession(sessionId, { label: rawLabel })?.label ?? null;
}
