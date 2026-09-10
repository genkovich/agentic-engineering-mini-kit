# Tracker — session-index

> Status of every task in the epic. `implement` updates `done` as it commits each task.
> States: `todo` · `in_progress` · `blocked` · `review` · `done`.

| # | Task | Layer | Owner | Estimate | Blocked by | Status |
|---|---|---|---|---|---|---|
| T1 | Derive a project label from the encoded project directory name | domain | maintainer | S | — | todo |
| T2 | Scan projects/ two levels deep and collect raw session records | infra | maintainer | M | — | todo |
| T3 | Deduplicate project-dir symlinks by realpath and reject external targets | infra | maintainer | M | T2 | todo |
| T4 | Sort sessions by mtime desc with filename tie-break and truncate to limit | infra | maintainer | S | T3 | todo |
| T5 | Make the scan best-effort: skip unreadable entries, count them, never throw | infra | maintainer | M | T4 | todo |
| T6 | Wire GET / to read, validate and pass through the ?limit query param | ports | maintainer | S | T5 | todo |
| T7 | Render the session index table, empty state and notes | ui | maintainer | M | T1, T6 | todo |

**Total:** 7 tasks, ~1 week (feature size S, 2–5 PRs per `sad.md` §2 Organisational).
