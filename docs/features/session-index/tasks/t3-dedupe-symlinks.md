---
id: T3
title: "Deduplicate project-dir symlinks by realpath and reject external targets"
layer: "infra"
deps: ["T2"]
blocks: ["T4"]
acs: ["AC-09", "AC-09b"]
files_hint: ["lib/claude/index.js", "test/session-index.test.js"]
owner: "maintainer"
estimate: "M"
context_budget: "M"
status: "todo"
---

# T3 — Deduplicate project-dir symlinks by realpath and reject external targets

## Place in the sequence

- **Blocked by:** T2 — scan projects/ two levels deep (needs the depth-1 project-dir entries to apply this to). **Blocks:** T4 — sort/limit needs the deduplicated, trust-checked session set as input. **Wave:** 2.
- **Lane:** shares `lib/claude/index.js` with T1, T2, T4, T5 — serialized commit order after T2.

## Why (user story)

> **As a** розробник
> **I want** щоб дашборд показував лише те, що лежить у домашній теці джерела, і лише метадані
> **So that** локальний інструмент не ставав переглядачем чужих тек і не виносив на екран текст моїх розмов
>
> — `spec.md §4, US-07, verbatim` · full text: [spec.md](../spec.md)

This task delivers the trust boundary US-07 depends on: a symlinked project directory is only trusted, and only counted once, if it resolves inside `CLAUDE_HOME`.

## Inlined context

> **Chosen:** Option 1, дедуп за realpath із відхиленням зовнішніх цілей. ... для кожного символічного запису обчислюємо реальний шлях (`node:fs.realpathSync`) і порівнюємо з `CLAUDE_HOME`; зовні — ігноруємо повністю, всередині — враховуємо раз за реальним шляхом. ... `realpathSync` сама виявляє цикл і кидає помилку, яку адаптер ловить і трактує як нечитабельний запис, тож захист від циклів не потребує окремої логіки обходу.
>
> — `adr/0002-dedupe-symlinks-by-realpath-reject-external.md, Decision outcome, abridged` · full text: [../adr/0002-dedupe-symlinks-by-realpath-reject-external.md](../adr/0002-dedupe-symlinks-by-realpath-reject-external.md)

> Символічне посилання з теки проєктів веде за межі домашньої теки джерела: сесії за ним не показуємо і не згадуємо про них, тобто ховаємо існування, а не пояснюємо відмову.
>
> — `spec.md §6.1, Abuse cases, verbatim` · full text: [spec.md](../spec.md)

**Hard rule:** посилання за межі `CLAUDE_HOME` приховується повністю (AC-09), посилання всередину дедуплюється за реальним шляхом (AC-09b) — і символічні посилання трапляються лише серед записів теки проєктів; глибше застосунок не спускається.

— `sad.md §4, Top strategic choices #2, verbatim` · full text: [../sad.md](../sad.md)

**Fallback:** insufficient or contradicted by the code → read the named file in full
([spec.md](../spec.md) · [sad.md](../sad.md) · [adr/0002-...md](../adr/0002-dedupe-symlinks-by-realpath-reject-external.md)) and follow it. Do not guess.

## Data delta

No DB changes.

## API contract

Internal — no API surface.

## Acceptance criteria

### AC-09 — authorization

> **Given** у теці проєктів лежить символічне посилання, яке веде за межі домашньої теки джерела
> **When** розробник відкриває сторінку переліку
> **Then** сесії, що лежать за цим посиланням, у переліку не зʼявляються, і сторінка жодним чином не показує, що вони існують, зокрема не додає його до примітки про непрочитані елементи джерела з AC-08
>
> — `spec.md §5, AC-09, verbatim` · full text: [spec.md](../spec.md)

### AC-09b — happy path

> **Given** у теці проєктів лежить символічне посилання, яке веде на іншу теку всередині домашньої теки джерела, і на ту саму теку веде ще одне посилання
> **When** розробник відкриває сторінку переліку
> **Then** кожна сесія з тієї теки зʼявляється в переліку рівно один раз, а сторінка складається за скінченний час
>
> — `spec.md §5, AC-09b, verbatim` · full text: [spec.md](../spec.md)

## Checklist

- [ ] In `lib/claude/index.js`, for each depth-1 project entry, `lstatSync` it; if `isSymbolicLink()`, resolve with `realpathSync(entryPath)`.
- [ ] If the resolved path is not inside `claudeHome()` (path containment check, not string-prefix on unresolved paths), drop the entry entirely — no session count, no unreadable count, no trace anywhere in the response.
- [ ] Track a `Set` of realpaths already scanned; if the resolved path (symlink or not) was already scanned, skip re-walking it — this is what gives AC-09b both "counted once" and "finite time" for a symlink cycle or double-link.
- [ ] Catch `realpathSync` throwing (broken symlink, permission denied, cycle) with the existing repo convention (`catch { ... }` no bound variable) — this task treats it as "drop silently" for now; T5 will formalize unreadable counting for the non-symlink cases.
- [ ] Unit tests in `test/session-index.test.js` build a **disposable temp directory** (not the checked-in fixtures — this is spec §8 OQ's resolved default) containing: a real project dir with 1 session, a symlink to it (dedup case, AC-09b), and a symlink pointing outside the temp tree (external case, AC-09). If creating the symlink fails (e.g. missing Windows privilege), the test skips itself with an explicit message rather than failing.

## Edge cases

| Case | Behaviour |
|---|---|
| Symlink resolves outside `CLAUDE_HOME` | dropped entirely — 0 sessions from it, not mentioned in any count |
| Two symlinks resolving to the same in-bounds directory | that directory's sessions appear exactly once |
| Symlink forms a cycle | `realpathSync` throws — caught, entry dropped, no infinite walk |
| Broken symlink (target does not exist) | `realpathSync` throws — caught, entry dropped |

## Definition of Done

- [ ] Test for AC-09 (external symlink invisible, not even in an unreadable count) passes.
- [ ] Test for AC-09b (internal double-link counted once, finishes in finite time) passes.
- [ ] Symlink test is skip-safe on platforms where creating a symlink needs elevated privilege.
- [ ] `realpathSync` call count is bounded by the number of project-dir entries, not sessions (matches ADR-0002's stated cost).
- [ ] `npm run verify` green.
