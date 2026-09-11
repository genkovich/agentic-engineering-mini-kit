// A static, dated price table (ADR-0007). No network, no dependency: the numbers live in the
// repo, carry the date they were true, and every sum built from them is an estimate.
//
// Prices are USD per million tokens, split by the usage kinds the journal reports:
// `input` (base input), `output`, `cacheRead` (cache hits and refreshes) and `cacheWrite`
// (the 5-minute cache write, the only write kind the journal distinguishes).
//
// Source: https://platform.claude.com/docs/en/about-claude/pricing, read 2026-09-11.
// Cache read is 0.1x base input on every model except Fable 5.1 and Mythos 5.1, where it is
// 0.025x; the 5-minute cache write is 1.25x base input everywhere.
export const PRICING = {
  asOf: '2026-09-11',
  perMillion: {
    'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
    'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
    'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    'claude-mythos-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    'claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    'claude-opus-4-1': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    'claude-opus-4': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
    'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    'claude-haiku-3-5': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  },
};

const DATED_SUFFIX = /-\d{8}$/;

// A journal can name a model by its plain id or by a dated snapshot of it. The exact key wins;
// otherwise a trailing `-YYYYMMDD` is stripped once and retried. Anything else has no price,
// and that is reported rather than papered over with a zero.
// `table` defaults to the repo's own price table; it is a parameter only so a caller (and a
// test) can price the same tokens against a different dated table without a second code path.
export function priceFor(model, table = PRICING.perMillion) {
  if (typeof model !== 'string' || !model) return null;
  const exact = table[model];
  if (exact) return exact;
  if (DATED_SUFFIX.test(model)) {
    const base = table[model.replace(DATED_SUFFIX, '')];
    if (base) return base;
  }
  return null;
}

const PER_MILLION = 1_000_000;

// `tokens` is the four-way split every stats object carries. An unpriced model costs 0 and says
// so with `priced: false`, so a caller can never mistake "no price" for "free".
export function estimateCost(tokens, model, table = PRICING.perMillion) {
  const price = priceFor(model, table);
  if (!price) return { usd: 0, priced: false };
  const t = tokens || {};
  const usd = ((t.input || 0) * price.input
    + (t.output || 0) * price.output
    + (t.cacheRead || 0) * price.cacheRead
    + (t.cacheWrite || 0) * price.cacheWrite) / PER_MILLION;
  return { usd, priced: true };
}

function hasTokens(tokens) {
  const t = tokens || {};
  return (t.input || 0) + (t.output || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0) > 0;
}

// `models` is the `stats.models` map: model name -> { turns, tokens }. The sum is only called
// priced when every model that actually spent tokens has a price; the rest are named so the
// page can say which models the estimate is missing.
export function estimateSessionCost(models, table = PRICING.perMillion) {
  let usd = 0;
  const unpriced = [];
  for (const [model, entry] of Object.entries(models || {})) {
    const tokens = entry && entry.tokens;
    const cost = estimateCost(tokens, model, table);
    if (cost.priced) { usd += cost.usd; continue; }
    if (hasTokens(tokens)) unpriced.push(model);
  }
  unpriced.sort();
  return { usd, priced: unpriced.length === 0, unpriced };
}
