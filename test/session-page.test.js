import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readSessionStats,
  readSessionTimeline,
  readSessionExtras,
  sessionAnalytics,
  getSession,
  timelineMemoSize,
  MAX_TIMELINE_EVENTS,
} from '../lib/claude/index.js';
import { PRICING, priceFor, estimateCost, estimateSessionCost } from '../lib/pricing.js';
import { fixtureHome, startServer } from './helpers.js';

const fixtureProjectsDir = join(fixtureHome, 'projects');
const checkoutApi = join(fixtureProjectsDir, '-Users-demo-sources-checkout-api');
const webShop = join(fixtureProjectsDir, '-Users-demo-sources-web-shop');

const SESSION_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const SESSION_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const SESSION_C = 'cccccccc-3333-4333-8333-333333333333';
const SESSION_E = 'eeeeeeee-5555-4555-8555-555555555555';

function timelineOf(dir, sessionId) {
  const path = join(dir, `${sessionId}.jsonl`);
  const st = statSync(path);
  return readSessionTimeline(path, st.size, st.mtimeMs);
}

function statsOf(dir, sessionId) {
  const path = join(dir, `${sessionId}.jsonl`);
  const st = statSync(path);
  return readSessionStats(path, st.size, st.mtimeMs);
}

test('T11: the timeline keeps journal order, names each tool call and marks a failed tool result', () => {
  const timeline = timelineOf(checkoutApi, SESSION_A);
  assert.equal(timeline.capped, false);
  assert.equal(timeline.total, timeline.events.length);
  assert.deepEqual(timeline.events.map((e) => e.kind), ['prompt', 'turn', 'result', 'turn', 'result', 'turn']);
  const turns = timeline.events.filter((e) => e.kind === 'turn');
  assert.equal(turns.length, 3, 'two records sharing one message id make a single turn event');
  assert.deepEqual(turns.map((t) => t.tools.map((tool) => tool.name)), [['Bash'], ['Edit'], []],
    'the tool call in the duplicated record is still attached to its turn');
  assert.deepEqual(turns.map((t) => t.model), ['claude-opus-5', 'claude-opus-5', 'claude-opus-5']);
  assert.equal(turns[0].tokens.output, 240);
  assert.deepEqual(timeline.events.filter((e) => e.kind === 'result').map((e) => [e.name, e.ok]),
    [['Bash', true], ['Edit', true]]);

  const failing = timelineOf(checkoutApi, SESSION_B);
  assert.deepEqual(failing.events.filter((e) => e.kind === 'result').map((e) => [e.name, e.ok]),
    [['Bash', false], ['Bash', true]], 'the first Bash result is the failed one');

  const compacted = timelineOf(webShop, SESSION_E);
  const compact = compacted.events.find((e) => e.kind === 'compact');
  assert.ok(compact, 'the compact boundary is an event of its own');
  assert.equal(compact.trigger, 'auto');
  assert.equal(compact.preTokens, 148000);
  assert.equal(compact.postTokens, 21000);
  assert.ok(compacted.events.indexOf(compact) > 0 && compacted.events.at(-1).kind === 'turn',
    'the compact sits between the turns it separates');
});

test('T12: the stats pass counts prompts, tool calls with their errors, compactions and per-day models', () => {
  const a = statsOf(checkoutApi, SESSION_A);
  assert.equal(a.prompts, 1, 'only a user record with a string content is a prompt');
  assert.deepEqual(a.tools, { Bash: { calls: 1, errors: 0 }, Edit: { calls: 1, errors: 0 } });
  assert.equal(a.turns, 3, 'the dedup by message id still holds');
  assert.deepEqual(Object.keys(a.days), ['2026-08-20']);
  assert.deepEqual(Object.keys(a.days['2026-08-20'].byModel), ['claude-opus-5']);
  assert.equal(a.days['2026-08-20'].byModel['claude-opus-5'].turns, 3);

  const b = statsOf(checkoutApi, SESSION_B);
  assert.deepEqual(b.tools, { Bash: { calls: 2, errors: 1 } });
  assert.equal(b.prompts, 1);

  const e = statsOf(webShop, SESSION_E);
  assert.deepEqual(e.compacts, { count: 1, preTokens: 148000, postTokens: 21000 });
  assert.equal(a.compacts.count, 0, 'a session without a boundary reports no compaction');
});

