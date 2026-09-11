// Step 3: the period overview, the dashboard's cost tile and the session-list orderings.
// `now` is injected everywhere a window is asserted, so the fixtures never age out of the tests.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSessions, readSessionStats, statsMemoSize, sortAndLimit } from '../lib/claude/index.js';
import { buildOverview, PERIOD_CHOICES_OVERVIEW } from '../lib/analytics.js';
import { renderOverview } from '../views/overview.js';
import { fixtureHome, startServer } from './helpers.js';

// Mid-September, about three weeks after the newest fixture session: inside a 30-day window,
// so nothing has to slide, and far enough that the previous 30 days are empty.
const NOW = Date.parse('2026-09-10T12:00:00Z');

const A = 'aaaaaaaa-1111-4111-8111-111111111111';
const F = 'ffffffff-6666-4666-8666-666666666666';

// Scoped to the Claude source: every window, total and cost asserted below describes the Claude
// fixtures, and the Codex fixtures sit inside the same window with models the price table does
// not know, which would move the numbers without testing anything new about the overview.
function overviewOf({ days = 30, project = '', source = 'claude' } = {}) {
  const result = listSessions({ limit: 1000, project, days, now: NOW, source });
  return { overview: buildOverview(result.sessions, result.projects, { now: NOW, days }), result };
}

const server = await startServer();
after(() => server.close());

test('T18: the 30-day window holds every fixture session and the period before it holds none', () => {
  const { overview } = overviewOf({ days: 30 });
  assert.equal(overview.span, 30);
  assert.equal(overview.granularity, 'day');
  assert.equal(overview.buckets.length, 30);
  assert.equal(overview.windowSlid, false);
  assert.equal(overview.window.start, '2026-08-12');
  assert.equal(overview.window.end, '2026-09-10');
  // The previous window is the same length, ending the day before this one starts.
  assert.equal(overview.prev.end, '2026-08-11');
  assert.equal(overview.prev.start, '2026-07-13');

  assert.equal(overview.totals.sessions, 6);
  assert.equal(overview.prevTotals.sessions, 0);
  assert.equal(overview.totals.activeDays, 4);
  // Nothing to compare against is null, not an invented "+100%".
  assert.equal(overview.delta.sessions.pct, null);
  assert.equal(overview.delta.sessions.abs, 6);
  assert.equal(overview.delta.cost.pct, null);
  assert.ok(overview.totals.cost.usd > 0);
  assert.equal(overview.totals.cost.priced, true);
});

