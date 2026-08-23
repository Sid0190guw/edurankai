// src/lib/horizon/intake/foundation.ts — THE SECURE STORAGE BOUNDARY.
//
// =================================================================================================
// EVERY PATH TO THIS DATA GOES THROUGH THIS FILE
// =================================================================================================
//
// Nothing outside this module reads `hzn_personal_foundation.payload_enc`, and nothing outside it
// writes one. That is what makes four guarantees checkable instead of aspirational:
//
//   ENCRYPTED AT REST   the personal values are one AES-256-GCM envelope (src/lib/crypto), bound by
//                       AAD to the subject they belong to, so a row copied onto another subject
//                       fails to decrypt rather than quietly describing the wrong person.
//   CONSENT-GATED       storePersonalFoundation() refuses without a recorded grant.
//                       readPersonalFoundation() refuses once it is withdrawn.
//   PURPOSE-LIMITED     every read declares WHY, from a closed list, and the reason a caller gives
//                       decides what it is allowed to be.
//   ACCESS-LOGGED       an audit row is written BEFORE a value is returned, and a read whose audit
//                       write fails still records the failure rather than proceeding in silence.
//
// =================================================================================================
// IT FAILS CLOSED, AND IT SAYS SO
// =================================================================================================
//
// A deployment with no key material cannot store this data. The honest outcome is a REFUSAL with a
// status the operator can see — `blocked_encryption_unavailable` — not a quiet fallback to plaintext
// and not a swallowed exception. src/lib/crypto/keys.ts throws when DATA_ENCRYPTION_KEY_<id> is
// unset; encryptionAvailable() turns that into a question a page can ask before it offers the form
// at all, so nobody types their date of birth into a field that was never going to keep it.
//
// =================================================================================================
// WHAT IS DELIBERATELY NOT ENCRYPTED
// =================================================================================================
//
// The quality and lifecycle columns: status, whether a time was given and how precisely, whether a
// place resolved, whether a zone was found, which key the row is under, the consent version, the
// timestamps. None of them narrows down who or where a person is, all of them are needed to run the
// system, and keeping them readable means a status screen, a queue planner and a key rotation do
// their jobs WITHOUT decrypting anything — which is the single biggest reduction in how often this
// data is touched at all.
import { sql } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import { activeKeyId, decryptField, encryptField, getKeyMaterial } from '@/lib/crypto';
import { subjectKey, type ActorRef, type SubjectRef, isSubjectRef } from '@/lib/horizon/ids';
import { canonicalInputJson, parseCanonicalInputJson } from './birth-input';
import { currentConsent } from './consent';
import { ensureHorizonIntakeSchema } from './schema';
import {
  CONSENT_SCOPE_PERSONAL_FOUNDATION,
  HORIZON_FOUNDATION_READ,
  READ_PURPOSES,
  reasonOf,
  rowsOf,
  type FoundationHoldings,
  type PersonalFoundationInput,
  type PlacePrecision,
  type ProcessingStatus,
  type ReadActor,
  type ReadPurpose,
  type ReadResult,
  type StoreOutcome,
  type TimePrecision,
} from './types';

// -------------------------------------------------------------------------------------------------
// MODULE CONSTANTS — before anything that reads them.
// -------------------------------------------------------------------------------------------------

/** Bound into the AAD and the hash label, so a format change cannot be confused with a data change. */
const PAYLOAD_VERSION = 'v1';

/** Audit actions. Written exactly as here, so /admin/audit can facet on them. */
const AUDIT_READ = 'horizon.foundation.read';
const AUDIT_STORE = 'horizon.foundation.store';
const AUDIT_PURGE = 'horizon.foundation.purge';
const AUDIT_ENTITY = 'hzn_personal_foundation';

let _db: any = null;
async function database(): Promise<any> {
  if (!_db) _db = (await import('@/lib/db')).db;
  return _db;
}

// -------------------------------------------------------------------------------------------------
// ENCRYPTION
// -------------------------------------------------------------------------------------------------

/**
 * Can this deployment actually keep this data?
 *
 * Asked BEFORE the form is offered, not after it is filled in. getKeyMaterial() throws when the key
 * is unset or the wrong length; that is the whole check, and it is cheap enough to call per request.
 */
