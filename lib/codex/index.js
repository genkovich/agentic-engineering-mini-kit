// Codex CLI adapter. Reads ~/.codex, or whatever CODEX_HOME points at, and never writes to it.
//
// Codex keeps one JSONL "rollout" per session under sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl.
// Every line is a RolloutLine: `{ timestamp, ordinal?, type, payload }`, where `type` is the
// snake_case name of a RolloutItem variant (`session_meta`, `turn_context`, `response_item`,
// `event_msg`, `compacted`, …) and `payload` is that variant's body. Verified against
// openai/codex: codex-rs/history/src/{lib.rs,rollout_payload.rs} (RolloutLine, RolloutItemWire,
// `#[serde(tag = "type", rename_all = "snake_case")]`, payload field), codex-rs/protocol/src/
// protocol.rs (SessionMeta.{id, cwd, timestamp}, TurnContextItem.{cwd, model}, TokenCountEvent
// {info}, TokenUsageInfo.{total_token_usage, last_token_usage}, TokenUsage.{input_tokens,
// cached_input_tokens, cache_write_input_tokens, output_tokens}) and codex-rs/protocol/src/
// models.rs (ResponseItem variants and FunctionCallOutputPayload.success).
//
// The closed field list (ADR-0001 / AGENTS.md §Межі) is narrower than that format. This module
// reads a record's `timestamp` and `type`; `session_meta.payload.{id, cwd}`;
// `turn_context.payload.{model, cwd}`; `response_item.payload.type` plus, for a tool call, only
// `name` and `call_id`, and for a tool output only `call_id` and the boolean `success` flag;
// `event_msg.payload.type` and, for `token_count`, only the numbers under
// `payload.info.last_token_usage`; and from a `compacted` record only the fact that it happened.
// `content`, `arguments`, `input`, `output` bodies, `message`, `text`, `instructions`, `summary`
// and reasoning of any kind are never read. No record or payload object is ever kept or returned:
// only the numbers and the short tool names read out of them reach a memo or a caller.
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { readdirSync, lstatSync, readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { registerSource, projectDirNameFor } from '../sources.js';
import { EMPTY_TOKENS, addSplitTokens } from '../tokens.js';
import { memoKey, createStatsMemo, createTimelineMemo, capTimeline } from '../journal-memo.js';

export function codexHome() {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

export function sessionsDir() {
  return join(codexHome(), 'sessions');
}

// -- Reading one line --------------------------------------------------------------------

function parseLines(path) {
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch { return []; }
  return text.split('\n');
}

function parseRecord(line) {
  let record;
  try { record = JSON.parse(line); } catch { return null; }
  if (!record || typeof record !== 'object') return null;
  return record;
}

function recordTs(record) {
  const ts = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
  return Number.isNaN(ts) ? null : ts;
}

// A payload is only ever inspected through these: a `type` discriminator and a handful of short
// scalars. Nothing returns the payload itself.
function payloadOf(record) {
  const payload = record.payload;
  return payload && typeof payload === 'object' ? payload : null;
}

function str(value) {
  return typeof value === 'string' && value ? value : null;
}

function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function callId(payload) {
  return str(payload.call_id);
}

// -- The scan ----------------------------------------------------------------------------

// The filename carries the session's uuid: rollout-<ISO timestamp>-<uuid>.jsonl. A file that does
// not match keeps its whole basename as the id, so an unusual name is still addressable rather
// than dropped.
const ROLLOUT_ID = /-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

export function sessionIdFromFileName(name) {
  const stem = name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : name;
  const match = ROLLOUT_ID.exec(stem);
  return match ? match[1] : stem;
}

// The head is read during the scan, not after it: the contract asks `scan` for a `projectDirName`,
// and Codex has no project directory of its own — the project is the session's working directory,
// which lives in the `session_meta` record on line 1. Caching it by path + size + mtime means
// `readHead` does not open the file a second time.
// Keyed by path alone, with the size and mtime kept beside the value: the contract hands
// `readHead` only a path, so a key built from all three could never be hit from there. A caller
// that knows the size and mtime (the scan) still gets a re-read when the file has changed under
// the cache; a caller that does not takes what the scan most recently read.
const HEAD_BYTES = 64 * 1024;
const headMemo = new Map();

export function headMemoSize() {
  return headMemo.size;
}

export function readCodexHead(path, size, mtimeMs) {
  const cached = headMemo.get(path);
  if (cached && (size === undefined || (cached.size === size && cached.mtimeMs === mtimeMs))) return cached.head;
  // Codex writes no generated title for a session, so `title` is always null: the only text that
  // could stand in for one is conversation content, which is off the closed list.
  const head = { title: null, cwd: null };
  let fd;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(HEAD_BYTES);
    const bytesRead = readSync(fd, buffer, 0, HEAD_BYTES, 0);
    for (const line of buffer.toString('utf8', 0, bytesRead).split('\n')) {
      const record = parseRecord(line);
      if (!record) continue;
      // `session_meta` is authoritative; a `turn_context` earlier in the file is the fallback for
      // a rollout whose head record is missing or truncated.
      if (record.type !== 'session_meta' && record.type !== 'turn_context') continue;
      const cwd = str(payloadOf(record)?.cwd);
      if (cwd) { head.cwd = cwd; break; }
    }
  } catch {
    // Unreadable or truncated head: the session keeps its metadata-only shape.
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
  }
  headMemo.set(path, { size, mtimeMs, head });
  return head;
}

// Walks sessions/ exactly four levels deep: year, month, day, then the rollout files inside.
// Everything is lstat'd and symlinks are skipped at every level, so the scan can never be walked
// out of the home it was pointed at and can never follow a cycle. A missing sessions/ is the
// empty state, not an error; anything that exists but cannot be read is counted.
export function scanCodexSessions(dir, stats = { unreadableCount: 0 }) {
  const records = [];
  for (const dayDir of walkDateDirs(dir, 3, stats)) {
    let names;
    try { names = readdirSync(dayDir); } catch { stats.unreadableCount++; continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(dayDir, name);
      let st;
      try { st = lstatSync(path); } catch { stats.unreadableCount++; continue; }
      if (!st.isFile()) continue;
      const head = readCodexHead(path, st.size, st.mtimeMs);
      records.push({
        sessionId: sessionIdFromFileName(name),
        // Codex has no project directory: the cross-source project key is derived from the
        // working directory with the registry's own encoding, so a Codex session and a Claude
        // session in the same directory land in one project (lib/sources.js).
        projectDirName: projectDirNameFor(head.cwd),
        size: st.size,
        mtimeMs: st.mtimeMs,
        path,
      });
    }
  }
  return records;
}

// The YYYY / MM / DD nesting, `levels` deep. Only directories are descended into, and only real
// ones: a symlinked date directory is skipped rather than resolved.
function walkDateDirs(dir, levels, stats) {
  let names;
  try { names = readdirSync(dir); } catch (err) {
    if (err.code !== 'ENOENT') stats.unreadableCount++;
    return [];
  }
  const found = [];
  for (const name of names) {
    const path = join(dir, name);
    let st;
    try { st = lstatSync(path); } catch { stats.unreadableCount++; continue; }
    if (!st.isDirectory()) continue;
    if (levels > 1) found.push(...walkDateDirs(path, levels - 1, stats));
    else found.push(path);
  }
  return found;
}

// A project's display name is the last segment of the session's working directory. Without one
// there is nothing to name it after, so the derived project key stands in and says it is derived.
export function describeCodexProject(record, head) {
  const cwd = head?.cwd;
  if (cwd) return { name: basename(cwd) || cwd, path: cwd, derived: false };
  return { name: record.projectDirName, path: record.projectDirName, derived: true };
}

// -- Per-session usage -------------------------------------------------------------------

const statsMemo = createStatsMemo();

export function statsMemoSize() {
  return statsMemo.size();
}

// ADR-0006: both memos are bounded by what the scan can still see, so a deleted or renamed
// rollout stops holding memory.
export function pruneStatsMemo(livePaths) {
  statsMemo.prune(livePaths);
  const live = livePaths instanceof Set ? livePaths : new Set(livePaths);
  for (const path of headMemo.keys()) {
    if (!live.has(path)) headMemo.delete(path);
  }
}

// Codex counts cached input inside `input_tokens` (TokenUsage::non_cached_input subtracts
// `cached_input_tokens` from it), so the split's `input` is the non-cached remainder and the
// cache is never counted twice.
function tokensFrom(usage) {
  const tokens = EMPTY_TOKENS();
  if (!usage || typeof usage !== 'object') return tokens;
  const cacheRead = positive(usage.cached_input_tokens);
  tokens.input = Math.max(0, positive(usage.input_tokens) - cacheRead);
  tokens.cacheRead = cacheRead;
  tokens.cacheWrite = positive(usage.cache_write_input_tokens);
  tokens.output = positive(usage.output_tokens);
  return tokens;
}

const CALL_KINDS = new Set(['function_call', 'custom_tool_call', 'local_shell_call']);
const OUTPUT_KINDS = new Set(['function_call_output', 'custom_tool_call_output']);

// A tool call contributes exactly two short strings: the name shown in the tools table, and the
// call id that lets the matching output be attributed to it. `arguments` and `input` are not read.
function toolCallOf(payload) {
  const name = payload.type === 'local_shell_call' ? 'shell' : (str(payload.name) ?? 'unknown');
  return { name, callId: str(payload.call_id) };
}

// The only thing read off an output record besides its call id: FunctionCallOutputPayload carries
// an optional boolean `success`. Older rollouts serialise `output` as a bare string — the tool's
// text — which is never touched, and an output with no flag counts as a success.
function outputOk(payload) {
  const out = payload.output;
  if (out && typeof out === 'object' && typeof out.success === 'boolean') return out.success;
  return true;
}

function toolBucket(tools, name) {
  if (!tools[name]) tools[name] = { calls: 0, errors: 0 };
  return tools[name];
}

function modelBucket(stats, model) {
  if (!stats.models[model]) stats.models[model] = { turns: 0, tokens: EMPTY_TOKENS() };
  return stats.models[model];
}

function dayBucket(stats, ts) {
  if (ts === null) return null;
  const day = new Date(ts).toISOString().slice(0, 10);
  if (!stats.days[day]) stats.days[day] = { turns: 0, tokens: EMPTY_TOKENS(), byModel: {} };
  return stats.days[day];
}

function dayModelBucket(bucket, model) {
  if (!bucket.byModel[model]) bucket.byModel[model] = { turns: 0, tokens: EMPTY_TOKENS() };
  return bucket.byModel[model];
}

// The aggregates every page is built from, in the shape the source contract fixes.
//
// The mapping Codex needs, and why:
//   * a turn is one assistant `response_item` of type `message` (`role: "assistant"`), attributed
//     to the model the latest `turn_context` named;
//   * a prompt is an `event_msg` of type `user_message`. A user turn is persisted twice — once as
//     that event and once as a `response_item` message with `role: "user"` — so counting only the
//     event avoids double counting, and it also skips the synthetic user items (environment
//     context, instructions) that are not things a person typed;
//   * tokens come from each `token_count` event's `info.last_token_usage`, which is that
//     request's own delta rather than the running total, so summing them gives the session total;
//   * `compacts.count` counts `compacted` records. Codex records no before/after size with them,
//     so `preTokens`/`postTokens` stay 0;
//   * `tools[name].errors` counts outputs whose `success` flag is false. A rollout that writes no
//     flag therefore reports zero errors, which is the honest answer rather than a guess.
export function readCodexStats(path, size, mtimeMs) {
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
  // call_id -> tool name, only so a later output can be attributed. Dropped with the pass: it
  // never reaches the memo.
  const toolNames = new Map();
  let model = 'unknown';
  for (const line of parseLines(path)) {
    const record = parseRecord(line);
    if (!record) continue;
    const ts = recordTs(record);
    if (ts !== null) {
      if (stats.firstTs === null || ts < stats.firstTs) stats.firstTs = ts;
      if (stats.lastTs === null || ts > stats.lastTs) stats.lastTs = ts;
    }
    const payload = payloadOf(record);
    if (!payload) continue;
    if (record.type === 'turn_context') {
      model = str(payload.model) ?? model;
      continue;
    }
    if (record.type === 'compacted') {
      stats.compacts.count++;
      continue;
    }
    if (record.type === 'response_item') {
      if (payload.type === 'message' && payload.role === 'assistant') {
        stats.turns++;
        modelBucket(stats, model).turns++;
        const bucket = dayBucket(stats, ts);
        if (bucket) { bucket.turns++; dayModelBucket(bucket, model).turns++; }
        continue;
      }
      if (CALL_KINDS.has(payload.type)) {
        const { name, callId } = toolCallOf(payload);
        if (callId !== null) toolNames.set(callId, name);
        toolBucket(stats.tools, name).calls++;
        continue;
      }
      if (OUTPUT_KINDS.has(payload.type)) {
        // An output whose call id matches nothing seen in this pass — a truncated rollout — is
        // booked under `unknown` and counted as its own call, so the aggregates and the timeline
        // (which names it `unknown` too) agree.
        const id = callId(payload);
        const known = id === null ? undefined : toolNames.get(id);
        const bucket = toolBucket(stats.tools, known ?? 'unknown');
        if (known === undefined) bucket.calls++;
        if (outputOk(payload) === false) bucket.errors++;
      }
      continue;
    }
    if (record.type === 'event_msg') {
      if (payload.type === 'user_message') { stats.prompts++; continue; }
      if (payload.type !== 'token_count') continue;
      const tokens = tokensFrom(payload.info?.last_token_usage);
      addSplitTokens(stats.tokens, tokens);
      addSplitTokens(modelBucket(stats, model).tokens, tokens);
      const bucket = dayBucket(stats, ts);
      if (bucket) {
        addSplitTokens(bucket.tokens, tokens);
        addSplitTokens(dayModelBucket(bucket, model).tokens, tokens);
      }
    }
  }
  return statsMemo.set(key, stats);
}

// -- Ordered timeline --------------------------------------------------------------------

const timelineMemo = createTimelineMemo(8);

export function timelineMemoSize() {
  return timelineMemo.size();
}

// The same four event kinds Claude's timeline uses, with the same fields, so the session page
// renders a Codex session with no vendor branch anywhere above this module.
//
// A turn event is opened by an assistant message and carries the tool calls that follow it, plus
// the tokens of the next `token_count` event — Codex reports usage in its own record after the
// response rather than inside it. A tool call made in a turn that produced no assistant message
// has no turn event to hang on; it is still counted in the stats and still shows up here as its
// own `result` event, so nothing is silently lost.
export function readCodexTimeline(path, size, mtimeMs) {
  const key = memoKey(path, size, mtimeMs);
  const cached = timelineMemo.get(key);
  if (cached) return cached;
  const events = [];
  const toolNames = new Map();
  let model = 'unknown';
  let openTurn = null;
  for (const line of parseLines(path)) {
    const record = parseRecord(line);
    if (!record) continue;
    const ts = recordTs(record);
    const payload = payloadOf(record);
    if (!payload) continue;
    if (record.type === 'turn_context') {
      model = str(payload.model) ?? model;
      continue;
    }
    if (record.type === 'compacted') {
      // Codex compacts on its own when the context window fills, and records no sizes with it.
      events.push({ kind: 'compact', ts, trigger: 'auto', preTokens: 0, postTokens: 0 });
      openTurn = null;
      continue;
    }
    if (record.type === 'response_item') {
      if (payload.type === 'message' && payload.role === 'assistant') {
        openTurn = { kind: 'turn', ts, model, tokens: EMPTY_TOKENS(), tools: [] };
        events.push(openTurn);
        continue;
      }
      if (CALL_KINDS.has(payload.type)) {
        const { name, callId: id } = toolCallOf(payload);
        if (id !== null) toolNames.set(id, name);
        if (openTurn) openTurn.tools.push({ id, name });
        continue;
      }
      if (OUTPUT_KINDS.has(payload.type)) {
        const id = callId(payload);
        events.push({ kind: 'result', ts, name: (id === null ? undefined : toolNames.get(id)) ?? 'unknown', ok: outputOk(payload) });
      }
      continue;
    }
    if (record.type === 'event_msg') {
      if (payload.type === 'user_message') {
        events.push({ kind: 'prompt', ts });
        openTurn = null;
        continue;
      }
      if (payload.type !== 'token_count') continue;
      if (openTurn) addSplitTokens(openTurn.tokens, tokensFrom(payload.info?.last_token_usage));
    }
  }
  return timelineMemo.set(key, capTimeline(events));
}

// Codex keeps no side files next to a rollout: no subagent transcripts, no spilled tool results.
// The contract's shape is answered with its empty value rather than left undefined, so every page
// above reads one shape whichever source produced the session.
export function readCodexExtras() {
  return { subagents: {}, toolResults: { count: 0, bytes: 0 } };
}

export const codex = registerSource({
  id: 'codex',
  label: 'Codex CLI',
  home: codexHome,
  scan: (stats) => scanCodexSessions(sessionsDir(), stats),
  // The scan already read and cached every head; this is the cache hit that the contract's
  // (path) signature asks for.
  readHead: (path) => readCodexHead(path),
  describeProject: describeCodexProject,
  readStats: readCodexStats,
  readTimeline: readCodexTimeline,
  readExtras: readCodexExtras,
  pruneStatsMemo,
});
