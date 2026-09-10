---
id: T6
title: "Wire GET / to read, validate and pass through the ?limit query param"
layer: "ports"
deps: ["T5"]
blocks: ["T7"]
acs: ["AC-05", "AC-12"]
files_hint: ["server.js", "test/session-index.test.js"]
owner: "maintainer"
estimate: "S"
context_budget: "S"
status: "todo"
---

# T6 — Wire GET / to read, validate and pass through the ?limit query param

## Place in the sequence

- **Blocked by:** T5 — `listSessions()` must be complete (sort, limit, readability) before the route calls it. **Blocks:** T7 — the view needs the `meta` shape (including `invalidLimitNote`) this task produces. **Wave:** 5.
- **Lane:** own lane — `server.js`, not shared with the `lib/claude/index.js` chain (T1–T5 can be reviewed/merged as one PR, this as the next).

## Why (user story)

> **As a** розробник
> **I want** щоб перелік мав розумну довжину і щоб я міг попросити іншу
> **So that** сторінка лишалася швидкою на теці з тисячами сесій
>
> — `spec.md §4, US-04, verbatim` · full text: [spec.md](../spec.md)

This task delivers the request-side half of US-04: reading `?limit` off the query string, validating it, and handing a trustworthy number to `listSessions()`.

## Inlined context

> Rozrobnyk->>Web: GET / (opt. ?limit=N)
> alt limit nepryynyatnyi (ne chyslo, <=0, abo > 1000)
>     Web->>Web: klampuie limit do typovoho (50), gotuie invalidLimitNote
> else limit korektnyi abo vidsutnii
>     Note over Web: nichoho ne klampuie, limit yak zaproshenyi abo default 50
> end
> Web->>Adapter: listSessions({ limit })
>
> — `sad.md §6, Critical flow 1, abridged` · full text: [../sad.md](../sad.md)

> **Механізм «іншої довжини переліку» (AC-05, spec §8 OQ)** — query-параметр `?limit=N` на `GET /`; неприпустиме значення (не число, ≤0, >1000) не ламає сторінку, а показує типовий ліміт 50 і пояснення простими словами.
>
> — `sad.md §4, Тактичні рішення, verbatim` · full text: [../sad.md](../sad.md)

**Hard rule:** validation lives here in `server.js`, not in the adapter — `listSessions({ limit })` (T4/T5) trusts the number it is given; this task is the only place that decides "invalid → 50 + note".

— `sad.md §5, Internal decomposition, abridged` · full text: [../sad.md](../sad.md)

**Fallback:** insufficient or contradicted by the code → read the named file in full
([spec.md](../spec.md) · [sad.md](../sad.md) · [server.js](../../../../server.js)) and follow it. Do not guess.

## Data delta

No DB changes.

## API contract

Internal — no OpenAPI contract (spec §3 non-goals: no new JSON surface). The only interface change is the existing `GET /` HTML route gaining an optional `?limit` query param; it stays HTML, not JSON.

## Acceptance criteria

### AC-05 — error

> **Given** розробник просить показати перелік із неприпустимою довжиною: не число, нуль, відʼємне значення або значення понад дозволену стелю
> **When** сторінка переліку складається
> **Then** сторінка пояснює простими словами, що значення довжини неприпустиме, і показує перелік типової довжини замість того, щоб не відкритися
>
> — `spec.md §5, AC-05, verbatim` · full text: [spec.md](../spec.md)

### AC-12 — happy path

> **Given** дашборд уже відповідав на службовий запит про свій стан і віддавав сторінку із захисною політикою
> **When** перелік сесій додано
> **Then** службова відповідь про стан і захисна політика сторінки лишаються такими самими, як були
>
> — `spec.md §5, AC-12, verbatim` · full text: [spec.md](../spec.md)

## Checklist

- [ ] In `server.js`, `GET /` reads `req.query.limit`. Parse with `Number(...)`; valid when it is a finite integer, `> 0`, and `<= 1000`.
- [ ] Invalid or absent → use default `50`; when it was present but invalid (not merely absent), also build `invalidLimitNote` (a short, plain-language string, no raw input echoed back) to pass to the view.
- [ ] Valid → pass the parsed number straight through to `listSessions({ limit })`.
- [ ] Call `listSessions({ limit })` from `lib/claude/index.js` and hand `{ sessions, totalFound, truncated, unreadableCount }` plus `invalidLimitNote` to the view (wired fully in T7 — this task can pass a placeholder body until T7 lands, or the two can be one PR).
- [ ] Leave `GET /api/health` and the `Content-Security-Policy` meta tag in `layout()` byte-for-byte unchanged.
- [ ] Test: `?limit=abc`, `?limit=0`, `?limit=-5`, `?limit=1001` each fall back to 50 with a note; `?limit=10` is forwarded as 10; no `?limit` defaults to 50 with no note.
- [ ] Test: `GET /api/health` response and the page's CSP header/meta are identical before and after this change (regression guard for AC-12).

## Edge cases

| Case | Behaviour |
|---|---|
| `?limit=1000` (exactly the ceiling) | valid, forwarded as-is |
| `?limit=1000.5` (non-integer) | invalid → fallback + note |
| `?limit=` (present, empty) | invalid → fallback + note |
| No `?limit` at all | default 50, no note (this is not "invalid", it's "not asked") |

## Definition of Done

- [ ] Test for AC-05 (each invalid form falls back to 50 with a note, page still returns 200) passes.
- [ ] Test for AC-12 (`/api/health` and CSP unchanged) passes.
- [ ] `npm run verify` green.
