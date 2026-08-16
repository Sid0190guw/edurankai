#!/usr/bin/env bash
# scripts/backup.sh — back up everything the mail stack cannot be rebuilt without.
#
#   ./scripts/backup.sh                 mail data, config, DKIM keys  (no database)
#   ./scripts/backup.sh --database      also dump Postgres  (see the warning below)
#   ./scripts/backup.sh --out DIR       write somewhere other than ./backups
#
# THE DATABASE DUMP IS OPT-IN AND IS RUN BY A PERSON, DELIBERATELY.
#
# docs/ops/BACKUP.md: "The founder runs everything in this document. No agent connects to the
# database, and no script in this repository is permitted to." That rule exists because a subagent
# asked to survey source files connected to production instead and read staff data out of
# hr_employees. This script honours it: --database is never implied, it prints the exact command it
# is about to run and asks for confirmation, and it refuses outright in a non-interactive shell.
#
# WHAT IS IN SCOPE HERE, in descending order of how badly you are hurt if you lose it:
#
#   1. DKIM PRIVATE KEYS — unrecoverable in the sense that matters. You can generate new ones, but
#      every message signed with the old key fails validation until DNS propagates, and anyone
#      holding a copy of the old key can sign mail as this domain forever.
#   2. MAILBOXES (docker/data/mta/mail) — the messages held on this host.
#   3. MAIL SERVER CONFIG (docker/data/mta/config) — accounts, aliases, generated settings.
#   4. THE DATABASE — everything else. Only a dump reconstructs it: the schema is created by ~343
#      self-bootstrapping statements scattered across application modules and no file in this
#      repository reproduces the live shape.
#
# WHAT IS DELIBERATELY NOT BACKED UP HERE: .env files and Vercel environment variables. Sweeping
# live credentials into a tarball on the same disk is not a backup, it is a second copy of the
# secret with worse permissions. docs/mail/BACKUP.md section 4 covers doing that properly.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKER_DIR="$ROOT/docker"
OUT_DIR="$ROOT/backups"
WITH_DB=0

while [ $# -gt 0 ]; do
  case "$1" in
    --database|--db) WITH_DB=1 ;;
    --out) OUT_DIR="${2:?--out needs a directory}"; shift ;;
    -h|--help) sed -n '2,10p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

if [ -t 1 ]; then RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'
else RED=''; GRN=''; YLW=''; DIM=''; RST=''; fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT_DIR"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/era-backup-XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

echo ""
echo "Backup $STAMP -> $OUT_DIR"
echo ""

# --- 1. mail data and configuration ----------------------------------------------------------------
copied_any=0
for src in "mta/mail:mailboxes" "mta/config:mail server config and DKIM keys" "mta/state:server state"; do
  path="$DOCKER_DIR/data/${src%%:*}"
  label="${src#*:}"
  if [ -d "$path" ]; then
    mkdir -p "$STAGE/$(dirname "${src%%:*}")"
    cp -a "$path" "$STAGE/${src%%:*}"
    size="$(du -sh "$path" 2>/dev/null | cut -f1 || echo '?')"
    printf '  %s+%s %-42s %s\n' "$GRN" "$RST" "$label" "$size"
    copied_any=1
  else
    printf '  %s-%s %-42s %s\n' "$DIM" "$RST" "$label" "not present on this host"
  fi
done

# --- 2. repository configuration --------------------------------------------------------------------
# The compose files and configs are in git, but a restore should not need the right commit checked
# out to be usable. These are small.
mkdir -p "$STAGE/repo-config"
for f in docker/compose.yml docker/compose.db.yml docker/compose.mail.yml docker/compose.observability.yml \
         docker/postfix docker/dovecot docker/rspamd docker/prometheus/prometheus.yml docker/prometheus/alerts.yml \
         docker/grafana vercel.json .env.example; do
  [ -e "$ROOT/$f" ] || continue
  mkdir -p "$STAGE/repo-config/$(dirname "$f")"
  cp -a "$ROOT/$f" "$STAGE/repo-config/$f"
done
printf '  %s+%s %-42s\n' "$GRN" "$RST" "compose files and service config"

# The prometheus bearer token is a real credential written by start-mail.sh. Never in the tarball.
rm -f "$STAGE/repo-config/docker/prometheus/metrics_token" 2>/dev/null || true

# --- 3. a manifest, so a restore knows what it is holding --------------------------------------------
{
  echo "EduRankAI Mail backup"
  echo "created:  $STAMP"
  echo "host:     $(hostname 2>/dev/null || echo unknown)"
  echo "commit:   $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo 'not a git checkout')"
  echo "database: $([ "$WITH_DB" = 1 ] && echo 'included' || echo 'NOT INCLUDED')"
  echo ""
  echo "Restore with:  ./scripts/restore.sh <this-file>"
  echo ""
  echo "NOT IN THIS ARCHIVE, and required for a working system:"
  echo "  - .env / .env.local / .env.production and the Vercel environment variables."
  echo "    Without DATABASE_URL, SESSION_SECRET, CRON_SECRET and the DATA_ENCRYPTION_KEY_* values"
  echo "    this archive restores a stack that cannot start. Those are backed up separately and"
  echo "    encrypted; docs/mail/BACKUP.md section 4."
  echo "  - DATA_ENCRYPTION_KEY_<keyId>. Losing one makes every column encrypted under it"
  echo "    permanently unreadable, and a perfect database dump does not help."
} > "$STAGE/MANIFEST.txt"

