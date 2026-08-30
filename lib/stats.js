// S6 — analytics.
//
// Two tiers on purpose, because they cost different amounts:
//
//   from the S1 index alone (fstat, ~50 ms for 340 sessions): sessions per day, bytes per day.
//   from a full parse of each file (824 MB on this machine): tool counts, tokens per day.
//
// The second tier is why `scanned` and `skipped` are part of the response. A dashboard that
// aggregates over a subset and prints the number as if it covered everything is lying about its
// own coverage, so the API reports what it actually read.

import { readFileSync } from 'node:fs';
import { listSessions } from './claude/index.js';
import { parseLines } from './claude/parse.js';
import { usageByResponse, addUsage, EMPTY } from './claude/tokens.js';

const DEFAULT_SCAN = 60;
const cache = new Map();   // "file:mtime:size" -> per-session aggregate

const day = (iso) => iso.slice(0, 10);

function aggregateFile(session) {
  const key = `${session.file}:${session.modifiedAt}:${session.sizeBytes}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const records = [...parseLines(readFileSync(session.file, 'utf8'))];
  const tools = new Map();
  let errors = 0;

  for (const r of records) {
    if (r?.type === 'assistant') {
      for (const block of r.message?.content ?? []) {
        if (block?.type === 'tool_use') tools.set(block.name, (tools.get(block.name) ?? 0) + 1);
      }
    }
    if (r?.type === 'user' && Array.isArray(r.message?.content)) {
      for (const block of r.message.content) {
        if (block?.type === 'tool_result' && block.is_error === true) errors += 1;
      }
    }
  }

  // Token days come from the response timestamps, not the file mtime: a session that ran past
  // midnight belongs to both days.
  const tokensByDay = new Map();
  for (const response of usageByResponse(records)) {
    const d = response.at ? day(response.at) : day(session.modifiedAt);
    addUsage(tokensByDay.get(d) ?? tokensByDay.set(d, { ...EMPTY }).get(d), response.usage);
  }

  const value = { tools: [...tools], errors, tokensByDay: [...tokensByDay] };
  cache.set(key, value);
  return value;
}

export function buildStats({ scan = DEFAULT_SCAN } = {}) {
  const started = Date.now();
  const all = listSessions();

  // Tier one: the whole index, no file opened.
  const sessionsPerDay = new Map();
  for (const s of all) {
    const d = day(s.modifiedAt);
    const bucket = sessionsPerDay.get(d) ?? sessionsPerDay.set(d, { day: d, sessions: 0, bytes: 0 }).get(d);
    bucket.sessions += 1;
    bucket.bytes += s.sizeBytes;
  }

  // Tier two: the freshest `scan` sessions, parsed.
  const target = all.slice(0, scan);
  const tools = new Map();
  const tokensPerDay = new Map();
  let errors = 0;
  let bytesScanned = 0;

  for (const session of target) {
    let agg;
    try {
      agg = aggregateFile(session);
    } catch {
      continue;   // unreadable file: skipped, and it shows up in scanned < requested
    }
    bytesScanned += session.sizeBytes;
    errors += agg.errors;
    for (const [name, n] of agg.tools) tools.set(name, (tools.get(name) ?? 0) + n);
    for (const [d, totals] of agg.tokensByDay) {
      const bucket = tokensPerDay.get(d) ?? tokensPerDay.set(d, { day: d, ...EMPTY }).get(d);
      for (const k of Object.keys(EMPTY)) bucket[k] += totals[k];
    }
  }

  return {
    totalSessions: all.length,
    scanned: target.length,
    skipped: all.length - target.length,
    bytesScanned,
    elapsedMs: Date.now() - started,
    sessionsPerDay: [...sessionsPerDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    topTools: [...tools].map(([name, calls]) => ({ name, calls })).sort((a, b) => b.calls - a.calls),
    toolErrors: errors,
    tokensPerDay: [...tokensPerDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
  };
}
