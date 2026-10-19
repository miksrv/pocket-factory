# syntax=docker/dockerfile:1

ARG NODE_VERSION=22

# ---- base: node + git + gh ----------------------------------------------------
# The control plane only: the agents run in Docker Sandboxes (one microVM per project, see
# docker-compose.yml), which bring their own Claude Code CLI, runtimes and Docker. What stays
# here reads the checkouts (git, gh for the Changes panel) and checks SSH hosts (ssh-keyscan).
FROM node:${NODE_VERSION}-bookworm-slim AS base

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git gnupg openssh-client \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/* \
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

# DATA_ROOT, WORKSPACES_ROOT and CLAUDE_CONFIG_DIR are the host's own paths under compose
# (a sandbox mounts the same paths); these defaults serve a bare `docker run`.
ENV NODE_ENV=production \
    HOME=/home/node \
    CLAUDE_CONFIG_DIR=/data/claude \
    WORKSPACES_ROOT=/data/workspaces \
    DATA_ROOT=/data \
    WEB_DIST=/app/web/dist \
    PRESETS_DIR=/app/presets \
    SANDBOX=sbx \
    SANDBOX_HELPERS_DIR=/usr/local/bin

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/supervisor/dist ./supervisor/dist
COPY --from=build /app/web/dist ./web/dist
COPY supervisor/package.json ./supervisor/
COPY package.json ./
COPY templates/ ./templates/
COPY presets/ ./presets/
# The git / gh wrappers (a token per repository owner): the supervisor uses them for the Changes
# panel, and every new sandbox gets a copy in ~/.local/bin.
COPY docker/entrypoint.sh docker/gh docker/gh-token docker/git-credential-owner /usr/local/bin/

RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/gh /usr/local/bin/gh-token /usr/local/bin/git-credential-owner \
    && mkdir -p /data /home/node \
    && chown -R node:node /data /home/node

# Never root: bind-mounted repositories keep sane ownership; uid 1000 is also the host user the
# sbx client acts for (its daemon socket and stores are that user's).
USER node

EXPOSE 8080

ENTRYPOINT ["entrypoint.sh"]
CMD ["node", "supervisor/dist/index.js"]
