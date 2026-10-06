# Landscape: what else drives Claude Code from a phone (2026-10)

A survey of projects that overlap with Pocket Factory, made to decide what to borrow and what to
leave alone. Facts come from each project's README / docs as of 6 October 2026 (the first pass was
late September 2026); star counts are from GitHub on that day. Items marked *unverified* were seen
only in search results or secondary descriptions.

**What changed since September.** Anthropic now covers the "laptop lid" story itself on Pro / Max:
background sessions under a supervisor daemon (Agent View), new sessions started from the phone
(Dispatch), a conversation that fans out into parallel threads (Projects), cloud automation with
cron / API / GitHub triggers (Routines) and local scheduled tasks in the Desktop app. The
open-source field moved towards **multi-provider** control planes (Claude Code, Codex, OpenCode
behind one UI), **a worktree per task**, and **personal agents with memory** (OpenClaw, Hermes).
Pocket Factory's margin is narrower than a month ago and lies in four things: work in the owner's
real checkouts with their MCP servers on the owner's own server, an audit log per tool call,
deterministic prefilters that make an empty poll free, and roles / skills / projects as files with
an editor.

## Anthropic's own offerings

| | What it is | Overlap with Pocket Factory |
|---|---|---|
| **Remote Control** (`claude remote-control`, `/rc`) | A live `claude` process on your machine driven from claude.ai/code or the Claude app. Server mode: `--spawn worktree`, `--capacity` (default 32), resume within ~4 h, push notifications ("when actions required"), Trusted Devices. Pro / Max / Team / Enterprise; not with `ANTHROPIC_BASE_URL`. | Permission prompts, `AskUserQuestion`, photos, push from the phone. Known pains (issues #36807, #29219, #32202): the OAuth token expires after a couple of days and `/login` needs a browser on the host, ~10 min without network ends the session, one remote session per interactive process, transcripts stored at Anthropic. No queue, no per-tool audit. |
| **Agent View** (`claude agents`, May 2026, research preview) | A terminal dashboard over background sessions hosted by a **supervisor daemon** (one per `CLAUDE_CONFIG_DIR`): sessions survive closing the terminal and laptop sleep, each dispatched session moves into its own worktree, questions are answered from a peek panel, idle processes stop after ~1 h and resume on reply. | The closest thing to Pocket Factory's queue from Anthropic. But local only ("sessions run on your machine"), no remote access, a shutdown marks sessions failed, no per-tool audit, no Telegram. |
| **Dispatch** (mobile app → Desktop) | Describe a task on the phone; the Desktop app spawns a Code or Cowork session for it, push on completion / input. "Remote Control = continue, Dispatch = create." | Needs the Desktop app awake. No queue, no schedules. |
| **Projects** (claude.ai/code, public beta on Pro / Max, rolling out) | One ongoing conversation; Claude starts a **thread** per task, usually a cloud session, on request a local one through Remote Control; shows which threads need you; a Routines tab. Cloud threads keep going when the laptop closes, local threads only while the machine is awake. | The same conversation → tasks model. Cloud threads are fresh clones without local MCP; local threads need the live machine. Not on Team / Enterprise yet. |
| **Routines** (April 2026, research preview, Pro / Max / Team / Enterprise) | A saved prompt + repositories + connectors, run in Anthropic's cloud (self-hosted runners only on Team / Enterprise). Triggers: schedule (presets, custom cron via `/schedule update`, **minimum one hour**), `POST …/fire` with a per-routine bearer token and the payload wrapped as untrusted `<routine-fire-payload>`, GitHub PR / release events with field filters. Hourly caps on firings; every run draws subscription usage. | Phase 5's shape, in the cloud. Fresh clone per run, no local MCP servers, no memory between runs beyond the repository, a run costs tokens even when there is nothing to do. The `/fire` design (bearer + untrusted wrapper) is worth copying. |
| **Desktop scheduled tasks** (Claude Desktop ≥ 1.1.5368) | Local routines: minimum one minute, a permission mode and **"always allow" per task** with a revoke panel, optional worktree per run, one catch-up run after sleep, a `SKILL.md` per task under `~/.claude/scheduled-tasks/`, the task may reschedule itself through an MCP tool. | Runs only while the app is open and the machine awake. The per-task always-allow panel is the model for SPEC open question 10. |
| **Channels** (March 2026, research preview; Telegram, Discord, iMessage, fakechat) | An MCP server pushes messages into an *already running* session; pairing code + allowlist; a channel may declare **permission relay**; a webhook-receiver channel can be built. Needs Bun. | Messages arrive only while a session runs; in `-p` mode questions and plan approval are disabled; no history, no queue. Voice: *unverified*. |
| **Self-hosted environments** (public beta, Team / Enterprise only) | Runners in your network execute cloud sessions and routines; transcripts still go to Anthropic. | Not available on Pro / Max. |
| **`/loop`, `CronCreate`** | In-session scheduling, restored on `--resume`. | Tied to one live session. |

## Open-source bridges, clients and orchestrators

| Project | ★ | What it does | Relevant to Pocket Factory |
|---|---|---|---|
| **Happy** (slopus/happy, MIT) | 24k | Mobile / web client for Claude Code and Codex, E2E-encrypted relay, realtime voice, push on permission requests | Interactive CLI wrapper; no queue, schedules or audit. |
| **Paseo** (getpaseo/paseo, source-available) | 19.7k | A daemon that runs Claude Code, Codex, Copilot, OpenCode, Pi and more; iOS / Android / desktop / web / CLI clients; worktrees, voice, scheduling, multi-agent fan-out, a TypeScript SDK, plugins (themes, panels, providers), Docker image, E2E relay or Tailscale; skills `paseo-handoff` / `paseo-advisor` / `paseo-committee` (plan with Claude, implement with Codex) | The most complete self-hosted control plane. No Telegram, no per-tool audit, no subscription windows, no role / skill management. |
| **claudecodeui / CloudCLI** (siteboon, AGPL) | 14k | Web + mobile UI over `~/.claude`: file explorer, git panel, terminal, MCP and permissions in the UI, image input, usage dashboard, Docker sandbox, paid cloud tier; also OpenCode, Cursor CLI, Codex | Session UI, not a session manager. |
| **claude-code-telegram** (overwirehq, ex RichardAtCT) | 2.8k | Telegram → Agent SDK or CLI; photos, voice, file uploads, per-user cost caps, GitHub webhook (HMAC), cron, multi-user | The reference Telegram bridge. No web UI, no audit, no windows. |
| **takopi** (banteg, MIT) | 1k | Telegram bridge for Codex, Claude Code, OpenCode, Pi: forum topics bound to repo / branch, a worktree per branch, progress streaming, per-session queue, files to the repo and back, "stateless resume" (copy a resume line into the terminal), plugins for engines / transports | Topics = repo / branch and files both ways are the ideas to take. |
| **ductor** (PleasePrompto, MIT) | 457 | Claude Code / Codex / Gemini CLI from Telegram: live streaming, persistent memory, cron jobs, webhooks, Docker sandboxing | Feature list overlaps most with Phase 5 + memory. |
| **flock** (duckbugio, MIT) | 502 | "Autonomous AI dev-team bot" | *unverified* |
| **c3** (andrometiq, Go, MIT) | 2 | One bot, a topic per project, adapters for seven CLIs, Allow / Deny buttons, a durable offline queue, voice in / TTS out | Sits inside an interactive session. |
| **ccgram** (jsayubi, MIT) | 27 | Notifications, permission approvals and keystroke injection over Telegram | Notify-and-reply. |
| **telegramcode**, **tg-claude-bot**, **mas-aleksey/claude-bot**, **Claude-Code-Remote** | — | September entries: tmux scraping or stream-json, resume any laptop session from an inline picker, auto-continue after a usage-limit reset, Docker-in-Docker per project | Auto-continue and "resume a laptop session" remain the two ideas to take. |
| **Discord**: claudecode-discord, claude-code-discord, claudecord | — | Multi-machine hub with approval buttons and a usage dashboard; thread = session; bring-your-own subscription | — |
| **Vibe Kanban** (Apache-2.0, main project sunsetting; `vibe-kanban-indie` fork) | 28k | Kanban → worktree → agent → diff review with inline comments → PR | The diff-and-PR review screen. |
| **Paperclip** (MIT, Postgres) | 93k | Agents as employees with token / dollar budgets, approval gates, cron routines, an immutable activity log | Company scale; the budget + activity-log pairing is the one to learn from. |
| **claude-code-runner**, **CLITrigger**, **claude-orchestrator**, **Sillage**, **OpenClawdex** | small | Self-hosted runners / dashboards: HTTP → `claude -p`; parallel worktrees; full-text search over sessions | Confirms the "agent behind an HTTP API" pattern; none has Telegram + audit + schedules together. |
| **ccusage** (MIT) | 19k | 5-hour blocks and daily / weekly reports from JSONL transcripts | Export target for the audit log. |
| **agents-observe**, OTel export (`CLAUDE_CODE_ENABLE_TELEMETRY=1`, enhanced tracing beta) | — | Hook-based live dashboards; aggregated metrics to a collector | Observability of one machine's sessions; Pocket Factory's audit is per task / agent / project from stream-json and needs no hooks. |
| **BAND** (band.ai, SaaS) | — | Chat rooms where agents and people @mention each other, approvals, audit trail; Band Desktop binds local Claude Code / Codex sessions to rooms | Same ideas (approvals in chat, audit), SaaS backplane, no self-hosting. |
| **OpenCode `serve`** | — | The agent as an HTTP server with OpenAPI, SSE, `prompt_async`, endpoints to answer permissions | The cleanest "agent behind an API" reference. |
| Proprietary clouds (Cursor background agents, Codex cloud, Jules, Devin) | — | Sandbox VMs | None self-hosted on an individual subscription. |

## Personal agents: OpenClaw and Hermes

Not Claude Code drivers, but they set what people now expect from "an agent on my own box":

- **OpenClaw** (ex Clawdbot / Moltbot, MIT, 391k★): a persistent daemon on 12+ messaging platforms,
  a heartbeat scheduler, memory and skills as Markdown / YAML, a web control UI, 50+ integrations.
  2026 brought a run of incidents: prompt injection through an inbox summary that shipped a private
  SSH key to an attacker, memory poisoning across days, malicious skills on its hub, exposed default
  ports, and a heartbeat that burnt tokens checking the time. The lessons are already Pocket
  Factory's rules (untrusted input, minimal tool sets, read-only hosts, secrets out of the CLI's
  environment, zero-token polls); what is missing is making them *visible* as a feature.
