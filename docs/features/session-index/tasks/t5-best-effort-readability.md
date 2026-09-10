---
id: T5
title: "Make the scan best-effort: skip unreadable entries, count them, never throw"
layer: "infra"
deps: ["T4"]
blocks: ["T6"]
acs: ["AC-06", "AC-07", "AC-08", "AC-13"]
files_hint: ["lib/claude/index.js", "test/session-index.test.js"]
owner: "maintainer"
estimate: "M"
context_budget: "M"
status: "todo"
---

# T5 — Make the scan best-effort: skip unreadable entries, count them, never throw

## Place in the sequence

- **Blocked by:** T4 — sort/limit (this task wraps the complete scan+dedup+sort+limit pipeline in error handling). **Blocks:** T6 — server.js needs the final `listSessions()` surface, including `unreadableCount`. **Wave:** 4 — this closes out `lib/claude/index.js`'s `listSessions()`.
- **Lane:** shares `lib/claude/index.js` with T1–T4 — serialized commit order, last in this file.

## Why (user story)

> **As a** розробник
> **I want** знати, коли частину джерела прочитати не вдалося
> **So that** я не вважаю неповний перелік повним
>
> — `spec.md §4, US-06, verbatim` · full text: [spec.md](../spec.md)

This task delivers US-06's guarantee end to end: one unreadable directory or file never blanks the page — it degrades to "what did read" plus an honest count of what did not, and also closes the zero-writes / performance quality goals (SAD QG-1, QG-2) for the whole `listSessions()` function.

## Inlined context

> Стійкість до часткової нечитабельності джерела — одна нечитабельна тека чи файл не гасить сторінку, і розробник бачить, що частина не прочиталася, а не вважає неповний перелік повним.
>
> — `sad.md §1, Top-3 quality goals #3, verbatim` · full text: [../sad.md](../sad.md)

> `catch` пишемо без привʼязки до змінної і з дефолтом замість прокидання далі: `try { st = lstatSync(p); } catch { continue; }`.
>
> — `.claude/rules/javascript.md, verbatim` · full text: [../../../../.claude/rules/javascript.md](../../../../.claude/rules/javascript.md)

> **How verify:** тест із текою, яку не вдається прочитати через права доступу — перевіряє, що відповідь 200, перелік містить сесії з прочитаних тек, а примітка показує лише кількість.
>
> — `sad.md §10, QG-3, verbatim` · full text: [../sad.md](../sad.md)

**Hard rule:** примітка про непрочитані елементи джерела (AC-08) показує лише кількість, без шляхів і без тексту системної помилки; символічне посилання за межі `CLAUDE_HOME` (T3) не додається до цього лічильника.

— `spec.md §6.1, Abuse cases, verbatim` · full text: [spec.md](../spec.md)

**Fallback:** insufficient or contradicted by the code → read the named file in full
([spec.md](../spec.md) · [sad.md](../sad.md) · [test/oracle.js](../../../../test/oracle.js)) and follow it. Do not guess.

## Data delta

No DB changes.

## API contract

Internal — no API surface.

## Acceptance criteria

### AC-06 — cross-context

> **Given** coding-агент на цій машині ще не запускався, тому теки проєктів у його домашній теці не існує
> **When** розробник відкриває сторінку переліку
> **Then** сторінка відкривається, показує порожній стан із повним шляхом теки, яку читала, і не створює цю теку
>
> — `spec.md §5, AC-06, verbatim` · full text: [spec.md](../spec.md)

### AC-07 — happy path

> **Given** тека проєктів у домашній теці джерела існує, але жодної сесії в ній немає
> **When** розробник відкриває сторінку переліку
> **Then** він бачить той самий порожній стан, а не помилку
>
> — `spec.md §5, AC-07, verbatim` · full text: [spec.md](../spec.md)

### AC-08 — error

> **Given** сама тека проєктів, одна з тек проєктів, або окремий файл сесії всередині інакше читабельної теки проєкту не читається через права доступу, а решта джерела читається
> **When** розробник відкриває сторінку переліку
> **Then** він бачить сесії з того, що прочиталося (порожній перелік, якщо не прочиталося нічого), і примітку про кількість непрочитаних елементів джерела, без шляхів і без тексту системної помилки
>
> — `spec.md §5, AC-08, verbatim` · full text: [spec.md](../spec.md)

### AC-13 — happy path (perf + no-write half)

> `Записи в домашню теку джерела` | рівно 0 | тест звіряє перелік файлів і час зміни до та після запиту
> `Час складання переліку на навчальних фікстурах (6 сесій)` | ≤ 50 ms | один прогін чистої функції побудови переліку (без HTTP-шару) у тесті на `fixtures/claude-home`
>
> — `spec.md §6, NFR table, verbatim` · full text: [spec.md](../spec.md)

## Checklist

- [ ] `readdirSync(projectsDir())` itself: if it throws (missing directory — AC-06, or permission denied — part of AC-08), return `{ sessions: [], totalFound: 0, truncated: false, unreadableCount: 0 }` without creating the directory.
- [ ] Wrap each depth-1 project-dir `readdirSync`/`lstatSync` in `try { ... } catch { unreadableCount++; continue; }` — one bad project dir increments the counter and moves on (AC-08), independent of the symlink-external case from T3 (which must NOT touch this counter).
- [ ] Wrap each depth-2 session-file `lstatSync` in the same pattern — one unreadable session file increments the counter, its siblings still appear.
- [ ] `listSessions()` never throws for a readability reason — it always returns the `{ sessions, totalFound, truncated, unreadableCount }` shape.
- [ ] Unit test: temp `projectsDir` that exists but is empty → `sessions: []` (AC-07), reusing the `empty()`-consuming shape T7 will render.
- [ ] Unit test: `CLAUDE_HOME` pointing at a path whose `projects/` does not exist → `sessions: []`, and a directory-existence check before/after proves the path was not created (AC-06).
- [ ] Unit test: temp tree with one unreadable project dir (permission bits, or a Windows-safe equivalent — chmod-based tests should skip themselves on platforms where chmod has no effect) and readable siblings → returned sessions come from the readable siblings only, `unreadableCount === 1`.
- [ ] Unit test: `npm run verify`-style before/after snapshot of `fixtures/claude-home` (file list + mtimes) proving zero writes across a `listSessions()` call.
- [ ] Perf test: single timed run of `listSessions()` on `fixtures/claude-home` (6 sessions) asserting `<= 50ms`.

## Edge cases

| Case | Behaviour |
|---|---|
| `projects/` directory does not exist | `sessions: []`, directory NOT created, no error surfaced beyond the empty result |
| `projects/` exists, zero session files anywhere | `sessions: []`, `unreadableCount: 0` |
| One project dir unreadable, others fine | its sessions absent, siblings' sessions present, `unreadableCount` incremented by 1 (not per file inside it) |
| One session file unreadable, siblings fine | that file absent, siblings present, `unreadableCount` incremented by 1 |
| External symlink (T3) alongside an unreadable dir (this task) | the two counts stay independent — external symlink never enters `unreadableCount` |

## Definition of Done

- [ ] Test for AC-06 (missing `projects/`, no creation) passes.
- [ ] Test for AC-07 (empty `projects/`) passes.
- [ ] Test for AC-08 (mixed readable/unreadable, count-only note data) passes.
- [ ] Zero-write test (before/after snapshot of `fixtures/claude-home`) passes.
- [ ] Perf test (≤50ms on fixtures) passes.
- [ ] `listSessions()` has no code path that throws for a readability reason.
- [ ] `npm run verify` green.
