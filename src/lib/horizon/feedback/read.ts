// src/lib/horizon/feedback/read.ts — THE IO. Rows in, FeedbackItem[] out, and nothing else.
//
// =================================================================================================
// THREE QUERIES, NEVER 1 + 2N
// =================================================================================================
//
// A feedback item has two child lists. Fetching them per parent is 1 + 2N round trips, and a round
// trip to this database measures ~139ms from the deployed function — thirty items on a manager's
// screen would be over eight seconds of latency before anything renders. So: one query for the
// parents, one for every dimension row across all of them, one for every example, then stitched in
// memory. The batch reader (readStructuredItemsFor) keeps the same three for a whole team.
//
// =================================================================================================
// LEGACY ROWS ARE NOT RETRO-FITTED, AND THE FILTER IS `source_type IS NOT NULL`
// =================================================================================================
//
// hr_feedback holds unstructured notes written by the older feedback surface. They have no source
// type, no period and no dimension ratings. Nothing here guesses one for them: a note with no
// dimension rows contributes to no dimension score, and inventing a source type would fabricate the
// single field the whole weighting model reasons about. They stay visible on the older surface,
// which is where they were written and where they read correctly.
//
// The partial index in schema.ts is on exactly this predicate, so the filter is also the fast path.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { isUuid, logFail, rowsOf, uuidList } from '@/lib/performance-scope';
import { ensureHorizonFeedbackSchema } from './schema';
import {
  isFeedbackDimension,
  isFeedbackSourceType,
  type EvidenceQuality,
  type FeedbackConfidentiality,
  type FeedbackContext,
  type FeedbackDimension,
  type FeedbackExample,
  type FeedbackItem,
  type FeedbackItemStatus,
} from './types';

const MOD = 'horizon-feedback-read';

/** How many items one subject's aggregate reads. Beyond this the oldest stop counting anyway. */
export const MAX_ITEMS_PER_SUBJECT = 300;

const iso = (v: any): string => {
  if (!v) return '';
  try {
    return new Date(v).toISOString();
  } catch {
    return '';
  }
};

const dateOnly = (v: any): string | null => {
  if (!v) return null;
  const s = iso(v);
  return s ? s.slice(0, 10) : null;
};

function mapItem(r: any): FeedbackItem | null {
  const sourceType = r?.source_type;
  if (!isFeedbackSourceType(sourceType)) return null;
  const authorEmployeeId = r?.author_employee_id ? String(r.author_employee_id) : null;
  const authorUserId = r?.author_user_id ? String(r.author_user_id) : null;
  // ONE HUMAN, ONE VOICE. The saturation caps are keyed on this, so an author who has both ids must
  // resolve to the SAME key every time or they become two sources and the cap stops working.
  // Employee id first because it is the stabler of the two: a person can be given a new login.
  const authorKey = authorEmployeeId || authorUserId || ('anon:' + String(r?.id || ''));
  const status = String(r?.status || 'submitted');
  return {
    id: String(r?.id || ''),
    subjectEmployeeId: String(r?.subject_employee_id || ''),
    sourceType,
    sourceVerified: r?.source_verified === true,
    sourceVerifiedNote: r?.source_verified_note ? String(r.source_verified_note) : null,
    authorKey,
    authorUserId,
    authorEmployeeId,
    authorName: r?.author_name ? String(r.author_name) : (r?.author_full_name ? String(r.author_full_name) : 'A colleague'),
    context: (r?.context ? String(r.context) : 'day_to_day') as FeedbackContext,
    contextNote: r?.context_note ? String(r.context_note) : null,
    periodStart: dateOnly(r?.period_start),
    periodEnd: dateOnly(r?.period_end),
    evidence: r?.evidence ? String(r.evidence) : '',
    // A row written before evidence_quality existed, or by a path that did not set it, is treated as
    // 'none'. That is the LOWEST weight, which is the safe direction: an unknown is never promoted.
    evidenceQuality: (r?.evidence_quality ? String(r.evidence_quality) : 'none') as EvidenceQuality,
    confidentiality: (r?.confidentiality ? String(r.confidentiality) : 'standard') as FeedbackConfidentiality,
    status: (['draft', 'submitted', 'withdrawn'].indexOf(status) >= 0 ? status : 'submitted') as FeedbackItemStatus,
    ratings: [],
    examples: [],
    createdAt: iso(r?.created_at),
    withdrawnAt: r?.withdrawn_at ? iso(r.withdrawn_at) : null,
    withdrawnReason: r?.withdrawn_reason ? String(r.withdrawn_reason) : null,
    cycleId: r?.cycle_id ? String(r.cycle_id) : null,
  };
}