- **Hermes Agent** (Nous Research, MIT, 252k★): "the agent that grows with you": writes its own
  skills from experience, keeps memory across sessions, searches its past conversations, runs
  scheduled tasks, talks from Telegram / Discord / Slack / WhatsApp / Signal / email, any model
  provider, a $5 VPS. Memory between conversations is the one idea to take; the self-written
  skills are already how a factory agent edits its own files.

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
| Several providers (Codex, OpenCode) | no | no | no | no | no | no | yes | yes | yes |
| Worktree per task | no | yes | yes | yes | n/a | no | yes | no | some |
| Photos / files in | yes (since 1.1.0) | yes | n/a | yes | n/a | yes | yes | yes | yes |
| Diff panel + Create PR | yes (since 1.1.0) | app | no | yes | yes | no | yes | git panel | no |

## What most of them have and Pocket Factory does not

1. ~~**Images and files as input**~~ (done in 1.1.0); files back to the chat, as takopi does,
   are still open.
2. **A worktree per task** as an opt-in per project. "One task per conversation in the real
   checkout" is a deliberate choice, but it serialises a repository; Agent View, Remote Control,
   Paseo and takopi all isolate by default.
3. ~~**A diff panel with "Create PR"** on the task page~~ (done in 1.1.0); "Merge" from the UI
   is still open.
