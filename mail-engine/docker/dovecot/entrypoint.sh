#!/bin/sh
# mail-engine/docker/dovecot/entrypoint.sh
set -eu

mkdir -p /var/mail /run/dovecot /etc/mail/certs
addgroup -g 1000 vmail 2>/dev/null || true
adduser -D -u 1000 -G vmail -h /var/mail vmail 2>/dev/null || true
chown -R vmail:vmail /var/mail

if [ ! -f /etc/mail/certs/fullchain.pem ]; then
  echo "[dovecot] no certificate — generating a self-signed one (development only)"
  openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
    -subj "/CN=${MAIL_HOSTNAME:-mail.edurankai.in}" \
    -keyout /etc/mail/certs/privkey.pem -out /etc/mail/certs/fullchain.pem 2>/dev/null
  chmod 600 /etc/mail/certs/privkey.pem
fi

# A missing user file is not an error worth refusing to start over — LMTP still needs to run so
# Postfix does not queue up mail it cannot hand over. It IS worth saying out loud.
if [ ! -s /etc/dovecot/users ]; then
  echo "[dovecot] WARNING: /etc/dovecot/users is empty. No mailbox can be authenticated to."
  echo "[dovecot]          Create one: docker compose exec dovecot doveadm pw -s ARGON2ID"
  echo "[dovecot]          then add 'address:{hash}::::' to mail-engine/docker/dovecot/users"
  : > /etc/dovecot/users
fi

exec dovecot -F
