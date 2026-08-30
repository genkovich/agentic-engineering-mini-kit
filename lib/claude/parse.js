// Targeted reads over a session JSONL. Nothing here loads a whole file unless asked to.
//
// Two records carry the human-facing identity of a session:
//   {"type":"ai-title","aiTitle":"...","sessionId":"..."}   the generated title
//   {"type":"user", ..., "message":{"content": ...}}         the first prompt
//
// Where the title actually sits: measured over the 222 real sessions on this machine that have
// one, it lands in the first ~2% of lines — Claude Code names a session right after the first
// exchange, not at the end. So the head window finds nearly all of them; the tail window is the
// fallback for the rare late rename.

import { statSync, openSync, readSync, closeSync } from 'node:fs';

export const HEAD_BYTES = 128 * 1024;
export const TAIL_BYTES = 64 * 1024;

function readWindow(file, { from, length }) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const read = readSync(fd, buf, 0, length, from);
    return buf.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export function readHead(file, bytes = HEAD_BYTES) {
  const size = statSync(file).size;
  const length = Math.min(bytes, size);
  const text = readWindow(file, { from: 0, length });
  // Drop a trailing partial line unless we read the file whole.
  return { text: length === size ? text : text.slice(0, text.lastIndexOf('\n') + 1), whole: length === size };
}

export function readTail(file, bytes = TAIL_BYTES) {
  const size = statSync(file).size;
  const length = Math.min(bytes, size);
  const from = size - length;
  const text = readWindow(file, { from, length });
  // Drop a leading partial line unless we read the file whole.
  return { text: from === 0 ? text : text.slice(text.indexOf('\n') + 1), whole: from === 0 };
}

export function* parseLines(text) {
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // A half-written last line is normal while Claude Code is running. Skip it.
    }
  }
}

// message.content is a string on plain prompts and an array of blocks otherwise. Tool results and
// interrupt notices arrive as user records too, so "first user record" is not "first prompt".
export function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n');
}

const NOT_A_PROMPT = [
  /^\[Request interrupted/,
  /^Caveat: The messages below were generated/,
  /^<(command-name|command-message|local-command)/,
];

export function isHumanPrompt(record) {
  if (record?.type !== 'user' || record.isMeta) return false;
  if (Array.isArray(record.message?.content)
      && record.message.content.some((b) => b?.type === 'tool_result')) return false;
  const text = textOf(record.message?.content).trim();
  if (!text) return false;
  return !NOT_A_PROMPT.some((re) => re.test(text));
}

function scan(text, found) {
  for (const record of parseLines(text)) {
    if (record.type === 'ai-title' && record.aiTitle && !found.aiTitle) {
      found.aiTitle = record.aiTitle;
    }
    if (!found.firstPrompt && isHumanPrompt(record)) {
      found.firstPrompt = textOf(record.message.content).trim();
      found.startedAt = record.timestamp ?? null;
    }
  }
  return found;
}

// Two bounded reads per file: head first, tail only when the head came up short.
export function sessionIdentity(file) {
  const found = { aiTitle: null, firstPrompt: null, startedAt: null, reads: 0 };

  const head = readHead(file);
  found.reads = 1;
  scan(head.text, found);

  if (!head.whole && !found.aiTitle) {
    const tail = readTail(file);
    found.reads = 2;
    scan(tail.text, found);
  }

  const title = found.aiTitle
    ?? (found.firstPrompt ? firstLine(found.firstPrompt) : null);

  return {
    title,
    titleSource: found.aiTitle ? 'ai-title' : (found.firstPrompt ? 'first prompt' : 'id only'),
    firstPrompt: found.firstPrompt,
    startedAt: found.startedAt,
    reads: found.reads,
  };
}

export function firstLine(text, max = 80) {
  const line = text.split('\n').find((l) => l.trim()) ?? '';
  const trimmed = line.trim();
  return trimmed.length > max ? trimmed.slice(0, max - 1) + '…' : trimmed;
}

// ---------------------------------------------------------------------------------------------
// S3 — the timeline. This is the one place that parses a whole file, and only ever one file.
//
// A tool call is split across two records: the `tool_use` block inside an assistant message, and
// the matching `tool_result` block inside the next user message. They join on tool_use_id.
//
// Truncation: Claude Code spills large outputs to <sessionId>/tool-results/*.txt and leaves an
// "... [N lines truncated]" marker in the transcript. The transcript carries NO path back to the
// spilled file — measured on real sessions, the jsonl never mentions tool-results at all. So the
// most we can honestly say is that this output is not the whole output.

import { readFileSync } from 'node:fs';

const TRUNCATION = /\.\.\. \[(\d+) lines truncated\]/;

export function summarizeInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  const first = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.query
    ?? input.prompt ?? input.description;
  if (typeof first === 'string') return firstLine(first, 160);
  return firstLine(JSON.stringify(input), 160);
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b === 'string' ? b : b?.text ?? '')).join('\n');
  }
  return '';
}

