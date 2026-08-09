// src/lib/job-twin.ts — THE JOB, EXPRESSED IN THE SAME VOCABULARY AS AN EVIDENCED CAPABILITY.
//
// =================================================================================================
// WHY THIS FILE HAD TO EXIST BEFORE ANY MATCHING COULD
// =================================================================================================
//
// The two sides of a comparison did not share a language. A job's requirement lived as
// `roles.skills` — a jsonb array of STRINGS somebody typed — and a person's capability lives as
// `hr_employee_skills.skill_id`, a UUID into a curated catalogue with evidence beside it. Comparing
// them would have been string overlap wearing a percentage, which is exactly the "keyword as proof
// of competence" failure the whole build forbids.
//
// So a job twin carries TWO different things and never lets them touch:
//
//   REQUIREMENTS   rows in job_requirements, each naming an hr_skills id, a necessity
//                  (required | preferred) and a minimum level, asserted by a named person with a
//                  written rationale. These are what a match is computed against.
//
//   KEYWORDS       the strings already in roles.skills and hiring_requisitions.skills_required.
//                  They are carried, shown, and marked as text. Nothing compares them, and there is
//                  no code path that promotes one into a requirement.
//
// A job with no requirements recorded is a job that cannot be matched, and this module says so in a
// sentence rather than falling back to the strings. Falling back is how the keyword trap gets walked
// into by a system that was designed to avoid it.
//
// =================================================================================================
// WHAT A JOB TWIN DOES NOT CARRY
// =================================================================================================
//
// No budget band, no salary, no compensation of any kind: pay is not a dimension of fit and putting
// it on the object next to a person's capabilities is how a comparison starts including it. It is
// also, on this platform, a field a candidate can see. hiring_requisitions.budget_band_min/max stay
// where they are, read by the finance surfaces that own them.
//
// No demographic preference of any kind, and no field shaped to hold one. There is no "profile",
// no "ideal candidate", no free-form criteria bag. A requirement is an hr_skills id plus a level,
// and that is the only thing the schema below can store.
//
// =================================================================================================
// THERE IS A SECOND REQUIREMENTS TABLE IN THIS WORKTREE, AND THIS FILE SAYS SO OUT LOUD
// =================================================================================================
//
// `hr_role_requirements` also exists. Its DDL is written by src/lib/person-spine.ts and it is read
// by src/lib/capability-coverage.ts. It stores the same idea — a role, an hr_skills id, a necessity,
// a minimum level and a written basis — with a different necessity vocabulary ('important' rather
// than required/preferred) and for ROLES ONLY, where `job_requirements` below also covers
// requisitions.
//
// The two are DIFFERENT TABLE NAMES, so unlike the skill-relations collision that src/lib/match.ts
// documents, neither one breaks the other: no query silently reads columns that are not there. What
// they do instead is quieter and lasts longer. Somebody records what a job asks for on one screen,
// opens the other screen, and is told the job has no requirements — and both screens are telling the
// truth about the table they read. A recruiter cannot be expected to know which of two tables their
// afternoon went into.
//
// THIS IS NOT A THING TO RESOLVE BY GUESSING. Merging them means choosing which module's write path
// survives and migrating rows that may already exist in production, which is a decision with an
// owner and not a tidy-up. It is recorded here, at the top of one of the two files, so that whoever
// makes that decision finds it stated rather than discovers it from a screen that says a job has no
// requirements when somebody spent an hour giving it some.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { logAudit } from '@/lib/audit';
import { clean, isUuid, logFail, rowsOf } from '@/lib/performance-scope';
import { ensurePerformanceSchema } from '@/lib/performance-schema';
import { asserted, classifyFieldName, type Asserted, type Provenance } from '@/lib/digital-twin';

const MOD = 'job-twin';
const WRITE_FAILED = 'We could not save that just now. Nothing was changed.';

/** The capability that already means "may define what a job is". No new key invents a second one. */
export const ROLES_EDIT = 'roles.edit';