export function encryptionAvailable(): boolean {
  try {
    getKeyMaterial(activeKeyId());
    return true;
  } catch {
    return false;
  }
}

/**
 * WHY THE CRYPTO IMPORT IS STATIC while the database one is lazy: src/lib/crypto reads env vars and
 * node:crypto and touches no connection, so importing it costs nothing and cannot throw at load.
 * That is what lets encryptionAvailable() be SYNCHRONOUS, which in turn lets an .astro page decide
 * whether to render the section at all without an extra await in its frontmatter.
 */

/**
 * The HMAC key for the change hash, derived from the data key rather than reusing it.
 *
 * WHY A KEYED HASH AT ALL. A bare SHA-256 of "1994-06-12 / Nagpur / India" is not a one-way function
 * in any useful sense: the input space is small enough to enumerate, so a plain digest would let
 * anybody holding the metadata half of the table confirm a guess about somebody's birth. The hash
 * exists only so an engine can tell "this changed" from "this did not", and a keyed one does that
 * job without also being an oracle.
 */
function inputHashKey(): Buffer {
  return createHmac('sha256', getKeyMaterial(activeKeyId()))
    .update('hzn:foundation:input-hash:' + PAYLOAD_VERSION)
    .digest();
}

/** PURE given a key. The change hash for a validated block. */
function computeInputHash(input: PersonalFoundationInput): string {
  return createHmac('sha256', inputHashKey())
    .update(canonicalInputJson(input), 'utf8')
    .digest('hex');
}

/**
 * Additional authenticated data: the subject this ciphertext belongs to.
 *
 * GCM verifies it on decrypt, so a payload moved to another subject's row throws instead of
 * describing the wrong person under the right name — which is the failure mode that would be
 * hardest to ever notice.
 */
function aadFor(subject: SubjectRef): string {
  return 'hzn:foundation:' + PAYLOAD_VERSION + ':' + subjectKey(subject);
}

// -------------------------------------------------------------------------------------------------
// ROW MAPPING
// -------------------------------------------------------------------------------------------------

interface FoundationRow {
  organisation_id: string;
  subject_kind: string;
  subject_id_scheme: string;
  subject_id: string;
  processing_status: string;
  payload_enc: any;
  key_id: string | null;
  has_birth_time: boolean;
  time_precision: string | null;
  place_precision: string | null;
  has_coordinates: boolean;
  timezone_resolved: boolean;
  input_hash: string | null;
  consent_version: string | null;
  consent_granted_at: string | Date | null;
  consent_ref: string | null;
  source: string | null;
  created_at: string | Date | null;
  updated_at: string | Date | null;
}

