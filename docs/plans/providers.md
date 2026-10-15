# Plan: model providers besides the subscription

Status: shipped. **1.3.0** (2026-10-14): `data/config/providers.yaml`, the translating gateway,
light mode, per-provider concurrency, provider + model per schedule / agent / chat. **1.4.0**
(2026-10-15): a provider's own MCP servers through the gateway, its TLS CA in the form, a
per-provider gateway bearer. How it works today is in `CLAUDE.md` (Model providers); the
forker's guide to a GPU box is `docs/SELF_HOSTED_LLM.md`. Open: delegation (below), the
follow-ups, the owner's questions.

## Small models in the CLI (tests 2026-10-14, `lookatstars`: RTX 2080 Ti 11 GB, Ollama 0.40)

Task: keywords → sources → an SEO page for geometki.com, written to a file; search through
SearXNG over MCP.

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
   context every turn. GPU 84 °C average, 88 °C peak, 275 W.

## The constraint

The CLI's endpoint is the **process's** environment (`ANTHROPIC_BASE_URL` …): one `claude -p` =
one endpoint for the orchestrator and all its sub-agents, and the subscription's OAuth token is
never proxied (SPEC §8). So a provider is chosen **per task**; within one provider roles may use
different models.

## Delegation (deferred)

**Claude orchestrator + a role on another provider** needs two processes. A factory MCP tool
`delegate(agent, prompt)` queues a child task on the agent's provider and returns its report;
the parent's slot is lent to the child, `tasks.parent_id` links them, the Audit log nests them,
the dispatcher rules route roles on other providers to `delegate`. First use: a Claude
fact-check of locally written pages (the geometki pipeline: research → write → draft → link to
Telegram → the owner publishes).

## Network (owner, 2026-10-15)

No VPN and no standing tunnel to the box (a persistent link from the office network to a RU
address is a security problem in itself). The box is reached like a cloud API: HTTPS on one
port with a bearer, requests only while a task runs; TLS from Caddy's own CA (`tls internal`,
no third-party DNS, no Let's Encrypt), the CA pasted into the provider form. Work-project code
never goes to this provider; a **per-project provider allowlist** is wanted (not built).

## After the 1.4.0 merge, on mikserver

1. `git pull && docker compose up -d --build`.
2. Settings → Providers → `lookatstars` → Edit: paste `/srv/llm/caddy-root.crt` as the TLS
   certificate (fingerprint starts `C7:EA:89:7D`); MCP servers → `search`,
   `https://<box IP>:<router port>/mcp`, `LOOKATSTARS_MCP_TOKEN`.
3. Test: "tool calling ok" and "MCP search ok".
4. Drop `NODE_EXTRA_CA_CERTS` from `docker-compose.override.yml` (backup first), delete
   `data/config/certs/lookatstars-ca.crt` and `data/config/mcp.json.pending`; `docker compose up -d`.
5. A search task in a chat on `lookatstars`; then a subscription task, and the box's Caddy log
   (`docker compose logs --since 5m caddy` in `/srv/llm`) shows no request from it.

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
2. `nvidia-smi -pl 200` on `lookatstars`.
