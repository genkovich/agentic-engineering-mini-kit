import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { startServer, fixtureHome } from './helpers.js';

const srv = await startServer();
after(() => srv.close());

const sh = (cmd) => execFileSync('/bin/sh', ['-c', cmd]).toString().trim();
const PROJECTS = `${fixtureHome}/projects`;

test('sessions per day sums to the whole index, nothing bucketed twice', async () => {
  const stats = await srv.json('/api/analytics');
  const summed = stats.sessionsPerDay.reduce((a, d) => a + d.sessions, 0);
  assert.equal(summed, stats.totalSessions);
  assert.equal(summed, Number(sh(
    `find "${PROJECTS}" -mindepth 2 -maxdepth 2 -name '*.jsonl' -type f | wc -l`)));
});

test('top tool counts equal a direct recount of tool_use blocks on disk', async () => {
  const stats = await srv.json('/api/analytics');
  const fromApi = stats.topTools.reduce((a, t) => a + t.calls, 0);
  const onDisk = Number(sh(
    `cat "${PROJECTS}"/*/*.jsonl | grep -o '"type":"tool_use"' | wc -l`));
  assert.equal(fromApi, onDisk);
});

test('the top tool is the one that actually appears most on disk', async () => {
  const stats = await srv.json('/api/analytics');
  const onDisk = Number(sh(
    `cat "${PROJECTS}"/*/*.jsonl | grep -o '"type":"tool_use","id":"[^"]*","name":"Bash"' | wc -l`));
  assert.equal(stats.topTools[0].name, 'Bash');
  assert.equal(stats.topTools[0].calls, onDisk);
});

test('failed tool calls match the on-disk count of is_error', async () => {
  const stats = await srv.json('/api/analytics');
  assert.equal(stats.toolErrors, Number(sh(
    `cat "${PROJECTS}"/*/*.jsonl | grep -o '"is_error":true' | wc -l`)));
});

test('tokens per day match a deduplicated jq recount across every file', async () => {
  const stats = await srv.json('/api/analytics');
  const fromApi = stats.tokensPerDay.reduce((a, d) => a + d.output, 0);
  const onDisk = Number(sh(
    `cat "${PROJECTS}"/*/*.jsonl | jq -n -c '[inputs | select(.type=="assistant") `
    + `| select(.message.usage)] | unique_by(.message.id) `
    + `| map(.message.usage.output_tokens // 0) | add'`));
  assert.equal(fromApi, onDisk);
});

test('the response states its own coverage instead of implying it read everything', async () => {
  const stats = await srv.json('/api/analytics?scan=2');
  assert.equal(stats.scanned, 2);
  assert.equal(stats.skipped, stats.totalSessions - 2);
  assert.equal(stats.sessionsPerDay.reduce((a, d) => a + d.sessions, 0), stats.totalSessions);
  const html = await srv.text('/analytics?scan=2');
  assert.match(html, /older ones were not opened/);
});

test('the analytics page renders charts as inline SVG', async () => {
  const html = await srv.text('/analytics');
  assert.match(html, /Sessions per day/);
  assert.match(html, /Tokens per day/);
  assert.match(html, /Top tools/);
  assert.ok((html.match(/<svg /g) ?? []).length >= 3);
});
