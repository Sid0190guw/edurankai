#!/usr/bin/env bash
# scripts/mailops/storage-migrate.sh - attachments and raw MIME to an S3-compatible bucket.
#
# THE ONE RULE: PRESERVE THE KEY EXACTLY. Objects are referenced by key from database rows. If the
# copy "tidies" the prefix structure, every existing reference breaks, and the breakage is invisible
# until somebody opens an old message. Do not rename during a migration; do it afterwards, with a
# rewrite of the references, or not at all.
#
# ENABLE VERSIONING ON THE TARGET BEFORE COPYING. It is far easier at creation than later, and it
# is the single cheapest protection available to this system - today there is exactly one copy of
# every attachment, with no versioning and no second bucket.
#
#   ./scripts/mailops/storage-migrate.sh --source s3://old-bucket --target s3://new-bucket --dry-run
#   ./scripts/mailops/storage-migrate.sh --source s3://old-bucket --target s3://new-bucket --verify
#
# Endpoints and credentials come from the environment (AWS_* / the S3_* set the app already uses),
# never from arguments - an argument ends up in shell history and in the process list.
set -euo pipefail

SRC=""; DST=""; DRY="false"; VERIFY="false"; ENDPOINT="${S3_ENDPOINT:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --source) SRC="$2"; shift 2 ;;
    --target) DST="$2"; shift 2 ;;
    --endpoint) ENDPOINT="$2"; shift 2 ;;
    --dry-run) DRY="true"; shift ;;
    --verify) VERIFY="true"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$SRC" ] && [ -n "$DST" ] || { echo "--source and --target are required (s3://bucket[/prefix])" >&2; exit 2; }
command -v aws >/dev/null || {
  echo "The AWS CLI is not installed. Any S3-compatible client will do; this script uses 'aws s3'" >&2
  echo "because it speaks to every S3-compatible endpoint with --endpoint-url." >&2; exit 2; }

EP=""
[ -n "$ENDPOINT" ] && EP="--endpoint-url $ENDPOINT"

if [ "$VERIFY" = "true" ]; then
  echo "Counting both sides. Counting is a separate act from copying: a sync that exits 0 is a"
  echo "statement about the sync, not about what is in the target."
  # shellcheck disable=SC2086
  SRC_N=$(aws s3 ls "$SRC" --recursive $EP | wc -l | tr -d ' ')
  # shellcheck disable=SC2086
  DST_N=$(aws s3 ls "$DST" --recursive $EP | wc -l | tr -d ' ')
  # shellcheck disable=SC2086
  SRC_B=$(aws s3 ls "$SRC" --recursive $EP | awk '{t+=$3} END {print t+0}')
  # shellcheck disable=SC2086
  DST_B=$(aws s3 ls "$DST" --recursive $EP | awk '{t+=$3} END {print t+0}')
  echo "  source: $SRC_N objects, $SRC_B bytes"
  echo "  target: $DST_N objects, $DST_B bytes"
  cat > storage-inventory-source.json <<JSON
{ "label": "$SRC", "takenAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)", "counts": { "objects": $SRC_N, "bytes": $SRC_B } }
JSON
  cat > storage-inventory-target.json <<JSON
{ "label": "$DST", "takenAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)", "counts": { "objects": $DST_N, "bytes": $DST_B } }
JSON
  echo ""
  echo "Wrote storage-inventory-source.json and storage-inventory-target.json. Compare them:"
  echo "  npx tsx scripts/mailops/migration-report.ts --source storage-inventory-source.json \\"
  echo "      --target storage-inventory-target.json --migration supabase-storage-to-s3"
  echo ""
  echo "Object count and total bytes agreeing does NOT prove content. Checksum a sample as well -"
  echo "a truncated object still counts as one object."
  exit 0
fi

FLAGS="--no-progress"
[ "$DRY" = "true" ] && FLAGS="$FLAGS --dryrun"
echo "Syncing $SRC -> $DST${DRY:+ (dry run)}"
echo "Keys are preserved exactly. Nothing is deleted on either side: no --delete, deliberately."
# shellcheck disable=SC2086
aws s3 sync "$SRC" "$DST" $FLAGS $EP

if [ "$DRY" = "true" ]; then
  echo ""
  echo "Dry run only. Nothing was copied."
else
  echo ""
  echo "Copy finished. Now verify, and do not cut over until you have:"
  echo "  $0 --source $SRC --target $DST --verify"
  echo ""
  echo "Cutover is setting the four S3_* variables and redeploying. Afterwards, open several OLD"
  echo "messages with attachments - new uploads working proves the write path, not the migration."
fi