test('T13: extras count subagents by type and size the spilled tool results, zero when absent', () => {
  const extras = readSessionExtras(checkoutApi, SESSION_C);
  assert.deepEqual(extras.subagents, { Explore: 1 });
  assert.equal(extras.toolResults.count, 1);
  assert.ok(extras.toolResults.bytes > 0, 'the tool result is sized from disk, never opened');

  const none = readSessionExtras(checkoutApi, SESSION_A);
  assert.deepEqual(none, { subagents: {}, toolResults: { count: 0, bytes: 0 } });
});

test('T14: pricing resolves known, dated and unknown models, and flags a partial sum', () => {
  const known = 'claude-opus-5';
  assert.ok(PRICING.perMillion[known], 'the price table carries the fixture model');
  assert.match(PRICING.asOf, /^\d{4}-\d{2}-\d{2}$/);

  const tokens = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 };
  const price = PRICING.perMillion[known];
  const priced = estimateCost(tokens, known);
  assert.equal(priced.priced, true);
  assert.equal(priced.usd, price.input + price.output);

  const unknown = estimateCost(tokens, 'some-other-vendor-model');
  assert.deepEqual(unknown, { usd: 0, priced: false }, 'an unknown model costs zero and says so');

  assert.equal(priceFor(`${known}-20260901`), price, 'a dated snapshot falls back to its base model');
  assert.equal(priceFor('unknown-model-20260901'), null);
  assert.equal(priceFor(''), null);

  const partial = estimateSessionCost({
    [known]: { turns: 1, tokens },
    'some-other-vendor-model': { turns: 1, tokens },
  });
  assert.equal(partial.priced, false, 'one unpriced model makes the whole sum incomplete');
  assert.deepEqual(partial.unpriced, ['some-other-vendor-model']);
  assert.equal(partial.usd, price.input + price.output, 'the priced part is still summed');

  const complete = estimateSessionCost({ [known]: { turns: 1, tokens } });
  assert.deepEqual(complete, { usd: price.input + price.output, priced: true, unpriced: [] });
});

test('T14: a session carries its analytics, with cost, tool shares and turn buckets', () => {
  const session = getSession(SESSION_B);
  assert.ok(session, 'the fixture session is found without enriching the others');
  assert.equal(session.sessionId, SESSION_B);
  const { analytics } = session;
  assert.deepEqual(analytics.tokensByType, session.stats.tokens);
  assert.deepEqual(analytics.perModel.map((m) => m.model), ['claude-opus-5']);
  assert.equal(analytics.perModel[0].cost.priced, true);
  assert.deepEqual(analytics.toolsTop, [{ name: 'Bash', calls: 2, errors: 1, errorShare: 0.5 }]);
  assert.equal(analytics.turnBuckets.length, 2, 'under 60 turns each turn is its own bucket');
  assert.deepEqual(analytics.turnBuckets.map((b) => b.label), ['#1', '#2']);
  assert.deepEqual(analytics.turnBuckets.map((b) => b.index), [0, 1]);
  assert.equal(analytics.durationMs, Date.parse('2026-08-21T14:11:15.000Z') - Date.parse('2026-08-21T14:10:00.000Z'));
  assert.equal(analytics.cost.priced, true);
  assert.equal(getSession('no-such-session'), null);
  assert.equal(getSession('not a valid id'), null, 'an id that cannot name a session file is rejected');
});