test('T18: a year folds into 52 weekly buckets labelled by the Monday they open on', () => {
  const { overview } = overviewOf({ days: 365 });
  assert.equal(overview.granularity, 'week');
  assert.equal(overview.buckets.length, 52);
  for (const bucket of overview.buckets) {
    assert.match(bucket.label, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(bucket.label, bucket.start);
    assert.equal(new Date(`${bucket.label}T00:00:00Z`).getUTCDay(), 1, `${bucket.label} is not a Monday`);
  }
  // Still the same six sessions, just counted in weeks.
  assert.equal(overview.totals.sessions, 6);
  assert.deepEqual(PERIOD_CHOICES_OVERVIEW, [7, 30, 90, 365]);
});

test('T18: an unoffered ?days= on /overview falls back to 30 with a note', async () => {
  const html = await server.text('/overview?days=12');
  assert.match(html, /class="note"/);
  assert.match(html, /Invalid.*days/);
  // The fallback really is the 30-day window, not just the wording.
  assert.match(html, /12 Aug/);
});

test('T19: tools carry the sessions they were used in, models carry a priced cost, tops are ordered', () => {
  const { overview } = overviewOf({ days: 30 });

  const bash = overview.tools.find((t) => t.name === 'Bash');
  assert.ok(bash, 'Bash should appear in the tool table');
  // Bash is called in sessions aaaa, bbbb and cccc.
  assert.equal(bash.sessions, 3);
  assert.equal(bash.calls, 4);
  assert.equal(bash.errors, 1);
  assert.equal(bash.errorRate, 0.25);

  assert.equal(overview.models[0].model, 'claude-opus-5');
  assert.equal(overview.models[0].cost.priced, true);
  assert.equal(overview.models[0].priced, true);
  assert.ok(overview.models[0].cost.usd > 0);

  assert.ok(overview.topExpensive.length > 0 && overview.topExpensive.length <= 10);
  for (let i = 1; i < overview.topExpensive.length; i++) {
    assert.ok(overview.topExpensive[i - 1].cost.usd >= overview.topExpensive[i].cost.usd, 'topExpensive must fall');
  }
  for (let i = 1; i < overview.topLongest.length; i++) {
    assert.ok(overview.topLongest[i - 1].durationMs >= overview.topLongest[i].durationMs, 'topLongest must fall');
  }
});

test('T19: the top-10 entries link into their sessions on the rendered page', async () => {
  const { overview } = overviewOf({ days: 30 });
  const html = await server.text('/overview');
  for (const row of overview.topExpensive.slice(0, 3)) {
    assert.ok(html.includes(`href="/sessions/${row.sessionId}"`), `no link for ${row.sessionId}`);
  }
  assert.ok(html.includes(`href="/sessions/${overview.topLongest[0].sessionId}"`));
});

test('T20: /overview marks itself current, charts a year in 52 columns and scopes to one project', async () => {
  const plain = await server.text('/overview');
  assert.match(plain, /<a href="\/overview" aria-current="page">Overview<\/a>/);
  assert.match(plain, /estimate, prices as of 2026-09-11/);
  assert.doesNotMatch(plain, /style="/);

  const year = await server.text('/overview?days=365');
  // Two charts over the same buckets: cost per week and output tokens per week.
  const columns = year.match(/class="col"/g) ?? [];
  assert.equal(columns.length, 104);
  assert.equal((year.match(/data-chart="cost"/g) ?? []).length, 1);
  assert.equal((year.match(/data-chart="tokens"/g) ?? []).length, 1);

  const scoped = await server.text('/overview?project=-Users-demo-notes');
  assert.match(scoped, /class="sub scope"/);
  assert.match(scoped, /All projects/);
  const { overview } = overviewOf({ days: 30, project: '-Users-demo-notes' });
  assert.equal(overview.totals.sessions, 1);
  assert.equal(overview.projects.length, 1);
  assert.equal(overview.projects[0].projectDirName, '-Users-demo-notes');
});

test('T18: the overview aggregates every scoped session, not the newest ?limit of them', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-ops-scope-'));
  const projects = join(home, 'projects', '-tmp-scope');
  mkdirSync(projects, { recursive: true });
  const journal = (id) => JSON.stringify({
    type: 'assistant', timestamp: '2026-09-01T10:00:00Z',
    message: { id: `msg_${id}`, model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 10 } },
  });
  for (const id of ['one', 'two', 'three']) {
    writeFileSync(join(projects, `${id}.jsonl`), `${journal(id)}\n`);
  }

  const previous = process.env.CLAUDE_HOME;
  try {
    process.env.CLAUDE_HOME = home;
    // The list is cut to one row; the aggregates must still see all three journals. Scoped to
    // Claude, since the three journals under test are the ones this temporary home holds.
    const result = listSessions({ limit: 1, days: 30, now: NOW, source: 'claude' });
    assert.equal(result.sessions.length, 1, 'the list itself is limited');
    assert.equal(result.scoped.length, 3, 'scoped carries every session in the project scope');
    assert.equal(buildOverview(result.scoped, result.projects, { now: NOW, days: 30 }).totals.sessions, 3);
    // The bug this guards against: aggregating over the truncated list instead.
    assert.equal(buildOverview(result.sessions, result.projects, { now: NOW, days: 30 }).totals.sessions, 1);
    assert.equal(result.dashboard.total.sessions, 3, 'the dashboard was already counting all three');
  } finally {
    process.env.CLAUDE_HOME = previous ?? fixtureHome;
    rmSync(home, { recursive: true, force: true });
  }
});