export const JOB_KINDS = ['role', 'requisition'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const NECESSITIES = ['required', 'preferred'] as const;
export type Necessity = (typeof NECESSITIES)[number];

export const NECESSITY_LABELS: Record<Necessity, string> = {
  required: 'Required',
  preferred: 'Preferred',
};

// =================================================================================================
// SCHEMA — AND WHY IT IS NOT BEHIND ensureOnce()
// =================================================================================================
//
// src/lib/ensure-once.ts ends in `p.catch(() => {})`. A DDL failure inside it RESOLVES, and the
// caller reports success: ten module tables were reported created on this project and none of them
// existed. The memo below rethrows on failure and clears itself so the next call retries, and
// verifyJobTwinSchema() then asks information_schema what is ACTUALLY there. Nothing in this file
// reports a table as present because an ensure resolved.

let _ready: Promise<void> | null = null;

export function ensureJobTwinSchema(): Promise<void> {
  if (_ready) return _ready;
  _ready = (async () => {
    try {
      // hr_skills is the catalogue this table references, and performance-schema.ts owns its DDL.
      // Asking for it first means a fresh database cannot fail this CREATE on a missing reference.
      await ensurePerformanceSchema();

      await db.execute(sql`CREATE TABLE IF NOT EXISTS job_requirements (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        job_kind VARCHAR(20) NOT NULL,
        job_id UUID NOT NULL,
        skill_id UUID NOT NULL REFERENCES hr_skills(id) ON DELETE CASCADE,
        necessity VARCHAR(20) NOT NULL DEFAULT 'required',
        min_level INT NOT NULL DEFAULT 3,
        rationale TEXT,
        asserted_by_user_id UUID,
        asserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        is_active BOOLEAN NOT NULL DEFAULT true,
        CONSTRAINT job_requirements_key UNIQUE (job_kind, job_id, skill_id)
      )`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS job_requirements_job_idx ON job_requirements(job_kind, job_id, necessity)`);
      await db.execute(sql`CREATE INDEX IF NOT EXISTS job_requirements_skill_idx ON job_requirements(skill_id)`);
    } catch (e: any) {
      logFail(MOD, 'ensureJobTwinSchema', e);
      _ready = null; // never cache a failed bootstrap for the life of the process
      throw e;
    }
  })();
  return _ready;
}

export interface SchemaReport {
  ok: boolean;
  present: string[];
  missing: string[];
  sentence: string;
  error?: string;
}

export const JOB_TWIN_TABLES = ['job_requirements'] as const;

/** What is ACTUALLY in the database. Never the ensure's return value. */
export async function verifyJobTwinSchema(): Promise<SchemaReport> {
  try {
    await ensureJobTwinSchema().catch(() => {});
    const r = rowsOf(await db.execute(sql`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN (${sql.join(JOB_TWIN_TABLES.map((t) => sql`${t}`), sql`, `)})`));
    const present = r.map((x: any) => String(x.table_name));
    const missing = JOB_TWIN_TABLES.filter((t) => present.indexOf(t) < 0);
    return {
      ok: missing.length === 0,
      present,
      missing,
      sentence: missing.length === 0
        ? 'Every table this module needs exists in the database.'
        : 'These tables are NOT in the database: ' + missing.join(', ')
          + '. Nothing that needs them will work, whatever a bootstrap reported.',
    };
  } catch (e: any) {
    const reason = e?.cause?.message || e?.message || 'unknown';
    logFail(MOD, 'verifyJobTwinSchema', e);
    return {
      ok: false, present: [], missing: [...JOB_TWIN_TABLES], error: reason,
      sentence: 'We could not read the database catalogue, so we cannot say what exists. (' + reason + ')',
    };
  }
}

// =================================================================================================
// REQUIREMENTS
// =================================================================================================

export interface JobRequirement {
  id: string;
  jobKind: JobKind;
  jobId: string;
  skillId: string;
  skillName: string;
  category: string;
  necessity: Necessity;
  minLevel: number;
  rationale: string | null;
  provenance: Provenance;
}

function mapRequirement(r: any): JobRequirement {
  const minLevel = Math.min(Math.max(Number(r?.min_level) || 3, 1), 5);
  return {
    id: String(r?.id ?? ''),
    jobKind: (String(r?.job_kind) === 'requisition' ? 'requisition' : 'role') as JobKind,
    jobId: String(r?.job_id ?? ''),
    skillId: String(r?.skill_id ?? ''),
    skillName: r?.skill_name ? String(r.skill_name) : '',
    category: r?.category ? String(r.category) : 'general',
    necessity: (String(r?.necessity) === 'preferred' ? 'preferred' : 'required') as Necessity,
    minLevel,
    rationale: r?.rationale ? String(r.rationale) : null,
    provenance: {
      assertion: 'provided',
      source: 'job-twin (job_requirements)',
      basis: 'A named person recorded this as a requirement of the job, with a written reason. '
        + 'It is a decision about the job, not a measurement of anybody.',
      recordedAt: r?.asserted_at ? new Date(r.asserted_at).toISOString() : null,
      assertedByUserId: r?.asserted_by_user_id ? String(r.asserted_by_user_id) : null,
      evidenceUrl: null,
    },
  };
}

export async function jobRequirements(jobKind: JobKind, jobId: string): Promise<JobRequirement[]> {
  if (!isUuid(jobId)) return [];
  const kind: JobKind = jobKind === 'requisition' ? 'requisition' : 'role';
  try {
    await ensureJobTwinSchema();
    const rows = rowsOf(await db.execute(sql`
      SELECT jr.*, s.name AS skill_name, s.category
        FROM job_requirements jr
        JOIN hr_skills s ON s.id = jr.skill_id
       WHERE jr.job_kind = ${kind} AND jr.job_id = ${jobId}::uuid AND jr.is_active = true
       ORDER BY jr.necessity ASC, jr.min_level DESC, s.name ASC
       LIMIT 200`));
    return rows.map(mapRequirement);
  } catch (e: any) {
    logFail(MOD, 'jobRequirements', e);
    return [];
  }
}

export interface RequirementWriteResult {
  ok: boolean;
  id?: string;
  error?: string;
}

/**
 * Record what a job asks for, in the catalogue's vocabulary.
 *
 * A RATIONALE IS REQUIRED. A requirement with no written reason is the thing that later gets
 * defended as "the system said so": every requirement here has a person's name and a sentence
 * attached, so a candidate refused against it can be told why the bar exists.
 *
 * The caller checks `roles.edit` and passes the answer in. This module reads no authorization
 * engine and must never become one.
 */
export async function setJobRequirement(input: {
  jobKind: JobKind;
  jobId: string;
  skillId: string;
  necessity?: Necessity;
  minLevel?: number;
  rationale: string;
  actorUserId: string;
  /** True when the caller holds `roles.edit`. Checked on the page, asked for here. */
  mayEditJobs: boolean;
}): Promise<RequirementWriteResult> {
  if (input?.mayEditJobs !== true) {
    return { ok: false, error: 'Defining what a job requires needs ' + ROLES_EDIT + '. Nothing was changed.' };
  }
  const kind: JobKind = input?.jobKind === 'requisition' ? 'requisition' : 'role';
  const jobId = String(input?.jobId || '');
  const skillId = String(input?.skillId || '');
  if (!isUuid(jobId) || !isUuid(skillId)) return { ok: false, error: 'Choose a job and a skill from the catalogue.' };
  const necessity: Necessity = input?.necessity === 'preferred' ? 'preferred' : 'required';
  const minLevel = Math.min(Math.max(Math.round(Number(input?.minLevel) || 3), 1), 5);
  const rationale = clean(input?.rationale, 1000);
  if (rationale.length < 12) {
    return { ok: false, error: 'Write why the job needs this. A requirement without a reason cannot be explained to somebody it excludes.' };
  }
  const actor = isUuid(input?.actorUserId) ? String(input.actorUserId) : null;

  try {
    await ensureJobTwinSchema();
    const rows = rowsOf(await db.execute(sql`
      INSERT INTO job_requirements (job_kind, job_id, skill_id, necessity, min_level, rationale, asserted_by_user_id)
      VALUES (${kind}, ${jobId}::uuid, ${skillId}::uuid, ${necessity}, ${minLevel}::int, ${rationale}::text, ${actor}::uuid)
      ON CONFLICT (job_kind, job_id, skill_id) DO UPDATE
        SET necessity = EXCLUDED.necessity,
            min_level = EXCLUDED.min_level,
            rationale = EXCLUDED.rationale,
            asserted_by_user_id = EXCLUDED.asserted_by_user_id,
            asserted_at = NOW(),
            is_active = true
      RETURNING id`));
    if (!rows.length) return { ok: false, error: WRITE_FAILED };
    await logAudit({
      userId: actor,
      action: 'job.requirement.set',
      entity: 'job_requirements',
      entityId: String(rows[0].id),
      diff: { jobKind: kind, jobId, skillId, necessity, minLevel },
    });
    return { ok: true, id: String(rows[0].id) };
  } catch (e: any) {
    // A write path never swallows. The caller prints this instead of a page that looks like it saved.
    logFail(MOD, 'setJobRequirement', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

export async function removeJobRequirement(
  requirementId: string,
  actorUserId: string | null,
  mayEditJobs: boolean,
): Promise<RequirementWriteResult> {
  if (mayEditJobs !== true) {
    return { ok: false, error: 'Changing what a job requires needs ' + ROLES_EDIT + '. Nothing was changed.' };
  }
  if (!isUuid(requirementId)) return { ok: false, error: 'That requirement does not exist.' };
  try {
    await ensureJobTwinSchema();
    // Retired, not deleted: a comparison run last week cited this requirement, and deleting the row
    // would make that explanation unreadable.
    const rows = rowsOf(await db.execute(sql`
      UPDATE job_requirements SET is_active = false WHERE id = ${requirementId}::uuid RETURNING id`));
    if (!rows.length) return { ok: false, error: 'That requirement does not exist.' };
    await logAudit({
      userId: isUuid(actorUserId) ? String(actorUserId) : null,
      action: 'job.requirement.retire',
      entity: 'job_requirements',
      entityId: requirementId,
      diff: {},
    });
    return { ok: true, id: requirementId };
  } catch (e: any) {
    logFail(MOD, 'removeJobRequirement', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

// =================================================================================================
// THE JOB TWIN
// =================================================================================================

export interface JobTwin {
  jobKind: JobKind;
  jobId: string;
  exists: boolean;
  title: Asserted<string> | null;
  functionSummary: Asserted<string> | null;
  seniority: Asserted<string> | null;
  engagementType: Asserted<string> | null;
  workMode: Asserted<string> | null;
  domain: Asserted<{ departmentId: string | null; departmentName: string | null }> | null;
  responsibilities: Asserted<string[]> | null;
  expectedOutcomes: Asserted<string[]> | null;
  educationExpectation: Asserted<string[]> | null;
  experienceExpectation: Asserted<string> | null;

  /** What a match is computed against. */
  requiredSkills: JobRequirement[];
  preferredSkills: JobRequirement[];

  /**
   * The strings already on the job. Carried so a screen can show them; never compared.
   * `unmapped` is the honest number: how many of them have no requirement behind them.
   */
  keywords: {
    words: string[];
    unmapped: string[];
    provenance: Provenance;
    sentence: string;
  };

  /** False when no requirement is recorded. A match must refuse rather than fall back to words. */
  matchable: boolean;
  sentence: string;
  /** A read failed. Distinct from a job that has nothing recorded. */
  readFailed: boolean;
}

const strList = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map((x) => clean(typeof x === 'string' ? x : '', 400)).filter(Boolean);
  if (typeof v === 'string') {
    return v.split(/\r?\n|;/).map((s) => clean(s, 400)).filter(Boolean);
  }
  return [];
};

/**
 * Build the job twin.
 *
 * A ROLE is the public job. A REQUISITION is the internal request that opens one. Both are read
 * through the same shape so a comparison does not need to know which it is looking at.
 */
export async function buildJobTwin(input: { jobKind: JobKind; jobId: string }): Promise<JobTwin> {
  const kind: JobKind = input?.jobKind === 'requisition' ? 'requisition' : 'role';
  const jobId = String(input?.jobId || '');

  const empty: JobTwin = {
    jobKind: kind, jobId, exists: false,
    title: null, functionSummary: null, seniority: null, engagementType: null, workMode: null,
    domain: null, responsibilities: null, expectedOutcomes: null,
    educationExpectation: null, experienceExpectation: null,
    requiredSkills: [], preferredSkills: [],
    keywords: {
      words: [], unmapped: [],
      provenance: {
        assertion: 'provided', source: 'none', basis: 'Nothing was read.',
        recordedAt: null, assertedByUserId: null, evidenceUrl: null,
      },
      sentence: 'Nothing was read.',
    },
    matchable: false,
    sentence: 'No job could be resolved from what was asked for.',
    readFailed: false,
  };
  if (!isUuid(jobId)) return empty;

  let row: any = null;
  let readFailed = false;
  let departmentName: string | null = null;

  try {
    if (kind === 'role') {
      const r = rowsOf(await db.execute(sql`
        SELECT r.id, r.title, r.function, r.level, r.engagement_type, r.location, r.duration,
               r.about, r.responsibilities, r.skills, r.eligibility, r.is_open,
               r.department_id::text AS department_id, d.name AS department_name
          FROM roles r
          LEFT JOIN departments d ON d.id::text = r.department_id::text
         WHERE r.id = ${jobId}::uuid
         LIMIT 1`));
      row = r.length ? r[0] : null;
      departmentName = row?.department_name ? String(row.department_name) : null;
    } else {
      const r = rowsOf(await db.execute(sql`
        SELECT id, role_title, department, level, engagement_type, work_mode, country,
               justification, kras, skills_required, status
          FROM hiring_requisitions
         WHERE id = ${jobId}::uuid
         LIMIT 1`));
      row = r.length ? r[0] : null;
      departmentName = row?.department ? String(row.department) : null;
    }
  } catch (e: any) {
    logFail(MOD, 'buildJobTwin:read', e);
    readFailed = true;
  }

  if (!row) {
    return {
      ...empty,
      readFailed,
      sentence: readFailed
        ? 'The job record could not be read just now, so nothing is shown. That is not a statement that the job does not exist.'
        : 'There is no job on file with that id.',
    };
  }

  const reqs = await jobRequirements(kind, jobId);
  const required = reqs.filter((r) => r.necessity === 'required');
  const preferred = reqs.filter((r) => r.necessity === 'preferred');

  const words = kind === 'role' ? strList(row.skills) : strList(row.skills_required);
  const haveNames = new Set(reqs.map((r) => r.skillName.toLowerCase()));
  const unmapped = words.filter((w) => !haveNames.has(w.toLowerCase()));

  const jobSource = kind === 'role' ? 'roles' : 'hiring_requisitions';
  const authored = 'Written by whoever authored the job. It describes the job, and nothing in it is a measurement of any person.';

  // The field names this twin exposes are screened by the same classifier the person twin uses, so a
  // job cannot acquire a demographic expectation by somebody adding a column upstream.
  const guardedFields = ['title', 'function', 'level', 'engagement_type', 'work_mode', 'department', 'eligibility'];
  const leaked = guardedFields.filter((f) => classifyFieldName(f) !== 'ok');
  if (leaked.length) console.error('[' + MOD + '] refusing job fields: ' + leaked.join(', '));

  const title = row.title ? String(row.title) : (row.role_title ? String(row.role_title) : null);

  return {
    jobKind: kind,
    jobId,
    exists: true,
    readFailed,
    title: title ? asserted(title, 'provided', jobSource + '.title', authored) : null,
    functionSummary: row.function
      ? asserted(String(row.function), 'provided', jobSource + '.function', authored)
      : (row.justification ? asserted(String(row.justification), 'provided', jobSource + '.justification', authored) : null),
    seniority: row.level ? asserted(String(row.level), 'provided', jobSource + '.level', authored) : null,
    engagementType: row.engagement_type
      ? asserted(String(row.engagement_type), 'provided', jobSource + '.engagement_type', authored)
      : null,
    workMode: row.work_mode
      ? asserted(String(row.work_mode), 'provided', jobSource + '.work_mode', authored)
      : (row.location ? asserted(String(row.location), 'provided', jobSource + '.location', authored) : null),
    domain: asserted(
      { departmentId: row.department_id ? String(row.department_id) : null, departmentName },
      'provided', jobSource + '.department', 'Where in the organization the job sits.',
    ),
    responsibilities: (() => {
      const list = strList(row.responsibilities);
      return list.length ? asserted(list, 'provided', jobSource + '.responsibilities', authored) : null;
    })(),
    expectedOutcomes: (() => {
      const list = strList(row.kras);
      return list.length
        ? asserted(list, 'provided', jobSource + '.kras',
          'The outcomes written down when the job was requested. They are what the job is for, not a bar any candidate has cleared.')
        : null;
    })(),
    educationExpectation: (() => {
      const list = strList(row.eligibility);
      return list.length
        ? asserted(list, 'provided', jobSource + '.eligibility',
          'Eligibility text the job author wrote. It is prose: nothing parses it, and nothing scores a person against it automatically.')
        : null;
    })(),
    experienceExpectation: row.level
      ? asserted(String(row.level), 'provided', jobSource + '.level',
        'The seniority band on the job. It is a label, not a number of years, and it is compared as a label.')
      : null,
    requiredSkills: required,
    preferredSkills: preferred,
    keywords: {
      words,
      unmapped,
      provenance: {
        assertion: 'provided',
        source: jobSource + (kind === 'role' ? '.skills' : '.skills_required'),
        basis: 'Words somebody typed on the job. A word is not a requirement and is not compared against anybody.',
        recordedAt: null, assertedByUserId: null, evidenceUrl: null,
      },
      sentence: unmapped.length === 0
        ? 'Every word written on this job also exists as a recorded requirement.'
        : unmapped.length + ' of the ' + words.length + ' words written on this job have no requirement behind them. '
          + 'They are shown as text and are not compared against any person.',
    },
    matchable: reqs.length > 0,
    sentence: reqs.length > 0
      ? 'This job has ' + required.length + ' required and ' + preferred.length + ' preferred capabilities recorded in the skills catalogue, so it can be compared against evidence.'
      : 'This job has no requirements recorded in the skills catalogue. It cannot be compared against anybody: '
        + 'the words on the job description are text, and treating text as a requirement is how a keyword becomes a verdict.',
  };
}
