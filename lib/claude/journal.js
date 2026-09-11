// Whole-journal reading for one session: usage aggregates, an ordered event list, the side
// files a session keeps, and the analytics the session page draws from them.
//
// Every field read here is on the closed list (ADR-0001 / AGENTS.md §Межі): from a record
// `type`, `timestamp`, `subtype` and `compactMetadata.{trigger,preTokens,postTokens}`; from
// `message` only `id`, `model` and `usage`; from a `message.content[]` block only `type`,
// `name`, `id`, `tool_use_id` and `is_error`. A user prompt is counted from the bare fact that
// `message.content` is a string — the string itself is never touched. No block, record or
// `message` object is ever kept or returned; only the numbers and short names read out of them.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EMPTY_TOKENS, addTokens, addSplitTokens } from '../tokens.js';
import { memoKey, createStatsMemo, createTimelineMemo, capTimeline, MAX_TIMELINE_EVENTS } from '../journal-memo.js';

// The memo mechanics and the timeline cap are source-agnostic and live in lib/journal-memo.js;
// this adapter owns its own instances, so a second source's entries never land in these.
export { MAX_TIMELINE_EVENTS };

// The token helpers live in lib/tokens.js, which knows nothing about journals; they are
// re-exported here because the adapter's own callers have always imported them from the
// journal layer.
export { EMPTY_TOKENS, addTokens, addSplitTokens, intoModels } from '../tokens.js';

function parseLines(path) {
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch { return []; }
  return text.split('\n');
}

function parseRecord(line) {
  let record;
  try { record = JSON.parse(line); } catch { return null; }
  return record && typeof record === 'object' ? record : null;
}

function recordTs(record) {
  const ts = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
  return Number.isNaN(ts) ? null : ts;
}

// A user record is a prompt when its content is a string, and a batch of tool results when it is
// an array. Only the shape is inspected; the string is never read.
function isPromptRecord(record) {
  return record.type === 'user' && typeof record.message?.content === 'string';
}

function contentBlocks(record) {
  const content = record.message?.content;
  return Array.isArray(content) ? content : [];
}

function compactOf(record) {
  const meta = record.compactMetadata;
  return {
    trigger: typeof meta?.trigger === 'string' ? meta.trigger : 'unknown',
    preTokens: typeof meta?.preTokens === 'number' ? meta.preTokens : 0,
    postTokens: typeof meta?.postTokens === 'number' ? meta.postTokens : 0,
  };
}

function isCompactRecord(record) {
  return record.type === 'system' && record.subtype === 'compact_boundary';
}

// -- Per-session usage -------------------------------------------------------------------
//
// Memoised by path + size + mtime (ADR-0006), so an unchanged journal is read once; the memo
// holds nothing but numbers and short names.
const statsMemo = createStatsMemo();

export function statsMemoSize() {
  return statsMemo.size();
}

// ADR-0006: the memo must not grow forever after a session file is deleted or renamed. The key
// is `path \0 size \0 mtime`, so eviction compares only the path part: a journal the scan
// still sees keeps its entries, and everything the scan no longer sees goes.
export function pruneStatsMemo(livePaths) {
  statsMemo.prune(livePaths);
}

function toolBucket(tools, name) {
  if (!tools[name]) tools[name] = { calls: 0, errors: 0 };
  return tools[name];
}