export function parseSession(file) {
  const records = [...parseLines(readFileSync(file, 'utf8'))];

  const pending = new Map();   // tool_use_id -> event awaiting its result
  const events = [];
  const stamps = [];
  let aiTitle = null;
  let cwd = null;
  let model = null;

  for (const r of records) {
    if (r.timestamp) stamps.push(r.timestamp);
    if (r.type === 'ai-title' && r.aiTitle) aiTitle = r.aiTitle;
    if (r.cwd && !cwd) cwd = r.cwd;

    if (r.type === 'system' && r.subtype === 'compact_boundary') {
      events.push({
        kind: 'compact',
        at: r.timestamp ?? null,
        trigger: r.compactMetadata?.trigger ?? 'unknown',
        preTokens: r.compactMetadata?.preTokens ?? null,
        postTokens: r.compactMetadata?.postTokens ?? null,
      });
      continue;
    }

    if (r.type === 'assistant') {
      if (r.message?.model) model = r.message.model;
      const text = textOf(r.message?.content).trim();
      if (text) events.push({ kind: 'assistant', at: r.timestamp ?? null, text });
      for (const block of r.message?.content ?? []) {
        if (block?.type !== 'tool_use') continue;
        const event = {
          kind: 'tool',
          at: r.timestamp ?? null,
          id: block.id,
          name: block.name,
          input: summarizeInput(block.name, block.input),
          output: null,
          isError: false,
          truncated: false,
          durationMs: null,
        };
        events.push(event);
        pending.set(block.id, event);
      }
      continue;
    }

    if (r.type === 'user') {
      const blocks = Array.isArray(r.message?.content) ? r.message.content : [];
      const results = blocks.filter((b) => b?.type === 'tool_result');
      for (const block of results) {
        const event = pending.get(block.tool_use_id);
        const text = resultText(block.content);
        if (!event) {
          // A result whose call is not in this file: a resumed session, or a compacted-away call.
          events.push({
            kind: 'tool', at: r.timestamp ?? null, id: block.tool_use_id, name: '(orphan result)',
            input: '', output: text, isError: block.is_error === true, truncated: TRUNCATION.test(text),
            durationMs: null,
          });
          continue;
        }
        event.output = text;
        event.isError = block.is_error === true;
        event.truncated = TRUNCATION.test(text);
        if (event.at && r.timestamp) event.durationMs = Date.parse(r.timestamp) - Date.parse(event.at);
        pending.delete(block.tool_use_id);
      }
      if (results.length === 0 && isHumanPrompt(r)) {
        events.push({ kind: 'prompt', at: r.timestamp ?? null, text: textOf(r.message.content).trim() });
      }
    }
  }

  stamps.sort();
  const startedAt = stamps[0] ?? null;
  const endedAt = stamps[stamps.length - 1] ?? null;

  return {
    aiTitle,
    cwd,
    model,
    startedAt,
    endedAt,
    // Wall time is not recorded anywhere in the transcript. This is the span between the first and
    // the last timestamp in the file — an OBSERVED value. A session left open over lunch and a
    // session that worked for two hours look identical here. Never present it as time spent.
    spanMs: startedAt && endedAt ? Date.parse(endedAt) - Date.parse(startedAt) : null,
    spanKind: 'observed',
    recordCount: records.length,
    events,
    unmatchedToolCalls: [...pending.keys()],
  };
}
