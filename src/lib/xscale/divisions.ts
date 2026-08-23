// src/lib/xscale/divisions.ts — READING AND WRITING THE DIVISION LAYER.
//
// Divisions sit between a department and its roles. Every function here TOLERATES THE TABLE NOT
// EXISTING, because production runs with SCHEMA_BOOTSTRAP off and db/xscale-schema.sql is applied by
// hand: a careers page must degrade to "no divisions yet" rather than to a 500 on a public URL.
//
// A missing table and an empty table are NOT reported as the same thing. Every list function returns
// `{ rows, readable }`, and every surface that shows an empty state has to say which one it is —
// "this department has no divisions" and "we could not read the division register" are different
// facts, and conflating them is how a broken deployment reads as a correct one.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { textArray } from '@/lib/pg-array';
import { ensureXscaleSchema } from './schema';
import { clampExp } from './taxonomy';

// postgres-js resolves execute() to a plain array (a RowList), never a { rows } object. Normalising
// through this helper rather than reading r.rows[0] is a house rule here for that reason.
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const reasonOf = (e: any): string => e?.cause?.message || e?.message || String(e);

export interface Division {
  id: string;
  departmentId: string;
  slug: string;
  name: string;
  code: string | null;
  summary: string;
  charter: string;
  researchClassification: string | null;
  scaleMinExp: number | null;
  scaleMaxExp: number | null;
  domains: string[];
  skillCategories: string[];
  collaboratesWith: string[];
  integrityNote: string;
  sortOrder: number;
  isVisible: boolean;
}

export interface DivisionInput {
  id: string;
  departmentId: string;
  slug: string;
  name: string;
  code?: string | null;
  summary?: string;
  charter?: string;
  researchClassification?: string | null;
  scaleMinExp?: number | null;
  scaleMaxExp?: number | null;
  domains?: string[];
  skillCategories?: string[];
  collaboratesWith?: string[];
  integrityNote?: string;
  sortOrder?: number;
  isVisible?: boolean;
}

/** A readable result that distinguishes "nothing there" from "could not look". */
export interface DivisionList {
  rows: Division[];
  /** False means the query failed or the table is absent — NOT that there are zero divisions. */
  readable: boolean;
}

function mapDivision(r: any): Division {
  return {
    id: String(r.id),
    departmentId: String(r.department_id),
    slug: String(r.slug),
    name: String(r.name),
    code: r.code ? String(r.code) : null,
    summary: String(r.summary || ''),
    charter: String(r.charter || ''),
    researchClassification: r.research_classification ? String(r.research_classification) : null,
    scaleMinExp: r.scale_min_exp === null || r.scale_min_exp === undefined ? null : Number(r.scale_min_exp),
    scaleMaxExp: r.scale_max_exp === null || r.scale_max_exp === undefined ? null : Number(r.scale_max_exp),
    domains: Array.isArray(r.domains) ? r.domains.map(String) : [],
    skillCategories: Array.isArray(r.skill_categories) ? r.skill_categories.map(String) : [],
    collaboratesWith: Array.isArray(r.collaborates_with) ? r.collaborates_with.map(String) : [],
    integrityNote: String(r.integrity_note || ''),
    sortOrder: Number(r.sort_order || 0),
    isVisible: r.is_visible !== false,
  };
}

const SELECT_COLS = sql`
  id, department_id, slug, name, code, summary, charter, research_classification,
  scale_min_exp, scale_max_exp, domains, skill_categories, collaborates_with,
  integrity_note, sort_order, is_visible`;

/** Every division, optionally filtered to one department. Visible ones only unless asked otherwise. */
export async function listDivisions(opts: {
  departmentId?: string | null;
  includeHidden?: boolean;
} = {}): Promise<DivisionList> {
  try {
    await ensureXscaleSchema();
    const dept = opts.departmentId || null;
    const r = await db.execute(sql`
      SELECT ${SELECT_COLS} FROM divisions
      WHERE (${dept}::text IS NULL OR department_id = ${dept})
        AND (${opts.includeHidden === true} OR is_visible = TRUE)
      ORDER BY sort_order ASC, name ASC`);
    return { rows: rowsOf(r).map(mapDivision), readable: true };
  } catch (e: any) {
    console.error('[xscale/divisions] list failed:', reasonOf(e));
    return { rows: [], readable: false };
  }
}

export async function getDivisionBySlug(slug: string): Promise<Division | null> {
  if (!slug) return null;
  try {
    await ensureXscaleSchema();
    const r = await db.execute(sql`SELECT ${SELECT_COLS} FROM divisions WHERE slug = ${slug} LIMIT 1`);
    const row = rowsOf(r)[0];
    return row ? mapDivision(row) : null;
  } catch (e: any) {
    console.error('[xscale/divisions] by slug failed:', reasonOf(e));
    return null;
  }
}

export async function getDivisionById(id: string): Promise<Division | null> {
  if (!id) return null;
  try {
    await ensureXscaleSchema();
    const r = await db.execute(sql`SELECT ${SELECT_COLS} FROM divisions WHERE id = ${id} LIMIT 1`);
    const row = rowsOf(r)[0];
    return row ? mapDivision(row) : null;
  } catch (e: any) {
    console.error('[xscale/divisions] by id failed:', reasonOf(e));
    return null;
  }
}

