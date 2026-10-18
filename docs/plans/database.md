# Plan: the database — stay on SQLite, or move to PostgreSQL?

Status: **decided 2026-10-17: stay on SQLite** (`node:sqlite`, WAL). The owner asked whether a fresh
deployment should go to PostgreSQL; this is the reasoning, so the question is not reopened every
release. Revisit when one of the triggers at the end becomes true.

## What the store does today

- One file, `data/db/factory.sqlite`, opened by the supervisor with Node's built-in `node:sqlite`
  (no native build, no driver, nothing to install). WAL journal, `busy_timeout` 5 s, foreign keys on.
- 17 migrations in `store/db.ts`, applied by `user_version` at start; the schema is ~12 tables:
  conversations, tasks, task_events (the Audit log, the biggest table), rate_limits, schedule_runs,
  seen_items, telegram_chats / telegram_messages, web_sessions, login_attempts, meta.
- One writer, ever: the supervisor process. Readers: the same process (API, bot, scheduler). No
  second service, no analytics job, no replica.
- Load: a task writes a few hundred event rows over minutes; the UI polls lists every 5 s; the
  scheduler ticks every 20 s. Thousands of rows a day, not thousands a second.
- Backups are a file copy (`data/` as a whole is the backup unit: the SQLite file, the Claude
  transcripts, the config files, the inbox). `.backup` / `VACUUM INTO` give a consistent copy while
  the supervisor runs.

## What PostgreSQL would change

| | SQLite today | PostgreSQL |
|---|---|---|
| Processes | 1 container | 2 containers (+ a volume, health check, start order), or a managed DB |
| Driver | built into Node | `pg` (+ a pool, connection errors to handle, reconnects after the DB restarts) |
| Config | none | `DATABASE_URL`, a password in `.env`, `pg_hba`, TLS if off the box |
| Migrations | 17 strings, `user_version` | the same strings rewritten (`AUTOINCREMENT`, `TEXT` dates, `json` columns, `INSERT OR IGNORE`, `strftime`, partial indexes) |
| Store code | synchronous (`node:sqlite`): `store.getTask()` returns the row | every call async; `TaskService`, the bot, the routes and ~500 tests change signature |
| Backups | copy a file with `data/` | `pg_dump` on a schedule + restore drills; `data/` alone is no longer a complete backup |
| Dev on the laptop | `yarn dev` | a local PostgreSQL or a second compose service |
| Memory on the box | ~0 | 100-300 MB resident for a mostly idle server |
| Concurrency | one process; fine | real concurrency the factory does not have (single supervisor, single owner) |

The gains PostgreSQL brings — many writers, remote access, replication, rich SQL, extensions,
row-level security — none is needed by a single-owner supervisor on one box. The costs — a second
service to keep alive, async plumbing through every module, a backup story that is no longer "copy
`data/`" — are paid on every day of operation and on every deploy.

## Why "we redeploy from scratch anyway" does not tip it

A clean install removes the *migration* cost (no data to move), not the *operational* cost (the
second container, the backups, the async rewrite). The rewrite is the expensive part: the store is
synchronous by design, which keeps `TaskService` simple (no interleaving between a check and the
write that follows it). Going async would be a release of its own with no visible change for the
owner.

## When to move (the triggers)

- A second process must write: a separate worker container, a webhook receiver on another host,
  several factories sharing one Audit log.
- The Audit log grows past what one file handles comfortably (tens of millions of rows; today it is
  tens of thousands) and the owner wants ad-hoc analytics over it rather than the UI's filters.
- Remote tooling needs SQL access over the network (Grafana, Metabase). (A read-only copy of the
  SQLite file, or `datasette`, covers the single-user version of this.)
- The factory becomes multi-tenant. (Out of scope by the SPEC's own rule: strictly single-owner.)

## What to do instead, now

- **Backups**: a nightly `sqlite3 data/db/factory.sqlite ".backup data/backups/factory-<date>.sqlite"`
  next to a `tar` of `data/config`, `data/claude/agents|skills`, `data/claude/.credentials.json`;
  keep seven. (CLAUDE.md "Next" has it under Hardening; this is the concrete shape.)
- **Hygiene**: `task_events` is the only table that grows without bound. A retention setting
  (`AUDIT_KEEP_DAYS`, default 0 = keep) with a nightly `DELETE … WHERE ts < ?` and a monthly
  `PRAGMA optimize` keeps the file small for years.
- **Visibility**: `data/db` size in Health next to `data/docker`, so growth is seen before it hurts.
- Keep `store/` synchronous and SQL-flavoured for SQLite; do not add an abstraction layer "in case".
