# UI / UX review (2026-10-17, for 1.6.0 and after)

The owner's brief: the web UI is too complex; the previous round removed the tracker and checks
fields from projects (prose in the notes instead). Look at the rest the same way, and let the
orchestrator inside the factory do part of the work. The review was done on a laptop build with the
owner's own data (6 projects, 10 agents, 9 skills, 2 routines) at 1280 px and at phone width.

## What already works

- One vocabulary (`ui.tsx`), one editor shell for the four file kinds, a sidebar with eleven
  entries in three groups, paper / dark themes, phone layouts that hold up (the routine form
  stacks cleanly at 500 px).
- The file editors show the same Markdown the agent reads; the preview is the default, editing is
  one double-click away; ⌘S saves; a file changed on disk by the agent is refused with Reload.

## What is complex, and what to do about it

Ordered by how much it would simplify day-to-day use. **Done in 1.6.0** marks what this release
already changed; the rest is proposed for the owner's call.

1. **Routine tasks named by their run frame.** Tasks, Sessions and Recent tasks showed
   "# Scheduled run: pf-test-agent This task was started by the factory's scheduler…" for every
   routine run, which hides what the list is for. *Done in 1.6.0*: a routine's task is listed as
   "⏱ name" (Tasks, Overview). Sessions still shows the first prompt (it reads the JSONL, which has
   no task row); a follow-up could map a session to its task and use the same title.

2. **The agent form drowns in MCP servers.** The developer agent's form lists every connector the
   account has, authorized or not: 11 usable rows and 10 "needs authentication" rows before the
   next field. *Done in 1.6.0*: servers without tools are folded under "N more need
   authentication". Proposed: hide the MCP block entirely behind "This agent is a role for an MCP
   server" unless the file already names one; nine agents in ten never do.

3. **Overview says too much.** Twelve stats in the first card (Agents / Skills / Projects /
   Workspaces / Model / Max sessions are configuration, not activity), then Providers, then
   Subscription, then two more grids. Proposed: keep Queued / Running / Done today / Failed today /
   Tokens today / the windows in one card; move the counts to the sidebar labels (they are already
   pages); fold Health and MCP into one "Health" card with a line per concern; the Providers card
   only when a provider exists (already so).

4. **Settings is a wall.** Eleven sections on one page, some of them long tables (62 signed-in
   browsers, most of them from scripts: *done in 1.6.0*, the screenshot script signs out; a
   "Sign out every other browser" button exists). Proposed: tabs (Claude Code · Security · MCP ·
   Providers · Hosts · Sandboxes · Paths) instead of a scroll, and the read-only `.env` facts
   (permission mode, caps, paths) under one "Environment" tab.
   *Done in 1.6.0*: permission mode, caps, concurrent sessions and config dir are gone from the
   Claude Code card (owner: not needed); a provider's MCP tools are one badge with a count.

5. **Projects form: half the fields are the repository's own facts.** Display name, checkout,
   repository URL, default branch and PR base are all derivable from the checkout (`git remote`,
   `git symbolic-ref`). Proposed: an "Onboard from the checkout" button that fills them (the
   `onboard-project` skill already does this for the agent; the form can call the same git reads
   through a read-only route), and the two branch fields folded under "More"
   unless they differ from the detected ones.
   *Done in 1.6.0* (owner's call, simpler than proposed): display name, default branch and PR base
   are gone from the form; the skills read the default branch from git and the base from the task
   or the notes; checkout and delegation sit under "More". Old files keep their fields.

6. **Routine form: four places to look.** Status card, Agent / Skill, Instructions, Triggers,
   now Steps, then "More". It is long but honest: every part is a thing the owner changes. Proposed:
   move Triggers above Instructions (the question "when" is read before "what", and the
   instructions are the long part), and show "More" as a single summary line until opened (already
   so when nothing is set).

7. **Agents page vs. Agents editor.** The grid (cards with mascots, runs, tokens) and the editor
   (list + form) are two pages for one thing. Fine on a desktop, a detour on a phone. Proposed:
   the grid stays the page; a tap opens the form in the same route with the grid as the back link
   (already so); drop the list pane from the editor when it was reached from the grid.

8. **Presets live outside the file pages.** The owner installs a preset, then edits the files on
   another page. Proposed: a "From a preset" entry in each file page's New menu, and keep the
   Presets page for Details / Reinstall only.

## Let the orchestrator help (the "describe it" path)

The factory's own agent reads and writes the same files the forms edit. Where a form is a long
list of fields, a sentence is often enough:

- **New routine / agent / project by description.** A "Describe it" button next to New opens
  Chat with a prefilled prompt ("Create a routine that … Use the onboard-project skill for the
  project file; save it under data/config/routines/<name>.md") and the file page reloads when the
  task is done. The `onboard-project` skill already exists for projects; routines and agents need
  a sentence in `light-system`-style frames, not a skill.
- **Fix an invalid file.** The routine status card shows "invalid: …"; a "Let the agent fix it"
  button sends the error and the file path to Chat.
- **Explain a run.** The Tasks page shows a failed routine run; "Ask why" opens Chat on the task's
  conversation with "Explain what went wrong in task <id> and what to change in the routine".

Each of these is a `Button to='/chat/new?prompt=…'` plus a Chat page that reads `prompt` from the
query (it reads a draft from local storage today, so the change is small). None of them needs a
new API.

## Not worth doing

- A UI framework or a design-system library: the tokens and `ui.tsx` already give one look; the
  complexity is in the *amount* shown, not in how.
- A CodeMirror editor for the Markdown bodies (CLAUDE.md "Next"): the textarea with Tab handling
  is enough for prose, and the agent edits these files more often than the owner.
- Collapsing the sidebar into fewer pages: eleven entries read fine; the problem pages are
  Overview and Settings, which are wide, not deep.
