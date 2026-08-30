#!/usr/bin/env node
// Builds fixtures/claude-home/projects/ — a tiny synthetic copy of the ~/.claude layout.
// Everything the verify suite asserts lives here, so the suite never touches real sessions.
//
// Deliberate properties, one per slice:
//   S1  noise dirs: <sessionId>/tool-results/*.txt and <sessionId>/subagents/*.jsonl
//   S2  one session WITH ai-title, one WITHOUT (fallback path)
//   S3  one tool_result with is_error:true
//   S4  one session with zero message.usage (the "not available" path)
//   S5  a dedicated append target
//   S6  sessions spread over three calendar days

import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'claude-home', 'projects');
rmSync(root, { recursive: true, force: true });

let uuidSeq = 0;
const uuid = () => `0000${String(++uuidSeq).padStart(4, '0')}-1111-4222-8333-444455556666`;

// mtime is pinned to the session's last timestamp: the index sorts on it, and S6 buckets by day.
const write = (relPath, lines) => {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const stamps = lines.map((l) => l.timestamp).filter(Boolean).sort();
  if (stamps.length) {
    const last = new Date(stamps[stamps.length - 1]);
    utimesSync(full, last, last);
  }
};

const usage = (input, output, cacheRead, cacheCreate, thinking) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheCreate,
  service_tier: 'standard',
  output_tokens_details: { thinking_tokens: thinking },
});

const user = (sessionId, cwd, ts, content) => ({
  type: 'user', uuid: uuid(), parentUuid: null, sessionId, cwd,
  timestamp: ts, message: { role: 'user', content },
});

// One API response is written as SEVERAL assistant records — one per content block — and every one
// of them repeats the SAME message.usage. Summing usage over assistant rows without deduplicating
// on message.id overcounts by 2.63x on the real corpus. msgId lets a fixture reproduce that.
let msgSeq = 0;
const assistant = (sessionId, cwd, ts, content, u, msgId) => ({
  type: 'assistant', uuid: uuid(), parentUuid: null, sessionId, cwd, timestamp: ts,
  requestId: `req_fixture_${msgSeq}`,
  message: { id: msgId ?? `msg_fixture_${++msgSeq}`, role: 'assistant', model: 'claude-opus-5', content, usage: u },
});

const aiTitle = (sessionId, title) => ({ type: 'ai-title', aiTitle: title, sessionId });

// ---------------------------------------------------------------- project 1
const P1 = '-Users-demo-sources-checkout-api';
const CWD1 = '/Users/demo/sources/checkout-api';

// S-01: has ai-title, has usage, clean tool call
const S1ID = 'aaaaaaaa-1111-4111-8111-111111111111';
write(`${P1}/${S1ID}.jsonl`, [
  { type: 'last-prompt', content: 'ignored bookkeeping record' },
  user(S1ID, CWD1, '2026-08-20T09:00:00.000Z', 'Полагодь падаючий тест на idempotency ключі'),
  aiTitle(S1ID, 'Idempotency key test fix'),
  assistant(S1ID, CWD1, '2026-08-20T09:00:04.000Z', [
    { type: 'text', text: 'Дивлюся тест.' },
    { type: 'tool_use', id: 'toolu_s1_a', name: 'Bash', input: { command: 'npm test -- idempotency' } },
  ], usage(120, 240, 18000, 4200, 0)),
  user(S1ID, CWD1, '2026-08-20T09:00:19.000Z', [
    { type: 'tool_result', tool_use_id: 'toolu_s1_a', is_error: false, content: '1 failing: expected 409, got 500' },
  ]),
  // Same response, two records, one message.id. Counted once.
  assistant(S1ID, CWD1, '2026-08-20T09:01:02.000Z', [
    { type: 'text', text: 'Причина у відсутньому unique constraint. Правлю міграцію.' },
  ], usage(90, 610, 22400, 0, 480), 'msg_fixture_dup'),
  assistant(S1ID, CWD1, '2026-08-20T09:01:02.000Z', [
    { type: 'tool_use', id: 'toolu_s1_b', name: 'Edit', input: { file_path: '/Users/demo/sources/checkout-api/store.js' } },
  ], usage(90, 610, 22400, 0, 480), 'msg_fixture_dup'),
  user(S1ID, CWD1, '2026-08-20T09:01:11.000Z', [
    { type: 'tool_result', tool_use_id: 'toolu_s1_b', is_error: false, content: 'Edit applied to store.js' },
  ]),
  assistant(S1ID, CWD1, '2026-08-20T09:02:30.000Z', [
    { type: 'text', text: 'Тест зелений.' },
  ], usage(40, 95, 23100, 0, 0)),
]);

// S-02: NO ai-title (S2 fallback) + is_error:true tool_result (S3 red row)
const S2ID = 'bbbbbbbb-2222-4222-8222-222222222222';
write(`${P1}/${S2ID}.jsonl`, [
  user(S2ID, CWD1, '2026-08-21T14:10:00.000Z', 'Підніми локальний postgres і прогони міграції'),
  assistant(S2ID, CWD1, '2026-08-21T14:10:06.000Z', [
    { type: 'tool_use', id: 'toolu_s2_a', name: 'Bash', input: { command: 'docker compose up -d db' } },
  ], usage(75, 130, 9000, 1200, 0)),
  user(S2ID, CWD1, '2026-08-21T14:10:41.000Z', [
    { type: 'tool_result', tool_use_id: 'toolu_s2_a', is_error: true, content: 'Error: port 5432 already allocated' },
  ]),
  assistant(S2ID, CWD1, '2026-08-21T14:11:00.000Z', [
    { type: 'text', text: 'Порт зайнятий старим контейнером. Знімаю його.' },
    { type: 'tool_use', id: 'toolu_s2_b', name: 'Bash', input: { command: 'docker rm -f pg-old' } },
  ], usage(60, 210, 9400, 0, 120)),
  user(S2ID, CWD1, '2026-08-21T14:11:15.000Z', [
    { type: 'tool_result', tool_use_id: 'toolu_s2_b', is_error: false, content: 'pg-old' },
  ]),
]);

