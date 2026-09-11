// Step 4, `workspace`: the dashboard's own store (names, tags, notes, stars), the edit page,
// the tag and star filters, the JSON API and the CSV export.
//
// Everything runs against the synthetic fixtures; the store goes to a throwaway directory that
// test/helpers.js sets per run, and the two store tests move it again so they start from empty.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer, fixtureHome } from './helpers.js';
import { readStore, updateSession, readLabels, sessionsFile, labelsFile, normalizeTags } from '../lib/store.js';
import { toCsv } from '../lib/csv.js';

const SESSION_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const SESSION_C = 'cccccccc-3333-4333-8333-333333333333';
const SESSION_E = 'eeeeeeee-5555-4555-8555-555555555555';

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

// Runs `fn` against a store directory of its own, then puts the shared one back. The store is
// chosen per call through the environment, so this is the whole isolation mechanism.
function withStoreHome(fn) {
  const previous = process.env.AGENT_OPS_HOME;
  const home = mkdtempSync(join(tmpdir(), 'agent-ops-store-t22-'));
  process.env.AGENT_OPS_HOME = home;
  try {
    return fn(home);
  } finally {
    process.env.AGENT_OPS_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

/* ---- T22: the store ---------------------------------------------------------------------- */

test('T22: a home with only labels.json reads as entries, and the first write creates sessions.json beside it', () => {
  withStoreHome((home) => {
    writeFileSync(join(home, 'labels.json'), JSON.stringify({ [SESSION_A]: 'Postgres boot' }) + '\n');

    assert.deepEqual(readStore(), { [SESSION_A]: { label: 'Postgres boot' } },
      'the legacy file is read as a store of entries');
    assert.deepEqual(readLabels(), { [SESSION_A]: 'Postgres boot' },
      'readLabels stays a projection of the same store');
    assert.equal(existsSync(sessionsFile()), false, 'a read never writes the new file');

    updateSession(SESSION_A, { tags: 'bug, Bug, refactor' });

    assert.equal(existsSync(sessionsFile()), true, 'the first write creates sessions.json');
    assert.deepEqual(JSON.parse(readFileSync(sessionsFile(), 'utf8')), {
      [SESSION_A]: { label: 'Postgres boot', tags: ['bug', 'refactor'] },
    }, 'the migrated name survives the write and the tags are deduped case-insensitively');
    assert.deepEqual(JSON.parse(readFileSync(labelsFile(), 'utf8')), { [SESSION_A]: 'Postgres boot' },
      'labels.json is legacy and read-only: the write left it exactly as it was');
    assert.deepEqual(readdirSync(home).filter((n) => n.endsWith('.tmp')), [],
      'the temp file of the atomic write is renamed away, never left behind');
  });
});

test('T22: a corrupt store reads as empty, an emptied entry is removed, and the store is never inside CLAUDE_HOME', () => {
  withStoreHome((home) => {
    writeFileSync(sessionsFile(), '{ this is not json');
    assert.deepEqual(readStore(), {}, 'a corrupt file is an empty store, not a crash');

    // The damaged store must not fall back to the legacy file: those names are older than the
    // entry that got damaged, and the next write would persist them over tags, notes and stars
    // that were damaged rather than deleted.
    writeFileSync(labelsFile(), JSON.stringify({ [SESSION_A]: 'Stale legacy name' }) + '\n');
    assert.deepEqual(readStore(), {}, 'a corrupt sessions.json never resurrects labels.json');
    rmSync(labelsFile());

    updateSession(SESSION_A, { label: 'Kept', note: 'why this matters', starred: true });
    assert.deepEqual(readStore()[SESSION_A], { label: 'Kept', note: 'why this matters', starred: true });

    updateSession(SESSION_A, { label: '', note: '', starred: false });
    assert.deepEqual(readStore(), {}, 'an entry with nothing left in it is deleted, not kept empty');

    assert.ok(!sessionsFile().startsWith(fixtureHome), 'the store never lives inside the agent home');
    assert.ok(!labelsFile().startsWith(fixtureHome));
    assert.equal(home, process.env.AGENT_OPS_HOME);
  });
});

test('T22: tag normalisation trims, dedupes, caps the count and drops anything that is not a tag', () => {
  assert.deepEqual(normalizeTags(' bug ,  refactor '), ['bug', 'refactor']);
  assert.deepEqual(normalizeTags(['Bug', 'bug', 'BUG']), ['Bug'], 'first spelling wins');
  assert.deepEqual(normalizeTags('міграція_1 db-2'), ['міграція_1', 'db-2'], 'any script, plus _ and -');
  assert.deepEqual(normalizeTags('ok has space!'), ['ok', 'has'],
    'whitespace separates, and a token carrying punctuation is dropped');
  assert.deepEqual(normalizeTags(['x'.repeat(33)]), [], 'over 32 characters is not a tag');
  assert.equal(normalizeTags(Array.from({ length: 30 }, (_, i) => `t${i}`)).length, 10, 'at most 10 tags');
  assert.deepEqual(normalizeTags(42), []);
});

/* ---- T23: the edit page ------------------------------------------------------------------ */

test('T23: the edit page saves a name, tags, a note and a star, redirects back, and clears everything', async () => {
  const back = '/?limit=10';
  const form = await srv.text(`/sessions/${SESSION_C}/edit?back=${encodeURIComponent(back)}`);
  assert.match(form, /<h1>Edit this session<\/h1>/);
  assert.match(form, /<textarea id="note" name="note" rows="5" maxlength="2000"/);
  assert.match(form, /name="back" value="\/\?limit=10"/);
  assert.match(form, /placeholder="bug, refactor"/);
  assert.ok(!form.includes('style='), 'no inline style survives the CSP');

  const saved = await srv.post(`/sessions/${SESSION_C}/edit`, {
    form: 'edit',
    label: '  Cache   warmup ',
    tags: 'Bug, bug, refactor, not a tag!',
    note: '  first line\nsecond line  ',
    starred: '1',
    back,
  });
  assert.equal(saved.status, 303);
  assert.equal(saved.headers.get('location'), back);
  assert.deepEqual(readStore()[SESSION_C], {
    label: 'Cache warmup',
    tags: ['Bug', 'refactor', 'not', 'a'],
    note: 'first line\nsecond line',
    starred: true,
  });

  // Unchecking the star and emptying the tags is a real edit, not a missing field: the form
  // marker says all four fields are present.
  const cleared = await srv.post(`/sessions/${SESSION_C}/edit`, { form: 'edit', label: 'Cache warmup', tags: '', note: '', back });
  assert.equal(cleared.status, 303);
  assert.deepEqual(readStore()[SESSION_C], { label: 'Cache warmup' });

  const gone = await srv.post(`/sessions/${SESSION_C}/edit`, { clear: '1', back });
  assert.equal(gone.status, 303);
  assert.equal(readStore()[SESSION_C], undefined, '"Clear all" removes the entry entirely');
});

test('T23: /rename stays an alias: the page moves to /edit and the old POST still writes', async () => {
  const res = await fetch(`${srv.base}/sessions/${SESSION_C}/rename?back=%2F`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), `/sessions/${SESSION_C}/edit?back=%2F`);

  updateSession(SESSION_C, { tags: ['keepme'] });
  const saved = await srv.post(`/sessions/${SESSION_C}/rename`, { label: 'Old road', back: '/' });
  assert.equal(saved.status, 303);
  assert.deepEqual(readStore()[SESSION_C], { label: 'Old road', tags: ['keepme'] },
    'a POST without the form marker patches only the fields it sent');

  await srv.post(`/sessions/${SESSION_C}/edit`, { clear: '1', back: '/' });
  const missing = await srv.post('/sessions/00000000-0000-4000-8000-000000000000/edit', { form: 'edit', back: '/' });
  assert.equal(missing.status, 404);
});

/* ---- T24: tag and star filters ----------------------------------------------------------- */

test('T24: ?tag= and ?starred=1 narrow the list on the page and in the API, and chips link to the tag', async () => {
  await srv.post(`/sessions/${SESSION_A}/edit`, { form: 'edit', label: '', tags: 'bug', note: '', starred: '1', back: '/' });
  await srv.post(`/sessions/${SESSION_E}/edit`, { form: 'edit', label: '', tags: 'refactor', note: '', back: '/' });
  try {
    const page = await srv.text('/');
    assert.match(page, /<a class="chip chip-tag" href="\/\?tag=bug">bug<\/a>/, 'a tag is a chip that filters');
    assert.match(page, /<span class="starred" title="Starred">/);

    const tagged = await srv.text('/?tag=BUG');
    assert.match(tagged, new RegExp(SESSION_A), 'the tag match is case-insensitive');
    assert.ok(!tagged.includes(`href="/sessions/${SESSION_E}"`), 'a session with another tag is out');
    assert.match(tagged, /Tagged <strong>BUG<\/strong>\. <a href="\/">Clear tag<\/a>/);

    const starred = await srv.text('/?starred=1');
    assert.match(starred, new RegExp(SESSION_A));
    assert.ok(!starred.includes(`href="/sessions/${SESSION_E}"`), 'an unstarred session is out');
    assert.match(starred, /Starred only\./);
    assert.match(starred, /class="star-toggle" href="\/" aria-current="true"/);

    const none = await srv.text('/?tag=nosuchtag');
    assert.match(none, /class="empty"/, 'a tag nobody used is the filtered empty state, not a crash');

    const api = await srv.json('/api/sessions?tag=bug');
    assert.equal(api.sessions.length, 1);
    assert.equal(api.sessions[0].sessionId, SESSION_A);
    assert.deepEqual(api.sessions[0].tags, ['bug']);
    assert.equal(api.sessions[0].starred, true);

    const apiStarred = await srv.json('/api/sessions?starred=1');
    assert.deepEqual(apiStarred.sessions.map((s) => s.sessionId), [SESSION_A]);
    assert.equal((await srv.json('/api/sessions')).sessions.length > 1, true, 'without a filter the API lists them all');
  } finally {
    await srv.post(`/sessions/${SESSION_A}/edit`, { clear: '1', back: '/' });
    await srv.post(`/sessions/${SESSION_E}/edit`, { clear: '1', back: '/' });
  }
});

/* ---- T25: the JSON API ------------------------------------------------------------------- */

// Walks every key in a parsed JSON tree, carrying the path to it. The API's field list is a
// closed decision, so the test that guards it has to look at the whole document, not at the
// fields it expects — and the one legitimate `input` has to be exempted by where it is, not by
// what its value happens to look like.
function walkKeys(value, visit, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkKeys(item, visit, `${path}[${i}]`));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      visit(key, child, `${path}.${key}`, value);
      walkKeys(child, visit, `${path}.${key}`);
    }
  }
}

