// src/lib/horizon/intake/schema.ts — THE THREE TABLES PATCH 01 OWNS, AND NOTHING ELSE.
//
// ONE MODULE CREATES THESE TABLES. Not the page that happens to write one first, not each surface
// bootstrapping its own slice. This repository has already paid for the alternative: two
// `CREATE TABLE IF NOT EXISTS` statements for one table with DIFFERENT SHAPES, where whichever ran
// second was a silent no-op and half the columns simply never existed (db/hr-schema.sql:300).
//
// =================================================================================================
// WHY THESE TABLES AND NOT COLUMNS ON `applications`
// =================================================================================================
//
// `applications` already carries plaintext `dob`, `birth_time` and `birth_place`. Those columns stay
// EXACTLY as they are and this patch does not write, move, encrypt or deprecate them — among other
// things src/pages/api/auth/forgot-password.ts reads `applications.dob` to verify an account
// recovery, and src/lib/payment-effects.ts copies all three out of an intent. Breaking either is a
// sign-in outage, and this patch owns neither.
//
// What this patch stores is a DIFFERENT THING with a different lifetime and a different lawful
// basis: consent-controlled personal profile information about a PERSON, held encrypted, withdrawable
// on request, and surviving across the many applications one human may file. An application is an
// event; this is a property of the person. Two concepts, two tables — which is also why the key here
// is a SubjectRef and not an application id.
//
// =================================================================================================
// FOUR RULES, ALL OF THEM SCAR TISSUE FROM THIS CODEBASE
// =================================================================================================
//
//  1. NO FOREIGN KEY ON `subject_id`. Its target depends on `subject_id_scheme`: users.id,
//     tal_person.id or applications.id (see SUBJECT_ID_SCHEMES in src/lib/horizon/ids.ts). A
//     constraint cannot express that, and one pointed at the wrong table simply fails to create and
//     takes the whole bootstrap down with it. Indexes and application-level checks instead.
//  2. `organisation_id` IS TEXT and defaults to the constant in ids.ts. There is no organisation
//     table in this repository and this patch does not invent one.
//  3. THE ENSURE FAILS LOUDLY. ensureOnce drops a failed promise so the next call retries, and logs
//     e.cause — the real Postgres reason. A memoised, silently-resolved bootstrap over DDL that
//     never ran is how a write path went down here with nothing in the logs saying why.
//  4. IDEMPOTENT THROUGHOUT, and CREATE-ONLY. Nothing here drops, renames or retypes, so it is safe
//     to run against an environment that already has some of it.
//
// SAFE TO RUN ON PRODUCTION, AND NOT RUN FROM A DEVELOPMENT PROCESS. db/horizon-intake-schema.sql is
// the readable mirror an operator applies by hand — the established pattern in this project, because
// nothing here connects to the production database from a developer's machine.
//
// BATCHED IN ONE MESSAGE. ensureBatch sends the whole block as a single simple query: measured from
// the deployed function a round trip costs ~177ms, and these are all CREATEs on tables nothing else
// touches, so the lock warning in src/lib/ensure-once.ts (about ALTERs queueing ahead of readers on
// a hot table) does not apply.
import { ensureBatch } from '@/lib/ensure-once';

/** Bumped only when a statement is ADDED. Changing an existing statement needs a new key. */
const KEY = 'horizon_intake_v1';

/**
 * The DDL, verbatim.
 *
 * Exported so db/horizon-intake-schema.sql can be regenerated from the single source of truth and
 * so a test can assert the two have not drifted.
 */
