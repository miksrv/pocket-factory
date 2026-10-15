# Landscape: what else drives Claude Code from a phone (2026-10)

Projects that overlap with Pocket Factory, surveyed to decide what to borrow. Facts and GitHub
stars as of 6 October 2026; *unverified* = seen only in search results.

**The picture.** Anthropic now covers the "laptop lid" story itself on Pro / Max (Agent View,
Dispatch, Projects, Routines, Desktop scheduled tasks). The open-source field moved towards
multi-runtime control planes (Claude Code, Codex, OpenCode behind one UI), a worktree per task,
and personal agents with memory. Pocket Factory's margin: the owner's real checkouts with their
MCP servers on the owner's server, an audit log per tool call, prefilters that make an empty poll
free, and roles / skills / projects as files with an editor.

## Anthropic's own offerings

| | What it is | Overlap with Pocket Factory |
|---|---|---|
| **Remote Control** (`claude remote-control`, `/rc`) | A live `claude` process on your machine driven from claude.ai/code or the Claude app. Server mode: `--spawn worktree`, `--capacity` (default 32), resume within ~4 h, push notifications ("when actions required"), Trusted Devices. Pro / Max / Team / Enterprise; not with `ANTHROPIC_BASE_URL`. | Permission prompts, `AskUserQuestion`, photos, push from the phone. Pains (#36807, #29219, #32202): the token expires in days and `/login` needs a browser on the host, ~10 min offline ends the session, transcripts at Anthropic. No queue, no audit. |
| **Agent View** (`claude agents`, May 2026, research preview) | A terminal dashboard over background sessions under a **supervisor daemon**: they survive closing the terminal and sleep, a worktree each, questions from a peek panel, idle processes stop after ~1 h and resume on reply. | Closest to Pocket Factory's queue, but local only, a shutdown fails sessions, no audit, no Telegram. |
| **Dispatch** (mobile app → Desktop) | Describe a task on the phone; the Desktop app spawns a Code or Cowork session for it, push on completion / input. "Remote Control = continue, Dispatch = create." | Needs the Desktop app awake. No queue, no schedules. |
| **Projects** (claude.ai/code, public beta on Pro / Max, rolling out) | One conversation; Claude starts a **thread** per task, usually in the cloud, locally through Remote Control on request; shows which threads need you. | The same conversation → tasks model. Cloud threads are fresh clones without local MCP; local ones need the live machine. Not on Team / Enterprise yet. |
| **Routines** (April 2026, research preview, Pro / Max / Team / Enterprise) | A saved prompt + repositories + connectors in Anthropic's cloud. Triggers: cron (**minimum one hour**), `POST …/fire` with a per-routine bearer and the payload wrapped as untrusted, GitHub events with filters. Every run draws usage. | Schedules' shape, in the cloud: fresh clone per run, no local MCP, no memory beyond the repository, tokens even when there is nothing to do. The `/fire` design is worth copying. |
| **Desktop scheduled tasks** (Claude Desktop ≥ 1.1.5368) | Local routines: one-minute minimum, **"always allow" per task** with a revoke panel, optional worktree, one catch-up run after sleep, a `SKILL.md` per task. | Only while the app is open and the machine awake. The always-allow panel is the model for SPEC §12. |
| **Channels** (March 2026, research preview; Telegram, Discord, iMessage, fakechat) | An MCP server pushes messages into an *already running* session; pairing + allowlist; optional permission relay. Needs Bun. | Only while a session runs; no questions in `-p`, no history, no queue. |
| **Self-hosted environments** (public beta, Team / Enterprise only) | Runners in your network execute cloud sessions and routines; transcripts still go to Anthropic. | Not available on Pro / Max. |
| **`/loop`, `CronCreate`** | In-session scheduling, restored on `--resume`. | Tied to one live session. |

## Open-source bridges, clients and orchestrators

| Project | ★ | What it does | Relevant to Pocket Factory |
|---|---|---|---|
| **Happy** (slopus/happy, MIT) | 24k | Mobile / web client for Claude Code and Codex, E2E-encrypted relay, realtime voice, push on permission requests | Interactive CLI wrapper; no queue, schedules or audit. |
| **Paseo** (getpaseo/paseo, source-available) | 19.7k | A daemon that runs Claude Code, Codex, Copilot, OpenCode, Pi and more; clients on every platform; worktrees, voice, scheduling, multi-agent fan-out, an SDK, plugins, E2E relay or Tailscale; "plan with Claude, implement with Codex" skills | The most complete self-hosted control plane. No Telegram, no per-tool audit, no subscription windows, no role / skill management. |
| **claudecodeui / CloudCLI** (siteboon, AGPL) | 14k | Web + mobile UI over `~/.claude`: file explorer, git panel, terminal, MCP and permissions in the UI, image input, usage dashboard, Docker sandbox, paid cloud tier; also OpenCode, Cursor CLI, Codex | Session UI, not a session manager. |
| **claude-code-telegram** (overwirehq, ex RichardAtCT) | 2.8k | Telegram → Agent SDK or CLI; photos, voice, file uploads, per-user cost caps, GitHub webhook (HMAC), cron, multi-user | The reference Telegram bridge. No web UI, no audit, no windows. |
| **takopi** (banteg, MIT) | 1k | Telegram bridge for Codex, Claude Code, OpenCode, Pi: forum topics bound to repo / branch, a worktree per branch, per-session queue, files both ways, "stateless resume" | Files back to the chat is the idea left to take. |
| **ductor** (PleasePrompto, MIT) | 457 | Claude Code / Codex / Gemini CLI from Telegram: live streaming, persistent memory, cron jobs, webhooks, Docker sandboxing | Overlaps most with schedules + memory. |
| **c3** (andrometiq, Go, MIT) | 2 | One bot, a topic per project, adapters for seven CLIs, Allow / Deny buttons, a durable offline queue, voice in / TTS out | Sits inside an interactive session. |
| **ccgram** (jsayubi, MIT) | 27 | Notifications, permission approvals and keystroke injection over Telegram | Notify-and-reply. |
| **telegramcode**, **tg-claude-bot**, **mas-aleksey/claude-bot**, **Claude-Code-Remote** | — | September entries: tmux scraping or stream-json, resume any laptop session from an inline picker, auto-continue after a usage-limit reset, Docker-in-Docker per project | "Resume a laptop session" is the idea left to take. |
| **Discord**: claudecode-discord, claude-code-discord, claudecord | — | Multi-machine hub with approval buttons and a usage dashboard; thread = session; bring-your-own subscription | — |
| **Vibe Kanban** (Apache-2.0, main project sunsetting; `vibe-kanban-indie` fork) | 28k | Kanban → worktree → agent → diff review with inline comments → PR | The diff-and-PR review screen. |
| **Paperclip** (MIT, Postgres) | 93k | Agents as employees with token / dollar budgets, approval gates, cron routines, an immutable activity log | Company scale; the budget + activity-log pairing is the one to learn from. |
| **claude-code-runner**, **CLITrigger**, **claude-orchestrator**, **Sillage**, **OpenClawdex** | small | Self-hosted runners / dashboards: HTTP → `claude -p`; parallel worktrees; full-text search over sessions | Confirms the "agent behind an HTTP API" pattern; none has Telegram + audit + schedules together. |
| **ccusage** (MIT) | 19k | 5-hour blocks and daily / weekly reports from JSONL transcripts | Export target for the audit log. |
| **agents-observe**, OTel export (`CLAUDE_CODE_ENABLE_TELEMETRY=1`, enhanced tracing beta) | — | Hook-based live dashboards; aggregated metrics to a collector | One machine's sessions; Pocket Factory's audit needs no hooks. |
| **BAND** (band.ai, SaaS) | — | Chat rooms where agents and people @mention each other, approvals, audit trail; Band Desktop binds local Claude Code / Codex sessions to rooms | Same ideas (approvals in chat, audit), SaaS backplane, no self-hosting. |
| **OpenCode `serve`** | — | The agent as an HTTP server with OpenAPI, SSE, `prompt_async`, endpoints to answer permissions | The cleanest "agent behind an API" reference. |
| Proprietary clouds (Cursor background agents, Codex cloud, Jules, Devin) | — | Sandbox VMs | None self-hosted on an individual subscription. |

## Personal agents: OpenClaw and Hermes

Not Claude Code drivers, but they set what people now expect from "an agent on my own box":

- **OpenClaw** (ex Clawdbot / Moltbot, MIT, 391k★): a persistent daemon on 12+ messaging platforms,
  a heartbeat scheduler, memory and skills as Markdown / YAML, a web control UI, 50+ integrations.
  Its 2026 incidents (prompt injection through an inbox summary that leaked an SSH key, memory
  poisoning, malicious hub skills, exposed ports, a token-burning heartbeat) are already Pocket
  Factory's rules; what is missing is making them *visible* as a feature.
- **Hermes Agent** (Nous Research, MIT, 252k★): writes its own skills, keeps memory across
  sessions and searches past conversations, scheduled tasks, every messenger, any model, a $5 VPS.
  Memory between conversations is the idea to take.

## Where Pocket Factory stands

| | Pocket Factory | Remote Control | Agent View | Projects | Routines | Channels | Paseo | Happy / claudecodeui | Telegram bridges |
|---|---|---|---|---|---|---|---|---|---|
| Keeps working with the laptop off | yes (own server) | no (live process) | no (local daemon) | cloud threads yes, local no | yes (cloud) | no | yes if the daemon is on a server | no | depends on the host |
| Works in your real checkout with its `.mcp.json`, `CLAUDE.md`, `.claude/` | yes | yes | yes | local threads only | no (fresh clone) | yes | yes | yes | yes |
| Telegram in / out | yes, voice too | no (Claude app) | no | no (Claude app) | no | yes | no | no | yes |
| Queue that survives restarts | yes | no | partly (jobs on disk) | cloud | cloud | no | per daemon | no | some |
| Questions / permissions from the phone | yes (web + Telegram) | yes | peek panel, local | yes | n/a (autonomous) | relay | yes | yes | buttons |
| Schedules | files, 1-minute cron, deterministic prefilter, zero tokens on an empty poll | no | no | routines tab | ≥ 1 h, every run costs | no | yes | no | cron in some |
| Audit per model call / tool call / sub-agent, per agent and project | yes | no | no | no | run transcript | no | change history | no | no |
| Subscription windows in the UI / chat | yes (`rate_limit_event`) | app | no | app | app | no | no | usage dashboard | some |
| Agents / skills / projects as files with an editor, presets | yes | no | no | no | prompt + connectors | no | plugins | MCP / permissions | no |
| Transcript stays on your server | yes | no (stored at Anthropic) | yes | no | no | yes | yes | yes | yes |
| Works behind `ANTHROPIC_BASE_URL` | yes | no | yes | no | no | n/a | yes | yes | yes |
| Beyond Claude | other models (since 1.3.0) | no | no | no | no | no | other agents (Codex, OpenCode) | other agents | other agents |
| Worktree per task | no | yes | yes | yes | n/a | no | yes | no | some |
| Photos / files in | yes | yes | n/a | yes | n/a | yes | yes | yes | yes |
| Diff panel + Create PR | yes | app | no | yes | yes | no | yes | git panel | no |

## What most of them have and Pocket Factory does not

1. **Files back to the chat** (takopi); files in arrived in 1.1.0.
2. **A worktree per task** as an opt-in per project. "One task per conversation in the real
   checkout" is deliberate but serialises a repository; Agent View, Remote Control, Paseo and
   takopi all isolate by default.
3. **Merge from the UI** (the diff panel and Create PR arrived in 1.1.0).
4. **"Always allow" rules per tool / project** (SPEC §12, Always allow); Desktop scheduled tasks
   show the UI: a per-task panel with revoke.
5. **An HTTP trigger** so CI, Sentry and GitHub Actions can start a task without polling.
6. **Resuming a laptop session** from the chat (`sessions/transcripts.ts` already indexes them).
7. **Memory across conversations** beyond `CLAUDE.md` and the project files (Hermes, ductor,
   OpenClaw).
8. **Other agent runtimes** (Codex, OpenCode). Deliberately not: see below.

## What Pocket Factory has that almost nobody does

- **An audit log per model call, tool call and sub-agent**, built live from stream-json; only
  Paperclip (action level) and hook / OTel dashboards come close.
- **Subscription windows from `rate_limit_event`** in the task list and in Telegram.
- **Schedules with a deterministic prefilter**: 1-minute cron, zero tokens on an empty poll, the
  file body as the agent's memory, soft-stop from the windows.
- **Agents, skills, projects and schedules as Markdown with an editor, plus presets.**
- **Three-layer MCP** plus the claude.ai connectors in every `-p` session, browser-driven sign-in.
- **The owner's real checkouts on a server**, a queue that survives restarts, transcripts at home.
- **A security posture written down and enforced**: secrets out of the CLI's environment,
  read-only SSH hosts, per-owner PATs, untrusted-input rules, a sign-in with lockout.

## Prioritised ideas

Table stakes (every neighbour has them):

1. **Opt-in worktree per project** for parallel tasks on one repository (`git worktree add` under
   `data/worktrees/<task>`, the session's cwd follows; the audit's project detection copes).
2. **"Always allow" per tool / project**, shown and revocable in the UI; deny-on-timeout stays per
   schedule (`SCHEDULES_ASK_TIMEOUT_MIN`).
3. **`POST /api/tasks/fire`**: bearer token per project or schedule, body wrapped as untrusted,
   optional GitHub HMAC. Polling stays the default.
4. **"Continue in chat"** for an indexed laptop transcript.
5. **Files back to the chat** and **Merge** behind the confirm dialog.

Where to pull ahead (fits the four pillars, nobody else has it):

6. **Audit → policy**: token budgets per agent / project with a soft stop (SPEC §7), an alert when
   an agent touches a path outside its project, a daily Telegram digest (tasks, PRs, tokens,
   denials).
7. **Audit export** as JSON and ccusage-compatible 5-hour blocks: cheap and unique.
8. **More prefilters, generically**: an `http` prefilter (URL, JSON path to the array, key field)
   and an `imap` one cover mail, RSS, Sentry and ClickUp without a poller each.
9. **Project notes as memory**: one file per project the dispatcher reads at start and appends to
   (corrections, decisions, deferred items), editable in the UI, in the spirit of the schedules'
   bodies.
10. **The pipeline as a visible object**: stages (developer → reviewer → checks → PR) drawn from
    the `agent` events on the task page; a "report → act" switch on schedules.
11. **Security as a feature**: a per-agent "blast radius" view (tools, MCP servers, hosts), an
    egress allowlist in compose, a check of the CLI's native sandbox (bubblewrap) inside the
    container under `bypassPermissions`.

### Model providers yes, other runtimes no

Codex and OpenCode behind the same UI is the most common feature among the neighbours (Paseo,
takopi, c3, ductor: "plan with Claude, implement with Codex"). Another agent runtime contradicts
the premise (the unmodified Claude Code CLI) and would fork `claude/runner.ts`, the audit event
shapes and the limits accounting, so it stays out. **Model providers** are a different thing and
shipped in 1.3.0: the same CLI pointed at another endpoint (Ollama, vLLM, OpenRouter natively;
OpenAI-compatible APIs through the supervisor's translating gateway), chosen per schedule, agent
or chat, so cheap bulk work leaves the subscription windows (`docs/plans/providers.md`).

### Still to check by hand

Voice in the official Telegram channel plugin; whether Happy drives the CLI through a PTY or the
SDK; the exact licence of Paseo (the repository says "Other"; forks show AGPL-3.0 and Apache-2.0);
whether the CLI's sandbox settings work under `bypassPermissions` in a container without
privileges; Projects availability on this account.
