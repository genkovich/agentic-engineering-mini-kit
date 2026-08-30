# agent-ops-dashboard

Local-first dashboard over Claude Code session logs. Teaching project for the «Agentic Engineering»
mini-course: six thin slices, one lesson each.

```bash
npm install
npm run verify        # 40 tests, on the synthetic fixture tree
npm run verify:live   # the same acceptance checks against the real ~/.claude
npm start             # http://127.0.0.1:4180
```

## Data source

Everything is read from `CLAUDE_HOME` (default `~/.claude`). Nothing is ever written there.

```bash
CLAUDE_HOME=./fixtures/claude-home npm start   # demo on fixtures
```

## Stack

Node + Express, HTML rendered on the server with template literals, vanilla JS, vanilla SVG.
One dependency: `express`. No build step, no framework, no TypeScript. Tests on `node --test`.

## Slices

| tag | slice |
|-----|-------|
| `l2-start` | skeleton: server, layout, CSS, fixtures, verify harness |
| `l3-start` | S1 session index + S2 human titles |
| `l4-start` | S3 session timeline |
| `l5-start` | S4 token accounting |
| `l6-start` | S5 live tail over SSE |
| `l6-finish` | S6 analytics |

## What the transcripts do and do not say

Four things this dashboard refuses to guess at, because the data does not support them:

- **Context window.** `model_context_window` is not a field. Grep the whole projects tree and every
  hit is prose inside somebody's prompt. So no percentage of context is shown anywhere.
- **Wall time.** Nothing records how long a session took. The span between the first and the last
  timestamp is labelled *observed*, and the page says why: on real data it runs to 20 hours for a
  session someone left open.
- **Token totals from assistant records.** One API response is written as several assistant
  records, each repeating the same `usage`. Over 333 real files that is 39 734 records against
  19 250 responses — a 2.63x overcount. Everything is deduplicated on `message.id` first.
- **Coverage.** The analytics endpoint parses the freshest N sessions and reports `scanned` and
  `skipped` next to every number, instead of implying it read all 340.

## Adding a second agent

Adapters register themselves in `lib/sources.js`. `lib/claude/` is one; a Codex adapter is
`lib/codex/index.js` calling `registerSource(...)` with the same shape. Nothing in `server.js` or
the views knows a vendor name.