4. ~~**Auto-continue after a window reset**~~ (done in 1.1.0).
5. **"Always allow" rules per tool / project** (SPEC open question 10); Desktop scheduled tasks
   show the UI: a per-task panel with revoke.
6. **An HTTP trigger** (`POST /api/tasks/fire`, bearer token, payload wrapped as untrusted, the
   Routines design) so CI, Sentry and GitHub Actions can start a task without polling.
7. **Resuming a laptop session** from the chat (`sessions/transcripts.ts` already indexes them).
8. **Memory across conversations** beyond `CLAUDE.md` and the project files (Hermes, ductor,
   OpenClaw).
9. **Several providers.** Deliberately not: see below.

## What Pocket Factory has that almost nobody does

- **The audit log per model call, tool call and sub-agent** with `parent_tool_use_id`, project
  detection and Edit-as-diff, built live from stream-json. Only Paperclip (action level) and hook /
  OTel dashboards come close; no Telegram or mobile bridge does this.
- **Subscription windows from `rate_limit_event`** in the task list and in Telegram, instead of
  transcript arithmetic (ccusage) or the app's usage page.
- **Schedules with a deterministic prefilter**: 1-minute cron, `command` / `github-prs` / `trac`
  pollers, zero tokens on an empty poll, the file body as the agent's memory between runs, soft-stop
  from the windows. Routines start at one hour, in the cloud, and pay for every run.
