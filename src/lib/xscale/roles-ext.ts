// src/lib/xscale/roles-ext.ts — THE EXTENDED ROLE RECORD, AND THE ONE QUERY THAT LISTS POSTINGS.
//
// The `roles` table gains its research facets through additive columns (see ./schema.ts). This
// module is the only place that reads or writes them, and the only place that builds a postings
// query. Every public surface — the careers page, a department page, a division page, the JSON feed —
// goes through listOpportunities() so that a filter added here works everywhere at once and the
// visibility rule is stated in exactly one place.
//
// THE VISIBILITY RULE, WRITTEN ONCE:
//
//   A posting is LISTED when it is open, its job status is PUBLISHED, and its deadline has not passed.
//   A posting is REACHABLE at its own URL when its status is PUBLISHED, PAUSED or CLOSED.
//   A posting ACCEPTS AN APPLICATION only when effectiveJobStatus() says so — deadline included.
//
// The third of those is enforced server-side at submission, not by hiding a button. See
// assertAcceptingApplications() at the bottom of this file, which is what the apply flow calls.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { textArray } from '@/lib/pg-array';
import { ensureXscaleSchema } from './schema';
import {
  clampExp, effectiveJobStatus, isResearchClassification, scaleBand,
  type JobStatus, type JobStatusDef,
} from './taxonomy';

const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const reasonOf = (e: any): string => e?.cause?.message || e?.message || String(e);
const strArray = (v: any): string[] => (Array.isArray(v) ? v.map(String) : []);
const numOrNull = (v: any): number | null => (v === null || v === undefined ? null : Number(v));

/** The research facets of a posting. Everything here is optional on a non-research role. */
export interface RoleExtension {
  divisionId: string | null;
  researchClassification: string | null;
  scaleMinExp: number | null;
  scaleMaxExp: number | null;
  skillCategories: string[];
  careerLevel: number | null;
  jobStatus: string | null;
  validThrough: string | null;
  preferredSkills: string[];
  tools: string[];
  deliverables: string[];
  evaluationCriteria: string[];
  reportingTo: string | null;
  collaboratesWith: string[];
  applicationInstructions: string | null;
  integrityNote: string | null;
}

export const EMPTY_EXTENSION: RoleExtension = Object.freeze({
  divisionId: null, researchClassification: null, scaleMinExp: null, scaleMaxExp: null,
  skillCategories: [], careerLevel: null, jobStatus: null, validThrough: null,
  preferredSkills: [], tools: [], deliverables: [], evaluationCriteria: [],
  reportingTo: null, collaboratesWith: [], applicationInstructions: null, integrityNote: null,
});

const EXT_COLS = sql`
  division_id, research_classification, scale_min_exp, scale_max_exp, skill_categories,
  career_level, job_status, valid_through, preferred_skills, tools, deliverables,
  evaluation_criteria, reporting_to, collaborates_with, application_instructions, integrity_note`;

export function mapExtension(r: any): RoleExtension {
  if (!r) return { ...EMPTY_EXTENSION };
  return {
    divisionId: r.division_id ? String(r.division_id) : null,
    researchClassification: r.research_classification ? String(r.research_classification) : null,
    scaleMinExp: numOrNull(r.scale_min_exp),
    scaleMaxExp: numOrNull(r.scale_max_exp),
    skillCategories: strArray(r.skill_categories),
    careerLevel: numOrNull(r.career_level),
    jobStatus: r.job_status ? String(r.job_status) : null,
    validThrough: r.valid_through ? new Date(r.valid_through).toISOString() : null,
    preferredSkills: strArray(r.preferred_skills),
    tools: strArray(r.tools),
    deliverables: strArray(r.deliverables),
    evaluationCriteria: strArray(r.evaluation_criteria),
    reportingTo: r.reporting_to ? String(r.reporting_to) : null,
    collaboratesWith: strArray(r.collaborates_with),
    applicationInstructions: r.application_instructions ? String(r.application_instructions) : null,
    integrityNote: r.integrity_note ? String(r.integrity_note) : null,
  };
}

