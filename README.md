# Pocket Factory

> Your agent becomes autonomous when you close your laptop.

A personal software factory: the unmodified [Claude Code](https://code.claude.com) CLI running on
your own server, driven from Telegram by text or voice and from a small web control plane. You send
a task from the road; the factory works in your repositories, opens pull requests and reports back.

Single-owner by design. You log in to Claude Code with **your own subscription**, create **your own**
Telegram bot, use **your own** GitHub token, point it at **your own** repositories. Nothing is shared,
proxied or stored by anyone else. See [docs/SPEC.md](docs/SPEC.md) for the concept and roadmap.

## What it does today

- **Telegram** — text and voice (Whisper on Groq) → `claude -p` in your workspaces → reply with
  turns / cost / time. Replies continue the same Claude Code session; `/new`, `/stop`, `/status`.
- **Task queue** — every channel goes through one SQLite queue; one running task per conversation,
  a configurable number overall; tasks survive supervisor restarts.
- **Web UI** — Overview (queue, spend, health), Tasks, Chat with Claude Code from the browser with
  live output, Sessions (rendered Claude Code transcripts), editors for **Agents**, **Skills** and
  **Projects**, **Presets**, **History**, Settings.
- **Factory files** — sub-agents `developer` / `reviewer`, skills `feature-to-pr` /
  `onboard-project`, one Markdown file per project (repo, branches, checks, tracker, hosts).
  The UI, the owner and the agent edit the same files; every change is a git commit on the volume.
- **Presets** — shareable bundles under `presets/` (`bug-tracker-fixer`, `pr-review`) that a
  colleague installs with one click into their own factory.

## Quick start

Requirements: Docker, a Claude subscription, a Telegram bot token from
[@BotFather](https://t.me/BotFather), your Telegram user id (ask
[@userinfobot](https://t.me/userinfobot)), a GitHub fine-grained PAT for the repositories the
factory may touch.

```bash
git clone https://github.com/miksrv/pocket-factory.git
cd pocket-factory
cp .env.example .env          # TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS, WORKSPACES_DIR, GH_TOKEN, WEB_AUTH_PASSWORD
claude setup-token            # on your laptop: prints a token — put it into .env as CLAUDE_CODE_OAUTH_TOKEN
docker compose up -d --build
docker compose logs -f supervisor
```

`claude setup-token` needs a browser, so run it on your laptop, not on the server. Interactive
`/login` inside the container is currently broken upstream
([anthropics/claude-code#34917](https://github.com/anthropics/claude-code/issues/34917)).

Then:

1. Open the web UI: `http://<server>:8080` (bound to localhost by default — use an SSH tunnel or
   Tailscale, or set `WEB_BIND=0.0.0.0` together with `WEB_AUTH_PASSWORD`).
2. **Projects → New**, or tell the bot *"connect project X"* and let the `onboard-project` skill
   write the file after inspecting the checkout.
3. Send the bot a task: *"In astronomy-portal change photo URLs from ids to SEO slugs"*.

## Layout

```
data/                    runtime state — everything the factory owns, all bind-mounted, gitignored
├── claude/              Claude Code home: CLAUDE.md, agents/, skills/, transcripts (git repo for the first three)
├── config/projects/     one Markdown file per connected project (git repo)
├── workspaces/          repositories (or WORKSPACES_DIR → a folder you already have)
├── secrets/ssh/         keys for project hosts, linked to ~/.ssh in the container
├── db/                  SQLite: conversations, tasks, task events
└── logs/
supervisor/              Telegram bot, task queue / session manager, HTTP API (TypeScript, Node 22)
web/                     admin UI (Vite + React), built into the image and served by the supervisor
templates/claude/        seeded into data/claude on every start (never overwrites your edits)
presets/                 shareable agent + skill bundles, installable from the UI
docs/SPEC.md             requirements & roadmap
```

Moving to another host is `rsync data/` + `docker compose up`.

## How a task flows

```
Telegram / web ──► tasks queue (SQLite) ──► claude -p --resume <session>  (cwd = workspaces)
                                              │  reads  data/claude/CLAUDE.md          dispatcher rules
                                              │  reads  data/config/projects/<p>.md    project facts
                                              │  loads  skills/feature-to-pr           the procedure
                                              │  spawns agents/developer, agents/reviewer
                                              └─► git push · gh pr create · report back
```

Sub-agents may reach the servers listed under `hosts:` in a project file over SSH with the keys in
`data/secrets/ssh/`; read-only inspection is allowed, changes need an explicit "yes" from you.

## Voice

Set `GROQ_API_KEY` in `.env` (free tier is enough). Voice notes are transcribed with
`whisper-large-v3-turbo`, echoed back as text and queued like a typed message. `STT_LANGUAGE=ru`
(or any ISO code) improves accuracy for a single language.

## Sharing with colleagues

Fork the repository, add your team's agents and skills under `presets/`, commit. Every colleague
runs their own factory from the fork with their own Claude login, bot and token, and installs the
presets from the UI. See [presets/README.md](presets/README.md).

## Development without Docker

```bash
corepack enable
yarn install
cp .env.example .env          # the supervisor reads it itself
yarn dev                      # supervisor + API on :8080, uses the claude CLI from your PATH
yarn dev:web                  # Vite dev server on :5173, proxies /api to :8080
```

`CLAUDE_CONFIG_DIR` defaults to `data/claude`, so the host CLI uses the same agents, skills and
transcripts as the container; the OAuth token in `.env` logs it in. Keep
`CLAUDE_PERMISSION_MODE=acceptEdits` outside the container.

## License

MIT
