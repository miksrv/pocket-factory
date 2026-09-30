---
name: devops-check
description: Look at a project's server over SSH and report — is the service up, what is in the logs, disk and memory, a config value. Read-only through the devops-engineer agent; any change is proposed to the owner and made only after an explicit "yes". Use when the task says check / inspect / diagnose a host, staging, production, a deployment or a service.
---

# devops-check

## Steps

1. **Project and host.** Read `/data/config/projects/<project>.md`. Pick the host from `hosts:` that the task names (or the only one). An entry `host: <name>` refers to `/data/config/hosts.yaml`: take the connection (ssh target, key) from there; the `path` and `notes` are the project's own, in its entry. If the project has no hosts, tell the owner and stop.
2. **Inspect.** Spawn `devops-engineer` with the project file path, the resolved host (ssh, key, the project's path and notes) and the question. It connects with the keys in `~/.ssh` and reports.
3. **Report** to the owner: state, evidence (the log lines or numbers that matter), a suggested next step. Short; the owner reads it on a phone.
4. **Change only on "yes".** If the fix is a change on the host (restart a service, roll back, edit a config, free disk space), propose the exact commands and wait. After an explicit "yes", run them yourself over the same SSH target, one at a time, and show what each returned. Never destructive shortcuts (`rm -rf`, wiping volumes, dropping databases) even with a "yes" — those the owner does by hand.

## Rules

- Nothing on a host changes without the owner's explicit "yes" in this conversation.
- Secrets seen in config files are reported as present, never quoted.
- GitHub stays on the PAT; hosts are reached with the SSH keys only.
