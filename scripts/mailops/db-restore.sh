#!/usr/bin/env bash
# scripts/mailops/db-restore.sh - restore a dump into a SCRATCH database, verify it, and file the result.
#
# THIS IS WHAT TURNS A COPY INTO A BACKUP. Until a dump has been restored and checked, the
# continuity page shows it as "never" verified, whatever its size or age. That is not pedantry:
# the two ways a backup fails silently are a zero-byte artefact and a restore that completes with
# empty tables, and neither is visible from the backup side.
#
# IT REFUSES TO RESTORE OVER PRODUCTION. The target must not be the URL in DATABASE_URL or
# DATABASE_URL_DIRECT, and must not be the pooler. This guard is here because the restore command
# and the "oh no" command differ by one string.
#
#   ./scripts/mailops/db-restore.sh --artefact /backups/db-2026....dump.enc \
#       --target 'postgres://postgres:pw@localhost:5433/scratch' [--report-to https://www.edurankai.in]
#
# The scratch target is easiest as a throwaway container:
#   docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=pw --name era-restore-test postgres:17
#
set -euo pipefail

ARTEFACT=""; TARGET=""; REPORT_TO=""; ASSET="database"; IDENTITY=""; ARTEFACT_ID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --artefact) ARTEFACT="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    --report-to) REPORT_TO="$2"; shift 2 ;;
    --asset) ASSET="$2"; shift 2 ;;
    --identity) IDENTITY="$2"; shift 2 ;;
    --artefact-id) ARTEFACT_ID="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$ARTEFACT" ] && [ -n "$TARGET" ] || { echo "--artefact <file> and --target <scratch-connection-string> are required" >&2; exit 2; }
[ -f "$ARTEFACT" ] || { echo "No such artefact: $ARTEFACT" >&2; exit 2; }
[ -n "$ARTEFACT_ID" ] || ARTEFACT_ID="$(basename "$ARTEFACT" | sed 's/\.dump\.enc$//')"

# --- the guard -----------------------------------------------------------------------------
if [ -n "${DATABASE_URL:-}" ] && [ "$TARGET" = "$DATABASE_URL" ]; then
  echo "REFUSING: --target is DATABASE_URL. That is production." >&2; exit 2
fi
if [ -n "${DATABASE_URL_DIRECT:-}" ] && [ "$TARGET" = "$DATABASE_URL_DIRECT" ]; then
  echo "REFUSING: --target is DATABASE_URL_DIRECT. That is production." >&2; exit 2