/**
 * Open-role counts per division, in ONE query.
 *
 * Deliberately not a count per division in a loop. This is read by the department page, which shows
 * fifteen divisions at once; fifteen sequential round trips on a public page is the shape that made
 * /careers take five seconds on a cold instance.
 */
export async function openRoleCountByDivision(departmentId?: string | null): Promise<Record<string, number>> {
  try {
    await ensureXscaleSchema();
    const dept = departmentId || null;
    const r = await db.execute(sql`
      SELECT division_id, COUNT(*)::int AS n
        FROM roles
       WHERE division_id IS NOT NULL
         AND is_open = TRUE
         AND COALESCE(job_status, 'PUBLISHED') = 'PUBLISHED'
         AND (application_deadline IS NULL OR application_deadline > NOW())
         AND (${dept}::text IS NULL OR department_id = ${dept})
       GROUP BY division_id`);
    return Object.fromEntries(rowsOf(r).map((x) => [String(x.division_id), Number(x.n || 0)]));
  } catch (e: any) {
    console.error('[xscale/divisions] counts failed:', reasonOf(e));
    return {};
  }
}

/**
 * Insert or update one division.
 *
 * THROWS on failure rather than returning false. Every caller is an admin form that must show what
 * went wrong, and a silent false is indistinguishable from a successful no-op — which is how a
 * "Saved" banner ends up over a database that changed nothing.
 */
export async function upsertDivision(d: DivisionInput): Promise<void> {
  await ensureXscaleSchema();
  const minExp = d.scaleMinExp === null || d.scaleMinExp === undefined ? null : clampExp(d.scaleMinExp);
  const maxExp = d.scaleMaxExp === null || d.scaleMaxExp === undefined ? null : clampExp(d.scaleMaxExp);
  await db.execute(sql`
    INSERT INTO divisions (
      id, department_id, slug, name, code, summary, charter, research_classification,
      scale_min_exp, scale_max_exp, domains, skill_categories, collaborates_with,
      integrity_note, sort_order, is_visible
    ) VALUES (
      ${d.id}, ${d.departmentId}, ${d.slug}, ${d.name}, ${d.code || null},
      ${d.summary || ''}, ${d.charter || ''}, ${d.researchClassification || null},
      ${minExp}, ${maxExp},
      ${textArray(d.domains || [])}, ${textArray(d.skillCategories || [])},
      ${textArray(d.collaboratesWith || [])},
      ${d.integrityNote || ''}, ${d.sortOrder ?? 0}, ${d.isVisible !== false}
    )
    ON CONFLICT (id) DO UPDATE SET
      department_id = EXCLUDED.department_id,
      slug = EXCLUDED.slug,
      name = EXCLUDED.name,
      code = EXCLUDED.code,
      summary = EXCLUDED.summary,
      charter = EXCLUDED.charter,
      research_classification = EXCLUDED.research_classification,
      scale_min_exp = EXCLUDED.scale_min_exp,
      scale_max_exp = EXCLUDED.scale_max_exp,
      domains = EXCLUDED.domains,
      skill_categories = EXCLUDED.skill_categories,
      collaborates_with = EXCLUDED.collaborates_with,
      integrity_note = EXCLUDED.integrity_note,
      sort_order = EXCLUDED.sort_order,
      is_visible = EXCLUDED.is_visible,
      updated_at = NOW()`);
}

/**
 * Insert a division ONLY if its id is not already present.
 *
 * This is what the seed import uses. An admin who has edited a division's wording must not have that
 * edit overwritten the next time somebody clicks Import — the same edit-safety rule the existing role
 * catalogue import follows.
 */
export async function insertDivisionIfMissing(d: DivisionInput): Promise<boolean> {
  await ensureXscaleSchema();
  const minExp = d.scaleMinExp === null || d.scaleMinExp === undefined ? null : clampExp(d.scaleMinExp);
  const maxExp = d.scaleMaxExp === null || d.scaleMaxExp === undefined ? null : clampExp(d.scaleMaxExp);
  const r = await db.execute(sql`
    INSERT INTO divisions (
      id, department_id, slug, name, code, summary, charter, research_classification,
      scale_min_exp, scale_max_exp, domains, skill_categories, collaborates_with,
      integrity_note, sort_order, is_visible
    ) VALUES (
      ${d.id}, ${d.departmentId}, ${d.slug}, ${d.name}, ${d.code || null},
      ${d.summary || ''}, ${d.charter || ''}, ${d.researchClassification || null},
      ${minExp}, ${maxExp},
      ${textArray(d.domains || [])}, ${textArray(d.skillCategories || [])},
      ${textArray(d.collaboratesWith || [])},
      ${d.integrityNote || ''}, ${d.sortOrder ?? 0}, ${d.isVisible !== false}
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING id`);
  return rowsOf(r).length > 0;
}

/**
 * Hide a division rather than delete it.
 *
 * There is no delete. A division holds roles, and roles hold applications from real people; removing
 * the row would orphan a candidate's record of what they applied to. Hiding is reversible and keeps
 * the trail — the same hide-not-delete invariant the LMS spine uses.
 */
export async function setDivisionVisible(id: string, visible: boolean): Promise<void> {
  await ensureXscaleSchema();
  await db.execute(sql`UPDATE divisions SET is_visible = ${visible}, updated_at = NOW() WHERE id = ${id}`);
}
