---
id: T1
title: "Derive a project label from the encoded project directory name"
layer: "domain"
deps: []
blocks: ["T7"]
acs: ["AC-02", "AC-02b"]
files_hint: ["lib/claude/index.js", "test/session-index.test.js"]
owner: "maintainer"
estimate: "S"
context_budget: "S"
status: "todo"
---

# T1 — Derive a project label from the encoded project directory name

## Place in the sequence

- **Blocked by:** none — pure function, no dependency on the scan. **Blocks:** T7 — render the session index view (needs the label shape). **Wave:** 1, can start immediately alongside T2.
- **Lane:** shares `lib/claude/index.js` with T2–T5 — `implement` serializes edits to that file regardless of this task's empty `deps`, so it still lands before or right alongside T2 in commit order.

## Why (user story)

> **As a** розробник
> **I want** бачити в кожному рядку, до якого проєкту належить сесія
> **So that** я відрізняю сесії різних робочих тек, не відкриваючи файл
>
> — `spec.md §4, US-02, verbatim` · full text: [spec.md](../spec.md)

This task delivers the one pure function that turns an opaque project-directory name into the label US-02 needs — everything downstream (T7's table) just displays what this returns.

## Inlined context

> проєкт: тека проєкту в домашній теці джерела. Її імʼя це закодований шлях до робочої теки, який однозначно не відновлюється; людині показуємо відновлений шлях із позначкою, що він похідний.
>
> — `CONTEXT.md §Glossary, «проєкт», verbatim` · full text: [../../../CONTEXT.md](../../../../CONTEXT.md)

> Простежуваність. Межі взяті з `AGENTS.md` §Межі ... і з `CONTEXT.md` §Glossary (сесія це файл безпосередньо в теці проєкту, вкладені транскрипти сесіями не є; проєкт показуємо як відновлений шлях із позначкою «похідний»).
>
> — `spec.md §1, Context, abridged` · full text: [spec.md](../spec.md)

**Hard rule:** значення з даних (імена проєктів, назви сесій, шляхи) пропускай через `esc()` — застосовується у T7, коли цей label потрапляє на сторінку, not here; this task only produces the string.

— `.claude/rules/views.md, verbatim` · full text: [../../../../.claude/rules/views.md](../../../../.claude/rules/views.md)

**Fallback:** insufficient or contradicted by the code → read the named file in full
([spec.md](../spec.md) · [sad.md](../sad.md) · [CONTEXT.md](../../../../CONTEXT.md)) and follow it. Do not guess.

## Data delta

No DB changes.

## API contract

Internal — no API surface. Pure function, no HTTP involvement.

## Acceptance criteria

### AC-02 — happy path

> **Given** сесія лежить у теці проєкту, назва якої є закодованим шляхом до робочої теки
> **When** розробник дивиться на рядок цієї сесії
> **Then** він бачить відновлений шлях проєкту разом із позначкою, що шлях похідний і точно не відновлюється
>
> — `spec.md §5, AC-02, verbatim` · full text: [spec.md](../spec.md)

### AC-02b — edge case

> **Given** назва теки проєкту не схожа на закодований шлях до робочої теки
> **When** розробник дивиться на рядок цієї сесії
> **Then** він бачить назву теки як є, з тією самою позначкою, що шлях похідний і точно не відновлюється
>
> — `spec.md §5, AC-02b, verbatim` · full text: [spec.md](../spec.md)

## Checklist

- [ ] Add a pure function (e.g. `deriveProjectLabel(dirName)`) in `lib/claude/index.js` that decodes an encoded directory name (fixture example: `-Users-demo-sources-checkout-api` → `/Users/demo/sources/checkout-api`) and always returns `{ label, derived: true }` — `derived` marks the value as reconstructed and not guaranteed accurate.
- [ ] When the directory name does not look like an encoded path, return it unchanged as `label`, still with `derived: true` — the marker does not depend on whether decoding "worked".
- [ ] Unit tests in `test/session-index.test.js` for both branches, using `fixtures/claude-home/projects/-Users-demo-sources-checkout-api` as the encoded-path case and a synthetic plain name (e.g. `"my-project"`) for the fallback case.

## Edge cases

| Case | Behaviour |
|---|---|
| Directory name with no leading `-` / no path-like separators (e.g. `"scratch"`) | returned as-is for `label`, `derived: true` |
| Directory name that decodes to an empty or all-separator string | returned as-is for `label` (no crash, no empty string presented as a path) |

## Definition of Done

- [ ] Unit test for AC-02 (fixture-derived encoded name) passes.
- [ ] Unit test for AC-02b (non-path-like name) passes.
- [ ] The function is pure — no `node:fs` call — so it needs no fixture I/O to test.
- [ ] `npm run verify` green.
