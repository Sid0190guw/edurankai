# mail-engine/docker/engine/Dockerfile — the Node service: queue, retry engine, classifier, events.
#
# Built from the REPOSITORY ROOT (see docker-compose.yml: context is ../) because the engine shares
# the repository's node_modules — nodemailer, mailparser and imapflow are already dependencies of
# the application, and installing a second copy of them would let the two drift to different
# versions of the code that parses hostile input.
FROM node:22-alpine

# tini: PID 1 in a container does not reap children or forward signals by default, and a mail worker
# that does not receive SIGTERM cannot drain its queue on `docker stop`.
RUN apk add --no-cache tini ca-certificates tzdata

WORKDIR /app

# Dependencies first, so a change to the engine's source does not re-run the install.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm install --no-save tsx@4

COPY mail-engine ./mail-engine

# The spool is a VOLUME. It is the durability promise: everything else in this image can be rebuilt
# from git, and the queue cannot.
RUN mkdir -p /var/spool/mail-engine && chown -R node:node /var/spool/mail-engine /app
VOLUME ["/var/spool/mail-engine"]

# Not root. The engine parses attacker-controlled MIME; the blast radius of a parser bug should not
# include the container's filesystem.
USER node

ENV NODE_ENV=production \
    MAIL_SPOOL_DIR=/var/spool/mail-engine \
    MAIL_ENGINE_PORT=2580

EXPOSE 2580

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MAIL_ENGINE_PORT||2580)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--import", "tsx", "mail-engine/src/index.ts"]
