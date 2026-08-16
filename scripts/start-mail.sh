#!/usr/bin/env bash
# scripts/start-mail.sh — bring up the local mail stack.
#
# Written to be run by a person who did not build it. It checks preconditions BEFORE starting
# anything, because the failure modes here are slow: a stack that comes up with a missing secret
# looks healthy for about a minute and then refuses every message, and the error appears in a
# container log nobody is tailing.
#
#   ./scripts/start-mail.sh                    app + worker + ingest + sink + health
#   ./scripts/start-mail.sh --mail             ... plus the real MTA (Postfix/Dovecot/Rspamd)
#   ./scripts/start-mail.sh --observability    ... plus Prometheus + Grafana
#   ./scripts/start-mail.sh --localdb          ... plus local Postgres + Redis (read the warning)
#   ./scripts/start-mail.sh --all              everything
#   ./scripts/start-mail.sh --build            force a rebuild of the app image
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKER_DIR="$ROOT/docker"
ENV_FILE="${ENV_FILE:-$ROOT/.env.local}"

# Colour only when attached to a terminal; a log file full of escape codes is unreadable.
if [ -t 1 ]; then RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'
else RED=''; GRN=''; YLW=''; DIM=''; RST=''; fi

say()  { printf '%s\n' "$*"; }
ok()   { printf '%s  ok %s %s\n' "$GRN" "$RST" "$*"; }
warn() { printf '%s warn%s %s\n' "$YLW" "$RST" "$*"; }
die()  { printf '%sFAILED%s %s\n' "$RED" "$RST" "$*" >&2; exit 1; }

WITH_MAIL=0; WITH_OBS=0; WITH_DB=0; BUILD=0
for arg in "$@"; do
  case "$arg" in
    --mail) WITH_MAIL=1 ;;
    --observability|--obs) WITH_OBS=1 ;;
    --localdb) WITH_DB=1 ;;
    --all) WITH_MAIL=1; WITH_OBS=1; WITH_DB=1 ;;
    --build) BUILD=1 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown option: $arg (try --help)" ;;
  esac
done

# --- preconditions --------------------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || die "docker is not installed or not on PATH.
  Install Docker Desktop (Windows/macOS) or the docker engine + compose plugin (Linux),
  start it, and run this again. Nothing in this stack runs without it."

docker compose version >/dev/null 2>&1 || die "the docker compose plugin is missing.
  'docker-compose' (the old standalone binary) is NOT equivalent — these files use the v2 schema."

docker info >/dev/null 2>&1 || die "docker is installed but the daemon is not responding.
  On Windows/macOS: start Docker Desktop and wait for it to say 'running'."

[ -f "$ENV_FILE" ] || die "no environment file at $ENV_FILE
  cp .env.example .env.local   then fill it in. Every value is explained in that file."

# --- environment check ----------------------------------------------------------------------------
# Runs the same validation the app's /api/health/ready uses, against the file rather than a process.
say ""
say "${DIM}Checking environment...${RST}"
if ! node "$ROOT/scripts/mail-env-check.mjs" --file "$ENV_FILE" --quiet; then
  die "environment check failed (run 'node scripts/mail-env-check.mjs' for the detail).
  Starting anyway would produce a stack that looks healthy and refuses mail."
fi
ok "environment"

# Secrets the stack cannot work without. Read WITHOUT sourcing the file: `source` on a .env with a
# value containing a space, a backtick or a $( ) would execute it.
envget() { grep -E "^${1}=" "$ENV_FILE" | tail -n1 | cut -d= -f2- | sed 's/^"//; s/"$//' || true; }

CRON_SECRET_VAL="$(envget CRON_SECRET)"
[ -n "$CRON_SECRET_VAL" ] || die "CRON_SECRET is empty in $ENV_FILE.
  The worker calls /api/jobs/run with it; without it every poll is a 403 and the queue never drains.
  Generate one:  openssl rand -hex 32"

if [ "$WITH_OBS" = 1 ]; then
  [ -n "$(envget GRAFANA_ADMIN_PASSWORD)" ] || die "GRAFANA_ADMIN_PASSWORD is empty and --observability was requested.
  Grafana would start with the admin/admin default, which is a public login."
  # Prometheus cannot expand env vars in most config fields, so the bearer token goes in a file.
  METRICS_TOKEN_VAL="$(envget METRICS_TOKEN)"
  if [ -n "$METRICS_TOKEN_VAL" ]; then
    printf '%s' "$METRICS_TOKEN_VAL" > "$DOCKER_DIR/prometheus/metrics_token"
    chmod 600 "$DOCKER_DIR/prometheus/metrics_token" 2>/dev/null || true
    ok "wrote docker/prometheus/metrics_token (gitignored)"
  else
    warn "METRICS_TOKEN is empty — /api/metrics answers 404 by design, and the 'app' scrape job will show as failing in Prometheus."
  fi