fi
case "$TARGET" in
  *pooler.supabase.com*|*:6543/*)
    echo "REFUSING: --target looks like the production pooler. A restore test runs against a scratch instance." >&2; exit 2 ;;
esac
command -v pg_restore >/dev/null || { echo "pg_restore is not on PATH." >&2; exit 2; }
command -v psql       >/dev/null || { echo "psql is not on PATH." >&2; exit 2; }

DECRYPT=""
case "$ARTEFACT" in
  *.enc)
    if command -v age >/dev/null && [ -n "$IDENTITY" ]; then DECRYPT="age -d -i $IDENTITY"
    elif command -v gpg >/dev/null; then DECRYPT="gpg --batch --quiet --decrypt"
    else echo "Encrypted artefact but no decryptor. Pass --identity <age-key-file>, or install gpg." >&2; exit 2; fi ;;
esac

# --- checksum ------------------------------------------------------------------------------
if [ -f "$ARTEFACT.sha256" ]; then
  echo "Checking the artefact against its recorded checksum ..."
  ( cd "$(dirname "$ARTEFACT")" && { sha256sum -c "$(basename "$ARTEFACT").sha256" 2>/dev/null || shasum -a 256 -c "$(basename "$ARTEFACT").sha256"; } ) \
    || { echo "CHECKSUM MISMATCH. The artefact has changed since it was written. Do not trust this restore." >&2; exit 1; }
else
  echo "No .sha256 beside the artefact, so silent corruption cannot be ruled out."
fi

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
START_EPOCH="$(date -u +%s)"
TEST_ID="restore-$(date -u +%Y%m%dT%H%M%SZ)"

echo "Restoring into the scratch target ..."
set +e
if [ -n "$DECRYPT" ]; then
  $DECRYPT < "$ARTEFACT" | pg_restore --dbname="$TARGET" --no-owner --no-privileges --clean --if-exists
else
  pg_restore --dbname="$TARGET" --no-owner --no-privileges --clean --if-exists "$ARTEFACT"
fi
RESTORE_STATUS=$?
set -e
FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
DURATION=$(( $(date -u +%s) - START_EPOCH ))

# --- verification --------------------------------------------------------------------------
# A restore that completes and leaves empty tables is a successful command and a failed backup, so
# what is checked is CONTENT, not the exit code. pg_restore also exits non-zero on benign
# --clean warnings, which is exactly why it cannot be the test on its own.
echo "Verifying content ..."
q() { psql "$TARGET" -tA -c "$1" 2>/dev/null || echo "ERR"; }

TABLES=$(q "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
MESSAGES=$(q "SELECT count(*) FROM mail_messages")
USERS=$(q "SELECT count(*) FROM users")
NEWEST=$(q "SELECT COALESCE(max(created_at)::text,'none') FROM mail_messages")

# Checks are accumulated as JSON fragments. Plain string building rather than a JSON tool, because
# this script has to run on a machine where the only certainty is bash, psql and curl.
CHECKS_JSON=""
add_check() {   # name  ok(true|false)  detail
  entry="{\"name\":\"$1\",\"ok\":$2,\"detail\":\"$3\"}"
  if [ -z "$CHECKS_JSON" ]; then CHECKS_JSON="$entry"; else CHECKS_JSON="$CHECKS_JSON,$entry"; fi
}

OK="true"
[ "$TABLES" != "ERR" ] && [ "${TABLES:-0}" -gt 50 ] && T_OK=true || { T_OK=false; OK="false"; }
[ "$MESSAGES" != "ERR" ] && [ "${MESSAGES:-0}" -gt 0 ] && M_OK=true || { M_OK=false; OK="false"; }
[ "$USERS" != "ERR" ] && [ "${USERS:-0}" -gt 0 ] && U_OK=true || { U_OK=false; OK="false"; }

add_check "tables present" "$T_OK" "public schema has ${TABLES} tables (expected well over 50)"
add_check "mail_messages populated" "$M_OK" "${MESSAGES} rows; newest ${NEWEST}"
add_check "users populated" "$U_OK" "${USERS} rows"
add_check "pg_restore exit code" "$([ $RESTORE_STATUS -eq 0 ] && echo true || echo false)" "exit ${RESTORE_STATUS} - non-zero is common with --clean and is not on its own a failure"
CHECKS="[$CHECKS_JSON]"

echo ""
echo "tables=$TABLES  mail_messages=$MESSAGES  users=$USERS  newest_message=$NEWEST"
echo "restore took ${DURATION}s"
echo ""
if [ "$OK" = "true" ]; then echo "RESTORE VERIFIED."; else echo "RESTORE NOT VERIFIED - see the counts above." >&2; fi

if [ -n "$REPORT_TO" ]; then
  if [ -z "${CRON_SECRET:-}" ]; then
    echo "CRON_SECRET is not set, so this test was NOT filed. The continuity page will still show this backup as unverified." >&2
  else
    curl -sS -X POST "$REPORT_TO/api/mailops/report" \
      -H "Authorization: Bearer $CRON_SECRET" -H 'Content-Type: application/json' \
      -d "{\"kind\":\"restore-test\",\"id\":\"$TEST_ID\",\"assetClass\":\"$ASSET\",\"artefactId\":\"$ARTEFACT_ID\",\"startedAt\":\"$STARTED_AT\",\"finishedAt\":\"$FINISHED_AT\",\"ok\":$OK,\"durationSeconds\":$DURATION,\"target\":\"scratch\",\"checks\":$CHECKS,\"reportedBy\":\"db-restore.sh\"}" \
      >/dev/null && echo "Filed to the continuity ledger." || echo "Could not file to the ledger." >&2
  fi
fi

echo ""
echo "Drop the scratch database when you are done. Do not leave a copy of production data on a"
echo "machine that was not chosen to hold one."
[ "$OK" = "true" ] || exit 1
