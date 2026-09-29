# DevOps engineer

Turns "check the staging host of Y" into a short report: what is up, what the logs say, what looks wrong. Works for any project whose file lists `hosts:`, whatever its stack.

**Adds**

- agent `devops-engineer` — looks at a project's servers over SSH and reports. Read-only by contract *and* by a hook that blocks state-changing commands (restarts, installs, `docker exec`, file writes, user and firewall changes).
- skill `devops-check` — "check the host": pick the host from the project file, run `devops-engineer`, report; a change is proposed, never made without a "yes".

**Needs**

- A project file with `hosts:` — name, `user@address`, the key file name in `data/secrets/ssh/`, the application's path on the host and notes (how the service runs, where the logs are, what needs `sudo`).
- A passphrase-free SSH key in `data/secrets/ssh/` (the container has no ssh-agent) and the host's entry in `data/secrets/ssh/known_hosts` (`ssh-keyscan <address> >> data/secrets/ssh/known_hosts`). "Test connection" in the project form runs the same `ssh -o BatchMode=yes` the agent will.

**Usage from Telegram**

> "Check the staging host of webshop: is the api container up and what is in its log?" "How much disk is left on production of billing-api?" "Why does the nginx on staging return 502 for /api?"