- **Agents, skills, projects and schedules as Markdown with a UI editor, plus presets.**
- **Three-layer MCP** (repository `.mcp.json`, owner `mcp.json`, role-owned servers), the claude.ai
  connectors in every `-p` session through a container-side login, browser-driven MCP sign-in.
- **Work in the owner's real checkouts on a server**, with a queue that survives restarts, the
  transcript on the server, and no dependency on `api.anthropic.com` being reachable directly.
- **A security posture written down and enforced**: supervisor secrets stripped from the CLI's
  environment, read-only SSH hosts with keys the API never reads, fine-grained PATs per owner,
  untrusted-input rules, a sign-in with lockout and Telegram notices.

## Prioritised ideas

Done since the September pass: ~~approvals and `AskUserQuestion` from Telegram and the web~~
(2026-09-30, over stream-json on stdin), ~~Phase 5 schedules with cron and prefilters~~
(2026-09-30 / 10-01), ~~Telegram topics by reply~~, ~~unread / waiting badges and desktop
notifications~~, ~~web sign-in~~; in 1.1.0 ~~photos and files in~~ and ~~auto-continue after a
window reset~~ and ~~the Changes panel with Create PR~~.

Table stakes first (every neighbour has them):

1. ~~**Photos and files in**~~ (1.1.0: `data/inbox/<conversation>/`, the path after the prompt,
   `--add-dir`); files back to the chat on request remain.
2. **Opt-in worktree per project** for parallel tasks on one repository (`git worktree add` under
   `data/worktrees/<task>`, the session's cwd follows; the audit's project detection already copes).
3. ~~**Diff panel and "Create PR"**~~ (1.1.0: summary first, files by folder, one diff at a time,
   `gh pr create --fill`); Merge behind the confirm dialog later.
4. ~~**Auto-continue after a window reset**~~ (1.1.0, `CLAUDE_AUTO_CONTINUE_HOURS`).
5. **"Always allow" per tool / project**, shown and revocable in the UI; deny-on-timeout stays per
   schedule (`SCHEDULES_ASK_TIMEOUT_MIN`).
6. **`POST /api/tasks/fire`**: bearer token per project or schedule, body wrapped as untrusted,
   optional GitHub HMAC. Polling stays the default; the endpoint is for the owner who wants it.
7. **"Continue in chat"** for an indexed laptop transcript.

Where to pull ahead (fits the four pillars, nobody else has it):

8. **Audit → policy**: token budgets per agent / project with a soft stop (SPEC §7), an alert when
   an agent touches a path outside its project, a daily Telegram digest (tasks, PRs, tokens,
   denials), export as JSON and ccusage-compatible 5-hour blocks.
9. **More prefilters, generically**: an `http` prefilter (URL, JSON path to the array, key field)
   and an `imap` one cover mail, RSS, Sentry and ClickUp without a poller each.
10. **Project notes as memory**: one file per project the dispatcher reads at start and appends to
    (owner corrections, decisions, deferred items), viewable and editable in the UI. Files, not a
    database, in the spirit of the schedules' bodies.
11. **The pipeline as a visible object**: stages (developer → reviewer → checks → PR) drawn from the
    `agent` events on the task page; a "report → act" switch on schedules.
12. **Security as a feature**: a per-agent "blast radius" view (tools, MCP servers, hosts), an
    egress allowlist in compose modelled on cloud environments' "Trusted" network, and a check of
    the CLI's native sandbox (bubblewrap) inside the container under `bypassPermissions`.
13. **Audit export** (JSON / ccusage blocks): cheap and unique.
14. **README positioning** against Remote Control, Agent View, Projects and Routines (done
    2026-10-06).

### Not now: several providers

Codex and OpenCode behind the same UI is the most common feature among the neighbours and the
direction Paseo, takopi, c3 and ductor share ("plan with Claude, implement with Codex"). It
contradicts the premise (the unmodified Claude Code CLI, the owner's subscription windows as the
only budget) and would fork `claude/runner.ts`, the audit event shapes and the limits accounting.
Keep the runner interface clean so a `codex exec --json` runner could be added later; do not spend
v1.x on it.

### Still to check by hand

Voice in the official Telegram channel plugin; whether Happy drives the CLI through a PTY or the
SDK; the exact licence of Paseo (the repository says "Other"; forks show AGPL-3.0 and Apache-2.0);
whether the CLI's sandbox settings work under `bypassPermissions` in a container without
privileges; Projects availability on this account.
