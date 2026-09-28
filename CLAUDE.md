# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

Pocket Factory is a **self-hosted layer over Claude Code for developers**: the **unmodified Claude
Code CLI** running in a Docker container on the owner's own server, driven from Telegram and a
small web control plane. The tagline is the product: *an agent becomes truly autonomous the moment
you close your laptop lid*. Four things it adds on top of the CLI, in this order of importance:

1. **Autonomy** — tasks arrive from Telegram (text, voice) or the browser, queue, run as `claude -p`
   sessions in the owner's real checkouts, continue across messages, survive restarts.
2. **Control over what agents do** — the Audit log (every model call, tool call, file edit,
   sub-agent, per agent and project), rendered transcripts, tokens and subscription windows.
3. **Management** — agents, skills and projects as Markdown files edited in the UI or by the agent;
   presets; live model and tool lists.
4. **Pipelines** — skills chaining sub-agents into repeatable flows; schedules and pollers next.

Full concept, decisions and roadmap: `docs/SPEC.md` (read it first; §4.4 session lifecycle and §8
security are the load-bearing parts).

Owner: Misha Topchilo. Single-owner tool; a fork uses the forker's own subscription and bot.

## Commands

```bash
yarn install                 # Yarn 4 workspaces (corepack)
yarn typecheck               # tsc --noEmit for all workspaces
yarn build                   # supervisor → supervisor/dist, web → web/dist
yarn dev                     # supervisor + API on :8080 on the host (reads .env itself, CLAUDE_CONFIG_DIR=data/claude)
TELEGRAM_BOT_TOKEN= yarn dev # web-only: use this while the container runs, or Telegram answers 409 to both pollers
yarn dev:web                 # Vite dev server on :5173 proxying /api → :8080
docker compose up -d --build # build image + (re)start the supervisor container
docker compose logs -f supervisor
docker compose run --rm supervisor claude -p "Reply with exactly: OK" --model haiku --max-turns 1   # auth smoke test
```

No test runner yet; smoke-test through the API (`curl localhost:8080/api/status`) or a scratch
tsx script against `TaskService`. Lint/prettier not configured yet — follow the portfolio repo's
style (4-space indent, single quotes, no trailing commas, 120 cols). For eyeballing the UI use
`node scripts/screenshot.mjs <url> out.png` (DevTools protocol, no browser deps); plain
`chrome --headless=new --screenshot` also works except on the Chat page, whose SSE stream keeps
the load event from ever firing. Chrome's window is never narrower than 500px, so that is the
"phone" width.

## Layout

- `supervisor/src/` — TypeScript, ESM (`"type": "module"`, NodeNext → import with `.js` suffix)
  - `index.ts` bootstrap (loads `.env`, wires everything); `config.ts` env parsing
  - `store/` SQLite via `node:sqlite` (no native build): `conversations`, `tasks`, `task_events`;
    migrations in `db.ts`
  - `tasks/service.ts` — **the session manager**: one queue for all channels, spawn `claude -p` per
    task, one running task per conversation, `MAX_CONCURRENT_SESSIONS` overall; emits `task` /
    `event` for Telegram delivery and SSE
  - `claude/runner.ts` spawns `claude -p --output-format stream-json`, surfaces text / tool_use /
    tool_result blocks and the final `result`
  - `bot.ts` grammY bot (text + voice), `stt/groq.ts` Whisper, `telegram/format.ts` Markdown → HTML
  - `files/catalog.ts` agents / skills / projects as Markdown+frontmatter; `sessions/transcripts.ts`
    indexes Claude Code JSONL; `presets/`
  - `web/routes/audit.ts` — the audit log: `task_events` carry `agent` (sub-agent type, null =
    orchestrator) and `parent_tool_use_id`; the runner emits `llm` (one per model call), `agent`
    (sub-agent started / completed, from the CLI's `task_started` / `task_notification` system
    events) and `limits` events besides text / tool calls. Project per task is detected from
    workspace names in tool-call inputs
  - `web/` Hono server: basic auth, `/api/*` routes, serves `web/dist`
- `web/src/` — Vite + React SPA, no UI framework, one `styles.css`; `lib/api.ts` typed client,
  `components/Editor.tsx` shared list+form for agents/skills/projects, pages per screen.
  Every list is keyset-paged (`lib/usePaged.ts` + `components/LoadMore.tsx` sentinel): tasks and
  sessions by timestamp, audit by event id, chat threads and transcripts load older items on
  demand; polling refreshes only the first page
- `templates/claude/` — seeded into `data/claude/` on **every** container start with `cp -n`: new
  files appear, edited files are never overwritten. On the host, copy by hand the same way.
- `presets/<name>/` — `preset.json` + `agents/` `skills/` `projects/`; installed from the UI
- `docker/entrypoint.sh` — seeds `/data`, git identity + `safe.directory '*'`, `gh auth setup-git`,
  links `/data/secrets/ssh` → `~/.ssh`
- `data/` — runtime state, gitignored, bind-mounted; `WORKSPACES_DIR` in `.env` points the container
  (and `yarn dev`) at the owner's existing repositories

## Decisions already made (don't re-open)

