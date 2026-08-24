// src/lib/manager-intelligence/schema.ts — THE THREE TABLES PATCH 14 OWNS, AND NOTHING ELSE.
//
// =================================================================================================
// WHAT IS HERE AND WHY IT IS ONLY THREE TABLES
// =================================================================================================
//
// This patch renders facts that eight other modules already own. It creates a table only where a
// manager's own act has no home anywhere else:
//
//   mti_manager_actions      APPEND-ONLY. One row per act: feedback given, a signal acknowledged, an
//                            intervention recorded, HR support requested, a development action set
//                            or moved. It carries the SIGNAL SNAPSHOT the manager was looking at, so
//                            "why did they do that" survives the numbers changing underneath it.
//   mti_development_actions  The tracked items. A status that moves, unlike the log above — and every
//                            move appends an mti_manager_actions row, so the TRAIL stays append-only
//                            even though the item does not.
//   mti_record_outbox        The durable half of the boundary to the central employee intelligence
//                            record. See record-port.ts.
//
// WHAT IS DELIBERATELY NOT HERE:
//   - No feedback table. hr_feedback exists and performance.ts owns it. Feedback written on this
//     screen is written THROUGH giveFeedback(), and mti_manager_actions holds only the pointer.
//   - No ticket table. helpdesk_tickets exists and helpdesk.ts owns it, with routing and an SLA.
//   - No employee, goal, review, task or attendance table. Every one of those already exists.
//
// =================================================================================================
// THE BOOTSTRAP DOES NOT RUN IN PRODUCTION, AND THAT IS THE PROJECT'S DECISION, NOT A BUG
// =================================================================================================
//
// src/lib/ensure-once.ts disables every self-bootstrap when NODE_ENV is production, after a cold
// deploy's DDL storm took the site down on 2026-08-23. So on the live database these tables are
// created by RUNNING db/manager-intelligence-schema.sql, which is the same statements in the same
// order. schemaState() below reads information_schema and REPORTS which of the three are missing,
// so the surfaces can say "this has not been created yet" instead of rendering an empty page that
// looks like an empty team.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureBatch, ensureOnce, guardedDdl } from '@/lib/ensure-once';

const MOD = 'manager-intelligence';

/** postgres-js resolves to a PLAIN ARRAY, never `{ rows }`. `r.rows[0]` is always a bug here. */
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** The real Postgres reason is on `e.cause`; `e.message` is only the SQL that failed. */
const logFail = (tag: string, e: any) =>
  console.error('[' + MOD + '] ' + tag, e?.cause?.message || e?.message || e);

export const MTI_TABLES = ['mti_manager_actions', 'mti_development_actions', 'mti_record_outbox'] as const;

/**
 * THE DDL, AS ONE STRING, SO IT CAN BE SHIPPED TWICE FROM ONE SOURCE.
 *
 * ensureBatch() sends it as one round trip in development, and scripts that need the file form print
 * it verbatim into db/manager-intelligence-schema.sql. Two hand-maintained copies of a schema is how
 * a table ends up existing in two shapes; there is one copy and it is this constant.
 *
 * NO FOREIGN KEYS TO hr_employees OR users. The hr_* tables in this repository do not use them
 * (see the note in employee-tasks.ts), and a record of what a manager did should outlive the
 * deletion of a row rather than vanish with it — that is the whole point of keeping it.
 */
export const MTI_DDL = `
CREATE TABLE IF NOT EXISTS mti_manager_actions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_employee_id  UUID NOT NULL,
  actor_user_id        UUID NOT NULL,
  actor_employee_id    UUID,
  kind                 TEXT NOT NULL,
  section              TEXT,
  signal_key           TEXT,
  signal_snapshot      JSONB NOT NULL DEFAULT '{}'::jsonb,
  record_ref           TEXT,
  note                 TEXT,
  visibility           TEXT NOT NULL DEFAULT 'manager_and_hr',
  authority_basis      TEXT NOT NULL DEFAULT 'unrecorded',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS mti_actions_subject_idx ON mti_manager_actions (subject_employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mti_actions_actor_idx ON mti_manager_actions (actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mti_actions_signal_idx ON mti_manager_actions (subject_employee_id, signal_key, created_at DESC);

CREATE TABLE IF NOT EXISTS mti_development_actions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id            UUID,
  subject_employee_id  UUID NOT NULL,
  created_by_user_id   UUID NOT NULL,
  title                TEXT NOT NULL,
  detail               TEXT,
  status               TEXT NOT NULL DEFAULT 'open',
  target_date          DATE,
  visible_to_employee  BOOLEAN NOT NULL DEFAULT TRUE,
  outcome_note         TEXT,
  closed_at            TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS mti_dev_subject_idx ON mti_development_actions (subject_employee_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS mti_dev_owner_idx ON mti_development_actions (created_by_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mti_record_outbox (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id     UUID NOT NULL,
  envelope      JSONB NOT NULL,
  attempts      INT NOT NULL DEFAULT 0,
  published_at  TIMESTAMPTZ,
  publish_error TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS mti_outbox_pending_idx ON mti_record_outbox (created_at) WHERE published_at IS NULL;
CREATE INDEX IF NOT EXISTS mti_outbox_action_idx ON mti_record_outbox (action_id);
`;

