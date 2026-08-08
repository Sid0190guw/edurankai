// src/lib/hei-editorial.ts — the storage the HEI editorial desks were written against and which
// this repository never created.
//
// WHAT WAS WRONG. Six admin surfaces under /admin/hei read and write tables that have no CREATE
// TABLE anywhere in src/ or db/, and no pgTable in src/lib/db/schema.ts:
//     hei_leads            /admin/hei/leads, /admin/hei (dashboard queue + counter)
//     hei_legal_queue      /admin/hei/legal
//     hei_right_of_reply   /admin/hei/replies
//     hei_rti_filings      /admin/hei/rti
//     hei_survey_forms     /admin/hei/surveys
//     hei_survey_responses /admin/hei/surveys (count), /admin/hei (counter)
//     hei_evidence_locks   /admin/hei (the sign-off workbench)
// Every list query on those pages is wrapped in `catch(e) {}`, so all six rendered as clean, empty
// desks — an editorial system that looked idle rather than one that could not read. Every write
// threw and surfaced a raw Postgres string, or on the dashboard nothing at all. The layout's own
// sidebar counters (HeiAdminLayout) read the same tables and showed nothing for the same reason.
//
// NO MIGRATIONS EXIST ON THIS PROJECT — every module here self-bootstraps. This follows that
// pattern: CREATE TABLE IF NOT EXISTS only, inside a single ensureOnce guard so the DDL runs at
// most once per process instead of on every page load.
//
// IF ANY OF THESE ALREADY EXIST IN PRODUCTION with a different shape, CREATE TABLE IF NOT EXISTS is
// a no-op and this file changes nothing about them. It cannot make an existing table worse; it can
// only stop a fresh environment from having six desks that silently do not work.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';

/** postgres-js resolves to a plain array, never a { rows } object. */
export const heiRows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** The real Postgres reason lives on e.cause; e.message is only the failed SQL. */
export const heiReason = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