- Agent runtime = `claude` CLI subprocess, never the Agent SDK with a stored token (ToS, see SPEC §8).
- Auth = `claude setup-token` on a laptop → `CLAUDE_CODE_OAUTH_TOKEN` in `.env`. Interactive `/login`
  inside the container is broken upstream (anthropics/claude-code#34917).
- Agent works inside the owner's real checkouts on a branch (no worktrees, no re-cloning).
- GitHub auth = fine-grained PAT (`GH_TOKEN`), never mounted SSH keys.
- Default model `sonnet`; cheaper models only for mechanical sub-agents later.
- Agents, skills and projects live only in `data/` (gitignored); `templates/` and `presets/` are the
  install-time seed. There is no config git history any more: what an agent did, including edits
  to its own files or to a repository, is the Audit log (built live from stream-json, never from
  transcripts after the fact).
- No money in the UI or Telegram: the owner pays a subscription, so tasks report **tokens** (cache
  included) and their share of the **5-hour window**; screens show the 5-hour / weekly windows from
  the CLI's `rate_limit_event` (stream-json, `unifiedWindows`). `/api/oauth/usage` needs the
  `user:profile` scope that a setup-token lacks, so there is no polling — readings come with every
  task, plus an explicit probe (one Haiku turn: Overview → Refresh, Telegram `/usage refresh`).
  `cost_usd` stays in the DB for the record; `CLAUDE_MAX_BUDGET_USD` stays as a safety stop.
- Unknown `/commands` never reach the agent; replies are converted to Telegram HTML with plain-text
  fallback.
- Single language: TypeScript for supervisor, API and UI. No Python service (asked and answered:
  it would add a runtime and duplicate the types for nothing).
- Web UI is a Vite SPA served by the supervisor, not a separate Next.js service: one container, no SSR.
- UI theme: light, Guild.ai-like (paper background, dot grid, mono font, pastel pills, icon tiles).
  Tokens live in `web/src/styles.css`; no UI framework, keep it that way. Icons are `lucide-react`
  (an icon set, not a framework) mapped once in `components/Icon.tsx`: the sidebar, `Tile` and
  card heads all draw the same icon for the same concept (chat = speech bubble, agents = bot,
  audit = clipboard, sessions = document, limits = gauge). A tile never changes size for its
  content; agents get a pixel mascot instead of an icon. The chat thread (`components/AssistantTurn.tsx`)
  renders one task as one exchange: a dark user bubble, then the agent's turn as a card with the
  orchestrator avatar, prose kept as prose and every run of tool calls / sub-agents folded into a
  "N steps" block (open while running). The view auto-follows only while scrolled to the bottom
  ("New messages" button otherwise); the composer grows with the draft, Enter sends. Code is
  highlighted with `highlight.js` (core build + the languages in `lib/highlight.ts`, theme in
  `styles.css` on the palette tokens): fenced blocks in Markdown via the `marked` renderer, and
  unfolded tool calls render an Edit as a diff, a Write as the file in its language, Bash as the
  command, the rest as JSON. Markdown / text files stay plain on purpose.
- Telegram is optional (`TELEGRAM_BOT_TOKEN` empty = web-only).
- Project files carry `hosts:` (SSH targets) for sub-agents; keys live in `data/secrets/ssh`, mounted
  read-only. GitHub still goes through the PAT, never SSH.
- The owner decides when to commit — never commit unprompted. When asked to commit: no
  `Co-Authored-By` lines.

## Status (2026-09-28, evening)

Phases 0–4 of the spec are implemented (see git log): Telegram text + voice, SQLite task queue /
session manager, web UI with chat, transcripts, editors for agents / skills / projects, presets.
The Docker image is built and the container runs with the web UI. Cost is gone from every screen:
tasks report tokens and their share of the 5-hour window, Overview and the sidebar show the
subscription windows (schema v2: `rate_limits` table, cache token columns). The History page and
the config git repos are gone; the Audit log (schema v3: `agent` / `parent_tool_use_id` on events,
`project` on tasks) lists every model call, tool call and sub-agent per agent and project.
All lists page dynamically; Sessions shows the real cwd / project instead of Claude Code's
`-Users-...` directory slug. Conversations can be deleted from Chat (schema v4 `deleted_at`,
soft: tasks, events and transcripts stay for the audit log; refused while a task is active).
Agents is a card grid (pixel mascots in `components/Sprite.tsx`, runs / tokens / status from
`/api/activity/agents`) and Overview has a "Team agents" roster; both link into the Audit log
with `?agent=` preset (Audit filters live in the URL). Built-in Claude Code agent types (Explore,
Plan, …) appear in the roster once the audit log has seen them. The shared file editor
(`components/Editor.tsx`, agents / skills / projects) fills the viewport: list and form scroll
independently, header with Save stays; ⌘S saves, Tab indents, Edit / Preview for the body, unsaved
changes guard list navigation. The agent Model select lists the CLI aliases plus the live models
from `GET https://api.anthropic.com/v1/models` called with the same OAuth token (read-only
metadata, `anthropic-beta: oauth-2025-04-20`, cached an hour in `web/routes/models.ts`); this is
the one direct API call the supervisor makes and it never does inference — the ToS rule in §8
stays. The Tools field is a chip picker: a fixed list of common tool names first (the CLI's own
`init` list names harness internals and omits lazily loaded Grep / Glob), then everything the CLI
reported at its last session start (schema v5 `meta` table, key `claude.tools`, refreshed by every
task and probe), plus a text field for MCP tool names. Empty `tools:` = inherit all.
`yarn dev` now runs from the repository root (same cwd as the container), so `.env`, `data/`,
`web/dist` and `presets/` resolve identically.

Not done / next:

1. Verify `git push` + `gh pr create` from the container with `GH_TOKEN`.
2. First real project file (let `onboard-project` draft it) and a real feature-to-pr run.
3. Phase 5: schedules + prefilters (TRAC poller, GitHub review requests) — `source: cron` is
   already in the tasks table.
4. Phase 6: quota estimate, budgets / soft-stop, backups; web-side notifications to Telegram.
5. Nice-to-haves: project selector in Chat (conversations already carry `project`), CodeMirror in
   editors, audit log export.
