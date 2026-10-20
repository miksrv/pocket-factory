# UI / UX: open proposals

From the 2026-10-17 review (the owner: "the web UI is too complex"). What it found and 1.6.0 already
changed is in the CHANGELOG; below is what is still proposed, for the owner's call.

## Simplify

1. **Sessions lists the first prompt** of a routine run (the JSONL has no task row); map a session
   to its task and show "⏱ name" as Tasks and Overview do.
2. **The agent form's MCP block**: hide it behind "This agent is a role for an MCP server" unless
   the file already names one; nine agents in ten never do.
3. **Overview says too much**: keep Queued / Running / Done today / Failed today / Tokens today /
   the windows in one card; move the counts (agents, skills, projects) to the sidebar labels; fold
   Health and MCP into one "Health" card with a line per concern.
4. **Settings is a wall**: tabs (Claude Code · Security · MCP · Providers · Hosts · Sandboxes ·
   Paths) instead of one scroll, the read-only `.env` facts under one "Environment" tab.
5. **Agents grid vs. editor**: drop the editor's list pane when it was reached from the grid (a
   detour on a phone).
6. **Presets outside the file pages**: a "From a preset" entry in each file page's New menu; the
   Presets page keeps Details / Reinstall.

## Let the orchestrator help

Each is a `Button to='/chat/new?prompt=…'` plus a Chat page that reads `prompt` from the query; no
new API.

- **New routine / agent / project by description**: "Describe it" next to New opens Chat with a
  prefilled prompt; the file page reloads when the task is done.
- **Fix an invalid file**: the routine status card's "invalid: …" gets "Let the agent fix it",
  sending the error and the file path to Chat.
- **Explain a run**: a failed routine run on Tasks gets "Ask why", opening Chat on the task's
  conversation.

## Not worth doing

- A UI framework or a design-system library: the complexity is in the *amount* shown, not in how.
- Collapsing the sidebar into fewer pages: the problem pages are Overview and Settings, which are
  wide, not deep.