// The synthetic journal below is generated, never a real transcript: every text field is a
// placeholder, and the model name is made up so it can never collide with the price table.
function writeSyntheticJournal(dir, name, promptCount) {
  const lines = [];
  const at = (i) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
  let turns = 0;
  let prompts = 0;
  for (let i = 0; i < promptCount; i++) {
    lines.push(JSON.stringify({ type: 'user', timestamp: at(i * 3), message: { role: 'user', content: 'x' } }));
    prompts++;
    if (lines.length >= 1000) break;
    turns++;
    lines.push(JSON.stringify({
      type: 'assistant',
      timestamp: at(i * 3 + 1),
      message: {
        id: `msg_synth_${i}`,
        role: 'assistant',
        model: 'synthetic-model-x',
        content: [{ type: 'tool_use', id: `toolu_synth_${i}`, name: 'Xtool', input: { arg: 'x' } }],
        usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
      },
    }));
    if (lines.length >= 1000) break;
    lines.push(JSON.stringify({
      type: 'user',
      timestamp: at(i * 3 + 2),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_synth_${i}`, is_error: false, content: 'x' }] },
    }));
    if (lines.length >= 1000) break;
  }
  const path = join(dir, name);
  writeFileSync(path, `${lines.join('\n')}\n`);
  return { path, events: lines.length, turns, prompts };
}

test('T17: a long journal keeps only the tail of its timeline, while the stats stay complete', () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-page-t17-'));
  const journal = writeSyntheticJournal(dir, 'long.jsonl', 400);
  assert.equal(journal.events, 1000, 'the synthetic journal holds a thousand events');
  const st = statSync(journal.path);

  const timeline = readSessionTimeline(journal.path, st.size, st.mtimeMs);
  assert.ok(timeline.events.length <= MAX_TIMELINE_EVENTS);
  assert.equal(timeline.events.length, MAX_TIMELINE_EVENTS);
  assert.equal(timeline.capped, true);
  assert.equal(timeline.total, journal.events);

  const stats = readSessionStats(journal.path, st.size, st.mtimeMs);
  assert.equal(stats.turns, journal.turns, 'the aggregates cover the whole session, not the tail');
  assert.equal(stats.prompts, journal.prompts);
  assert.equal(stats.tools.Xtool.calls, journal.turns);
  assert.equal(stats.tokens.output, journal.turns * 2);

  const analytics = sessionAnalytics(stats, timeline);
  assert.equal(analytics.cost.priced, false, 'a made-up model has no price');
  assert.deepEqual(analytics.cost.unpriced, ['synthetic-model-x']);
  const bucketed = analytics.turnBuckets.reduce((n, b) => n + b.turns, 0);
  assert.equal(bucketed, timeline.events.filter((e) => e.kind === 'turn').length);
  assert.ok(analytics.turnBuckets.length <= 60, 'the bucket size keeps the small chart bounded');

  for (let i = 0; i < 10; i++) {
    const extra = writeSyntheticJournal(dir, `memo-${i}.jsonl`, 3);
    const extraStat = statSync(extra.path);
    readSessionTimeline(extra.path, extraStat.size, extraStat.mtimeMs);
  }
  assert.ok(timelineMemoSize() <= 8, `the timeline memo evicts down to eight, saw ${timelineMemoSize()}`);
});

test('T12: a tool result whose tool_use_id matches nothing is booked under unknown, not dropped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-page-orphan-'));
  const path = join(dir, 'orphan.jsonl');
  writeFileSync(path, `${[
    JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'x' } }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_never_seen', is_error: true, content: 'x' }] },
    }),
  ].join('\n')}\n`);
  const st = statSync(path);

  const stats = readSessionStats(path, st.size, st.mtimeMs);
  assert.deepEqual(stats.tools.unknown, { calls: 1, errors: 1 },
    'the orphaned failure is counted, so toolsTop cannot disagree with the timeline');

  const timeline = readSessionTimeline(path, st.size, st.mtimeMs);
  const result = timeline.events.find((e) => e.kind === 'result');
  assert.ok(result, 'the orphaned result is still an event');
  assert.equal(result.name, 'unknown');
  assert.equal(result.ok, false);
});

/* ---- the pages ------------------------------------------------------------------------- */

// One server for the page tests in this file; node:test tears it down after the last one.
const srv = await startServer();
test.after(() => srv.close());

test('T15: the session page shows the head, the resume command and a labelled cost estimate', async () => {
  const res = await srv.get(`/sessions/${SESSION_A}`);
  assert.equal(res.status, 200);
  const html = await res.text();

  assert.match(html, /<h1>Idempotency key test fix<\/h1>/, 'the journal title is the page heading');
  assert.match(html, new RegExp(`claude --resume ${SESSION_A}`), 'the resume command names this session');
  assert.match(html, /class="resume"/);
  assert.match(html, new RegExp(`href="/projects/-Users-demo-sources-checkout-api"`), 'the project links to its page');
  assert.match(html, new RegExp(`/sessions/${SESSION_A}/rename\\?back=`), 'Edit returns to this page');
  assert.match(html, /estimate, prices as of 2026-09-11/, 'the cost is labelled an estimate and dated');
  assert.match(html, /class="cost-note"/);
  assert.match(html, /<ol class="timeline">/);
  assert.match(html, /class="tl-row tl-kind-prompt"/);
  assert.match(html, /class="chip chip-ok">ok</);
  assert.match(html, /class="tl-row tl-kind-turn"/);

  // The journal's own words never reach a page: not the prompt, not a tool's command line.
  assert.ok(!html.includes('Дивлюся тест'), 'no prompt text on the page');
  assert.ok(!html.includes('npm test -- idempotency'), 'no tool input on the page');
  assert.ok(!html.includes('style="'), 'the CSP forbids inline styles');
});

test('T15: a failed tool result is chipped, a compaction shows pre and post tokens', async () => {
  const bad = await srv.text(`/sessions/${SESSION_B}`);
  assert.match(bad, /class="chip chip-bad">error</, 'the failed Bash result is marked');

  const compacted = await srv.text(`/sessions/${SESSION_E}`);
  assert.match(compacted, /class="tl-row tl-kind-compact"/);
  assert.match(compacted, /148K → 21K tokens/, 'the compaction shows pre → post');
});

test('T15: an unknown id and a traversal attempt are 404 pages, not stack traces', async () => {
  // A bare ".." never survives fetch(), which normalises the URL before it is sent; an encoded
  // separator does, and that is the shape a crafted request would take.
  assert.equal(getSession('..'), null, 'the id validator rejects a traversal before any disk work');
  for (const path of ['/sessions/99999999-0000-4000-8000-000000000000', '/sessions/a%2f..%2f..%2fetc']) {
    const res = await srv.get(path);
    assert.equal(res.status, 404, `${path} is not found`);
    const html = await res.text();
    assert.match(html, /<h1>Session not found<\/h1>/);
    assert.ok(!html.includes('at Object.'), 'no stack trace on the page');
  }
});

test('T16: the project page is scoped, keeps its base in every link and drops the project select', async () => {
  const dir = '-Users-demo-sources-checkout-api';
  const res = await srv.get(`/projects/${dir}`);
  assert.equal(res.status, 200);
  const html = await res.text();

  assert.match(html, /<h1><span class="mark mark-0"><\/span>checkout-api<\/h1>/, 'the project names itself');
  assert.match(html, /Totals for the last 30 days"[\s\S]*?<span class="stat-value">3<\/span>/,
    'the stat strip counts this project only, not all six sessions');

  // The toolbar belongs to a page that is already scoped.
  assert.ok(!html.includes('<select name="project"'), 'no project select on a project page');
  assert.match(html, new RegExp(`<form class="search" method="get" action="/projects/${dir}"`),
    'the search form posts back to this project page');
  assert.match(html, new RegExp(`href="/projects/${dir}\\?days=7"`), 'the period switch keeps the base');
  assert.match(html, new RegExp(`href="/projects/${dir}\\?limit=10"`), 'the limit switch keeps the base');
  assert.ok(!/href="[^"]*\?[^"]*project=/.test(html), 'a scoped page never writes ?project= into a link');

  // Rows lead to the sessions themselves.
  assert.match(html, new RegExp(`href="/sessions/${SESSION_A}"`));
  assert.ok(!html.includes(`href="/sessions/${'dddddddd-4444-4444-8444-444444444444'}"`),
    'a session from another project is not listed');
});

test('T16: an unknown project directory is a 404 page and the dashboard links into the pages', async () => {
  for (const path of ['/projects/nope', '/projects/a%2f..%2f..%2fetc']) {
    const res = await srv.get(path);
    assert.equal(res.status, 404, `${path} is not found`);
    assert.match(await res.text(), /<h1>Project not found<\/h1>/);
  }

  const index = await srv.text('/');
  assert.match(index, /href="\/projects\/-Users-demo-sources-checkout-api"/,
    'the projects table and the session rows link to the project page');
  assert.match(index, /class="legend-item" href="\/\?project=/,
    'the chart legend keeps the in-place filter');
});
