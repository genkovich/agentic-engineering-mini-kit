import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeHome, listSessions, enrichWithIdentity } from './lib/claude/index.js';
import { listSources } from './lib/sources.js';
import { layout } from './views/layout.js';
import { sessionsPage } from './views/sessions.js';
import { sessionPage } from './views/session.js';
import { livePage } from './views/live.js';
import { analyticsPage } from './views/analytics.js';
import { buildStats } from './lib/stats.js';
import { SessionWatcher, activeSessions } from './lib/watch.js';
import { parseSession, parseLines } from './lib/claude/parse.js';
import { tokenReport } from './lib/claude/tokens.js';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
export const app = express();

app.use(express.static(join(here, 'public')));

const DEFAULT_LIMIT = 50;

app.get('/api/health', (req, res) => {
  res.json({ ok: true, sources: listSources(), claudeHome: claudeHome() });
});

// S1 — the index. Built from directory names, file names and fstat only. No file is opened.
app.get('/api/sessions', (req, res) => {
  const all = listSessions();
  const limit = Number(req.query.limit) || DEFAULT_LIMIT;
  const page = all.slice(0, limit);
  // ?titles=0 gives the raw S1 index, which is what the timing comparison in lesson 3 measures.
  const sessions = req.query.titles === '0' ? page : enrichWithIdentity(page);
  res.json({ total: all.length, count: sessions.length, sessions });
});

function findSession(id) {
  return listSessions().find((s) => s.sessionId === id) ?? null;
}

// S3 — the timeline. One file, parsed in full, on demand.
app.get('/api/sessions/:id', (req, res) => {
  const session = findSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'session not found' });
  res.json({
    session: enrichWithIdentity([session])[0],
    timeline: parseSession(session.file),
    tokens: tokenReport([...parseLines(readFileSync(session.file, 'utf8'))]),
  });
});

app.get('/sessions/:id', (req, res) => {
  const session = findSession(req.params.id);
  if (!session) return res.status(404).type('html').send(layout({ title: 'not found', body: '<h1>404</h1>' }));
  const records = [...parseLines(readFileSync(session.file, 'utf8'))];
  res.type('html').send(sessionPage({
    session: enrichWithIdentity([session])[0],
    timeline: parseSession(session.file),
    tokens: tokenReport(records),
  }));
});

app.get('/', (req, res) => {
  const all = listSessions();
  const limit = Number(req.query.limit) || DEFAULT_LIMIT;
  res.type('html').send(sessionsPage({
    sessions: enrichWithIdentity(all.slice(0, limit)),
    home: claudeHome(),
    limit: { total: all.length },
  }));
});

// S5 — one watcher for the whole process, fanned out to every open SSE connection.
export const watcher = new SessionWatcher();
const clients = new Set();

watcher.on('append', ({ session, events }) => {
  const frame = `event: append\ndata: ${JSON.stringify({
    sessionId: session.sessionId, project: session.projectLabel, events,
  })}\n\n`;
  for (const res of clients) res.write(frame);
});

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('event: ready\ndata: {}\n\n');
  clients.add(res);
  watcher.start();
  req.on('close', () => {
    clients.delete(res);
    if (clients.size === 0) watcher.stop();
  });
});

app.get('/api/live', (req, res) => {
  const windowMs = Number(req.query.windowMs) || undefined;
  res.json({ active: enrichWithIdentity(activeSessions({ windowMs })) });
});

app.get('/live', (req, res) => {
  const windowMs = Number(req.query.windowMs) || 10 * 60 * 1000;
  res.type('html').send(livePage({
    active: enrichWithIdentity(activeSessions({ windowMs })),
    home: claudeHome(),
    windowMinutes: Math.round(windowMs / 60000),
  }));
});

// S6 — analytics.
app.get('/api/analytics', (req, res) => {
  res.json(buildStats({ scan: Number(req.query.scan) || undefined }));
});

app.get('/analytics', (req, res) => {
  res.type('html').send(analyticsPage({
    stats: buildStats({ scan: Number(req.query.scan) || undefined }),
    home: claudeHome(),
  }));
});

const PORT = Number(process.env.PORT || 4180);
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`agent-ops on http://127.0.0.1:${PORT}  (CLAUDE_HOME=${claudeHome()})`);
  });
}