/** The extension for one role. Returns the empty extension when the columns are not there yet. */
export async function getRoleExtension(roleId: string): Promise<RoleExtension> {
  if (!roleId) return { ...EMPTY_EXTENSION };
  try {
    await ensureXscaleSchema();
    const r = await db.execute(sql`SELECT ${EXT_COLS} FROM roles WHERE id = ${roleId} LIMIT 1`);
    return mapExtension(rowsOf(r)[0]);
  } catch (e: any) {
    console.error('[xscale/roles-ext] read failed:', reasonOf(e));
    return { ...EMPTY_EXTENSION };
  }
}

/**
 * Write the extension for one role.
 *
 * THROWS. Every caller is an admin form, and a swallowed failure here means an editor is told a
 * posting was reclassified when it was not.
 */
export async function setRoleExtension(roleId: string, e: Partial<RoleExtension>): Promise<void> {
  await ensureXscaleSchema();
  const v: RoleExtension = { ...EMPTY_EXTENSION, ...e };
  const minExp = v.scaleMinExp === null ? null : clampExp(v.scaleMinExp);
  const maxExp = v.scaleMaxExp === null ? null : clampExp(v.scaleMaxExp);
  const classification = isResearchClassification(v.researchClassification) ? v.researchClassification : null;
  await db.execute(sql`
    UPDATE roles SET
      division_id = ${v.divisionId},
      research_classification = ${classification},
      scale_min_exp = ${minExp},
      scale_max_exp = ${maxExp},
      skill_categories = ${textArray(v.skillCategories)},
      career_level = ${v.careerLevel},
      job_status = ${v.jobStatus},
      valid_through = ${v.validThrough},
      preferred_skills = ${textArray(v.preferredSkills)},
      tools = ${textArray(v.tools)},
      deliverables = ${textArray(v.deliverables)},
      evaluation_criteria = ${textArray(v.evaluationCriteria)},
      reporting_to = ${v.reportingTo},
      collaborates_with = ${textArray(v.collaboratesWith)},
      application_instructions = ${v.applicationInstructions},
      integrity_note = ${v.integrityNote},
      updated_at = NOW()
    WHERE id = ${roleId}`);
}

/**
 * Set extensions for MANY roles in one statement, matched by slug.
 *
 * One round trip per chunk instead of one per role. The catalogue import writes several hundred of
 * these, and the per-role form of that is what forced the existing role import to be time-boxed and
 * clicked repeatedly. Returns how many rows were actually updated — not how many were sent.
 */
