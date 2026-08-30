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
