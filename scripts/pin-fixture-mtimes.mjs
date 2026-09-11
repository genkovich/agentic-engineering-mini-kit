#!/usr/bin/env node
// git does not store file mtimes: after a clone every fixture session carries the same mtime (the
// checkout moment). Anything that sorts or buckets sessions by mtime then sees identical dates.
// This pins each session file's mtime to its own last `timestamp`, the way it was written.
// Runs before `verify` and `demo` (see package.json), safe to run any time.
//
// Both fixture homes are covered: Claude keeps its sessions two levels down (projects/<project>/
// <id>.jsonl), Codex four (sessions/YYYY/MM/DD/rollout-*.jsonl), so the walk is depth-driven
// rather than hard-coded per source.
import { readdirSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

const TREES = [
  { root: join(fixtures, 'claude-home', 'projects'), depth: 1 },
  { root: join(fixtures, 'codex-home', 'sessions'), depth: 3 },
];

// Every `.jsonl` exactly `depth` directories below `root`. Deeper files (a Claude session's own
// subagent transcripts) are not session journals and are left alone.
function journalsUnder(dir, depth) {
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  const found = [];
  for (const name of names) {
    const path = join(dir, name);
    let st;
    try { st = statSync(path); } catch { continue; }
    if (depth > 0) {
      if (st.isDirectory()) found.push(...journalsUnder(path, depth - 1));
    } else if (st.isFile() && name.endsWith('.jsonl')) {
      found.push(path);
    }
  }
  return found;
}

let pinned = 0;
for (const { root, depth } of TREES) {
  for (const file of journalsUnder(root, depth)) {
    const stamps = readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => { try { return JSON.parse(line).timestamp; } catch { return undefined; } })
      .filter(Boolean)
      .sort();
    if (!stamps.length) continue;
    const last = new Date(stamps[stamps.length - 1]);
    utimesSync(file, last, last);
    pinned += 1;
  }
}
console.log(`fixture mtimes pinned: ${pinned} session files`);
