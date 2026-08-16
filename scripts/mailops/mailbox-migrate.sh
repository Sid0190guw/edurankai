#!/usr/bin/env bash
# scripts/mailops/mailbox-migrate.sh - move mailboxes to a new host, and count what arrived.
#
# TWO MODES, AND THE ORDER MATTERS.
#   --mode bulk    a first full copy while the old host is still serving. It WILL be stale by the
#                  time it finishes. That is expected and is not a problem.
#   --mode delta   repeat until the difference is small enough that the final pass takes under a
#                  minute. The length of the final pass is the length of your cutover window.
#   --mode inventory  count what is actually there, on either side, into a JSON file for
#                  migration-report.ts. Counting is a separate act from copying, deliberately:
#                  "rsync exited 0" is a statement about rsync, not about the target.
#
# TWO TRANSPORTS.
#   rsync      file-level, fast, preserves the maildir exactly. Needs filesystem access to both.
#   imapsync   protocol-level, slower, works between hosts that share nothing but IMAP. Preserves
#              flags and folders because IMAP has words for them. Not installed by default and this
#              script does not install it.
#
# FLAGS AND FOLDERS ARE THE THINGS THAT GET LOST. A copy that moves every message and drops the
# \Seen flags looks complete and is not: the user opens their mail and everything is unread. That
# is why the inventory counts flags and folders separately from messages, and why the cutover gate
# in src/lib/mailops/migration.ts refuses on a folder shortfall.
set -euo pipefail

MODE=""; SRC=""; DST=""; OUT=""; LABEL=""; DRY="false"; TRANSPORT="rsync"
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --source) SRC="$2"; shift 2 ;;
    --target) DST="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --transport) TRANSPORT="$2"; shift 2 ;;
    --dry-run) DRY="true"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$MODE" in
  bulk|delta)
    [ -n "$SRC" ] && [ -n "$DST" ] || { echo "--source and --target are required for $MODE" >&2; exit 2; }
    case "$TRANSPORT" in
      rsync)
        command -v rsync >/dev/null || { echo "rsync is not installed." >&2; exit 2; }
        # -a preserves times and permissions; maildir filenames carry the flags, so preserving the
        # NAME is what preserves \Seen and \Flagged. --delete only on the delta pass, and only
        # after a bulk pass has succeeded, or an interrupted first copy deletes on the target.
        EXTRA=""
        [ "$MODE" = "delta" ] && EXTRA="--delete"
        [ "$DRY" = "true" ] && EXTRA="$EXTRA --dry-run"
        echo "rsync $MODE: $SRC -> $DST $EXTRA"
        # shellcheck disable=SC2086
        rsync -a --numeric-ids --info=stats2 $EXTRA "$SRC/" "$DST/"
        ;;
      imapsync)
        command -v imapsync >/dev/null || {
          echo "imapsync is not installed. It is the right tool when the two hosts share nothing but IMAP;" >&2
          echo "install it deliberately rather than having a migration script install software." >&2
          exit 2; }
        echo "imapsync expects per-account credentials. Run it per mailbox:" >&2
        echo "  imapsync --host1 OLD --user1 U --password1 P --host2 NEW --user2 U --password2 P --dry" >&2
        exit 2
        ;;
      *) echo "unknown --transport: $TRANSPORT" >&2; exit 2 ;;
    esac
    echo ""
    echo "Copy finished. That is NOT verification. Take an inventory on both sides and compare:"
    echo "  $0 --mode inventory --source $SRC --out inv-source.json --label 'old host'"
    echo "  $0 --mode inventory --source $DST --out inv-target.json --label 'new host'"
    echo "  npx tsx scripts/mailops/migration-report.ts --source inv-source.json --target inv-target.json --migration zbook-to-dedicated"
    ;;

  inventory)
    [ -n "$SRC" ] || { echo "--source <maildir-root> is required" >&2; exit 2; }
    [ -n "$OUT" ] || { echo "--out <file.json> is required" >&2; exit 2; }
    [ -d "$SRC" ] || { echo "No such directory: $SRC" >&2; exit 2; }
    [ -n "$LABEL" ] || LABEL="$SRC"

    # Maildir counting rules, and they are not obvious:
    #   cur/ + new/  are messages. tmp/ is not - it is delivery in progress.
    #   A message in cur/ whose filename flags contain S has been read.
    #   A folder is any directory containing a cur/, which is what makes .Sent and .Archive count
    #   and stops a stray directory from doing so.
    MESSAGES=$(find "$SRC" -type f -path '*/cur/*' -o -type f -path '*/new/*' 2>/dev/null | wc -l | tr -d ' ')
    FOLDERS=$(find "$SRC" -type d -name cur 2>/dev/null | wc -l | tr -d ' ')
    SEEN=$(find "$SRC" -type f -path '*/cur/*' -name '*:2,*S*' 2>/dev/null | wc -l | tr -d ' ')
    MAILBOXES=$(find "$SRC" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
    BYTES=$(find "$SRC" -type f \( -path '*/cur/*' -o -path '*/new/*' \) -printf '%s\n' 2>/dev/null | awk '{t+=$1} END {print t+0}')

    {
      echo "{"
      echo "  \"label\": \"$LABEL\","
      echo "  \"takenAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
      echo "  \"counts\": {"
      echo "    \"messages\": $MESSAGES,"
      echo "    \"mailboxes\": $MAILBOXES,"
      echo "    \"folders\": $FOLDERS,"
      echo "    \"flags\": $SEEN,"
      echo "    \"bytes\": $BYTES"
      echo "  },"
      echo "  \"perMailbox\": {"
      FIRST=true
      for d in "$SRC"/*/; do
        [ -d "$d" ] || continue
        NAME=$(basename "$d")
        M=$(find "$d" -type f \( -path '*/cur/*' -o -path '*/new/*' \) 2>/dev/null | wc -l | tr -d ' ')
        F=$(find "$d" -type d -name cur 2>/dev/null | wc -l | tr -d ' ')
        [ "$FIRST" = "true" ] || echo ","
        FIRST=false
        printf '    "%s": { "messages": %s, "folders": %s }' "$NAME" "$M" "$F"
      done
      echo ""
      echo "  }"
      echo "}"
    } > "$OUT"

    echo "Wrote $OUT"
    echo "  messages=$MESSAGES  mailboxes=$MAILBOXES  folders=$FOLDERS  read-flags=$SEEN  bytes=$BYTES"
    if [ "$MESSAGES" -eq 0 ]; then
      echo "  WARNING: zero messages counted. Either this is not a maildir root, or the copy has not run." >&2
      echo "  An inventory of zero compared against another inventory of zero PASSES, and proves nothing." >&2
    fi
    ;;

  *)
    echo "Usage: $0 --mode <bulk|delta|inventory> [--source ...] [--target ...] [--out ...] [--label ...] [--dry-run]" >&2
    exit 2
    ;;
esac
