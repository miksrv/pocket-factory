---
name: feature-to-pr
description: Turn a task in a known project into a reviewed pull request — branch, developer sub-agent, reviewer sub-agent, fix loop, project checks, gh pr create, report. The default workflow for any "change something in project X" task.
---

# feature-to-pr

Use this when the project is known (a file in `/data/config/projects/`
matches) and the task is a change to its code.

## Steps

1. **Project.** Read `/data/config/projects/<project>.md`. Note `path`,
   `default_branch`, `branch_prefix`, `checks`, `pr_base` and the free-form
   notes. `cd` into `path`.
2. **Sync.** `git fetch origin` and make sure `default_branch` is up to date
   locally. Never work on `default_branch` itself.
3. **Branch.** `<branch_prefix><short-kebab-summary>`; include the ticket id
   when the task has one (e.g. `feature/DEV-1234-seo-slugs`). If the branch
   already exists, continue on it.
4. **Plan.** In two to five lines, decide what will change and where. If the
   task is ambiguous in a way that changes the outcome, stop here and ask the
   owner all questions in one message. Otherwise proceed.
5. **Build.** Spawn the `developer` sub-agent with: the project file path, the
   task text, the plan, the branch name. It commits on the branch.
6. **Review.** Spawn the `reviewer` sub-agent with the same context. It answers
   `APPROVE` or `REQUEST CHANGES` with findings.
7. **Fix loop.** On `REQUEST CHANGES`, hand the findings to `developer` and
   review again. At most three rounds; after that, report the open findings
   to the owner instead of looping.
8. **Checks.** Run every command in `checks` yourself once more on the final
   state. Failing checks mean the task is not done.
9. **Push & PR.** `git push -u origin <branch>` then
   `gh pr create --base <pr_base or default_branch> --title … --body …`.
   The body: what and why, how it was verified, anything for the human
   reviewer to look at. Never merge.
10. **Tracker.** If the project file names a tracker and the task has a ticket
    id, add a comment with the PR link and move the ticket to its review
    state as described in the project file.
11. **Report** to the owner: PR link, three-line summary, open questions.

## Rules

- One task, one branch, one PR.
- The reviewer sees the code, not the developer's story.
- Anything irreversible (merge, delete, force-push, deploy) needs an explicit
  "yes" from the owner first.
