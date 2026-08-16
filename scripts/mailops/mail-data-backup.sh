#!/usr/bin/env bash
# scripts/mailops/mail-data-backup.sh - the things that are NOT in Postgres.
#
# The database dump covers messages, contacts, campaigns, templates and domains. It does not cover
# four things that live only on the mail host, and losing that disk loses all four:
#
#   1. DKIM private keys      - unrecoverable; replacing them costs a DNS change and days of
#                               deliverability. Also the one asset where the BACKUP is itself a risk.
#   2. Maildirs               - the IMAP copy of delivered mail.
#   3. MTA / IMAP / spam config - reconstructible, slowly, from memory and grief.
#   4. The spool's failed/    - dead-lettered mail, which is evidence a human still has to look at.
#
# KEYS ARE PACKAGED SEPARATELY, DELIBERATELY. An operator restoring maildirs should not be handed
# the ability to sign mail as this domain in the same archive. Two artefacts, two recipients if you
# want them, and the key archive is the one that goes into escrow rather than into the nightly set.
#
#   ./scripts/mailops/mail-data-backup.sh --out /backups --recipient age1... \
#       --maildir /var/mail --keys /etc/opendkim/keys --config /etc/postfix --spool /var/spool/era
#
set -euo pipefail

OUT_DIR=""; RECIPIENT=""; GPG_RECIPIENT=""; REPORT_TO=""; OFFSITE="false"
MAILDIR=""; KEYS=""; CONFIG=""; SPOOL="${MAIL_SPOOL_DIR:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT_DIR="$2"; shift 2 ;;
    --recipient) RECIPIENT="$2"; shift 2 ;;
    --gpg-recipient) GPG_RECIPIENT="$2"; shift 2 ;;
    --report-to) REPORT_TO="$2"; shift 2 ;;
    --maildir) MAILDIR="$2"; shift 2 ;;
    --keys) KEYS="$2"; shift 2 ;;
    --config) CONFIG="$2"; shift 2 ;;
    --spool) SPOOL="$2"; shift 2 ;;
    --offsite) OFFSITE="true"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$OUT_DIR" ] || { echo "--out <dir> is required" >&2; exit 2; }

if   [ -n "$RECIPIENT" ]     && command -v age >/dev/null; then ENC="age -r $RECIPIENT"
elif [ -n "$GPG_RECIPIENT" ] && command -v gpg >/dev/null; then ENC="gpg --batch --yes --encrypt --recipient $GPG_RECIPIENT"
else
  echo "No usable encryption. Pass --recipient <age-key> or --gpg-recipient <id>." >&2
  echo "This refuses to write plaintext: one of these archives contains the DKIM private keys." >&2
  exit 2
fi

mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

report() {   # id assetClass file ok error
  local size=0 sum=""
  [ -f "$3" ] && size=$(wc -c < "$3" | tr -d ' ')
  if command -v sha256sum >/dev/null && [ -f "$3" ]; then sum="$(sha256sum "$3" | cut -d' ' -f1)"; fi
  [ -n "$sum" ] && echo "$sum  $(basename "$3")" > "$3.sha256"
  echo "  $3  ${size} bytes"
  [ -n "$REPORT_TO" ] || return 0
  [ -n "${CRON_SECRET:-}" ] || { echo "  (CRON_SECRET unset - not filed)" >&2; return 0; }
  curl -sS -X POST "$REPORT_TO/api/mailops/report" \
    -H "Authorization: Bearer $CRON_SECRET" -H 'Content-Type: application/json' \
    -d "{\"kind\":\"backup\",\"id\":\"$1\",\"assetClass\":\"$2\",\"takenAt\":\"$STARTED_AT\",\"finishedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"ok\":$4,\"sizeBytes\":$size,\"location\":\"$3\",\"encrypted\":true,\"offsite\":$OFFSITE,\"checksum\":\"$sum\",\"error\":\"$5\",\"reportedBy\":\"mail-data-backup.sh\"}" \
    >/dev/null || echo "  (could not file to the ledger)" >&2
}

archive() {  # sourceDir outFile
  # -C so the archive holds relative paths: an archive of /var/mail that only unpacks to /var/mail
  # is one you cannot examine on a scratch host without root.
  tar -C "$(dirname "$1")" -cf - "$(basename "$1")" | $ENC > "$2"
}

if [ -n "$KEYS" ] && [ -d "$KEYS" ]; then
  echo "DKIM keys:"
  F="$OUT_DIR/dkim-keys-$STAMP.tar.enc"
  archive "$KEYS" "$F"
  report "dkim-$STAMP" "dkim_keys" "$F" true ""
  echo "  This artefact goes to ESCROW, not into the nightly rotation, and not to the same place as"
  echo "  the database dump. Anyone holding it can sign mail as this domain."
else
  echo "No --keys directory given or it does not exist. DKIM keys are NOT backed up by this run." >&2
fi

if [ -n "$MAILDIR" ] && [ -d "$MAILDIR" ]; then
  echo "Maildirs:"
  F="$OUT_DIR/maildir-$STAMP.tar.enc"
  archive "$MAILDIR" "$F"
  report "maildir-$STAMP" "mailboxes" "$F" true ""
else
  echo "No --maildir given or it does not exist. The IMAP copy of delivered mail is NOT backed up." >&2
fi

if [ -n "$CONFIG" ] && [ -d "$CONFIG" ]; then
  echo "MTA / IMAP / spam configuration:"
  F="$OUT_DIR/mailconfig-$STAMP.tar.enc"
  archive "$CONFIG" "$F"
  report "mailconfig-$STAMP" "mail_config" "$F" true ""
fi

if [ -n "$SPOOL" ] && [ -d "$SPOOL/failed" ]; then
  echo "Dead-lettered mail (spool failed/):"
  F="$OUT_DIR/spool-failed-$STAMP.tar.enc"
  archive "$SPOOL/failed" "$F"
  report "spoolfailed-$STAMP" "spool" "$F" true ""
  echo "  queued/ and sending/ are deliberately NOT captured. A stale spool restored later re-sends"
  echo "  mail that has already gone out, which is worse than losing it."
fi

echo ""
echo "None of these is a verified backup until it has been restored onto a scratch host:"
echo "  maildir - point a Dovecot instance at the restored tree and open a mailbox over IMAP"
echo "  keys    - sign a message with the restored key and confirm dkim=pass at an external mailbox"