export function ensureHeiEditorialSchema(): Promise<void> {
  return ensureOnce('hei_editorial', async () => {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS hei_leads (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL,
      summary TEXT,
      priority VARCHAR(20) DEFAULT 'medium',
      category VARCHAR(40) DEFAULT 'general',
      pipeline VARCHAR(10),
      institution_id UUID,
      institution_name TEXT,
      confidence_pct INT DEFAULT 0,
      status VARCHAR(30) DEFAULT 'needs_review',
      assigned_to UUID,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

    await db.execute(sql`CREATE TABLE IF NOT EXISTS hei_legal_queue (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL,
      risk_type VARCHAR(40),
      notes TEXT,
      finding_id UUID,
      status VARCHAR(20) DEFAULT 'open',
      created_by UUID,
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

    await db.execute(sql`CREATE TABLE IF NOT EXISTS hei_right_of_reply (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      finding_id UUID,
      institution_name TEXT,
      sent_at TIMESTAMPTZ,
      deadline_at TIMESTAMPTZ,
      status VARCHAR(20) DEFAULT 'sent',
      response_text TEXT,
      response_received_at TIMESTAMPTZ,
      modifier_score NUMERIC(5,2) DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

    await db.execute(sql`CREATE TABLE IF NOT EXISTS hei_rti_filings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      subject TEXT NOT NULL,
      institution_name TEXT,
      filed_at TIMESTAMPTZ,
      status VARCHAR(20) DEFAULT 'filed',
      notes TEXT,
      response_text TEXT,
      responded_at TIMESTAMPTZ,
      filed_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

    await db.execute(sql`CREATE TABLE IF NOT EXISTS hei_survey_forms (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL,
      slug VARCHAR(200) UNIQUE,
      description TEXT,
      questions JSONB DEFAULT '[]'::jsonb,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

    // Survey answers are what a student said about an institution. There is deliberately no column
    // for a name, an email or a user id: the only surface that writes this table is a public form,
    // and a respondent who cannot be identified cannot be retaliated against. institution_name is
    // free text the respondent typed, not a link to an account.
    await db.execute(sql`CREATE TABLE IF NOT EXISTS hei_survey_responses (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      form_id UUID,
      institution_name TEXT,
      answers JSONB DEFAULT '{}'::jsonb,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

    await db.execute(sql`CREATE TABLE IF NOT EXISTS hei_evidence_locks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      finding_id UUID,
      label TEXT,
      evidence_url TEXT,
      is_locked BOOLEAN NOT NULL DEFAULT false,
      locked_by UUID,
      locked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  });
}

// =================================================================================================
// EVIDENCE LOCKS — the sign-off gate that had no way to be satisfied.
//
// /admin/hei/index.astro renders, on every finding awaiting sign-off:
//     IN REVIEW · {locked_count}/{total_locks} EVIDENCE LOCKED
// from two sub-selects over hei_evidence_locks. That table is CREATEd above and there was not one
// INSERT into it anywhere in the repository, and no lock control on /admin/hei/findings — whose
// actions are create_draft / send_notice / set_response_quality / publish / unpublish / delete.
//
// So the badge read 0/0 for every finding, forever. That is worse than absent: a reviewer reads
// "0/0" as "nobody has locked the evidence yet" — a fact about the workflow — rather than "locking
// is not implemented", and can publish a finding about a NAMED INSTITUTION believing a gate stood
// behind it. The number cannot move, so it can never warn anybody.
//
// These four functions are that missing half. Evidence is attached to a finding, then locked; a
// locked row records who locked it and when, and cannot be silently edited afterwards — unlock is a
// separate, deliberate act. addEvidence/lockEvidence are called from /admin/hei/findings and the
// counts are what /admin/hei has been displaying all along.
// =================================================================================================

export interface EvidenceRow {
  id: string;
  findingId: string;
  label: string;
  evidenceUrl: string | null;
  isLocked: boolean;
  lockedBy: string | null;
  lockedAt: string | null;
}

export type EvidenceResult =
  | { ok: true; rows: EvidenceRow[] }
  | { ok: false; reason: string };

function toEvidence(r: any): EvidenceRow {
  return {
    id: String(r.id),
    findingId: r.finding_id ? String(r.finding_id) : '',
    label: String(r.label || 'Untitled evidence'),
    evidenceUrl: r.evidence_url || null,
    isLocked: !!r.is_locked,
    lockedBy: r.locked_by ? String(r.locked_by) : null,
    lockedAt: r.locked_at ? String(r.locked_at) : null,
  };
}

/**
 * The evidence attached to one finding.
 *
 * Discriminated, because "no evidence has been attached" and "we could not read the evidence table"
 * must not both render as an empty list on a screen whose whole job is deciding whether a finding
 * about a named institution is safe to publish.
 */
export async function listEvidence(findingId: string): Promise<EvidenceResult> {
  if (!findingId) return { ok: true, rows: [] };
  try {
    await ensureHeiEditorialSchema();
    const r = await db.execute(sql`
      SELECT id, finding_id, label, evidence_url, is_locked, locked_by, locked_at
      FROM hei_evidence_locks WHERE finding_id = ${findingId}::uuid
      ORDER BY created_at ASC`);
    return { ok: true, rows: heiRows(r).map(toEvidence) };
  } catch (e: any) {
    const reason = heiReason(e);
    console.error('[hei-editorial] listEvidence', reason);
    return { ok: false, reason };
  }
}

/**
 * Attach a piece of evidence to a finding. Documents are LINKS on this project, never uploads, so
 * evidence_url is a URL and is validated as one.
 */
export async function addEvidence(
  findingId: string,
  label: string,
  evidenceUrl: string,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const name = String(label || '').trim();
  if (!findingId) return { ok: false, error: 'No finding was identified.' };
  if (name.length < 3) return { ok: false, error: 'Give the evidence a label of at least 3 characters, so a reviewer can tell the items apart.' };
  const url = String(evidenceUrl || '').trim();
  if (!url) return { ok: false, error: 'Give the link to the evidence. Evidence nobody can open cannot support a published finding.' };
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'The evidence link must start with http:// or https://.' };
  try {
    await ensureHeiEditorialSchema();
    const r = heiRows(await db.execute(sql`
      INSERT INTO hei_evidence_locks (finding_id, label, evidence_url, is_locked)
      VALUES (${findingId}::uuid, ${name.slice(0, 300)}, ${url.slice(0, 2000)}, false)
      RETURNING id`));
    if (!r[0]?.id) return { ok: false, error: 'The evidence was not attached. Nothing has been recorded.' };
    return { ok: true, id: String(r[0].id) };
  } catch (e: any) {
    const reason = heiReason(e);
    console.error('[hei-editorial] addEvidence', reason);
    return { ok: false, error: reason };
  }
}

/**
 * Lock or unlock one piece of evidence.
 *
 * Locking stamps WHO and WHEN. The UPDATE is guarded on the row not already being in the target
 * state, so a double-submit cannot rewrite an earlier locker's name and timestamp onto somebody
 * else's decision.
 */
export async function lockEvidence(
  evidenceId: string,
  actorUserId: string,
  locked: boolean,
): Promise<{ ok: true; changed: boolean } | { ok: false; error: string }> {
  if (!evidenceId) return { ok: false, error: 'No evidence item was identified.' };
  if (!actorUserId) return { ok: false, error: 'Only a signed-in editor can lock evidence.' };
  try {
    await ensureHeiEditorialSchema();
    const r = heiRows(await db.execute(sql`
      UPDATE hei_evidence_locks
      SET is_locked = ${locked},
          locked_by = ${locked ? actorUserId : null},
          locked_at = ${locked ? sql`NOW()` : sql`NULL`}
      WHERE id = ${evidenceId}::uuid AND is_locked <> ${locked}
      RETURNING id`));
    return { ok: true, changed: r.length > 0 };
  } catch (e: any) {
    const reason = heiReason(e);
    console.error('[hei-editorial] lockEvidence', reason);
    return { ok: false, error: reason };
  }
}

/**
 * The pair of numbers /admin/hei has always displayed, computed where the rest of the codebase can
 * reach them. `total === 0` genuinely means no evidence has been attached — which, now that
 * attaching is possible, is a statement about the finding rather than about the software.
 */
export async function evidenceLockCounts(findingId: string): Promise<{ ok: true; locked: number; total: number } | { ok: false; reason: string }> {
  const res = await listEvidence(findingId);
  if (!res.ok) return { ok: false, reason: res.reason };
  return { ok: true, locked: res.rows.filter((r) => r.isLocked).length, total: res.rows.length };
}

export type PromoteResult = { ok: boolean; message: string };

/**
 * Promote a lead to a DRAFT FINDING.
 *
 * WHY THIS IS NOT A ONE-LINER. Both call sites (/admin/hei and /admin/hei/leads) used to do this:
 *
 *     UPDATE hei_leads SET status = 'promoted' ...          <- ran first, always succeeded
 *     INSERT INTO hei_findings (title, description, status, institution_id, created_by) ...
 *
 * hei_findings has no `title`, no `description` and no `created_by`. src/lib/db/schema.ts declares
 * finding_title, finding_body, evidence_summary (all NOT NULL) and created_by_user_id. So the
 * INSERT threw on every single use, while the UPDATE before it had already committed: the lead left
 * the queue and no finding was ever created. On the dashboard the throw was caught by
 * `catch(e){ console.error(...) }` and the page re-rendered with no error at all. That is silent
 * data loss on every use of the button, and it has never worked once.
 *
 * Order is now INSERT FIRST, and the lead is marked promoted only after the finding exists.
 *
 * institution_id is NOT NULL on hei_findings and hei_leads carries only a free-text institution
 * name, so a lead with no resolvable institution CANNOT become a finding. That is refused with a
 * message naming what is missing, and the lead stays in the queue where an editor can fix it.
 */
export async function promoteLeadToFinding(leadId: string, actorUserId: string): Promise<PromoteResult> {
  if (!leadId) return { ok: false, message: 'No lead was identified.' };
  try {
    await ensureHeiEditorialSchema();

    const lead = heiRows(await db.execute(sql`SELECT * FROM hei_leads WHERE id = ${leadId}::uuid LIMIT 1`))[0];
    if (!lead) return { ok: false, message: 'That lead no longer exists.' };
    if (lead.status === 'promoted') return { ok: false, message: 'That lead has already been promoted.' };

    // Resolve the institution: the id if the lead carries one, otherwise an exact name match.
    let institutionId: string | null = lead.institution_id || null;
    if (!institutionId && lead.institution_name) {
      const match = heiRows(await db.execute(sql`
        SELECT id FROM hei_institutions WHERE LOWER(name) = LOWER(${String(lead.institution_name).trim()}) LIMIT 1
      `));
      institutionId = match[0]?.id || null;
    }
    if (!institutionId) {
      return {
        ok: false,
        message: lead.institution_name
          ? 'No institution on record matches "' + String(lead.institution_name) + '". A finding must be attached to a registered institution, so this lead stays in the queue.'
          : 'This lead names no institution. A finding must be attached to a registered institution, so this lead stays in the queue.',
      };
    }

    const summary = String(lead.summary || '').trim();
    const inserted = heiRows(await db.execute(sql`
      INSERT INTO hei_findings (institution_id, finding_title, finding_body, evidence_summary, status, created_by_user_id)
      VALUES (
        ${institutionId}::uuid,
        ${String(lead.title || 'Untitled lead').slice(0, 500)},
        ${summary || 'Promoted from the lead queue. The body has not been written yet.'},
        ${summary || 'No evidence has been summarised yet. This draft cannot be published until it is.'},
        'draft',
        ${actorUserId}
      )
      RETURNING id
    `));
    if (inserted.length === 0) {
      return { ok: false, message: 'The finding was not created, so the lead has been left in the queue.' };
    }

    await db.execute(sql`UPDATE hei_leads SET status = 'promoted', updated_at = NOW() WHERE id = ${leadId}::uuid`);
    return { ok: true, message: 'Lead promoted to a draft finding. Its body and evidence summary are placeholders until an editor writes them.' };
  } catch (e: any) {
    return { ok: false, message: 'Could not promote this lead: ' + heiReason(e).slice(0, 200) + '. The lead has been left in the queue.' };
  }
}
