// src/lib/horizon/intake/consent.ts — CAPTURE, VERSION, TIMESTAMP AND WITHDRAWAL.
//
// =================================================================================================
// AN APPEND-ONLY LEDGER, NOT A BOOLEAN
// =================================================================================================
//
// The obvious design is a `consented BOOLEAN` column. It is also the one that cannot answer any of
// the questions that actually get asked: when did they agree, what exactly were they shown, from
// which surface, who clicked it, and did they later change their mind. A boolean answers none of
// those, and it is a field somebody eventually flips without leaving a trace.
//
// So every act is a ROW — grant and withdrawal alike — and the current state is DERIVED by reading
// the most recent one. Withdrawal is not an update; it is another row. Nothing in this module
// updates or deletes a ledger row, and no function to do so may be added.
//
// =================================================================================================
// THE THREE RULES THIS MODULE ENFORCES
// =================================================================================================
//
//  1. A GRANT IS AGAINST A VERSION, AND THE TEXT IS HASHED. Storing "consented: true" against a
//     notice that was later reworded is a record of nothing. See ./notice.ts.
//  2. WITHDRAWAL IS ALWAYS AVAILABLE, AND IT NEVER FAILS BECAUSE OF STATE. Withdrawing when there is
//     nothing to withdraw is recorded and returns cleanly — an error message is not a reasonable
//     answer to a person exercising a right, and "your withdrawal failed" is the worst possible
//     thing to show them.
//  3. A WRITE FAILURE IS REPORTED, NEVER SWALLOWED. recordConsent() returns null and logs the real
//     Postgres reason from e.cause. A caller that cannot tell whether consent was recorded must not
//     go on to store the data, and foundation.ts checks.
//
// PURE PART SEPARATED. deriveConsentState() takes rows and returns state with no database anywhere
// near it, so the logic that decides whether we may hold somebody's data is unit-testable.
import { sql } from 'drizzle-orm';
import {
  type ActorRef,
  type SubjectRef,
  isSubjectRef,
} from '@/lib/horizon/ids';
import {
  CURRENT_NOTICE,
  CURRENT_NOTICE_VERSION,
  isNoticeCurrent,
  noticeByVersion,
  noticeHash,
  type PurposeNotice,
} from './notice';
import { ensureHorizonIntakeSchema } from './schema';
import {
  CONSENT_SCOPE_PERSONAL_FOUNDATION,
  reasonOf,
  rowsOf,
  type ConsentAction,
  type ConsentEvent,
  type ConsentScope,
} from './types';

// -------------------------------------------------------------------------------------------------
// MODULE CONSTANTS — before anything that reads them.
// -------------------------------------------------------------------------------------------------

/** How much ledger a self-service page shows without asking for more. */
export const HISTORY_DEFAULT_LIMIT = 50;

const MAX_REASON_CHARS = 500;
const MAX_SOURCE_CHARS = 80;
const MAX_UA_CHARS = 400;

/**
 * The database is resolved LAZILY. A module-scope `import { db }` makes src/lib/db throw
 * "DATABASE_URL is not set" the moment any importer loads, which puts every pure function in this
 * file — and in anything that imports it — out of reach of a test that needs no connection at all.
 * src/lib/audit.ts and src/lib/talent/events.ts carry the same note for the same reason.
 */
let _db: any = null;
async function database(): Promise<any> {
  if (!_db) _db = (await import('@/lib/db')).db;
  return _db;
}

// -------------------------------------------------------------------------------------------------
// PURE: STATE FROM ROWS
// -------------------------------------------------------------------------------------------------

/** Row shape as it comes back from `hzn_consent_event`. Snake case, straight from Postgres. */
interface ConsentRow {
  id: string;
  organisation_id: string;
  subject_kind: string;
  subject_id_scheme: string;
  subject_id: string;
  scope: string;
  action: string;
  notice_version: string;
  notice_hash: string;
  occurred_at: string | Date;
  actor_kind: string | null;
  actor_id: string | null;
  actor_name: string | null;
  source: string;
  ip_address: string | null;
  user_agent: string | null;
  reason: string | null;
}

function iso(v: string | Date | null | undefined): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

/** PURE. Map one database row to the exported contract shape. */
export function toConsentEvent(r: ConsentRow): ConsentEvent {
  return {
    id: String(r.id),
    subject: {
      kind: r.subject_kind as SubjectRef['kind'],
      id: String(r.subject_id),
      idScheme: r.subject_id_scheme as SubjectRef['idScheme'],
      organisationId: String(r.organisation_id),
    },
    scope: r.scope as ConsentScope,
    action: r.action as ConsentAction,
    noticeVersion: String(r.notice_version),
    noticeHash: String(r.notice_hash),
    occurredAt: iso(r.occurred_at) || '',
    actor: r.actor_kind
      ? { kind: r.actor_kind as ActorRef['kind'], id: String(r.actor_id || ''), displayName: r.actor_name }
      : null,
    source: String(r.source),
    ipAddress: r.ip_address,
    userAgent: r.user_agent,
    reason: r.reason,
  };
}

