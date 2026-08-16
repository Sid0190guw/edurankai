# docker/mailops/Dockerfile — one image for the four small Node services in the mail stack:
# the health aggregator, the inbound bridge (mail-parser), the queue worker, and the test sink.
#
# ONE IMAGE, FOUR ENTRYPOINTS. They share the SMTP server module and the signing module, they are
# all a few hundred lines of dependency-free ESM, and building four near-identical images would mean
# four things to rebuild when Node ships a security fix. Compose selects the entrypoint per service.
#
# NO npm install, AND THAT IS THE POINT. Every one of these services uses only Node built-ins: net,
# http, crypto, fs. Nothing in the mail path — the part that accepts connections from the internet —
# pulls a transitive dependency tree. That is a deliberate reduction of what has to be trusted at
# the most exposed point in the system.
#
# Build context is the repository root:  docker build -f docker/mailops/Dockerfile .

FROM node:22-bookworm-slim

WORKDIR /srv

# Only the service sources. No package.json, no node_modules, nothing to install.
COPY docker/mailops/*.mjs ./

# Tells the services to bind 0.0.0.0 rather than loopback. Outside a container they default to
# 127.0.0.1, so running the sink bare on a laptop does not open an SMTP port to the café network.
ENV IN_CONTAINER=1
ENV NODE_ENV=production

USER node

# Each service answers /health on its own port; compose sets the port and the healthcheck per
# service, because a single healthcheck here would probe the wrong port for three of the four.
CMD ["node", "health.mjs"]
