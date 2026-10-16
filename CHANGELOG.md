# Changelog

All notable changes to Pocket Factory are recorded here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow
[Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`, where the major almost never
moves, a minor adds something the owner can see or use, a patch fixes or polishes. The current
version is `version` in the root `package.json`; the UI shows it in the sidebar foot and
Telegram in `/status`. Every version is a tag `vX.Y.Z` on `main` and a
[GitHub release](https://github.com/miksrv/pocket-factory/releases) whose notes are this file's
section (`node scripts/release.mjs tag`).

## [1.5.0] - 2026-10-16

### Changed

- **Schedules are Routines.** A routine is work an agent does again and again: who does it
  (the agent, first in the form), what to do (the instructions, which the agent still edits to
  remember its decisions) and when — a list of **triggers**: "on a schedule" (a cron; every
  firing starts a run) and "when something new appears" (a cron that runs a prefilter first and
  starts a run only for new items). A routine may have several triggers (a daily run plus a poll),
  still one run at a time, or none at all and run only by **Run now**. The page is **Routines**
  (`/routines`; the old paths are gone), the files live in `data/config/routines/` (an existing
  `schedules/` directory is moved on the first start), Telegram says `/routines`, the run's prompt
  starts with "Routine run", and new tasks carry the source `routine`. Files written before keep
  working: `cron:` alone reads as one schedule, `cron:` with `prefilter:` as one poll; the form
  writes `triggers:` on the next save. The run history, seen items and the routines' chat threads
  stay as they were.
- The form puts what matters first — Agent, Skill, Instructions, Triggers — and folds project,
  model, mode, report, session, once and hosts under **More**. The live panel lists every trigger
  with its next firing.
- `.env`: `ROUTINES_SOFT_STOP`, `ROUTINES_LATE_MIN`, `ROUTINES_ASK_TIMEOUT_MIN`; the `SCHEDULES_*`
  names are still read.

## [1.4.2] - 2026-10-16

### Changed

- **The agent a schedule names always runs itself**, also when it cannot edit files (an email
  agent with only its Gmail tools) and when the project has an agent of the same name: no
  orchestrator in between any more. An agent without `Edit` simply keeps no notes.
- **A schedule's skill comes in the prompt** of a run as the agent, so the agent needs no Read
  and no extra turn to load it.

### Removed

- **The `devops` preset** (a read-only SSH inspector and its `devops-check` skill): never used;
  an agent that looks at a host is a project's own role. Factories that installed it keep the files.

## [1.4.1] - 2026-10-16

### Changed

- **A schedule runs as its agent.** A schedule with `agent:` on the subscription now starts the
  session as that agent (`claude --agent`: its prompt, its tools, its `model:` unless the schedule
  pins one) instead of an orchestrator that loads the skill, spawns the agent and retells its
  report. On the geometki pipelines that orchestrator took about a third of every run (six calls
  over a 40-50k context). The agent's `maxTurns:` applies, and the run's thread says
  `as <agent>`. An agent with neither `Edit` nor `Write` (it could not keep the schedule's notes),
  or one shadowed by the project's own `.claude/agents`, is still spawned the old way.
- **The Audit log and the Agents panel count a task's work under the agent it runs as**: a
  schedule's agent, and a delegated role, instead of the orchestrator.

## [1.4.0] - 2026-10-15

### Added

- **Delegation to other models.** An agent file with a `provider:` is now a role a Claude
  orchestrator hands work to: the factory's own MCP tool `delegate` runs the role as a task of its
  own on that provider (light mode, its search included), in a work directory under the chat, and
  answers the orchestrator with the role's report and files. The orchestrator waits without
  spending tokens and lends the role its session slot; the CLI's Agent tool refuses such roles so
  they never run on Claude by mistake. A role has nobody to ask: its question is answered at once
  ("decide by the brief"). A role queued behind other work still gets its parent's slot, the same
  brief after the role's own failure runs again, and deleting a chat takes its roles' hidden
  conversations with it. The chat shows a "Delegated to …" card, the task page lists
  the delegated tasks, the Tasks list marks them.
- When a role's provider does not answer, fails mid-run, or the task's project does not allow it,
  the role runs on the orchestrator's model instead (or the alias in `fallback:`; `fallback: none`
  reports that it did not run). Agents → the form's "When the provider is unavailable".
- Overview → **Providers** (shown once a provider is added): the subscription and every provider
  in one card, each with whether it answers now (a cheap check about once a minute, never a model
  call), its load and its tokens today and in all; the foot says how much work the providers took
  off the subscription and how many roles were delegated. Control plane counts the tokens of every
  model.
- Projects → "Providers this project may delegate to" (`providers:` in the project file): a
  project's work reaches a provider only when it is ticked there.
- A provider's own MCP servers (Settings → Providers → MCP servers: name, URL, key variable): only
  the tasks on that provider get them, through the factory's gateway, which adds the key; a
  subscription task never connects to the provider's box.
- TLS certificate field on a provider: paste a self-signed box's CA and the factory trusts it at
  once, no `NODE_EXTRA_CA_CERTS`, no restart.
- Test checks the provider's MCP servers too; a certificate failure says what to paste.
- `docs/SELF_HOSTED_LLM.md`: the guide to a GPU box with Ollama, Caddy and a search MCP.
- **Telegram: a new chat per message.** A message without a reply starts a fresh chat, so a
  self-contained skill no longer drags the last task's context (and its tokens) along; a reply to
  any message, the bot's or your own, continues that message's chat, and a reply whose chat was
  deleted starts a new one with the replied message quoted. An open question still takes the next
  message as its answer. `/new <project>` sets the project of the next chats, `/model
  <provider>:<model>` their provider, `/stop` as a reply stops that chat's task. `/mode thread`
  brings back one session until `/new`.
- **Chat titles by meaning.** A new web or Telegram chat is named after what its first message
  is about by one Haiku call without tools (about a thousand tokens, under a second), like Claude
  Desktop does; `CHAT_TITLES=off` keeps the first line.

### Changed

- Token figures (Overview, task pages, Agents, Audit, Telegram) leave out cache reads: every model
  call re-reads the whole context, so they were ~95 % of the number. They are still recorded and
  listed on the task page; old tasks show the new figure at once.
- Each provider has its own gateway bearer: a task on one provider can no longer use another
  provider's key.
- The gateway reports why an upstream request failed instead of a bare "fetch failed".
- Dependencies: Vite 8 with `@vitejs/plugin-react` 6, marked 18, hono 4.13.13 and
  `@hono/node-server` 2.1.4 (fixes a `serveStatic` path-decoding bypass, GHSA-rmxm-3fg6-px4f),
  lucide-react 1.54; CI actions `upload-artifact` 7.0.2 and `codeql-action` 4.38.3. Dependabot no
  longer offers `@types/node` majors: the types follow the Node the image runs (22).

### Fixed

- Stopping the supervisor waits for each run to write its end (changes, result) before the
  database closes, instead of only for the CLI processes.
- Enter on the sign-in page signs in from either field (or moves to the empty one), and the
  provider dialog's TLS certificate and MCP server rows no longer overlap.

## [1.3.0] - 2026-10-14

### Added

- **Model providers besides the subscription.** Settings → Providers connects self-hosted models
  (Ollama, llama.cpp, vLLM on any machine) and cloud APIs (OpenRouter, Gemini, OpenAI, Groq …):
  a name, the endpoint, the `.env` variable that holds the key (never the key), the models, how
  many tasks at once. A schedule, an agent file (`provider:` + `model:`) or a chat (the selector
  next to the project, Telegram `/model <provider>:<model>`, `/model claude` comes back) picks one,
  and that task's `claude -p` talks to it instead of Anthropic — through the factory's own gateway
  (`/gateway/<provider>`), which holds the key and translates for endpoints that speak only the
  OpenAI chat API. Such tasks move no subscription window and the schedules' soft-stop does not
  hold them; the footer and the task page name the provider and the model instead of the window
  share. **Test** sends one tool-calling probe; **Fetch** reads the endpoint's model list.
- **Light mode** for small models (the default on a new provider): the task runs with a short
  system prompt — the agent file's body when a schedule names an agent, else
  `data/claude/light-system.md` — and Read / Write / Edit / Bash / Glob / Grep, no skills, instead
  of Claude Code's full prompt and tool set; measured on a self-hosted RTX 2080 Ti (9–12B
  models), the full prompt never reached the file, the short one did on the first try.
- `tasks.provider` / `tasks.agent`, `conversations.provider` / `model` (migration v15);
  `/api/providers` (list, save, delete, test, models), `PUT /api/conversations/:id/model`,
  `providers` in `/api/status`.

## [1.2.1] - 2026-10-13

### Fixed

- **A scheduled run skipped for the subscription limit is told in Telegram.** When the 5-hour or
  the weekly window is past `SCHEDULES_SOFT_STOP`, every skipped cron firing now sends the owner
  a message with the window, its share and when scheduled runs resume (plus `/run <name>` to
  run it anyway), instead of leaving the chat silent for days. A schedule with `notify: none`
  stays quiet.

## [1.2.0] - 2026-10-09

### Added

- **Dark theme.** The same palette on charcoal, chosen with the sun / moon in the sidebar foot or
  in Settings → Appearance (System / Light / Dark; System follows the browser). The choice stays
  in the browser, a reload paints the right theme from the first frame, and the phone's status
  bar follows it.
- **Toolchains for the agents.** The image carries `mise`, PHP 8.2 with composer and the docker
  CLI; the agents install the runtimes a checkout asks for (Go, Node, Python … from its own
  version files) into `data/tools` themselves before the checks, and PHP is there already.
  With `COMPOSE_PROFILES=docker` in `.env` the factory runs its own Docker daemon (a
  `docker:dind` sidecar, state in `data/docker`, 8 GB), so a project's compose file brings up
  its database or the whole application for the tests; what a task started is stopped when the
  task ends. Settings → Toolchains lists every installed version with its size and the projects
  on it (Install, Remove, Prune) and the sidecar's containers (Stop); the project form shows what
  the checkout needs with a badge each; Overview → Health has a Toolchains line and an MCP
  servers line. The PR reviewer's "the factory has no toolchains" rule is gone.
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
  5-hour window: `— project: shop` / `— windows: 5h 27% · week 50% · this task +4%`. Turns,
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
