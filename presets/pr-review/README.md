# Pull request review

> "Review org/repo#123" · "Look at the PR for the nav rewrite and tell me if it's mergeable"

**Adds**

- agent `pr-reviewer` — read-only reviewer that works from the PR diff and
  the project rules; never edits, never pushes.
- skill `pr-review` — fetches the PR with `gh`, runs the reviewer, posts a
  review with inline comments (or only reports to the owner when asked for a
  dry run).

**Needs** `GH_TOKEN` with pull-request write permission on the repository.
