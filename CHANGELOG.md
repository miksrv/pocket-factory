# Changelog

All notable changes to Pocket Factory are recorded here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow
[Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`, where the major almost never
moves, a minor adds something the owner can see or use, a patch fixes or polishes. The current
version is `version` in the root `package.json`; the UI shows it in the sidebar foot and
Telegram in `/status`. Every version is a tag `vX.Y.Z` on `main` and a
[GitHub release](https://github.com/miksrv/pocket-factory/releases) whose notes are this file's
section (`node scripts/release.mjs tag`).

## [1.2.0] - 2026-10-09

### Added

- **Dark theme.** The same palette on charcoal, chosen with the sun / moon in the sidebar foot or
  in Settings → Appearance (System / Light / Dark; System follows the browser). The choice stays
  in the browser, a reload paints the right theme from the first frame, and the phone's status
  bar follows it.
- **The web signs you out after a day away.** A session the owner has not used for
  `WEB_SESSION_IDLE_HOURS` (default 8, 0 = off) ends by itself; only your own activity at the
  page (a key, a click, a scroll, the tab coming back) counts as use, a tab polling on its own
  overnight does not. Settings → Security states the policy.

### Changed

- Durations read `1h 23m 10s` instead of a bare count of minutes and seconds (and `1m 59.6s` no
  longer shows as `1m 60s`).

### Fixed

- A running task showed 0 turns, 0 tokens and 0s until its result landed, so a long run looked
  stuck on the task page and in the list. The supervisor now writes turns, tokens and wall-clock
  to the task every few seconds, and the page and the list tick the duration from the start.

## [1.1.2] - 2026-10-06

A task started in the web UI no longer goes silent when the owner walks away from the laptop:
Telegram hears about it and picks the thread up.

### Added

- **Web tasks reach Telegram when nobody is at the browser.** A reply of a web task that stays
  unopened in the web for `TELEGRAM_WEB_NOTIFY_MIN` minutes (default 2; 0 = off) goes to
  Telegram with the usual footer, and is then marked read. A question or permission request of
  a web task unanswered for as long goes there too, with the buttons; once it did, the task's
  next questions and its reply follow at once. "Opened" is the web's own read mark, so while
  the thread is open in a visible tab Telegram stays quiet.
- **The chat switches to that thread.** The message names the web thread, and the next text or
  voice message in the chat continues it, exactly as after replying to a message of the bot;
  `/new` comes back. Replying to any other message of the bot still switches to its thread.

## [1.1.1] - 2026-10-06

Long tasks with sub-agents no longer end half-done with a "waiting for the report" reply, and a
question asked right after such a task gets an answer instead of an empty reply.

### Fixed

- **Background sub-agents are no longer killed after 10 minutes.** In `-p` the CLI waits for
  background work after the orchestrator's last turn only 10 minutes, then stops it and answers
  with whatever was said last. A sub-agent continued with SendMessage always runs in the
  background, so a long one was cut off mid-work and the task showed "done" with "Waiting for
  the client report." as its result. The factory now starts the CLI with
  `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` (wait for them; `CLAUDE_TASK_TIMEOUT_MIN` is the limit,
  and the variable in `.env` still overrides).
- **An empty reply to the next message.** A resumed session first ran a turn of its own about the
  background tasks the previous run left behind and produced an empty result; the factory took it
  as the answer and closed the CLI before it read the prompt. The CLI now echoes the prompt
  (`--replay-user-messages`) and only the result after that echo counts; a CLI that exits before
  taking the prompt fails the task with that reason.
- A reply whose sub-agents were stopped before finishing, after the reply was written, now says so
  ("A sub-agent stopped before finishing … Say "continue" to pick it up.") like a reply that came
  while sub-agents were still running.

### Changed

- Dispatcher rules (`templates/claude/CLAUDE.md`): a sub-agent continued with SendMessage reports
  back by a notification; a short status while it works is fine, a background `sleep` as a
  fallback timer is not.
- `CLAUDE.md`: the first real feature run is done, the toolchains plan (`docs/plans/toolchains.md`)
  is on the list.

## [1.1.0] - 2026-10-06

Photos and files with a task, tasks that wait out the subscription limit instead of failing, and
a Changes panel to decide on a task's work from a phone. The release plan from the October survey
of similar projects (`docs/LANDSCAPE.md`).

### Added

- **Photos and files with a task, from Telegram and the web.** A screenshot of a bug, a log, a
  PDF: the file is saved under `data/inbox/<conversation>/` and its absolute path follows the
  message, so the agent opens it with the Read tool (which shows images and PDFs to the model).
  Telegram takes photos, documents and videos, an album as one message; with a caption the
  files go at once, without one they wait up to 30 minutes for the next text or voice message
  of the chat (`/new` drops them). Files sent while the agent waits for an answer go with the
  answer. The web composer has a paperclip, takes pasted screenshots and dropped files, uploads
  each at once and shows it as a chip; the thread shows images as thumbnails and other files as
  chips under the message, the task page too. Up to 10 files of 20 MB each per message
  (Telegram's own download limit). Sessions get `--add-dir` for the inbox, so reading a file
  needs no permission prompt in any mode. **Deleting a conversation in the UI deletes its files
  from the disk** (everything under its inbox directory, Telegram and web uploads alike); its
  tasks stay in Tasks and the Audit log, and their attachments say "removed". Directories of
  deleted or unknown conversations are swept at start, and uploads older than 30 days go too.
- **Changes panel on the task page**, built for deciding from a phone rather than reading every
  line. A task in a project records where it started in the checkout; at the end the factory
  measures what it changed: the branch, the range (the merge-base with the default branch for a
  branch of its own, else the start), files and lines, files left uncommitted, and the branch's
  pull request if `gh` finds one. The panel shows the agent's report first (a few lines, "Show
  the whole report"), then `4 files +5 −2 · feature/x → main` with **Create PR** (pushes the
  branch and runs `gh pr create --fill` against the default branch; an open PR is shown instead),
  then the files by folder with lock files and build output folded into one line, and the diff of
  a file only when it is tapped, as wrapped lines without sideways scrolling. The chat shows the
  size as a link under each reply that changed something, and the Telegram report adds
  `— changes: 4 files, +5 −2 on feature/x`, the PR and, with `WEB_PUBLIC_URL` set, a link to the
  panel. Migration v14: `tasks.git`. Two conversations working in the same checkout at the same
  time see each other's commits in their ranges: the real checkout is shared by design.
- **Auto-continue after a window reset.** A task the CLI refused because the subscription
  window was used up goes back to the queue until the window resets (plus a minute) and then
  continues its session by itself, like a task interrupted by a restart. Telegram says when it
  continues; the thread and the task page show the wait; Stop (or `/stop`, which now also
  cancels a queued task) cancels it. Only when the reset is at most
  `CLAUDE_AUTO_CONTINUE_HOURS` away (default 6, so the weekly window fails as before, with the
  reset time in the error; 0 turns it off) and at most three times per task. The reset comes
  from the CLI's `rate_limit_event` (`rejected`, with the window and its reset), else from the
  result text, else from the exhausted window.

### Changed

- **Migrations v13 and v14**: `tasks.attachments`, `tasks.not_before`, `tasks.limit_waits`,
  `tasks.git`.
- **`Button` takes `href`** for an external link that looks like a button (the pull request).
- **`/stop` in Telegram** cancels a queued task too, not only a running one.
- **Review fixes before the merge**: a limit refusal pauses the whole queue until the reset, so
  other conversations do not each start a CLI only to be refused; only the CLI's own wordings
  and a `rejected` event count as the limit (an API 429 fails as before); files saved for the
  chat's topic move with a reply that lands in another conversation; Create PR no longer makes
  the bot deliver the finished report again; a task that leaves its branch for main is measured
  from where the two meet, never backwards; the PR lookup before the report waits 5 s at most
  and a merged or closed PR is saved as such; old uploads are pruned daily, not only at start;
  two quick pastes cannot queue more than ten files.
- **README and `docs/LANDSCAPE.md` reflect October 2026**: the comparison with Remote Control,
  Agent View, Projects and Routines, the open-source neighbours, the quick start with
  `claude auth login` in the container.

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
- **`/status` is shorter.** Session id and the workspaces path are gone; the running task is shown
  by its first line and how long it has run (or that it is queued, or waits for an answer); the
  conversation line appears only when the chat was switched to another thread by a reply.
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
- **A reply that cut off a sub-agent says so.** In `claude -p` the orchestrator's final answer
  ends the process, and a sub-agent still working dies with it, so "I will run the review when it
  finishes" never happens. The result now ends with a warning naming how many sub-agents were cut
  off (counted when the result arrives, shown in Telegram and in the web thread), and the
  dispatcher rules tell the agent there is no "later": wait for the report, then reply.

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
