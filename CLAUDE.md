# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

Pocket Factory — a personal software factory: the **unmodified Claude Code CLI** running in a
Docker container, driven from Telegram. Full concept, decisions and roadmap: `docs/SPEC.md`
(read it first; §4.4 session lifecycle and §8 security are the load-bearing parts).

Owner: Misha Topchilo. Single-owner tool; a fork uses the forker's own subscription and bot.

## Commands

```bash
yarn install                 # Yarn 4 workspaces (corepack)
yarn typecheck               # tsc --noEmit for all workspaces
yarn dev                     # supervisor on the host with tsx watch (uses host claude login)
docker compose up -d --build # build image + (re)start the supervisor container
docker compose logs -f supervisor
docker compose run --rm supervisor claude -p "Reply with exactly: OK" --model haiku --max-turns 1   # auth smoke test
```

No test runner yet. Lint/prettier not configured yet — follow the portfolio repo's style
(4-space indent, single quotes, no trailing commas, 120 cols).

## Layout

- `supervisor/src/` — TypeScript, ESM (`"type": "module"`, NodeNext → import with `.js` suffix)
  - `index.ts` bootstrap; `config.ts` env parsing; `bot.ts` grammY bot; `claude/runner.ts` spawns
    `claude -p --output-format stream-json` and parses `init` / `assistant` / `result` events;
    `telegram/format.ts` Markdown → Telegram HTML
- `templates/claude/` — seeded into `data/claude/` (= `CLAUDE_CONFIG_DIR`) on first container start
  only. Editing a template does **not** update a running install; copy it over `data/claude/` by hand.
- `docker/entrypoint.sh` — seeds `/data`, sets git identity + `safe.directory '*'`, `gh auth setup-git`
- `data/` — runtime state, gitignored, bind-mounted; `WORKSPACES_DIR` in `.env` points the container
  at the owner's existing repositories (`/data/workspaces/<project>`)

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
- The owner decides when to commit — never commit unprompted.

## Status

Phase 0 done and verified end-to-end (2026-09-27): Telegram text → `claude -p` in `/data/workspaces`
→ formatted reply with turns/cost/time; per-chat session continuity via `--resume`; `/new`, `/stop`,
`/status`. Nothing committed yet.

## Next (Phase 1, agreed order)

1. `data/config/projects/<project>.md` — project knowledge files (let the agent draft the first one)
2. `GH_TOKEN` in `.env`; verify `git push` + `gh pr create` from the container
3. Sub-agents `developer` / `reviewer` in `templates/claude/agents/`, `feature-to-pr` skill
4. Voice messages → STT (Groq Whisper) → same task path
Then Phase 2 (SQLite task queue, idle timeout, `/done`) and Phase 3 (read-only web UI).