/**
 * THE APPEND-ONLY GUARANTEE ON mti_manager_actions, ATTEMPTED SEPARATELY AND REPORTED HONESTLY.
 *
 * A record of what a manager did about a colleague is worth nothing if it can be edited afterwards.
 * A trigger is the only place that guarantee can actually live — a convention in the writers is a
 * convention until somebody writes an UPDATE.
 *
 * It is its own call, not part of the batch above, for the reason ensureBatch() documents: a batch is
 * one transaction and rolls back whole, so a CREATE TRIGGER that fails on a database where the
 * function already exists in a different form would take the three tables down with it. Here it can
 * fail alone, and schemaState() REPORTS whether the guarantee is a database guarantee or only a
 * convention rather than assuming it took.
 */
const APPEND_ONLY_DDL = `
CREATE OR REPLACE FUNCTION mti_actions_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'mti_manager_actions is append-only: % is refused', TG_OP;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS mti_actions_no_change ON mti_manager_actions;
CREATE TRIGGER mti_actions_no_change
  BEFORE UPDATE OR DELETE ON mti_manager_actions
  FOR EACH ROW EXECUTE FUNCTION mti_actions_append_only();
`;

/** Create the tables. A no-op in production, where ensure-once refuses to run any bootstrap. */
export function ensureManagerIntelligenceSchema(): Promise<void> {
  return ensureBatch('mti_v1', MTI_DDL).then(() => ensureOnce('mti_v1_append_only', async () => {
    try {
      const { sqlClient } = await import('@/lib/db');
      // guardedDdl, LIKE EVERY OTHER .simple() BATCH IN THIS REPOSITORY. This was the one that sent
      // raw DDL, and of all of them it is the one that could least afford to.
      //
      // APPEND_ONLY_DDL ends in CREATE TRIGGER ... BEFORE UPDATE OR DELETE ON mti_manager_actions,
      // which takes an ACCESS EXCLUSIVE lock on that table. Without a lock_timeout it waits for as
      // long as any open reader holds it — and a PENDING exclusive lock queues AHEAD of new readers,
      // so every subsequent SELECT on the table stacks up behind it. That is not a hypothetical
      // shape: it is precisely the mechanism src/lib/ensure-once.ts records taking this site down on
      // 2026-08-23, which is why guardedDdl exists and why it is exported rather than private.
      //
      // It wraps the batch in BEGIN / SET LOCAL lock_timeout '3s' / SET LOCAL statement_timeout
      // '20s' / COMMIT, so a contended run gives up in three seconds instead of holding the table.
      // The catch below already treats a failed trigger as survivable — the tables work without it
      // and schemaState() reports appendOnlyEnforced:false in words — so giving up is the answer
      // this code was already written to accept.
      await sqlClient().unsafe(guardedDdl(APPEND_ONLY_DDL)).simple();
    } catch (e: any) {
      // Logged and swallowed on purpose: the tables are usable without the trigger, and refusing to
      // load the module because a guarantee could not be installed would take the whole surface down
      // over something schemaState() is about to report in words.
      logFail('append-only trigger', e);
    }
  }));
}

export interface MtiSchemaState {
  ok: boolean;
  /** Tables that exist, of MTI_TABLES. */
  present: string[];
  missing: string[];
  /** Is the append-only refusal a database guarantee, or only a convention in the writers? */
  appendOnlyEnforced: boolean;
  /** A sentence a surface prints verbatim when ok is false. */
  sentence: string;
}

const MISSING_SENTENCE =
  'The manager intelligence tables have not been created on this database yet. Schema bootstrap is '
  + 'switched off in production by design, so this is created by running db/manager-intelligence-schema.sql '
  + 'once. Until it has been, this page can record nothing — it is not that there is nothing to show.';

const UNREADABLE_SENTENCE =
  'We could not check whether the manager intelligence tables exist, so this is showing nothing rather '
  + 'than guessing. That is a statement about the database, not about this team.';

/**
 * WHAT IS ACTUALLY THERE, read from information_schema rather than assumed.
 *
 * ensureOnce() ends in a swallow: a resolved bootstrap proves the promise settled, not that any DDL
 * ran. Ten module tables were reported created on this project and none of them existed. So nothing
 * here trusts the ensure — it looks.
 */
export async function schemaState(): Promise<MtiSchemaState> {
  try {
    const found = rowsOf(await db.execute(sql`
      SELECT table_name
        FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('mti_manager_actions', 'mti_development_actions', 'mti_record_outbox')`))
      .map((r: any) => String(r.table_name));

    const present = MTI_TABLES.filter((t) => found.indexOf(t) >= 0);
    const missing = MTI_TABLES.filter((t) => found.indexOf(t) < 0);

    let appendOnlyEnforced = false;
    if (present.indexOf('mti_manager_actions') >= 0) {
      const trg = rowsOf(await db.execute(sql`
        SELECT 1 AS ok
          FROM pg_trigger
         WHERE tgname = 'mti_actions_no_change'
           AND NOT tgisinternal
         LIMIT 1`));
      appendOnlyEnforced = trg.length > 0;
    }

    return {
      ok: missing.length === 0,
      present: [...present],
      missing: [...missing],
      appendOnlyEnforced,
      sentence: missing.length === 0 ? '' : MISSING_SENTENCE,
    };
  } catch (e: any) {
    logFail('schemaState', e);
    return {
      ok: false,
      present: [],
      missing: [...MTI_TABLES],
      appendOnlyEnforced: false,
      sentence: UNREADABLE_SENTENCE,
    };
  }
}

/**
 * Ensure, then report.
 *
 * Every writer in write.ts starts here, so a write against a table that does not exist fails with
 * the sentence above rather than with a Postgres error nobody outside this repository can read.
 */
export async function readyState(): Promise<MtiSchemaState> {
  await ensureManagerIntelligenceSchema();
  return schemaState();
}
