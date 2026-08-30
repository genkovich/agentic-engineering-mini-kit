import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { startServer, fixtureHome } from './helpers.js';

const srv = await startServer();
after(() => srv.close());

const P1 = join(fixtureHome, 'projects', '-Users-demo-sources-checkout-api');
const ERR_SESSION = 'bbbbbbbb-2222-4222-8222-222222222222';

// grep -c counts LINES, and one assistant record can hold several tool_use blocks on one line.
// The AC has to count OCCURRENCES, so: grep -o | wc -l.
function grepCount(file, needle) {
  const out = execFileSync('/bin/sh', ['-c', `grep -o '${needle}' "${file}" | wc -l`]);
  return Number(out.toString().trim());
}

test('tool event count equals the number of tool_use blocks on disk', async () => {
  const { timeline } = await srv.json(`/api/sessions/${ERR_SESSION}`);
  const fromApi = timeline.events.filter((e) => e.kind === 'tool').length;
  assert.equal(fromApi, grepCount(join(P1, `${ERR_SESSION}.jsonl`), '"type":"tool_use"'));
});

test('every tool_use is joined to its tool_result by tool_use_id', async () => {
  const { timeline } = await srv.json(`/api/sessions/${ERR_SESSION}`);
  assert.deepEqual(timeline.unmatchedToolCalls, []);
  for (const e of timeline.events.filter((x) => x.kind === 'tool')) {
    assert.ok(e.output !== null, `${e.name} has no joined output`);
    assert.ok(e.durationMs >= 0, `${e.name} has no duration`);
  }
});

test('a failed tool call is flagged, and carries the real error text', async () => {
  const { timeline } = await srv.json(`/api/sessions/${ERR_SESSION}`);
  const failed = timeline.events.filter((e) => e.kind === 'tool' && e.isError);
  assert.equal(failed.length, 1);
  assert.match(failed[0].output, /port 5432 already allocated/);
});

test('duration is labelled observed, never presented as time spent', async () => {
  const { timeline } = await srv.json(`/api/sessions/${ERR_SESSION}`);
  assert.equal(timeline.spanKind, 'observed');
  assert.equal(timeline.spanMs, 75_000);
  const html = await srv.text(`/sessions/${ERR_SESSION}`);
  assert.match(html, /Observed span/);
  assert.match(html, /not time anyone spent/);
});

test('a compaction boundary becomes its own event', async () => {
  const { timeline } = await srv.json('/api/sessions/eeeeeeee-5555-4555-8555-555555555555');
  const compact = timeline.events.find((e) => e.kind === 'compact');
  assert.ok(compact, 'compact_boundary must surface');
  assert.equal(compact.trigger, 'auto');
  assert.equal(compact.preTokens, 148_000);
});

test('the failed call renders as a red row', async () => {
  const html = await srv.text(`/sessions/${ERR_SESSION}`);
  assert.match(html, /class="ev tool err"/);
});

test('an unknown session id is a 404, not a crash', async () => {
  const res = await srv.get('/api/sessions/does-not-exist');
  assert.equal(res.status, 404);
});
