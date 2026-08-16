# docker/app/Dockerfile — the Astro application, built for a container instead of for Vercel.
#
# THIS IS NOT A SECOND BUILD OF THE APP. astro.config.mjs already switches adapter on the VERCEL
# environment variable: `vercel()` when VERCEL=1, `node({ mode: 'standalone' })` otherwise. So the
# same source, the same config and the same `npm run build` produce a Vercel function bundle in CI
# and a runnable Node server here, with no build flag and no fork. That switch is the reason MODE C
# in the brief — moving off Vercel — does not require rebuilding the application.
#
# BUILD CONTEXT IS THE REPOSITORY ROOT, not this directory:
#   docker build -f docker/app/Dockerfile .
# The compose files set that for you.

# --- build stage ---------------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Copy manifests first so `npm ci` is cached and does not re-run on every source edit.
COPY package.json package-lock.json ./
# `npm ci` and not `npm install`: it installs exactly the lockfile, fails if the lockfile disagrees
# with package.json, and is the only form of install that makes this image reproducible.
RUN npm ci --no-audit --no-fund

COPY . .

# The build must not receive real credentials. Astro evaluates module top level at build time, and a
# module that reads DATABASE_URL at import gets a placeholder rather than a live pooler string — a
# build that connects to production is the exact incident this project's CLAUDE.md was written about.
ENV NODE_ENV=production
ENV DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build
RUN npm run build

# --- runtime stage -------------------------------------------------------------------------------
# A second stage so the image ships the built server and its dependencies, not the toolchain and the
# source tree. Roughly a third of the size, and nothing in it can rebuild itself in place.
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# curl is here for HEALTHCHECK. It is the one addition to a slim base — a healthcheck that shells
# out to node costs ~40ms of process start per probe, every 30 seconds, forever.
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4321

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/dist ./dist
# public/ is served by the node adapter's static middleware from dist/client, which the build
# already populated; it is copied only for anything read from disk at runtime.
COPY --from=build /app/public ./public

# Run as the `node` user that the base image already provides. Root inside a container is still root
# on a mounted volume, and this process has no reason to write anywhere.
USER node

EXPOSE 4321

# Liveness, not readiness. /api/health returns 503 when the database is unreachable, which is what
# makes it worth probing at all — see the header of src/pages/api/health.ts. `start-period` is
# generous because the first request pays the schema-bootstrap cost.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD curl -fsS http://127.0.0.1:4321/api/health || exit 1

CMD ["node", "./dist/server/entry.mjs"]