export async function setRoleExtensionBulk(
  items: { slug: string; ext: Partial<RoleExtension> }[],
): Promise<number> {
  if (!items.length) return 0;
  await ensureXscaleSchema();
  const CHUNK = 150;
  let updated = 0;
  for (let i = 0; i < items.length; i += CHUNK) {
    const payload = items.slice(i, i + CHUNK).map(({ slug, ext }) => {
      const v: RoleExtension = { ...EMPTY_EXTENSION, ...ext };
      return {
        slug,
        division_id: v.divisionId,
        research_classification: isResearchClassification(v.researchClassification) ? v.researchClassification : null,
        scale_min_exp: v.scaleMinExp === null ? null : clampExp(v.scaleMinExp),
        scale_max_exp: v.scaleMaxExp === null ? null : clampExp(v.scaleMaxExp),
        skill_categories: v.skillCategories || [],
        career_level: v.careerLevel,
        job_status: v.jobStatus,
        valid_through: v.validThrough,
        preferred_skills: v.preferredSkills || [],
        tools: v.tools || [],
        deliverables: v.deliverables || [],
        evaluation_criteria: v.evaluationCriteria || [],
        reporting_to: v.reportingTo,
        collaborates_with: v.collaboratesWith || [],
        application_instructions: v.applicationInstructions,
        integrity_note: v.integrityNote,
      };
    });
    // jsonb_to_recordset REQUIRES a JSON array, and answers "cannot call jsonb_to_recordset on a
    // non-array" if it is handed anything else — a message that names the SQL function rather than
    // the data and sends you looking in the wrong place.
    if (!Array.isArray(payload) || payload.length === 0) continue;
    const r = await db.execute(sql`
      UPDATE roles r SET
        division_id = d.division_id,
        research_classification = d.research_classification,
        scale_min_exp = d.scale_min_exp,
        scale_max_exp = d.scale_max_exp,
        skill_categories = COALESCE((SELECT array_agg(t.x) FROM jsonb_array_elements_text(d.skill_categories) AS t(x)), ARRAY[]::text[]),
        career_level = d.career_level,
        -- COALESCE, NOT AN OVERWRITE. job_status is WORKFLOW STATE, not classification: an editor
        -- publishes a posting, and the next click of the catalogue import must not silently demote
        -- it back to a draft and pull a live advertisement off the site. Passing null for it here
        -- means "leave whatever is there"; passing a value means "set it".
        job_status = COALESCE(d.job_status, r.job_status),
        valid_through = d.valid_through,
        preferred_skills = COALESCE((SELECT array_agg(t.x) FROM jsonb_array_elements_text(d.preferred_skills) AS t(x)), ARRAY[]::text[]),
        tools = COALESCE((SELECT array_agg(t.x) FROM jsonb_array_elements_text(d.tools) AS t(x)), ARRAY[]::text[]),
        deliverables = COALESCE((SELECT array_agg(t.x) FROM jsonb_array_elements_text(d.deliverables) AS t(x)), ARRAY[]::text[]),
        evaluation_criteria = COALESCE((SELECT array_agg(t.x) FROM jsonb_array_elements_text(d.evaluation_criteria) AS t(x)), ARRAY[]::text[]),
        reporting_to = d.reporting_to,
        collaborates_with = COALESCE((SELECT array_agg(t.x) FROM jsonb_array_elements_text(d.collaborates_with) AS t(x)), ARRAY[]::text[]),
        application_instructions = d.application_instructions,
        integrity_note = d.integrity_note,
        updated_at = NOW()
      FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS d(
        slug text, division_id text, research_classification text, scale_min_exp int,
        scale_max_exp int, skill_categories jsonb, career_level int, job_status text,
        valid_through timestamptz, preferred_skills jsonb, tools jsonb, deliverables jsonb,
        evaluation_criteria jsonb, reporting_to text, collaborates_with jsonb,
        application_instructions text, integrity_note text)
      WHERE r.slug = d.slug
      RETURNING r.id`);
    updated += rowsOf(r).length;
  }
  return updated;
}

// -------------------------------------------------------------------------------------------------
//   THE LISTING QUERY
// -------------------------------------------------------------------------------------------------

export interface OpportunityFilters {
  q?: string;
  departmentId?: string;
  divisionId?: string;
  level?: string;
  /** A rung on the department's 0-10 research ladder. Distinct from `level`, the site-wide enum. */
  careerLevel?: number | null;
  engagementType?: string;
  workMode?: string;
  classification?: string;
  /** A scale band id, e.g. 'BAND_05'. A posting matches when its range OVERLAPS the band. */
  band?: string;
  skillCategory?: string;
  /** A single skill string, matched against the role's own skills array. */
  skill?: string;
  /**
   * ANY-OF over the discipline column, as opposed to `skillCategory`'s single value.
   *
   * Added for Career Intelligence (src/lib/career-intel/retrieve.ts), which reads several
   * disciplines out of one sentence and must fetch a candidate pool for all of them in ONE query.
   * The alternative — a query per discipline — is four round trips to build one page, and this
   * project's own measurements say the round-trip COUNT is the lever that matters here.
   *
   * Empty or absent means "no constraint". It does NOT mean "match nothing".
   */
  skillCategoriesAny?: string[];
  /**
   * OR-of-ILIKE over the posting's own words. Same reason as above: a sentence yields several
   * salient terms and they belong in one predicate, not one query each.
   *
   * `q` stays what it is — a single search box term, AND-ed with everything else. `terms` is a
   * widening: a posting matching ANY of them qualifies.
   */
  terms?: string[];
  /** Postings created within this many days. */
  postedWithinDays?: number;
  /** Admin only. Omitted or empty means "the public rule": PUBLISHED and in date. */
  jobStatus?: string;
  /** Admin only. Includes drafts, paused, closed and archived postings. */
  includeUnpublished?: boolean;
  limit?: number;
  offset?: number;
}