function iso(v: string | Date | null | undefined): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function toHoldings(r: FoundationRow): FoundationHoldings {
  return {
    subject: {
      kind: r.subject_kind as SubjectRef['kind'],
      id: String(r.subject_id),
      idScheme: r.subject_id_scheme as SubjectRef['idScheme'],
      organisationId: String(r.organisation_id),
    },
    processingStatus: r.processing_status as ProcessingStatus,
    hasStoredData: !!r.payload_enc,
    hasBirthTime: !!r.has_birth_time,
    timePrecision: (r.time_precision as TimePrecision) || null,
    placePrecision: (r.place_precision as PlacePrecision) || null,
    hasCoordinates: !!r.has_coordinates,
    timezoneResolved: !!r.timezone_resolved,
    consentVersion: r.consent_version,
    consentGrantedAt: iso(r.consent_granted_at),
    keyId: r.key_id,
    source: r.source,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

// -------------------------------------------------------------------------------------------------
// AUDIT
// -------------------------------------------------------------------------------------------------

/**
 * Write the access record.
 *
 * `diff` carries the PURPOSE and the ACTOR, never a value. src/lib/audit.ts already declines to
 * forward diffs into the error log for exactly this reason; the same discipline applies at the
 * source.
 *
 * Returns whether the row landed. Callers that must fail closed check it — see readPersonalFoundation.
 */
async function audit(
  action: string,
  subject: SubjectRef,
  actor: ReadActor,
  detail: Record<string, unknown>,
): Promise<boolean> {
  try {
    const { logAudit } = await import('@/lib/audit');
    const r = await logAudit({
      userId: actor.userId || null,
      action,
      entity: AUDIT_ENTITY,
      entityId: subjectKey(subject),
      diff: { ...detail, actorService: actor.service || null },
      ipAddress: actor.ipAddress || undefined,
    });
    return !!r?.ok;
  } catch (e: any) {
    console.error('[horizon/foundation] audit write threw:', reasonOf(e));
    return false;
  }
}

/**
 * Narrow an ActorRef down to what the audit log can actually store.
 *
 * `audit_log.user_id` is a UUID with a foreign key to `users`. An ActorRef of kind `system`, `engine`
 * or `integration` carries an id like 'horizon' — writing that into the column fails the constraint
 * and loses the whole audit row, so those actors are recorded with a NULL user and their identity
 * kept in the diff instead. An `employee` id is hr_employees.id, which is also not users.id.
 */
function actorAsReader(actor: ActorRef | null | undefined, ipAddress?: string | null): ReadActor {
  return {
    userId: actor && actor.kind === 'user' ? actor.id : null,
    service: actor && actor.kind !== 'user' ? actor.kind + ':' + actor.id : null,
    ipAddress: ipAddress || null,
  };
}

// -------------------------------------------------------------------------------------------------
// WRITE
// -------------------------------------------------------------------------------------------------

export interface StoreArgs {
  subject: SubjectRef;
  /** Already validated by validateFoundationSubmission(). This function does not re-parse a form. */
  input: PersonalFoundationInput;
  actor: ActorRef | null;
  /** The surface, e.g. 'apply/step-1'. */
  source: string;
  ipAddress?: string | null;
}

/**
 * Store a validated block, encrypted, for a subject who has consented.
 *
 * ORDER MATTERS AND IS NOT NEGOTIABLE:
 *   1. consent is read FIRST and the write is refused without a live grant;
 *   2. encryption is attempted, and a missing key is a refusal with a visible status, never a
 *      plaintext fallback;
 *   3. only then is anything written.
 *
 * `changed` reports whether the content actually differs from what was already held, so a caller can
 * decide whether a recomputation is worth asking for. Re-walking the application form with the same
 * answers should not queue work.
 */
export async function storePersonalFoundation(args: StoreArgs): Promise<StoreOutcome> {
  const { subject, input } = args;
  if (!isSubjectRef(subject)) {
    return { ok: false, reason: 'invalid-input', message: 'Not a valid subject reference.' };
  }

  const consent = await currentConsent(subject, CONSENT_SCOPE_PERSONAL_FOUNDATION);
  if (!consent.granted) {
    return {
      ok: false,
      reason: 'no-consent',
      message: 'Nothing was stored: this person has not authorised it.',
    };
  }

  if (!encryptionAvailable()) {
    // RECORDED, not swallowed. The operator needs to see that somebody filled this in and it could
    // not be kept, and the person needs to be told rather than thanked for nothing.
    await markProcessingStatus(subject, 'blocked_encryption_unavailable', args.source).catch(() => {});
    return {
      ok: false,
      reason: 'encryption-unavailable',
      message: 'Nothing was stored: secure storage is not configured on this deployment.',
    };
  }

  try {
    await ensureHorizonIntakeSchema();
    const json = canonicalInputJson(input);
    const hash = computeInputHash(input);
    const envelope = encryptField(json, aadFor(subject));
    const keyId = activeKeyId();
    const db = await database();

    // A CTE, NOT `RETURNING (input_hash IS DISTINCT FROM ...)`. RETURNING on an ON CONFLICT DO UPDATE
    // reports the NEW row, so comparing there would compare the hash with itself and answer "never
    // changed" every time. `prev` reads the row under the statement's own snapshot, which is the
    // state BEFORE this insert, and that is the comparison actually wanted. One round trip either way.
    const res = await db.execute(sql`
      WITH prev AS (
        SELECT input_hash FROM hzn_personal_foundation
        WHERE organisation_id = ${subject.organisationId}
          AND subject_kind = ${subject.kind}
          AND subject_id_scheme = ${subject.idScheme}
          AND subject_id = ${subject.id}
      ),
      upserted AS (
      INSERT INTO hzn_personal_foundation (
        organisation_id, subject_kind, subject_id_scheme, subject_id,
        processing_status, payload_enc, key_id,
        has_birth_time, time_precision, place_precision, has_coordinates, timezone_resolved,
        input_hash, consent_version, consent_granted_at, consent_ref, source, updated_at
      ) VALUES (
        ${subject.organisationId}, ${subject.kind}, ${subject.idScheme}, ${subject.id},
        'captured', ${JSON.stringify(envelope)}::jsonb, ${keyId},
        ${!!input.timeOfBirth}, ${input.timePrecision}, ${input.place.precision},
        ${!!input.coordinates}, ${!!input.timezoneId},
        ${hash}, ${consent.noticeVersion}, ${consent.grantedAt}, ${consent.consentRef},
        ${String(args.source || 'unknown').slice(0, 80)}, NOW()
      )
      ON CONFLICT (organisation_id, subject_kind, subject_id_scheme, subject_id) DO UPDATE SET
        processing_status  = 'captured',
        payload_enc        = EXCLUDED.payload_enc,
        key_id             = EXCLUDED.key_id,
        has_birth_time     = EXCLUDED.has_birth_time,
        time_precision     = EXCLUDED.time_precision,
        place_precision    = EXCLUDED.place_precision,
        has_coordinates    = EXCLUDED.has_coordinates,
        timezone_resolved  = EXCLUDED.timezone_resolved,
        input_hash         = EXCLUDED.input_hash,
        consent_version    = EXCLUDED.consent_version,
        consent_granted_at = EXCLUDED.consent_granted_at,
        consent_ref        = EXCLUDED.consent_ref,
        source             = EXCLUDED.source,
        updated_at         = NOW()
      RETURNING *
      )
      SELECT u.*, ((SELECT input_hash FROM prev) IS DISTINCT FROM ${hash}) AS was_different
      FROM upserted u
    `);

    const row = rowsOf(res)[0] as (FoundationRow & { was_different?: boolean }) | undefined;
    if (!row) {
      return { ok: false, reason: 'storage-error', message: 'The record could not be written.' };
    }

    // A WRITE IS AUDITED TOO. Not only reads: "when did this person's held information last change,
    // and from which surface" is a question a data-subject request asks directly.
    await audit(AUDIT_STORE, subject, actorAsReader(args.actor, args.ipAddress), {
      source: args.source,
      consentVersion: consent.noticeVersion,
      timePrecision: input.timePrecision,
      placePrecision: input.place.precision,
      timezoneResolved: !!input.timezoneId,
    });

    return {
      ok: true,
      holdings: toHoldings(row),
      // On a first insert `prev` is empty, so the scalar subquery is NULL, which IS DISTINCT FROM the
      // new hash — a brand-new record correctly counts as a change.
      changed: row.was_different !== false,
      inputHash: hash,
    };
  } catch (e: any) {
    console.error('[horizon/foundation] store failed:', reasonOf(e));
    return { ok: false, reason: 'storage-error', message: 'The record could not be written.' };
  }
}

/**
 * Move the lifecycle status without touching the payload.
 *
 * Used when a recomputation is asked for and when encryption turns out to be unavailable. Never used
 * to express a decision about a person: the status describes this ROW, nothing else.
 */
export async function markProcessingStatus(
  subject: SubjectRef,
  status: ProcessingStatus,
  source?: string,
): Promise<boolean> {
  if (!isSubjectRef(subject)) return false;
  try {
    await ensureHorizonIntakeSchema();
    const db = await database();
    const res = await db.execute(sql`
      INSERT INTO hzn_personal_foundation (
        organisation_id, subject_kind, subject_id_scheme, subject_id, processing_status, source, updated_at
      ) VALUES (
        ${subject.organisationId}, ${subject.kind}, ${subject.idScheme}, ${subject.id},
        ${status}, ${source ? String(source).slice(0, 80) : null}, NOW()
      )
      ON CONFLICT (organisation_id, subject_kind, subject_id_scheme, subject_id) DO UPDATE SET
        processing_status = ${status}, updated_at = NOW()
      RETURNING organisation_id
    `);
    return rowsOf(res).length > 0;
  } catch (e: any) {
    console.error('[horizon/foundation] status update failed:', reasonOf(e));
    return false;
  }
}

// -------------------------------------------------------------------------------------------------
// READ — METADATA (no decryption, no audit row)
// -------------------------------------------------------------------------------------------------

/**
 * What is held for this subject, WITHOUT decrypting anything.
 *
 * Safe for a status screen, an operator view, a queue planner and the person's own summary page:
 * nothing it returns narrows down who or where anybody is. Null when there has never been a record.
 */
export async function getHoldings(subject: SubjectRef): Promise<FoundationHoldings | null> {
  if (!isSubjectRef(subject)) return null;
  try {
    await ensureHorizonIntakeSchema();
    const db = await database();
    const res = await db.execute(sql`
      SELECT * FROM hzn_personal_foundation
      WHERE organisation_id = ${subject.organisationId}
        AND subject_kind = ${subject.kind}
        AND subject_id_scheme = ${subject.idScheme}
        AND subject_id = ${subject.id}
      LIMIT 1
    `);
    const row = rowsOf(res)[0] as FoundationRow | undefined;
    return row ? toHoldings(row) : null;
  } catch (e: any) {
    console.error('[horizon/foundation] holdings failed:', reasonOf(e));
    return null;
  }
}

/**
 * The stored change hash, or null.
 *
 * Deliberately NOT part of FoundationHoldings: it is not something a status screen has any use for,
 * and the fewer surfaces that carry it the better. It exists so a recomputation request can quote
 * the hash it was raised against without decrypting anything. It is a KEYED HMAC — see
 * inputHashKey() — so it discloses nothing on its own.
 */
export async function storedInputHash(subject: SubjectRef): Promise<string | null> {
  if (!isSubjectRef(subject)) return null;
  try {
    await ensureHorizonIntakeSchema();
    const db = await database();
    const res = await db.execute(sql`
      SELECT input_hash FROM hzn_personal_foundation
      WHERE organisation_id = ${subject.organisationId}
        AND subject_kind = ${subject.kind}
        AND subject_id_scheme = ${subject.idScheme}
        AND subject_id = ${subject.id}
      LIMIT 1
    `);
    return rowsOf(res)[0]?.input_hash ?? null;
  } catch (e: any) {
    console.error('[horizon/foundation] input hash read failed:', reasonOf(e));
    return null;
  }
}

// -------------------------------------------------------------------------------------------------
// READ — PLAINTEXT (authorised, audited)
// -------------------------------------------------------------------------------------------------

export interface ReadArgs {
  subject: SubjectRef;
  actor: ReadActor;
  purpose: ReadPurpose;
  /** Free text recorded in the audit row. Required for a compliance read; a matter number belongs here. */
  justification?: string | null;
}

/**
 * Decide whether this actor may read this subject's plaintext for this purpose.
 *
 * SEPARATED FROM THE READ so the rule is testable on its own, and so a reader of this file can see
 * the whole policy in one place rather than inferring it from control flow.
 */
export async function mayRead(args: ReadArgs): Promise<{ ok: true } | { ok: false; reason: 'forbidden' | 'unknown-purpose'; message: string }> {
  const { subject, actor, purpose } = args;

  if (!READ_PURPOSES.includes(purpose)) {
    return { ok: false, reason: 'unknown-purpose', message: 'That is not a purpose this data may be read for.' };
  }

  if (purpose === 'subject-self-service') {
    // Only defensible where the subject IS the signed-in account. For a subject anchored on
    // tal_person or applications, proving "this account is that person" needs the identity patch's
    // SubjectResolver, and asserting it here without one would be a guess about whose data this is.
    const isSelf = subject.idScheme === 'user' && !!actor.userId && actor.userId === subject.id;
    return isSelf
      ? { ok: true }
      : { ok: false, reason: 'forbidden', message: 'This can only be read by the person it belongs to.' };
  }

  if (purpose === 'intelligence-computation') {
    // A SERVER-SIDE JOB, NEVER A HUMAN. A human wanting to see the values asks for compliance-review
    // and gets audited as a human; letting a person borrow the engine's purpose would erase exactly
    // the distinction the audit log exists to record.
    const isService = !!actor.service && !actor.userId;
    return isService
      ? { ok: true }
      : { ok: false, reason: 'forbidden', message: 'Only a server-side computation may read this for that purpose.' };
  }

  // compliance-review: a named human holding the capability. Uncatalogued today, so this resolves to
  // the super-admin wildcard and to nobody else. See HORIZON_FOUNDATION_READ in ./types.ts.
  if (!actor.userId) {
    return { ok: false, reason: 'forbidden', message: 'A compliance read must be made by a named person.' };
  }
  try {
    const { hasPermission } = await import('@/lib/auth/registry');
    const allowed = await hasPermission(actor.userId, HORIZON_FOUNDATION_READ);
    return allowed
      ? { ok: true }
      : { ok: false, reason: 'forbidden', message: 'You do not hold the capability to read this.' };
  } catch (e: any) {
    // FAILS CLOSED. An authorization check that could not run is not an authorization.
    console.error('[horizon/foundation] capability check failed:', reasonOf(e));
    return { ok: false, reason: 'forbidden', message: 'The authorization check could not be completed.' };
  }
}

/**
 * Read the plaintext.
 *
 * THE SEQUENCE IS THE POINT:
 *   authorise -> check consent -> WRITE THE AUDIT ROW -> decrypt -> return.
 *
 * The audit row goes first, and a failed audit write REFUSES THE READ. src/lib/legal-hold.ts already
 * holds this line for legal-hold records; personal foundation data is not a lesser case. A read
 * nobody can prove happened is indistinguishable from one that never did.
 */
export async function readPersonalFoundation(args: ReadArgs): Promise<ReadResult> {
  const { subject, actor, purpose } = args;
  if (!isSubjectRef(subject)) {
    return { ok: false, reason: 'not-found', message: 'Not a valid subject reference.' };
  }

  const allowed = await mayRead(args);
  if (!allowed.ok) {
    // A REFUSED READ IS ALSO AN EVENT. Someone asking for data they may not have is precisely what an
    // access log is for, and the refusal costs nothing to record.
    await audit(AUDIT_READ + '.refused', subject, actor, { purpose, reason: allowed.reason });
    return { ok: false, reason: allowed.reason, message: allowed.message };
  }

  const consent = await currentConsent(subject, CONSENT_SCOPE_PERSONAL_FOUNDATION);
  if (!consent.granted) {
    await audit(AUDIT_READ + '.refused', subject, actor, { purpose, reason: 'no-consent' });
    return { ok: false, reason: 'no-consent', message: 'This person has not authorised this, or has withdrawn.' };
  }
  if (purpose === 'intelligence-computation' && consent.stale) {
    // A live grant against superseded terms is still a grant — it is not revoked — but new
    // processing under new terms needs the person to be re-asked. Their own access is unaffected.
    await audit(AUDIT_READ + '.refused', subject, actor, { purpose, reason: 'stale-consent', consentVersion: consent.noticeVersion });
    return { ok: false, reason: 'no-consent', message: 'The authorisation on file predates the current notice. The person must be asked again before new processing.' };
  }

  const holdings = await getHoldings(subject);
  if (!holdings) {
    return { ok: false, reason: 'not-found', message: 'Nothing is held for this person.' };
  }
  if (!holdings.hasStoredData) {
    return {
      ok: false,
      reason: holdings.processingStatus === 'withdrawn' ? 'purged' : 'not-found',
      message: holdings.processingStatus === 'withdrawn'
        ? 'This was deleted when consent was withdrawn.'
        : 'Nothing is held for this person.',
    };
  }
  if (!encryptionAvailable()) {
    return { ok: false, reason: 'encryption-unavailable', message: 'The decryption key is not available on this deployment.' };
  }

  const recorded = await audit(AUDIT_READ, subject, actor, {
    purpose,
    justification: args.justification || null,
    consentVersion: consent.noticeVersion,
  });
  if (!recorded) {
    // FAIL CLOSED, deliberately, and this is the one place in the patch where an infrastructure
    // failure blocks a legitimate caller. That is the correct trade for data held under a promise
    // that every access is logged.
    return { ok: false, reason: 'storage-error', message: 'The access log could not be written, so the read was refused.' };
  }

  try {
    await ensureHorizonIntakeSchema();
    const db = await database();
    const res = await db.execute(sql`
      SELECT payload_enc FROM hzn_personal_foundation
      WHERE organisation_id = ${subject.organisationId}
        AND subject_kind = ${subject.kind}
        AND subject_id_scheme = ${subject.idScheme}
        AND subject_id = ${subject.id}
      LIMIT 1
    `);
    const enc = rowsOf(res)[0]?.payload_enc;
    if (!enc) return { ok: false, reason: 'not-found', message: 'Nothing is held for this person.' };

    const parsed = typeof enc === 'string' ? JSON.parse(enc) : enc;
    const value = parseCanonicalInputJson(decryptField(parsed));
    return { ok: true, value, holdings };
  } catch (e: any) {
    // A GCM tag mismatch lands here too, which is the point of the AAD: a payload that does not
    // belong to this subject throws rather than being returned under the wrong name.
    console.error('[horizon/foundation] read failed:', reasonOf(e));
    return { ok: false, reason: 'storage-error', message: 'The stored record could not be read.' };
  }
}

// -------------------------------------------------------------------------------------------------
// PURGE
// -------------------------------------------------------------------------------------------------

export interface PurgeArgs {
  subject: SubjectRef;
  actor: ReadActor;
  reason: string;
  source: string;
}

export interface PurgeResult {
  ok: boolean;
  /** True when there was ciphertext and it is now gone. False when there was nothing to delete. */
  deleted: boolean;
  /** One plain sentence, suitable for showing the person. Never a stack trace. */
  sentence: string;
}

/**
 * Delete the stored values, keeping the record that they existed and were deleted.
 *
 * WHY THE ROW SURVIVES. "We never held anything for you" and "we held something and deleted it on
 * your instruction" are different answers to the same question, and only one of them is true. The
 * row keeps the status, the timestamps and the consent version; the payload, the key id, the hash
 * and every quality flag are cleared, so nothing about the person's date, place or time remains — not
 * even the shape of it.
 *
 * NEVER BLOCKS ON BOOKKEEPING. The audit write is attempted and its failure is logged, but a failure
 * to record the deletion does not stop the deletion. A person who asked for their data to be removed
 * gets it removed.
 */
export async function purgeFoundation(args: PurgeArgs): Promise<PurgeResult> {
  const { subject } = args;
  if (!isSubjectRef(subject)) {
    return { ok: false, deleted: false, sentence: 'Not a valid subject reference.' };
  }
  try {
    await ensureHorizonIntakeSchema();
    const db = await database();
    const res = await db.execute(sql`
      UPDATE hzn_personal_foundation SET
        processing_status = 'withdrawn',
        payload_enc       = NULL,
        key_id            = NULL,
        input_hash        = NULL,
        has_birth_time    = false,
        time_precision    = NULL,
        place_precision   = NULL,
        has_coordinates   = false,
        timezone_resolved = false,
        updated_at        = NOW()
      WHERE organisation_id = ${subject.organisationId}
        AND subject_kind = ${subject.kind}
        AND subject_id_scheme = ${subject.idScheme}
        AND subject_id = ${subject.id}
        AND payload_enc IS NOT NULL
      RETURNING organisation_id
    `);
    const deleted = rowsOf(res).length > 0;

    // Any recomputation still waiting is cancelled: asking an engine to work on data that no longer
    // exists is at best wasted work and at worst a read attempt against a withdrawn record.
    await db.execute(sql`
      UPDATE hzn_recompute_request
      SET status = 'cancelled', updated_at = NOW(), last_error = 'consent withdrawn'
      WHERE organisation_id = ${subject.organisationId}
        AND subject_kind = ${subject.kind}
        AND subject_id_scheme = ${subject.idScheme}
        AND subject_id = ${subject.id}
        AND status IN ('pending','claimed')
    `).catch((e: any) => console.error('[horizon/foundation] cancel pending recompute failed:', reasonOf(e)));

    await audit(AUDIT_PURGE, subject, args.actor, { reason: args.reason, source: args.source, deleted });

    return {
      ok: true,
      deleted,
      sentence: deleted
        ? 'The personal profile information held for you has been deleted. The record that you withdrew is kept, and nothing else about your application or your account has changed.'
        : 'There was nothing stored to delete. Your withdrawal is recorded, so nothing will be stored unless you authorise it again.',
    };
  } catch (e: any) {
    console.error('[horizon/foundation] purge failed:', reasonOf(e));
    return {
      ok: false,
      deleted: false,
      sentence: 'We could not complete the deletion just now. Nothing has been lost, and support can complete it: connect@edurankai.in',
    };
  }
}
