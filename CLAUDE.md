# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

Pocket Factory — a personal software factory: the **unmodified Claude Code CLI** running in a
Docker container, driven from Telegram and a small web control plane. Full concept, decisions and
roadmap: `docs/SPEC.md` (read it first; §4.4 session lifecycle and §8 security are the load-bearing
parts).

Owner: Misha Topchilo. Single-owner tool; a fork uses the forker's own subscription and bot.

## Commands

```bash
yarn install                 # Yarn 4 workspaces (corepack)
yarn typecheck               # tsc --noEmit for all workspaces
yarn build                   # supervisor → supervisor/dist, web → web/dist
yarn dev                     # supervisor + API on :8080 on the host (reads .env itself, CLAUDE_CONFIG_DIR=data/claude)
yarn dev:web                 # Vite dev server on :5173 proxying /api → :8080
docker compose up -d --build # build image + (re)start the supervisor container
docker compose logs -f supervisor
docker compose run --rm supervisor claude -p "Reply with exactly: OK" --model haiku --max-turns 1   # auth smoke test
```

No test runner yet; smoke-test through the API (`curl localhost:8080/api/status`) or a scratch
tsx script against `TaskService`. Lint/prettier not configured yet — follow the portfolio repo's
style (4-space indent, single quotes, no trailing commas, 120 cols). Headless Chrome
(`/Applications/Google Chrome.app/...` `--headless=new --screenshot`) works for eyeballing the UI;
the Chat page keeps an SSE connection open, so give it a timeout.

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
  - `files/catalog.ts` agents / skills / projects as Markdown+frontmatter; `files/history.ts` git
    repos on `data/claude` (CLAUDE.md, agents, skills only) and `data/config`, auto-commit on UI
    save and after each task; `sessions/transcripts.ts` indexes Claude Code JSONL; `presets/`
  - `web/` Hono server: basic auth, `/api/*` routes, serves `web/dist`
- `web/src/` — Vite + React SPA, no UI framework, one `styles.css`; `lib/api.ts` typed client,
  `components/Editor.tsx` shared list+form for agents/skills/projects, pages per screen
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
- Default model `sonnet`; cheaper models only for mechanical sub-agents later. The cost shown in
  Telegram is the CLI's list-price estimate (quota on a subscription, not money).
- Unknown `/commands` never reach the agent; replies are converted to Telegram HTML with plain-text
  fallback.
- Single language: TypeScript for supervisor, API and UI. No Python service (asked and answered:
  it would add a runtime and duplicate the types for nothing).
- Web UI is a Vite SPA served by the supervisor, not a separate Next.js service: one container, no SSR.
- Project files carry `hosts:` (SSH targets) for sub-agents; keys live in `data/secrets/ssh`, mounted
  read-only. GitHub still goes through the PAT, never SSH.
- The owner decides when to commit — never commit unprompted. When asked to commit: no
  `Co-Authored-By` lines.

## Status (2026-09-28)

Phases 0–4 of the spec are implemented in one pass (see git log): Telegram text + voice, SQLite
task queue / session manager, web UI with chat, transcripts, editors for agents / skills / projects,
presets, config git history. Verified on the host (`yarn dev` + curl + headless Chrome); the Docker
image with the web build has **not** been built yet (daemon was down) — run
`docker compose up -d --build` and check `/api/status` first thing.

Not done / next:

1. Build the image, verify `git push` + `gh pr create` from the container with `GH_TOKEN`.
2. First real project file (let `onboard-project` draft it) and a real feature-to-pr run.
3. Phase 5: schedules + prefilters (TRAC poller, GitHub review requests) — `source: cron` is
   already in the tasks table.
4. Phase 6: quota estimate, budgets / soft-stop, backups; web-side notifications to Telegram.
5. Nice-to-haves: revert button on History, project selector in Chat, CodeMirror in editors.