export interface OpportunityRow {
  id: string;
  slug: string;
  title: string;
  level: string;
  functionText: string;
  engagementType: string;
  location: string;
  departmentId: string;
  departmentName: string | null;
  divisionId: string | null;
  divisionName: string | null;
  divisionSlug: string | null;
  researchClassification: string | null;
  scaleMinExp: number | null;
  scaleMaxExp: number | null;
  skills: string[];
  skillCategories: string[];
  careerLevel: number | null;
  jobStatus: string;
  isFeatured: boolean;
  isOpen: boolean;
  applicationDeadline: string | null;
  createdAt: string | null;
  openings: number | null;
}

export interface OpportunityPage {
  rows: OpportunityRow[];
  total: number;
  /** False means the query failed — NOT that no opportunity matched. */
  readable: boolean;
  /** Set when the extended columns are absent, so a surface can say why filters did nothing. */
  degraded: boolean;
}

/** A hard ceiling on a public, unauthenticated read. Not a page size. */
const MAX_LIMIT = 100;

function mapOpportunity(r: any): OpportunityRow {
  return {
    id: String(r.id),
    slug: String(r.slug),
    title: String(r.title),
    level: String(r.level || ''),
    functionText: String(r.function || ''),
    engagementType: String(r.engagement_type || ''),
    location: String(r.location || ''),
    departmentId: String(r.department_id || ''),
    departmentName: r.department_name ? String(r.department_name) : null,
    divisionId: r.division_id ? String(r.division_id) : null,
    divisionName: r.division_name ? String(r.division_name) : null,
    divisionSlug: r.division_slug ? String(r.division_slug) : null,
    researchClassification: r.research_classification ? String(r.research_classification) : null,
    scaleMinExp: numOrNull(r.scale_min_exp),
    scaleMaxExp: numOrNull(r.scale_max_exp),
    skills: Array.isArray(r.skills) ? r.skills.map(String) : [],
    skillCategories: strArray(r.skill_categories),
    careerLevel: numOrNull(r.career_level),
    jobStatus: String(r.job_status || (r.is_open === false ? 'CLOSED' : 'PUBLISHED')),
    isFeatured: r.is_featured === true,
    isOpen: r.is_open !== false,
    applicationDeadline: r.application_deadline ? new Date(r.application_deadline).toISOString() : null,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    openings: numOrNull(r.openings),
  };
}

/**
 * THE listing query. Every public and admin postings surface uses this one function.
 *
 * COUNTED WITH A SEPARATE, NARROWER QUERY, not with `COUNT(*) OVER ()` beside the LIMIT — that
 * window function is evaluated over every matching row before the limit is applied, which is a full
 * scan dressed up as a paginated read, and it is called out by name in this project's notes.
 */
