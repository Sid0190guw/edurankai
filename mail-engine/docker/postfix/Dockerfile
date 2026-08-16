# mail-engine/docker/postfix/Dockerfile
#
# Alpine's postfix package, configured by entrypoint.sh at boot. Pinned to a major Alpine release
# rather than :latest — a mail server that changes underneath you on a rebuild is a mail server you
# cannot debug.
FROM alpine:3.20

RUN apk add --no-cache postfix postfix-pcre ca-certificates openssl rsyslog curl bash tzdata \
    && mkdir -p /etc/mail/certs /var/spool/postfix

COPY main.cf /etc/postfix/main.cf.template
COPY master.cf /etc/postfix/master.cf.template
COPY header_checks /etc/postfix/header_checks
COPY pipe-to-engine.sh /usr/local/bin/pipe-to-engine.sh
COPY entrypoint.sh /usr/local/bin/entrypoint.sh

RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/pipe-to-engine.sh

# 25 = MX (other mail servers) · 587 = submission (our clients) · 465 = implicit-TLS submission
EXPOSE 25 587 465

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD postfix status || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
