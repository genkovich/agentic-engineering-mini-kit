// S5 — live tail.
//
// Claude Code appends to the session JSONL as it works, so "live" is: remember how many bytes of
// each file we have already read, and on every tick read only what grew past that mark.
//
// Polling, not fs.watch: session files live wherever the user's home is, and on iCloud-backed or
// network paths fs.watch drops events silently. A 1 s poll over 340 fstat calls costs ~50 ms — the
// same walk S1 already does — and it cannot miss a write.
//
// The other rule: a JSONL file is appended to a line at a time, so the last chunk we read is very
// often half a record. Anything after the final "\n" is left in the file for the next tick.

import { openSync, readSync, closeSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { listSessions } from './claude/index.js';
import { parseLines, isHumanPrompt, textOf } from './claude/parse.js';

const ACTIVE_WINDOW_MS = 10 * 60 * 1000;

function readRange(file, from, length) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const read = readSync(fd, buf, 0, length, from);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

// One live event per appended record, flattened to what a feed row needs.
export function toLiveEvent(record) {
  if (record?.type === 'assistant') {
    const text = textOf(record.message?.content).trim();
    const calls = (record.message?.content ?? []).filter((b) => b?.type === 'tool_use');
    if (calls.length) return { kind: 'tool', at: record.timestamp ?? null, label: calls.map((c) => c.name).join(', ') };
    if (text) return { kind: 'assistant', at: record.timestamp ?? null, label: text.slice(0, 120) };
    return null;
  }
  if (record?.type === 'user') {
    const blocks = Array.isArray(record.message?.content) ? record.message.content : [];
    const result = blocks.find((b) => b?.type === 'tool_result');
    if (result) {
      return { kind: result.is_error ? 'error' : 'result', at: record.timestamp ?? null,
        label: result.is_error ? 'tool call failed' : 'tool result' };
    }
    if (isHumanPrompt(record)) {
      return { kind: 'prompt', at: record.timestamp ?? null, label: textOf(record.message.content).trim().slice(0, 120) };
    }
    return null;
  }
  if (record?.type === 'system' && record.subtype === 'compact_boundary') {
    return { kind: 'compact', at: record.timestamp ?? null, label: 'conversation compacted' };
  }
  return null;
}

export class SessionWatcher extends EventEmitter {
  constructor({ intervalMs = Number(process.env.WATCH_INTERVAL_MS || 1000) } = {}) {
    super();
    this.intervalMs = intervalMs;
    this.offsets = new Map();
    this.timer = null;
    this.primed = false;
  }

  // Start from the current end of every file: subscribers want what happens next, not the archive.
  prime() {
    for (const s of listSessions()) this.offsets.set(s.file, s.sizeBytes);
    this.primed = true;
    return this;
  }

  start() {
    if (this.timer) return this;
    if (!this.primed) this.prime();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this;
  }

  tick() {
    for (const session of listSessions()) {
      const from = this.offsets.get(session.file);
      if (from === undefined) {
        // A session file that appeared after priming: read it whole, it is a new session.
        this.offsets.set(session.file, 0);
        this.emit('session-started', session);
      }
      const start = this.offsets.get(session.file);
      if (session.sizeBytes === start) continue;
      if (session.sizeBytes < start) {           // rewritten or rotated under us
        this.offsets.set(session.file, session.sizeBytes);
        continue;
      }

      const chunk = readRange(session.file, start, session.sizeBytes - start);
      const cut = chunk.lastIndexOf(0x0a);        // "\n"
      if (cut < 0) continue;                     // only a partial record so far, wait for the rest
      this.offsets.set(session.file, start + cut + 1);

      const events = [];
      for (const record of parseLines(chunk.subarray(0, cut + 1).toString('utf8'))) {
        const event = toLiveEvent(record);
        if (event) events.push(event);
      }
      if (events.length) this.emit('append', { session, events });
    }
  }
}

export function activeSessions({ now = Date.now(), windowMs = ACTIVE_WINDOW_MS } = {}) {
  return listSessions().filter((s) => now - Date.parse(s.modifiedAt) <= windowMs);
}
