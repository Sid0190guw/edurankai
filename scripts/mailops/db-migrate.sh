#!/usr/bin/env bash
# scripts/mailops/db-migrate.sh - Supabase -> self-hosted PostgreSQL, in stages that can be stopped.
#
# THE FACT THAT SHAPES THIS ENTIRE MIGRATION: the schema is not in this repository. There is no
# migration history, and DDL self-bootstraps with CREATE TABLE IF NOT EXISTS scattered across
# application modules. No file here reconstructs the live schema - only a dump does. A hand-built
# target schema WILL be subtly wrong, and the wrongness will be a default or a constraint nobody
# looks at until it rejects a row six weeks later.
#
# STAGES, EACH SEPARATELY RUNNABLE:
#   --stage schema     structure only. Fails fast and cheaply if the target cannot take it.
#   --stage data       contents. The long one.
#   --stage inventory  count both sides into JSON for migration-report.ts.
#   --stage cutover    prints the checklist. Changes nothing - the repoint is a deploy, not a script.
#
# IT NEVER DROPS THE SOURCE. Nothing here can. The source is opened read-only by pg_dump and there
# is no code path that deletes anything anywhere.
set -euo pipefail

STAGE=""; TARGET=""; OUT=""; LABEL=""; JOBS="4"
while [ $# -gt 0 ]; do
  case "$1" in
    --stage) STAGE="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --jobs) JOBS="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

need_source() {
  [ -n "${DATABASE_URL_DIRECT:-}" ] || {
    echo "DATABASE_URL_DIRECT is not set. Export the DIRECT (session, :5432) string for this shell only." >&2
    echo "The transaction pooler on :6543 cannot hold the session pg_dump needs." >&2; exit 2; }
  case "$DATABASE_URL_DIRECT" in *:6543/*) echo "That is the pooler. Use the :5432 direct connection." >&2; exit 2 ;; esac
}
need_target() {
  [ -n "$TARGET" ] || { echo "--target <connection-string> is required" >&2; exit 2; }
  if [ -n "${DATABASE_URL:-}" ] && [ "$TARGET" = "$DATABASE_URL" ]; then
    echo "REFUSING: --target is the live DATABASE_URL." >&2; exit 2; fi
  case "$TARGET" in *pooler.supabase.com*) echo "REFUSING: --target points back at the source provider." >&2; exit 2 ;; esac
}

case "$STAGE" in
  schema)
    need_source; need_target
    command -v pg_dump >/dev/null && command -v psql >/dev/null || { echo "pg_dump and psql are required." >&2; exit 2; }
    echo "Comparing server versions first - the dump client must be at least the server major."
    psql "$DATABASE_URL_DIRECT" -tA -c 'SELECT version()' | head -1
    psql "$TARGET"              -tA -c 'SELECT version()' | head -1
    echo ""
    echo "Dumping schema ..."
    pg_dump "$DATABASE_URL_DIRECT" --schema-only --no-owner --no-privileges > /tmp/era-schema.sql
    echo "Applying to the target ..."
    # ON_ERROR_STOP so a failed CREATE does not scroll past and leave a target that is 90% right.
    psql "$TARGET" -v ON_ERROR_STOP=1 -f /tmp/era-schema.sql
    echo ""
    echo "Schema applied. Count the tables on both sides before going further:"
    echo "  source: $(psql "$DATABASE_URL_DIRECT" -tA -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
    echo "  target: $(psql "$TARGET" -tA -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
    rm -f /tmp/era-schema.sql
    ;;

  data)
    need_source; need_target
    echo "Dumping and restoring data. This is the long stage; it can be re-run."
    # --data-only with --disable-triggers so foreign keys do not force a load order that does not
    # exist. Directory format so -j actually parallelises.
    TMPDIR_D="$(mktemp -d)"
    pg_dump "$DATABASE_URL_DIRECT" --data-only --no-owner --no-privileges --format=directory --jobs="$JOBS" --file="$TMPDIR_D/data"
    pg_restore --dbname="$TARGET" --data-only --disable-triggers --no-owner --jobs="$JOBS" "$TMPDIR_D/data"
    rm -rf "$TMPDIR_D"
    echo ""
    echo "Data loaded. Now count, on both sides, independently:"
    echo "  $0 --stage inventory --target '<source-url>' --out inv-src.json --label source"
    echo "  $0 --stage inventory --target '<target-url>' --out inv-dst.json --label target"
    ;;

  inventory)
    [ -n "$TARGET" ] || { echo "--target <connection-string to count> is required" >&2; exit 2; }
    [ -n "$OUT" ] || { echo "--out <file.json> is required" >&2; exit 2; }
    [ -n "$LABEL" ] || LABEL="$TARGET"
    q() { psql "$TARGET" -tA -c "$1" 2>/dev/null | tr -d ' ' || echo 0; }
    MESSAGES=$(q "SELECT count(*) FROM mail_messages")
    MAILBOXES=$(q "SELECT count(DISTINCT user_id) FROM mail_box")
    CONTACTS=$(q "SELECT count(*) FROM mail_contacts")
    TEMPLATES=$(q "SELECT count(*) FROM mail_templates")
    EVENTS=$(q "SELECT count(*) FROM email_logs")
    ATTACH=$(q "SELECT count(*) FROM mail_attachments")
    cat > "$OUT" <<JSON
{
  "label": "$LABEL",
  "takenAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "counts": {
    "messages": ${MESSAGES:-0},
    "mailboxes": ${MAILBOXES:-0},
    "contacts": ${CONTACTS:-0},
    "templates": ${TEMPLATES:-0},
    "delivery_events": ${EVENTS:-0},
    "attachments": ${ATTACH:-0}
  }
}
JSON
    echo "Wrote $OUT"
    cat "$OUT"
    echo ""
    echo "A table that does not exist counts as 0 here and will compare as a match against another 0."
    echo "Check the numbers against what you expect before trusting the comparison."
    ;;

  cutover)
    cat <<'TXT'
CUTOVER CHECKLIST - nothing here is automated, and the order is not interchangeable.

  1. Freeze writes. Without a freeze the final sync is incomplete and the last few seconds of
     writes are lost silently. On this stack that means putting the app into maintenance or
     stopping the deployment.
  2. Final data sync (--stage data again; it is re-runnable).
  3. Inventory both sides and run the report:
       npx tsx scripts/mailops/migration-report.ts --source inv-src.json --target inv-dst.json \
         --migration supabase-to-selfhosted-pg
     The report must PASS. It gates on messages, mailboxes, contacts, campaigns, templates,
     domains, delivery events and automations.
  4. Confirm encrypted columns still decrypt on the target, using the escrowed key. A restore that
     carries ciphertext but not the key is a database of unreadable columns and it looks fine.
  5. Repoint DATABASE_URL and redeploy. Confirm the deploy actually promoted - pushed is not live.
  6. Keep the SOURCE RUNNING AND READABLE for the soak period (30 days for this migration). A
     readable source is how a missing row gets recovered; a deleted one is how it does not.

ROLLBACK WINDOW. Repointing DATABASE_URL back is only valid before the first write lands on the
new database. After that, rolling back loses those writes. State that window in minutes and decide
in advance who is allowed to call it.
TXT
    ;;

  *)
    echo "Usage: $0 --stage <schema|data|inventory|cutover> [--target ...] [--out ...] [--label ...]" >&2
    exit 2 ;;
esac
