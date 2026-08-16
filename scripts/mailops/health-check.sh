#!/usr/bin/env bash
# scripts/mailops/health-check.sh - what is actually up on the mail host, reported to the platform.
#
# WHY THIS EXISTS. Nothing polls the mail host today. Every failure in the model on
# /admin/mail/continuity is currently detected by a person noticing that mail stopped, which on a
# single-laptop deployment can be a working day. Running this on a timer is the smallest change
# that turns "somebody noticed" into "the page says so".
#
#   ./scripts/mailops/health-check.sh --report-to https://www.edurankai.in
#   ./scripts/mailops/health-check.sh                       # print only, report nothing
#   watch -n 60 ./scripts/mailops/health-check.sh --report-to https://www.edurankai.in
#
# WHAT IT WILL NOT DO. It never reports a component as 'up' on the strength of a process existing.
# A listener that accepts a connection is up; a unit file that exists is not. The distinction is
# the whole value of the check - a dead Postfix with a live systemd unit is the exact shape of the
# incident that gets missed.
#
# SILENCE IS NOT HEALTH. If this script stops running, the platform sees no new reports and shows
# those components as UNKNOWN after ten minutes rather than continuing to show the last good state.
set -euo pipefail

REPORT_TO=""; SPOOL="${MAIL_SPOOL_DIR:-}"; MX_PORT="${MAIL_MX_PORT:-25}"; SUB_PORT="${MAIL_PORT:-587}"
IMAP_PORT="${MAIL_IMAP_PORT:-993}"; HOST="127.0.0.1"; JSON="false"
while [ $# -gt 0 ]; do
  case "$1" in
    --report-to) REPORT_TO="$2"; shift 2 ;;
    --spool) SPOOL="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    --json) JSON="true"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

RESULTS=""
FAILED=0

report() {   # component state detail
  RESULTS="$RESULTS$1=$2 "
  [ "$2" = "up" ] || FAILED=$((FAILED + 1))
  if [ "$JSON" != "true" ]; then printf '%-16s %-8s %s\n' "$1" "$2" "$3"; fi
  [ -n "$REPORT_TO" ] || return 0
  [ -n "${CRON_SECRET:-}" ] || return 0
  curl -sS -m 10 -X POST "$REPORT_TO/api/mailops/report" \
    -H "Authorization: Bearer $CRON_SECRET" -H 'Content-Type: application/json' \
    -d "{\"kind\":\"component\",\"component\":\"$1\",\"state\":\"$2\",\"detail\":\"$3\",\"reportedBy\":\"health-check.sh\"}" \
    >/dev/null 2>&1 || true
}

# A TCP connect, not a process check. Uses bash's /dev/tcp so nothing extra has to be installed on
# the mail host - nc and telnet are both absent from minimal images often enough to matter.
port_open() {   # host port
  timeout 5 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null
}

# -- MTA ------------------------------------------------------------------------------------
if port_open "$HOST" "$MX_PORT"; then report mta_in up "listening on $MX_PORT"
else report mta_in down "nothing accepting on port $MX_PORT - inbound mail is being refused and senders are queueing it"; fi

if port_open "$HOST" "$SUB_PORT"; then report mta_out up "submission listening on $SUB_PORT"
else report mta_out down "nothing accepting on submission port $SUB_PORT"; fi

if port_open "$HOST" "$IMAP_PORT"; then report dovecot up "IMAP listening on $IMAP_PORT"
else report dovecot down "nothing accepting on IMAP port $IMAP_PORT"; fi

# -- uplink ---------------------------------------------------------------------------------
# Port 25 outbound specifically, not a ping. Domestic and cloud providers block 25 while leaving
# everything else working, and that failure looks like "mail is broken" rather than "port blocked".
if timeout 8 bash -c 'exec 3<>/dev/tcp/aspmx.l.google.com/25' 2>/dev/null; then
  report internet up "outbound port 25 reaches a public MX"
elif timeout 5 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' 2>/dev/null; then
  report internet degraded "the uplink is up but outbound port 25 is blocked - direct-to-MX delivery cannot work, set MAIL_RELAY_HOST"
else
  report internet down "no outbound connectivity at all"
fi

# -- spool ----------------------------------------------------------------------------------
if [ -n "$SPOOL" ] && [ -d "$SPOOL" ]; then
  if [ -w "$SPOOL" ]; then
    QUEUED=$(find "$SPOOL/queued" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
    SENDING=$(find "$SPOOL/sending" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
    DEAD=$(find "$SPOOL/failed" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
    AVAIL=$(df -Pk "$SPOOL" 2>/dev/null | awk 'NR==2 {print int($4/1024)}')
    if [ "${AVAIL:-1024}" -lt 512 ]; then
      report spool degraded "only ${AVAIL}MB free - acceptance will start failing, which is correct but is an outage"
    else
      report spool up "${QUEUED} queued, ${SENDING} in flight, ${DEAD} dead-lettered, ${AVAIL}MB free"
    fi
  else
    report spool down "$SPOOL is not writable - the API must refuse to accept mail it cannot write down"
  fi
elif [ -n "$SPOOL" ]; then
  # A configured spool path that does not exist is NOT the same as no spool configured. The first
  # means the worker cannot accept mail; the second means this check was not told where to look.
  report spool down "$SPOOL does not exist - the worker cannot spool anything, so acceptance must be failing"
else
  report spool unknown "no spool directory given (--spool or MAIL_SPOOL_DIR), so nothing was checked"
fi

# -- the application ------------------------------------------------------------------------
if [ -n "$REPORT_TO" ]; then
  CODE=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "$REPORT_TO/api/health" 2>/dev/null || echo "000")
  case "$CODE" in
    200) report vercel up "application health returned 200" ;;
    503) report vercel degraded "application is up but reports 503 - usually the database" ;;
    000) report vercel down "application unreachable from the mail host" ;;
    *)   report vercel degraded "application health returned $CODE" ;;
  esac
fi

if [ "$JSON" = "true" ]; then echo "{\"results\":\"$RESULTS\",\"failed\":$FAILED}"; fi

if [ -z "$REPORT_TO" ]; then
  echo ""
  echo "Nothing was filed: pass --report-to <base-url> with CRON_SECRET set, or this check informs"
  echo "only the terminal it ran in."
elif [ -z "${CRON_SECRET:-}" ]; then
  echo ""
  echo "CRON_SECRET is not set, so nothing was filed and /admin/mail/continuity still shows these"
  echo "components as never reported." >&2
fi

exit $(( FAILED > 0 ? 1 : 0 ))
