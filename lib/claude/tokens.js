// S4 — token accounting.
//
// Where the numbers live: message.usage on records of type "assistant".
//   input_tokens                  fresh prompt tokens billed at full rate
//   output_tokens                 generated tokens
//   cache_read_input_tokens       prompt tokens served from cache
//   cache_creation_input_tokens   prompt tokens written into cache
//   output_tokens_details.thinking_tokens
//
// The trap that makes every naive total wrong: ONE API response is written as SEVERAL assistant
// records — one per content block — and each of them repeats the SAME usage object. Measured over
// 333 real session files: 39 734 assistant records carrying usage, 19 250 distinct message.id.
// Summing the records gives 60.7M output tokens; summing the responses gives 23.1M. A 2.63x
// overcount. So: deduplicate on message.id before adding anything up.
//
// What is NOT here: the context window. `model_context_window` does not exist in Claude Code
// records — grep the whole projects tree and every hit is prose inside somebody's prompt. Without
// the window size, "percent of context used" cannot be computed, so the dashboard says so.

import { readFileSync } from 'node:fs';
import { parseLines } from './parse.js';

export const EMPTY = {
  input: 0, output: 0, cacheRead: 0, cacheCreation: 0, thinking: 0,
};

export function addUsage(into, usage) {
  into.input += usage.input_tokens ?? 0;
  into.output += usage.output_tokens ?? 0;
  into.cacheRead += usage.cache_read_input_tokens ?? 0;
  into.cacheCreation += usage.cache_creation_input_tokens ?? 0;
  into.thinking += usage.output_tokens_details?.thinking_tokens ?? 0;
  return into;
}

// One entry per API response, in file order. Callers that want a total just fold this.
export function usageByResponse(records) {
  const seen = new Set();
  const responses = [];
  for (const r of records) {
    if (r?.type !== 'assistant') continue;
    const usage = r.message?.usage;
    if (!usage) continue;
    const key = r.message?.id ?? r.requestId ?? r.uuid;
    if (key != null && seen.has(key)) continue;   // same response, another content block
    if (key != null) seen.add(key);
    responses.push({ key, at: r.timestamp ?? null, model: r.message?.model ?? null, usage });
  }
  return responses;
}

export function tokenReport(records) {
  const responses = usageByResponse(records);
  const totals = { ...EMPTY };
  for (const r of responses) addUsage(totals, r.usage);

  const compactions = records
    .filter((r) => r?.type === 'system' && r.subtype === 'compact_boundary')
    .map((r) => ({
      at: r.timestamp ?? null,
      trigger: r.compactMetadata?.trigger ?? 'unknown',
      preTokens: r.compactMetadata?.preTokens ?? null,
      postTokens: r.compactMetadata?.postTokens ?? null,
    }));

  const assistantRecords = records.filter((r) => r?.type === 'assistant' && r.message?.usage).length;

  return {
    available: responses.length > 0,
    totals: responses.length > 0 ? totals : null,
    responses: responses.length,
    assistantRecords,
    // Kept visible on purpose: it is the size of the mistake the dashboard is not making.
    duplicateRecords: assistantRecords - responses.length,
    compactions,
    // Not derivable from the transcript. Anything claiming a percentage of context is guessing.
    contextWindow: null,
    contextWindowNote: 'not available — Claude Code records do not carry the model context window',
    series: responses.map((r) => ({
      at: r.at,
      ...addUsage({ ...EMPTY }, r.usage),
    })),
  };
}

export function tokenReportForFile(file) {
  return tokenReport([...parseLines(readFileSync(file, 'utf8'))]);
}
