# Pocket Factory — Requirements & Specification

> **Tagline:** *"An agent becomes truly autonomous the moment you close your laptop lid."*
>
> Status: Draft v1.4 · Date: 2026-09-30 · Author: Misha Topchilo (with Claude)
>
> **v1.4 changes:** decisions recorded 2026-09-29/30. Phase 5 implemented: schedules as Markdown files with a cron, an active window, a deterministic prefilter (`command`, `github-prs`, `trac`) and instructions the agent edits to remember decisions; soft-stop for background work (§4.3). Claude auth is a full claude.ai login **inside the container** (`claude auth login`, URL + code), which brings the account's connectors and plugins into every session; the setup-token is the fallback. Questions and permissions reach the owner over stream-json on stdin (`AskUserQuestion`, `--permission-prompt-tool stdio`) and are answered from the web or Telegram inside the same run; the idle-timeout model is gone for good. MCP is three layers (repository `.mcp.json`, owner `config/mcp.json`, role-owned servers in agent frontmatter) with a registry, status refresh and browser-driven sign-in in Settings. SSH hosts are a shared registry (`config/hosts.yaml`) referenced from project files; host keys are trusted from the UI. Unread replies and drafts in the chat.
>
> **v1.3 changes:** the concept is stated as a self-hosted layer over Claude Code for developers with four pillars — autonomy, control over what agents do, management of agents / skills / projects, pipelines. Money is gone from the product (tokens and subscription windows instead); the config git history is replaced by the Audit log built live from stream-json; every list pages dynamically; agents are a card roster with live activity; models and tools come from the subscription and the CLI.
>
> **v1.2 changes:** decisions recorded from the implementation: the agent works in the owner's real checkouts on a branch (no per-task worktrees); the web UI is a Vite/React SPA served by the supervisor (no Next.js service); sessions are one-shot `claude -p` runs resumed by id, so idle timeout is a no-op; config history is two git repositories on the volume; project files carry `hosts:` for SSH access; presets are shareable bundles. Phases 0–4 implemented.
>
> **v1.1 changes:** the agent runtime is the owner's own, unmodified **Claude Code CLI** (subscription login), supervised by a thin always-on process — not a custom Agent SDK application holding a token. Added the session lifecycle model (spawn on demand, tear down on idle / explicit finish, resume from disk). Dropped Langfuse and the custom events table in favour of Claude Code's own JSONL transcripts. Closed the auth question. Added prompt-injection requirements and the conditions under which others may reuse the template.

---

## 1. Vision & Concept

A **self-hosted layer over Claude Code for developers**: a containerized personal agent platform that lives on a VPS and works autonomously while the owner is away. It adds four things the CLI alone does not have — autonomy (tasks queue and run without a terminal), control over what agents do (an audit log per agent and project), management (agents, skills, projects as files with a UI) and pipelines (skills chaining sub-agents into repeatable flows). Think of it as `/rc` (remote control) for Claude Code, but through Telegram and without a laptop: the owner is driving to a conference, gets a message that a hotfix is needed, records a voice note to the bot — and the agent does the work and reports back.

The system is a thin **supervisor** around the owner's own **Claude Code** installation. The supervisor receives tasks from multiple triggers — Telegram messages (text and voice), cron schedules, and (optionally) external webhooks — and hands them to a Claude Code session, which decomposes them, spawns specialized **sub-agents** (developer, reviewer, QA, email assistant, …) via Claude Code's native sub-agent mechanism, iterates until the work is done, and reports back through the channel the task came from.

The platform is an **agent factory**: new sub-agents, skills (workflows), and project definitions are plain Markdown files in Claude Code's own configuration directory. They can be created and edited both through a web UI and conversationally through Telegram ("create an agent that triages my email"). Everything — configuration, credentials, knowledge base, transcripts — lives in a single data volume, making the whole system trivially portable between servers.

Inspiration: Guild.ai's "Software Factory" (specialized agents producing ready pull requests) — but personal, self-hosted, Telegram-first, and fully owned by the developer. Closest first-party analogue: Claude Code Channels (Telegram/Discord bridge to a running session) — but with a task queue, on-demand session lifecycle, schedules and a web UI on top.

### Core principles

1. **Zero idle cost.** Claude Code is spawned per task, not kept alive. Tokens are consumed only while a task is running; RAM is consumed only while a session is open. When there is nothing to do, only the cheap deterministic supervisor (bot polling, scheduler, web UI) is awake.
2. **Claude Code is the agent; we are the supervisor.** The tool never modifies the Claude Code binary, never handles the owner's credentials, and never re-implements what Claude Code already does (sub-agents, skills, sessions, memory, MCP, transcripts). The supervisor adds only what Claude Code lacks: a Telegram front-end, a task queue, schedules, lifecycle management, and a UI over the files.
3. **Everything is a file.** Sub-agents, skills, project knowledge, and global rules are Markdown files on a volume. The UI and the agent itself edit the same files. No hidden state. Every change the agent makes to its own configuration is a file event in the Audit log (§6.9), attributed to the task and agent that made it.
4. **Deterministic pre-filter before LLM.** Polling, event filtering, and deduplication are done by plain code. Claude Code is invoked only when there is real work.
5. **Facts ≠ procedures ≠ roles.** Project facts live in the knowledge base, step-by-step workflows live in skills, roles live in sub-agent definitions, universal rules live in `CLAUDE.md`. No duplication.
6. **Portable by design.** One Docker Compose stack + one `/data` volume = the entire system. Migration is `rsync` + `docker compose up`.
7. **Template for others.** No personal facts hardcoded in the codebase — any developer can fork the repo, log in to Claude Code with **their own subscription**, add their own Telegram bot and projects, and get their own factory. The tool is strictly single-owner: it never offers Claude login inside its own UI, never stores or proxies anyone's Claude credentials, and never intermediates Claude usage for a third party. Each installation is billed to its owner under the owner's own agreement with Anthropic.

---

## 2. Goals & Non-Goals

### Goals

