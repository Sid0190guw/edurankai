#!/usr/bin/env bash
# scripts/status-mail.sh — what is actually running, and what is actually answering.
#
# TWO DIFFERENT QUESTIONS, ASKED SEPARATELY, because they disagree more often than people expect:
#   `docker compose ps`  — which containers exist and what the container runtime thinks of them.
#   the health probes    — which of them answer a real request.
# A container can be "Up 4 hours" and refusing every connection. The second block is the one to
# believe.
#
#   ./scripts/status-mail.sh            summary
#   ./scripts/status-mail.sh --json     machine-readable (for a script or a cron)
#   ./scripts/status-mail.sh --logs     ... plus the last 20 log lines of anything unhealthy
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKER_DIR="$ROOT/docker"
ENV_FILE="${ENV_FILE:-$ROOT/.env.local}"

if [ -t 1 ]; then GRN=$'\033[32m'; RED=$'\033[31m'; YLW=$'\033[33m'; DIM=$'\033[2m'; BLD=$'\033[1m'; RST=$'\033[0m'
else GRN=''; RED=''; YLW=''; DIM=''; BLD=''; RST=''; fi

JSON=0; LOGS=0
for arg in "$@"; do
  case "$arg" in
    --json) JSON=1 ;;
    --logs) LOGS=1 ;;
    -h|--help) sed -n '2,16p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 1 ;;
  esac
done

envget() { [ -f "$ENV_FILE" ] && grep -E "^${1}=" "$ENV_FILE" | tail -n1 | cut -d= -f2- | sed 's/^"//; s/"$//' || true; }
MAILOPS_PORT="$(envget PORT_MAILOPS)"; MAILOPS_PORT="${MAILOPS_PORT:-9100}"

if [ "$JSON" = 1 ]; then
  curl -fsS "http://127.0.0.1:${MAILOPS_PORT}/health" 2>/dev/null || printf '{"status":"down","error":"health aggregator is not answering on port %s"}\n' "$MAILOPS_PORT"
  exit 0
fi

printf '\n%sContainers%s  %s(what the runtime believes)%s\n' "$BLD" "$RST" "$DIM" "$RST"
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  FILES=(-f "$DOCKER_DIR/compose.yml" -f "$DOCKER_DIR/compose.db.yml" -f "$DOCKER_DIR/compose.mail.yml" -f "$DOCKER_DIR/compose.observability.yml")
  ENV_ARG=(); [ -f "$ENV_FILE" ] && ENV_ARG=(--env-file "$ENV_FILE")
  docker compose "${ENV_ARG[@]}" --project-directory "$DOCKER_DIR" "${FILES[@]}" \
    --profile localdb --profile mail --profile observability ps \
    --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || echo "  (compose could not list services)"
else
  printf '  %sdocker is not available — skipping container list%s\n' "$DIM" "$RST"
fi

printf '\n%sHealth%s  %s(what actually answers)%s\n' "$BLD" "$RST" "$DIM" "$RST"
if BODY="$(curl -fsS "http://127.0.0.1:${MAILOPS_PORT}/health" 2>/dev/null)" || BODY="$(curl -s "http://127.0.0.1:${MAILOPS_PORT}/health" 2>/dev/null)"; then
  if [ -n "$BODY" ]; then
    node "$ROOT/scripts/mail-status.mjs" --port "$MAILOPS_PORT"
  else
    printf '  %sthe health aggregator on port %s is not answering.%s\n' "$RED" "$MAILOPS_PORT" "$RST"
    printf '  Either the stack is not running (./scripts/start-mail.sh) or the aggregator itself failed:\n'
    printf '    docker compose --project-directory docker -f docker/compose.yml logs --tail=50 mailops\n'
  fi
else
  printf '  %sno response on http://127.0.0.1:%s/health%s\n' "$RED" "$MAILOPS_PORT" "$RST"
  printf '  The stack is probably not running.  ./scripts/start-mail.sh\n'
fi

# Captured mail: the fastest way to answer "did my test message go anywhere".
SINK="$(curl -fsS http://127.0.0.1:1080/health 2>/dev/null || true)"
if [ -n "$SINK" ]; then
  COUNT="$(printf '%s' "$SINK" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).captured))}catch{process.stdout.write("?")}})' 2>/dev/null || echo '?')"
  printf '\n%sSink%s  %s messages captured  %s(http://localhost:1080/messages)%s\n' "$BLD" "$RST" "$COUNT" "$DIM" "$RST"
fi

if [ "$LOGS" = 1 ]; then
  printf '\n%sRecent logs from anything unhealthy%s\n' "$BLD" "$RST"
  DEGRADED="$(curl -fsS "http://127.0.0.1:${MAILOPS_PORT}/health" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write((JSON.parse(s).degraded||[]).join(" "))}catch{}})' 2>/dev/null || true)"
  if [ -z "$DEGRADED" ]; then
    printf '  %snothing is degraded%s\n' "$DIM" "$RST"
  else
    for svc in $DEGRADED; do
      # Probe names and service names differ for two components; map them.
      case "$svc" in
        smtp|submission|imap) svc=mta ;;
        ingest) svc=mail-parser ;;
        worker) svc=mail-worker ;;
        sink) svc=smtp-sink ;;
      esac
      printf '\n%s--- %s ---%s\n' "$YLW" "$svc" "$RST"
      docker compose --project-directory "$DOCKER_DIR" -f "$DOCKER_DIR/compose.yml" -f "$DOCKER_DIR/compose.mail.yml" --profile mail logs --tail=20 "$svc" 2>/dev/null || echo "  (no logs)"
    done
  fi
fi

printf '\n'
