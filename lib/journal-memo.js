// The two memos every journal reader needs, and the timeline cap they share. Source-agnostic on
// purpose: reading a session file is expensive, and the rule for when a read may be reused is the
// same whichever agent wrote the file — a path is unchanged while its size and mtime are.
//
// Each source creates its own memo instances, so one adapter's entries never count towards
// another's size and pruning one never evicts the other's. Nothing but numbers and short names is
// ever stored: the values handed in are the aggregates, never a record or a payload (ADR-0001).

// `path \0 size \0 mtime`. The NUL separator is what makes prune() able to recover the path part:
// a path may contain anything else, but never a NUL byte.
export function memoKey(path, size, mtimeMs) {
  return `${path}\u0000${size}\u0000${mtimeMs}`;
}

// An unbounded memo with an explicit eviction step (ADR-0006): it must not grow forever after a
// session file is deleted or renamed, so the orchestrator hands back the paths the scan can still
// see and everything else goes.
export function createStatsMemo() {
  const memo = new Map();
  return {
    get: (key) => memo.get(key),
    set: (key, value) => { memo.set(key, value); return value; },
    size: () => memo.size,
    prune(livePaths) {
      const live = livePaths instanceof Set ? livePaths : new Set(livePaths);
      for (const key of memo.keys()) {
        if (!live.has(key.slice(0, key.indexOf('\u0000')))) memo.delete(key);
      }
    },
  };
}

// The event list is much larger than the aggregates, so it gets a small LRU instead: at most
// `limit` journals are kept and the oldest insertion is dropped.
export function createTimelineMemo(limit = 8) {
  const memo = new Map();
  return {
    get: (key) => memo.get(key),
    set(key, value) {
      memo.set(key, value);
      while (memo.size > limit) memo.delete(memo.keys().next().value);
      return value;
    },
    size: () => memo.size,
  };
}

// Long sessions keep the last MAX_TIMELINE_EVENTS events; `total` still reports the full count, so
// a page can say that the head was collapsed while the analytics still cover the whole session.
export const MAX_TIMELINE_EVENTS = 400;

export function capTimeline(events) {
  const total = events.length;
  const capped = total > MAX_TIMELINE_EVENTS;
  return { events: capped ? events.slice(-MAX_TIMELINE_EVENTS) : events, total, capped };
}