export function readSessionStats(path, size, mtimeMs) {
  const key = memoKey(path, size, mtimeMs);
  const cached = statsMemo.get(key);
  if (cached) return cached;
  const stats = {
    turns: 0,
    tokens: EMPTY_TOKENS(),
    models: {},
    days: {},
    firstTs: null,
    lastTs: null,
    prompts: 0,
    tools: {},
    compacts: { count: 0, preTokens: 0, postTokens: 0 },
  };
  const seenMessages = new Set();
  const seenToolUses = new Set();
  // tool_use id -> tool name, only so a later tool_result can be attributed. Dropped with the
  // pass: it never reaches the memo.
  const toolNames = new Map();
  for (const line of parseLines(path)) {
    const record = parseRecord(line);
    if (!record) continue;
    const ts = recordTs(record);
    if (ts !== null) {
      if (stats.firstTs === null || ts < stats.firstTs) stats.firstTs = ts;
      if (stats.lastTs === null || ts > stats.lastTs) stats.lastTs = ts;
    }
    if (record.type === 'user') {
      if (isPromptRecord(record)) { stats.prompts++; continue; }
      for (const block of contentBlocks(record)) {
        if (!block || block.type !== 'tool_result') continue;
        // A result whose tool_use_id matches nothing seen in this pass — a truncated journal,
        // or a tool_use whose id was not a string — is booked under `unknown` rather than
        // dropped, so the aggregates and the timeline (which names it `unknown` too) agree.
        // Its call was never counted from a tool_use block, so it is counted here.
        const known = toolNames.get(block.tool_use_id);
        const bucket = toolBucket(stats.tools, known ?? 'unknown');
        if (known === undefined) bucket.calls++;
        if (block.is_error === true) bucket.errors++;
      }
      continue;
    }
    if (isCompactRecord(record)) {
      const compact = compactOf(record);
      stats.compacts.count++;
      stats.compacts.preTokens += compact.preTokens;
      stats.compacts.postTokens += compact.postTokens;
      continue;
    }
    if (record.type !== 'assistant' || !record.message || typeof record.message !== 'object') continue;
    // Tool calls are collected before the message dedup: a journal may split one message id
    // across several records, and the tool block can sit in the second of them.
    for (const block of contentBlocks(record)) {
      if (!block || block.type !== 'tool_use') continue;
      const name = typeof block.name === 'string' && block.name ? block.name : 'unknown';
      const id = typeof block.id === 'string' ? block.id : null;
      if (id !== null) {
        if (seenToolUses.has(id)) continue;
        seenToolUses.add(id);
        toolNames.set(id, name);
      }
      toolBucket(stats.tools, name).calls++;
    }
    const id = typeof record.message.id === 'string' ? record.message.id : null;
    if (id !== null) {
      if (seenMessages.has(id)) continue;
      seenMessages.add(id);
    }
    stats.turns++;
    const model = typeof record.message.model === 'string' ? record.message.model : 'unknown';
    const usage = record.message.usage && typeof record.message.usage === 'object' ? record.message.usage : {};
    addTokens(stats.tokens, usage);
    if (!stats.models[model]) stats.models[model] = { turns: 0, tokens: EMPTY_TOKENS() };
    stats.models[model].turns++;
    addTokens(stats.models[model].tokens, usage);
    if (ts !== null) {
      const day = new Date(ts).toISOString().slice(0, 10);
      if (!stats.days[day]) stats.days[day] = { turns: 0, tokens: EMPTY_TOKENS(), byModel: {} };
      const bucket = stats.days[day];
      bucket.turns++;
      addTokens(bucket.tokens, usage);
      if (!bucket.byModel[model]) bucket.byModel[model] = { turns: 0, tokens: EMPTY_TOKENS() };
      bucket.byModel[model].turns++;
      addTokens(bucket.byModel[model].tokens, usage);
    }
  }
  return statsMemo.set(key, stats);
}

// -- Ordered timeline --------------------------------------------------------------------
//
// The event list is much larger than the aggregates, so it gets its own small LRU instead of
// sharing the stats memo: at most eight journals are kept, and the oldest insertion is dropped.
const timelineMemo = createTimelineMemo(8);

export function timelineMemoSize() {
  return timelineMemo.size();
}

