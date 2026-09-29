# Pull request review

> "Review org/repo#123" · "Look at the PR for the nav rewrite and tell me if it's mergeable"

**Adds**

- agent `pr-reviewer` — read-only reviewer that works from the PR diff, the surrounding code and the repository's `CLAUDE.md` / `REVIEW.md`. Two passes: candidates, then verification; only findings with a `path:line` citation survive. Severity as in Claude Code's own Code Review: 🔴 Important, 🟡 Nit (five at most), 🟣 Pre-existing. Never edits, never pushes.
- skill `pr-review` — fetches the PR with `gh`, skips drafts / closed / bot PRs, runs the reviewer, posts one review with inline comments (or only reports to the owner when asked for an opinion). On a re-review it posts only what is new or still open.

**Needs** a GitHub token with pull-request write permission on the repository. A `REVIEW.md` in the repository tunes what gets flagged and at which severity, exactly as for Claude Code's Code Review.