export async function listOpportunities(f: OpportunityFilters = {}): Promise<OpportunityPage> {
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(f.limit ?? 24)));
  const offset = Math.max(0, Math.floor(f.offset ?? 0));

  const term = String(f.q || '').trim();
  const like = '%' + term + '%';

  const band = scaleBand(f.band);
  const bandLo = band ? band.minExp : null;
  const bandHi = band ? band.maxExp : null;

  const postedSince = f.postedWithinDays && f.postedWithinDays > 0
    ? new Date(Date.now() - f.postedWithinDays * 86400000).toISOString()
    : null;

  // ANY-OF DISCIPLINES AND ANY-OF TERMS. Both are widenings and both default to "no constraint";
  // an empty list must never be allowed to become a predicate that nothing can satisfy, which is
  // the standard way an optional filter turns into a search that silently returns zero.
  const catsAny = Array.from(new Set((f.skillCategoriesAny || [])
    .map((s) => String(s || '').trim().toUpperCase())
    .filter(Boolean)))
    .slice(0, 8);
  const hasCatsAny = catsAny.length > 0;

  const anyTerms = Array.from(new Set((f.terms || [])
    .map((s) => String(s || '').trim())
    .filter((s) => s.length >= 2)))
    .slice(0, 6);
  const hasTerms = anyTerms.length > 0;

  // A FACTORY, LIKE whereClause() BELOW, AND FOR THE SAME REASON. One shared `sql` fragment reused
  // by the rows statement and the count statement is what produced "bind message supplies 36
  // parameters, but prepared statement requires 34" — see the long note above whereClause(). These
  // two build a fresh fragment per statement.
  const termsFragment = () => (hasTerms
    ? sql`(${sql.join(anyTerms.map((t) => {
      const lk = '%' + t + '%';
      return sql`(r.title ILIKE ${lk} OR r.function ILIKE ${lk} OR r.about ILIKE ${lk}
                  OR COALESCE(d.name, '') ILIKE ${lk} OR COALESCE(v.name, '') ILIKE ${lk}
                  OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(
                       CASE WHEN jsonb_typeof(r.skills) = 'array' THEN r.skills ELSE '[]'::jsonb END
                     ) AS s WHERE s ILIKE ${lk}))`;
    }), sql` OR `)})`
    : sql`TRUE`);

  // `&&` is array overlap. Guarded by hasCatsAny so an empty list is a no-op rather than a
  // predicate over an empty array, which overlaps with nothing and would return no rows at all.
  const catsFragment = () => (hasCatsAny
    ? sql`(COALESCE(r.skill_categories, ARRAY[]::text[]) && ${textArray(catsAny)})`
    : sql`TRUE`);

  // The same widening, narrowed to columns that exist on every database, for the retry path.
  const narrowTerms = () => (hasTerms
    ? sql`(${sql.join(anyTerms.map((t) => {
      const lk = '%' + t + '%';
      return sql`(r.title ILIKE ${lk} OR r.function ILIKE ${lk})`;
    }), sql` OR `)})`
    : sql`TRUE`);

  // The public rule, or the admin one. `includeUnpublished` is set only by an authenticated admin
  // surface; it is never derived from a query parameter on a public page.
  const publicOnly = f.includeUnpublished !== true;

  // A FACTORY, NOT A SHARED FRAGMENT — AND THIS IS A BUG THAT WAS FOUND BY RUNNING THE THING.
  //
  // This was ONE `const where = sql\`...\`` embedded into both the rows query and the count query,
  // and the two were then run through Promise.all(). Against a real database that produced:
  //
  //     bind message supplies 36 parameters, but prepared statement "" requires 34
  //
  // Thirty-six and thirty-four differ by exactly two: the LIMIT and the OFFSET, which only the rows
  // query carries. The count statement was being bound with the rows statement's parameter list.
  // postgres-js runs with prepare:false, so both statements are the UNNAMED prepared statement, and
  // pipelining two of them concurrently down one connection lets the second Bind arrive against the
  // first Parse.
  //
  // The failure mode is what makes it serious rather than merely wrong. listOpportunities() catches
  // and RETRIES on a narrowed query — and that narrowed query silently drops the division,
  // classification, scale-band and discipline filters. So the page did not error: it returned every
  // published posting and presented it as the filtered result. A scale-band filter for a band with
  // nothing in it returned sixteen roles. That is a search that lies rather than one that breaks.
  //
  // Fixed twice over: a fresh fragment per statement, and the two statements run in sequence.
  const whereClause = () => sql`
    WHERE (${publicOnly} = FALSE OR (
            r.is_open = TRUE
        AND COALESCE(r.job_status, 'PUBLISHED') = 'PUBLISHED'
        AND (r.application_deadline IS NULL OR r.application_deadline > NOW())
      ))
      AND (${f.jobStatus || null}::text IS NULL OR COALESCE(r.job_status, 'PUBLISHED') = ${f.jobStatus || null})
      AND (${f.departmentId || null}::text IS NULL OR r.department_id = ${f.departmentId || null})
      AND (${f.divisionId || null}::text IS NULL OR r.division_id = ${f.divisionId || null})
      AND (${f.level || null}::text IS NULL OR r.level::text = ${f.level || null})
      AND (${f.careerLevel ?? null}::int IS NULL OR r.career_level = ${f.careerLevel ?? null}::int)
      AND (${f.engagementType || null}::text IS NULL OR r.engagement_type::text = ${f.engagementType || null})
      AND (${f.workMode || null}::text IS NULL OR r.location ILIKE '%' || ${f.workMode || null} || '%')
      AND (${f.classification || null}::text IS NULL OR r.research_classification = ${f.classification || null})
      AND (${f.skillCategory || null}::text IS NULL OR ${f.skillCategory || null} = ANY(COALESCE(r.skill_categories, ARRAY[]::text[])))
      AND ${catsFragment()}
      AND ${termsFragment()}
      AND (${postedSince}::timestamptz IS NULL OR r.created_at >= ${postedSince}::timestamptz)
      AND (${bandLo}::int IS NULL OR (
            r.scale_min_exp IS NOT NULL AND r.scale_max_exp IS NOT NULL
        AND r.scale_min_exp <= ${bandHi}::int AND r.scale_max_exp >= ${bandLo}::int
      ))
      AND (${f.skill || null}::text IS NULL OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(r.skills) = 'array' THEN r.skills ELSE '[]'::jsonb END
        ) AS s WHERE s ILIKE '%' || ${f.skill || null} || '%'
      ))
      AND (${term === '' } OR (
           r.title ILIKE ${like}
        OR r.function ILIKE ${like}
        OR r.about ILIKE ${like}
        OR COALESCE(d.name, '') ILIKE ${like}
        OR COALESCE(v.name, '') ILIKE ${like}
        OR EXISTS (
             SELECT 1 FROM jsonb_array_elements_text(
               -- GUARDED WITH jsonb_typeof. jsonb_array_elements_text throws a hard Postgres error
               -- on any row whose skills column is not actually a JSON array, and because this runs
               -- per row across the whole table, ONE bad row silently killed EVERY search on
               -- /careers — surfacing as "0 results" for terms that obviously matched.
               CASE WHEN jsonb_typeof(r.skills) = 'array' THEN r.skills ELSE '[]'::jsonb END
             ) AS s WHERE s ILIKE ${like}
           )
        OR EXISTS (
             SELECT 1 FROM unnest(COALESCE(r.tools, ARRAY[]::text[])) AS t WHERE t ILIKE ${like}
           )
      ))`;

  try {
    await ensureXscaleSchema();
    // SEQUENTIAL, NOT Promise.all. See the note above whereClause(). src/lib/db/index.ts already
    // records that Promise.all buys nothing against a small pool; here it actively caused a
    // mis-bind, and the cost of awaiting one query before the next is a single round trip.
    const rr = await db.execute(sql`
      SELECT r.id, r.slug, r.title, r.level, r.function, r.engagement_type, r.location,
             r.department_id, r.is_featured, r.is_open, r.application_deadline, r.created_at,
             r.skills, r.openings,
             r.division_id, r.research_classification, r.scale_min_exp, r.scale_max_exp,
             r.skill_categories, r.career_level, r.job_status,
             d.name AS department_name, v.name AS division_name, v.slug AS division_slug
        FROM roles r
        LEFT JOIN departments d ON d.id = r.department_id
        LEFT JOIN divisions v ON v.id = r.division_id
        ${whereClause()}
       ORDER BY r.is_featured DESC, r.sort_order ASC, r.created_at DESC, r.title ASC
       LIMIT ${limit} OFFSET ${offset}`);

    const cc = await db.execute(sql`
      SELECT COUNT(*)::int AS n
        FROM roles r
        LEFT JOIN departments d ON d.id = r.department_id
        LEFT JOIN divisions v ON v.id = r.division_id
        ${whereClause()}`);

    return {
      rows: rowsOf(rr).map(mapOpportunity),
      total: Number(rowsOf(cc)[0]?.n || 0),
      readable: true,
      degraded: false,
    };
  } catch (e: any) {
    const reason = reasonOf(e);
    console.error('[xscale/roles-ext] listOpportunities failed:', reason);
    // The extended columns are the likeliest thing missing on a database where the migration has not
    // been applied. Retry WITHOUT any of them rather than reporting "no opportunities match", which
    // is indistinguishable from a genuinely empty result and is the worse of the two lies.
    try {
      const fallback = await db.execute(sql`
        SELECT r.id, r.slug, r.title, r.level, r.function, r.engagement_type, r.location,
               r.department_id, r.is_featured, r.is_open, r.application_deadline, r.created_at,
               r.skills, d.name AS department_name
          FROM roles r
          LEFT JOIN departments d ON d.id = r.department_id
         WHERE r.is_open = TRUE
           AND (${f.departmentId || null}::text IS NULL OR r.department_id = ${f.departmentId || null})
           AND (${f.level || null}::text IS NULL OR r.level::text = ${f.level || null})
      AND (${f.careerLevel ?? null}::int IS NULL OR r.career_level = ${f.careerLevel ?? null}::int)
           AND (${term === ''} OR r.title ILIKE ${like} OR r.function ILIKE ${like})
           -- 'terms' survives the narrowing, on the two columns certain to exist on any database.
           -- The discipline overlap does NOT, which is precisely why 'degraded' stays true below:
           -- this result was produced without it and must not be presented as though it had it.
           AND ${narrowTerms()}
         ORDER BY r.is_featured DESC, r.sort_order ASC, r.title ASC
         LIMIT ${limit} OFFSET ${offset}`);
      const list = rowsOf(fallback).map(mapOpportunity);
      console.error('[xscale/roles-ext] retried without the extended columns and succeeded');
      // `degraded: true` IS NOT COSMETIC. This result was produced WITHOUT the division,
      // classification, scale-band and discipline predicates, so it is not the answer that was
      // asked for — it is every open posting. Any surface rendering this must say so, which is what
      // the degraded banner on /careers/opportunities exists for. Returning it as though it were
      // filtered is how a search comes to lie about what matched.
      return { rows: list, total: list.length, readable: true, degraded: true };
    } catch (e2: any) {
      console.error('[xscale/roles-ext] narrowed listing also failed:', reasonOf(e2));
      return { rows: [], total: 0, readable: false, degraded: true };
    }
  }
}

