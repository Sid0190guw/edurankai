// src/lib/role-aicte.ts — AICTE-portal-format internship fields for a role.
//
// AICTE (internship.aicte-india.org) listings carry more structure than a generic job post:
// learning outcomes, qualification type + specific qualifications + specialisations,
// keywords, perks, number of interns required, and a "terms of engagement" block (working
// days/week, weekly hours, how those hours split between project work and holistic
// well-being, plus freeform conduct notes). These columns are additive (ALTER ... IF NOT
// EXISTS) and separate from the core `roles` Drizzle schema, mirroring the existing
// products/openings pattern in role-products.ts.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { textArray } from '@/lib/pg-array';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

export function ensureRoleAicteColumns(): Promise<void> {
  return ensureOnce('roles_aicte_cols_v1', async () => {
    await db.execute(sql`ALTER TABLE roles ADD COLUMN IF NOT EXISTS keywords TEXT[]`);
    await db.execute(sql`ALTER TABLE roles ADD COLUMN IF NOT EXISTS learning_outcomes TEXT[]`);
    await db.execute(sql`ALTER TABLE roles ADD COLUMN IF NOT EXISTS qualification_type VARCHAR(40)`);
    await db.execute(sql`ALTER TABLE roles ADD COLUMN IF NOT EXISTS qualifications TEXT[]`);
    await db.execute(sql`ALTER TABLE roles ADD COLUMN IF NOT EXISTS specialisations TEXT[]`);
    await db.execute(sql`ALTER TABLE roles ADD COLUMN IF NOT EXISTS no_of_interns INT`);
    await db.execute(sql`ALTER TABLE roles ADD COLUMN IF NOT EXISTS perks TEXT[]`);
    await db.execute(sql`ALTER TABLE roles ADD COLUMN IF NOT EXISTS internship_mode VARCHAR(20) DEFAULT 'Full-Time'`);
    await db.execute(sql`ALTER TABLE roles ADD COLUMN IF NOT EXISTS working_days_per_week INT`);
    await db.execute(sql`ALTER TABLE roles ADD COLUMN IF NOT EXISTS hours_per_week NUMERIC(5,2)`);
    await db.execute(sql`ALTER TABLE roles ADD COLUMN IF NOT EXISTS project_hours_per_day NUMERIC(4,2)`);
    await db.execute(sql`ALTER TABLE roles ADD COLUMN IF NOT EXISTS wellbeing_hours_per_day NUMERIC(4,2)`);
    await db.execute(sql`ALTER TABLE roles ADD COLUMN IF NOT EXISTS engagement_notes TEXT[]`);
  });
}

export interface RoleAicte {
  keywords: string[];
  learningOutcomes: string[];
  qualificationType: string;
  qualifications: string[];
  specialisations: string[];
  noOfInterns: number | null;
  perks: string[];
  internshipMode: string;
  workingDaysPerWeek: number | null;
  hoursPerWeek: number | null;
  projectHoursPerDay: number | null;
  wellbeingHoursPerDay: number | null;
  engagementNotes: string[];
}

const EMPTY: RoleAicte = {
  keywords: [], learningOutcomes: [], qualificationType: '', qualifications: [], specialisations: [],
  noOfInterns: null, perks: [], internshipMode: 'Full-Time', workingDaysPerWeek: null, hoursPerWeek: null,
  projectHoursPerDay: null, wellbeingHoursPerDay: null, engagementNotes: [],
};

export async function getRoleAicte(roleId: string): Promise<RoleAicte> {
  await ensureRoleAicteColumns();
  try {
    const r = rows(await db.execute(sql`
      SELECT keywords, learning_outcomes, qualification_type, qualifications, specialisations,
        no_of_interns, perks, internship_mode, working_days_per_week, hours_per_week,
        project_hours_per_day, wellbeing_hours_per_day, engagement_notes
      FROM roles WHERE id = ${roleId} LIMIT 1`))[0];
    if (!r) return { ...EMPTY };
    return {
      keywords: r.keywords || [], learningOutcomes: r.learning_outcomes || [],
      qualificationType: r.qualification_type || '', qualifications: r.qualifications || [],
      specialisations: r.specialisations || [], noOfInterns: r.no_of_interns ?? null,
      perks: r.perks || [], internshipMode: r.internship_mode || 'Full-Time',
      workingDaysPerWeek: r.working_days_per_week ?? null, hoursPerWeek: r.hours_per_week != null ? Number(r.hours_per_week) : null,
      projectHoursPerDay: r.project_hours_per_day != null ? Number(r.project_hours_per_day) : null,
      wellbeingHoursPerDay: r.wellbeing_hours_per_day != null ? Number(r.wellbeing_hours_per_day) : null,
      engagementNotes: r.engagement_notes || [],
    };
  } catch { return { ...EMPTY }; }
}

