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

/**
 * Build a text[] value from a JS string array, safely.
 *
 * The previous approach — `${jsArray}::text[]` — DID NOT WORK. postgres-js/drizzle sends a JS array
 * as a row/record literal, so Postgres rejected every one of these writes with
 * "cannot cast type record to text[]". Because the only caller wrapped setRoleAicte in a
 * try/catch, that error was swallowed on every single import: base role rows were inserted while
 * keywords, learning_outcomes, qualifications, specialisations, perks and engagement_notes stayed
 * NULL for all 988 live roles. Confirmed on production via /admin/roles/diagnose, which reported
 * "0 open roles have a keyword containing 'a'" while the search clause itself ran fine.
 *
 * Going via jsonb is the fix: the value crosses as ONE ordinary text parameter (so it is
 * injection-safe and needs no manual escaping of commas, quotes, braces or backslashes — all of
 * which appear in this catalog's text), and jsonb_array_elements_text unpacks it unambiguously.
 * Hand-building a '{a,b,c}' array literal would also work but requires getting that escaping
 * exactly right, which is not worth the risk here.
 */
function textArray(xs: string[] | null | undefined) {
  const arr = (xs || []).filter((x) => typeof x === 'string');
  return sql`COALESCE((SELECT array_agg(t.x) FROM jsonb_array_elements_text(${JSON.stringify(arr)}::jsonb) AS t(x)), ARRAY[]::text[])`;
}

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
