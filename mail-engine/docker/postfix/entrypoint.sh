#!/bin/sh
# mail-engine/docker/postfix/entrypoint.sh — render the configuration, then hand over to Postfix.
#
# Everything variable about this container is an environment variable, and it is substituted here
# rather than by a templating tool, so the running configuration is a plain file an operator can
# read with `docker exec postfix cat /etc/postfix/main.cf` and compare against what is in git.
set -eu

MAIL_HOSTNAME="${MAIL_HOSTNAME:-mail.edurankai.in}"
MAIL_DOMAINS="${MAIL_DOMAINS:-edurankai.in}"
MAIL_MAX_MESSAGE_BYTES="${MAIL_MAX_MESSAGE_BYTES:-26214400}"
VIRTUAL_TRANSPORT="${VIRTUAL_TRANSPORT:-lmtp:inet:dovecot:24}"
MAIL_PRIMARY_DOMAIN="$(echo "$MAIL_DOMAINS" | cut -d, -f1)"
MAIL_DOMAINS_SPACED="$(echo "$MAIL_DOMAINS" | tr ',' ' ')"

echo "[postfix] hostname=$MAIL_HOSTNAME domains=$MAIL_DOMAINS transport=$VIRTUAL_TRANSPORT"

# A hostname that is not a fully qualified name makes every receiving server suspicious, and some
# refuse the connection outright. Better to fail loudly at boot than to discover it in a bounce.
case "$MAIL_HOSTNAME" in
  *.*) : ;;
  *) echo "[postfix] FATAL: MAIL_HOSTNAME must be a fully qualified domain name, got '$MAIL_HOSTNAME'" >&2; exit 1 ;;
esac

render() {
  sed -e "s|\${MAIL_HOSTNAME}|$MAIL_HOSTNAME|g" \
      -e "s|\${MAIL_PRIMARY_DOMAIN}|$MAIL_PRIMARY_DOMAIN|g" \
      -e "s|\${MAIL_DOMAINS_SPACED}|$MAIL_DOMAINS_SPACED|g" \
      -e "s|\${MAIL_MAX_MESSAGE_BYTES}|$MAIL_MAX_MESSAGE_BYTES|g" \
      -e "s|\${VIRTUAL_TRANSPORT}|$VIRTUAL_TRANSPORT|g" \
      "$1" > "$2"
}

render /etc/postfix/main.cf.template /etc/postfix/main.cf
cp /etc/postfix/master.cf.template /etc/postfix/master.cf

# ---------------------------------------------------------------------------
# Recipient maps.
#
# RECIPIENT VALIDATION IS THE POINT OF THIS SECTION. Postfix refuses mail at RCPT TIME for an
# address that is not in virtual_mailbox_maps, so a sender who mistypes an address is told
# immediately by their own mail client. The alternative — accept everything, discover later that
# nobody owns the address — means either a bounce nobody reads or, worse, silence.
#
# The seed list below is deliberately minimal: the addresses an organisation must have (RFC 2142)
# plus whatever MAIL_EXTRA_MAILBOXES adds. Per-user mailboxes are the APPLICATION's business — when
# the engine pipes to /inbound it is the application that decides whether a mailbox exists, and it
# already has resolveAddress() for exactly that. Duplicating a user list into Postfix would be a
# second source of truth that goes stale the first time somebody is onboarded.
# ---------------------------------------------------------------------------
: > /etc/postfix/virtual_mailbox
: > /etc/postfix/virtual_alias

for domain in $MAIL_DOMAINS_SPACED; do
  for local in postmaster abuse hostmaster webmaster noreply connect; do
    echo "$local@$domain  $domain/$local/" >> /etc/postfix/virtual_mailbox
  done
done

# MAIL_EXTRA_MAILBOXES="one@edurankai.in,two@edurankai.in"
if [ -n "${MAIL_EXTRA_MAILBOXES:-}" ]; then
  echo "$MAIL_EXTRA_MAILBOXES" | tr ',' '\n' | while read -r addr; do
    [ -z "$addr" ] && continue
    domain="${addr#*@}"
    local="${addr%@*}"
    echo "$addr  $domain/$local/" >> /etc/postfix/virtual_mailbox
  done
fi

# RFC 2142 requires postmaster and abuse to be reachable, and mail systems that cannot be complained
# to get blocklisted. They alias to the address in MAIL_POSTMASTER unless one is defined already.
if [ -n "${MAIL_POSTMASTER:-}" ]; then
  for domain in $MAIL_DOMAINS_SPACED; do
    echo "postmaster@$domain  ${MAIL_POSTMASTER}" >> /etc/postfix/virtual_alias
    echo "abuse@$domain  ${MAIL_POSTMASTER}" >> /etc/postfix/virtual_alias
  done
fi

# MAIL_CATCH_ALL is off by default, per the brief: "catch-all only if explicitly enabled".
if [ "${MAIL_CATCH_ALL:-false}" = "true" ]; then
  echo "[postfix] WARNING: catch-all is ON. Every address at every hosted domain will be accepted."
  for domain in $MAIL_DOMAINS_SPACED; do
    echo "@$domain  ${MAIL_CATCH_ALL_TARGET:-postmaster@$domain}" >> /etc/postfix/virtual_alias
  done
fi

postmap /etc/postfix/virtual_mailbox
postmap /etc/postfix/virtual_alias

# ---------------------------------------------------------------------------
# TLS certificate.
# ---------------------------------------------------------------------------
if [ ! -f /etc/mail/certs/fullchain.pem ] || [ ! -f /etc/mail/certs/privkey.pem ]; then
  echo "[postfix] no certificate at /etc/mail/certs — generating a SELF-SIGNED one."
  echo "[postfix] This is fine for local development and WRONG for production: other mail servers"
  echo "[postfix] will fall back to cleartext. See docs/production-migration.md for Let's Encrypt."
  mkdir -p /etc/mail/certs
  openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
    -subj "/CN=$MAIL_HOSTNAME" \
    -keyout /etc/mail/certs/privkey.pem \
    -out /etc/mail/certs/fullchain.pem 2>/dev/null
  chmod 600 /etc/mail/certs/privkey.pem
fi

# A relayhost is how this works from a laptop, where outbound 25 is blocked.
if [ -n "${RELAYHOST:-}" ]; then
  echo "[postfix] relaying all outbound mail through $RELAYHOST"
  postconf -e "relayhost = $RELAYHOST"
  if [ -n "${RELAY_USER:-}" ]; then
    echo "$RELAYHOST ${RELAY_USER}:${RELAY_PASS:-}" > /etc/postfix/sasl_passwd
    chmod 600 /etc/postfix/sasl_passwd
    postmap /etc/postfix/sasl_passwd
    postconf -e "smtp_sasl_auth_enable = yes" \
                "smtp_sasl_password_maps = hash:/etc/postfix/sasl_passwd" \
                "smtp_sasl_security_options = noanonymous" \
                "smtp_tls_security_level = encrypt"
  fi
fi

postfix check
echo "[postfix] ready"
exec /usr/sbin/postfix start-fg