/**
 * One posting by slug, WITH its division and department, for the detail page.
 *
 * Returns the row whatever its status. The page decides what to render; this function does not hide
 * a closed posting, because "closed" is a thing a candidate needs to be told rather than a 404.
 */
export async function getOpportunityBySlug(slug: string): Promise<{
  row: any | null;
  ext: RoleExtension;
  division: { id: string; slug: string; name: string; summary: string } | null;
  readable: boolean;
}> {
  const empty = { row: null, ext: { ...EMPTY_EXTENSION }, division: null, readable: false };
  if (!slug) return { ...empty, readable: true };
  try {
    await ensureXscaleSchema();
    const r = await db.execute(sql`
      SELECT r.*, v.id AS v_id, v.slug AS v_slug, v.name AS v_name, v.summary AS v_summary
        FROM roles r
        LEFT JOIN divisions v ON v.id = r.division_id
       WHERE r.slug = ${slug}
       LIMIT 1`);
    const row = rowsOf(r)[0];
    if (!row) return { row: null, ext: { ...EMPTY_EXTENSION }, division: null, readable: true };
    return {
      row,
      ext: mapExtension(row),
      division: row.v_id
        ? { id: String(row.v_id), slug: String(row.v_slug), name: String(row.v_name), summary: String(row.v_summary || '') }
        : null,
      readable: true,
    };
  } catch (e: any) {
    console.error('[xscale/roles-ext] getOpportunityBySlug failed:', reasonOf(e));
    return empty;
  }
}

