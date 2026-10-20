# Providers: what is left

Shipped in 1.3.0–1.4.0 (providers, the translating gateway, light mode, a provider's MCP servers,
its CA, delegation); how it works is in `CLAUDE.md` (Model providers), the forker's guide to a GPU
box in `docs/SELF_HOSTED_LLM.md`.

## Not built

- Nested children in the Audit log (a delegated role is its own task there).
- Parallel delegate calls sharing one lent slot (a second concurrent child takes a slot of its own).

## Follow-ups

- `light: false` and `kind: openai` not verified against a live endpoint;
  `max_completion_tokens` for OpenAI reasoning models.
- Ollama's Messages API reports `output_tokens` 0 on assistant messages (the real count is in
  `message_delta`): provider tasks show input tokens only. Fix: the gateway counts usage per
  request with a per-task bearer and attributes it to the task.
- A routine that inherits `provider:` from its agent shows the subscription in the form, and
  `usedBy` misses it.
- `session: continue` keeps the old backend's session after a provider change.
- `/model claude:<alias>` reply and `/status` name the factory model, not the chat's pinned alias.
- Overview Health line for providers; the context length in Test; web tests for `ModelPicker` /
  `ProvidersSection`; a chat-level agent selector.

## Open question (owner)

Money for cloud providers: `$` next to tokens, or tokens only (the "no money" rule was about the
subscription).