// Two synthetic sessions, one in each 30-day window ending at NOW. buildOverview takes plain
// records, so this needs no disk and no server.
// NOW is 2026-09-10: the window is 12 Aug — 10 Sep, the one before it 13 Jul — 11 Aug.
function twoPeriodSessions(thisPeriodOutput, previousPeriodOutput) {
  const session = (id, day, output) => ({
    sessionId: id,
    projectDirName: '-tmp-delta',
    projectName: 'delta',
    projectPath: '/tmp/delta',
    projectDerived: false,
    name: id,
    mtimeMs: Date.parse(`${day}T10:00:00Z`),
    stats: {
      turns: 1,
      tokens: { input: 0, output, cacheRead: 0, cacheWrite: 0 },
      models: { 'claude-opus-5': { turns: 1, tokens: { input: 0, output, cacheRead: 0, cacheWrite: 0 } } },
      days: { [day]: { turns: 1, tokens: { input: 0, output, cacheRead: 0, cacheWrite: 0 },
        byModel: { 'claude-opus-5': { turns: 1, tokens: { input: 0, output, cacheRead: 0, cacheWrite: 0 } } } } },
      firstTs: Date.parse(`${day}T10:00:00Z`),
      lastTs: Date.parse(`${day}T10:05:00Z`),
      prompts: 1,
      tools: {},
      compacts: { count: 0, preTokens: 0, postTokens: 0 },
    },
  });
  return [
    session('in-window', '2026-09-01', thisPeriodOutput),
    session('before', '2026-07-20', previousPeriodOutput),
  ];
}

test('T20: a rising bill is marked as a regression, not as an improvement', () => {
  const overview = buildOverview(twoPeriodSessions(2000, 1000), [], { now: NOW, days: 30 });
  assert.ok(overview.delta.cost.pct > 0, 'this period should cost more than the one before');
  assert.ok(overview.delta.turns.pct === 0, 'turns are unchanged between the two periods');

  const html = renderOverview({ overview, state: { days: 30 }, asOf: '2026-09-11' });
  const tile = html.split('<div class="stat"').find((chunk) => chunk.includes('est. cost'));
  assert.ok(tile, 'the overview should carry an est. cost tile');
  // `.delta-up` is reserved for welcome changes; spending more is not one.
  assert.doesNotMatch(tile, /delta-up/);
  assert.match(tile, /class="delta delta-down">\+100%<\/span>/);

  // The activity tiles keep the plain convention: more turns is the up direction.
  const turns = html.split('<div class="stat"').find((chunk) => chunk.includes('assistant turns'));
  assert.match(turns, /class="delta">0%<\/span>/);
});

test('T20: a falling bill is the welcome direction', () => {
  const overview = buildOverview(twoPeriodSessions(1000, 2000), [], { now: NOW, days: 30 });
  assert.ok(overview.delta.cost.pct < 0);
  const html = renderOverview({ overview, state: { days: 30 }, asOf: '2026-09-11' });
  const tile = html.split('<div class="stat"').find((chunk) => chunk.includes('est. cost'));
  assert.match(tile, /class="delta delta-up">−50%<\/span>/);
});

test('T19: both top tables say their figures cover the whole session', async () => {
  const html = await server.text('/overview');
  const captions = html.match(/Whole-session figures for sessions active in this period/g) ?? [];
  assert.equal(captions.length, 2, 'the caption belongs under both top tables');
});