// -------------------------------------------------------------------------------------------------
//   THE APPLICATION GATE
// -------------------------------------------------------------------------------------------------

/**
 * MAY THIS POSTING ACCEPT AN APPLICATION RIGHT NOW?
 *
 * Called on the SERVER at submission, not used to hide a button. Hiding the Apply button is a
 * courtesy to honest applicants; anybody can post the form anyway, and a closed posting that quietly
 * accepts an application is the specific failure the brief names.
 *
 * Returns null when it may, or a sentence for the candidate when it may not.
 */
export async function refuseIfNotAccepting(roleId: string | null | undefined): Promise<string | null> {
  if (!roleId) return null;  // A general application, not tied to a posting.
  try {
    await ensureXscaleSchema();
    const r = await db.execute(sql`
      SELECT title, is_open, job_status, application_deadline FROM roles WHERE id = ${roleId} LIMIT 1`);
    const row = rowsOf(r)[0];
    // A posting that cannot be found is not refused here: the apply flow has its own handling for a
    // missing role, and refusing on a failed lookup would block applicants over a transient error.
    if (!row) return null;
    const status = effectiveJobStatus({
      jobStatus: row.job_status,
      isOpen: row.is_open,
      applicationDeadline: row.application_deadline,
    });
    if (status.acceptsApplications) return null;
    return (status.publicNote || 'This opportunity is no longer accepting applications.')
      + ' Nothing you entered has been submitted. Please choose another opportunity from the careers page.';
  } catch (e: any) {
    // FAILS OPEN, DELIBERATELY, AND THIS IS THE ONE PLACE IN THIS MODULE THAT DOES. If the status
    // cannot be read, refusing would turn a database hiccup into a candidate being told they may not
    // apply — a much worse outcome than one late application that a reviewer can see and set aside.
    console.error('[xscale/roles-ext] accepting check failed, allowing:', reasonOf(e));
    return null;
  }
}