// Arrays go through textArray() from src/lib/pg-array.ts. The previous `${jsArray}::text[]` form
// threw "cannot cast type record to text[]" on every call and, being wrapped in a try/catch by the
// caller, left all six of these columns NULL across all 988 live roles. That module documents the
// mechanism and the other three places the same pattern had broken.
export async function setRoleAicte(roleId: string, a: Partial<RoleAicte>): Promise<void> {
  await ensureRoleAicteColumns();
  const v: RoleAicte = { ...EMPTY, ...a };
  await db.execute(sql`
    UPDATE roles SET
      keywords = ${textArray(v.keywords)}, learning_outcomes = ${textArray(v.learningOutcomes)}, qualification_type = ${v.qualificationType || null},
      qualifications = ${textArray(v.qualifications)}, specialisations = ${textArray(v.specialisations)},
      no_of_interns = ${v.noOfInterns}, perks = ${textArray(v.perks)}, internship_mode = ${v.internshipMode || 'Full-Time'},
      working_days_per_week = ${v.workingDaysPerWeek}, hours_per_week = ${v.hoursPerWeek},
      project_hours_per_day = ${v.projectHoursPerDay}, wellbeing_hours_per_day = ${v.wellbeingHoursPerDay},
      engagement_notes = ${textArray(v.engagementNotes)}
    WHERE id = ${roleId}`);
}

/**
 * Set AICTE fields for MANY roles in a single statement, matched by slug.
 *
 * setRoleAicte() costs one round-trip per role. Repairing a ~600-role catalog that way is ~600
 * sequential queries from a serverless function to a pooled database, which is slow enough that the
 * import had to be time-boxed and clicked repeatedly. This does the same work as ONE query per
 * chunk by shipping the whole payload as jsonb and joining it to `roles` on slug.
 *
 * Returns the number of rows actually updated.
 */
export async function setRoleAicteBulk(items: { slug: string; a: Partial<RoleAicte> }[]): Promise<number> {
  if (!items.length) return 0;
  await ensureRoleAicteColumns();

  // Chunked so one statement's parameter never becomes unreasonably large on a big catalog.
  const CHUNK = 150;
  let updated = 0;

  for (let i = 0; i < items.length; i += CHUNK) {
    const payload = items.slice(i, i + CHUNK).map(({ slug, a }) => {
      const v: RoleAicte = { ...EMPTY, ...a };
      return {
        slug,
        keywords: v.keywords || [],
        learning_outcomes: v.learningOutcomes || [],
        qualification_type: v.qualificationType || null,
        qualifications: v.qualifications || [],
        specialisations: v.specialisations || [],
        no_of_interns: v.noOfInterns ?? null,
        perks: v.perks || [],
        internship_mode: v.internshipMode || 'Full-Time',
        working_days_per_week: v.workingDaysPerWeek ?? null,
        hours_per_week: v.hoursPerWeek ?? null,
        project_hours_per_day: v.projectHoursPerDay ?? null,
        wellbeing_hours_per_day: v.wellbeingHoursPerDay ?? null,
        engagement_notes: v.engagementNotes || [],
      };
    });

    // jsonb_to_recordset REQUIRES a JSON array. If the payload ever serialises to anything else the
    // database answers "cannot call jsonb_to_recordset on a non-array", which names the SQL function
    // rather than the data and sends you looking in the wrong place. Assert it here, where the
    // message can say what was actually wrong and the whole import does not fail on the last step.
    if (!Array.isArray(payload)) {
      console.error('[role-aicte] payload is not an array; skipping chunk', typeof payload);
      continue;
    }
    if (payload.length === 0) continue;

    // jsonb_to_recordset turns the payload into a typed relation we can join on. The text[] columns
    // arrive as jsonb arrays and are unpacked per row — same mechanism as textArray(), just applied
    // set-wise instead of one value at a time.
    const r = await db.execute(sql`
      UPDATE roles r SET
        keywords = COALESCE((SELECT array_agg(t.x) FROM jsonb_array_elements_text(d.keywords) AS t(x)), ARRAY[]::text[]),
        learning_outcomes = COALESCE((SELECT array_agg(t.x) FROM jsonb_array_elements_text(d.learning_outcomes) AS t(x)), ARRAY[]::text[]),
        qualification_type = d.qualification_type,
        qualifications = COALESCE((SELECT array_agg(t.x) FROM jsonb_array_elements_text(d.qualifications) AS t(x)), ARRAY[]::text[]),
        specialisations = COALESCE((SELECT array_agg(t.x) FROM jsonb_array_elements_text(d.specialisations) AS t(x)), ARRAY[]::text[]),
        no_of_interns = d.no_of_interns,
        perks = COALESCE((SELECT array_agg(t.x) FROM jsonb_array_elements_text(d.perks) AS t(x)), ARRAY[]::text[]),
        internship_mode = COALESCE(d.internship_mode, 'Full-Time'),
        working_days_per_week = d.working_days_per_week,
        hours_per_week = d.hours_per_week,
        project_hours_per_day = d.project_hours_per_day,
        wellbeing_hours_per_day = d.wellbeing_hours_per_day,
        engagement_notes = COALESCE((SELECT array_agg(t.x) FROM jsonb_array_elements_text(d.engagement_notes) AS t(x)), ARRAY[]::text[])
      FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS d(
        slug text, keywords jsonb, learning_outcomes jsonb, qualification_type text,
        qualifications jsonb, specialisations jsonb, no_of_interns int, perks jsonb,
        internship_mode text, working_days_per_week int, hours_per_week numeric,
        project_hours_per_day numeric, wellbeing_hours_per_day numeric, engagement_notes jsonb)
      WHERE r.slug = d.slug
      RETURNING r.id`);
    updated += rows(r).length;
  }
  return updated;
}
