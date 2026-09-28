# Bug tracker fixer

Turns "fix ticket #1234" into a pull request.

**Adds**

- agent `triager` — reads the ticket and the code, writes a reproduction and
  a root-cause note before anyone edits anything. Read-only.
- skill `tracker-defect-fix` — the pipeline: triage → developer → reviewer →
  checks → PR with the ticket reference → tracker comment.

**Needs**

- The core `developer` and `reviewer` agents (shipped with the factory).
- A project file with a `tracker:` section. Ticket text is fetched with the
  tracker's MCP server or CLI configured in `.mcp.json` / the project notes;
  for GitHub Issues `gh issue view` is enough.

**Usage from Telegram**

> "In GlobalNavigation fix DEV-21234"
> "Trac ticket 46812 in ServicePattern — reproduce and fix"