/** Attach the two child lists to a set of parents, in two queries whatever the parent count. */
async function attachChildren(items: FeedbackItem[]): Promise<FeedbackItem[]> {
  const ids = items.map((i) => i.id).filter(isUuid);
  if (!ids.length) return items;
  const byId = new Map(items.map((i) => [i.id, i]));

  try {
    const dims = rowsOf(await db.execute(sql`
      SELECT feedback_id, dimension, rating, comment
        FROM hr_feedback_dimensions
       WHERE feedback_id IN (${uuidList(ids)})`));
    for (const d of dims) {
      const parent = byId.get(String(d.feedback_id));
      if (!parent) continue;
      const dim = String(d.dimension);
      if (!isFeedbackDimension(dim)) continue; // a dimension retired from the vocabulary is ignored
      parent.ratings.push({
        dimension: dim as FeedbackDimension,
        rating: Number(d.rating),
        comment: d.comment ? String(d.comment) : null,
      });
    }
  } catch (e: any) {
    logFail(MOD, 'attachChildren.dimensions', e);
  }

  try {
    const exs = rowsOf(await db.execute(sql`
      SELECT id, feedback_id, dimension, occurred_on, description, reference_url
        FROM hr_feedback_examples
       WHERE feedback_id IN (${uuidList(ids)})
       ORDER BY occurred_on DESC NULLS LAST, created_at DESC`));
    for (const e of exs) {
      const parent = byId.get(String(e.feedback_id));
      if (!parent) continue;
      const dim = e.dimension ? String(e.dimension) : null;
      const example: FeedbackExample = {
        id: String(e.id),
        dimension: dim && isFeedbackDimension(dim) ? (dim as FeedbackDimension) : null,
        occurredOn: dateOnly(e.occurred_on),
        description: String(e.description || ''),
        referenceUrl: e.reference_url ? String(e.reference_url) : null,
      };
      parent.examples.push(example);
    }
  } catch (e: any) {
    logFail(MOD, 'attachChildren.examples', e);
  }

  return items;
}

/**
 * Every structured item about one person.
 *
 * RETURNS EVERYTHING, INCLUDING hr_channel AND DRAFTS. Redaction is visibility.ts's job and happens
 * ONE layer up, on purpose: the aggregate has to be computed over the whole record or a reporting
 * manager could infer the content of a withheld item by watching the number move. See the note on
 * redactSignal().
 *
 * Empty array on any failure. A feedback screen that throws is a screen that tells its reader there
 * is something there.
 */
export async function readStructuredItems(
  subjectEmployeeId: string,
  opts: { limit?: number; includeWithdrawn?: boolean } = {},
): Promise<FeedbackItem[]> {
  if (!isUuid(subjectEmployeeId)) return [];
  const lim = Math.min(Math.max(Number(opts.limit) || MAX_ITEMS_PER_SUBJECT, 1), MAX_ITEMS_PER_SUBJECT);
  try {
    await ensureHorizonFeedbackSchema();
    const withdrawnFilter = opts.includeWithdrawn ? sql`` : sql`AND f.status <> 'withdrawn'`;
    const rows = rowsOf(await db.execute(sql`
      SELECT f.id, f.subject_employee_id, f.author_user_id, f.author_employee_id, f.author_name,
             f.cycle_id, f.source_type, f.source_verified, f.source_verified_note,
             f.context, f.context_note, f.period_start, f.period_end,
             f.evidence, f.evidence_quality, f.confidentiality, f.status,
             f.withdrawn_at, f.withdrawn_reason, f.created_at,
             ae.full_name AS author_full_name
        FROM hr_feedback f
        LEFT JOIN hr_employees ae ON ae.id = f.author_employee_id
       WHERE f.subject_employee_id = ${subjectEmployeeId}::uuid
         AND f.source_type IS NOT NULL
         ${withdrawnFilter}
       ORDER BY f.created_at DESC
       LIMIT ${lim}`));
    const items = rows.map(mapItem).filter(Boolean) as FeedbackItem[];
    return attachChildren(items);
  } catch (e: any) {
    logFail(MOD, 'readStructuredItems', e);
    return [];
  }
}

/**
 * The same, for many people at once, in three queries total.
 *
 * This is what PATCH 06 and PATCH 10 need: a team view that calls the single reader per employee is
 * 3N round trips, which at ~139ms each is where a "why is this page slow" ticket comes from.
 */