/**
 * PURE. Derive the current state from a subject's ledger.
 *
 * `events` may arrive in any order; this sorts. The MOST RECENT act wins, which is the only rule
 * that survives an out-of-order write, a replayed request or a clock skew between instances.
 *
 * `grantedAt` is the timestamp of the CURRENT grant, not the first one ever: a person who withdrew
 * in March and re-authorised in July consented in July, and showing March would misdate the record.
 */
export function deriveConsentState(
  events: readonly ConsentEvent[],
  subject: SubjectRef,
  scope: ConsentScope = CONSENT_SCOPE_PERSONAL_FOUNDATION,
): import('./types').ConsentState {
  const mine = events
    .filter((e) => e.scope === scope)
    .slice()
    .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0));

  const latest = mine.length > 0 ? mine[mine.length - 1] : null;
  const granted = latest?.action === 'granted';

  // The timestamp of the grant currently in force — the last grant with no withdrawal after it.
  let grantedAt: string | null = null;
  let noticeVersion: string | null = null;
  let noticeHashValue: string | null = null;
  if (granted && latest) {
    grantedAt = latest.occurredAt;
    noticeVersion = latest.noticeVersion;
    noticeHashValue = latest.noticeHash;
  }

  const lastWithdrawal = [...mine].reverse().find((e) => e.action === 'withdrawn') || null;

  return {
    subject,
    scope,
    granted,
    noticeVersion,
    noticeHash: noticeHashValue,
    grantedAt,
    withdrawnAt: lastWithdrawal ? lastWithdrawal.occurredAt : null,
    stale: granted && !isNoticeCurrent(noticeVersion),
    consentRef: latest ? latest.id : null,
  };
}

// -------------------------------------------------------------------------------------------------
// WRITES
// -------------------------------------------------------------------------------------------------

export interface RecordConsentArgs {
  subject: SubjectRef;
  action: ConsentAction;
  scope?: ConsentScope;
  /** Defaults to the current notice. Pass an older one only when replaying a historical act. */
  notice?: PurposeNotice;
  actor?: ActorRef | null;
  /** The surface, e.g. 'apply/step-1'. Required: "somewhere in the product" is not a record. */
  source: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  reason?: string | null;
}

/**
 * Append one act to the ledger.
 *
 * RETURNS null ON FAILURE rather than throwing, and logs the real Postgres reason. The caller
 * decides what that means: foundation.ts refuses to store anything without a recorded grant, and the
 * withdrawal path still purges the ciphertext even if the ledger write failed, because the person's
 * instruction outranks our bookkeeping.
 */
export async function recordConsent(args: RecordConsentArgs): Promise<ConsentEvent | null> {
  if (!isSubjectRef(args.subject)) {
    console.error('[horizon/consent] refused: not a valid SubjectRef');
    return null;
  }
  const scope = args.scope || CONSENT_SCOPE_PERSONAL_FOUNDATION;
  const notice = args.notice || CURRENT_NOTICE;
  const hash = noticeHash(notice);
  const s = args.subject;

  try {
    await ensureHorizonIntakeSchema();
    const db = await database();
    const res = await db.execute(sql`
      INSERT INTO hzn_consent_event (
        organisation_id, subject_kind, subject_id_scheme, subject_id,
        scope, action, notice_version, notice_hash,
        actor_kind, actor_id, actor_name, source, ip_address, user_agent, reason
      ) VALUES (
        ${s.organisationId}, ${s.kind}, ${s.idScheme}, ${s.id},
        ${scope}, ${args.action}, ${notice.version}, ${hash},
        ${args.actor?.kind || null}, ${args.actor?.id || null}, ${args.actor?.displayName || null},
        ${String(args.source || '').slice(0, MAX_SOURCE_CHARS) || 'unknown'},
        ${args.ipAddress ? String(args.ipAddress).slice(0, 64) : null},
        ${args.userAgent ? String(args.userAgent).slice(0, MAX_UA_CHARS) : null},
        ${args.reason ? String(args.reason).slice(0, MAX_REASON_CHARS) : null}
      )
      RETURNING *
    `);
    const row = rowsOf(res)[0];
    return row ? toConsentEvent(row as ConsentRow) : null;
  } catch (e: any) {
    console.error('[horizon/consent] record ' + args.action + ' failed:', reasonOf(e));
    return null;
  }
}

