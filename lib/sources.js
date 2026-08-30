// Registry of telemetry sources. One adapter per agent vendor.
//
// The dashboard never imports an adapter directly — it asks the registry. That is what keeps a
// second adapter (Codex, Cursor) a matter of writing lib/<vendor>/index.js and calling
// registerSource() from it, with nothing in server.js or the views to change.
//
// An adapter is an object:
//   { id, label, home(), listSessions(), readSession(id) }

const sources = new Map();

export function registerSource(adapter) {
  for (const field of ['id', 'label', 'home']) {
    if (!adapter?.[field]) throw new Error(`source adapter is missing "${field}"`);
  }
  sources.set(adapter.id, adapter);
  return adapter;
}

export function getSource(id) {
  const adapter = sources.get(id);
  if (!adapter) throw new Error(`unknown source "${id}"`);
  return adapter;
}

export function listSources() {
  return [...sources.values()].map(({ id, label }) => ({ id, label }));
}
