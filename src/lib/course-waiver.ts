// src/lib/course-waiver.ts — A FEE WAIVER ON A COURSE, IN FULL OR IN PART.
//
// =================================================================================================
// THIS EXTENDS THE WAIVER FLOW THAT ALREADY EXISTS. IT DOES NOT REPLACE IT AND IT DOES NOT FORK IT.
// =================================================================================================
//
// `application_fee_waivers` (src/lib/fee-waiver.ts) is where a person asking for help with a fee
// already lives: a situation note, a supporting link, a status of pending/approved/rejected, a
// reviewer, a reviewed_at and a reject reason. It ALREADY carries grant_pct, grant_amount and
// grant_currency — and /portal/waivers ALREADY RENDERS "Full waiver" against "N% waiver - CHF X
// covered". Nothing in the repository ever wrote those three columns. Partial waiver was a rendered
// promise with no writer.
//
// So this module adds a WRITER and a REFERENCE, not a table:
//
//   reference_type / reference_id   what the waiver is against. 'application_intent' (everything
//                                   that exists today, and the column default, so no existing row
//                                   changes meaning) or 'training_course'.
//   proposed_grant_pct              what the decider chose, held until the approval settles.
//   decision_note                   why. Copied to reject_reason on a decline, so the requester
//                                   reads the actual reason and not a shrug.
//   workflow_instance_id            the approval this request is being decided through.
//   list_price_minor / currency     what the fee WAS when the request was made. A waiver granted
//                                   against a price that later changed must still say what it
//                                   covered.
//   consumed_order_id / consumed_at when it was spent. A waiver is single-use.
//
// A COURSE FEE WAIVER IS THE FIRST WAIVER IN THIS PRODUCT WITH REAL MONEY BEHIND IT.
// src/lib/application-fee.ts has returned 0 for every level since 2026-07, so the existing flow
// currently waives a fee of zero. That is why every guard below is written as though somebody is
// trying to get a paid course for nothing, because from now on they might be.
//
// =================================================================================================
// THE DECISION GOES THROUGH src/lib/workflow.ts. THERE IS NO SECOND APPROVAL ENGINE HERE.
// =================================================================================================
//
// Domain `fee_waiver`, capability `learning.waiver.grant`, one rung: the fee-waiver approval owner
// if the Organization Graph names one, otherwise THE DESK — see resolveDeskRoute() in workflow.ts
// and the `subjectOptional` note on DomainDefinition. Nothing in this file writes 'approved' onto a
// waiver by itself: settleCourseWaiverFromWorkflow() is called BY the engine when the instance
// settles, which is what makes the decision survive whichever surface it was taken from.
//
// THE SUBJECT IS DELIBERATELY NEVER AN EMPLOYEE ID, even when the requester happens to work here. A
// fee waiver is not a request about somebody's employment, and routing it up their reporting line
// would ask their manager to give away company revenue — an authority no manager has and no
// relationship confers. It always goes to the waiver desk.
//
// NOBODY MAY GRANT THEMSELVES A WAIVER. Checked explicitly, first, in decideCourseWaiver(), before
// any capability is consulted — because the capability is exactly what would otherwise let somebody
// do it.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureFeeWaiverSchema } from '@/lib/fee-waiver';
import { logAudit } from '@/lib/audit';
import { holdsCapability } from '@/lib/auth/capability';
import { startWorkflow, decideInstance, instanceForRecord } from '@/lib/workflow';
import {
  coveredByWaiver,
  formatPrice,
  getCoursePricing,
  netAfterWaiver,
  normaliseCurrency,
  priceForUser,
  type PriceCurrency,
  type PricedUser,
} from '@/lib/course-pricing';

// -------------------------------------------------------------------------------------------------
// CONSTANTS — declared above every function that reads them. `const` is not hoisted.
// -------------------------------------------------------------------------------------------------

const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const logFail = (tag: string, e: any) => console.error('[course-waiver] ' + tag, causeOf(e));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** The reference_type this module owns. Every other value belongs to the application flow. */
export const COURSE_REF = 'training_course';

/** The capability that decides one of these. It exists in permissions.ts AND registry.ts. */
export const WAIVER_CAPABILITY = 'learning.waiver.grant' as const;

/** What a person is told when a write fails. Never the database's own words. */
const WRITE_FAILED = 'Something went wrong saving that. Nothing was changed. Try again in a moment.';

const MIN_REASON = 20;
const MAX_REASON = 2000;

// -------------------------------------------------------------------------------------------------
// SHAPES
// -------------------------------------------------------------------------------------------------

export interface CourseWaiver {
  id: string;
  userId: string;
  courseId: string;
  status: 'pending' | 'approved' | 'rejected';
  reason: string;
  evidenceUrl: string | null;
  /** 1-100 once granted. 100 is a full waiver. Null while pending or declined. */
  grantPct: number | null;
  /** What the grant covers, in major units of grantCurrency — the record of what was given. */
  grantAmount: number | null;
  grantCurrency: string | null;
  /** The list price when the request was made, in minor units. */
  listPriceMinor: number;
  listPriceCurrency: PriceCurrency;
  decisionNote: string | null;
  rejectReason: string | null;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  createdAt: string | null;
  consumedAt: string | null;
  workflowInstanceId: string | null;
  /** Joined for the console and the learner's own list. */
  courseTitle?: string | null;
  courseSlug?: string | null;
  requesterName?: string | null;
  requesterEmail?: string | null;
}

