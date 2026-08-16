#!/usr/bin/env bash
# scripts/restore.sh — restore from an archive made by ./scripts/backup.sh.
#
#   ./scripts/restore.sh backups/mail-20260816T120000Z.tar.gz --inspect     list, change nothing
#   ./scripts/restore.sh backups/mail-...tar.gz --to /tmp/drill             restore to a scratch dir
#   ./scripts/restore.sh backups/mail-...tar.gz --live                      restore over the real stack
#
# --inspect IS THE DEFAULT. A restore script whose default action overwrites live mailboxes is a
# loaded weapon, and the moment you reach for it is the moment you are least careful. So: reading is
# free, restoring to a scratch directory is one flag, and overwriting the real thing needs --live,
# a stopped stack, and a typed confirmation.
#
# THE DATABASE IS NEVER RESTORED BY THIS SCRIPT. It prints the exact pg_restore command and stops.
# Restoring a database is destructive, irreversible, and belongs to a person who has decided to do
# it — the same rule docs/ops/BACKUP.md applies to dumps.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKER_DIR="$ROOT/docker"

if [ -t 1 ]; then RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; BLD=$'\033[1m'; DIM=$'\033[2m'; RST=$'\033[0m'
else RED=''; GRN=''; YLW=''; BLD=''; DIM=''; RST=''; fi

ARCHIVE="${1:-}"
[ -n "$ARCHIVE" ] || { sed -n '2,18p' "${BASH_SOURCE[0]}"; exit 1; }
shift || true
[ -f "$ARCHIVE" ] || { printf '%sNo such archive: %s%s\n' "$RED" "$ARCHIVE" "$RST"; exit 1; }

MODE="inspect"
DEST=""
while [ $# -gt 0 ]; do
  case "$1" in
    --inspect) MODE="inspect" ;;
    --to) MODE="scratch"; DEST="${2:?--to needs a directory}"; shift ;;
    --live) MODE="live" ;;
    -h|--help) sed -n '2,18p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

# --- always: read the manifest and show what is inside ------------------------------------------------
printf '\n%sArchive%s %s (%s)\n\n' "$BLD" "$RST" "$ARCHIVE" "$(du -sh "$ARCHIVE" | cut -f1)"

if ! tar -tzf "$ARCHIVE" >/dev/null 2>&1; then
  printf '%sThis archive cannot be listed — it is truncated or corrupt. Do not rely on it.%s\n\n' "$RED" "$RST"
  exit 1
fi

MANIFEST="$(tar -xzOf "$ARCHIVE" ./MANIFEST.txt 2>/dev/null || tar -xzOf "$ARCHIVE" MANIFEST.txt 2>/dev/null || true)"
if [ -n "$MANIFEST" ]; then
  printf '%s\n' "$MANIFEST" | sed 's/^/  /'
else
  printf '  %s(no manifest — this archive was not made by ./scripts/backup.sh)%s\n' "$YLW" "$RST"
fi

printf '\n%sContents%s\n' "$BLD" "$RST"
tar -tzf "$ARCHIVE" | awk -F/ '{ if (NF>1 && $2 != "") print $2 }' | sort -u | sed 's/^/  /' | head -20

HAS_DB=0
tar -tzf "$ARCHIVE" | grep -q 'database\.dump$' && HAS_DB=1

if [ "$MODE" = "inspect" ]; then
  cat <<INSPECT

  ${DIM}Nothing was changed. To go further:${RST}
    ./scripts/restore.sh "$ARCHIVE" --to /tmp/restore-drill    ${DIM}# safe: a scratch copy${RST}
    ./scripts/restore.sh "$ARCHIVE" --live                     ${DIM}# overwrites the real stack${RST}

INSPECT
  exit 0
fi