// S-03: carries the noise directories the S1 index must ignore
const S3ID = 'cccccccc-3333-4333-8333-333333333333';
write(`${P1}/${S3ID}.jsonl`, [
  user(S3ID, CWD1, '2026-08-21T18:00:00.000Z', 'Порахуй покриття тестами по пакетах'),
  aiTitle(S3ID, 'Coverage per package'),
  assistant(S3ID, CWD1, '2026-08-21T18:00:30.000Z', [
    { type: 'tool_use', id: 'toolu_s3_a', name: 'Bash', input: { command: 'go test ./... -cover' } },
  ], usage(200, 300, 15000, 8000, 0)),
  user(S3ID, CWD1, '2026-08-21T18:01:40.000Z', [
    { type: 'tool_result', tool_use_id: 'toolu_s3_a', is_error: false, content: 'ok  checkout/store  0.412s  coverage: 74.1%' },
  ]),
]);
mkdirSync(join(root, P1, S3ID, 'tool-results'), { recursive: true });
writeFileSync(join(root, P1, S3ID, 'tool-results', 'r7x2kq10p.txt'), 'spilled tool output, not a session\n');
mkdirSync(join(root, P1, S3ID, 'subagents'), { recursive: true });
writeFileSync(
  join(root, P1, S3ID, 'subagents', 'agent-deadbeef1234.jsonl'),
  JSON.stringify(user('agent-deadbeef1234', CWD1, '2026-08-21T18:00:35.000Z', 'subagent transcript, not a session')) + '\n',
);
writeFileSync(
  join(root, P1, S3ID, 'subagents', 'agent-deadbeef1234.meta.json'),
  JSON.stringify({ agentType: 'Explore', parentSessionId: S3ID }) + '\n',
);

// ---------------------------------------------------------------- project 2
const P2 = '-Users-demo-sources-web-shop';
const CWD2 = '/Users/demo/sources/web-shop';

// S-04: zero usage anywhere -> S4 must say "not available", not 0
const S4ID = 'dddddddd-4444-4444-8444-444444444444';
write(`${P2}/${S4ID}.jsonl`, [
  user(S4ID, CWD2, '2026-08-22T11:00:00.000Z', 'Покажи структуру теки components'),
  aiTitle(S4ID, 'Components folder tour'),
  { type: 'assistant', uuid: uuid(), sessionId: S4ID, cwd: CWD2, timestamp: '2026-08-22T11:00:05.000Z',
    message: { id: 'msg_fixture_nousage', role: 'assistant', model: 'claude-opus-5',
      content: [{ type: 'text', text: 'Ось дерево.' }] } },
]);

// S-05: compaction boundary for the S4 marker
const S5ID = 'eeeeeeee-5555-4555-8555-555555555555';
write(`${P2}/${S5ID}.jsonl`, [
  user(S5ID, CWD2, '2026-08-22T15:30:00.000Z', 'Перепиши кошик на новий API'),
  aiTitle(S5ID, 'Cart rewrite'),
  assistant(S5ID, CWD2, '2026-08-22T15:30:20.000Z', [
    { type: 'tool_use', id: 'toolu_s5_a', name: 'Read', input: { file_path: '/Users/demo/sources/web-shop/cart.js' } },
  ], usage(310, 1200, 40000, 12000, 900)),
  user(S5ID, CWD2, '2026-08-22T15:30:26.000Z', [
    { type: 'tool_result', tool_use_id: 'toolu_s5_a', is_error: false, content: 'export function cart() { /* ... */ }' },
  ]),
  { type: 'system', subtype: 'compact_boundary', sessionId: S5ID, timestamp: '2026-08-22T15:45:00.000Z',
    content: 'Conversation compacted',
    compactMetadata: { trigger: 'auto', preTokens: 148000, postTokens: 21000 } },
  assistant(S5ID, CWD2, '2026-08-22T15:46:00.000Z', [
    { type: 'text', text: 'Продовжую після компакту.' },
  ], usage(50, 400, 21000, 0, 0)),
]);

// ---------------------------------------------------------------- project 3
const P3 = '-Users-demo-notes';
const CWD3 = '/Users/demo/notes';

// S-06: the append target the S5 live test writes into
const S6ID = 'ffffffff-6666-4666-8666-666666666666';
write(`${P3}/${S6ID}.jsonl`, [
  user(S6ID, CWD3, '2026-08-23T08:00:00.000Z', 'Зроби зведення нотаток за тиждень'),
  aiTitle(S6ID, 'Weekly notes digest'),
  assistant(S6ID, CWD3, '2026-08-23T08:00:12.000Z', [
    { type: 'text', text: 'Готово.' },
  ], usage(30, 80, 5000, 500, 0)),
]);

console.log(`fixtures written to ${root}`);
