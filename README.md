# agent-ops-dashboard

Local-first dashboard over Claude Code session logs. Teaching project for the «Agentic Engineering»
mini-course: six thin slices, one lesson each.

```bash
npm install
npm run verify     # tests, on the synthetic fixture tree
npm start          # http://127.0.0.1:4180, on real ~/.claude
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

## Adding a second agent

Adapters register themselves in `lib/sources.js`. `lib/claude/` is one; a Codex adapter is
`lib/codex/index.js` calling `registerSource(...)` with the same shape. Nothing in `server.js` or
the views knows a vendor name.
