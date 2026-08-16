#!/usr/bin/env bash
# scripts/mailops/db-backup.sh - take an encrypted, checksummed database dump and report it.
#
# THE FOUNDER RUNS THIS. No agent and no process in this repository may open the production
# database; that rule exists because a subagent asked to survey source files connected to
# production and read staff PII instead. So this script is written to be handed over, and it is
# never invoked by anything in the application.
#
# USE THE DIRECT CONNECTION, NOT THE POOLER. pg_dump needs a session: it sets session parameters
# and holds a consistent snapshot. The Supabase transaction pooler on 6543 does not hold one, and
# the failure is confusing rather than loud - prepared-statement errors, or a dump that completes
# and is subtly inconsistent. Use the 5432 direct/session string.
#
# IT REFUSES TO PRODUCE AN UNENCRYPTED ARTEFACT. The dump contains every user, every application,
# every HR record and every message body in the system. `age` or `gpg` must be present.
#
#   ./scripts/mailops/db-backup.sh --out /backups --recipient age1... [--report-to https://www.edurankai.in]
#   DATABASE_URL_DIRECT=... ./scripts/mailops/db-backup.sh --out /backups --gpg-recipient ops@example
#
set -euo pipefail

OUT_DIR=""; RECIPIENT=""; GPG_RECIPIENT=""; REPORT_TO=""; ASSET="database"; OFFSITE="false"; TABLES=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT_DIR="$2"; shift 2 ;;
    --recipient) RECIPIENT="$2"; shift 2 ;;
    --gpg-recipient) GPG_RECIPIENT="$2"; shift 2 ;;
    --report-to) REPORT_TO="$2"; shift 2 ;;
    --offsite) OFFSITE="true"; shift ;;
    --tables) TABLES="$2"; ASSET="mail_config"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$OUT_DIR" ] || { echo "--out <dir> is required" >&2; exit 2; }
[ -n "${DATABASE_URL_DIRECT:-}" ] || {
  echo "DATABASE_URL_DIRECT is not set." >&2
  echo "Export the DIRECT (session, port 5432) connection string for this shell only:" >&2
  echo "    export DATABASE_URL_DIRECT='postgres://...:5432/postgres'   # note the leading space" >&2
  echo "Do NOT use the transaction pooler on 6543 - pg_dump needs a session it cannot hold." >&2
  exit 2
}
case "$DATABASE_URL_DIRECT" in
  *:6543/*) echo "That is the transaction pooler (:6543). pg_dump needs the direct connection (:5432)." >&2; exit 2 ;;
esac
command -v pg_dump >/dev/null || { echo "pg_dump is not on PATH. Install the client tools, matching or exceeding the server major version." >&2; exit 2; }

ENCRYPT_CMD=""
if [ -n "$RECIPIENT" ] && command -v age >/dev/null; then
  ENCRYPT_CMD="age -r $RECIPIENT"
elif [ -n "$GPG_RECIPIENT" ] && command -v gpg >/dev/null; then
  ENCRYPT_CMD="gpg --batch --yes --encrypt --recipient $GPG_RECIPIENT"
else
  echo "No usable encryption. Pass --recipient <age-key> with age installed, or --gpg-recipient <id> with gpg." >&2
  echo "This script will not write an unencrypted dump: it contains every user, message and HR record in the system." >&2
  exit 2
fi

mkdir -p "$OUT_DIR"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ID="db-$STAMP"
FILE="$OUT_DIR/$ID.dump.enc"

echo "Dumping ($ASSET) at $STARTED_AT ..."
# --format=custom so a restore can be selective and parallel. Piped straight into the encryptor:
# the plaintext never exists as a file, so an interrupted run cannot leave one behind.
set +e
if [ -n "$TABLES" ]; then
  TABLE_ARGS=""
  for t in $(echo "$TABLES" | tr ',' ' '); do TABLE_ARGS="$TABLE_ARGS --table=$t"; done
  # shellcheck disable=SC2086
  pg_dump "$DATABASE_URL_DIRECT" --format=custom --no-owner --no-privileges $TABLE_ARGS | $ENCRYPT_CMD > "$FILE"
else
  pg_dump "$DATABASE_URL_DIRECT" --format=custom --no-owner --no-privileges | $ENCRYPT_CMD > "$FILE"
fi
STATUS=${PIPESTATUS[0]}
set -e
FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

SIZE=0
[ -f "$FILE" ] && SIZE=$(wc -c < "$FILE" | tr -d ' ')
CHECKSUM=""
if command -v sha256sum >/dev/null; then CHECKSUM="$(sha256sum "$FILE" | cut -d' ' -f1)"
elif command -v shasum   >/dev/null; then CHECKSUM="$(shasum -a 256 "$FILE" | cut -d' ' -f1)"; fi

# A ZERO-BYTE FILE IS THE CLASSIC SILENT BACKUP FAILURE: the command exits, the file exists, and
# nobody looks again until a restore. Treated as a failure here, and reported as one.
OK="true"; ERROR=""
if [ "$STATUS" -ne 0 ]; then OK="false"; ERROR="pg_dump exited $STATUS"; fi
if [ "$SIZE" -lt 1024 ]; then OK="false"; ERROR="${ERROR:+$ERROR; }artefact is $SIZE bytes"; fi

if [ "$OK" = "true" ]; then
  echo "$CHECKSUM  $(basename "$FILE")" > "$FILE.sha256"
  echo "Wrote $FILE ($SIZE bytes)"
  echo "sha256 $CHECKSUM"
else
  echo "BACKUP FAILED: $ERROR" >&2
fi

if [ -n "$REPORT_TO" ]; then
  if [ -z "${CRON_SECRET:-}" ]; then
    echo "CRON_SECRET is not set, so the run was NOT filed to the continuity ledger." >&2
  else
    curl -sS -X POST "$REPORT_TO/api/mailops/report" \
      -H "Authorization: Bearer $CRON_SECRET" -H 'Content-Type: application/json' \
      -d "{\"kind\":\"backup\",\"id\":\"$ID\",\"assetClass\":\"$ASSET\",\"takenAt\":\"$STARTED_AT\",\"finishedAt\":\"$FINISHED_AT\",\"ok\":$OK,\"sizeBytes\":$SIZE,\"location\":\"$FILE\",\"encrypted\":true,\"offsite\":$OFFSITE,\"checksum\":\"$CHECKSUM\",\"error\":\"$ERROR\",\"reportedBy\":\"db-backup.sh\"}" \
      >/dev/null && echo "Filed to the continuity ledger." || echo "Could not file to the ledger (the dump itself is fine)." >&2
  fi
fi

echo ""
echo "This dump is NOT a verified backup until it has been restored."
echo "Run: ./scripts/mailops/db-restore.sh --artefact $FILE --target <scratch-connection-string>"
[ "$OK" = "true" ] || exit 1
