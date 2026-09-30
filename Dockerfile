# syntax=docker/dockerfile:1

ARG NODE_VERSION=22
ARG CLAUDE_CODE_VERSION=2.1.283

# ---- base: node + git + gh + unmodified Claude Code CLI -------------------
FROM node:${NODE_VERSION}-bookworm-slim AS base
ARG CLAUDE_CODE_VERSION

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git gnupg openssh-client ripgrep \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Claude Code is installed exactly as published. The version is pinned so the
# supervisor's stream-json parsing is tested against a known CLI.
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
    && corepack enable

# ---- deps: install workspace dependencies ---------------------------------
FROM base AS deps
WORKDIR /app
COPY package.json yarn.lock .yarnrc.yml ./
COPY supervisor/package.json supervisor/
COPY web/package.json web/
RUN yarn install --immutable

# ---- build: compile the supervisor and bundle the web UI -----------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY supervisor/ supervisor/
COPY web/ web/
RUN yarn build

# ---- runtime --------------------------------------------------------------
FROM base AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOME=/home/node \
    CLAUDE_CONFIG_DIR=/data/claude \
    WORKSPACES_ROOT=/data/workspaces \
    DATA_ROOT=/data \
    WEB_DIST=/app/web/dist \
    PRESETS_DIR=/app/presets

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/supervisor/dist ./supervisor/dist
COPY --from=build /app/web/dist ./web/dist
COPY supervisor/package.json ./supervisor/
COPY package.json ./
COPY templates/ ./templates/
COPY presets/ ./presets/
COPY docker/entrypoint.sh docker/gh docker/gh-token docker/git-credential-owner /usr/local/bin/

RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/gh /usr/local/bin/gh-token /usr/local/bin/git-credential-owner \
    && mkdir -p /data /home/node \
    && chown -R node:node /data /home/node

# The factory's known_hosts lives with its config, not with the read-only keys:
# the UI writes it (Settings → Hosts → Test connection → Trust host key) and
# every ssh an agent runs consults the same file.
RUN printf '\nHost *\n    UserKnownHostsFile /data/config/known_hosts\n' >> /etc/ssh/ssh_config

# Never root: bind-mounted repos keep sane ownership, and Claude Code refuses
# bypassPermissions as root anyway.
USER node

EXPOSE 8080

ENTRYPOINT ["entrypoint.sh"]
CMD ["node", "supervisor/dist/index.js"]
