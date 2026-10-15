# Plan: model providers besides the subscription

Status: shipped. **1.3.0** (2026-10-14): `data/config/providers.yaml`, the translating gateway,
light mode, per-provider concurrency, provider + model per schedule / agent / chat. **1.4.0**
(2026-10-15): a provider's own MCP servers through the gateway, its TLS CA in the form, a
per-provider gateway bearer. How it works today is in `CLAUDE.md` (Model providers); the
forker's guide to a GPU box is `docs/SELF_HOSTED_LLM.md`. Delegation from a Claude orchestrator
shipped in 1.4.0 too (below). Open: the follow-ups, the owner's questions.

## Small models in the CLI (tests 2026-10-14)

Box: RTX 2080 Ti 11 GB, 14 GB RAM, Ollama 0.40 (context 65536, flash attention, KV cache q8_0).
Task: keywords → sources → an SEO page in Russian for a travel site, written to a file; search
through SearXNG over MCP.

| Model | Fits VRAM | Default CLI prompt | Short system prompt |
|---|---|---|---|
| qwen3.5:9b | yes (7 GB @ 64k) | researched well (8 pages), never wrote the file | file written; 6 pages, 1900 words, broken Russian in places, legends as facts |
| gemma4:12b | yes (9.3 GB @ 64k) | 0–3 pages, text in the reply, not the file | file written in 1:53; clean Russian, 640 words, 2 pages read |
| qwen3:14b | **no** (12 GB → 20 % on CPU, 10 min) | 4 searches, no page read | not tried |

1. **The default Claude Code system prompt (~15k tokens) breaks small models**: no run reached
   the file. A ~400-token `--system-prompt` + a short tool list made both finish first time →
   **light mode**.
2. **64k context is needed**: at 32k it overflows after 2–3 pages read.
3. **Two roles beat one**: qwen3.5 researches, gemma4 writes; a research draft edited by gemma4
   gave the best page. One provider serves several models; a skill chains roles.
4. **Facts are the weak point**: legends as facts, wrong routes → publication needs review.
5. **One task at a time per GPU** (one model in VRAM, ~5 min research + ~5 min edit) →
   `concurrency: 1`.
6. ~25 tok/s generation, 1–2k tok/s prompt processing: the cost is re-reading the growing
   context every turn. A cold first call (model load) ~2.5 min. GPU 84 °C average, 88 °C peak,
   275 W.

## The constraint

The CLI's endpoint is the **process's** environment (`ANTHROPIC_BASE_URL` …): one `claude -p` =
one endpoint for the orchestrator and all its sub-agents, and the subscription's OAuth token is
never proxied (SPEC §8). So a provider is chosen **per task**; within one provider roles may use
different models.

## Delegation (shipped in 1.4.0)

A Claude orchestrator hands a role on another provider its work through the factory's own MCP
server (`/factory/<task>/mcp`, `gateway/factory.ts`, a bearer per task): the tool
`delegate(agent, prompt, files?)` queues a child task (`tasks.parent_id`, `source: delegate`, a
hidden conversation of channel `delegate`) on the agent's provider, waits and answers with the
report, the work directory (`data/inbox/<parent chat>/delegate/<child>/`) and its files. The call
streams MCP progress every 30 s; the server's `timeout` in `--mcp-config` (3 h) lifts the CLI's
per-call and idle limits (CLI 2.1.283: `timeout` per server, idle = max(default, timeout)).

- Roles = agent files with `provider:`; their `Agent(<name>)` is denied in every subscription
  session (verified: "Agent type … has been denied by permission rule" in `-p`), and
  `--append-system-prompt` names them and the tool, which sits behind ToolSearch.
- The waiting parent lends its slot to one child at a time; a provider's `concurrency` still
  queues the box. A stopped or finished parent cancels its children. A parent resumed after a
  restart calling with the same agent + prompt joins the child already made.
- Fallback (`fallback:` inherit | alias | none): before queueing, `reachable()` asks the
  provider's models route (any status < 500 within 10 s, cached a minute; never loads a model);
  a child that fails on the box for transport reasons (the gateway's health since its start, or
  the error text) runs once more on the subscription. A project without the provider in its
  `providers:` list also falls back. The fallback run gets the role's body through
  `--append-system-prompt` with "use WebSearch / WebFetch" instead of the box's search.
- Measured 2026-10-15 (haiku orchestrator, gemma4:12b role on the box above): research + a
  180-word note in 29 s, an article in 169 s (~391k input tokens on the box), 0 subscription
  tokens for the role; the orchestrator's brief, waiting, reading and checking the file: 4 turns,
  ~124k tokens (mostly cache reads of its own system prompt). A call queued behind another GPU
  task took 12 min.

Not built: an Overview figure for tokens moved off the subscription, the delegation line in the
Telegram footer, nested children in the Audit log (the child is its own task there), parallel
calls sharing one lent slot (a second concurrent child takes a slot of its own).

## Network

No VPN and no standing tunnel to a box: it is reached like a cloud API, HTTPS on one port with a
bearer, requests only while a task runs; TLS from the box's own CA (e.g. Caddy's `tls internal`),
pasted into the provider form. A project delegates only to providers its file lists.

## Follow-ups

- `light: false` and `kind: openai` not verified against a live endpoint;
  `max_completion_tokens` for OpenAI reasoning models.
- Ollama's Messages API reports `output_tokens` 0 on assistant messages (the real count is in
  `message_delta`): provider tasks show input tokens only. Fix: the gateway counts usage per
  request with a per-task bearer and attributes it to the task.
- A schedule that inherits `provider:` from its agent shows the subscription in the form, and
  `usedBy` misses it.
- `session: continue` keeps the old backend's session after a provider change.
- `/model claude:<alias>` reply and `/status` name the factory model, not the chat's pinned alias.
- Overview Health line for providers; the context length in Test; web tests for `ModelPicker` /
  `ProvidersSection`; a chat-level agent selector.

## Open questions (owner)

1. Money for cloud providers: `$` next to tokens, or tokens only (the "no money" rule was about
   the subscription).
