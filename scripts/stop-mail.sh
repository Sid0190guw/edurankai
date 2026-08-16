#!/usr/bin/env bash
# scripts/stop-mail.sh — stop the local mail stack.
#
#   ./scripts/stop-mail.sh              stop containers, KEEP all data
#   ./scripts/stop-mail.sh --volumes    also delete mailboxes, captured mail, metrics, local DB
#
# THE DEFAULT KEEPS EVERYTHING. `docker compose down -v` is one keystroke away from deleting every
# mailbox on the host, and it is the flag people reach for when a container will not start. So it is
# not the default here, it is spelled --volumes, and it asks first and says exactly what it will
# destroy — including whether a backup exists.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKER_DIR="$ROOT/docker"
ENV_FILE="${ENV_FILE:-$ROOT/.env.local}"

if [ -t 1 ]; then RED=$'\033[31m'; YLW=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'; else RED=''; YLW=''; DIM=''; RST=''; fi

WIPE=0
for arg in "$@"; do
  case "$arg" in
    --volumes|-v) WIPE=1 ;;
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) printf 'unknown option: %s\n' "$arg" >&2; exit 1 ;;
  esac
done

command -v docker >/dev/null 2>&1 || { echo "docker is not installed — nothing to stop."; exit 0; }

# Every compose file, so `down` catches containers started under any profile. Listing only the base
# file leaves the MTA and Grafana running, which is how a "stopped" stack keeps holding port 25.
FILES=(-f "$DOCKER_DIR/compose.yml" -f "$DOCKER_DIR/compose.db.yml" -f "$DOCKER_DIR/compose.mail.yml" -f "$DOCKER_DIR/compose.observability.yml")
PROFILES=(--profile localdb --profile mail --profile observability)

ENV_ARG=()
[ -f "$ENV_FILE" ] && ENV_ARG=(--env-file "$ENV_FILE")
compose() { docker compose "${ENV_ARG[@]}" --project-directory "$DOCKER_DIR" "${FILES[@]}" "${PROFILES[@]}" "$@"; }

if [ "$WIPE" = 1 ]; then
  printf '%s\n' ""
  printf '%sThis will permanently delete:%s\n' "$RED" "$RST"
  for d in "mta/mail:every mailbox stored on this host" "sink:captured test mail" "postgres:the local development database" "redis:the local Redis data" "prometheus:all metrics history" "grafana:dashboard state"; do
    path="$DOCKER_DIR/data/${d%%:*}"
    desc="${d#*:}"
    if [ -d "$path" ]; then
      size="$(du -sh "$path" 2>/dev/null | cut -f1 || echo '?')"
      printf '  %-28s %-6s %s\n' "docker/data/${d%%:*}" "$size" "$desc"
    fi
  done
  printf '\n'
  if [ -d "$DOCKER_DIR/data/mta/mail" ]; then
    LATEST_BACKUP="$(ls -1t "$ROOT/backups"/mail-*.tar.gz 2>/dev/null | head -n1 || true)"
    if [ -n "$LATEST_BACKUP" ]; then
      printf '%sMost recent backup: %s (%s)%s\n' "$YLW" "$(basename "$LATEST_BACKUP")" "$(date -r "$LATEST_BACKUP" 2>/dev/null || echo 'unknown date')" "$RST"
    else
      printf '%sTHERE IS NO BACKUP in ./backups. Run ./scripts/backup.sh first.%s\n' "$RED" "$RST"
    fi
  fi
  printf '\n'
  # Requires the word, not a y/n. A reflex "y" is exactly what this guard exists to stop.
  read -r -p "Type DELETE to confirm: " answer
  [ "$answer" = "DELETE" ] || { echo "Cancelled. Nothing was removed."; exit 1; }

  compose down --volumes --remove-orphans
  # Named volumes are handled by compose; these are bind mounts and it does not touch them.
  rm -rf "$DOCKER_DIR/data/mta" "$DOCKER_DIR/data/sink" "$DOCKER_DIR/data/postgres" "$DOCKER_DIR/data/redis" "$DOCKER_DIR/data/prometheus" "$DOCKER_DIR/data/grafana"
  echo "Stopped, and data removed."
  exit 0
fi

compose down --remove-orphans
printf '%sStopped. All data kept in docker/data — ./scripts/start-mail.sh brings it back.%s\n' "$DIM" "$RST"