- Autonomous execution of multi-step software tasks (feature → PR → review → fixes → report) without supervision.
- Telegram as the primary human channel: task input (text + voice), progress milestones, clarifying questions, final reports. Only essential information — details live in the UI.
- Web UI for observability and administration: agents, skills, projects, schedules, task log, session transcripts, token analytics and subscription-window (5-hour / weekly) visibility.
- Event-driven task creation: Telegram, cron schedules with UI management, and optionally external webhooks (GitHub).
- Support for multiple independent repositories (personal and organization-owned) with per-project workflows, credentials, and conventions.
- Human-in-the-loop: the agent pauses and asks the owner via Telegram when it hits ambiguity or a decision gate; runs resume after the answer.
- Self-improvement loop: corrections given via Telegram ("remember: in this project always update the CHANGELOG") are persisted by the agent into its own knowledge files (visible as file events in the Audit log).
- Session lifecycle under the owner's control: every task is a one-shot run that ends with the agent's report; the next message in the same conversation resumes the session with full context, `/new` starts a fresh one, `/stop` cancels a run.

### Non-Goals (v1)

- Multi-tenant / team usage. This is a single-owner system (whitelist of one or few Telegram IDs belonging to the same person).
- Enterprise fleet management, RBAC, SSO, compliance (that is Guild.ai's territory).
- A general-purpose chat assistant. The system is task-oriented.
- Horizontal autoscaling. Scaling model is "one more VPS with its own instance".
- Re-implementing the agent loop, sub-agents, tracing, or memory. Claude Code provides these; the tool wraps them.

---

## 3. Use Cases

### UC-1 — Feature task in a personal project (via Telegram)

> "In my personal project, URLs in the `/photos` section must change from numeric IDs to SEO slugs like `12245-andromeda-galaxy`."

1. Owner sends the message (text or voice) to the Telegram bot.
2. Voice is transcribed (STT); the supervisor creates a task and spawns a Claude Code session.
3. Claude Code matches the message to the `photos` project via the knowledge base, applies the `feature-to-pr` skill.
4. Spawns *developer* sub-agent (branch, implementation, tests) → *reviewer* sub-agent (diff review, fresh context) → fix loop until review passes → runs the project's checks.
5. Opens a PR via `gh`, sends a Telegram report: "PR ready: <link>. Summary of changes…". The run ends with the report; a follow-up in the same conversation resumes the session, `/new` closes the topic.

### UC-2 — Organization task from ClickUp (via Telegram)

> "In project webshop take ClickUp task DEV-1234 and do it."

1. Claude Code matches `webshop` → org repo, ClickUp workspace, `clickup-task` skill.
2. Reads the task via the ClickUp connector. If ambiguous — asks with `AskUserQuestion` (one Telegram message per question with inline buttons, a form in the web thread); the run waits with its process alive and the wall-clock timeout paused, and the owner's answer — buttons or free text, from either channel — continues the same run.
3. Branch `feature/DEV-21234-…`, developer → reviewer → QA loop, PR to the branch defined in project config.
4. Posts a comment on the ClickUp task with the PR link, transitions the task status to *Review*.
5. Telegram report: "DEV-21234 done, PR ready, task moved to Review."

### UC-3 — GitHub review request (via polling or webhook)

1. Someone requests the owner's review / mentions them on GitHub.
2. Default: a **prefilter schedule** polls `gh api` every few minutes and diffs against `seen_items` — no public endpoint needed. Optional: a webhook endpoint with signature verification and in-code event filtering (only `review_requested` / mention create a task).
3. Claude Code applies the `pr-review` skill: reads the PR diff and context, performs the review, posts comments on the PR. The `pr-review` skill runs with **read-only repository tools** — PR bodies and diffs are untrusted input.
4. Telegram notification: "Reviewed org/repo#123: 2 issues found, comments posted."

### UC-4 — Scheduled TRAC defect monitor (via cron)

1. Schedule: hourly, working hours only (Mon–Fri, configurable window).
2. **Deterministic pre-filter script** (no LLM): polls the TRAC API, diffs ticket IDs against the `seen_items` table. No new defects → zero tokens spent, no session spawned.
3. New relevant defect → task created with the `trac-defect-fix` skill: reproduce (over SSH on the project's `hosts:` when it has any, read-only; from the code and tests otherwise), find root cause, branch, fix, review loop, PR.
4. Telegram report: "Defect #46812 fixed, PR ready: <link>."

### UC-5 — Creating a new sub-agent (via Telegram or UI)

> "I need an agent that triages my inbox and prepares draft replies."

- Via Telegram: Claude Code itself writes `agents/email-agent.md` (+ skill + MCP binding) and confirms; the edit shows up in the Audit log. Next time a mail-related task arrives, the dispatcher knows to spawn it.
- Via UI: the owner creates/edits the same Markdown file in the agent editor (form for frontmatter: name, trigger description, allowed tools/MCP, model + prompt body).

### UC-6 — Onboarding a new project

> "Connect project X: repo <url>, tasks in ClickUp."

The `onboard-project` skill interviews the owner (PR target branch, branch naming, pre-PR checks, tracker workflow), inspects the repo itself (README, CI config, conventions), and generates `projects/x.md`. The owner reviews/edits it in the UI.

### UC-7 — Teaching / correcting behavior

> "Remember: in webshop always update CHANGELOG before the PR."

Claude Code edits the corresponding project file or skill itself and confirms. The UI editors and the Audit log (file events per task) are used to audit and clean up accumulated knowledge.

### UC-8 — Ending a session

There is nothing to end: a run finishes with the agent's report and the process exits. The transcript stays on disk; a later message in the same conversation resumes the session with full context, `/new` (optionally `/new <project>`) starts a fresh conversation, `/stop` cancels a running task. The dispatcher suggests `/new` after a finished task so a long-lived conversation does not drag its whole history into every run.

---

## 4. System Architecture

```
                     ┌──────────────────────── VPS · docker compose ────────────────────────┐
 Telegram ◄─────────►│  supervisor (always on, no LLM)                    web              │
 (text / voice)      │  ┌──────────────────────────────────────────┐     ┌──────────────┐  │
 GitHub (polling ───►│  │ telegram bot (long polling) + STT        │     │ Vite/React   │  │
  or webhook)        │  │ task queue · scheduler · prefilters      │◄────│ SPA: chat    │  │
                     │  │ session manager: spawn / resume / ask /  │     │ agents/skills│  │
                     │  │   answer / stop / restart recovery       │     │ projects     │  │
                     │  └───────────────┬──────────────────────────┘     │ audit · tasks│  │
                     │                  │ stdio (stream-json both ways)  │ transcripts  │  │
                     │                  ▼                                │ limits       │  │
                     │  claude -p  (unmodified Claude Code CLI,          │ settings     │  │
                     │              owner's claude.ai login, 0..N)       └──────────────┘  │
                     │              └─ sub-agents · skills · MCP · connectors              │
                     │                                 │                                    │
                     │                                 ▼                                    │
                     │  /data volume: claude/ (CLAUDE_CONFIG_DIR: credentials, agents,     │
                     │  skills, transcripts) · config/ (projects, hosts.yaml, mcp.json,    │
                     │  known_hosts) · workspaces · db (SQLite) · secrets (ssh, read-only) │
                     └──────────────────────────────────────────────────────────────────────┘
```

### 4.1 Components

| Component | Responsibility | Tech |
|---|---|---|
| **supervisor** | Telegram bot (long polling — no public IP required), voice → text (STT), task queue + worker, scheduler + prefilters, optional webhook endpoint, **session manager** (spawn Claude Code, stream-json in and out, resume by session id, questions and permission prompts relayed to the owner and answered back on stdin, stop, re-queue after a supervisor restart), delivery of reports/questions back to Telegram, transcript indexing and token accounting | Node.js/TypeScript, grammY, node-cron, `child_process` around `claude -p` |
| **claude** | The agent itself: dispatcher prompt, sub-agents, skills, MCP, sessions, memory. Unmodified Claude Code CLI, logged in by the owner. Not a long-running service — spawned per task, 0..N processes at a time | `@anthropic-ai/claude-code` (pinned version), `git`, `gh`, project runtimes |
| **web** | Admin & observability UI (see §6) | Vite + React SPA, built into the image and served by the supervisor; SSE for live output |
| **db** | Tasks, schedules, seen-items, session index, usage aggregates | SQLite on the volume (WAL mode) |

The container image also ships: `git`, `gh` CLI, project runtimes as needed (node, yarn, …).

### 4.2 The trigger → task model (central abstraction)

Every source converges into one queue:

```
tasks (
  id, source,            -- telegram | webhook | cron | ui
  idempotency_key,       -- dedup: webhook retries, overlapping cron runs
  project,               -- resolved project slug (nullable until dispatched)
  prompt, payload_json,  -- user text / webhook payload / schedule prompt
  status,                -- queued | running | done | failed | cancelled
  ask,                   -- what a running task waits for (question / permission, answers so far); null otherwise
  restarts,              -- how many supervisor restarts the task has survived (re-queued once)
  conversation_id,       -- the thread the task belongs to; the conversation holds the session id
  reply_to,              -- where to report: telegram chat, PR, clickup task…
  created_at, started_at, finished_at,
  tokens_in, tokens_out, cost_usd   -- cost kept for the record, never shown
)
```

Rules:

- **Idle = free.** The worker spawns Claude Code only for queued tasks.
- **Dedup** via `idempotency_key` (e.g. webhook delivery ID, `schedule_id + fire_time`).
- **Workspace:** the agent works inside the owner's real checkout on a branch — no worktrees, no re-cloning (decided during Phase 0; the owner's repositories are bind-mounted and expected to stay in the state the owner left them). One running task per conversation; tasks touching the same repository are the owner's responsibility to sequence for now.
- **Questions:** a question or an unsettled permission prompt is stored on the running task (`ask`); the task keeps its slot, the timeout is paused, and the answer from any channel continues the same run (§4.4). A message typed while a question is open is the answer.
- **Cancellation & steering:** the owner can stop a running task (`/stop`, the Stop button); free text sent while a task runs is queued as the next task of the conversation and resumes the same session once the current run ends.

### 4.3 Schedules

> **As implemented (v1.4, 2026-09-30):** a schedule is a Markdown file, `data/config/schedules/<name>.md`, not a table row — because its body is the instruction the agent reads every run *and* the agent's memory between runs (deferred tickets, PRs skipped on purpose), which the agent edits itself; that edit is a file event in the Audit log like any other. The store keeps only what a file cannot: `schedule_runs` (every firing and why it did or did not start a task) and `seen_items` (prefilter items already handed over). `tasks.schedule` names the schedule a task came from.

```yaml
---
cron: "0 * * * *"                  # five fields; @hourly / @daily also work
# tz: Europe/Warsaw                # by hand only: the form reads the cron in TIMEZONE (the container runs in UTC)
# window: { days: mon-fri, hours: "09:30-17:45" }   # by hand only, for bounds a cron cannot say; weekdays and whole hours belong in the cron
enabled: true
project: GlobalNavigation          # the task runs from its checkout; or `hosts:` as in a project file (`- host: <name>` + path, notes)
skill: tracker-defect-fix          # optional; `agent:` hands the work to a sub-agent
action: report                     # free text the agent gets as the mode: report | fix | comment …
prefilter:                         # optional, runs without the model on every firing
  kind: trac                       # command | github-prs | trac
  query: "status=new&component=GlobalNavigation"
notify: telegram                   # or none (web thread only)
session: fresh                     # or continue (one transcript across runs)
first_run: skip                    # a poller starts from now; `process` hands existing items over
max_items: 10
---
Instructions for every run, in prose. ## Notes: what the agent decided last time (it edits this).
```

- **Firing.** The scheduler ticks every 20 s; a schedule fires at each minute its cron and window allow (in its zone), once. A minute already fired before a restart is not repeated; minutes missed while the supervisor was down are not caught up (a poller catches up by itself on the next firing). "Run now" (UI, Telegram `/run <name>`) ignores cron, window and soft-stop but never overlaps a run in progress.
- **Prefilter before LLM.** `command` (a bash command; its output lines or a JSON array are the items), `github-prs` (`gh pr list` of a repository: every open PR, those requesting the owner's review, or those mentioning the owner; key = PR + head commit, so a new push resurfaces it), `trac` (a Trac query as CSV; key = ticket id + change time, so a deferred ticket resurfaces when it changes). Items minus `seen_items` = the run's work; nothing new = no task, zero tokens. The first cron firing of a poller marks what already exists as seen unless `first_run: process`.
- **The task.** One conversation per schedule (`web` channel, `schedule:<name>`, shown with a clock in the Chat list), a fresh session per run by default, source `cron`. The prompt frames the run (started by the scheduler, nobody at the keyboard, report at the end, memory in the file's body), then the file's body, then the new items. The report and any `AskUserQuestion` go to the owner's Telegram chat unless `notify: none`.
- **Guards.** One run at a time per schedule (a firing while the previous task is queued or running is skipped, told in Telegram once per task); **soft-stop** (`SCHEDULES_SOFT_STOP`, default 85 %): cron firings are skipped while the 5-hour or the weekly window is at or above the share, the owner's own tasks are never held back; a prefilter that fails is a run with status `error`, reported to Telegram once per distinct error. A scheduled run's question or permission request unanswered for `SCHEDULES_ASK_TIMEOUT_MIN` (default 120) is answered for the owner (deny / "no answer: decide by the instructions"), so a schedule never stalls on a question nobody saw.
- **Missed minutes** (2026-10-01). The ticker remembers its last look at the clock (`meta`), so after a sleep or a restart it knows which minutes passed meanwhile: a firing at most `SCHEDULES_LATE_MIN` (default 5) late still runs ("late by N min"), an older one becomes a run with status `missed` — recorded, told in Telegram with `/run <name>` as the way to start it now, never run by itself (the owner's decision: the 08:00 inbox check is not wanted at 14:00). "Forget seen items" keeps the first-run seeding mark, so the next run hands everything over as promised. An item whose key changed since an earlier handover (a ticket's change time, a PR's head commit) is handed over as "seen before, changed since": possibly the agent's own comment or push, so it checks the latest change before acting again. `once: true` switches the file off after queueing its task (a check for tomorrow, not every day).
- **UI.** Schedules: the same list + form editor as projects, with the live state above the form (valid / on / off, next run, last firing and its note, last task with the task's own status, seen items, the thread), Run now, Preview prefilter (what it finds, which items are new or changed, marking nothing), Switch on / off, Forget seen items, the run history (the firings that mattered by default — a task with its outcome, an error, a missed minute — every poll and skip on request; the store keeps the last 1000 per schedule). A new schedule is saved switched off unless "switch it on" is ticked. The Overview's Health line and an amber count on the sidebar's Schedules item say when a file is invalid or a prefilter fails. A save over a file the agent changed meanwhile (its notes after a run) is refused with "changed on disk" and a Reload button. Telegram: `/schedules`, `/run <name>`; a reply to a schedule's report (or to any message of the bot) switches the chat to that conversation — **topics**, §4.4 — so "look at the second mail in more detail" continues the run's session.

### 4.4 Session lifecycle

The session manager is the piece Claude Code does not provide and the core of the "zero idle cost" promise.

Every task is a **one-shot** `claude -p` run: the process starts for the task and exits with the result. Continuity lives in the conversation, which remembers the session id and resumes it with `--resume` for the next task. Nothing is kept warm between tasks, so there is no idle timer and nothing to "close" — the v1.1 idle-timeout model was dropped in v1.2 and is not coming back.

stdin is stream-json too (since 2026-09-30): after an `initialize` control request the prompt goes out as a user message and stdin stays open until the result, with `--permission-prompt-tool stdio`. That is what makes the CLI offer `AskUserQuestion` in print mode and route it — like any permission prompt the mode leaves open — to the supervisor as a `can_use_tool` control request. Without such a host the tool does not exist in `-p` and the agent can only ask in prose, which ends the run.

```
                 task queued (owner message, cron, restart recovery)
                            │
              ┌─────────────▼─────────────┐
   no session │  spawn                    │ conversation has a session
   ───────────►  claude -p                ◄──────────────── --resume <session_id>
              │   --input-format  stream-json      (cwd = project checkout or workspaces root;
              │   --output-format stream-json       a cwd change starts a fresh session)
              │   --permission-prompt-tool stdio
              │   --max-turns N
              └─────────────┬─────────────┘
                            │ stdin:  initialize, the prompt, control responses (answers)
                            │ stdout: text, tool events, sub-agent events, rate limits, result
                            ▼
                     ┌── running ──┐
                     │             │  can_use_tool (question / permission)
                     │             ├────────────────► task.ask set, timeout paused,
                     │             │                  owner asked on web + Telegram
                     │             ◄──────────────── control_response (answer / allow / deny)
                     │             │
        result       │             │  /stop  ·  wall-clock timeout  ·  max turns
                     ▼             ▼
                   done          cancelled / failed  (SIGTERM to the process group, SIGKILL 10 s later)
                     transcript stays in CLAUDE_CONFIG_DIR/projects/<ws>/<session_id>.jsonl
```

Rules:

- **Spawn on demand.** One task → one `claude -p` process, cwd = the checkout of the conversation's project (a project-less conversation runs from the workspaces root). Several may run concurrently (bounded by `MAX_CONCURRENT_SESSIONS`, RAM ≈ 1 GiB each); one running task per conversation.
- **Questions and permissions.** A `can_use_tool` request is stored on the task (`ask`: kind, request id, tool, input, answers so far) and shown in the web thread (a form inside the turn) and in Telegram (one message per question with inline buttons; free text also counts). The task stays `running`, its wall-clock timeout is paused, and it keeps its concurrency slot for as long as it waits (decided 2026-09-30). The answer from either channel goes back as a `control_response`, the other channel's prompt is settled, and the same run continues. Under `bypassPermissions` (the container) only `AskUserQuestion` arrives; under `acceptEdits` / `default` every unsettled tool does. Open: "Always allow" rules and a deny-on-timeout policy.
- **Hard stop.** `/stop` (or the Stop button) sends SIGTERM to the CLI's process group, SIGKILL after 10 s, and marks the task `cancelled`. `CLAUDE_TASK_TIMEOUT_MIN` bounds a run's wall-clock time (0 = none).
- **Resume.** The next task of the same conversation restarts the process with `--resume <session_id>`. Context continuity is Claude Code's own transcript, nothing is copied. A session that cannot be resumed is forgotten and the task runs once more from scratch. `/new` starts a conversation without a session.
- **Crash safety.** If the supervisor restarts (deploy, reboot, crash), running CLIs are lost. A task found `running` at startup goes back to the queue and its next run resumes the conversation's session, so the agent continues from where the transcript ends (the task's prompt is sent once more to the resumed session; the dispatcher rules say a repeated prompt means "continue"). Each task survives this once (`restarts` column); a task that keeps hitting restarts fails with a notice, so a task that takes the supervisor down cannot loop. A pending question is lost with the process; the resumed session asks again. A graceful stop (SIGTERM to the supervisor) leaves running tasks `running` on purpose for the same recovery; only the owner's `/stop` cancels.
- **Bounds.** Every spawn sets `--max-turns`; `CLAUDE_TASK_TIMEOUT_MIN` bounds wall-clock time. No `--max-budget-usd` (dropped 2026-10-05): the CLI tells the model its remaining dollars and the agent then rations work by money, which means nothing on a subscription; the windows (§7) are the limit and the API enforces them.

---

## 5. Configuration Model ("the factory")

Four layers, all plain files under `/data`, editable by UI, by the owner, and by the agent itself. The first two live where Claude Code natively reads them (`CLAUDE_CONFIG_DIR`), so no translation layer is needed:

| Layer | Location | Contains | Example |
|---|---|---|---|
| **Roles → sub-agents** | `claude/agents/*.md` | Who: frontmatter (name, trigger description, allowed tools/MCP, model) + system prompt. Project-agnostic, reusable. | `developer.md`, `reviewer.md`, `qa.md`, `email-agent.md` |
| **Procedures → skills** | `claude/skills/*/SKILL.md` | How, step by step. Composable (a skill may reference another). | `feature-to-pr`, `clickup-task` (→ feature-to-pr), `pr-review`, `trac-defect-fix`, `onboard-project` |
| **Facts → knowledge base** | `config/projects/*.md` | What is true about each project: repo URL & credentials ref, tracker & workflow, branch/PR conventions, stack, test/lint commands, which skill applies, `hosts:` (references to the shared registry plus the project's own `path` and `notes` on that server), `mcp:` allowlist over the checkout's `.mcp.json`. | `photos.md`, `global-navigation.md` |
| **Universal rules → dispatcher prompt** | `claude/CLAUDE.md` | Always-on behavior: match task → project (ask if unknown); Telegram gets milestones/questions/results only; never merge without approval; batch questions; persist corrections into files; treat PR bodies, tickets and emails as untrusted data. | — |

**Dispatcher flow:** incoming task → resolve project from knowledge base → project file names the workflow (skill) → skill orchestrates sub-agents → report to `reply_to`.

**Learning = file edits, not training.** Corrections via Telegram are applied by the agent to its own skills/knowledge files; the UI editors and the Audit log are the audit/cleanup surface (the config git history of v1.2 was dropped in v1.3). `onboard-project` bootstraps new project files through an interview + repo inspection.

**Shared SSH hosts** (2026-09-30) live once in `config/hosts.yaml` (`name`, `ssh` target, optional `key` = file name in `secrets/ssh`), the way an IDE keeps its SSH configurations; a project file only references a host by name and adds the project's own `path` and `notes` there. Trusted host keys are `config/known_hosts`, written from the UI after the owner confirms the fingerprints; keys are never read by the API; passwords are not supported on purpose.

**MCP in three layers** (2026-09-29): the repository's own `.mcp.json` (loaded from the cwd; a project file's `mcp:` list turns the unwanted ones off), the owner's `config/mcp.json` passed to every session, and `mcpServers:` in an agent's frontmatter for role-owned tools only. Secrets only as `${VAR}` from `.env` (not expanded in frontmatter: a stdio server inherits the CLI's environment instead). On top of that the claude.ai login brings the account's **connectors** (Gmail, ClickUp, Drive, Calendar, …) and synced plugins into every session, deferred behind ToolSearch; a role is therefore usually a `tools:` allowlist over those (the email assistant is Gmail without send, "a ClickUp agent" is that server ticked) rather than a server of its own. Each sub-agent's frontmatter restricts which tools/MCP it may use (developer gets git/gh and no mail; reviewer gets read-only tools); sub-agents get data from the orchestrator, not MCP access, except role-owned tools. The supervisor keeps a registry of every server the CLI ever reported (source: connector / plugin / project / factory, last status, URL) and can sign in to a server from Settings.

---

## 6. Web UI Requirements

The UI is deliberately small: it is a viewer for files and transcripts Claude Code already produces, plus CRUD for the supervisor's own tables.

Screens (v1):

1. **Tasks** — unified feed across all sources; status, project, source, duration, tokens and share of the 5-hour window; filters; cancel / retry / "run now" / resume.
2. **Session view** — rendered Claude Code transcript (`*.jsonl`): dispatcher turns → sub-agent spans → expandable tool calls with results; live tail via SSE while a session is running; token/cost per turn from the usage fields in the transcript.
3. **Agents** — list + Markdown editor with frontmatter form (name, description/trigger, tools/MCP allowlist, model).
4. **Skills** — same editor pattern; show which skills reference which.
5. **Projects** — knowledge-base editor; onboarding wizard (drives the `onboard-project` skill).
6. **Schedules** — the schedule files (cron, window, project or hosts, skill / agent, mode, prefilter, instructions) with their live state: valid / on / off, next run, last run and why, run history, seen items; Run now, Preview prefilter, Switch on / off, Forget seen items.
7. **Quota dashboard** — the 5-hour and weekly windows as the CLI reports them (`rate_limit_event`), with reset times and a history of readings; tokens per day/project/agent/task-type; forecast to limit. No money anywhere: the owner pays a subscription, so the unit is tokens and window share.
8. **Settings** — MCP: the registry of servers the sessions have seen (connectors first, then plugins, project and factory servers; duplicates by URL folded into the connector's row), Refresh (`claude mcp list` in the factory), Authorize for a server that needs sign-in (the CLI's `claude mcp login --no-browser` under a pseudo-terminal; the dialog shows the link and, for a redirect-style server, takes the redirect URL back), and the editor for `config/mcp.json`. Hosts: the shared SSH registry with the projects on each, test connection, host-key trust. Presets install. Shows the Claude login status (`claude.ai (team, connectors)` / `token` / `none`) but never performs the login. Telegram whitelist, concurrency and timeouts stay in `.env`.
9. **Audit log** — every model call (model, tokens), tool call, file edit, sub-agent start / end, task lifecycle and rate-limit reading, each attributed to the agent that produced it (orchestrator or sub-agent type) and the project the task worked in. Period selector, filter by kind / agent / project, expandable details. Built live from the stream-json events; there is no separate config git history (dropped in v1.3: the owner's repositories are on GitHub, and self-edits of agents / skills show up here as file events).

Non-functional: UI is behind its own sign-in (a password from `.env`, a session cookie per browser, lockout after repeated failures, every attempt logged and reported in Telegram; Tailscale/Cloudflare Access and https in front recommended) — it controls an agent holding GitHub and mail credentials.

---

## 7. Logging & Observability

- **Transcripts are the log of record.** Claude Code writes every session to `CLAUDE_CONFIG_DIR/projects/<workspace>/<session_id>.jsonl` (assistant messages, tool_use/tool_result, sub-agent activity, per-turn usage). The supervisor does not duplicate this; it indexes it:

```
sessions (session_id, task_id, workspace, started_at, ended_at,
          turns, tokens_in, tokens_out, cache_read, cost_usd, model)
usage_daily (date, project, agent, task_type, tokens_in, tokens_out, cost_usd)
```

- Tokens per task come from the `result` message in stream-json output (`usage`, cache read/creation included); `total_cost_usd` is stored for the record but never shown. Window utilisation comes from the `rate_limit_event` messages (`unifiedWindows.five_hour` / `seven_day`, utilisation 0..1 and reset time) that the CLI emits after API calls; every task refreshes it, and an explicit probe (one Haiku turn) refreshes it on demand. The `/api/oauth/usage` endpoint is not used: it needs the `user:profile` scope a setup-token lacks, and even with the claude.ai login the supervisor never calls Anthropic APIs with the owner's credentials (decided 2026-09-29). Per-turn detail is parsed from the transcript for the session view and aggregates.
- Supervisor's own logs (bot, scheduler, prefilters, lifecycle events) go to stdout/JSON files under `/data/logs`.
- Optional: enable Claude Code's built-in OpenTelemetry export (`CLAUDE_CODE_ENABLE_TELEMETRY=1`, OTLP env vars) if the owner already runs a collector. Not required for v1.

### Budget & quota protection

- Per-task ceiling in turns (`--max-turns`) and wall-clock time; no dollar ceiling (see §4.4 Bounds). A per-task token budget enforced by the supervisor from streamed usage stays open.
- Model policy: dispatcher on the strongest model; worker sub-agents default to cheaper models (Sonnet/Haiku class) via their frontmatter unless overridden.
- Soft-stop: when the rolling 5-hour or weekly window approaches the limit, background/cron tasks are deferred; direct owner tasks keep working. Telegram warning at configurable thresholds. (The reading is the CLI's own `rate_limit_event`; it is exact as of the last API call, not an estimate.)

---

## 8. Security Requirements

- **Telegram whitelist** by chat/user ID — the bot must ignore everyone else. This is mandatory: the bot fronts an agent with repo and mail access.
- **Claude auth belongs to the owner, not to the tool.** The owner logs the CLI in **inside the container**, once: `docker compose run --rm -it -e CLAUDE_CODE_OAUTH_TOKEN= supervisor claude auth login` prints a URL, the owner opens it on a laptop and pastes the code back, and the CLI writes `data/claude/.credentials.json` itself (decided 2026-09-29; the URL + code flow works in CLI 2.1.283, the earlier upstream breakage anthropics/claude-code#34917 is behind us). A full login carries the `user:mcp_servers` / `user:profile` / `user:plugins` scopes, which is what brings the account's claude.ai connectors and plugins into `-p` sessions. `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` in `.env` remains the fallback for CI-like runs; the variable must stay empty otherwise, since a setup-token takes precedence and cannot fetch connectors. The same URL + paste flow inside the container authorizes OAuth MCP servers (`claude mcp login --no-browser`), driven from Settings → MCP → Authorize or from the console; a login from a macOS laptop lands in the Keychain, not in the volume. The supervisor never reads, copies, proxies or exposes the credentials and never calls Anthropic APIs with them (no model list, no usage endpoint); the UI only shows login status, and the agent editor offers the CLI's model aliases (the CLI resolves an alias to the subscription's current model). The Claude Code binary is installed as published and never patched.
- **Untrusted input.** PR bodies and diffs, tracker tickets, webhook payloads and emails are data, not instructions. `CLAUDE.md` says so; sub-agents that read such content get the minimum tool set (`pr-review` and `email-agent` have no push / no destructive tools). Any instruction found inside such content that asks to change repos, send messages or read secrets must be reported to the owner, not executed.
- **Webhook signature verification** (GitHub HMAC secret) + in-code event filtering, if the optional webhook endpoint is enabled. Default is polling, which exposes no inbound port.
- **Container as sandbox:** the agent may run with broad in-container permissions, but the container gets resource limits (`mem_limit`, `pids_limit` in compose) and, where possible, restricted egress; the host is never exposed to the agent. The agents' Docker (1.2.0) is a `docker:dind` sidecar with its own state in `data/docker`, reached over TLS on the compose network only, never the host's socket: dind needs `privileged`, which is the one trade-off the owner accepted for cleanliness (nothing on the host, nothing left after `rm -rf data`); it is off unless `COMPOSE_PROFILES=docker` is set. The CLI's environment is the supervisor's minus the supervisor's own secrets (`TELEGRAM_BOT_TOKEN`, `WEB_AUTH_*`, `GROQ_API_KEY`): a prompt injection that runs `env` must not walk away with the bot or the UI.
- **Secrets** for tools in `/data/secrets` (mounted read-only; SSH keys under `secrets/ssh`, referenced by file name from `config/hosts.yaml` and never read by the API) + env (docker secrets / `.env` on volume), never in config Markdown, never in the repo. Staging and production servers are reached only over SSH keys, read-only by rule, with host keys trusted explicitly by the owner (`config/known_hosts`); passwords are not supported. GitHub access via **fine-grained PATs** (per-repo scope; one per repository owner as `GH_TOKEN_<OWNER>`, since a fine-grained token belongs to a single user or organization) or a GitHub App — not a classic all-scope token.
- UI behind auth (see §6): a sign-in page with `WEB_AUTH_USER` / `WEB_AUTH_PASSWORD` (constant-time compare), an HttpOnly SameSite=Strict session cookie whose hash lives in the store, `WEB_LOGIN_MAX_FAILURES` wrong passwords within `WEB_LOGIN_LOCK_MIN` minutes lock the address (and, at four times that, everyone) for as long, every attempt is logged, shown in Settings → Security and told in Telegram (sign-in, first failure, lock); sessions can be revoked from Settings. HTTPS via reverse proxy (Caddy/Traefik) or Cloudflare Tunnel, with `WEB_TRUST_PROXY=1` so the client address is the real one. The API refuses mutating requests with a foreign `Origin` in both modes, refuses foreign `Host` names without a password (DNS rebinding), caps request bodies at 2 MB, answers `/api` with `Cache-Control: no-store` and sets the usual security headers.
- No destructive actions without a human gate: merging PRs, deleting branches/data, sending email, and anything irreversible require explicit confirmation. The mechanism is the CLI's own permission prompt relayed over stream-json (§4.4): under `bypassPermissions` the gate is the `AskUserQuestion` the skills call before such steps, under `acceptEdits` / `default` every unsettled tool call reaches the owner as Allow / Deny.

---

## 9. Portability & Scaling

- **All state in `/data`** (Claude Code config + credentials + transcripts, project config, workspaces, secrets, db, logs). The image is stateless.
- **Migration:** `docker compose down` → rsync `/data` → `docker compose up` on the new VPS. Everything moves: agents, skills, memory, login, history.
- **Scaling v1:** semantic sharding — a second VPS runs an independent instance (e.g. a dedicated mail instance), each with its own bot.
- **Concurrency** within one instance is bounded by RAM (≈1 GiB per open session) and by the subscription's usage limits, not by the supervisor.

---

## 10. Technology Stack (proposed)

| Concern | Choice | Rationale |
|---|---|---|
| Agent runtime | **Claude Code CLI**, unmodified, `claude -p` with `--input-format/--output-format stream-json` | The owner's own subscription and login; sub-agents, skills, sessions, memory, MCP, transcripts all built in. The tool only supervises. |
| Language | TypeScript / Node 22 | Single language across supervisor and UI; owner's stack. |
| Telegram | grammY | Long polling, mature middleware. |
| STT | Whisper via Groq API (default) or faster-whisper (local) | A small VPS CPU is slow for local Whisper; voice is occasional, API is cheap and fast. Local stays an option. |
| Queue/scheduler | SQLite table + worker; node-cron | Simplest thing that works. |
| DB | SQLite on volume (WAL) | Zero-ops, portable. |
| Web UI | Vite + React SPA served by the supervisor | One container, no SSR needed for an admin panel; same TypeScript types as the API. |
| Observability | Claude Code transcripts + SQLite index; optional OTEL export | Don't rebuild what the CLI already writes. |
| GitHub | `gh` CLI + fine-grained PAT / GitHub App | PRs, reviews, comments, polling. |
| Trackers | ClickUp MCP, TRAC API (custom prefilter script + MCP) | Per-project binding. |
| Deployment | Docker Compose; Caddy or Cloudflare Tunnel only for the UI (and webhooks if enabled) | Single-file infra. |

---

## 11. Roadmap

| Phase | Deliverable | Acceptance |
|---|---|---|
| **0. Skeleton** ✅ | Repo, Dockerfile (node + claude-code + git + gh), compose, `/data` layout, Claude login documented (`claude auth login` in the container since v1.4; setup-token as fallback) | `docker compose up` runs on a clean VPS; `claude -p "hi"` answers from inside the container |
| **1. Voice hotfix** ✅ (code) | Telegram bot + STT → `claude -p` in the owner's checkout → reply in Telegram; `developer`/`reviewer` agents, `feature-to-pr` skill, project file format + `onboard-project` | UC-1 end-to-end from a voice note: PR link comes back; zero tokens when idle — **still to be exercised on a real project** |
| **2. Lifecycle & persistence** ✅ | Task queue in SQLite, session manager (`/new`, `/stop`, `--resume`, one-shot runs), HITL questions via Telegram and the web (`AskUserQuestion` / permission prompts over stream-json since 2026-09-30, earlier the agent's final message ↔ owner's reply), crash recovery (running tasks re-queued once and resumed) | UC-2 and UC-8: a conversation survives a supervisor restart; a pending question is asked again |
| **3. Web UI (read)** ✅ | Task feed + session view (transcript rendering, SSE live feed), overview with spend from the tasks table, **chat with Claude Code from the browser** | Owner can watch a live run and see spend without SSH |
| **4. Factory CRUD** ✅ | Agent/skill/project editors (projects incl. tracker + hosts), audit log, presets install, `onboard-project`, correction-to-file loop via CLAUDE.md rule | UC-5, UC-6, UC-7 work from both TG and UI; every agent self-edit is a file event in the Audit log |
| **5. Schedules** ✅ (code) | Schedule files + UI, prefilter pattern (`command`, `github-prs`, `trac`), soft-stop, Telegram `/schedules` `/run` | UC-3 and UC-4: zero tokens on empty polls — **the Trac poller still needs the owner's credentials in `.env` and a first real run in the container** |
| **6. Hardening** | Budgets/soft-stop, quota estimate, backups of `/data`, template-ization (README for forkers with the conditions from §1.7), optional webhook ingress | Quota forecast visible; fork-and-run documented and tested on a fresh account |

Phase 1 is deliberately the whole "driving to a conference" story: if it works, everything after is refinement.

---

## 12. Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Token burn by autonomous loops (dispatcher + 3 sub-agents on a strong model) | Subscription window exhausted mid-day | Per-task budgets, model policy for sub-agents, soft-stop for background tasks, cost dashboard with forecast |
| Runaway/looping agent | Cost + garbage PRs | `--max-turns` on every spawn, per-sub-agent turn caps, wall-clock timeout per task, kill switch (`/stop`) in TG and UI |
| Prompt injection via PR bodies, tickets, emails | Credential misuse, unwanted pushes/emails | Untrusted-input rule in `CLAUDE.md`, minimal tool sets per sub-agent, human gate on irreversible actions, fine-grained PATs |
| Credential blast radius (GitHub + mail in one box) | Account compromise | Fine-grained PATs, per-agent MCP/tool allowlists, container egress limits, TG whitelist |
| Usage-policy drift: limits assume "ordinary, individual usage"; heavy background automation could look otherwise | Account restricted | Keep cron/background work modest and prefiltered; owner-initiated tasks are the primary load; re-read the policy at each phase |
| Reviewer agent rubber-stamps the developer agent | Bad PRs while owner is away | Reviewer runs in a fresh context with diff + project rules only; deterministic checks (tests, lint, CI) are the real gate; start supervised (report before PR), graduate to full autonomy per project |
| Run lost to a supervisor restart or a stuck question | Lost work, a slot held for ever | A task found `running` at startup is re-queued once and resumes its session; a question holds the slot by decision (2026-09-30) — a deny-on-timeout policy is still open |
| Claude Code CLI changes flags/transcript format | Supervisor breaks | Pin the CLI version in the image; upgrade deliberately; integration test on `stream-json` shape |
| SQLite contention at scale | Slow UI during runs | WAL mode; Postgres migration path documented |

---

## 13. Open Questions

0. ~~Idle timeout / closing-phrase detection~~ — **moot since v1.2:** runs are one-shot; nothing stays warm. v1.4 did introduce `--input-format stream-json`, but only to relay questions and permissions inside a run; the process still exits with the result, so the question stays closed.

1. ~~Claude auth mode for production~~ — **Decided (v1.1, revised 2026-09-29):** the owner's own claude.ai login inside the container (`claude auth login`, URL + code), credentials in `data/claude/.credentials.json` written by the CLI; `claude setup-token` → `.env` only as the fallback. The tool never holds or uses the credentials itself (§8).
2. ~~Does the pinned Claude Code version support `--max-budget-usd`?~~ — **Yes** (verified on 2.1.283), but it is not used since 2026-10-05: the model sees the remaining dollars and rations work by them.
3. ~~Quota visibility~~ — answered 2026-09-28: `claude -p --output-format stream-json` emits `rate_limit_event` with `unifiedWindows.five_hour` / `seven_day` utilisation and reset times (CLI 2.1.283); works with a setup-token. Implemented (§7).
4. STT: confirm Groq Whisper latency/cost from a moving car (LTE); keep faster-whisper as a fallback for offline-ish VPS setups.
5. ~~Closing-phrase detection: pure keyword list + `/done`, or let the agent emit an explicit "session can be closed" marker in its final report?~~ — **moot** for the same reason as 0; there is no `/done`. The dispatcher suggests `/new` after a finished task instead.
6. Voice replies (TTS) from the agent — nice-to-have, out of v1 scope?
7. How much of the transcript should be mirrored into Telegram on failure (error digest format).
8. ~~Staging access pattern for UC-4 (how sub-agents reach the staging environment: SSH? VPN? MCP?)~~ — **Decided (2026-09-29):** SSH only, through the project file's `hosts:` (a shared host from `config/hosts.yaml` with its key in `data/secrets/ssh`, plus the project's own `path` and `notes` with the rules), strictly read-only; a project without hosts reproduces from the code and tests, and the triager asks the owner when neither suffices. No VPN, no dedicated MCP server. The remaining risk (a ticket is untrusted input and the sub-agent holds a shell) is covered by the read-only rule in the skill and the host notes, the Audit log, and, where wanted, a restricted user or `command=` on the host itself.
9. Webhook ingress: is anyone going to miss the few-minutes latency of polling enough to justify a public endpoint?
10. Permission policy: "Always allow" rules per tool / project so a recurring prompt is settled once, and what happens to a question nobody answers (deny after N hours? keep holding the slot?). Today a waiting task holds its slot indefinitely (decided 2026-09-30).

---

## Appendix A — Repository Layout (proposed)

```
pocket-factory/
├── docker-compose.yml
├── Dockerfile                # node 22 + @anthropic-ai/claude-code (pinned) + git + gh
├── .env.example
├── supervisor/               # telegram bot, STT, queue / session manager, scheduler + prefilters, HTTP API (TypeScript)
├── web/                      # Vite + React admin UI, served by the supervisor
├── templates/claude/         # seeded into data/claude (CLAUDE.md, agents/, skills/)
├── presets/                  # shareable agent + skill bundles, installable from the UI
└── data/                     # → mounted volume in production
    ├── claude/               # CLAUDE_CONFIG_DIR — owned by Claude Code
    │   ├── CLAUDE.md         #   dispatcher rules
    │   ├── agents/           #   developer.md, reviewer.md, …
    │   ├── skills/           #   feature-to-pr/, onboard-project/, …
    │   ├── projects/         #   session transcripts (*.jsonl), written by the CLI
    │   └── (credentials)     #   never touched by the tool
    ├── config/               # the supervisor's own files
    │   ├── projects/         #   photos.md, global-navigation.md, … (frontmatter: repo, branches, tracker, hosts, mcp, checks)
    │   ├── schedules/        #   recurring tasks (cron, prefilter, instructions + the agent's notes)
    │   ├── hosts.yaml        #   shared SSH hosts (name, ssh target, key file name)
    │   ├── known_hosts       #   host keys the owner trusted from the UI
    │   └── mcp.json          #   the owner's MCP servers, passed to every session
    ├── workspaces/           # the owner's checkouts (or WORKSPACES_DIR bind-mounted)
    ├── secrets/ssh/          # keys for project hosts → ~/.ssh in the container (mounted read-only)
    ├── db/                   # sqlite: conversations, tasks, task_events
    └── logs/                 # supervisor logs
```
