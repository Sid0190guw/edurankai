#!/bin/sh
# mail-engine/docker/postfix/pipe-to-engine.sh — hand one message to the mail engine over HTTP.
#
# Used by the `engine` transport in master.cf, for deployments that send inbound mail straight to
# the application instead of storing it in Dovecot.
#
# THE EXIT CODE IS THE ENTIRE POINT OF THIS FILE. Postfix reads it and decides what to tell the
# sending server, and the three answers are not interchangeable:
#
#   0   delivered      the sender is released; if this is wrong the message is GONE
#   75  EX_TEMPFAIL    Postfix keeps the message and retries; the sender hears 4xx
#   77  EX_NOPERM      permanent failure; Postfix bounces it back to the sender
#
# A naive `curl -X POST ... < message` exits 0 whenever the HTTP request itself completed, including
# when the engine answered 500. That would tell Postfix a message was delivered which the engine
# refused, and the message would be deleted. So the HTTP status is read explicitly and mapped.

set -eu

SENDER="${1:-}"
RECIPIENT="${2:-}"
ENGINE_URL="${MAIL_ENGINE_URL:-http://engine:2580}"
SECRET="${MAIL_APP_SHARED_SECRET:-}"

BODY_FILE="$(mktemp)"
trap 'rm -f "$BODY_FILE" "$BODY_FILE.hdr"' EXIT
cat > "$BODY_FILE"

# The engine API is HMAC-signed. Without a secret it is loopback-only and unauthenticated, which is
# the local-development shape; inside the compose network it is signed.
AUTH_HEADERS=""
if [ -n "$SECRET" ]; then
  TS="$(date +%s000)"
  SIG="$(printf '%s.' "$TS" | cat - "$BODY_FILE" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.*= //')"
  AUTH_HEADERS="-H x-mail-engine-timestamp:$TS -H x-mail-engine-signature:$SIG"
fi

# shellcheck disable=SC2086
STATUS="$(curl -sS -o "$BODY_FILE.hdr" -w '%{http_code}' \
  --max-time 120 \
  -X POST "$ENGINE_URL/inbound" \
  -H 'content-type: message/rfc822' \
  -H "x-mail-to: $RECIPIENT" \
  -H "x-mail-from: $SENDER" \
  $AUTH_HEADERS \
  --data-binary "@$BODY_FILE" 2>/dev/null || echo 000)"

case "$STATUS" in
  2*)
    exit 0
    ;;
  550|551|552|553|554)
    echo "engine refused the message permanently: $(head -c 400 "$BODY_FILE.hdr")" >&2
    exit 77
    ;;
  000)
    # curl could not reach the engine at all. Temporary by definition — the message stays in
    # Postfix's queue, which is exactly where it should be while the engine restarts.
    echo "engine unreachable at $ENGINE_URL" >&2
    exit 75
    ;;
  *)
    echo "engine answered $STATUS: $(head -c 400 "$BODY_FILE.hdr")" >&2
    exit 75
    ;;
esac
