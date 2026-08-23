# mail-engine/docker/dovecot/Dockerfile
FROM alpine:3.20

RUN apk add --no-cache dovecot dovecot-lmtpd dovecot-pigeonhole-plugin openssl ca-certificates \
    && mkdir -p /var/mail /run/dovecot /etc/mail/certs /etc/dovecot/host

# The mail owner is created at BUILD time, not at boot. dovecot.conf sets mail_uid = vmail, and
# anything that parses that configuration — including the sieve compiler below — needs the account to
# exist. Creating it here also means the uid is fixed in the image rather than depending on whatever
# order the entrypoint happens to run in.
RUN addgroup -g 1000 vmail && adduser -D -u 1000 -G vmail -h /var/mail vmail \
    && chown -R vmail:vmail /var/mail

COPY dovecot.conf /etc/dovecot/dovecot.conf
COPY default.sieve /etc/dovecot/default.sieve
COPY entrypoint.sh /usr/local/bin/entrypoint.sh

# COMPILE THE SIEVE SCRIPT, AND LET A BROKEN ONE FAIL THE BUILD.
#
# This was `sievec /etc/dovecot/default.sieve 2>/dev/null || true`, which did neither of the things it
# looked like it did. `-c /dev/null` matters: without it sievec loads /etc/dovecot/dovecot.conf,
# which resolves `ssl_cert = <` against a certificate that does not exist until runtime, so the
# compile ALWAYS failed — and `|| true` with stderr discarded meant the build carried on and shipped
# no .svbin at all. At runtime the LMTP process then recompiled the script for every single delivery
# and could not cache the result, because it has dropped to vmail while /etc/dovecot is root-owned:
# one permission error per delivered message, in a log nobody reads.
#
# Now a syntactically broken filing rule stops the build, which is where it should stop.
RUN chmod +x /usr/local/bin/entrypoint.sh \
    && sievec -c /dev/null /etc/dovecot/default.sieve \
    && chown vmail:vmail /etc/dovecot/default.svbin 2>/dev/null || true

# 993 = IMAPS (clients and the engine's mailbox sync) · 24 = LMTP (Postfix) · 12345 = SASL (Postfix)
EXPOSE 993 143 24 12345

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD doveadm service status > /dev/null 2>&1 || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
