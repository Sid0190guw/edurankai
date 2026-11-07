// THE COMPLETION ENGINE: from "this internship ends next week" to a certificate in the person's inbox.
//
// The rules are in completion-rules.ts (pure, tested). This file reads the records, keeps one row of
// state per engagement in hr_engagement_completions, and performs the three actions:
//
//   notifyLead()             web push to the person's lead: review, approve or hold, write the LOR
//   evaluateEngagement()     measure against the criteria, from the same ledger the completion page uses
//   issueCompletionCertificate()   record a verifiable certificate and email it
//
// runEngine() strings them together for the daily cron (/api/cron/engagement-completion) and for the
// "Run now" button on /admin/hr/completions. EVERY ACTION IS ALSO A BUTTON on that page: the engine
// is a convenience on top of a manual system, never the only way to do something.
//
// IDEMPOTENT. The state row records that the lead was told and what the outcome was, and a
// certificate already issued for the engagement is found and reused rather than issued twice, so a
// cron that runs twice, or a person pressing the button while the cron runs, does no harm.
//
// THE TABLE IS NOT CREATED ON A REQUEST in production: the bootstrap at /admin/setup creates it, or
// db/completion-engine-schema.sql. Every reader reports `ready: false` when it is absent.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { civilToday } from '@/lib/page-safety';
import { logAudit } from '@/lib/audit';
import { termsFor, ledgerFor, reviewsForDetailed } from '@/lib/credit-ledger';
import { completionFigures } from '@/lib/credit-hours';
import { reconcileCreditWeeks, syncCreditDecisions } from '@/lib/credit-week-ledger';
import { positionFrom } from '@/lib/credit-week';
import { creditsLabel } from '@/lib/credit-week-copy';
import { getManagerCompat } from '@/lib/org-graph';
import { issueUniversalCertificate, getUniversalForAdmin, universalForEmployee } from '@/lib/universal-certificates';
import { skillsForEmployee } from '@/lib/hr/role-skills';
import { emailUniversalCertificate } from '@/lib/hr/certificate-mail';
import {
  parseDuration, endDateFor, daysUntil, isFixedTerm, evaluateCriteria, nextStep,
  type Evaluation,
} from '@/lib/hr/completion-rules';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const why = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const isUuid = (v: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
const isMissingTable = (e: any) => String(e?.cause?.code || e?.code || '') === '42P01';
const isoDay = (v: any): string => {
  if (!v) return '';
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};

/** Who signs a certificate the engine issues. The same default the HR letter desks open with. */
export const ENGINE_SIGNATORY = { name: 'Siddharth Prasad', title: 'Founder & CEO' };

export const COMPLETION_DDL = `
CREATE TABLE IF NOT EXISTS hr_engagement_completions (
  employee_id        UUID PRIMARY KEY,
  end_date_override  DATE,
  lead_notified_at   TIMESTAMPTZ,
  lead_user_id       UUID,
  lead_decision      TEXT,
  lead_decided_at    TIMESTAMPTZ,
  lead_decided_by    UUID,
  lead_note          TEXT,
  lor_serial         TEXT,
  outcome            TEXT,
  outcome_at         TIMESTAMPTZ,
  outcome_by         UUID,
  outcome_note       TEXT,
  certificate_serial TEXT,
  criteria           JSONB,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

export function ensureCompletionSchema(): Promise<void> {
  return ensureOnce('hr_engagement_completions_v1', async () => {
    await db.execute(sql.raw(COMPLETION_DDL.trim().replace(/;\s*$/, '')));
  });
}

const NOT_SET_UP = 'The completion engine is not set up on this deployment yet: the hr_engagement_completions table does not exist. Run the bootstrap at /admin/setup, or db/completion-engine-schema.sql.';

// -------------------------------------------------------------------------------------------------
// READ
// -------------------------------------------------------------------------------------------------

export interface Engagement {
  employeeId: string;
  fullName: string;
  email: string;
  designation: string;
  employmentType: string;
  startDate: string;
  durationText: string;
  endDate: string | null;
  endSource: 'override' | 'offer' | 'none';
  daysLeft: number | null;
  leadNotifiedAt: string | null;
  leadDecision: 'approved' | 'held' | null;
  leadNote: string | null;
  lorSerial: string | null;
  outcome: string | null;
  outcomeAt: string | null;
  outcomeNote: string | null;
  certificateSerial: string | null;
  criteria: Evaluation | null;
}

export type Read<T> = { ready: true; value: T } | { ready: false; error: string };

function mapEngagement(r: any, today: string): Engagement {
  const start = isoDay(r.joining_date) || isoDay(r.offer_joining);
  const durationText = String(r.offer_duration || '');
  const dur = parseDuration(durationText);
  const override = isoDay(r.end_date_override);
  const computed = start && dur ? endDateFor(start, dur) : null;
  const endDate = override || computed || null;
  let criteria: Evaluation | null = null;
  if (r.criteria) {
    try { criteria = typeof r.criteria === 'string' ? JSON.parse(r.criteria) : r.criteria; } catch { criteria = null; }
  }
  return {
    employeeId: String(r.id),
    fullName: String(r.full_name || ''),
    email: String(r.email || ''),
    designation: String(r.designation || ''),
    employmentType: String(r.employment_type || ''),
    startDate: start,
    durationText,
    endDate,
    endSource: override ? 'override' : computed ? 'offer' : 'none',
    daysLeft: endDate ? daysUntil(endDate, today) : null,
    leadNotifiedAt: r.lead_notified_at ? new Date(r.lead_notified_at).toISOString() : null,
    leadDecision: r.lead_decision === 'approved' || r.lead_decision === 'held' ? r.lead_decision : null,
    leadNote: r.lead_note ? String(r.lead_note) : null,
    lorSerial: r.lor_serial ? String(r.lor_serial) : null,
    outcome: r.outcome ? String(r.outcome) : null,
    outcomeAt: r.outcome_at ? new Date(r.outcome_at).toISOString() : null,
    outcomeNote: r.outcome_note ? String(r.outcome_note) : null,
    certificateSerial: r.certificate_serial ? String(r.certificate_serial) : null,
    criteria,
  };
}

/** Every fixed-term engagement the engine watches, soonest end first. */
export async function listEngagements(opts: { employeeId?: string } = {}): Promise<Read<Engagement[]>> {
  const today = civilToday();
  const one = isUuid(opts.employeeId) ? sql`AND e.id = ${String(opts.employeeId)}::uuid` : sql``;
  try {
    const r = rows(await db.execute(sql`
      SELECT e.id, e.full_name, e.email, e.designation, e.employment_type, e.joining_date,
             o.content->>'duration' AS offer_duration, o.joining_date AS offer_joining,
             c.end_date_override, c.lead_notified_at, c.lead_decision, c.lead_note, c.lor_serial,
             c.outcome, c.outcome_at, c.outcome_note, c.certificate_serial, c.criteria
        FROM hr_employees e
        LEFT JOIN LATERAL (
          SELECT content, joining_date FROM offer_letters
           WHERE application_id = e.application_id AND status IN ('sent', 'signed')
           ORDER BY created_at DESC LIMIT 1
        ) o ON TRUE
        LEFT JOIN hr_engagement_completions c ON c.employee_id = e.id
       WHERE e.is_active = true ${one}
       LIMIT 1000`));
    const list = r.map((x: any) => mapEngagement(x, today))
      .filter((x) => isFixedTerm(x.employmentType, !!x.durationText) || x.endSource === 'override' || !!x.outcome);
    list.sort((a, b) => {
      if (a.endDate && b.endDate) return a.endDate < b.endDate ? -1 : a.endDate > b.endDate ? 1 : 0;
      return a.endDate ? -1 : b.endDate ? 1 : a.fullName.localeCompare(b.fullName);
    });
    return { ready: true, value: list };
  } catch (e: any) {
    return { ready: false, error: isMissingTable(e) ? NOT_SET_UP : 'The engagements could not be read: ' + why(e) };
  }
}

async function upsert(employeeId: string, set: Record<string, any>): Promise<void> {
  // A fixed column list, written in full; values bound as parameters.
  const cols = ['end_date_override', 'lead_notified_at', 'lead_user_id', 'lead_decision', 'lead_decided_at',
    'lead_decided_by', 'lead_note', 'lor_serial', 'outcome', 'outcome_at', 'outcome_by', 'outcome_note',
    'certificate_serial', 'criteria'];
  await db.execute(sql`INSERT INTO hr_engagement_completions (employee_id) VALUES (${employeeId}::uuid) ON CONFLICT (employee_id) DO NOTHING`);
  for (const k of Object.keys(set)) {
    if (!cols.includes(k)) throw new Error('Unknown completion column ' + k);
    const v = set[k];
    const val = k === 'criteria' ? (v == null ? null : JSON.stringify(v)) : v;
    if (k === 'criteria') {
      await db.execute(sql`UPDATE hr_engagement_completions SET criteria = ${val}::jsonb, updated_at = NOW() WHERE employee_id = ${employeeId}::uuid`);
    } else {
      await db.execute(sql`UPDATE hr_engagement_completions SET ${sql.raw(k)} = ${val}, updated_at = NOW() WHERE employee_id = ${employeeId}::uuid`);
    }
  }
}

// -------------------------------------------------------------------------------------------------
// EVALUATE
// -------------------------------------------------------------------------------------------------

export interface EvaluationDetail {
  evaluation: Evaluation;
  creditHours: number;
  creditsLine: string;
  achievements: string[];
}

/** Measure one engagement, with the same ledger reads the completion page makes. */
export async function evaluateEngagement(e: Engagement): Promise<EvaluationDetail> {
  const terms = await termsFor(e.employeeId);
  const ledger = await ledgerFor(e.employeeId, terms);
  const reviewRead = await reviewsForDetailed(e.employeeId);
  const achievements = reviewRead.reviews.filter((r) => (r.rating || 0) >= 4).map((r) => r.note).filter(Boolean).slice(0, 6);
  const figures = completionFigures({
    name: e.fullName, role: e.designation, startDate: e.startDate, endDate: e.endDate || civilToday(),
    terms, summary: ledger.summary, reviews: reviewRead.reviews, achievements,
  });
  await syncCreditDecisions(e.employeeId).catch(() => null);
  const credit = await reconcileCreditWeeks(e.employeeId, { maxWeeks: 104 });
  const position = positionFrom(credit.weeks);
  const evaluation = evaluateCriteria({
    figuresMeasured: ledger.ok && reviewRead.ok && credit.ok,
    eligible: figures.eligible,
    eligibilityReason: figures.reason,
    attendanceKnown: ledger.summary.daysPresent > 0,
    attendancePct: ledger.summary.attendancePct,
    reviewCount: figures.reviewCount,
    averageRating: figures.averageRating,
    unauthorisedLeaveDays: ledger.summary.unauthorisedLeaveDays,
    creditApplicable: credit.ok && credit.applicable,
    pendingCreditWeeks: position.pending,
    leadDecision: e.leadDecision,
    hasEmail: !!e.email,
  });
  const creditsLine = credit.ok && credit.applicable && position.credits > 0
    ? creditsLabel(position.credits) + ' earned, one credit per completed week of measured work.'
    : figures.creditHours > 0 ? figures.creditHours + ' hours of measured work recorded.' : '';
  return { evaluation, creditHours: figures.creditHours, creditsLine, achievements };
}

// -------------------------------------------------------------------------------------------------
// ACT
// -------------------------------------------------------------------------------------------------

/** Ask the lead to review. Falls back to the HR desk when nobody is recorded as the lead. */
export async function notifyLead(e: Engagement, actorUserId: string | null): Promise<{ ok: boolean; message: string }> {
  const { sendPushToUser, sendPushToAdmins } = await import('@/lib/push');
  const endWords = e.endDate ? (e.daysLeft != null && e.daysLeft >= 0 ? 'ends on ' + e.endDate : 'ended on ' + e.endDate) : 'is ending';
  const kind = /intern/i.test(e.employmentType) ? 'internship' : /apprentic/i.test(e.employmentType) ? 'apprenticeship' : 'engagement';
  let leadUserId: string | null = null;
  let leadName = '';
  try {
    const m = await getManagerCompat(e.employeeId);
    leadUserId = m.value?.userId || null;
    leadName = m.value?.fullName || '';
  } catch (err: any) {
    console.error('[completion-engine] lead lookup', why(err));
  }
  try {
    if (leadUserId) {
      await sendPushToUser(leadUserId, {
        type: 'completion_review',
        title: e.fullName + "'s " + kind + ' ' + (e.daysLeft != null && e.daysLeft < 0 ? 'has ended' : 'is ending'),
        body: 'It ' + endWords + '. Review it, approve or hold the completion, and write their letter of recommendation.',
        url: '/portal/manager/completion/' + e.employeeId,
        tag: 'completion-' + e.employeeId,
      });
    } else {
      await sendPushToAdmins({
        type: 'completion_review',
        title: e.fullName + "'s " + kind + ' ' + endWords.replace(/^ends/, 'ends'),
        body: 'No lead is recorded for them, so the review comes to the People desk.',
        url: '/admin/hr/completions?employee=' + e.employeeId,
        tag: 'completion-' + e.employeeId,
      });
    }
    await upsert(e.employeeId, { lead_notified_at: new Date(), lead_user_id: leadUserId });
    await logAudit({
      userId: actorUserId, action: 'hr.completion.lead_notified', entity: 'hr_engagement', entityId: e.employeeId,
      diff: { leadUserId, endDate: e.endDate },
    }).catch(() => {});
    return { ok: true, message: leadUserId ? 'Asked ' + (leadName || 'their lead') + ' to review.' : 'No lead is recorded, so the People desk was notified instead.' };
  } catch (err: any) {
    return { ok: false, message: isMissingTable(err) ? NOT_SET_UP : 'The lead was not notified: ' + why(err) };
  }
}

/**
 * Record and email the completion certificate. Reuses one already issued for this engagement.
 * `note` is required when a person issues it over a failed criterion; the engine never does that.
 */
export async function issueCompletionCertificate(
  e: Engagement, detail: EvaluationDetail | null,
  by: { userId: string | null; name: string; auto: boolean; note?: string },
): Promise<{ ok: boolean; serial?: string; message: string }> {
  const kind = /intern|apprentic|trainee/i.test(e.employmentType) ? 'internship' : 'employment';
  try {
    let row = e.certificateSerial ? await getUniversalForAdmin(e.certificateSerial) : null;
    if (!row || row.revoked) row = await universalForEmployee(e.employeeId, kind);
    let serial = row?.serial ? String(row.serial) : '';
    if (!serial) {
      const skills = await skillsForEmployee(e.employeeId);
      const title = kind === 'internship'
        ? (e.designation || 'Internship').replace(/\bIntern\b/i, 'Internship')
        : (e.designation || 'Engagement');
      const r = await issueUniversalCertificate({
        kind, recipientName: e.fullName, recipientEmail: e.email || undefined, recipientEmployeeId: e.employeeId,
        title, issuedByUserId: by.userId || undefined,
        issuedByName: ENGINE_SIGNATORY.name, issuedByDesignation: ENGINE_SIGNATORY.title,
        metadata: {
          fromDate: e.startDate, toDate: e.endDate || civilToday(),
          achievements: detail?.achievements || [], skills, measureLine: detail?.creditsLine || '',
          issuedBy: by.auto ? 'completion-engine' : 'people-desk',
        },
      });
      if (!r.ok || !r.serial) return { ok: false, message: 'The certificate could not be recorded, so nothing was issued.' };
      serial = String(r.serial);
      row = await getUniversalForAdmin(serial);
    }
    await upsert(e.employeeId, {
      outcome: 'certificate_issued', outcome_at: new Date(), outcome_by: by.userId,
      outcome_note: by.note || (by.auto ? 'Issued automatically: every criterion passed.' : 'Issued by the People desk.'),
      certificate_serial: serial, criteria: detail?.evaluation || null,
    });
    await logAudit({
      userId: by.userId, action: by.auto ? 'hr.completion.certificate_auto_issued' : 'hr.completion.certificate_issued',
      entity: 'hr_engagement', entityId: e.employeeId, diff: { serial, note: by.note || '' },
    }).catch(() => {});
    let mail = 'It has no email address on record, so it was not sent.';
    if (e.email && row) {
      const sent = await emailUniversalCertificate(row, e.email, '', by.userId);
      mail = sent.message;
    }
    return { ok: true, serial, message: 'Certificate ' + serial + ' issued. ' + mail };
  } catch (err: any) {
    return { ok: false, message: isMissingTable(err) ? NOT_SET_UP : 'The certificate was not issued: ' + why(err) };
  }
}

export async function holdCompletion(e: Engagement, detail: EvaluationDetail | null, by: { userId: string | null; note: string }): Promise<void> {
  await upsert(e.employeeId, {
    outcome: 'held', outcome_at: new Date(), outcome_by: by.userId, outcome_note: by.note, criteria: detail?.evaluation || null,
  });
  await logAudit({ userId: by.userId, action: 'hr.completion.held', entity: 'hr_engagement', entityId: e.employeeId, diff: { note: by.note } }).catch(() => {});
}

export async function reopenCompletion(employeeId: string, userId: string | null): Promise<void> {
  await upsert(employeeId, { outcome: null, outcome_at: null, outcome_by: null, outcome_note: null });
  await logAudit({ userId, action: 'hr.completion.reopened', entity: 'hr_engagement', entityId: employeeId }).catch(() => {});
}

export async function setEndDate(employeeId: string, iso: string | null, userId: string | null): Promise<void> {
  await upsert(employeeId, { end_date_override: iso || null });
  await logAudit({ userId, action: 'hr.completion.end_date_set', entity: 'hr_engagement', entityId: employeeId, diff: { endDate: iso } }).catch(() => {});
}

export async function recordLeadDecision(
  employeeId: string, decision: 'approved' | 'held', note: string, userId: string | null, lorSerial?: string | null,
): Promise<void> {
  const set: Record<string, any> = { lead_decision: decision, lead_decided_at: new Date(), lead_decided_by: userId, lead_note: note || null };
  if (lorSerial) set.lor_serial = lorSerial;
  await upsert(employeeId, set);
  await logAudit({ userId, action: 'hr.completion.lead_' + decision, entity: 'hr_engagement', entityId: employeeId, diff: { note, lorSerial: lorSerial || null } }).catch(() => {});
}

// -------------------------------------------------------------------------------------------------
// RUN
// -------------------------------------------------------------------------------------------------

export interface RunLine { employeeId: string; name: string; step: string; result: string }

/**
 * One pass. Bounded: evaluating an engagement reads its whole ledger, so at most `limit` are
 * evaluated per pass and the rest wait for the next one. Notifications are cheap and not bounded.
 */
export async function runEngine(opts: { dryRun?: boolean; limit?: number; actorUserId?: string | null; onlyEmployeeId?: string } = {}): Promise<{ ok: boolean; error?: string; lines: RunLine[] }> {
  const limit = Math.min(Math.max(opts.limit || 8, 1), 25);
  const list = await listEngagements({ employeeId: opts.onlyEmployeeId });
  if (!list.ready) return { ok: false, error: list.error, lines: [] };
  const lines: RunLine[] = [];
  let evaluated = 0;
  for (const e of list.value) {
    const step = nextStep({ daysLeft: e.daysLeft, leadNotified: !!e.leadNotifiedAt, outcome: e.outcome });
    if (step === 'none') continue;
    if (step === 'notify_lead') {
      if (opts.dryRun) { lines.push({ employeeId: e.employeeId, name: e.fullName, step, result: 'would ask the lead to review (ends ' + e.endDate + ')' }); continue; }
      const r = await notifyLead(e, opts.actorUserId || null);
      lines.push({ employeeId: e.employeeId, name: e.fullName, step, result: r.message });
      continue;
    }
    // evaluate
    if (evaluated >= limit) { lines.push({ employeeId: e.employeeId, name: e.fullName, step, result: 'waiting for the next pass' }); continue; }
    evaluated++;
    try {
      if (!e.leadNotifiedAt && !opts.dryRun) await notifyLead(e, opts.actorUserId || null);
      const detail = await evaluateEngagement(e);
      if (opts.dryRun) {
        lines.push({ employeeId: e.employeeId, name: e.fullName, step, result: detail.evaluation.allPassed ? 'would issue the certificate' : 'would hold: ' + detail.evaluation.blocking.map((b) => b.label).join(', ') });
        continue;
      }
      if (detail.evaluation.allPassed) {
        const r = await issueCompletionCertificate(e, detail, { userId: opts.actorUserId || null, name: 'Completion engine', auto: true });
        lines.push({ employeeId: e.employeeId, name: e.fullName, step: 'issue', result: r.message });
      } else {
        const note = 'Held for a decision: ' + detail.evaluation.blocking.map((b) => b.label + ' (' + b.detail + ')').join('; ');
        await holdCompletion(e, detail, { userId: opts.actorUserId || null, note });
        const { sendPushToAdmins } = await import('@/lib/push');
        await sendPushToAdmins({
          type: 'completion_review',
          title: e.fullName + ': completion needs a decision',
          body: detail.evaluation.blocking.map((b) => b.label).join(', ') + ' did not pass. Decide on the completions desk.',
          url: '/admin/hr/completions?employee=' + e.employeeId,
          tag: 'completion-hold-' + e.employeeId,
        }).catch(() => {});
        lines.push({ employeeId: e.employeeId, name: e.fullName, step: 'hold', result: note });
      }
    } catch (err: any) {
      lines.push({ employeeId: e.employeeId, name: e.fullName, step, result: 'Could not evaluate: ' + why(err) });
    }
  }
  return { ok: true, lines };
}
