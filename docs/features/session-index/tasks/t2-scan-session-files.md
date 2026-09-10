---
id: T2
title: "Scan projects/ two levels deep and collect raw session records"
layer: "infra"
deps: []
blocks: ["T3"]
acs: ["AC-01", "AC-10", "AC-13"]
files_hint: ["lib/claude/index.js", "test/session-index.test.js"]
owner: "maintainer"
estimate: "M"
context_budget: "M"
status: "todo"
---

# T2 — Scan projects/ two levels deep and collect raw session records

## Place in the sequence

- **Blocked by:** none — the base walk that T3 (symlink dedup), T4 (sort/limit) and T5 (readability) all build on. **Blocks:** T3 — symlink dedup builds directly on this; T4/T5 are downstream through T3. **Wave:** 1, alongside T1.
- **Lane:** shares `lib/claude/index.js` with T1, T3, T4, T5 — `implement` serializes this whole file; this is the foundation commit the rest layer onto.

## Why (user story)

> **As a** розробник
> **I want** відкрити дашборд і побачити перелік своїх сесій усіх проєктів
> **So that** я бачу, що взагалі є на диску, не обходячи теки руками
>
> — `spec.md §4, US-01, verbatim` · full text: [spec.md](../spec.md)

This task builds the raw data US-01 needs: every session file, found by walking exactly two levels deep, with its metadata — before sorting, limiting or symlink handling exist.

## Inlined context

> Обхід диска рівно дворівневий: тека проєктів, потім файли сесій у кожній теці проєкту; символічні посилання трапляються лише серед записів теки проєктів і дедуплікуються за реальним шляхом, глибше застосунок не спускається.
>
> — `spec.md §1, Context, verbatim` · full text: [spec.md](../spec.md)

> сесія: одна розмова з агентом. На диску це файл `<sessionId>.jsonl` безпосередньо в теці проєкту. Вкладені транскрипти субагентів і результати інструментів належать сесії, але окремими сесіями не є.
>
> — `CONTEXT.md §Glossary, «сесія», verbatim` · full text: [../../../../CONTEXT.md](../../../../CONTEXT.md)

> lstat, not stat: a symlink is not a session, so the oracle must not follow it. ... only `<project>/<sessionId>.jsonl`, not the subagent transcripts nested deeper.
>
> — `test/oracle.js §sessionFiles, comment, verbatim` · full text: [../../../../test/oracle.js](../../../../test/oracle.js)

**Hard rule:** Переліки й індекси будуємо з метаданих файлів: імʼя, розмір, час зміни. Вміст JSONL читаємо лише там, де фіча прямо цього вимагає у своїй специфікації.

— `AGENTS.md §Межі, verbatim` · full text: [../../../../AGENTS.md](../../../../AGENTS.md)

**Fallback:** insufficient or contradicted by the code → read the named file in full
([spec.md](../spec.md) · [sad.md](../sad.md) · [test/oracle.js](../../../../test/oracle.js)) and follow it. Do not guess.

## Data delta

No DB changes.

## API contract

Internal — no API surface. This task adds a scan helper inside `lib/claude/index.js`, not a route.

## Acceptance criteria

### AC-01 — happy path

> **Given** у домашній теці джерела є три теки проєктів, а в них разом шість сесій
> **When** розробник відкриває сторінку переліку
> **Then** він бачить шість рядків, по одному на кожну сесію
>
> — `spec.md §5, AC-01, verbatim` · full text: [spec.md](../spec.md)

### AC-10 — domain invariant

> **Given** під текою проєкту, поряд із файлами сесій, лежать вкладені транскрипти субагентів і результати інструментів
> **When** розробник відкриває сторінку переліку
> **Then** перелік містить лише сесії — файли безпосередньо в теці проєкту з іменем `<sessionId>.jsonl`, як визначено в глосарії `CONTEXT.md`, — і не показує вкладені транскрипти як окремі сесії; запис, який сам є символічним посиланням, сесією не вважається і в переліку не зʼявляється
>
> — `spec.md §5, AC-10, verbatim` · full text: [spec.md](../spec.md)

### AC-13 — happy path (metadata capture half)

> **Given** у теці проєкту лежить сесія з відомими часом зміни і розміром файлу
> **When** розробник дивиться на рядок цієї сесії
> **Then** він бачить час зміни цієї сесії і розмір її файлу, і обидва значення відповідають тому, що лежить на диску
>
> — `spec.md §5, AC-13, verbatim` · full text: [spec.md](../spec.md)
>
> This task covers the capture half (reading real `mtime`/`size` off disk); T7 covers the display half.

## Checklist

- [ ] In `lib/claude/index.js`, add the depth-2 walk: `readdirSync(projectsDir())` for project dirs, then `readdirSync(projectDir)` for entries inside each.
- [ ] Use `lstatSync` (not `stat`) on each depth-2 entry: it must be a regular file, its own name must end in `.jsonl`, and it must not itself be a symlink (`st.isSymbolicLink()` → excluded, satisfies AC-10's last clause) and not a directory (excludes nested subagent-transcript dirs).
- [ ] For each accepted session file, capture `sessionId` (filename without `.jsonl`), the owning project directory name, `size` (`st.size`), and `mtime` (`st.mtime`).
- [ ] Do not read file contents — metadata only, per `AGENTS.md` §Межі.
- [ ] Unit test on `fixtures/claude-home` asserting exactly 6 raw session records, cross-checked against `test/oracle.js`'s `sessionFiles(projectsDir, { exactDepth: 2 })`.
- [ ] Unit test asserting the nested `cccccccc-3333-.../` directory (already in fixtures, sibling of `cccccccc-3333-....jsonl`) contributes no extra record.

## Edge cases

| Case | Behaviour |
|---|---|
| A depth-2 entry named `*.jsonl` that is itself a symlink | excluded — not a session (AC-10) |
| A depth-2 entry that is a directory (subagent transcripts) | excluded — walk does not descend past depth 2 |
| A depth-2 entry not ending in `.jsonl` | excluded |

## Definition of Done

- [ ] Unit test for AC-01 (6 sessions from fixtures) passes.
- [ ] Unit test for AC-10 (nested transcripts + symlinked session file excluded) passes.
- [ ] `mtime`/`size` captured match `lstatSync` truth on the same files (cross-checked with the oracle).
- [ ] Zero content reads — grep confirms no `readFileSync` added for `.jsonl` files in this task's diff.
- [ ] `npm run verify` green.
