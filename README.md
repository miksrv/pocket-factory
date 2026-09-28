# Pocket Factory

> Your agent becomes autonomous when you close your laptop.

A personal software factory: the unmodified [Claude Code](https://code.claude.com) CLI running on
your own server, driven from Telegram by text (voice soon). You send a task from the road; the
factory works in your repositories and reports back.

Single-owner by design. You log in to Claude Code with **your own subscription**, create **your own**
Telegram bot, point it at **your own** repositories. Nothing is shared, proxied or stored by anyone
else. See [docs/SPEC.md](docs/SPEC.md) for the full concept and roadmap.

## Status

Phase 0 — skeleton. Telegram text → `claude -p` → reply, with session continuity per chat.

## Quick start

Requirements: Docker, a Claude subscription, a Telegram bot token from
[@BotFather](https://t.me/BotFather), your Telegram user id (ask
[@userinfobot](https://t.me/userinfobot)).

```bash
git clone https://github.com/miksrv/pocket-factory.git
cd pocket-factory
cp .env.example .env          # fill in TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS, WORKSPACES_DIR
claude setup-token            # on your laptop: prints a token — put it into .env as CLAUDE_CODE_OAUTH_TOKEN
docker compose build
docker compose up -d
docker compose logs -f supervisor
```

`claude setup-token` needs a browser, so run it on your laptop, not on the server. Interactive
`/login` inside the container is currently broken upstream
([anthropics/claude-code#34917](https://github.com/anthropics/claude-code/issues/34917)).

Send your bot a message. `/new` starts a fresh session, `/stop` cancels a running task.

## Layout

```
data/                    runtime state — everything the factory owns, all bind-mounted
├── claude/              Claude Code home: login, CLAUDE.md, agents/, skills/, transcripts
├── config/projects/     one Markdown file per connected project
├── workspaces/          repositories (or set WORKSPACES_DIR to a folder you already have)
├── db/                  SQLite
└── logs/
supervisor/              Telegram bot + Claude Code runner (TypeScript)
templates/claude/        seeded into data/claude on first start
docs/SPEC.md             requirements & roadmap
```

Moving to another host is `rsync data/` + `docker compose up`.

## Development without Docker

```bash
corepack enable
yarn install
cp .env.example .env
yarn dev                 # uses the claude CLI and login from your own machine
```

Keep `CLAUDE_PERMISSION_MODE=acceptEdits` when running outside the container.

## License

MIT
