#!/bin/sh
# Container entrypoint: prepare the data directory on first start, wire git/gh, then exec.
set -e

CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-/data/claude}"
DATA_ROOT="${DATA_ROOT:-/data}"

mkdir -p "$CLAUDE_CONFIG_DIR" \
    "$DATA_ROOT/config/projects" \
    "${WORKSPACES_ROOT:-$DATA_ROOT/workspaces}" \
    "$DATA_ROOT/db" \
    "$DATA_ROOT/logs" \
    "$DATA_ROOT/secrets" \
    "$DATA_ROOT/inbox" \
    "$DATA_ROOT/vault"
# The vault holds what the owner sets in the UI: nobody but the factory's user reads it.
chmod 700 "$DATA_ROOT/vault" 2>/dev/null || true

# Seed Claude Code's config dir from the templates. `cp -n` never overwrites
# the owner's edited files, so new template files (agents, skills) appear on
# upgrade while local changes are kept.
echo "[entrypoint] seeding new template files into $CLAUDE_CONFIG_DIR"
cp -Rn /app/templates/claude/. "$CLAUDE_CONFIG_DIR"/ \
    || echo "[entrypoint] warning: could not seed templates into $CLAUDE_CONFIG_DIR (is it writable by uid $(id -u)?)"

# SSH keys for project hosts live on the volume, never in the image.
if [ -d "$DATA_ROOT/secrets/ssh" ] && [ ! -e "$HOME/.ssh" ]; then
    ln -s "$DATA_ROOT/secrets/ssh" "$HOME/.ssh"
fi

# Bind-mounted repositories may be owned by a different uid than `node`.
git config --global --replace-all safe.directory '*'
git config --global user.name "${GIT_AUTHOR_NAME:-Pocket Factory}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-pocket-factory@localhost}"

# GitHub over HTTPS: one fine-grained PAT per repository owner (GH_TOKEN_<OWNER>,
# GH_TOKEN as the fallback). git asks git-credential-owner with the repository
# path, the gh wrapper on PATH picks the token from the checkout's origin.
git config --global credential.https://github.com.helper '/usr/local/bin/git-credential-owner'
git config --global credential.https://github.com.useHttpPath true
owners=$(gh-token --owners | tr '\n' ' ')
if [ -n "$GH_TOKEN" ] || [ -n "$owners" ]; then
    echo "[entrypoint] github tokens: ${GH_TOKEN:+default }${owners}"
else
    echo "[entrypoint] warning: no GH_TOKEN / GH_TOKEN_<OWNER> — git push and gh will fail"
fi

# The agents run in Docker Sandboxes: the host's sbx client must be mounted (docker-compose.yml).
if [ "${SANDBOX:-sbx}" = "sbx" ]; then
    if command -v sbx >/dev/null 2>&1; then
        echo "[entrypoint] sandboxes: $(HOME="${SBX_HOME:-$HOME}" sbx version 2>/dev/null | head -n 1 || echo 'sbx does not answer')"
    else
        echo "[entrypoint] warning: SANDBOX=sbx but no sbx client is mounted — tasks will fail until it is"
    fi
fi

exec "$@"