/** The status a posting row is actually in, for a surface that already has the row. */
export function statusOf(row: {
  job_status?: string | null; jobStatus?: string | null;
  is_open?: boolean | null; isOpen?: boolean | null;
  application_deadline?: any; applicationDeadline?: any;
}): JobStatusDef {
  return effectiveJobStatus({
    jobStatus: row.jobStatus ?? row.job_status ?? null,
    isOpen: row.isOpen ?? row.is_open ?? null,
    applicationDeadline: row.applicationDeadline ?? row.application_deadline ?? null,
  });
}

/**
 * Move a posting into a new status, keeping `is_open` in step.
 *
 * `is_open` REMAINS THE COLUMN THE REST OF THE SITE READS. Nine existing surfaces filter on it —
 * /careers, the product pages, the job feed, the sitemap — and none of them knows about job_status.
 * Writing both in one statement is what keeps a "Close" click actually closing the posting
 * everywhere, rather than only on the pages that have been taught the new vocabulary.
 */
export async function setJobStatus(roleId: string, status: JobStatus): Promise<void> {
  await ensureXscaleSchema();
  const open = status === 'PUBLISHED';
  await db.execute(sql`
    UPDATE roles SET job_status = ${status}, is_open = ${open}, updated_at = NOW()
     WHERE id = ${roleId}`);
}

/**
 * Backfill job_status from is_open for every row that has none.
 *
 * Run once after the migration. Without it every pre-existing role has a NULL job_status, which the
 * queries above read as PUBLISHED via COALESCE — correct, but it leaves the admin console showing a
 * blank status column for the whole catalogue.
 */
export async function backfillJobStatus(): Promise<number> {
  await ensureXscaleSchema();
  const r = await db.execute(sql`
    UPDATE roles SET job_status = CASE WHEN is_open THEN 'PUBLISHED' ELSE 'CLOSED' END
     WHERE job_status IS NULL
     RETURNING id`);
  return rowsOf(r).length;
}
