# Plan: Schedules become Routines

Status: **shipped in 1.5.0** (phases 1 and 2; phase 3, the `api` trigger, is still open). Owner's
decisions (2026-10-16): "Рутины" in Russian, a routine may have no trigger at all (Run now only),
no aliases or redirects for the old paths at all. Owner's call (2026-10-16): a schedule is not "a
task at 08:10" but routine work an agent does again and again, as in Claude Code's routines (a
saved agent + prompt + trigger). 1.4.1-1.4.2 already made the run *be* the agent the owner picked
(`claude --agent`, the skill in the prompt), so what is left is mostly the model and the words.

## The idea

A **routine** = who does it (an agent), what to do (the body: instructions and memory), and when
(one or more triggers). Today's parts map one to one:

| Today | Routine |
|---|---|
| `data/config/schedules/<name>.md` | `data/config/routines/<name>.md` |
| `agent:` | `agent:`, first field of the form; the run is that agent (1.4.2) |
| `skill:` | `skill:`, given in the prompt (1.4.2) |
| `cron:` + `window:` | trigger `schedule` |
| `prefilter:` (`command`, `github-prs`, `trac`) | trigger `poll`: a cron that starts a run only for new items |
| Run now | trigger `manual`, always available |
| (`POST /api/tasks/fire`, CLAUDE.md "Next") | trigger `api`: a URL with its own token, later |
| `## Notes` in the body | the routine's memory, unchanged |
| `once: true` | unchanged |
| task source `cron` | task source `routine` (old rows stay `cron`) |

What does not change: one run at a time per routine, the soft-stop for subscription runs, missed
minutes never caught up, seen items, the ask timeout, `action: report` first. Light mode on a
provider stays as it is.

## File format

```yaml
---
agent: geometki-rewriter
skill: geometki-rewriter
triggers:
  - schedule: 10 8 * * *
  - poll: 10 11 * * *
    prefilter: { kind: command, run: /data/claude/skills/geometki-publisher/scripts/places.sh next }
enabled: true
notify: telegram
model: sonnet
---

Rewrite 1 old geometki.com place and report in Russian.

## Notes
```

- Old files keep working: `cron:` alone reads as `triggers: [schedule]`, `cron:` + `prefilter:` as
  `[poll]`. The form writes the new shape only when the owner saves; nothing is rewritten on start.
- Several triggers per routine are allowed (a daily run plus a poll), still one run at a time.
- `tz:` / `window:` move under a trigger; top-level ones are still read.

## Storage and migration

- On start: `data/config/schedules/` exists and `routines/` does not → rename the directory (one
  `rename`, logged). Both exist → read both, `routines/` wins on a name clash, a warning in Health.
- The store keeps its table and column names (`schedule_runs`, `seen_items.schedule`,
  `tasks.schedule`): a rename buys nothing and risks the history. The code layer says routine.
- Conversations `schedule:<name>` keep their key (threads and history stay); new ones too, so no
  two keys for one routine.

## API and UI

- `/api/routines/*` with the same routes as `/api/schedules/*`; the old paths answer as aliases
  for one minor version (scripts, an open tab after the deploy), then go.
- Sidebar "Routines" (lucide `repeat` or `refresh-cw`, mapped once in `Icon.tsx`), page
  `/routines`; `/schedules` redirects.
- The form, top to bottom: **Agent** (required, the picker from the agents list; a routine
  without an agent falls back to the orchestrator as today), **Skill** (optional), **Instructions**
  (the body), **Triggers** (a list: "On a schedule" with the one cron field read back in words,
  "When something new appears" with the prefilter, Run now is a button, not a trigger), then the
  rest (project, hosts, model, provider, notify, mode) folded under "More".
- The live panel (`aside`) shows next run per trigger, last runs, seen items; unchanged otherwise.
- Overview / Health / Telegram `/status`: "routines" instead of "schedules"; a Telegram notice reads
  "⏱ geometki-rewriter (routine)".

## Docs

`CLAUDE.md` (the Schedules section becomes Routines), `docs/SPEC.md` §4.3, the README (no preset
ships a schedule file), `templates/claude/CLAUDE.md` (the dispatcher
rule "A task whose prompt starts with 'Scheduled run'" → "Routine run"; the frame's first line
changes with it, so keep both strings recognised for one version).

## Phases

1. **Words and files** (one PR): directory rename with migration, `/api/routines` + aliases,
   page and sidebar renamed, frame "Routine run", task source `routine`, docs. No format change.
2. **Triggers** (one PR): `triggers:` in the spec with the old fields read as before, several
   triggers per routine, the new form.
3. **Later**: trigger `api` (a per-routine token, `POST /api/routines/<name>/fire` with an optional
   payload handed over as an item), which also covers "Next" item `POST /api/tasks/fire`.

## Open questions for the owner

- The Russian word in Telegram and the UI headings: «Рутины» or «Регулярные задачи»?
- Keep "Run now" as a button only, or also allow a routine with no trigger at all (manual-only)?
- Aliases for `/api/schedules`: one minor version, or drop them at once (single owner, no
  outside scripts)?