export interface WaiverResult {
  ok: boolean;
  error?: string;
  waiverId?: string;
  status?: 'pending' | 'approved' | 'rejected';
  /** True when the call changed nothing because it was already true. Not an error. */
  changed?: boolean;
  /** Something that did not happen and that somebody needs to know about. */
  warning?: string;
}

// -------------------------------------------------------------------------------------------------
// SCHEMA — ADDITIVE ONLY, AND VERIFIED. src/lib/ensure-once.ts swallows DDL failures by design, so
// no ensure return anywhere in this codebase is evidence; this one reads information_schema back.
// -------------------------------------------------------------------------------------------------

let waiverSchema: Promise<boolean> | null = null;

export function ensureCourseWaiverSchema(): Promise<boolean> {
  if (waiverSchema) return waiverSchema;
  waiverSchema = (async () => {
    // The base table and the grant columns already have an owner. Called first so this module never
    // creates a second definition of the same table.
    try { await ensureFeeWaiverSchema(); } catch (e: any) { logFail('ensureFeeWaiverSchema', e); }

    try {
      // DEFAULT 'application_intent' ON PURPOSE. Every row that exists today is an application
      // waiver, and a default of NULL would make them ambiguous the moment anything filtered on it.
      await db.execute(sql`ALTER TABLE application_fee_waivers ADD COLUMN IF NOT EXISTS reference_type VARCHAR(32) NOT NULL DEFAULT 'application_intent'`);
      await db.execute(sql`ALTER TABLE application_fee_waivers ADD COLUMN IF NOT EXISTS reference_id UUID`);
      await db.execute(sql`ALTER TABLE application_fee_waivers ADD COLUMN IF NOT EXISTS proposed_grant_pct INT`);
      await db.execute(sql`ALTER TABLE application_fee_waivers ADD COLUMN IF NOT EXISTS decision_note TEXT`);
      await db.execute(sql`ALTER TABLE application_fee_waivers ADD COLUMN IF NOT EXISTS workflow_instance_id UUID`);
      await db.execute(sql`ALTER TABLE application_fee_waivers ADD COLUMN IF NOT EXISTS list_price_minor INTEGER`);
      await db.execute(sql`ALTER TABLE application_fee_waivers ADD COLUMN IF NOT EXISTS list_price_currency VARCHAR(8)`);
      await db.execute(sql`ALTER TABLE application_fee_waivers ADD COLUMN IF NOT EXISTS consumed_order_id TEXT`);
      await db.execute(sql`ALTER TABLE application_fee_waivers ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS afw_reference_idx ON application_fee_waivers(reference_type, reference_id, status)`);
      // ONE LIVE REQUEST PER PERSON PER COURSE, ENFORCED BY THE DATABASE. The pre-check in
      // requestCourseWaiver() is a courtesy; two taps on a phone are a race and this index is not.
      // PARTIAL, so it constrains only what is still open: a declined request may be made again.
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS afw_course_open_uq
        ON application_fee_waivers (user_id, reference_id)
        WHERE reference_type = 'training_course' AND status IN ('pending', 'approved')`);
    } catch (e: any) {
      logFail('ensureCourseWaiverSchema', e);
    }

    try {
      const need = ['reference_type', 'reference_id', 'proposed_grant_pct', 'decision_note', 'grant_pct'];
      const found = rowsOf(await db.execute(sql`
        SELECT column_name FROM information_schema.columns
         WHERE table_name = 'application_fee_waivers'`)).map((r: any) => String(r.column_name));
      const missing = need.filter((c) => !found.includes(c));
      if (missing.length) {
        console.error('[course-waiver] application_fee_waivers is missing:', missing.join(', ')
          + ' - no course fee waiver can be recorded until they exist.');
        return false;
      }
      return true;
    } catch (e: any) {
      logFail('ensureCourseWaiverSchema.verify', e);
      return false;
    }
  })().catch((e: any) => {
    logFail('ensureCourseWaiverSchema', e);
    waiverSchema = null;
    return false;
  });
  return waiverSchema;
}

// -------------------------------------------------------------------------------------------------
// READS
// -------------------------------------------------------------------------------------------------

function mapWaiver(r: any): CourseWaiver {
  const status = String(r?.status || 'pending');
  return {
    id: String(r?.id || ''),
    userId: String(r?.user_id || ''),
    courseId: r?.reference_id ? String(r.reference_id) : '',
    status: (status === 'approved' || status === 'rejected') ? status : 'pending',
    reason: String(r?.situation_note || ''),
    evidenceUrl: r?.drive_url ? String(r.drive_url) : null,
    grantPct: r?.grant_pct === null || r?.grant_pct === undefined ? null : Number(r.grant_pct),
    grantAmount: r?.grant_amount === null || r?.grant_amount === undefined ? null : Number(r.grant_amount),
    grantCurrency: r?.grant_currency ? String(r.grant_currency) : null,
    listPriceMinor: Number(r?.list_price_minor) || 0,
    listPriceCurrency: normaliseCurrency(r?.list_price_currency),
    decisionNote: r?.decision_note ? String(r.decision_note) : null,
    rejectReason: r?.reject_reason ? String(r.reject_reason) : null,
    reviewedByUserId: r?.reviewed_by_user_id ? String(r.reviewed_by_user_id) : null,
    reviewedAt: r?.reviewed_at ? new Date(r.reviewed_at).toISOString() : null,
    createdAt: r?.created_at ? new Date(r.created_at).toISOString() : null,
    consumedAt: r?.consumed_at ? new Date(r.consumed_at).toISOString() : null,
    workflowInstanceId: r?.workflow_instance_id ? String(r.workflow_instance_id) : null,
    courseTitle: r?.course_title ? String(r.course_title) : null,
    courseSlug: r?.course_slug ? String(r.course_slug) : null,
    requesterName: r?.requester_name ? String(r.requester_name) : null,
    requesterEmail: r?.requester_email ? String(r.requester_email) : null,
  };
}

/**
 * This person's waiver on this course, whatever state it is in — pending, granted, or declined.
 *
 * A CONSUMED WAIVER IS NOT RETURNED AS SPENDABLE but IS returned, with consumedAt set, so a screen
 * can say "you used this" rather than pretending it never existed.
 */
export async function waiverForCourse(userId: string, courseId: string): Promise<CourseWaiver | null> {
  if (!isUuid(userId) || !isUuid(courseId)) return null;
  if (!(await ensureCourseWaiverSchema())) return null;
  try {
    const r = rowsOf(await db.execute(sql`
      SELECT * FROM application_fee_waivers
       WHERE user_id = ${userId}::uuid
         AND reference_type = ${COURSE_REF}
         AND reference_id = ${courseId}::uuid
       ORDER BY created_at DESC LIMIT 1`));
    return r.length ? mapWaiver(r[0]) : null;
  } catch (e: any) {
    logFail('waiverForCourse', e);
    return null;
  }
}

/** Every course waiver this person has ever asked for. Their own record, newest first. */
export async function myCourseWaivers(userId: string): Promise<CourseWaiver[]> {
  if (!isUuid(userId)) return [];
  if (!(await ensureCourseWaiverSchema())) return [];
  try {
    return rowsOf(await db.execute(sql`
      SELECT w.*, c.title AS course_title, c.slug AS course_slug
        FROM application_fee_waivers w
        LEFT JOIN training_courses c ON c.id = w.reference_id
       WHERE w.user_id = ${userId}::uuid AND w.reference_type = ${COURSE_REF}
       ORDER BY w.created_at DESC
       LIMIT 100`)).map(mapWaiver);
  } catch (e: any) {
    logFail('myCourseWaivers', e);
    return [];
  }
}

/**
 * The console's list. Pending first, then whatever was decided recently.
 *
 * Fails to an EMPTY ARRAY and says so through `ok`: a queue that could not be read must never render
 * as "nothing is waiting", because that sentence tells a desk that nobody needs an answer.
 */
export async function listCourseWaivers(status: 'pending' | 'all' = 'pending', limit = 100): Promise<{ ok: boolean; waivers: CourseWaiver[] }> {
  if (!(await ensureCourseWaiverSchema())) return { ok: false, waivers: [] };
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 200);
  try {
    const r = rowsOf(await db.execute(sql`
      SELECT w.*, c.title AS course_title, c.slug AS course_slug,
             u.name AS requester_name, u.email AS requester_email
        FROM application_fee_waivers w
        LEFT JOIN training_courses c ON c.id = w.reference_id
        LEFT JOIN users u ON u.id = w.user_id
       WHERE w.reference_type = ${COURSE_REF}
         ${status === 'pending' ? sql`AND w.status = 'pending'` : sql``}
       ORDER BY (w.status = 'pending') DESC, w.created_at DESC
       LIMIT ${lim}`));
    return { ok: true, waivers: r.map(mapWaiver) };
  } catch (e: any) {
    logFail('listCourseWaivers', e);
    return { ok: false, waivers: [] };
  }
}

/**
 * THE BALANCE THIS PERSON STILL OWES ON THIS COURSE, after any granted waiver.
 *
 * The single answer both the course page and the checkout ask, so the number a learner is shown and
 * the number they are charged come from one function. Anything else is two prices.
 */
export interface PayableNow {
  /** Is this person allowed to enrol at all? */
  allowed: boolean;
  /** Nothing to pay — free course, employee on an employees-free course, or a full waiver. */
  free: boolean;
  payableMinor: number;
  listMinor: number;
  currency: PriceCurrency;
  /** The waiver being applied, if any is granted and unspent. */
  waiver: CourseWaiver | null;
  grantPct: number | null;
  reason: string;
}

export async function payableForCourse(
  user: PricedUser & { id?: string | null },
  courseIdOrSlug: string,
): Promise<PayableNow | null> {
  const pricing = await getCoursePricing(courseIdOrSlug, { publishedOnly: true });
  if (!pricing) return null;
  const list = priceForUser(pricing, user);

  const base: PayableNow = {
    allowed: list.allowed,
    free: list.free,
    payableMinor: list.payableMinor,
    listMinor: list.listMinor,
    currency: list.currency,
    waiver: null,
    grantPct: null,
    reason: list.reason,
  };
  if (!list.allowed || list.free || !isUuid(user?.id || '')) return base;

  const waiver = await waiverForCourse(String(user.id), pricing.courseId);
  if (!waiver || waiver.status !== 'approved' || waiver.consumedAt) {
    return { ...base, waiver: waiver || null };
  }

  const pct = waiver.grantPct === null ? 100 : waiver.grantPct;
  const net = netAfterWaiver(list.payableMinor, pct);
  return {
    ...base,
    free: net === 0,
    payableMinor: net,
    waiver,
    grantPct: pct,
    reason: net === 0
      ? 'Your fee waiver covers this course in full. There is nothing to pay.'
      : 'Your ' + pct + '% fee waiver has been applied. ' + formatPrice(net, list.currency) + ' is left to pay.',
  };
}

// -------------------------------------------------------------------------------------------------
// THE REQUEST
// -------------------------------------------------------------------------------------------------

export interface RequestWaiverInput {
  userId: string;
  courseIdOrSlug: string;
  reason: string;
  /** A link to anything that supports the request. NEVER an upload — this product stores no files. */
  evidenceUrl?: string | null;
  user?: PricedUser | null;
}

export async function requestCourseWaiver(input: RequestWaiverInput): Promise<WaiverResult> {
  const userId = String(input?.userId || '').trim();
  if (!isUuid(userId)) return { ok: false, error: 'Sign in to ask for a fee waiver.' };

  const reason = String(input?.reason || '').trim().slice(0, MAX_REASON);
  if (reason.length < MIN_REASON) {
    return { ok: false, error: 'Please tell us in a sentence or two why the fee is a barrier - at least ' + MIN_REASON + ' characters. A person reads this.' };
  }

  // A LINK, NEVER A FILE. Uploads do not exist in this product by deliberate design, and an http(s)
  // scheme is the only thing accepted here — a `javascript:` value in a field that is later rendered
  // as a link is a one-click script execution in whoever opens it.
  let evidenceUrl: string | null = null;
  const rawUrl = String(input?.evidenceUrl || '').trim();
  if (rawUrl) {
    if (!/^https?:\/\/[^\s]+$/i.test(rawUrl)) {
      return { ok: false, error: 'That link does not look like a web address. Paste a link starting with https:// or leave it blank.' };
    }
    evidenceUrl = rawUrl.slice(0, 1000);
  }

  if (!(await ensureCourseWaiverSchema())) {
    return { ok: false, error: 'We could not record that request just now, so nothing was submitted. Please try again in a moment.' };
  }

  const pricing = await getCoursePricing(String(input?.courseIdOrSlug || ''), { publishedOnly: true });
  if (!pricing) return { ok: false, error: 'That course could not be found.' };

  const who: PricedUser = input?.user || { id: userId, role: null };
  const list = priceForUser(pricing, who);
  if (!list.allowed) return { ok: false, error: 'That course is not open to your account.' };
  // NOTHING TO WAIVE. Said plainly rather than accepted and then declined by a human who has to
  // work out why somebody asked for help with a fee of zero.
  if (list.free || list.payableMinor <= 0) {
    return { ok: false, error: 'There is no fee to waive on this course - you can start it now.' };
  }

  try {
    const existing = rowsOf(await db.execute(sql`
      SELECT id, status, consumed_at FROM application_fee_waivers
       WHERE user_id = ${userId}::uuid AND reference_type = ${COURSE_REF} AND reference_id = ${pricing.courseId}::uuid
       ORDER BY created_at DESC LIMIT 1`))[0] as any;
    if (existing && String(existing.status) === 'pending') {
      return { ok: true, changed: false, waiverId: String(existing.id), status: 'pending', error: undefined };
    }
    if (existing && String(existing.status) === 'approved' && !existing.consumed_at) {
      return { ok: true, changed: false, waiverId: String(existing.id), status: 'approved' };
    }

    // application_fee_waivers has NOT NULL on expertise_note and drive_url — they belong to the
    // application form, which asks for both. A course waiver asks for ONE reason and an optional
    // link, so the columns are written empty rather than the table being altered under the flow that
    // owns it. Empty is not null; nothing that reads them breaks.
    const ins = rowsOf(await db.execute(sql`
      INSERT INTO application_fee_waivers
        (user_id, situation_note, expertise_note, drive_url, status,
         reference_type, reference_id, list_price_minor, list_price_currency)
      VALUES
        (${userId}::uuid, ${reason}, '', ${evidenceUrl || ''}, 'pending',
         ${COURSE_REF}, ${pricing.courseId}::uuid, ${list.payableMinor}, ${list.currency})
      ON CONFLICT DO NOTHING
      RETURNING id`));

    const waiverId = ins.length ? String(ins[0].id) : '';
    if (!waiverId) {
      // The unique partial index won a race the read above could not see: somebody double-tapped.
      const raced = rowsOf(await db.execute(sql`
        SELECT id, status FROM application_fee_waivers
         WHERE user_id = ${userId}::uuid AND reference_type = ${COURSE_REF} AND reference_id = ${pricing.courseId}::uuid
         ORDER BY created_at DESC LIMIT 1`))[0] as any;
      if (raced?.id) return { ok: true, changed: false, waiverId: String(raced.id), status: String(raced.status) as any };
      return { ok: false, error: WRITE_FAILED };
    }

    // THE APPROVAL. Subject deliberately empty — see the header: a fee waiver is never routed up
    // anybody's reporting line, even when the person asking happens to work here.
    let warning: string | undefined;
    const started = await startWorkflow({
      domain: 'fee_waiver',
      recordId: waiverId,
      subjectEmployeeId: '',
      requestedByUserId: userId,
      createdByUserId: userId,
      summary: 'Course fee waiver - ' + (pricing.title || 'a course') + ' - ' + formatPrice(list.payableMinor, list.currency),
      amount: list.payableMinor / 100,
      currency: list.currency,
    });

    if (started.ok && started.instanceId) {
      await db.execute(sql`
        UPDATE application_fee_waivers SET workflow_instance_id = ${started.instanceId}::uuid WHERE id = ${waiverId}::uuid`)
        .catch((e: any) => {
          logFail('link workflow instance', e);
          warning = 'Your request is recorded and will be reviewed.';
        });
    } else {
      // THE REQUEST IS SAVED AND THE APPROVAL IS NOT. Loud, recorded, and never reported to the
      // requester as a success with nothing behind it: the console lists by the waiver row, so a desk
      // still sees it, and decideCourseWaiver() starts the instance on first decision.
      console.error('[course-waiver] waiver', waiverId, 'was recorded but its approval could not be started -', started.error || started.haltReason || 'unknown reason');
      warning = 'Your request is recorded. It is being routed to the team that decides it.';
    }

    await logAudit({
      userId,
      action: 'course.waiver.request',
      entity: 'application_fee_waiver',
      entityId: waiverId,
      diff: { courseId: pricing.courseId, listMinor: list.payableMinor, currency: list.currency, instanceId: started.instanceId || null },
    });

    // TELL THE DESK. The step is owed by whoever holds the capability, so it is not on any one
    // person's routed queue by design — without this it would be waiting silently.
    try {
      const { sendPushToAdmins } = await import('@/lib/push');
      await sendPushToAdmins({
        type: 'course_fee_waiver_requested',
        title: 'Course fee waiver requested',
        body: 'Somebody has asked for help with the fee on ' + (pricing.title || 'a course') + '.',
        url: '/admin/course-waivers',
        tag: 'course-waiver-' + waiverId,
      });
    } catch (e: any) {
      logFail('notify desk', e);
      warning = (warning ? warning + ' ' : '') + 'The review team may not have been alerted yet, but your request is in their queue.';
    }

    return { ok: true, changed: true, waiverId, status: 'pending', warning };
  } catch (e: any) {
    logFail('requestCourseWaiver', e);
    return { ok: false, error: 'We could not submit that request just now. Nothing was saved. Try again in a moment.' };
  }
}

// -------------------------------------------------------------------------------------------------
// THE DECISION
// -------------------------------------------------------------------------------------------------

export interface DecideWaiverInput {
  waiverId: string;
  actor: { id?: string | null; role?: string | null; isActive?: boolean | null; name?: string | null } | null | undefined;
  decision: 'approve' | 'decline';
  /** 1-100. Ignored on a decline. Absent on an approval means a full waiver. */
  grantPct?: number | null;
  /** Why. REQUIRED on a decline — a person is waiting for an answer, not for silence. */
  note?: string | null;
}

/**
 * GRANT A WAIVER IN FULL, GRANT A PERCENTAGE, OR DECLINE IT WITH A REASON.
 *
 * ORDER OF CHECKS, AND IT MATTERS:
 *   1. NOBODY MAY DECIDE THEIR OWN REQUEST. Asked first, before the capability, because the
 *      capability is precisely what would otherwise permit it. Refused, audited, and stated plainly.
 *   2. The request exists and is still pending.
 *   3. The percentage is a real percentage and a decline carries a reason.
 *   4. The DECISION ITSELF is taken by src/lib/workflow.ts — mayAct() decides whether this actor may
 *      act on this step, through the routed approver, an in-force delegate, or the domain's standing
 *      capability. This file never writes 'approved' on its own authority.
 *
 * The percentage and the note are written BEFORE the approval is decided, because the engine settles
 * the record through settleCourseWaiverFromWorkflow() and has no idea what a partial waiver is. They
 * are written to `proposed_*` columns and only become the grant when the instance settles approved.
 */
export async function decideCourseWaiver(input: DecideWaiverInput): Promise<WaiverResult> {
  const waiverId = String(input?.waiverId || '').trim();
  if (!isUuid(waiverId)) return { ok: false, error: 'That request is not available.' };

  const actorId = String(input?.actor?.id || '').trim();
  if (!isUuid(actorId)) return { ok: false, error: 'Sign in to decide this.' };

  const decision = input?.decision === 'approve' ? 'approve' : input?.decision === 'decline' ? 'decline' : null;
  if (!decision) return { ok: false, error: 'That is not a decision we record.' };

  const note = String(input?.note || '').trim().slice(0, MAX_REASON);
  if (decision === 'decline' && note.length < MIN_REASON) {
    return {
      ok: false,
      error: 'A decline needs a reason the person can read - at least ' + MIN_REASON + ' characters. They asked for help and are entitled to an answer.',
    };
  }

  let grantPct = 100;
  if (decision === 'approve') {
    const raw = input?.grantPct === null || input?.grantPct === undefined ? 100 : Math.floor(Number(input.grantPct));
    if (!Number.isFinite(raw) || raw < 1 || raw > 100) {
      return { ok: false, error: 'A waiver covers between 1 and 100 per cent of the fee.' };
    }
    grantPct = raw;
  }

  if (!(await ensureCourseWaiverSchema())) return { ok: false, error: WRITE_FAILED };

  try {
    const row = rowsOf(await db.execute(sql`
      SELECT w.*, c.title AS course_title, c.slug AS course_slug
        FROM application_fee_waivers w
        LEFT JOIN training_courses c ON c.id = w.reference_id
       WHERE w.id = ${waiverId}::uuid AND w.reference_type = ${COURSE_REF}
       LIMIT 1`))[0] as any;
    if (!row) return { ok: false, error: 'That request is not available.' };
    const waiver = mapWaiver(row);

    // =============================================================================================
    // 1. NOBODY GRANTS THEMSELVES A WAIVER. FIRST, EXPLICITLY, AND LOUDLY.
    //
    // The whole point of `learning.waiver.grant` is that its holder can give somebody free access to
    // a paid course. Without this line, the person who holds it can give it to themselves, and every
    // record of the act would look exactly like an ordinary approval. It is checked before the
    // capability rather than after, so the refusal does not depend on what the actor holds.
    //
    // The attempt is AUDITED, not just refused: somebody deciding their own money request is a fact
    // worth having on the record whether or not it succeeded.
    // =============================================================================================
    if (waiver.userId && waiver.userId === actorId) {
      await logAudit({
        userId: actorId,
        action: 'course.waiver.self_decision_refused',
        entity: 'application_fee_waiver',
        entityId: waiverId,
        diff: { decision, grantPct: decision === 'approve' ? grantPct : null, courseId: waiver.courseId },
      });
      return {
        ok: false,
        error: 'This is your own request, so you cannot decide it. Somebody else on the team has to.',
      };
    }

    if (waiver.status !== 'pending') {
      return { ok: false, error: 'That request has already been ' + waiver.status + '.' };
    }

    // THE PROPOSAL, WRITTEN BEFORE THE APPROVAL IS ASKED FOR. It is not the grant: `status` is what
    // makes it real, and that is only written when the instance settles. The `status = 'pending'`
    // guard is repeated on the statement so a decision landing a moment earlier wins the race.
    const staged = rowsOf(await db.execute(sql`
      UPDATE application_fee_waivers
         SET proposed_grant_pct = ${decision === 'approve' ? grantPct : null},
             decision_note = ${note || null}
       WHERE id = ${waiverId}::uuid AND status = 'pending'
      RETURNING id`));
    if (!staged.length) {
      return { ok: false, error: 'That request changed while this page was open. Reload it and try again.' };
    }

    // THE APPROVAL. Started here if it was never started (a waiver whose startWorkflow failed at
    // submission would otherwise be undecidable forever) — startWorkflow is idempotent on
    // (domain, record_id), so this is a no-op when the instance already exists.
    let instance = await instanceForRecord('fee_waiver', waiverId);
    if (!instance) {
      const started = await startWorkflow({
        domain: 'fee_waiver',
        recordId: waiverId,
        subjectEmployeeId: '',
        requestedByUserId: waiver.userId,
        createdByUserId: actorId,
        summary: 'Course fee waiver - ' + (waiver.courseTitle || 'a course'),
        amount: waiver.listPriceMinor / 100,
        currency: waiver.listPriceCurrency,
      });
      if (!started.ok || !started.instanceId) {
        return { ok: false, error: started.error || 'This request could not be routed for approval, so nothing was decided.' };
      }
      await db.execute(sql`UPDATE application_fee_waivers SET workflow_instance_id = ${started.instanceId}::uuid WHERE id = ${waiverId}::uuid`)
        .catch((e: any) => logFail('link workflow instance (late)', e));
      instance = await instanceForRecord('fee_waiver', waiverId);
    }
    if (!instance) return { ok: false, error: WRITE_FAILED };

    const decided = await decideInstance(instance.id, input.actor, decision === 'approve' ? 'approved' : 'rejected', note);
    if (!decided.ok) {
      // The refusal came from the engine — not the routed approver, not a delegate, no standing
      // capability. Reported verbatim: it is already a sentence written for a person.
      return { ok: false, error: decided.error || 'That approval is not available.' };
    }

    // The record was settled by settleCourseWaiverFromWorkflow() inside the engine. Read it back
    // rather than assuming: a decision reported over a record that did not change is exactly the
    // class of failure this codebase keeps finding.
    const after = await getCourseWaiver(waiverId);
    if (!after || after.status === 'pending') {
      return {
        ok: false,
        error: 'The approval was recorded but the request was not updated. Nothing has been granted - please reload and check before deciding again.',
      };
    }

    return { ok: true, changed: decided.changed !== false, waiverId, status: after.status };
  } catch (e: any) {
    logFail('decideCourseWaiver', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/** One waiver by id, joined for display. */
export async function getCourseWaiver(waiverId: string): Promise<CourseWaiver | null> {
  if (!isUuid(waiverId)) return null;
  if (!(await ensureCourseWaiverSchema())) return null;
  try {
    const r = rowsOf(await db.execute(sql`
      SELECT w.*, c.title AS course_title, c.slug AS course_slug,
             u.name AS requester_name, u.email AS requester_email
        FROM application_fee_waivers w
        LEFT JOIN training_courses c ON c.id = w.reference_id
        LEFT JOIN users u ON u.id = w.user_id
       WHERE w.id = ${waiverId}::uuid LIMIT 1`));
    return r.length ? mapWaiver(r[0]) : null;
  } catch (e: any) {
    logFail('getCourseWaiver', e);
    return null;
  }
}

export interface SettleResult {
  settled: boolean;
  grantPct?: number | null;
  warning?: string | null;
}

/**
 * WRITE THE OUTCOME ONTO THE REQUEST. Called BY src/lib/workflow.ts when the instance settles, from
 * whichever surface the decision was taken on.
 *
 * `WHERE status = 'pending'` is the guard: a request decided the ordinary way is left exactly as it
 * was left, and a re-run of the settlement changes nothing. `settled: false` means "already decided",
 * which is a no-op and not an error.
 *
 * ON A DECLINE THE REASON IS COPIED INTO reject_reason, which is the column /portal/waivers and the
 * learner's own screens already read. A decline that reaches here with no reason recorded — possible
 * only if the decision was taken from a generic approvals surface that does not ask for one — still
 * writes a sentence, and flags a warning, rather than leaving somebody with a refusal and no words.
 */
export async function settleCourseWaiverFromWorkflow(
  waiverId: string,
  state: 'approved' | 'rejected',
  actorId: string | null,
  instanceId: string | null,
): Promise<SettleResult> {
  if (!isUuid(waiverId)) return { settled: false };
  if (!(await ensureCourseWaiverSchema())) return { settled: false, warning: 'the waiver schema is not present' };

  try {
    const row = rowsOf(await db.execute(sql`
      SELECT * FROM application_fee_waivers WHERE id = ${waiverId}::uuid AND reference_type = ${COURSE_REF} LIMIT 1`))[0] as any;
    if (!row) return { settled: false };
    if (String(row.status) !== 'pending') return { settled: false };

    const listMinor = Number(row.list_price_minor) || 0;
    const currency = normaliseCurrency(row.list_price_currency);
    const note = row.decision_note ? String(row.decision_note) : '';
    let warning: string | null = null;

    if (state === 'approved') {
      // No proposal recorded means the decision came through a surface that only says yes or no.
      // The honest reading of a bare "approve" on a fee waiver is the whole fee.
      const pct = row.proposed_grant_pct === null || row.proposed_grant_pct === undefined
        ? 100
        : Math.min(100, Math.max(1, Math.floor(Number(row.proposed_grant_pct))));
      const coveredMinor = coveredByWaiver(listMinor, pct);

      const wrote = rowsOf(await db.execute(sql`
        UPDATE application_fee_waivers
           SET status = 'approved',
               grant_pct = ${pct},
               grant_amount = ${(coveredMinor / 100).toFixed(2)}::numeric,
               grant_currency = ${currency},
               reject_reason = NULL,
               reviewed_by_user_id = ${actorId || null}::uuid,
               reviewed_at = NOW(),
               workflow_instance_id = COALESCE(${instanceId || null}::uuid, workflow_instance_id)
         WHERE id = ${waiverId}::uuid AND status = 'pending'
        RETURNING id`));
      if (!wrote.length) return { settled: false };

      await notifyRequesterOfDecision(row, 'approved', pct, note, currency, coveredMinor);
      await logAudit({
        userId: actorId,
        action: 'course.waiver.granted',
        entity: 'application_fee_waiver',
        entityId: waiverId,
        diff: { courseId: row.reference_id ? String(row.reference_id) : null, grantPct: pct, coveredMinor, currency, note: note || null },
      });
      return { settled: true, grantPct: pct, warning };
    }

    const reason = note || 'We are not able to grant a waiver for this course at the moment.';
    if (!note) warning = 'the decline was recorded without a written reason, so the requester was given a general sentence';

    const wrote = rowsOf(await db.execute(sql`
      UPDATE application_fee_waivers
         SET status = 'rejected',
             reject_reason = ${reason},
             grant_pct = NULL,
             grant_amount = NULL,
             reviewed_by_user_id = ${actorId || null}::uuid,
             reviewed_at = NOW(),
             workflow_instance_id = COALESCE(${instanceId || null}::uuid, workflow_instance_id)
       WHERE id = ${waiverId}::uuid AND status = 'pending'
      RETURNING id`));
    if (!wrote.length) return { settled: false };

    await notifyRequesterOfDecision(row, 'rejected', null, reason, currency, 0);
    await logAudit({
      userId: actorId,
      action: 'course.waiver.declined',
      entity: 'application_fee_waiver',
      entityId: waiverId,
      diff: { courseId: row.reference_id ? String(row.reference_id) : null, reason },
    });
    return { settled: true, grantPct: null, warning };
  } catch (e: any) {
    logFail('settleCourseWaiverFromWorkflow', e);
    return { settled: false, warning: causeOf(e) };
  }
}

/**
 * TELL THE PERSON WHO ASKED. A decision they cannot read is a decision that did not happen to them.
 *
 * The engine also pings the requester when an instance settles, with the request's one-line summary.
 * This is the one that carries the ANSWER — how much was granted, or why it was not — and it is sent
 * from here because the engine does not know what a partial waiver is.
 */
async function notifyRequesterOfDecision(
  row: any,
  state: 'approved' | 'rejected',
  grantPct: number | null,
  note: string,
  currency: PriceCurrency,
  coveredMinor: number,
): Promise<void> {
  const userId = row?.user_id ? String(row.user_id) : '';
  if (!isUuid(userId)) return;
  try {
    const { sendPushToUser } = await import('@/lib/push');
    const body = state === 'approved'
      ? (grantPct === 100
        ? 'Your fee is fully covered. You can start the course now.'
        : grantPct + '% of the fee is covered (' + formatPrice(coveredMinor, currency) + '). The balance is payable when you enrol.')
      : note;
    await sendPushToUser(userId, {
      type: 'course_fee_waiver_decided',
      title: state === 'approved' ? 'Fee waiver granted' : 'Fee waiver not granted',
      body,
      url: '/portal/course-waivers',
      tag: 'course-waiver-decision-' + String(row?.id || ''),
    });
  } catch (e: any) {
    // Never fatal: the decision is recorded and the learner's own page shows it. But a decision that
    // nobody was told about is exactly the silence this feature exists to remove, so it is logged.
    logFail('notifyRequesterOfDecision', e);
  }
}

/**
 * SPEND THE WAIVER. Called once the course is actually granted — after a verified payment of the
 * balance, or at the moment a full waiver is used to enrol.
 *
 * ONE STATEMENT, guarded on `consumed_at IS NULL`, so two confirmations of the same purchase spend
 * it once. Returns whether THIS call was the one that spent it.
 */
export async function consumeWaiver(waiverId: string, orderId: string | null): Promise<boolean> {
  if (!isUuid(waiverId)) return false;
  try {
    const r = rowsOf(await db.execute(sql`
      UPDATE application_fee_waivers
         SET consumed_at = NOW(), consumed_order_id = COALESCE(${orderId || null}, consumed_order_id)
       WHERE id = ${waiverId}::uuid AND status = 'approved' AND consumed_at IS NULL
      RETURNING id`));
    return r.length > 0;
  } catch (e: any) {
    // NOT SWALLOWED. An unspent waiver is a second free course; the log is what makes that findable.
    logFail('consumeWaiver', e);
    return false;
  }
}

/**
 * May this signed-in user decide course fee waivers at all — the question the console asks before it
 * renders anything.
 *
 * TWO WAYS, and both are already the engine's answer rather than a new one:
 *   - they hold `learning.waiver.grant`, the domain's standing capability; or
 *   - the Organization Graph routed a live fee-waiver step to them personally (or to somebody they
 *     are standing in for), which pendingForApprover() answers.
 *
 * The second arm exists so that recording a fee-waiver approval owner does not hand somebody a queue
 * they cannot open. It grants nothing: decideCourseWaiver() still goes through mayAct().
 */
export async function mayDecideWaivers(user: { id?: string | null; role?: string | null; isActive?: boolean | null } | null | undefined): Promise<boolean> {
  if (!user?.id) return false;
  if (holdsCapability(user as any, WAIVER_CAPABILITY)) return true;
  try {
    const { pendingForApprover } = await import('@/lib/workflow');
    const pending = await pendingForApprover(String(user.id));
    return pending.some((p) => p.instance.domain === 'fee_waiver');
  } catch (e: any) {
    // FAILS CLOSED. Somebody refused once asks why; somebody admitted by a failed query is an
    // authorisation nobody granted.
    logFail('mayDecideWaivers', e);
    return false;
  }
}