// Words that name a message body, a tool's arguments or a model's reasoning. None of them is a
// field the journal reader is allowed to open, so none may appear as a key anywhere.
const FORBIDDEN_KEYS = ['input', 'content', 'text', 'thinking', 'command', 'prompt'];
// The single exemption: a token split. Every object that may hold an `input` key sits under a
// key named `tokens` (the session, per-model and per-day splits) or `tokensByType` (the session
// page's analytics), and it must carry exactly these four counters and nothing else.
const TOKEN_KEYS = ['cacheRead', 'cacheWrite', 'input', 'output'];
const IS_TOKENS = /(^|\.)(tokens|tokensByType)$/;

test('T25: the API answers the documented shapes and a JSON 404', async () => {
  const list = await srv.get('/api/sessions?limit=2');
  assert.equal(list.status, 200);
  assert.match(list.headers.get('content-type'), /application\/json/);
  assert.equal(list.headers.get('cache-control'), 'no-store');
  const body = await list.json();
  assert.deepEqual(Object.keys(body).sort(), ['generatedAt', 'projects', 'sessions', 'totalFound', 'truncated']);
  assert.equal(body.sessions.length, 2);
  assert.equal(body.truncated, true);
  assert.ok(body.totalFound > 2);
  assert.deepEqual(Object.keys(body.sessions[0]).sort(), [
    'cwd', 'label', 'mtimeMs', 'name', 'note', 'projectDerived', 'projectDirName', 'projectName',
    'projectPath', 'sessionId', 'size', 'starred', 'stats', 'tags', 'title',
  ]);
  assert.deepEqual(Object.keys(body.projects[0]).sort(),
    ['count', 'derived', 'name', 'path', 'projectDirName', 'tokens', 'turns']);
  assert.match(body.generatedAt, /^\d{4}-\d{2}-\d{2}T/);

  const one = await srv.json(`/api/sessions/${SESSION_A}`);
  assert.equal(one.sessionId, SESSION_A);
  assert.equal(typeof one.timeline.total, 'number');
  assert.equal(one.timeline.capped, false);
  assert.ok(one.analytics.perModel.length >= 1);
  assert.equal(typeof one.extras.toolResults.count, 'number');

  const overview = await srv.json('/api/overview?days=30');
  assert.equal(overview.span, 30);
  assert.equal(typeof overview.totals.sessions, 'number');
  assert.match(overview.asOf, /^\d{4}-\d{2}-\d{2}$/);

  const missing = await srv.get('/api/sessions/00000000-0000-4000-8000-000000000000');
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await missing.json(), { error: 'not found' });
});

