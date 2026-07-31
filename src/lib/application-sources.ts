// src/lib/application-sources.ts — where an application came from, as admin-managed data.
//
// step-5 previously hardcoded a handful of channels, so adding a job board meant a code change and
// a deploy. This makes the list data: add, edit, reorder, activate/deactivate from the admin panel.
//
// TWO THINGS WORTH KNOWING:
//
// 1. Options are never hard-deleted while applications reference them. An application that says it
//    came from a since-removed job board must keep saying so — deleting the option would silently
//    rewrite history. Removal deactivates; purge is a separate, deliberate action.
//
// 2. Free-text "Other" answers are captured as SUGGESTIONS, not published straight to the form.
//    Auto-publishing whatever an applicant types would let any applicant put arbitrary text in
//    front of every future applicant, which is a defacement and abuse vector. Instead identical
//    answers are counted, so genuinely common sources rise to the top of the admin list and are
//    published with one click. Set AUTO_PUBLISH_SETTING to true if you accept that trade-off.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

export const AUTO_PUBLISH_SETTING = 'application_sources.auto_publish_other';

export interface AppSource {
  id: string;
  slug: string;
  label: string;
  category: string;
  detailLabel: string | null;   // when set, a follow-up field is shown
  detailRequired: boolean;
  isActive: boolean;
  sortOrder: number;
  usageCount: number;
}

/** Seeded once so the form is never empty on a fresh database. Admins own it from then on. */
const DEFAULTS: Omit<AppSource, 'id' | 'usageCount'>[] = [
  { slug: 'vrittih', label: 'Vrittih.online', category: 'platform', detailLabel: null, detailRequired: false, isActive: true, sortOrder: 10 },
  { slug: 'linkedin', label: 'LinkedIn', category: 'platform', detailLabel: null, detailRequired: false, isActive: true, sortOrder: 20 },
  { slug: 'indeed', label: 'Indeed', category: 'platform', detailLabel: null, detailRequired: false, isActive: true, sortOrder: 30 },
  { slug: 'internshala', label: 'Internshala', category: 'platform', detailLabel: null, detailRequired: false, isActive: true, sortOrder: 40 },
  { slug: 'jobboard-other', label: 'Another hiring platform', category: 'platform', detailLabel: 'Which platform', detailRequired: true, isActive: true, sortOrder: 50 },
  { slug: 'aicte', label: 'AICTE Internship Portal', category: 'government', detailLabel: null, detailRequired: false, isActive: true, sortOrder: 60 },
  { slug: 'govt-portal', label: 'Another national government portal', category: 'government', detailLabel: 'Which portal, and which country', detailRequired: true, isActive: true, sortOrder: 70 },
  { slug: 'institution', label: 'Institution collaboration or outreach', category: 'institution', detailLabel: 'Your institution, and its placement or training cell', detailRequired: true, isActive: true, sortOrder: 80 },
  { slug: 'university-hiring', label: 'University hiring drive', category: 'institution', detailLabel: 'Which university', detailRequired: true, isActive: true, sortOrder: 90 },
  { slug: 'job-fair', label: 'Job fair', category: 'event', detailLabel: 'Which fair, and where', detailRequired: true, isActive: true, sortOrder: 100 },
  { slug: 'referral', label: 'Referred by someone at EduRankAI', category: 'referral', detailLabel: 'Their employee ID (and name, if you know it)', detailRequired: true, isActive: true, sortOrder: 110 },
  { slug: 'other', label: 'Other', category: 'other', detailLabel: 'Please tell us where', detailRequired: true, isActive: true, sortOrder: 999 },
];

