#!/usr/bin/env node
// Runs the acceptance checks against the real Claude home instead of the fixtures, and proves the
// dashboard did not touch a single session file while doing it.
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { listSessions, claudeHome } from '../lib/claude/index.js';
import { buildStats } from '../lib/stats.js';

const sh = (cmd) => execFileSync('/bin/sh', ['-c', cmd]).toString().trim();
const projects = `${claudeHome()}/projects`;
let failures = 0;

function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
}

const before = new Map(listSessions().map((s) => {
  const st = statSync(s.file);
  return [s.file, `${st.size}:${st.mtimeMs}`];
}));

console.log(`home: ${claudeHome()}`);

const sessions = listSessions();
check('index count == *.jsonl one level inside a project',
  sessions.length,
  Number(sh(`find "${projects}" -mindepth 2 -maxdepth 2 -name '*.jsonl' -type f | wc -l`)));

const recursive = Number(sh(`find "${projects}" -name '*.jsonl' -type f | wc -l`));
console.log(`INFO  naive recursive count would have been ${recursive}, `
  + `${(recursive / sessions.length).toFixed(1)}x too many`);

const scan = Number(process.env.SCAN || 40);
const stats = buildStats({ scan });
const files = stats.scanned
  ? sessions.slice(0, scan).map((s) => `"${s.file}"`).join(' ')
  : '';

check('tool_use blocks == top tool calls',
  stats.topTools.reduce((a, t) => a + t.calls, 0),
  Number(sh(`cat ${files} | grep -o '"type":"tool_use"' | wc -l`)));

check('is_error:true == reported failures',
  stats.toolErrors,
  Number(sh(`cat ${files} | grep -o '"is_error":true' | wc -l`)));

check('deduplicated output_tokens == reported total',
  stats.tokensPerDay.reduce((a, d) => a + d.output, 0),
  Number(sh(`cat ${files} | jq -n -c '[inputs | select(.type=="assistant") | select(.message.usage)] `
    + `| unique_by(.message.id) | map(.message.usage.output_tokens // 0) | add'`)));

const naive = Number(sh(`cat ${files} | jq -n -c `
  + `'[inputs | select(.type=="assistant") | .message.usage.output_tokens // 0] | add'`));
const deduped = stats.tokensPerDay.reduce((a, d) => a + d.output, 0);
console.log(`INFO  naive per-record sum would have been ${naive}, ${(naive / deduped).toFixed(2)}x too high`);

let touched = 0;
for (const [file, sig] of before) {
  try {
    const st = statSync(file);
    if (`${st.size}:${st.mtimeMs}` !== sig) touched += 1;
  } catch { /* the file went away on its own; not our doing */ }
}
check('session files left untouched (size and mtime)', touched, 0);

console.log(`\nscanned ${stats.scanned} of ${stats.totalSessions} sessions, `
  + `${(stats.bytesScanned / 1048576).toFixed(0)} MB, ${stats.elapsedMs} ms`);
process.exit(failures === 0 ? 0 : 1);
