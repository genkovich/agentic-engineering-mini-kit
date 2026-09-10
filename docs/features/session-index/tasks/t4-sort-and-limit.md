---
id: T4
title: "Sort sessions by mtime desc with filename tie-break and truncate to limit"
layer: "infra"
deps: ["T3"]
blocks: ["T5"]
acs: ["AC-03", "AC-03b", "AC-04"]
files_hint: ["lib/claude/index.js", "test/session-index.test.js"]
owner: "maintainer"
estimate: "S"
context_budget: "M"
status: "todo"
---

# T4 — Sort sessions by mtime desc with filename tie-break and truncate to limit

## Place in the sequence

- **Blocked by:** T3 — symlink dedup (sorts/truncates the already-deduplicated, trust-checked set). **Blocks:** T5 — best-effort readability wraps the complete scan+sort+limit pipeline. **Wave:** 3.
- **Lane:** shares `lib/claude/index.js` with T1–T3, T5 — serialized commit order after T3.

## Why (user story)

> **As a** розробник
> **I want** бачити перелік від найсвіжіших сесій до найстаріших
> **So that** учорашня робота видно згори, а не десь усередині списку
>
> — `spec.md §4, US-03, verbatim` · full text: [spec.md](../spec.md)

This task delivers the ordering and the size cap US-03 and US-04 ask for: newest-first with a deterministic tie-break, capped to a bounded response.

## Inlined context

> **Chosen:** Option 1, синхронний скан без кешу. ... адаптер щоразу обходить `CLAUDE_HOME/projects` рівно два рівні, сортує в памʼяті (mtime спадаюче, імʼя файлу як другий ключ) і обрізає лімітом після сортування.
>
> — `adr/0001-rebuild-index-synchronously-per-request.md, Decision outcome, abridged` · full text: [../adr/0001-rebuild-index-synchronously-per-request.md](../adr/0001-rebuild-index-synchronously-per-request.md)

> Типова довжина переліку | 50 рядків, якщо розробник не просив іншої | перевірка дефолту в тесті
> Стеля довжини переліку | ≤ 1000 рядків на сторінку | перевірка валідації параметра в тесті
>
> — `spec.md §6, NFR table, verbatim` · full text: [spec.md](../spec.md)

**Hard rule:** the invalid-limit *validation* itself (non-number, ≤0, >1000 → fallback + note) happens in `server.js`, per the runtime flow — this task's `listSessions({ limit })` trusts the `limit` it receives and just applies it: sort, then truncate, then report `totalFound` (count before truncation) and `truncated` (boolean).

— `sad.md §6, Critical flow 1, abridged` · full text: [../sad.md](../sad.md)

**Fallback:** insufficient or contradicted by the code → read the named file in full
([spec.md](../spec.md) · [sad.md](../sad.md) · [adr/0001-...md](../adr/0001-rebuild-index-synchronously-per-request.md)) and follow it. Do not guess.

## Data delta

No DB changes.

## API contract

Internal — no API surface.

## Acceptance criteria

### AC-03 — happy path

> **Given** у домашній теці джерела є сесії з різним часом зміни
> **When** розробник відкриває сторінку переліку
> **Then** сесії йдуть від найсвіжішої до найстарішої за часом зміни
>
> — `spec.md §5, AC-03, verbatim` · full text: [spec.md](../spec.md)

### AC-03b — happy path

> **Given** дві сесії мають однаковий час зміни
> **When** розробник відкриває сторінку переліку
> **Then** ці дві сесії впорядковані за іменем файлу сесії як вторинним ключем, тому порядок однаковий і при повторному відкритті, і на будь-якій із трьох платформ CI
>
> — `spec.md §5, AC-03b, verbatim` · full text: [spec.md](../spec.md)

### AC-04 — happy path

> **Given** у домашній теці джерела більше ніж пʼятдесят сесій, а розробник не просив іншої довжини переліку
> **When** розробник відкриває сторінку переліку
> **Then** він бачить пʼятдесят найсвіжіших сесій і повідомлення про те, скільки сесій знайдено всього в прочитаних і показаних теках проєктів до обрізання; це повідомлення зʼявляється саме тому, що перелік обрізано лімітом
>
> — `spec.md §5, AC-04, verbatim` · full text: [spec.md](../spec.md)

## Checklist

- [ ] In `lib/claude/index.js`, `listSessions({ limit = 50 } = {})` sorts the deduplicated session list by `mtime` descending, then by `sessionId` (session filename) ascending as the tie-break.
- [ ] After sorting, slice to `limit` entries; return `{ sessions, totalFound, truncated }` where `totalFound` is the count before slicing and `truncated = totalFound > sessions.length`.
- [ ] Unit test building a synthetic set of sessions with two equal `mtime`s and asserting the tie-break order is stable across repeated runs (no reliance on object insertion order beyond what the sort itself guarantees).
- [ ] Unit test with >50 synthetic sessions and no explicit `limit` (default) asserting exactly 50 returned, `truncated === true`, `totalFound` equals the full synthetic count.

## Edge cases

| Case | Behaviour |
|---|---|
| Exactly `limit` sessions found | `truncated === false`, `totalFound === sessions.length` |
| `limit` larger than the number of sessions found | all sessions returned, `truncated === false` |
| Two sessions with equal `mtime` and equal filename (impossible on a real filesystem — same file) | not a real case; not tested |

## Definition of Done

- [ ] Unit test for AC-03 (mtime desc ordering) passes.
- [ ] Unit test for AC-03b (filename tie-break, deterministic) passes.
- [ ] Unit test for AC-04 (default 50, `truncated`/`totalFound` correct) passes.
- [ ] `npm run verify` green on all 3 CI platforms (sort must not depend on platform-specific string/locale ordering — use plain `<`/`>` comparison, not `localeCompare`).