export function ensureSourceSchema(): Promise<void> {
  return ensureOnce('application_sources_v1', async () => {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS application_sources (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      slug TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      detail_label TEXT,
      detail_required BOOLEAN NOT NULL DEFAULT false,
      is_active BOOLEAN NOT NULL DEFAULT true,
      sort_order INT NOT NULL DEFAULT 500,
      usage_count INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    // Free-text answers, counted. Reviewed by an admin before they can appear on the form.
    await db.execute(sql`CREATE TABLE IF NOT EXISTS application_source_suggestions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      text TEXT NOT NULL,
      normalised TEXT NOT NULL UNIQUE,
      times_seen INT NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending',
      first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    // Seed only when empty, so a re-run never resurrects options an admin deleted.
    const [{ n }] = rows(await db.execute(sql`SELECT COUNT(*)::int AS n FROM application_sources`)) as any[];
    if (!n) {
      for (const d of DEFAULTS) {
        await db.execute(sql`
          INSERT INTO application_sources (slug, label, category, detail_label, detail_required, is_active, sort_order)
          VALUES (${d.slug}, ${d.label}, ${d.category}, ${d.detailLabel}, ${d.detailRequired}, ${d.isActive}, ${d.sortOrder})
          ON CONFLICT (slug) DO NOTHING`);
      }
    }
  });
}

const map = (r: any): AppSource => ({
  id: r.id, slug: r.slug, label: r.label, category: r.category,
  detailLabel: r.detail_label, detailRequired: !!r.detail_required,
  isActive: !!r.is_active, sortOrder: Number(r.sort_order) || 0,
  usageCount: Number(r.usage_count) || 0,
});

/** What the application form shows. Ordered, active only. */
export async function listActiveSources(): Promise<AppSource[]> {
  try {
    await ensureSourceSchema();
    return rows(await db.execute(sql`
      SELECT * FROM application_sources WHERE is_active = true
      ORDER BY sort_order ASC, label ASC`)).map(map);
  } catch { return []; }
}

/** Everything, for the admin screen. */
export async function listAllSources(): Promise<AppSource[]> {
  try {
    await ensureSourceSchema();
    return rows(await db.execute(sql`
      SELECT * FROM application_sources ORDER BY sort_order ASC, label ASC`)).map(map);
  } catch { return []; }
}

const slugify = (s: string) =>
  (s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || ('src-' + Date.now().toString(36));

export async function createSource(input: {
  label: string; category?: string; detailLabel?: string | null; detailRequired?: boolean;
  isActive?: boolean; sortOrder?: number; slug?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const label = (input.label || '').trim();
  if (!label) return { ok: false, error: 'A label is required.' };
  try {
    await ensureSourceSchema();
    await db.execute(sql`
      INSERT INTO application_sources (slug, label, category, detail_label, detail_required, is_active, sort_order)
      VALUES (${input.slug || slugify(label)}, ${label}, ${input.category || 'other'},
              ${input.detailLabel || null}, ${!!input.detailRequired},
              ${input.isActive !== false}, ${input.sortOrder ?? 500})
      ON CONFLICT (slug) DO NOTHING`);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.cause?.message || e?.message || 'Could not add that option.' };
  }
}

export async function updateSource(id: string, input: {
  label?: string; category?: string; detailLabel?: string | null;
  detailRequired?: boolean; isActive?: boolean; sortOrder?: number;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    await ensureSourceSchema();
    await db.execute(sql`
      UPDATE application_sources SET
        label = COALESCE(${input.label ?? null}, label),
        category = COALESCE(${input.category ?? null}, category),
        detail_label = ${input.detailLabel === undefined ? sql`detail_label` : sql`${input.detailLabel}`},
        detail_required = COALESCE(${input.detailRequired ?? null}, detail_required),
        is_active = COALESCE(${input.isActive ?? null}, is_active),
        sort_order = COALESCE(${input.sortOrder ?? null}, sort_order)
      WHERE id = ${id}`);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.cause?.message || e?.message || 'Could not save.' };
  }
}

/** Bulk activate/deactivate — what "select all" acts on. */
export async function setActiveBulk(ids: string[], isActive: boolean): Promise<number> {
  if (!ids.length) return 0;
  await ensureSourceSchema();
  const r = await db.execute(sql`
    UPDATE application_sources SET is_active = ${isActive}
    WHERE id IN (SELECT (jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))::uuid)
    RETURNING id`);
  return rows(r).length;
}

/**
 * Deactivate rather than delete when an option has been used. An application that recorded a source
 * must keep recording it; removing the row would quietly rewrite what applicants told us.
 */
export async function deleteSources(ids: string[]): Promise<{ deleted: number; deactivated: number }> {
  if (!ids.length) return { deleted: 0, deactivated: 0 };
  await ensureSourceSchema();
  const del = await db.execute(sql`
    DELETE FROM application_sources
    WHERE usage_count = 0
      AND id IN (SELECT (jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))::uuid)
    RETURNING id`);
  const deact = await setActiveBulk(ids, false);
  const deleted = rows(del).length;
  return { deleted, deactivated: Math.max(0, deact - 0) };
}

/** Called on submission, so the admin list shows what is actually being used. */
export async function recordSourceUse(slug: string): Promise<void> {
  if (!slug) return;
  try {
    await ensureSourceSchema();
    await db.execute(sql`UPDATE application_sources SET usage_count = usage_count + 1 WHERE slug = ${slug}`);
  } catch { /* never block a submission over a counter */ }
}

/** Capture a free-text "Other" answer for admin review, counting repeats. */
export async function recordSuggestion(text: string): Promise<void> {
  const t = (text || '').trim().slice(0, 200);
  if (t.length < 2) return;
  const norm = t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  try {
    await ensureSourceSchema();
    await db.execute(sql`
      INSERT INTO application_source_suggestions (text, normalised)
      VALUES (${t}, ${norm})
      ON CONFLICT (normalised) DO UPDATE
        SET times_seen = application_source_suggestions.times_seen + 1, last_seen = NOW()`);
  } catch { /* observability only */ }
}

export interface Suggestion { id: string; text: string; timesSeen: number; status: string; lastSeen: string; }

export async function listSuggestions(status = 'pending'): Promise<Suggestion[]> {
  try {
    await ensureSourceSchema();
    return rows(await db.execute(sql`
      SELECT id, text, times_seen, status, last_seen FROM application_source_suggestions
      WHERE status = ${status} ORDER BY times_seen DESC, last_seen DESC LIMIT 200`))
      .map((r: any) => ({ id: r.id, text: r.text, timesSeen: Number(r.times_seen) || 1, status: r.status, lastSeen: String(r.last_seen) }));
  } catch { return []; }
}

/** Promote a suggestion to a real option, in one click. */
export async function publishSuggestion(id: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await ensureSourceSchema();
    const s = rows(await db.execute(sql`SELECT text FROM application_source_suggestions WHERE id = ${id} LIMIT 1`))[0];
    if (!s) return { ok: false, error: 'That suggestion no longer exists.' };
    const res = await createSource({ label: s.text, category: 'other', sortOrder: 500 });
    if (!res.ok) return res;
    await db.execute(sql`UPDATE application_source_suggestions SET status = 'published' WHERE id = ${id}`);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.cause?.message || e?.message || 'Could not publish.' };
  }
}

export async function setSuggestionStatus(ids: string[], status: 'pending' | 'rejected' | 'published'): Promise<number> {
  if (!ids.length) return 0;
  await ensureSourceSchema();
  const r = await db.execute(sql`
    UPDATE application_source_suggestions SET status = ${status}
    WHERE id IN (SELECT (jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))::uuid)
    RETURNING id`);
  return rows(r).length;
}