# --- scratch restore ------------------------------------------------------------------------------------
if [ "$MODE" = "scratch" ]; then
  mkdir -p "$DEST"
  # Refuse a non-empty destination rather than merging into it. A restore that half-overwrites an
  # existing tree produces a state that is neither the backup nor what was there, and nobody can
  # tell afterwards which files came from where.
  if [ -n "$(ls -A "$DEST" 2>/dev/null || true)" ]; then
    printf '\n%s%s is not empty. Refusing to merge a restore into an existing directory.%s\n\n' "$RED" "$DEST" "$RST"
    exit 1
  fi
  tar -xzf "$ARCHIVE" -C "$DEST"
  printf '\n%sRestored to%s %s\n' "$GRN" "$RST" "$DEST"
  printf '  %sNothing live was touched. Compare against the running stack before trusting the archive.%s\n\n' "$DIM" "$RST"
  [ "$HAS_DB" = 1 ] && printf '  The database dump is at %s/database.dump — see the command below.\n\n' "$DEST"
fi

# --- live restore ---------------------------------------------------------------------------------------
if [ "$MODE" = "live" ]; then
  # A restore into a running mail server is a corrupted mailbox: Dovecot holds index files open and
  # rewrites them, so files replaced underneath it are inconsistent the moment it next writes.
  if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -q 'mta\|mail-parser\|mail-worker'; then
    printf '\n%sThe mail stack is still running.%s Stop it first:\n' "$RED" "$RST"
    printf '  ./scripts/stop-mail.sh\n'
    printf '\nRestoring into a running Dovecot corrupts mailbox index files; the damage is not visible\n'
    printf 'until the next write, by which point the backup has been overwritten too.\n\n'
    exit 1
  fi

  printf '\n%sThis will REPLACE:%s\n' "$RED" "$RST"
  for d in mta/mail mta/config mta/state; do
    [ -d "$DOCKER_DIR/data/$d" ] && printf '  docker/data/%-16s %s\n' "$d" "$(du -sh "$DOCKER_DIR/data/$d" 2>/dev/null | cut -f1)"
  done
  printf '\nThe CURRENT contents will be moved aside to docker/data/.pre-restore-%s rather than deleted,\n' "$(date -u +%Y%m%dT%H%M%SZ)"
  printf 'so a restore from the wrong archive is recoverable.\n\n'
  read -r -p "Type RESTORE to proceed: " answer
  [ "$answer" = "RESTORE" ] || { echo "Cancelled. Nothing was changed."; exit 1; }

  ASIDE="$DOCKER_DIR/data/.pre-restore-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$ASIDE"
  for d in mta; do
    [ -d "$DOCKER_DIR/data/$d" ] && mv "$DOCKER_DIR/data/$d" "$ASIDE/" || true
  done

  STAGE="$(mktemp -d "${TMPDIR:-/tmp}/era-restore-XXXXXX")"
  trap 'rm -rf "$STAGE"' EXIT
  tar -xzf "$ARCHIVE" -C "$STAGE"
  mkdir -p "$DOCKER_DIR/data"
  [ -d "$STAGE/mta" ] && cp -a "$STAGE/mta" "$DOCKER_DIR/data/"

  printf '\n%sRestored.%s Previous contents kept at %s\n' "$GRN" "$RST" "$ASIDE"
  printf '  Start the stack and verify BEFORE deleting that directory:\n'
  printf '    ./scripts/start-mail.sh --mail\n'
  printf '    ./scripts/test-mail.sh\n\n'
fi

# --- the database, always by hand ----------------------------------------------------------------------
if [ "$HAS_DB" = 1 ]; then
  cat <<DBNOTE
${BLD}The database is NOT restored by this script.${RST}

Extract the dump and run pg_restore yourself, against a target you have chosen deliberately:

  tar -xzf "$ARCHIVE" -C /tmp ./database.dump
  pg_restore --clean --if-exists --no-owner --no-acl \\
    --dbname "\$DATABASE_URL_DIRECT" /tmp/database.dump

${YLW}--clean DROPS existing objects before recreating them.${RST} Against the wrong database that is
total data loss with no undo. Check twice which connection string is in that variable, and prefer
restoring into a NEW empty database first and comparing.

Use the DIRECT connection (:5432), not the transaction pooler (:6543) — pg_restore needs session
state the pooler does not provide.

DBNOTE
fi