export async function readStructuredItemsFor(
  subjectEmployeeIds: string[],
  opts: { perSubjectLimit?: number } = {},
): Promise<Map<string, FeedbackItem[]>> {
  const out = new Map<string, FeedbackItem[]>();
  const ids = Array.from(new Set((subjectEmployeeIds || []).filter(isUuid)));
  if (!ids.length) return out;
  for (const id of ids) out.set(id, []);
  const perSubject = Math.min(Math.max(Number(opts.perSubjectLimit) || 100, 1), MAX_ITEMS_PER_SUBJECT);

  try {
    await ensureHorizonFeedbackSchema();
    // ROW_NUMBER rather than a LIMIT, because a plain LIMIT over the union would give the whole
    // budget to whoever has the most feedback and return nothing at all for somebody quiet.
    const rows = rowsOf(await db.execute(sql`
      SELECT * FROM (
        SELECT f.id, f.subject_employee_id, f.author_user_id, f.author_employee_id, f.author_name,
               f.cycle_id, f.source_type, f.source_verified, f.source_verified_note,
               f.context, f.context_note, f.period_start, f.period_end,
               f.evidence, f.evidence_quality, f.confidentiality, f.status,
               f.withdrawn_at, f.withdrawn_reason, f.created_at,
               ae.full_name AS author_full_name,
               ROW_NUMBER() OVER (PARTITION BY f.subject_employee_id ORDER BY f.created_at DESC) AS rn
          FROM hr_feedback f
          LEFT JOIN hr_employees ae ON ae.id = f.author_employee_id
         WHERE f.subject_employee_id IN (${uuidList(ids)})
           AND f.source_type IS NOT NULL
           AND f.status <> 'withdrawn'
      ) t
      WHERE t.rn <= ${perSubject}`));
    const items = rows.map(mapItem).filter(Boolean) as FeedbackItem[];
    await attachChildren(items);
    for (const item of items) {
      const list = out.get(item.subjectEmployeeId);
      if (list) list.push(item);
    }
  } catch (e: any) {
    logFail(MOD, 'readStructuredItemsFor', e);
  }
  return out;
}

/**
 * An item as its AUTHOR sees it. The subject's name rides along, because the "feedback I wrote"
 * list is about them, not about us — a list of ids would be unreadable.
 */
export type AuthoredFeedbackItem = FeedbackItem & { subjectName: string };

/** What this author has written, so they can find and withdraw their own. */
export async function readItemsByAuthor(userId: string, limit = 50): Promise<AuthoredFeedbackItem[]> {
  if (!isUuid(userId)) return [];
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  try {
    await ensureHorizonFeedbackSchema();
    const rows = rowsOf(await db.execute(sql`
      SELECT f.id, f.subject_employee_id, f.author_user_id, f.author_employee_id, f.author_name,
             f.cycle_id, f.source_type, f.source_verified, f.source_verified_note,
             f.context, f.context_note, f.period_start, f.period_end,
             f.evidence, f.evidence_quality, f.confidentiality, f.status,
             f.withdrawn_at, f.withdrawn_reason, f.created_at,
             se.full_name AS subject_name
        FROM hr_feedback f
        LEFT JOIN hr_employees se ON se.id = f.subject_employee_id
       WHERE f.author_user_id = ${userId}::uuid
         AND f.source_type IS NOT NULL
       ORDER BY f.created_at DESC
       LIMIT ${lim}`));
    const items = rows.map(mapItem).filter(Boolean) as FeedbackItem[];
    const names = new Map<string, string>(
      rows.map((r: any) => [String(r.id), r.subject_name ? String(r.subject_name) : 'Unnamed record']),
    );
    await attachChildren(items);
    return items.map((i) => ({ ...i, subjectName: names.get(i.id) || 'Unnamed record' }));
  } catch (e: any) {
    logFail(MOD, 'readItemsByAuthor', e);
    return [];
  }
}

/** One item with its children, for a detail panel or a withdrawal confirmation. */
export async function readItem(feedbackId: string): Promise<FeedbackItem | null> {
  if (!isUuid(feedbackId)) return null;
  try {
    await ensureHorizonFeedbackSchema();
    const rows = rowsOf(await db.execute(sql`
      SELECT f.*, ae.full_name AS author_full_name
        FROM hr_feedback f
        LEFT JOIN hr_employees ae ON ae.id = f.author_employee_id
       WHERE f.id = ${feedbackId}::uuid
       LIMIT 1`));
    if (!rows.length) return null;
    const item = mapItem(rows[0]);
    if (!item) return null;
    const [withKids] = await attachChildren([item]);
    return withKids;
  } catch (e: any) {
    logFail(MOD, 'readItem', e);
    return null;
  }
}

/**
 * WHO STILL OWES FEEDBACK. The people this viewer could write about and has not, this period.
 *
 * Not a nag list and not a compliance score. It exists because the single largest cause of a
 * one-source aggregate is that nobody asked the other four people, and a screen that cannot say who
 * is missing cannot fix that.
 */
export async function outstandingFor(
  authorUserId: string,
  candidateEmployeeIds: string[],
  sinceIso: string,
): Promise<Set<string>> {
  const out = new Set<string>(candidateEmployeeIds.filter(isUuid));
  if (!isUuid(authorUserId) || out.size === 0) return out;
  try {
    await ensureHorizonFeedbackSchema();
    const rows = rowsOf(await db.execute(sql`
      SELECT DISTINCT subject_employee_id
        FROM hr_feedback
       WHERE author_user_id = ${authorUserId}::uuid
         AND source_type IS NOT NULL
         AND status = 'submitted'
         AND created_at >= ${sinceIso}::timestamptz
         AND subject_employee_id IN (${uuidList(Array.from(out))})`));
    for (const r of rows) out.delete(String(r.subject_employee_id));
  } catch (e: any) {
    logFail(MOD, 'outstandingFor', e);
  }
  return out;
}
