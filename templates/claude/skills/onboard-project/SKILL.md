---
name: onboard-project
description: Connect a new repository to the factory by writing its project file in /data/config/projects/ — inspects the checkout, asks the owner what cannot be inferred, then writes the file. Use when the owner says "connect/add/onboard project X" or when a task names a project that has no file yet.
---

# onboard-project

## Steps

1. Find the checkout under `/data/workspaces/`. If the name is ambiguous or
   missing, list the candidates and ask.
2. Inspect it: README, package manifests, CI config, existing branches, PR
   templates, `CLAUDE.md`. Derive stack, default branch, lint/test/build
   commands, branch naming in use.
3. Ask the owner, in one message, only what you could not infer: PR target
   branch if unclear, tracker and workflow, hosts the project runs on, any
   rule they want enforced.
4. Write `/data/config/projects/<slug>.md` in the format below. Keep the
   free-form notes short and concrete.
5. Show the owner the file and confirm.

## Project file format

```markdown
---
name: Astronomy Portal
slug: astronomy-portal
path: /data/workspaces/astronomy-portal
repo: https://github.com/owner/astronomy-portal
default_branch: main
pr_base: main
branch_prefix: feature/
skill: feature-to-pr
tracker:
  type: github        # github | clickup | trac | jira | none
  url: https://github.com/owner/astronomy-portal/issues
  review_state: Review
hosts:
  - name: production
    ssh: deploy@203.0.113.10
    path: /srv/astronomy-portal
    notes: docker compose; restart with `docker compose up -d`
checks:
  - yarn lint
  - yarn typecheck
  - yarn test
---

Free-form notes for the agent: conventions, gotchas, what never to touch,
how deploys work, where the docs are.
```

`path` defaults to `/data/workspaces/<slug>`. `hosts` are reachable with the
SSH keys the owner placed in `/data/secrets/ssh/` (see README); never copy
keys anywhere.