export const HORIZON_INTAKE_DDL = `
-- =================================================================================================
-- hzn_consent_event — THE APPEND-ONLY CONSENT LEDGER
-- =================================================================================================
-- One row per act. Nothing updates or deletes a row here, including a withdrawal: a withdrawal is
-- ITSELF a row. Current state is derived by reading the most recent row for a subject and scope,
-- which is what makes "when did they agree, to what text, and from where" answerable years later.
CREATE TABLE IF NOT EXISTS hzn_consent_event (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id   TEXT NOT NULL DEFAULT 'org_edurankai',
  subject_kind      TEXT NOT NULL,
  subject_id_scheme TEXT NOT NULL,
  subject_id        TEXT NOT NULL,
  scope             TEXT NOT NULL,
  action            TEXT NOT NULL CHECK (action IN ('granted','withdrawn')),
  -- The version AND the hash of the exact notice text the person was shown. The hash is what makes
  -- an after-the-fact edit to shipped copy detectable instead of merely unlikely.
  notice_version    TEXT NOT NULL,
  notice_hash       TEXT NOT NULL,
  occurred_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Who performed the act. Normally the person themselves; a staff actor is recorded as such and
  -- never anonymised into "the system".
  actor_kind        TEXT,
  actor_id          TEXT,
  actor_name        TEXT,
  -- The surface it happened on, e.g. 'apply/step-1' or 'portal/personal-profile-data'.
  source            TEXT NOT NULL,
  ip_address        VARCHAR(64),
  user_agent        TEXT,
  reason            TEXT
);

CREATE INDEX IF NOT EXISTS hzn_consent_event_subject_idx
  ON hzn_consent_event (organisation_id, subject_kind, subject_id_scheme, subject_id, scope, occurred_at DESC);

CREATE INDEX IF NOT EXISTS hzn_consent_event_occurred_idx
  ON hzn_consent_event (occurred_at DESC);

-- =================================================================================================
-- hzn_personal_foundation — THE ENCRYPTED RECORD, ONE PER SUBJECT
-- =================================================================================================
-- SPLIT DELIBERATELY IN TWO HALVES:
--   payload_enc  every personal value — date, time, place, country, zone, coordinates — as one
--                AES-256-GCM envelope (src/lib/crypto). Reading it is an audited act.
--   everything   quality and lifecycle metadata ONLY. A status screen, an operator or a queue
--   else        planner reads these without decrypting anything and therefore without an audit row.
--                Nothing in this half narrows down who or where a person is.
CREATE TABLE IF NOT EXISTS hzn_personal_foundation (
  organisation_id   TEXT NOT NULL DEFAULT 'org_edurankai',
  subject_kind      TEXT NOT NULL,
  subject_id_scheme TEXT NOT NULL,
  subject_id        TEXT NOT NULL,

  processing_status TEXT NOT NULL DEFAULT 'captured',

  -- NULL once consent is withdrawn: the ciphertext is deleted and the row survives as the record
  -- THAT it was deleted. A missing row and a purged row are different facts.
  payload_enc       JSONB,
  key_id            TEXT,

  has_birth_time    BOOLEAN NOT NULL DEFAULT false,
  time_precision    TEXT,
  place_precision   TEXT,
  has_coordinates   BOOLEAN NOT NULL DEFAULT false,
  timezone_resolved BOOLEAN NOT NULL DEFAULT false,

  -- Keyed HMAC (never a bare hash: a date and a city are low-entropy and would be trivially
  -- brute-forced from a plain digest). Lets an engine skip work it has already done.
  input_hash        TEXT,

  consent_version   TEXT,
  consent_granted_at TIMESTAMPTZ,
  consent_ref       UUID,

  source            TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (organisation_id, subject_kind, subject_id_scheme, subject_id)
);

CREATE INDEX IF NOT EXISTS hzn_personal_foundation_status_idx
  ON hzn_personal_foundation (processing_status, updated_at DESC);

-- Rotation needs to find every row written under a retiring key without reading any plaintext.
CREATE INDEX IF NOT EXISTS hzn_personal_foundation_key_idx
  ON hzn_personal_foundation (key_id);

-- =================================================================================================
-- hzn_recompute_request — THE DURABLE HALF OF profile.recompute_requested
-- =================================================================================================
-- src/lib/events.ts is in-process, and on this platform the function can be frozen the instant the
-- response is written — so a bus emit alone has a window in which the data changed and no engine
-- ever hears about it. The row is written next to the fact that caused it; delivery and drain are a
-- separate, retryable pass. A request is a REQUEST: nothing here computes, and a consumer is free to
-- decide it is not worth acting on.
CREATE TABLE IF NOT EXISTS hzn_recompute_request (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id   TEXT NOT NULL DEFAULT 'org_edurankai',
  subject_kind      TEXT NOT NULL,
  subject_id_scheme TEXT NOT NULL,
  subject_id        TEXT NOT NULL,
  reason            TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','claimed','completed','failed','cancelled')),
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  input_hash        TEXT,
  correlation_id    TEXT,
  -- An applications.id OR an application_intents.id. Text, because the two live in different tables
  -- and a UUID column with no FK that sometimes points at one and sometimes at the other is a trap.
  application_ref   TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT
);

-- IDEMPOTENCE, ENFORCED BY THE DATABASE RATHER THAN BY THE CALLER. An applicant who re-walks the
-- form, or a retried request, must not pile up a queue of identical work. At most ONE pending
-- request per subject; a second ask updates the one that is already waiting.
CREATE UNIQUE INDEX IF NOT EXISTS hzn_recompute_request_pending_uq
  ON hzn_recompute_request (organisation_id, subject_kind, subject_id_scheme, subject_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS hzn_recompute_request_status_idx
  ON hzn_recompute_request (status, requested_at);
`;

/**
 * Create the three tables. Call at the top of any write path in this patch.
 *
 * Memoised per process by ensureOnce, and honours the SCHEMA_BOOTSTRAP=off kill switch like every
 * other bootstrap in this codebase.
 */
export function ensureHorizonIntakeSchema(): Promise<void> {
  return ensureBatch(KEY, HORIZON_INTAKE_DDL);
}
