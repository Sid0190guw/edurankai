# mail-engine/docker/dovecot/Dockerfile
FROM alpine:3.20

RUN apk add --no-cache dovecot dovecot-lmtpd dovecot-pigeonhole-plugin openssl ca-certificates \
    && mkdir -p /var/mail /run/dovecot /etc/mail/certs

COPY dovecot.conf /etc/dovecot/dovecot.conf
COPY default.sieve /etc/dovecot/default.sieve
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
    && sievec /etc/dovecot/default.sieve 2>/dev/null || true

# 993 = IMAPS (clients and the engine's mailbox sync) · 24 = LMTP (Postfix) · 12345 = SASL (Postfix)
EXPOSE 993 143 24 12345

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD doveadm service status > /dev/null 2>&1 || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