test('T21: the dashboard carries a labelled cost tile and the three orderings', async () => {
  const plain = await server.text('/');
  assert.match(plain, /est\. cost/);
  // The tile says out loud that the figure is an estimate from a dated table.
  assert.match(plain, /title="Estimate from the static price table, prices as of 2026-09-11[^"]*"/);

  const stats = (id) => {
    const s = listSessions({ limit: 1000, now: NOW }).sessions.find((x) => x.sessionId === id);
    return readSessionStats(s.path, s.size, s.mtimeMs);
  };
  const aOut = stats(A).tokens.output;
  const fOut = stats(F).tokens.output;
  assert.ok(aOut > fOut, 'the fixture assumption behind this ordering no longer holds');

  const byTokens = await server.text('/?sort=tokens');
  assert.ok(byTokens.indexOf(`href="/sessions/${A}"`) < byTokens.indexOf(`href="/sessions/${F}"`),
    'the session with more output tokens must come first');
  assert.match(byTokens, /<th class="num" aria-sort="descending"><a href="\/\?sort=tokens">Output tokens<\/a><\/th>/);
  // Only the active column claims an ordering.
  assert.equal((byTokens.match(/aria-sort=/g) ?? []).length, 1);

  const byCost = await server.text('/?sort=cost');
  assert.equal((byCost.match(/aria-sort=/g) ?? []).length, 1);
  assert.match(byCost, /aria-sort="descending"><a href="\/\?sort=cost">Est\. cost<\/a>/);

  const bad = await server.text('/?sort=nope');
  assert.match(bad, /class="note"/);
  assert.match(bad, /Invalid.*sort/);
  // The fallback is the time order, which writes no sort param at all.
  assert.match(bad, /<th class="num" aria-sort="descending"><a href="\/">Last activity<\/a><\/th>/);
});

test('T21: sortAndLimit keeps its newest-first default and orders by tokens and cost on request', () => {
  const { sessions } = listSessions({ limit: 1000, now: NOW });
  const ids = (sort) => sortAndLimit(sessions, { limit: 10, sort }).sessions.map((s) => s.sessionId);
  assert.deepEqual(ids('time'), sortAndLimit(sessions, { limit: 10 }).sessions.map((s) => s.sessionId));

  const byTokens = ids('tokens').map((id) => sessions.find((s) => s.sessionId === id).stats.tokens.output);
  for (let i = 1; i < byTokens.length; i++) assert.ok(byTokens[i - 1] >= byTokens[i]);

  const byCost = ids('cost').map((id) => sessions.find((s) => s.sessionId === id).cost.usd);
  for (let i = 1; i < byCost.length; i++) assert.ok(byCost[i - 1] >= byCost[i]);
});

test('T21: the stats memo evicts the keys of journals the scan no longer sees (ADR-0006)', () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-ops-memo-'));
  const projects = join(home, 'projects', '-tmp-memo');
  mkdirSync(projects, { recursive: true });
  const journal = (id, model) => JSON.stringify({
    type: 'assistant', timestamp: '2026-09-01T10:00:00Z',
    message: { id: `msg_${id}`, model, usage: { input_tokens: 1, output_tokens: 1 } },
  });
  writeFileSync(join(projects, 'one.jsonl'), `${journal('one', 'synthetic-memo-x')}\n`);
  writeFileSync(join(projects, 'two.jsonl'), `${journal('two', 'synthetic-memo-x')}\n`);

  const previous = process.env.CLAUDE_HOME;
  try {
    process.env.CLAUDE_HOME = home;
    listSessions({ limit: 10 });
    assert.equal(statsMemoSize(), 2, 'both journals should be memoised');

    rmSync(join(projects, 'two.jsonl'));
    listSessions({ limit: 10 });
    // The deleted journal's key is gone; the surviving one is still there.
    assert.equal(statsMemoSize(), 1);
  } finally {
    process.env.CLAUDE_HOME = previous ?? fixtureHome;
    rmSync(home, { recursive: true, force: true });
  }
  // The fixture tree repopulates the memo on the next read, so later suites are unaffected.
  listSessions({ limit: 10 });
  assert.ok(statsMemoSize() >= 6);
});
