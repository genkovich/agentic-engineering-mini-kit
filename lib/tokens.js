// The four-way token split every aggregate in the project is built out of, and the three ways
// it gets added up. Source-agnostic on purpose: nothing here knows what a session or a journal
// is, so both the Claude adapter and the source-independent analytics can share one copy.
//
// Two shapes meet here. `usage` is the wire shape a journal record carries
// (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`);
// the split is our own (`input`, `output`, `cacheRead`, `cacheWrite`). `addTokens` reads the
// first, `addSplitTokens` the second, and everything downstream of the journal reader speaks
// the split.

export const EMPTY_TOKENS = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

// From a journal record's `usage` object.
export function addTokens(target, usage) {
  const u = usage || {};
  target.input += u.input_tokens || 0;
  target.output += u.output_tokens || 0;
  target.cacheRead += u.cache_read_input_tokens || 0;
  target.cacheWrite += u.cache_creation_input_tokens || 0;
}

// From an already-split token object, without inventing a wire-shaped one to pass through.
export function addSplitTokens(target, tokens) {
  const t = tokens || {};
  target.input += t.input || 0;
  target.output += t.output || 0;
  target.cacheRead += t.cacheRead || 0;
  target.cacheWrite += t.cacheWrite || 0;
}

// Fold one `{ turns, tokens }` entry into a `stats.models`-shaped accumulator, so a whole group
// of sessions or days can be priced with a single estimateSessionCost() call.
export function intoModels(map, model, entry) {
  if (!map[model]) map[model] = { turns: 0, tokens: EMPTY_TOKENS() };
  map[model].turns += entry?.turns || 0;
  addSplitTokens(map[model].tokens, entry?.tokens);
  return map[model];
}