test('T25: no conversation text and no message-body key reaches the API', async () => {
  const res = await srv.get(`/api/sessions/${SESSION_A}`);
  const text = await res.text();

  // The fixture's own prompt and the command its Bash call ran. Neither is a field the reader is
  // allowed to open, so neither can appear in the response.
  assert.ok(!text.includes('Дивлюся тест'), 'a prompt from the journal never reaches the API');
  assert.ok(!text.includes('npm test -- idempotency'), 'a tool command never reaches the API');

  const offenders = [];
  const tokenObjects = [];
  walkKeys(JSON.parse(text), (key, child, path, parent) => {
    const parentPath = path.slice(0, path.length - key.length - 1);
    const exempt = IS_TOKENS.test(parentPath);
    if (exempt) tokenObjects.push([parentPath, parent]);
    if (FORBIDDEN_KEYS.includes(key) && !exempt) offenders.push(path);
  });
  assert.deepEqual(offenders, [], 'no message-body, tool-argument or reasoning key in the tree');

  // The exemption is only sound while a `tokens` object really is four counters. Assert that for
  // every one of them, so a field smuggled into a tokens object cannot ride the exemption.
  assert.ok(tokenObjects.length > 0, 'the response does carry token splits, so the walk saw them');
  for (const [path, obj] of tokenObjects) {
    assert.deepEqual(Object.keys(obj).sort(), TOKEN_KEYS, `${path} is a plain token split`);
    for (const value of Object.values(obj)) assert.equal(typeof value, 'number');
  }
});

