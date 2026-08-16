#!/usr/bin/env bash
# scripts/test-mail.sh — prove the mail stack actually works.
#
#   ./scripts/test-mail.sh              unit + live-stack integration
#   ./scripts/test-mail.sh --quick      unit tests only (no stack needed, ~2s)
#   ./scripts/test-mail.sh --security   add the security suite
#   ./scripts/test-mail.sh --load 1000  add a load run of N messages
#   ./scripts/test-mail.sh --all        everything
#
# A SKIPPED SUITE IS NOT A PASSING SUITE, and this script exits non-zero for one. That rule is the
# reason the layer exists: an integration suite that cannot reach the system it tests will otherwise
# report success for months while every case silently no-ops.
#
# Pass --allow-skip when you are deliberately testing only part of the stack.
set -uo pipefail   # NOT -e: a failing suite must still let the summary print

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -t 1 ]; then GRN=$'\033[32m'; RED=$'\033[31m'; YLW=$'\033[33m'; BLD=$'\033[1m'; DIM=$'\033[2m'; RST=$'\033[0m'
else GRN=''; RED=''; YLW=''; BLD=''; DIM=''; RST=''; fi

QUICK=0; SECURITY=0; LOAD=0; LOAD_N=1000; ALLOW_SKIP=0; DNS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --quick) QUICK=1 ;;
    --security) SECURITY=1 ;;
    --load) LOAD=1; [ "${2:-}" ] && [[ "${2}" =~ ^[0-9]+$ ]] && { LOAD_N="$2"; shift; } ;;
    --dns) DNS=1 ;;
    --all) SECURITY=1; LOAD=1; DNS=1 ;;
    --allow-skip) ALLOW_SKIP=1 ;;
    -h|--help) sed -n '2,18p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

# Load .env.local into this shell so the suites can authenticate. Parsed, never sourced: `source` on
# a file containing $(...) executes it, and .env.local is exactly the file you least want to run.
ENV_FILE="${ENV_FILE:-$ROOT/.env.local}"
if [ -f "$ENV_FILE" ]; then
  while IFS= read -r line; do
    case "$line" in ''|'#'*) continue ;; esac
    key="${line%%=*}"
    val="${line#*=}"
    case "$key" in
      CRON_SECRET|MAIL_INBOUND_SECRET|MAIL_WEBHOOK_SECRET|METRICS_TOKEN|MAIL_DOMAIN|TEST_SESSION_COOKIE|TEST_BASE_URL)
        val="${val%\"}"; val="${val#\"}"
        export "$key=$val" ;;
    esac
  done < "$ENV_FILE"
fi

FAILED=0
SKIPPED_RUN=0

printf '\n%s=== 1. Unit tests (no stack required) ===%s\n' "$BLD" "$RST"
# The infrastructure layer's own tests: signature verification, CORS, env grouping, signer parity
# between the container and the app. These must pass on any machine, always.
if npx vitest run src/lib/mailops/ 2>&1 | tail -8; then
  printf '%s  unit tests passed%s\n' "$GRN" "$RST"
else
  printf '%s  unit tests FAILED%s\n' "$RED" "$RST"
  FAILED=1
fi

if [ "$QUICK" = 1 ]; then
  printf '\n%s--quick: stopping here. The live-stack guarantees were NOT tested.%s\n\n' "$YLW" "$RST"
  exit $FAILED
fi

printf '\n%s=== 2. Stack health ===%s\n' "$BLD" "$RST"
if node scripts/mail-status.mjs 2>/dev/null; then
  printf '%s  stack healthy%s\n' "$GRN" "$RST"
else
  printf '%s  the stack is not fully healthy — suites below will skip rather than pass%s\n' "$YLW" "$RST"
fi

printf '\n%s=== 3. Integration (send, receive, campaign, automation) ===%s\n' "$BLD" "$RST"
ARGS=""
[ "$ALLOW_SKIP" = 1 ] && ARGS="--allow-skip"
node tests/run.mjs --only integration $ARGS
rc=$?
[ $rc -eq 1 ] && FAILED=1
[ $rc -eq 2 ] && SKIPPED_RUN=1

if [ "$SECURITY" = 1 ]; then
  printf '\n%s=== 4. Security ===%s\n' "$BLD" "$RST"
  node tests/run.mjs --only security $ARGS
  rc=$?
  [ $rc -eq 1 ] && FAILED=1
  [ $rc -eq 2 ] && SKIPPED_RUN=1
fi

if [ "$DNS" = 1 ]; then
  printf '\n%s=== 5. DNS and DKIM ===%s\n' "$BLD" "$RST"
  # The app already owns this check and shows it on /admin/mail/health; calling the same endpoint
  # keeps one implementation rather than a second opinion that can disagree with the screen.
  BASE="${TEST_BASE_URL:-http://127.0.0.1:4321}"
  if OUT="$(curl -fsS "$BASE/api/mail/dns-check" 2>/dev/null)"; then
    printf '%s\n' "$OUT"
    printf '%s  read this yourself: a DKIM record published WITHOUT a matching private key makes every%s\n' "$DIM" "$RST"
    printf '%s  signature fail while the DNS record makes the setup look configured.%s\n' "$DIM" "$RST"
  else
    printf '%s  /api/mail/dns-check did not answer — DNS was NOT verified%s\n' "$YLW" "$RST"
    SKIPPED_RUN=1
  fi
fi

if [ "$LOAD" = 1 ]; then
  printf '\n%s=== 6. Load (%s messages, sink only) ===%s\n' "$BLD" "$LOAD_N" "$RST"
  node tests/load/loadtest.mjs --messages "$LOAD_N" --concurrency 16 || FAILED=1
fi

printf '\n%s' "$BLD"
if [ "$FAILED" = 1 ]; then
  printf '%sSomething failed. Do not deploy on this result.%s\n\n' "$RED" "$RST"
  exit 1
fi
if [ "$SKIPPED_RUN" = 1 ] && [ "$ALLOW_SKIP" = 0 ]; then
  printf '%sNothing failed, but suites were SKIPPED — parts of the system were not tested.%s\n' "$YLW" "$RST"
  printf '%sStart the missing services and run again, or pass --allow-skip if that is what you want.%s\n\n' "$YLW" "$RST"
  exit 2
fi
printf '%sAll requested checks passed.%s\n\n' "$GRN" "$RST"
exit 0
