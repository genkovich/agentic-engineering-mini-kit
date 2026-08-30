import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { startServer, fixtureHome } from './helpers.js';

const srv = await startServer();
after(() => srv.close());

const WITH_TOKENS = 'aaaaaaaa-1111-4111-8111-111111111111';
const NO_TOKENS = 'dddddddd-4444-4444-8444-444444444444';
const FILE = join(fixtureHome, 'projects', '-Users-demo-sources-checkout-api', `${WITH_TOKENS}.jsonl`);

// Ground truth straight off disk. `unique_by(.message.id)` is not decoration: one API response is
// written as several assistant records that all repeat the same usage object.
function jqSum(field) {
  const filter = `[inputs | select(.type=="assistant") | select(.message.usage)] `
    + `| unique_by(.message.id) | map(.message.usage.${field} // 0) | add`;
  const out = execFileSync('/bin/sh', ['-c', `jq -n -c '${filter}' < "${FILE}"`]);
  return Number(out.toString().trim());
}

test('API totals equal the deduplicated jq totals', async () => {
  const { tokens } = await srv.json(`/api/sessions/${WITH_TOKENS}`);
  assert.equal(tokens.totals.input, jqSum('input_tokens'));
  assert.equal(tokens.totals.output, jqSum('output_tokens'));
  assert.equal(tokens.totals.cacheRead, jqSum('cache_read_input_tokens'));
  assert.equal(tokens.totals.cacheCreation, jqSum('cache_creation_input_tokens'));
  assert.equal(tokens.totals.thinking, jqSum('output_tokens_details.thinking_tokens'));
});

test('summing assistant records instead of responses would overcount', async () => {
  const { tokens } = await srv.json(`/api/sessions/${WITH_TOKENS}`);
  const naive = Number(execFileSync('/bin/sh', ['-c',
    `jq -n -c '[inputs | select(.type=="assistant") | .message.usage.output_tokens // 0] | add' < "${FILE}"`])
    .toString().trim());
  assert.ok(naive > tokens.totals.output, 'the fixture must contain a repeated message.id');
  assert.equal(tokens.duplicateRecords, tokens.assistantRecords - tokens.responses);
  assert.ok(tokens.duplicateRecords > 0);
});

test('the context window is reported as not available, never as a number', async () => {
  const { tokens } = await srv.json(`/api/sessions/${WITH_TOKENS}`);
  assert.equal(tokens.contextWindow, null);
  assert.match(tokens.contextWindowNote, /not available/);
  const html = await srv.text(`/sessions/${WITH_TOKENS}`);
  assert.match(html, /context window/);
  assert.match(html, /not available/);
});

test('model_context_window is not a field any Claude Code record carries', () => {
  const hits = execFileSync('/bin/sh', ['-c',
    `grep -l '"model_context_window"' "${fixtureHome}/projects"/*/*.jsonl 2>/dev/null | wc -l`]);
  assert.equal(Number(hits.toString().trim()), 0);
});

test('a session with no usage says not available rather than zero', async () => {
  const { tokens } = await srv.json(`/api/sessions/${NO_TOKENS}`);
  assert.equal(tokens.available, false);
  assert.equal(tokens.totals, null);
  const html = await srv.text(`/sessions/${NO_TOKENS}`);
  assert.match(html, /not available/);
  assert.match(html, /empty answer, not a zero/);
});

test('compaction markers are reported with their pre and post token counts', async () => {
  const { tokens } = await srv.json('/api/sessions/eeeeeeee-5555-4555-8555-555555555555');
  assert.equal(tokens.compactions.length, 1);
  assert.equal(tokens.compactions[0].preTokens, 148_000);
  assert.equal(tokens.compactions[0].postTokens, 21_000);
});

test('the chart is inline SVG with one rect per series value, no client script', async () => {
  const html = await srv.text(`/sessions/${WITH_TOKENS}`);
  assert.match(html, /<svg viewBox=/);
  assert.ok((html.match(/<rect /g) ?? []).length >= 4);
  assert.doesNotMatch(html, /<script/);
});