/* ---- T26: CSV ---------------------------------------------------------------------------- */

test('T26: toCsv quotes only what RFC 4180 requires and ends every line with CRLF', () => {
  const csv = toCsv(
    [{ key: 'a', header: 'name' }, { key: 'b', header: 'n' }, { key: 'c', header: 'note' }],
    [
      { a: 'plain', b: 12, c: null },
      { a: 'has, comma', b: 0, c: 'say "hi"' },
      { a: 'two\nlines', b: -1, c: undefined },
    ],
  );
  assert.equal(csv, [
    'name,n,note',
    'plain,12,',
    '"has, comma",0,"say ""hi"""',
    '"two\nlines",-1,',
  ].join('\r\n') + '\r\n');
});

test('T26: /overview.csv downloads an allow-listed table and refuses anything else', async () => {
  for (const table of ['projects', 'models', 'tools', 'sessions']) {
    const res = await srv.get(`/overview.csv?table=${table}&days=90`);
    assert.equal(res.status, 200, `${table} is on the allow-list`);
    assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.equal(res.headers.get('content-disposition'), `attachment; filename="overview-${table}-90d.csv"`);
    const body = await res.text();
    assert.ok(body.endsWith('\r\n'), 'CRLF line ends');
    assert.ok(body.split('\r\n').length > 1, `${table} has a header row and at least one row`);
  }

  const projects = await srv.text('/overview.csv?table=projects');
  assert.match(projects.split('\r\n')[0], /^project,path,sessions,turns,output_tokens,est_cost_usd$/);
  const sessions = await srv.text('/overview.csv?table=sessions&days=90');
  assert.match(sessions.split('\r\n')[0], /^session_id,name,project,turns,output_tokens,est_cost_usd,duration_ms$/);
  assert.match(sessions, new RegExp(SESSION_A));

  const bad = await srv.get('/overview.csv?table=nope');
  assert.equal(bad.status, 400);
  assert.match(bad.headers.get('content-type'), /text\/plain/);
  assert.match(await bad.text(), /Unknown \?table=nope/);

  const page = await srv.text('/overview');
  assert.match(page, /<span class="api-links"><a href="\/overview\.csv\?table=projects">CSV<\/a><\/span>/);
  assert.match(page, /<a href="\/api\/overview\?">JSON<\/a>/);
});

test('T26: editing a session writes to the dashboard store and never to the agent home', async () => {
  const before = readdirSync(fixtureHome, { recursive: true }).sort();

  // The write path, not a no-op: a real edit, a real clear, and the pages that read them back.
  const saved = await srv.post(`/sessions/${SESSION_A}/edit`, {
    form: 'edit', label: 'Touched', tags: 'audit', note: 'written during a test', starred: '1', back: '/',
  });
  assert.equal(saved.status, 303);
  assert.deepEqual(readStore()[SESSION_A], {
    label: 'Touched', tags: ['audit'], note: 'written during a test', starred: true,
  });
  assert.match(await srv.text('/'), /Touched/, 'the dashboard reads the edit back');
  assert.equal((await srv.get(`/sessions/${SESSION_A}`)).status, 200);
  await srv.post(`/sessions/${SESSION_A}/edit`, { clear: '1', back: '/' });

  assert.deepEqual(readdirSync(fixtureHome, { recursive: true }).sort(), before,
    'not one entry of the agent home changed while the dashboard wrote');
  assert.ok(!sessionsFile().startsWith(fixtureHome), 'the store file is not inside the agent home');
  assert.ok(!labelsFile().startsWith(fixtureHome));
});