/** Record that the person authorised this scope, against the notice version they were shown. */
export function grantConsent(args: Omit<RecordConsentArgs, 'action'>): Promise<ConsentEvent | null> {
  return recordConsent({ ...args, action: 'granted' });
}

/**
 * Record a withdrawal.
 *
 * Deliberately does NOT check whether a grant exists first. A person withdrawing consent they never
 * gave is not an error to report back at them, and the extra round trip buys nothing.
 */
export function withdrawConsent(args: Omit<RecordConsentArgs, 'action'>): Promise<ConsentEvent | null> {
  return recordConsent({ ...args, action: 'withdrawn' });
}

// -------------------------------------------------------------------------------------------------
// READS
// -------------------------------------------------------------------------------------------------

/**
 * The subject's ledger, newest first.
 *
 * Readable by the subject themselves without any capability: it is the record of their own acts, and
 * a consent trail nobody can see is not a consent trail. Callers acting on somebody else's behalf
 * gate the surface, not this function.
 */
export async function consentHistory(
  subject: SubjectRef,
  scope: ConsentScope = CONSENT_SCOPE_PERSONAL_FOUNDATION,
  limit = HISTORY_DEFAULT_LIMIT,
): Promise<ConsentEvent[]> {
  if (!isSubjectRef(subject)) return [];
  try {
    await ensureHorizonIntakeSchema();
    const db = await database();
    const capped = Math.max(1, Math.min(500, Math.floor(limit)));
    const res = await db.execute(sql`
      SELECT * FROM hzn_consent_event
      WHERE organisation_id = ${subject.organisationId}
        AND subject_kind = ${subject.kind}
        AND subject_id_scheme = ${subject.idScheme}
        AND subject_id = ${subject.id}
        AND scope = ${scope}
      ORDER BY occurred_at DESC
      LIMIT ${capped}
    `);
    return rowsOf(res).map((r) => toConsentEvent(r as ConsentRow));
  } catch (e: any) {
    console.error('[horizon/consent] history failed:', reasonOf(e));
    return [];
  }
}

/**
 * The current answer to "may we hold this?".
 *
 * FAILS CLOSED. If the ledger cannot be read, this reports `granted: false` — the same answer as
 * "never asked". Storing somebody's personal information because a query timed out is not a
 * defensible outcome, and every caller of this function is about to either store or reveal data.
 */
export async function currentConsent(
  subject: SubjectRef,
  scope: ConsentScope = CONSENT_SCOPE_PERSONAL_FOUNDATION,
): Promise<import('./types').ConsentState> {
  const empty = {
    subject, scope, granted: false, noticeVersion: null, noticeHash: null,
    grantedAt: null, withdrawnAt: null, stale: false, consentRef: null,
  };
  if (!isSubjectRef(subject)) return empty;
  try {
    await ensureHorizonIntakeSchema();
    const db = await database();
    // Only the two rows that can decide the answer: the newest act, and the newest withdrawal (which
    // may be older). Cheaper than pulling a whole history to compute a boolean.
    const res = await db.execute(sql`
      (SELECT * FROM hzn_consent_event
        WHERE organisation_id = ${subject.organisationId}
          AND subject_kind = ${subject.kind}
          AND subject_id_scheme = ${subject.idScheme}
          AND subject_id = ${subject.id}
          AND scope = ${scope}
        ORDER BY occurred_at DESC LIMIT 1)
      UNION ALL
      (SELECT * FROM hzn_consent_event
        WHERE organisation_id = ${subject.organisationId}
          AND subject_kind = ${subject.kind}
          AND subject_id_scheme = ${subject.idScheme}
          AND subject_id = ${subject.id}
          AND scope = ${scope}
          AND action = 'withdrawn'
        ORDER BY occurred_at DESC LIMIT 1)
    `);
    const events = rowsOf(res).map((r) => toConsentEvent(r as ConsentRow));
    return deriveConsentState(events, subject, scope);
  } catch (e: any) {
    console.error('[horizon/consent] current failed:', reasonOf(e));
    return empty;
  }
}

/**
 * Does this subject need to be re-asked?
 *
 * True when they hold a live grant against a superseded notice. Exposed so a surface can show the
 * new notice rather than silently carrying an old agreement forward onto new terms.
 */
export function needsReconsent(state: import('./types').ConsentState): boolean {
  return state.granted && state.noticeVersion !== CURRENT_NOTICE_VERSION;
}

/** The notice a given state was granted under, for a page that shows somebody what they agreed to. */
export function noticeForState(state: import('./types').ConsentState): PurposeNotice | null {
  return noticeByVersion(state.noticeVersion);
}
