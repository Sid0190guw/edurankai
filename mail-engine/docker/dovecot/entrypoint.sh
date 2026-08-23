#!/bin/sh
# mail-engine/docker/dovecot/entrypoint.sh
set -eu

mkdir -p /var/mail /run/dovecot /etc/mail/certs
addgroup -g 1000 vmail 2>/dev/null || true
adduser -D -u 1000 -G vmail -h /var/mail vmail 2>/dev/null || true
chown -R vmail:vmail /var/mail

# Same failure and same repair as the Postfix entrypoint: this wrote into a directory the compose
# file mounted read-only, so under `set -eu` the container crash-looped on a fresh checkout before
# Dovecot ever started. An unwritable certificate directory is now handled rather than fatal, and
# `ssl = required` in dovecot.conf means a Dovecot with no usable certificate serves nothing at all —
# so falling back is the difference between a working stack and a silent one.
CERT_DIR=/etc/mail/certs
if [ ! -f "$CERT_DIR/fullchain.pem" ] || [ ! -f "$CERT_DIR/privkey.pem" ]; then
  if ! mkdir -p "$CERT_DIR" 2>/dev/null || [ ! -w "$CERT_DIR" ]; then
    CERT_DIR=/var/lib/dovecot-certs
    mkdir -p "$CERT_DIR"
    echo "[dovecot] /etc/mail/certs holds no certificate and cannot be written to;"
    echo "[dovecot] falling back to a self-signed certificate in $CERT_DIR (NOT persisted)."
  else
    echo "[dovecot] no certificate — generating a self-signed one (development only)"
  fi
  openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
    -subj "/CN=${MAIL_HOSTNAME:-mail.edurankai.in}" \
    -keyout "$CERT_DIR/privkey.pem" -out "$CERT_DIR/fullchain.pem" 2>/dev/null
  chmod 600 "$CERT_DIR/privkey.pem" 2>/dev/null || true
fi

# Point the shipped configuration at wherever the certificate actually ended up.
sed -i "s|^ssl_cert = <.*|ssl_cert = <$CERT_DIR/fullchain.pem|; s|^ssl_key = <.*|ssl_key = <$CERT_DIR/privkey.pem|" \
  /etc/dovecot/dovecot.conf

# The mailbox list is copied out of the read-only host mount rather than being mounted onto
# /etc/dovecot/users directly — see the long note on that volume in docker-compose.yml. Copying also
# means the file inside the container is writable and a normal file, so the `-s` test below means
# what it says instead of silently being true for a directory.
if [ -f /etc/dovecot/host/users ]; then
  cp /etc/dovecot/host/users /etc/dovecot/users
  chmod 600 /etc/dovecot/users 2>/dev/null || true
  echo "[dovecot] loaded $(grep -c ':' /etc/dovecot/users 2>/dev/null || echo 0) mailbox line(s)"
else
  : > /etc/dovecot/users
fi

# A missing user file is not an error worth refusing to start over — LMTP still needs to run so
# Postfix does not queue up mail it cannot hand over. It IS worth saying out loud, because a Dovecot
# with no users authenticates nobody while still reporting itself healthy.
if [ ! -s /etc/dovecot/users ]; then
  echo "[dovecot] WARNING: no mailboxes are defined. Nothing can authenticate — IMAP logins and"
  echo "[dovecot]          Postfix submission on 587/465 will both fail."
  echo "[dovecot]          Create one: docker compose -f mail-engine/docker-compose.yml exec dovecot doveadm pw -s ARGON2ID"
  echo "[dovecot]          then add 'address:{hash}::::' to mail-engine/docker/dovecot/users and restart."
fi

exec dovecot -F
