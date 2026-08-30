import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, fixtureHome } from './helpers.js';

process.env.WATCH_INTERVAL_MS = '100';

const TARGET = join(fixtureHome, 'projects', '-Users-demo-notes',
  'ffffffff-6666-4666-8666-666666666666.jsonl');

let original, originalStat;
before(() => {
  original = readFileSync(TARGET, 'utf8');
  originalStat = statSync(TARGET);
});
after(() => {                                    // the fixture is committed; put it back byte and mtime
  writeFileSync(TARGET, original);
  utimesSync(TARGET, originalStat.atime, originalStat.mtime);
});

const srv = await startServer();
after(() => srv.close());

// Read one named SSE frame off the live stream, or give up after ms.
async function nextFrame(name, ms, trigger) {
  const controller = new AbortController();
  const res = await fetch(`${srv.base}/api/events`, { signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let triggered = false;
  const deadline = Date.now() + ms;

  try {
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise((r) => setTimeout(() => r({ value: undefined }), deadline - Date.now())),
      ]);
      if (chunk?.value) buffer += decoder.decode(chunk.value, { stream: true });

      // Only fire the append once the stream is open, otherwise the write races the priming pass.
      if (!triggered && buffer.includes('event: ready')) { triggered = true; await trigger(); }

      const marker = buffer.indexOf(`event: ${name}\ndata: `);
      if (marker !== -1) {
        const from = marker + `event: ${name}\ndata: `.length;
        const to = buffer.indexOf('\n\n', from);
        if (to !== -1) return JSON.parse(buffer.slice(from, to));
      }
    }
    return null;
  } finally {
    controller.abort();
  }
}

test('an append to a session file reaches an SSE subscriber within 3 seconds', async () => {
  const started = Date.now();
  const frame = await nextFrame('append', 3000, () => {
    appendFileSync(TARGET, JSON.stringify({
      type: 'user', sessionId: 'ffffffff-6666-4666-8666-666666666666',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'а тепер додай розділ про ризики' },
    }) + '\n');
  });

  assert.ok(frame, 'no append frame arrived within 3 s');
  assert.ok(Date.now() - started < 3000);
  assert.equal(frame.sessionId, 'ffffffff-6666-4666-8666-666666666666');
  assert.equal(frame.events[0].kind, 'prompt');
  assert.match(frame.events[0].label, /розділ про ризики/);
});

test('a half-written record is held back until its newline arrives', async () => {
  const { SessionWatcher } = await import('../lib/watch.js');
  const watcher = new SessionWatcher({ intervalMs: 50 }).prime();

  const seen = [];
  watcher.on('append', ({ events }) => seen.push(...events));

  appendFileSync(TARGET, '{"type":"user","message":{"role":"user","content":"partial');
  watcher.tick();
  assert.deepEqual(seen, [], 'a record without its newline must not be emitted');

  appendFileSync(TARGET, '"},"timestamp":"2026-08-23T09:00:00.000Z"}\n');
  watcher.tick();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].label, 'partial');
});

test('the live page lists sessions written to recently and loads its script from a file', async () => {
  appendFileSync(TARGET, JSON.stringify({
    type: 'user', timestamp: new Date().toISOString(),
    message: { role: 'user', content: 'свіжий запис' },
  }) + '\n');
  const html = await srv.text('/live');
  assert.match(html, /Weekly notes digest/);
  assert.match(html, /<script src="\/live\.js" defer><\/script>/);
  assert.doesNotMatch(html, /<script>[^<]/);   // CSP is script-src 'self': nothing inline
});

test('the live API respects the window and never reports a stale session as active', async () => {
  const { active } = await srv.json('/api/live?windowMs=1000');
  for (const s of active) {
    assert.ok(Date.now() - Date.parse(s.modifiedAt) <= 1000 + 500);
  }
});