# --- 4. the database, only on request and only interactively -------------------------------------------
if [ "$WITH_DB" = 1 ]; then
  echo ""
  if [ ! -t 0 ]; then
    printf '%sRefusing --database in a non-interactive shell.%s\n' "$RED" "$RST"
    printf 'A database dump is run by a person on a trusted machine, never by automation in this repository.\n'
    printf 'docs/ops/BACKUP.md explains why. Run this from a terminal, or dump by hand.\n'
    exit 1
  fi
  if ! command -v pg_dump >/dev/null 2>&1; then
    printf '%spg_dump is not installed.%s Install the Postgres client tools, or dump from the Supabase dashboard.\n' "$RED" "$RST"
    exit 1
  fi

  DB_TARGET="${DATABASE_URL_DIRECT:-${DATABASE_URL:-}}"
  if [ -z "$DB_TARGET" ]; then
    printf '%sNeither DATABASE_URL_DIRECT nor DATABASE_URL is exported in this shell.%s\n' "$RED" "$RST"
    printf 'Export it yourself for this command — this script deliberately does not read your .env files.\n'
    exit 1
  fi
  # Show the host, never the password. A backup script that echoes a connection string into a
  # terminal has put it in the scrollback and, on Windows, in the terminal host's buffer.
  SAFE_TARGET="$(printf '%s' "$DB_TARGET" | sed -E 's#(://[^:]+):[^@]*@#\1:****@#')"
  case "$DB_TARGET" in
    *:6543/*) printf '%sNote: this is the transaction pooler (:6543). pg_dump wants the DIRECT connection (:5432);%s\n' "$YLW" "$RST"
              printf '%sa dump through the pooler can fail or produce an inconsistent snapshot. Set DATABASE_URL_DIRECT.%s\n' "$YLW" "$RST" ;;
  esac
  echo ""
  echo "About to run:"
  echo "  pg_dump --format=custom --no-owner --no-acl '$SAFE_TARGET' > <archive>/database.dump"
  echo ""
  read -r -p "Type YES to run it: " answer
  if [ "$answer" != "YES" ]; then
    echo "Skipped the database. The archive will contain mail data only."
    sed -i.bak 's/^database: included/database: NOT INCLUDED (declined at prompt)/' "$STAGE/MANIFEST.txt" 2>/dev/null || true
    rm -f "$STAGE/MANIFEST.txt.bak"
  else
    echo "Dumping..."
    pg_dump --format=custom --no-owner --no-acl "$DB_TARGET" > "$STAGE/database.dump"
    printf '  %s+%s %-42s %s\n' "$GRN" "$RST" "database dump" "$(du -sh "$STAGE/database.dump" | cut -f1)"
  fi
fi

# --- 5. archive --------------------------------------------------------------------------------------
ARCHIVE="$OUT_DIR/mail-$STAMP.tar.gz"
tar -czf "$ARCHIVE" -C "$STAGE" .
chmod 600 "$ARCHIVE" 2>/dev/null || true

echo ""
printf '%sWrote%s %s  (%s)\n' "$GRN" "$RST" "$ARCHIVE" "$(du -sh "$ARCHIVE" | cut -f1)"

# --- 6. verify the archive is readable ----------------------------------------------------------------
# An unverified backup is a hope. This is the cheapest possible check — that tar can list it — and
# it catches the truncated-write and out-of-disk cases, which are the common ones.
if tar -tzf "$ARCHIVE" >/dev/null 2>&1; then
  printf '%sVerified%s the archive lists cleanly (%s entries)\n' "$GRN" "$RST" "$(tar -tzf "$ARCHIVE" | wc -l | tr -d ' ')"
else
  printf '%sWARNING: the archive was written but cannot be listed. Treat it as unusable.%s\n' "$RED" "$RST"
  exit 1
fi

if [ "$copied_any" = 0 ]; then
  echo ""
  printf '%sNothing but configuration was backed up — no mail data exists on this host yet.%s\n' "$YLW" "$RST"
fi

cat <<NOTE

  A backup you have never restored is a hope, not a backup. docs/mail/BACKUP.md section 6 is a
  30-minute restore drill against a scratch directory. Do it once, now, rather than for the first
  time during an incident.

  Retention is NOT automated. Old archives accumulate in $OUT_DIR until somebody deletes them.

NOTE