fi

# --- assemble the compose invocation ---------------------------------------------------------------
FILES=(-f "$DOCKER_DIR/compose.yml")
PROFILES=()
[ "$WITH_DB" = 1 ]   && { FILES+=(-f "$DOCKER_DIR/compose.db.yml");            PROFILES+=(--profile localdb); }
[ "$WITH_MAIL" = 1 ] && { FILES+=(-f "$DOCKER_DIR/compose.mail.yml");          PROFILES+=(--profile mail); }
[ "$WITH_OBS" = 1 ]  && { FILES+=(-f "$DOCKER_DIR/compose.observability.yml"); PROFILES+=(--profile observability); }

mkdir -p "$DOCKER_DIR/data/sink" "$DOCKER_DIR/data/mta" "$DOCKER_DIR/data/prometheus" "$DOCKER_DIR/data/grafana" "$DOCKER_DIR/data/postgres" "$DOCKER_DIR/data/redis"

compose() { docker compose --env-file "$ENV_FILE" --project-directory "$DOCKER_DIR" "${FILES[@]}" "${PROFILES[@]}" "$@"; }

if [ "$WITH_DB" = 1 ]; then
  warn "--localdb uses a LOCAL Postgres. This project has no migration runner and no file
       reconstructs the live schema — the local database will contain only whatever tables the code
       paths you exercise happen to create. Read docker/compose.db.yml before trusting a result
       from it."
fi

if [ "$WITH_MAIL" = 1 ]; then
  say ""
  warn "--mail starts a REAL MTA that will attempt real delivery to real recipients.
       Outbound from the app still goes to the sink unless LOCAL_SMTP_MODE=local.
       Port 25 is blocked by most ISPs in both directions; that is not a fault in this stack."
fi

# --- start -----------------------------------------------------------------------------------------
say ""
say "${DIM}Starting...${RST}"
if [ "$BUILD" = 1 ]; then compose build --pull; fi
compose up -d --remove-orphans

# --- wait for health ---------------------------------------------------------------------------------
# Poll the aggregator rather than sleeping a fixed time. "docker compose up finished" means the
# containers were created, not that anything works — this project's whole ops posture is that
# reported success and observable result are different things.
say ""
say "${DIM}Waiting for the stack to report ready (up to 180s)...${RST}"
MAILOPS_PORT="$(envget PORT_MAILOPS)"; MAILOPS_PORT="${MAILOPS_PORT:-9100}"
DEADLINE=$(( $(date +%s) + 180 ))
LAST=""
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if BODY="$(curl -fsS "http://127.0.0.1:${MAILOPS_PORT}/ready" 2>/dev/null)"; then
    ok "stack ready"
    say ""
    node "$ROOT/scripts/mail-status.mjs" --port "$MAILOPS_PORT" 2>/dev/null || printf '%s\n' "$BODY"
    say ""
    say "  App          http://localhost:$( { envget PORT_APP; } || echo 4321 )"
    say "  Mail health  http://localhost:${MAILOPS_PORT}/health"
    say "  Captured mail (sink)  http://localhost:1080/messages"
    [ "$WITH_OBS" = 1 ] && say "  Prometheus   http://localhost:$( { envget PORT_PROMETHEUS; } || echo 9090 )
  Grafana      http://localhost:$( { envget PORT_GRAFANA; } || echo 3001 )  (admin / GRAFANA_ADMIN_PASSWORD)"
    say ""
    say "  Next:  ./scripts/test-mail.sh     end-to-end check"
    say "         ./scripts/status-mail.sh   what is running"
    exit 0
  fi
  BODY="$(curl -s "http://127.0.0.1:${MAILOPS_PORT}/ready" 2>/dev/null || true)"
  if [ -n "$BODY" ] && [ "$BODY" != "$LAST" ]; then LAST="$BODY"; printf '%s      %s%s\n' "$DIM" "$BODY" "$RST"; fi
  sleep 3
done

warn "the stack did not report ready within 180s."
say ""
compose ps
say ""
say "The aggregator's own view (which components it expected and which failed):"
curl -s "http://127.0.0.1:${MAILOPS_PORT}/health" || say "  (the aggregator itself is not answering — 'docker compose logs mailops')"
say ""
say "Logs:  docker compose --project-directory docker ${FILES[*]} logs --tail=80"
exit 1