// Events in journal order: a prompt, an assistant turn (deduped by message id, with the tool
// calls it made), a tool result, a compact boundary. Long sessions keep the last
// MAX_TIMELINE_EVENTS events; `total` still reports the full count, so the page can say that the
// head was collapsed while the analytics still cover the whole session.
export function readSessionTimeline(path, size, mtimeMs) {
  const key = memoKey(path, size, mtimeMs);
  const cached = timelineMemo.get(key);
  if (cached) return cached;
  const events = [];
  const turnByMessageId = new Map();
  const seenToolUses = new Set();
  const toolNames = new Map();
  for (const line of parseLines(path)) {
    const record = parseRecord(line);
    if (!record) continue;
    const ts = recordTs(record);
    if (record.type === 'user') {
      if (isPromptRecord(record)) { events.push({ kind: 'prompt', ts }); continue; }
      for (const block of contentBlocks(record)) {
        if (!block || block.type !== 'tool_result') continue;
        const name = toolNames.get(block.tool_use_id) ?? 'unknown';
        events.push({ kind: 'result', ts, name, ok: block.is_error !== true });
      }
      continue;
    }
    if (isCompactRecord(record)) {
      events.push({ kind: 'compact', ts, ...compactOf(record) });
      continue;
    }
    if (record.type !== 'assistant' || !record.message || typeof record.message !== 'object') continue;
    const id = typeof record.message.id === 'string' ? record.message.id : null;
    let event = id !== null ? turnByMessageId.get(id) : undefined;
    if (event === undefined) {
      const usage = record.message.usage && typeof record.message.usage === 'object' ? record.message.usage : {};
      const tokens = EMPTY_TOKENS();
      addTokens(tokens, usage);
      event = {
        kind: 'turn',
        ts,
        model: typeof record.message.model === 'string' ? record.message.model : 'unknown',
        tokens,
        tools: [],
      };
      events.push(event);
      if (id !== null) turnByMessageId.set(id, event);
    }
    // A repeated message id adds no second turn, but its tool calls still belong to that turn.
    for (const block of contentBlocks(record)) {
      if (!block || block.type !== 'tool_use') continue;
      const blockId = typeof block.id === 'string' ? block.id : null;
      const name = typeof block.name === 'string' && block.name ? block.name : 'unknown';
      if (blockId !== null) {
        if (seenToolUses.has(blockId)) continue;
        seenToolUses.add(blockId);
        toolNames.set(blockId, name);
      }
      event.tools.push({ id: blockId, name });
    }
  }
  return timelineMemo.set(key, capTimeline(events));
}

// -- Side files --------------------------------------------------------------------------
//
// A session may keep a directory of its own next to the journal: subagent transcripts with a
// small meta file each, and spilled tool results. Only `agentType` is read out of the meta
// files; the tool results are counted and sized with statSync and never opened.
export function readSessionExtras(projectRealPath, sessionId) {
  const extras = { subagents: {}, toolResults: { count: 0, bytes: 0 } };
  const dir = join(projectRealPath, sessionId);
  let metaNames;
  try { metaNames = readdirSync(join(dir, 'subagents')); } catch { metaNames = []; }
  for (const name of metaNames) {
    if (!name.startsWith('agent-') || !name.endsWith('.meta.json')) continue;
    let meta;
    try { meta = JSON.parse(readFileSync(join(dir, 'subagents', name), 'utf8')); } catch { continue; }
    const agentType = typeof meta?.agentType === 'string' && meta.agentType ? meta.agentType : 'unknown';
    extras.subagents[agentType] = (extras.subagents[agentType] || 0) + 1;
  }
  let resultNames;
  try { resultNames = readdirSync(join(dir, 'tool-results')); } catch { resultNames = []; }
  for (const name of resultNames) {
    let st;
    try { st = statSync(join(dir, 'tool-results', name)); } catch { continue; }
    if (!st.isFile()) continue;
    extras.toolResults.count++;
    extras.toolResults.bytes += st.size;
  }
  return extras;
}

// The session analytics live in lib/analytics.js: they are derived from stats + timeline and
// know nothing about Claude, so every source shares them. Re-exported here so this module
// stays the one import for the journal layer.
export { sessionAnalytics } from '../analytics.js';
