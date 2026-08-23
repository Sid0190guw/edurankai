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
# THE SENDER-IDENTITY MAP IS A SEPARATE FILE, AND IT HAS TO BE.
#
# main.cf pointed smtpd_sender_login_maps at virtual_mailbox, which looks reasonable — it lists every
# address we host — but the two maps answer different QUESTIONS. virtual_mailbox answers "where does
# mail for this address get written" and its value is a maildir path (`edurankai.in/noreply/`).
# smtpd_sender_login_maps answers "which SASL login owns this address", and master.cf runs
# reject_sender_login_mismatch on submission. So Postfix looked up noreply@edurankai.in, got
# `edurankai.in/noreply/`, compared it to the login `noreply@edurankai.in`, found them different, and
# answered `553 5.7.1 Sender address rejected: not owned by user`. EVERY authenticated submission on
# 587 and 465 was refused, while port 25 and the healthcheck stayed green.
#
# Here the value is the login itself, which is what Dovecot authenticates as (dovecot.conf uses
# username_format=%u, so the login IS the full address).
: > /etc/postfix/sender_login

add_mailbox() {
  # $1 = address, $2 = domain, $3 = localpart
  echo "$1  $2/$3/" >> /etc/postfix/virtual_mailbox
  echo "$1  $1" >> /etc/postfix/sender_login
}

for domain in $MAIL_DOMAINS_SPACED; do
  for local in postmaster abuse hostmaster webmaster noreply connect; do
    add_mailbox "$local@$domain" "$domain" "$local"
  done
done

# MAIL_EXTRA_MAILBOXES="one@edurankai.in,two@edurankai.in"
if [ -n "${MAIL_EXTRA_MAILBOXES:-}" ]; then
  for addr in $(echo "$MAIL_EXTRA_MAILBOXES" | tr ',' ' '); do
    [ -z "$addr" ] && continue
    add_mailbox "$addr" "${addr#*@}" "${addr%@*}"
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
postmap /etc/postfix/sender_login
postmap /etc/postfix/virtual_alias

# WHO DECIDES WHETHER A MAILBOX EXISTS DEPENDS ON WHERE THE MAIL IS GOING, and getting this wrong
# rejects every real user's mail at RCPT time.
#
# With the default lmtp:dovecot transport the mailbox list above IS the authority: an address not in
# it has nowhere to be delivered, so rejecting at RCPT is correct and tells the sender immediately.
#
# With VIRTUAL_TRANSPORT=engine the authority is the APPLICATION — it holds the user table and
# resolveAddress() answers the question. Postfix has only the six seeded addresses, so leaving strict
# validation on means mail to every actual learner and staff member is refused with "User unknown in
# virtual mailbox table" while the engine sits behind it, perfectly able to deliver. So in that mode
# Postfix accepts anything at a hosted domain and the engine's own 550 (mapped to a bounce by
# pipe-to-engine.sh) becomes the rejection instead — later in the conversation, but from the party
# that actually knows.
case "$VIRTUAL_TRANSPORT" in
  engine*)
    echo "[postfix] transport=engine: recipient existence is the application's decision, not Postfix's"
    postconf -e "virtual_mailbox_maps = static:all" "smtpd_reject_unlisted_recipient = no"
    ;;
esac

# ---------------------------------------------------------------------------
# TLS certificate.
# ---------------------------------------------------------------------------
# THIS BLOCK USED TO CRASH-LOOP THE CONTAINER ON A FRESH CHECKOUT, and the reason is worth keeping
# written down: docker-compose mounted ./docker/certs READ-ONLY, and this code writes a self-signed
# pair into it when none is present. Under `set -eu` the failed mkdir killed the entrypoint, Postfix
# never started, and `docker compose up` produced a container that restarted forever with an error
# most people would read as a TLS problem rather than a permissions one.
#
# Two changes. The compose mount is no longer read-only, so the normal path works. And an unwritable
# certificate directory is now a legitimate production posture — certificates managed outside the
# stack, mounted read-only on purpose — so instead of dying, the entrypoint falls back to a
# container-local directory and points Postfix at it.
CERT_DIR=/etc/mail/certs
if [ ! -f "$CERT_DIR/fullchain.pem" ] || [ ! -f "$CERT_DIR/privkey.pem" ]; then
  if ! mkdir -p "$CERT_DIR" 2>/dev/null || [ ! -w "$CERT_DIR" ]; then
    CERT_DIR=/var/lib/postfix-certs
    mkdir -p "$CERT_DIR"
    echo "[postfix] /etc/mail/certs holds no certificate and cannot be written to."
    echo "[postfix] Falling back to a self-signed certificate in $CERT_DIR (NOT persisted)."
    echo "[postfix] If you meant to supply your own, put fullchain.pem and privkey.pem in the"
    echo "[postfix] mounted directory — see mail-engine/docker/certs/README.md."
  else
    echo "[postfix] no certificate at $CERT_DIR — generating a SELF-SIGNED one."
  fi
  echo "[postfix] Self-signed is fine for local development and WRONG for production: other mail"
  echo "[postfix] servers fall back to cleartext. See docs/production-migration.md for Let's Encrypt."
  openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
    -subj "/CN=$MAIL_HOSTNAME" \
    -keyout "$CERT_DIR/privkey.pem" \
    -out "$CERT_DIR/fullchain.pem" 2>/dev/null
  # A bind mount from a Windows host does not carry Unix permissions; failing to tighten them must
  # not be fatal, because the alternative is a mail server that will not start on a developer laptop.
  chmod 600 "$CERT_DIR/privkey.pem" 2>/dev/null || true
fi
postconf -e "smtpd_tls_cert_file = $CERT_DIR/fullchain.pem" "smtpd_tls_key_file = $CERT_DIR/privkey.pem"

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
