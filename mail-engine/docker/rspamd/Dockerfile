# mail-engine/docker/rspamd/Dockerfile — spam filtering as a milter.
FROM alpine:3.20

RUN apk add --no-cache rspamd rspamd-client ca-certificates \
    && mkdir -p /etc/rspamd/local.d /var/lib/rspamd /run/rspamd

COPY local.d/ /etc/rspamd/local.d/
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# 11332 = milter (Postfix connects here) · 11334 = the web interface, loopback only
EXPOSE 11332 11334

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD rspamc -h 127.0.0.1:11334 stat > /dev/null 2>&1 || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
