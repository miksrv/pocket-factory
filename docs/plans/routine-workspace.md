# Routine workspace and secrets

Status: built on release/1.6.0 (2026-10-17), uncommitted. Not done from the plan: Rename of a folder's directory, a step's result as a live log while it runs. Owner's ask after trying the geometki routines on 1.6.0: "I cannot see what the scripts are". A step card shows `"${SKILL_DIR}/scripts/place.sh"` and a name; the script itself is two pages away in the skill form, the credentials it needs are in files on the host the UI cannot touch. Wanted: a routine is one place with everything it runs, an editor where every step's script is visible and editable, and credentials set from the UI, safely, for any script (Trac, Metrika tokens, the geometki author's login), not only for the built-in sources.

How others do it: GitHub Actions / GitLab CI (the workflow file next to its scripts in one repository, masked secrets per repository / environment, write-only in the UI, every run shows each step's log), n8n / Windmill (a script per node, edited in place with a code editor, a test run per node, credentials as named objects attached to nodes), Airflow (connections stored apart from DAGs, referenced by id). Common parts: the script lives next to the flow, the editor is a real code editor, a step can be run on its own, a run shows every step's output, secrets are write-only, scoped and masked in logs.

## 1. A routine is a directory

```
data/config/routines/geometki-rewriter/
  ROUTINE.md          frontmatter (triggers, steps, project, agent, …) + the short instruction + ## Notes
  scripts/            what the steps run: place.sh, gsc.sh, metrika.sh, …
  data/               the routine's own files: places.csv, log-ids.txt, a state file
  (anything else)     README, templates, prompts the scripts read
```

- `ROUTINE_DIR` joins the step environment; a step's command is `${ROUTINE_DIR}/scripts/gsc.sh` (the form writes it). Steps still run in the project's checkout. The agent's prompt names the directory, so the agent reads `data/` and keeps notes there if the instruction says so.
- `SKILL_DIR` stays: a skill's own tools (`publish.sh`, which the agent calls) belong to the skill, reused by several routines; what feeds one routine (statistics, its queue) belongs to the routine.
- A flat `routines/<name>.md` still reads as before; Save (or "Convert to a folder") moves it to `<name>/ROUTINE.md`. No aliases or redirects, as in 1.5.0. Delete removes the folder (confirm lists the files).
- The 409 "changed on disk" guard stays per file (the agent edits ROUTINE.md and data files during runs).

## 2. The routine page as a workspace

Two columns on a desktop, stacked on a phone:

- **Left: the pipeline** as a vertical flow of cards, top to bottom, the agent last. A script card shows its name, the **description** (the leading comment block of the script), the **secrets it uses** with set / not set, timeout, and the last run of that step (ok / failed, seconds, first lines of output). A source card shows its query and how many items it found last time. "＋ Script" asks for a name and creates `scripts/<name>.sh` from a template (shebang, `set -euo pipefail`, a comment header to fill), then opens it.
- **Right: the editor.** Clicking a card opens its script; a **Files** tab lists the whole directory (tree, add / rename / delete / upload). A code editor (CodeMirror 6: line numbers, highlighting for bash / python / js / yaml / markdown, search, Ctrl+S, unsaved-edit guard through `useLeaveGuard`). A CSV opens as a table (read-only view, raw text on a toggle); binary files are listed, not edited (download only). `ROUTINE.md` opens as the existing form (Pipeline, Instructions, Schedule, More) — the form is a view of that file.
- **Run this step** under the editor: runs the one script alone, in the same environment as in a run, and shows stdout, stderr, exit code and time. Nothing is recorded, no agent. "Preview steps" stays for the whole pipeline and now fills every card with its result.
- **Runs** keep each step's result (name, exit, ms, first 2 KB of output) in a new `schedule_runs.steps` JSON column, so a run's row expands into its steps like a CI job.
- The **Routines list** shows each routine's pipeline as a chain of small chips (Script › Script › Trac › Agent) coloured by the last run, so all pipelines are visible at once.

## 3. Secrets

A write-only store the UI manages, for every script, source, agent and MCP server.

- **Where:** `data/vault/secrets.json`, mode 0600, outside `data/config` (configs get copied, shared, backed up; the vault does not), a read-write mount. Values are never returned by the API, never logged, never in Markdown.
- **Settings → Secrets:** one row per name: set or not, when changed, **scope**, and **used by** (found by scanning routine steps and scripts, providers, MCP configs for `$NAME` / `${NAME}`). Actions: Set / Replace (a password field; the old value is not shown), Delete. Every change is logged and told in Telegram, like a sign-in.
- **Scope:** `everywhere` or a list of routines and projects. The geometki author's password reaches only the geometki routines' steps and runs; a Trac password only what uses Trac. A chat task gets only the `everywhere` ones.
- **Where values go:** the step environment, the built-in sources (Trac reads `TRAC_USER` / `TRAC_PASSWORD` from it), the agent's CLI environment for runs in scope (so MCP `${VAR}` works). A name in the store wins over `.env`; `.env` stays for the factory's own bootstrap. The factory's own secrets (`PRIVATE_ENV`: bot token, web auth, allowed ids, Groq key, provider token variables) cannot be set or read here.
- **Masking:** before a step's output, a run note or a task event is stored or sent, every in-scope secret value (6+ characters) is replaced with `••••`, as CI does.
- **Inline:** a card lists what it needs and offers "Set" right there. Built-in sources declare their names (Trac: `TRAC_URL`, `TRAC_USER`, `TRAC_PASSWORD` or `TRAC_COOKIE`), so the Trac card has Login / Password fields that write to the store. A script declares its own in its header (`# secrets: GSC_REFRESH_TOKEN GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET`); undeclared `$NAME`s that match a stored name are shown too.
- **Honest limits:** an agent with Bash in scope can print a value it was given (masking hides it from the logs, not from the agent); scope is the real protection. No encryption at rest: the key would sit next to the file, so 0600 and the vault outside `config/` are the measure. `data/secrets` (SSH keys, Gmail) stays read-only as it is.

## 4. geometki as the first user

`geometki-rewriter/` and `geometki-publisher/` folders: the statistics and queue scripts move from the skill to `scripts/`, `places.csv` and the log to `data/`; `publish.sh` / `add.sh` stay in the skills. `secrets/geometki/*.env` become secrets scoped to the two routines: `GEOMETKI_BOT_EMAIL` / `_PASSWORD`, `GEOMETKI_AUTHOR_EMAIL` / `_PASSWORD`, `GSC_REFRESH_TOKEN`, `GOOGLE_CLIENT_ID` / `_SECRET`, `YANDEX_OAUTH_TOKEN`, `WEBMASTER_USER_ID` / `_HOST_ID`. Trac: three secrets, scope `trac-defects`.

## Order

1. Routine directory + `ROUTINE_DIR` + migration on save; the Files tab with CodeMirror; script cards with description and "open".
2. Secrets store, Settings → Secrets, scope, masking, inline fields on cards, Trac's declared names.
3. Run this step, per-step results in runs, the pipeline chips on the list.

Docs with the change: SPEC §4.3 and §8 (the secrets rule changes: the UI may write, never read), CLAUDE.md Decisions (Routines, Security), DESIGN.md for the workspace layout.
