// The JSON API's projection of a session. Source-agnostic: it is handed a session somebody else
// already read, and imports nothing.
//
// Every field is picked by name. The point is not tidiness: a session record carries whatever
// the reader put on it, so spreading one into a response would make the API's field list a
// consequence of an internal shape instead of a decision (AGENTS.md §Межі). Adding a field here
// is the only way a field reaches a client, and it is a deliberate edit.
export function toApiSession(session) {
  const s = session.stats;
  return {
    sessionId: session.sessionId,
    projectDirName: session.projectDirName,
    projectName: session.projectName,
    projectPath: session.projectPath,
    projectDerived: session.projectDerived,
    cwd: session.cwd ?? null,
    title: session.title ?? null,
    label: session.label ?? null,
    name: session.name ?? null,
    tags: session.tags ?? [],
    note: session.note ?? '',
    starred: Boolean(session.starred),
    size: session.size,
    mtimeMs: session.mtimeMs,
    stats: {
      turns: s.turns,
      prompts: s.prompts,
      tokens: {
        input: s.tokens.input,
        output: s.tokens.output,
        cacheRead: s.tokens.cacheRead,
        cacheWrite: s.tokens.cacheWrite,
      },
      models: s.models,
      days: s.days,
      tools: s.tools,
      compacts: s.compacts,
      firstTs: s.firstTs ?? null,
      lastTs: s.lastTs ?? null,
    },
  };
}
