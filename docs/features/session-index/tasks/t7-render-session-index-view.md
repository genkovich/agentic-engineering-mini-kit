---
id: T7
title: "Render the session index table, empty state and notes"
layer: "ui"
deps: ["T1", "T6"]
blocks: []
acs: ["AC-01", "AC-02", "AC-02b", "AC-03", "AC-03b", "AC-04", "AC-05", "AC-06", "AC-07", "AC-08", "AC-11", "AC-13"]
files_hint: ["views/session-index.js", "server.js", "test/session-index.test.js"]
owner: "maintainer"
estimate: "M"
context_budget: "M"
status: "todo"
---

# T7 — Render the session index table, empty state and notes

## Place in the sequence

- **Blocked by:** T1 — project label shape; T6 — the `{ sessions, totalFound, truncated, unreadableCount, invalidLimitNote }` payload this view renders. **Blocks:** none — last task in the feature.
- **Lane:** own lane for `views/session-index.js` (new file); touches `server.js` only to swap the placeholder body for `renderSessionIndex(...)`, which is why T6 must land first.

## Why (user story)

> **As a** розробник
> **I want** щоб дашборд показував лише те, що лежить у домашній теці джерела, і лише метадані
> **So that** локальний інструмент не ставав переглядачем чужих тек і не виносив на екран текст моїх розмов
>
> — `spec.md §4, US-07, verbatim` · full text: [spec.md](../spec.md)

This task is where every earlier task's data becomes the page the developer actually reads — the table, the empty state, and the notes, with `esc()` on every value and never a fragment of conversation text.

## Inlined context

> `views/session-index.js    # NEW: pure render function — table markup + empty()/error notes, esc() everything`
>
> — `sad.md §5, Internal decomposition, verbatim` · full text: [../sad.md](../sad.md)

> `views/session-index.js` імпортує `esc`/`empty` з `views/layout.js` для рендеру таблиці й порожнього стану — це робить його **другим споживачем** `views/layout.js` ... Сам `views/layout.js` не змінюється — лише зʼявляється другий імпортер його наявних експортів.
>
> — `sad.md §5, building block view, verbatim` · full text: [../sad.md](../sad.md)

> Значення з даних (імена проєктів, назви сесій, шляхи) пропускай через `esc()`. `body`, `nav` і `head` вставляються як готовий HTML, тому екранування лежить на тому, хто їх збирає. ... Порожній стан показуй через `empty()`. Власний абзац для цього не пиши.
>
> — `.claude/rules/views.md, verbatim` · full text: [../../../../.claude/rules/views.md](../../../../.claude/rules/views.md)

**Hard rule:** у рядку сесії видно лише проєкт, ідентифікатор сесії, розмір і час зміни, і жодного фрагмента тексту розмови на сторінці немає (AC-11) — the view must not accept or render anything beyond that shape, even if a future caller passes more.

— `spec.md §5, AC-11, verbatim` · full text: [spec.md](../spec.md)

**Resolved open questions (spec §8, defaults already agreed):** file size shown human-readable (KB/MB) in the cell, exact byte count in a `title` attribute; modification time shown as absolute local time (not relative) — chosen because it is stable across test runs and does not depend on when the page happens to be opened.

— `spec.md §8, Open questions, abridged` · full text: [spec.md](../spec.md)

**Fallback:** insufficient or contradicted by the code → read the named file in full
([spec.md](../spec.md) · [sad.md](../sad.md) · [views/layout.js](../../../../views/layout.js) · [views/AGENTS.md](../../../../views/AGENTS.md)) and follow it. Do not guess.

## Data delta

No DB changes.

## API contract

Internal — no API surface. This is a server-rendered HTML view, no JSON.

## Acceptance criteria

### AC-01 — happy path

> **Given** у домашній теці джерела є три теки проєктів, а в них разом шість сесій
> **When** розробник відкриває сторінку переліку
> **Then** він бачить шість рядків, по одному на кожну сесію
>
> — `spec.md §5, AC-01, verbatim` · full text: [spec.md](../spec.md)

### AC-02 / AC-02b — project label display

> Він бачить відновлений шлях проєкту разом із позначкою, що шлях похідний і точно не відновлюється. / він бачить назву теки як є, з тією самою позначкою.
>
> — `spec.md §5, AC-02 + AC-02b, abridged` · full text: [spec.md](../spec.md)

### AC-03 / AC-03b — ordering is a pass-through

> Сесії йдуть від найсвіжішої до найстарішої за часом зміни. / ... впорядковані за іменем файлу сесії як вторинним ключем.
>
> — `spec.md §5, AC-03 + AC-03b, abridged` · full text: [spec.md](../spec.md)
>
> The view renders `sessions` in the order it receives them (T4 already sorted) — no re-sorting here.

### AC-04 — truncation note

