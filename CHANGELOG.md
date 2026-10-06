# Changelog

All notable changes to Pocket Factory are recorded here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow
[Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`, where the major almost never
moves, a minor adds something the owner can see or use, a patch fixes or polishes. The current
version is `version` in the root `package.json`; the UI shows it in the sidebar foot and
Telegram in `/status`. Every version is a tag `vX.Y.Z` on `main` and a
[GitHub release](https://github.com/miksrv/pocket-factory/releases) whose notes are this file's
section (`node scripts/release.mjs tag`).

## [1.0.1] - 2026-10-05

Fixes from the owner's first day of real use from Telegram.

### Changed

- **One project command in Telegram.** `/project <name>` is gone; `/new [project]` is the only
  way to start a session, with or without a project. The two did the same thing (both restarted
  the session) and were confused with each other; `/status` still names the current project.
- **The footer under every Telegram reply** names the project the agent worked in instead of
  `N turns · tokens · +x% of 5h · Ns`, and the windows line carries this task's share of the
  5-hour window: `— project: geometki` / `— windows: 5h 27% · week 50% · this task +4%`. Turns,
  tokens and duration stay on the task page.
- **No dollar budget.** `CLAUDE_MAX_BUDGET_USD` and `--max-budget-usd` are removed: the CLI told
  the model its remaining dollars and the agent cut work short "because $0.30 were left", which
  means nothing on a subscription. The dispatcher rules say the 5-hour and weekly windows are the
  only limit and never to ration work by money. Settings → Claude Code shows turns only.

### Fixed

- **A bound conversation no longer switches projects by itself.** Any tool call that mentioned
  another checkout (a `git status` across the fence, a path in a command) re-bound the thread to
  that project, dropped its session and the next reply was about the other repository. A task of
  a bound conversation now carries that project from creation; detection from tool inputs runs
  only for a project-less task and binds only a project-less conversation. The project is read
  again when the task starts (the binding may have changed in the web while it queued), and a
  bound conversation whose checkout or project file is gone fails the task with a message instead
  of running from the workspaces root under the project's name.

## [1.0.0] - 2026-10-05

The first numbered version: the factory as it runs on the owner's own server after a week of
daily use.

### Added

- **Autonomy.** Tasks arrive from Telegram (text and voice, Groq Whisper) or the browser, queue
  per conversation, run as `claude -p` sessions in the owner's real checkouts, continue across
  messages and survive a supervisor restart (an interrupted task is re-queued once and resumes
  its session). Questions and permission prompts from the agent (`AskUserQuestion`,
  `can_use_tool` over stream-json) reach the owner in Telegram and the web and are answered from
  either.
- **Control.** The Audit log records every model call, tool call, file edit and sub-agent per
  agent and project, built live from the CLI's stream. Tokens (cache included) and the 5-hour /
  weekly subscription windows replace dollar figures. Rendered transcripts of every session.
- **Management.** Agents, skills, projects and schedules are Markdown files with frontmatter,
  edited in the UI or by the agent; presets (`fullstack-ts-go`, `fullstack-ts-php`, `devops`,
  `pr-review`, `email-assistant`) install them. Shared SSH hosts with host-key trust from the UI;
  MCP servers in three layers (repository `.mcp.json`, the owner's `mcp.json`, role-owned
  servers), with claude.ai connectors available to every session and sign-in from Settings. The
  orchestrator's model is a run-time setting (`/model`, Settings).
- **Pipelines.** Skills chain sub-agents into repeatable flows; schedules fire tasks on a cron
  behind a deterministic prefilter (shell command, GitHub PRs, Trac query), so an empty poll costs
  no tokens; missed firings are reported, never caught up.
- **Web UI.** Light, paper-and-mono theme without a UI framework: Chat with unread, waiting and
  running marks, Tasks, Sessions, Audit log, Agents, Skills, Projects, Schedules, Presets,
  Settings (Claude Code, MCP, Hosts, Security). Installs as a PWA; favicon badge and desktop
  notifications for replies and questions.
- **Security.** Web sign-in with session cookies, lockout after failed attempts and a sign-in log
  reported to Telegram; CSRF and DNS-rebinding guards; the CLI never sees the supervisor's own
  secrets; GitHub through fine-grained tokens per repository owner, never mounted SSH keys.
- **Versioning.** This changelog, the version in the sidebar foot and `/status`, and
  `scripts/release.mjs` for bumping and tagging.