> Він бачить пʼятдесят найсвіжіших сесій і повідомлення про те, скільки сесій знайдено всього ... до обрізання; це повідомлення зʼявляється саме тому, що перелік обрізано лімітом
>
> — `spec.md §5, AC-04, verbatim` · full text: [spec.md](../spec.md)

### AC-05 — invalid limit note

> Сторінка пояснює простими словами, що значення довжини неприпустиме, і показує перелік типової довжини замість того, щоб не відкритися
>
> — `spec.md §5, AC-05, verbatim` · full text: [spec.md](../spec.md)

### AC-06 / AC-07 — empty state

> Сторінка відкривається, показує порожній стан із повним шляхом теки, яку читала, і не створює цю теку. / Він бачить той самий порожній стан, а не помилку.
>
> — `spec.md §5, AC-06 + AC-07, abridged` · full text: [spec.md](../spec.md)

### AC-08 — unreadable-count note

> Він бачить сесії з того, що прочиталося ..., і примітку про кількість непрочитаних елементів джерела, без шляхів і без тексту системної помилки
>
> — `spec.md §5, AC-08, verbatim` · full text: [spec.md](../spec.md)

### AC-11 — domain invariant

> У рядку сесії видно лише проєкт, ідентифікатор сесії, розмір і час зміни, і жодного фрагмента тексту розмови на сторінці немає
>
> — `spec.md §5, AC-11, verbatim` · full text: [spec.md](../spec.md)

### AC-13 — display half

> Він бачить час зміни цієї сесії і розмір її файлу, і обидва значення відповідають тому, що лежить на диску
>
> — `spec.md §5, AC-13, verbatim` · full text: [spec.md](../spec.md)

## Checklist

- [ ] Create `views/session-index.js` exporting a pure `renderSessionIndex({ sessions, totalFound, truncated, unreadableCount, invalidLimitNote, claudeHome })` function returning an HTML string (template strings, like `views/layout.js`).
- [ ] Import `esc` and `empty` from `views/layout.js`; run every data-sourced value (project label, `sessionId`, formatted size, formatted mtime) through `esc()`.
- [ ] When `sessions.length === 0`, render `empty(...)` with a message that includes the full `claudeHome` path when the reason is "projects/ does not exist or has nothing in it" (AC-06/AC-07) — no separate hand-rolled empty paragraph.
- [ ] When `sessions.length > 0`, render a table: columns project (label + "похідний" marker), session id, size (human-readable, e.g. `"12.4 KB"`, with exact byte count in a `title` attribute), mtime (absolute local time string).
- [ ] When `truncated`, render a note near the table stating `totalFound` and the shown count (AC-04).
- [ ] When `invalidLimitNote` is present, render it near the top of the body (AC-05).
- [ ] When `unreadableCount > 0`, render a note with only the count — no path, no error text (AC-08).
- [ ] Wire `server.js`'s `GET /` to call `renderSessionIndex(...)` instead of the current `empty('No slice is wired up yet.')` placeholder, inside the existing `layout({...})` call — CSP and overall page chrome unchanged (AC-12, already covered by T6's test, re-verify here).
- [ ] Update `views/AGENTS.md` — the "Єдиний споживач це `server.js:6`" line no longer holds; `views/session-index.js` is a second consumer.
- [ ] Integration tests via `startServer()` (`test/session-index.test.js`) covering: 6 fixture sessions render as 6 rows (AC-01); encoded vs. plain project dir names both show the derived marker (AC-02/AC-02b); an empty `projects/` renders `empty()` with the `claudeHome` path (AC-06/AC-07); a response body never contains a literal string pulled from a fixture session's JSONL conversation content (AC-11).

## Edge cases

| Case | Behaviour |
|---|---|
| `unreadableCount === 0` | no unreadable note rendered at all (not "0 unreadable") |
| `truncated === false` | no truncation note rendered |
| `invalidLimitNote` absent | no note rendered |
| Project label contains HTML-special characters (e.g. a directory name with `<` in it) | escaped by `esc()`, not rendered as markup |

## Definition of Done

- [ ] Test for AC-01 (6 rows) passes.
- [ ] Test for AC-02 / AC-02b (label + derived marker, both branches) passes.
- [ ] Test for AC-04 (truncation note with counts) passes.
- [ ] Test for AC-05 (invalid-limit note) passes.
- [ ] Test for AC-06 / AC-07 (empty state, path shown, no directory created) passes.
- [ ] Test for AC-08 (unreadable-count note, no path/error text) passes.
- [ ] Test for AC-11 (no conversation text anywhere in the response body) passes.
- [ ] Test for AC-13 (size + mtime rendered, matching disk truth) passes.
- [ ] `views/AGENTS.md` updated to reflect the second consumer of `views/layout.js`.
- [ ] `npm run verify` green.
