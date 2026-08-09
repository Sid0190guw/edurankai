// src/lib/eims-programme.ts — THE PROGRAMME, AND WHO IS ON ONE.
//
// =================================================================================================
// WHAT WAS MISSING, AND WHY IT MATTERS MORE THAN IT SOUNDS
// =================================================================================================
//
// Every rule in this system is already per-PROGRAMME: eims_workload_policy holds a ceiling per
// programme key, eims_credit_configs holds a credit conversion per programme key, eims_rubric_criteria
// holds a rubric per programme key, eims_outcomes holds outcomes per programme key. And until this
// file there was no such thing as a programme, and no record anywhere of WHICH ONE A PERSON IS ON.
//
// The key was being GUESSED, per read, from resolveEngagementPolicy() over employment_type and job
// title — the two fields the codebase already documents as written inconsistently across records.
// So a person's weekly ceiling, the meaning of their credits and the rubric they are graded against
// were all decided by how somebody once typed a job title. That is not a configuration; it is a
// coincidence, and it is the coincidence a completion document was resting on.
//
// TWO NOUNS, AND NOTHING ELSE:
//
//   A PROGRAMME  is the offer: a name, the accredited partner it is run with, how long it runs, the
//                total hours it requires, the kind of work its evidence types are drawn from, and
//                whether it is open to enrol into.
//
//   AN ENROLMENT is one named person on one programme between two dates. It is what binds them to
//                the ceiling, the credit conversion and the rubric. One open enrolment per person,
//                enforced by a partial unique index in the DATABASE and not only by this file.
//
// =================================================================================================
// THIS FILE STORES NO CEILING, NO CREDIT RULE AND NO RUBRIC. ON PURPOSE.
// =================================================================================================
//
// The obvious shape for a programme table is one row carrying every rule: ceiling, credits, weights.
// It is also how this system ends up with two ceilings that disagree. The ceiling has exactly one
// writer — setProgrammeCeiling() in src/lib/eims-workload.ts, which is the only code that refuses a
// figure above the statutory weekly maximum. The credit conversion has exactly one writer,
// saveCreditConfig() in src/lib/eims-credit.ts, which is the only code that refuses a component
// conditioned on attendance. Copying either number here would create a second place to change it and
// a first opportunity to bypass the refusal that guards it.
//
// So the ADMIN SCREEN writes through those functions, and programmeRules() below READS them back
// together for display. What this file owns is the programme's identity and its enrolments — the two
// facts nothing else stores.
//
// The one hour figure that does live here is `required_hours`: the TOTAL a programme asks for over
// its whole length. Nothing else in the codebase holds it — requiredWeeklyHours() answers a WEEK —
// and a completion record needs to say what "complete" was measured against.
//
// =================================================================================================
// RELATIONSHIPS ARE ORG-GRAPH ROWS. AN ENROLMENT IS NOT A GRANT.
// =================================================================================================
//
// Enrolling somebody records a mentor and a reporting manager THROUGH src/lib/org-graph.ts
// (supersedeMentor / supersedeReportingManager), which close the previous edge and open the new one
// at the same instant so "who was the mentor on the day this was verified" stays answerable. This
// file has no relationship table, resolves no relationship of its own, and confers no authority: the
// question "may this person verify these hours" is asked again, per row, from the graph, at the write.
//
// =================================================================================================
// WHAT THIS FILE WILL NOT DO
// =================================================================================================
//
//   - IT WRITES NO HOURS. Not allocated, not completed, and above all not verified. There is no
//     function here that touches an hour on anybody's record, and an HR console built on this file
//     therefore cannot become a place where hours are edited into existence away from the mentor who
//     verified them.
//   - IT GRADES NOBODY AND AWARDS NOTHING. EduRankAI is the technology platform: it computes and
//     evidences, and an accredited partner awards the credential. `partner_institution` is recorded
//     precisely so the document can name who awards, and it is never this platform.
//   - IT MEASURES NO ATTENDANCE. Nothing here reads hr_attendance, and an enrolment carries no
//     presence figure of any kind.
//   - IT DELETES NOTHING. A finished enrolment is closed with a state and a written reason. A
//     retired programme is a state, not a DELETE, because records already issued must still be able
//     to say what they were issued under.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { logAudit } from '@/lib/audit';
import { can, type Permission } from '@/lib/auth/permissions';
import {
  supersedeMentor, supersedeReportingManager, getMentorsFor, getManagersFor,
  type OrgPerson,
} from '@/lib/org-graph';
import {
  listProgrammeCeilings, setProgrammeCeiling, resolveWeeklyCeiling,
  DEFAULT_PROGRAMME_KEY, DEFAULT_WEEKLY_CEILING_HOURS,
  type ProgrammeCeiling, type WeeklyCeiling,
} from '@/lib/eims-workload';
import {
  activeCreditConfig, listRubricCriteria,
  type CreditConfig, type RubricCriterion,
} from '@/lib/eims-credit';
import { ROLE_KEYS, ROLE_LABELS, isRoleKey, evidenceTypesForRole } from '@/lib/eims-evidence';
import { weekStartOf, weekEndOf, isoDate } from '@/lib/credit-week';

// -------------------------------------------------------------------------------------------------
// MODULE CONSTANTS — every one declared ABOVE the function that reads it. `const` is not hoisted.
// -------------------------------------------------------------------------------------------------

/** postgres-js resolves to a PLAIN ARRAY, never { rows }. */
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** The real Postgres reason is on e.cause; e.message is only the SQL that failed. */
const logFail = (tag: string, e: any) =>
  console.error('[eims-programme] ' + tag, e?.cause?.message || e?.message);

const WRITE_FAILED = 'Something went wrong saving that. Nothing was changed. Try again in a moment.';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v: unknown): v is string => typeof v === 'string' && DATE_RE.test(v);

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const num = (v: any): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? round2(n) : null;
};

const MAX_ROWS = 400;

/** The same normalisation eims-workload uses, so one programme is one key across both tables. */
const normaliseKey = (v: unknown): string =>
  String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);

/** A closing reason shorter than this is not a reason. */
export const MIN_CLOSE_REASON = 10;

/** The permission that owns the offer. */
export const CONFIGURE_PERMISSION: Permission = 'eims.programme.configure';
/** The permission that owns who is on it. */
export const ENROL_PERMISSION: Permission = 'eims.enrolment.manage';

export const PLATFORM_ROLE_SENTENCE =
  'EduRankAI is the technology platform. It records and evidences what an intern did; the accredited '
  + 'partner named on the programme is who awards any credential for it.';

export const NOT_ATTENDANCE_SENTENCE =
  'Nothing on this page is measured from attendance. A programme is measured in hours somebody '
  + 'allocated, an intern reported, and a mentor verified.';

export const ENROLMENT_BINDS_SENTENCE =
  'An enrolment is what binds a person to a rule set: the weekly ceiling, the required hours, the '
  + 'credit conversion and the rubric they will be measured under. Moving somebody between '
  + 'programmes changes what their record will say without touching a single hour, which is why '
  + 'every change here is written to the audit log with who made it and when.';

export const NO_AUTHORITY_SENTENCE =
  'Recording a mentor or a reporting manager here writes a relationship into the organization graph. '
  + 'It grants nobody any power: whether a person may verify an hour, approve a week or assess an '
  + 'outcome is asked again, for that row, at the moment of the write.';

export interface Actor {
  id?: string | null;
  role?: string | null;
  isActive?: boolean | null;
  name?: string | null;
  email?: string | null;
}

// -------------------------------------------------------------------------------------------------
// THE VOCABULARY
// -------------------------------------------------------------------------------------------------

export const PROGRAMME_STATES = ['draft', 'open', 'closed'] as const;
export type ProgrammeState = (typeof PROGRAMME_STATES)[number];
export const isProgrammeState = (v: unknown): v is ProgrammeState =>
  typeof v === 'string' && (PROGRAMME_STATES as readonly string[]).includes(v);

export const PROGRAMME_STATE_LABELS: Record<ProgrammeState, string> = {
  draft: 'Draft, not open to enrol into',
  open: 'Open to enrol into',
  closed: 'Closed to new enrolments',
};

/**
 * ENROLMENT STATES. Three, and the difference between the last two is the whole point.
 *
 *   active     on the programme now.
 *   completed  reached the end of the programme. This is the numerator of the completion rate.
 *   withdrawn  left before the end, for any reason at all. It is NOT a judgement and no screen may
 *              render it as one: illness, a university timetable, a better offer and a change of
 *              plan all land here, and the written reason is what distinguishes them.
 */
export const ENROLMENT_STATES = ['active', 'completed', 'withdrawn'] as const;
export type EnrolmentState = (typeof ENROLMENT_STATES)[number];
export const isEnrolmentState = (v: unknown): v is EnrolmentState =>
  typeof v === 'string' && (ENROLMENT_STATES as readonly string[]).includes(v);

export const ENROLMENT_STATE_LABELS: Record<EnrolmentState, string> = {
  active: 'On the programme',
  completed: 'Completed the programme',
  withdrawn: 'Left before the end',
};

// -------------------------------------------------------------------------------------------------
// SCHEMA — additive, self-bootstrapping, inside one guard, under a key of its own.
// -------------------------------------------------------------------------------------------------

/**
 * A NEW ensureOnce KEY, because a spent key never runs again in a process. Appending these
 * statements to 'eims_workload_v1' would mean the tables never appear on any environment that has
 * already booted the current code — which is the failure mode where the deploy is green and the
 * feature is absent.
 */
export function ensureProgrammeSchema(): Promise<void> {
  return ensureOnce('eims_programme_v1', async () => {
    try {
      await createProgrammeTables();
    } catch (e: any) {
      // Re-thrown after logging: ensureOnce drops a failed run from its cache so the next call
      // retries, and swallows the rejection for callers.
      logFail('ensureProgrammeSchema', e);
      throw e;
    }
  });
}

async function createProgrammeTables(): Promise<void> {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS eims_programmes (
    programme_key TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    description TEXT,
    state TEXT NOT NULL DEFAULT 'draft',
    partner_institution TEXT,
    duration_weeks INT,
    required_hours NUMERIC(8,2),
    role_key TEXT NOT NULL DEFAULT 'general',
    note TEXT,
    created_by_user_id UUID,
    updated_by_user_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  for (const stmt of [
    'ALTER TABLE eims_programmes ADD COLUMN IF NOT EXISTS partner_institution TEXT',
    'ALTER TABLE eims_programmes ADD COLUMN IF NOT EXISTS duration_weeks INT',
    'ALTER TABLE eims_programmes ADD COLUMN IF NOT EXISTS required_hours NUMERIC(8,2)',
    'ALTER TABLE eims_programmes ADD COLUMN IF NOT EXISTS role_key TEXT NOT NULL DEFAULT \'general\'',
    'ALTER TABLE eims_programmes ADD COLUMN IF NOT EXISTS note TEXT',
    'ALTER TABLE eims_programmes ADD COLUMN IF NOT EXISTS updated_by_user_id UUID',
  ]) {
    await db.execute(sql.raw(stmt));
  }

  await db.execute(sql`CREATE TABLE IF NOT EXISTS eims_enrolments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id UUID NOT NULL,
    programme_key TEXT NOT NULL,
    role_key TEXT NOT NULL DEFAULT 'general',
    state TEXT NOT NULL DEFAULT 'active',
    started_on DATE NOT NULL,
    ends_on DATE,
    required_hours NUMERIC(8,2),
    note TEXT,
    enrolled_by_user_id UUID,
    closed_on DATE,
    closed_reason TEXT,
    closed_by_user_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  for (const stmt of [
    'ALTER TABLE eims_enrolments ADD COLUMN IF NOT EXISTS required_hours NUMERIC(8,2)',
    'ALTER TABLE eims_enrolments ADD COLUMN IF NOT EXISTS closed_on DATE',
    'ALTER TABLE eims_enrolments ADD COLUMN IF NOT EXISTS closed_reason TEXT',
    'ALTER TABLE eims_enrolments ADD COLUMN IF NOT EXISTS closed_by_user_id UUID',
  ]) {
    await db.execute(sql.raw(stmt));
  }

  // ONE OPEN ENROLMENT PER PERSON, ENFORCED BY THE DATABASE. A second code path — an import, a
  // script, a future screen — cannot get around a partial unique index, and two open enrolments
  // would mean two ceilings and two credit conversions for the same week with no rule for which wins.
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS eims_enrolments_one_open
    ON eims_enrolments (employee_id) WHERE state = 'active'`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS eims_enrolments_programme
    ON eims_enrolments (programme_key, state)`);

  // SEEDED, NEVER OVERWRITTEN. The seed matches the programme keys eims_workload_policy already
  // seeds, so the ceiling that exists and the programme that names it are the same row from the
  // first boot. ON CONFLICT DO NOTHING is what makes an administrator's edit survive a deploy.
  try {
    const seeds: { key: string; label: string; state: ProgrammeState; weeks: number | null; description: string }[] = [
      {
        key: 'Intern', label: 'Internship', state: 'open', weeks: 24,
        description: 'The published internship policy: forty hours of total recognised engagement a '
          + 'week, holistic fitness and well-being counted inside that forty and never added on top. '
          + 'Any day of the week — interns are university students and the system does not impose a '
          + 'timetable.',
      },
      {
        key: 'Apprentice', label: 'Apprenticeship', state: 'draft', weeks: 52,
        description: 'The same weekly shape as the internship, over a longer engagement.',
      },
    ];
    for (const s of seeds) {
      await db.execute(sql`
        INSERT INTO eims_programmes (programme_key, label, description, state, duration_weeks, role_key)
        VALUES (${s.key}, ${s.label}, ${s.description}, ${s.state}, ${s.weeks}, 'general')
        ON CONFLICT (programme_key) DO NOTHING`);
    }
  } catch (e: any) {
    logFail('seed programmes', e);
  }
}

// -------------------------------------------------------------------------------------------------
// THE PROGRAMME
// -------------------------------------------------------------------------------------------------

export interface ProgrammeRow {
  programmeKey: string;
  label: string;
  description: string;
  state: ProgrammeState;
  partnerInstitution: string | null;
  durationWeeks: number | null;
  /** The TOTAL hours the programme requires over its whole length. Null where nobody has said. */
  requiredHours: number | null;
  roleKey: string;
  roleLabel: string;
  note: string;
  updatedByUserId: string | null;
  updatedAt: string | null;
}

const mapProgramme = (r: any): ProgrammeRow => {
  const state = String(r.state || 'draft');
  const roleKey = String(r.role_key || 'general');
  return {
    programmeKey: String(r.programme_key),
    label: String(r.label || r.programme_key),
    description: String(r.description || ''),
    state: isProgrammeState(state) ? state : 'draft',
    partnerInstitution: r.partner_institution ? String(r.partner_institution) : null,
    durationWeeks: r.duration_weeks == null ? null : Number(r.duration_weeks),
    requiredHours: num(r.required_hours),
    roleKey,
    roleLabel: isRoleKey(roleKey) ? String(ROLE_LABELS[roleKey]) : roleKey,
    note: String(r.note || ''),
    updatedByUserId: r.updated_by_user_id ? String(r.updated_by_user_id) : null,
    updatedAt: r.updated_at ? String(r.updated_at) : null,
  };
};

export interface ProgrammesRead {
  ok: boolean;
  programmes: ProgrammeRow[];
  /** Empty when ok. A sentence for a person, never a database message. */
  error: string;
}

/**
 * EVERY PROGRAMME. An unreadable table returns ok:false with an EMPTY list and a sentence — never a
 * fabricated default row, because a screen that invents a programme is a screen somebody enrols into.
 */
export async function listProgrammes(includeClosed = true): Promise<ProgrammesRead> {
  try {
    await ensureProgrammeSchema();
    const list = rows(await db.execute(sql`
      SELECT programme_key, label, description, state, partner_institution, duration_weeks,
             required_hours, role_key, note, updated_by_user_id, updated_at
        FROM eims_programmes
       WHERE (${includeClosed}::boolean OR state <> 'closed')
       ORDER BY (state = 'open') DESC, label ASC
       LIMIT 200`)).map(mapProgramme);
    return { ok: true, programmes: list, error: '' };
  } catch (e: any) {
    logFail('listProgrammes', e);
    return {
      ok: false,
      programmes: [],
      error: 'The list of programmes could not be read. That is a failure to read it, not an absence '
        + 'of programmes, and nothing below is a measurement.',
    };
  }
}

export async function getProgramme(programmeKey: string): Promise<ProgrammeRow | null> {
  const key = normaliseKey(programmeKey);
  if (!key) return null;
  try {
    await ensureProgrammeSchema();
    const r = rows(await db.execute(sql`
      SELECT programme_key, label, description, state, partner_institution, duration_weeks,
             required_hours, role_key, note, updated_by_user_id, updated_at
        FROM eims_programmes WHERE lower(programme_key) = ${key} LIMIT 1`))[0];
    return r ? mapProgramme(r) : null;
  } catch (e: any) {
    logFail('getProgramme', e);
    return null;
  }
}

export interface ProgrammeWriteResult {
  ok: boolean;
  programmeKey: string;
  error: string;
}

/**
 * CREATE OR EDIT A PROGRAMME.
 *
 * THE CEILING IS NOT A PARAMETER OF THIS FUNCTION. `weeklyCeilingHours` is accepted and handed
 * straight to setProgrammeCeiling(), which is the only code in this codebase that refuses a ceiling
 * above the statutory weekly maximum. Storing it here as well would create a second figure and a
 * first way past that refusal. Where the ceiling write fails, THIS WRITE STILL REPORTS THE FAILURE
 * rather than returning ok with a stale ceiling in force.
 *
 * EVERY SAVE IS AUDITED with the user id and the fields that changed. That is the "audited with who
 * and when" requirement, satisfied by logAudit() rather than by a second bespoke log.
 */
export async function saveProgramme(
  actor: Actor | null,
  input: {
    programmeKey: string;
    label: string;
    description?: string | null;
    state?: string | null;
    partnerInstitution?: string | null;
    durationWeeks?: number | null;
    requiredHours?: number | null;
    roleKey?: string | null;
    note?: string | null;
    /** Handed to setProgrammeCeiling(). Omit to leave the recorded ceiling alone. */
    weeklyCeilingHours?: number | null;
  },
): Promise<ProgrammeWriteResult> {
  if (!can(actor as any, CONFIGURE_PERMISSION)) {
    return { ok: false, programmeKey: '', error: 'You do not hold the desk that configures internship programmes.' };
  }

  const key = normaliseKey(input?.programmeKey);
  if (!key) {
    return { ok: false, programmeKey: '', error: 'A programme needs a short key, for example "intern".' };
  }
  const label = String(input?.label || '').trim().slice(0, 160);
  if (!label) {
    return { ok: false, programmeKey: key, error: 'A programme needs a name people will read.' };
  }

  const stateRaw = String(input?.state || 'draft');
  const state: ProgrammeState = isProgrammeState(stateRaw) ? stateRaw : 'draft';

  const weeks = num(input?.durationWeeks);
  if (weeks != null && (weeks <= 0 || weeks > 260)) {
    return { ok: false, programmeKey: key, error: 'Give the length in weeks as a number between 1 and 260, or leave it blank.' };
  }
  const requiredHours = num(input?.requiredHours);
  if (requiredHours != null && requiredHours < 0) {
    return { ok: false, programmeKey: key, error: 'Required hours cannot be negative. Leave it blank if nobody has decided yet.' };
  }

  const roleKeyRaw = String(input?.roleKey || 'general');
  const roleKey = isRoleKey(roleKeyRaw) ? roleKeyRaw : 'general';
  const actorId = isUuid(actor?.id) ? String(actor!.id) : null;

  // THE CEILING FIRST, THROUGH ITS OWN WRITER. If it refuses — above the statutory maximum, or a
  // typo below one hour — nothing else is written, so the programme never exists carrying a ceiling
  // that was rejected.
  const ceilingAsked = num(input?.weeklyCeilingHours);
  if (ceilingAsked != null) {
    const c = await setProgrammeCeiling({
      programmeKey: key,
      label,
      ceilingHours: ceilingAsked,
      note: String(input?.description || '').slice(0, 1000),
      actorUserId: actorId,
    });
    if (!c.ok) return { ok: false, programmeKey: key, error: c.error };
  }

  try {
    await ensureProgrammeSchema();
    await db.execute(sql`
      INSERT INTO eims_programmes
        (programme_key, label, description, state, partner_institution, duration_weeks,
         required_hours, role_key, note, created_by_user_id, updated_by_user_id)
      VALUES (${key}, ${label}, ${String(input?.description || '').slice(0, 4000)}, ${state},
              ${input?.partnerInstitution ? String(input.partnerInstitution).slice(0, 200) : null},
              ${weeks}, ${requiredHours}, ${roleKey},
              ${String(input?.note || '').slice(0, 2000)}, ${actorId}::uuid, ${actorId}::uuid)
      ON CONFLICT (programme_key) DO UPDATE SET
        label = EXCLUDED.label,
        description = EXCLUDED.description,
        state = EXCLUDED.state,
        partner_institution = EXCLUDED.partner_institution,
        duration_weeks = EXCLUDED.duration_weeks,
        required_hours = EXCLUDED.required_hours,
        role_key = EXCLUDED.role_key,
        note = EXCLUDED.note,
        updated_by_user_id = EXCLUDED.updated_by_user_id,
        updated_at = NOW()`);

    await logAudit({
      userId: actorId,
      action: 'eims.programme.save',
      entity: 'eims_programmes',
      entityId: key,
      diff: {
        label, state, roleKey, durationWeeks: weeks, requiredHours,
        partnerInstitution: input?.partnerInstitution || null,
        weeklyCeilingHours: ceilingAsked,
      },
    });
    return { ok: true, programmeKey: key, error: '' };
  } catch (e: any) {
    // NEVER SWALLOWED. This is a write path, and the real Postgres reason is on e.cause.
    logFail('saveProgramme', e);
    return { ok: false, programmeKey: key, error: WRITE_FAILED };
  }
}

// -------------------------------------------------------------------------------------------------
// THE RULES IN FORCE FOR A PROGRAMME, READ BACK FROM THEIR OWN OWNERS
// -------------------------------------------------------------------------------------------------

export interface ProgrammeRules {
  programme: ProgrammeRow | null;
  /** From eims_workload_policy, the single writer of a ceiling. */
  ceiling: ProgrammeCeiling | null;
  /** From eims_credit_configs, the single writer of a credit conversion. Null when none is in force. */
  credit: CreditConfig | null;
  /** From eims_rubric_criteria. */
  rubric: RubricCriterion[];
  /** The sum of the rubric weights. 100 is intended; anything else is stated, never silently scaled. */
  rubricWeightTotal: number;
  evidenceTypeCount: number;
  /** Named sources that could NOT be read. A rules page built on a gap says so. */
  unread: string[];
  /** Plain sentences a screen shows instead of inventing its own. */
  notes: string[];
}

/**
 * EVERY RULE IN FORCE FOR ONE PROGRAMME, gathered from the modules that own each one.
 *
 * Four reads, deliberately: one per owner. A single joined query would be faster and would also be
 * the moment this file started holding its own opinion about what a ceiling is.
 */
export async function programmeRules(programmeKey: string): Promise<ProgrammeRules> {
  const key = normaliseKey(programmeKey) || DEFAULT_PROGRAMME_KEY;
  const out: ProgrammeRules = {
    programme: null, ceiling: null, credit: null, rubric: [], rubricWeightTotal: 0,
    evidenceTypeCount: 0, unread: [], notes: [],
  };

  out.programme = await getProgramme(key);

  const ceilings = await listProgrammeCeilings();
  if (!ceilings.ok) out.unread.push('the weekly ceiling');
  out.ceiling = ceilings.programmes.find((p) => p.programmeKey.toLowerCase() === key.toLowerCase())
    || ceilings.programmes.find((p) => p.programmeKey === DEFAULT_PROGRAMME_KEY)
    || null;

  try {
    out.credit = await activeCreditConfig(key);
  } catch (e: any) {
    logFail('programmeRules credit', e);
    out.unread.push('the credit conversion');
  }

  try {
    out.rubric = await listRubricCriteria(key);
    out.rubricWeightTotal = round2(out.rubric.reduce((s, c) => s + (Number(c.weightPct) || 0), 0));
  } catch (e: any) {
    logFail('programmeRules rubric', e);
    out.unread.push('the grading rubric');
  }

  try {
    const roleKey = out.programme ? out.programme.roleKey : 'general';
    out.evidenceTypeCount = (await evidenceTypesForRole(roleKey)).length;
  } catch (e: any) {
    logFail('programmeRules evidence types', e);
    out.unread.push('the evidence types');
  }

  // ---- what the screen should say, in the order a person would read it -------------------------
  if (!out.programme) {
    out.notes.push('No programme is recorded under this key yet. The ceiling and credit rules below, '
      + 'where they exist, are what would apply if one were created under it.');
  }
  if (out.ceiling) {
    out.notes.push('Weekly ceiling: ' + out.ceiling.ceilingHours + ' hours of TOTAL recognised '
      + 'engagement, holistic fitness and well-being counted inside it and never added on top. It is '
      + 'a ceiling on what may be recognised, not a target to reach.');
  } else {
    out.notes.push('No weekly ceiling is recorded for this programme, so the default of '
      + DEFAULT_WEEKLY_CEILING_HOURS + ' hours applies until one is set.');
  }
  if (!out.credit) {
    out.notes.push('No credit conversion is in force for this programme. Nothing is computed into '
      + 'credits until one is saved and activated, and a final record issued now would say so rather '
      + 'than assume a number.');
  } else {
    out.notes.push('Credit conversion in force: version ' + out.credit.version + ', owned by '
      + (out.credit.ownerName || 'an unnamed owner') + '. '
      + (out.credit.partnerInstitution
        ? out.credit.partnerInstitution + ' is recorded as the awarding partner.'
        : 'No awarding partner is named on it yet — this platform does not award, so a record issued '
          + 'under it would have nobody to name.'));
  }
  if (!out.rubric.length) {
    out.notes.push('No grading rubric exists for this programme. A mentor evaluation without a rubric '
      + 'is a rating with nothing behind it, which is what this system exists to replace.');
  } else if (out.rubricWeightTotal !== 100) {
    out.notes.push('The rubric weights add up to ' + out.rubricWeightTotal + ', not 100. Results are '
      + 'weighted over the criteria that were actually scored, so this does not silently distort a '
      + 'grade — but it does mean the weights do not read as percentages.');
  }
  if (out.unread.length) {
    out.notes.push('These could not be read: ' + out.unread.join(', ') + '. What is shown is '
      + 'incomplete, and that is a failure to read it rather than a fact about this programme.');
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// THE ENROLMENT
// -------------------------------------------------------------------------------------------------

export interface EnrolmentRow {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  designation: string;
  programmeKey: string;
  programmeLabel: string;
  roleKey: string;
  roleLabel: string;
  state: EnrolmentState;
  stateLabel: string;
  startedOn: string;
  endsOn: string | null;
  /** The total hours this enrolment requires: the person's override, or the programme's figure. */
  requiredHours: number | null;
  requiredHoursBasis: string;
  note: string;
  closedOn: string | null;
  closedReason: string | null;
  enrolledByUserId: string | null;
}

const mapEnrolment = (r: any): EnrolmentRow => {
  const state = String(r.state || 'active');
  const st: EnrolmentState = isEnrolmentState(state) ? state : 'active';
  const roleKey = String(r.role_key || 'general');
  const own = num(r.required_hours);
  const programmeHours = num(r.programme_required_hours);
  return {
    id: String(r.id),
    employeeId: String(r.employee_id || ''),
    employeeName: String(r.full_name || 'Unnamed record'),
    employeeCode: String(r.employee_code || ''),
    designation: String(r.designation || ''),
    programmeKey: String(r.programme_key || ''),
    programmeLabel: String(r.programme_label || r.programme_key || ''),
    roleKey,
    roleLabel: isRoleKey(roleKey) ? String(ROLE_LABELS[roleKey]) : roleKey,
    state: st,
    stateLabel: ENROLMENT_STATE_LABELS[st],
    startedOn: r.started_on ? String(r.started_on).slice(0, 10) : '',
    endsOn: r.ends_on ? String(r.ends_on).slice(0, 10) : null,
    requiredHours: own != null ? own : programmeHours,
    requiredHoursBasis: own != null
      ? 'Recorded on this enrolment.'
      : (programmeHours != null
        ? 'From the programme, which asks for ' + programmeHours + ' hours in total.'
        : 'Nobody has recorded a required total for this programme or this person, so completion '
          + 'cannot be expressed as a fraction. That is a gap in the configuration, not a zero.'),
    note: String(r.note || ''),
    closedOn: r.closed_on ? String(r.closed_on).slice(0, 10) : null,
    closedReason: r.closed_reason ? String(r.closed_reason) : null,
    enrolledByUserId: r.enrolled_by_user_id ? String(r.enrolled_by_user_id) : null,
  };
};

const ENROLMENT_COLUMNS = sql`
  en.id, en.employee_id, en.programme_key, en.role_key, en.state, en.started_on, en.ends_on,
  en.required_hours, en.note, en.enrolled_by_user_id, en.closed_on, en.closed_reason,
  e.full_name, e.employee_code, e.designation,
  p.label AS programme_label, p.required_hours AS programme_required_hours`;

export interface EnrolmentsRead {
  ok: boolean;
  enrolments: EnrolmentRow[];
  error: string;
}

/** Every enrolment, newest first, with the person and the programme resolved. */
export async function listEnrolments(opts?: {
  state?: EnrolmentState | null;
  programmeKey?: string | null;
  limit?: number;
}): Promise<EnrolmentsRead> {
  const state = opts?.state && isEnrolmentState(opts.state) ? String(opts.state) : null;
  const key = opts?.programmeKey ? normaliseKey(opts.programmeKey) : null;
  const limit = Math.max(1, Math.min(MAX_ROWS, Number(opts?.limit) || MAX_ROWS));
  try {
    await ensureProgrammeSchema();
    const list = rows(await db.execute(sql`
      SELECT ${ENROLMENT_COLUMNS}
        FROM eims_enrolments en
        JOIN hr_employees e ON e.id = en.employee_id
        LEFT JOIN eims_programmes p ON p.programme_key = en.programme_key
       WHERE (${state}::text IS NULL OR en.state = ${state}::text)
         AND (${key}::text IS NULL OR lower(en.programme_key) = ${key}::text)
       ORDER BY (en.state = 'active') DESC, en.started_on DESC, e.full_name ASC
       LIMIT ${limit}`)).map(mapEnrolment);
    return { ok: true, enrolments: list, error: '' };
  } catch (e: any) {
    logFail('listEnrolments', e);
    return {
      ok: false,
      enrolments: [],
      error: 'The enrolment record could not be read. Everything below is missing because of that, '
        + 'not because nobody is enrolled.',
    };
  }
}

/** The one open enrolment for a person, or null where there is none. */
export async function enrolmentFor(employeeId: string): Promise<EnrolmentRow | null> {
  if (!isUuid(employeeId)) return null;
  try {
    await ensureProgrammeSchema();
    const r = rows(await db.execute(sql`
      SELECT ${ENROLMENT_COLUMNS}
        FROM eims_enrolments en
        JOIN hr_employees e ON e.id = en.employee_id
        LEFT JOIN eims_programmes p ON p.programme_key = en.programme_key
       WHERE en.employee_id = ${employeeId}::uuid AND en.state = 'active'
       LIMIT 1`))[0];
    return r ? mapEnrolment(r) : null;
  } catch (e: any) {
    logFail('enrolmentFor', e);
    return null;
  }
}

/** Every enrolment a person has ever had, newest first. A withdrawn one is still their record. */
export async function enrolmentHistory(employeeId: string): Promise<EnrolmentRow[]> {
  if (!isUuid(employeeId)) return [];
  try {
    await ensureProgrammeSchema();
    return rows(await db.execute(sql`
      SELECT ${ENROLMENT_COLUMNS}
        FROM eims_enrolments en
        JOIN hr_employees e ON e.id = en.employee_id
        LEFT JOIN eims_programmes p ON p.programme_key = en.programme_key
       WHERE en.employee_id = ${employeeId}::uuid
       ORDER BY en.started_on DESC
       LIMIT 40`)).map(mapEnrolment);
  } catch (e: any) {
    logFail('enrolmentHistory', e);
    return [];
  }
}

/**
 * THE PROGRAMME KEY THAT GOVERNS A PERSON, and where the answer came from.
 *
 * THIS IS THE FUNCTION THE REST OF THE SYSTEM SHOULD ASK. Before it existed, every module inferred
 * the key from employment type and job title — two fields this codebase documents as inconsistently
 * written — so a ceiling and a credit conversion followed a typo. An open enrolment is an explicit,
 * dated, attributable statement and it wins over an inference every time.
 *
 * WHERE THERE IS NO ENROLMENT the inference is still returned, because a person mid-internship on
 * the day this ships must not silently lose their ceiling. `source` says which of the two it was and
 * every screen showing it must say so too.
 */
export async function governingProgramme(employeeId: string): Promise<{
  programmeKey: string;
  source: 'enrolment' | 'inferred' | 'none';
  enrolment: EnrolmentRow | null;
  sentence: string;
}> {
  const enrolment = await enrolmentFor(employeeId);
  if (enrolment) {
    return {
      programmeKey: enrolment.programmeKey,
      source: 'enrolment',
      enrolment,
      sentence: 'On the ' + enrolment.programmeLabel + ' programme since ' + enrolment.startedOn
        + (enrolment.endsOn ? ', through ' + enrolment.endsOn : '')
        + '. The ceiling, the credit conversion and the rubric all come from that enrolment.',
    };
  }
  const ceiling = await resolveWeeklyCeiling(employeeId);
  if (!ceiling) {
    return {
      programmeKey: DEFAULT_PROGRAMME_KEY,
      source: 'none',
      enrolment: null,
      sentence: 'This person is not enrolled on a programme and their employee record could not be '
        + 'read either, so no programme rules can be resolved for them.',
    };
  }
  return {
    programmeKey: ceiling.programmeKey,
    source: 'inferred',
    enrolment: null,
    sentence: 'This person is NOT enrolled on a programme. The rules being applied were inferred from '
      + 'their employment type and job title, which is a guess. Enrolling them replaces the guess '
      + 'with a dated record of who decided it.',
  };
}

export interface EnrolResult {
  ok: boolean;
  id: string;
  error: string;
  /** Things that happened and are worth saying, none of which failed the write. */
  notes: string[];
}

/**
 * PUT A NAMED PERSON ON A PROGRAMME, and record who mentors them and who they report to.
 *
 * THE RELATIONSHIPS GO THROUGH THE ORGANIZATION GRAPH, not into a column here. supersedeMentor() and
 * supersedeReportingManager() close the previous edge and open the new one at the same instant, so
 * "who was the mentor on the day this hour was verified" is still answerable after the third
 * reshuffle. Both are idempotent, so a double-submitted form does not disconnect anybody.
 *
 * A RELATIONSHIP FAILURE DOES NOT FAIL THE ENROLMENT, and it is not swallowed either: the enrolment
 * is the record of the engagement, the edges are how work is routed, and losing the second is not a
 * reason to refuse the first. It comes back in `notes`, worded so the screen can show what still
 * needs doing rather than reporting a clean save that half happened.
 */
export async function enrolIntern(
  actor: Actor | null,
  input: {
    employeeId: string;
    programmeKey: string;
    roleKey?: string | null;
    startedOn: string;
    endsOn?: string | null;
    requiredHours?: number | null;
    note?: string | null;
    mentorEmployeeId?: string | null;
    managerEmployeeId?: string | null;
  },
): Promise<EnrolResult> {
  const fail = (error: string): EnrolResult => ({ ok: false, id: '', error, notes: [] });

  if (!can(actor as any, ENROL_PERMISSION)) {
    return fail('You do not hold the desk that enrols people onto internship programmes.');
  }
  const employeeId = String(input?.employeeId || '');
  if (!isUuid(employeeId)) return fail('That is not an employee record.');

  const key = normaliseKey(input?.programmeKey);
  if (!key) return fail('Choose the programme this person is joining.');

  const programme = await getProgramme(key);
  if (!programme) {
    return fail('There is no programme recorded under that key. Create the programme first, so the '
      + 'ceiling and the credit conversion this person will be measured under exist before they are '
      + 'measured against them.');
  }
  if (programme.state !== 'open') {
    return fail('The ' + programme.label + ' programme is ' + PROGRAMME_STATE_LABELS[programme.state].toLowerCase()
      + '. Open it before enrolling anybody onto it.');
  }

  const startedOn = String(input?.startedOn || '').slice(0, 10);
  if (!isDate(startedOn)) return fail('Give the start date as a real date, in YYYY-MM-DD form.');
  const endsOn = input?.endsOn && isDate(String(input.endsOn).slice(0, 10))
    ? String(input.endsOn).slice(0, 10) : null;
  if (endsOn && endsOn < startedOn) {
    return fail('The end date is before the start date. Nothing was recorded.');
  }

  const roleKeyRaw = String(input?.roleKey || programme.roleKey || 'general');
  const roleKey = isRoleKey(roleKeyRaw) ? roleKeyRaw : 'general';
  const requiredHours = num(input?.requiredHours);
  if (requiredHours != null && requiredHours < 0) {
    return fail('Required hours cannot be negative. Leave it blank to use the programme total.');
  }

  const mentorId = isUuid(input?.mentorEmployeeId) ? String(input.mentorEmployeeId) : null;
  const managerId = isUuid(input?.managerEmployeeId) ? String(input.managerEmployeeId) : null;
  if (mentorId && mentorId === employeeId) return fail('Nobody can be their own mentor.');
  if (managerId && managerId === employeeId) return fail('Nobody can be their own reporting manager.');

  const actorId = isUuid(actor?.id) ? String(actor!.id) : null;
  const notes: string[] = [];
  let enrolmentId = '';

  try {
    await ensureProgrammeSchema();

    // The person must exist and be active. Enrolling a leaver creates a record nobody can work
    // against, and reading it back later looks like a system fault rather than a keying mistake.
    const emp = rows(await db.execute(sql`
      SELECT id::text AS id, full_name, is_active FROM hr_employees
       WHERE id = ${employeeId}::uuid LIMIT 1`))[0];
    if (!emp) return fail('That employee record could not be found.');
    if (emp.is_active === false || emp.is_active === 'f') {
      return fail('That employee record is not active, so nothing can be allocated to them or '
        + 'verified for them. Nothing was recorded.');
    }

    // THE PRECONDITION IS IN THE STATEMENT, not in a read above it. Two people pressing Enrol at the
    // same moment both pass a prior check and one of them writes a second open enrolment; the
    // partial unique index refuses that, and the NOT EXISTS turns the refusal into an answer rather
    // than an exception.
    const w = rows(await db.execute(sql`
      INSERT INTO eims_enrolments
        (employee_id, programme_key, role_key, state, started_on, ends_on, required_hours, note,
         enrolled_by_user_id)
      SELECT ${employeeId}::uuid, ${programme.programmeKey}, ${roleKey}, 'active',
             ${startedOn}::date, ${endsOn}::date, ${requiredHours},
             ${String(input?.note || '').slice(0, 2000)}, ${actorId}::uuid
       WHERE NOT EXISTS (
         SELECT 1 FROM eims_enrolments x
          WHERE x.employee_id = ${employeeId}::uuid AND x.state = 'active')
      RETURNING id`));

    if (!w.length) {
      return fail('That person already has an open enrolment. Close it as completed or withdrawn — '
        + 'with a reason — before starting another, so their record never has two ceilings and two '
        + 'credit conversions in force for the same week.');
    }
    enrolmentId = String(w[0].id);

    await logAudit({
      userId: actorId,
      action: 'eims.enrolment.open',
      entity: 'eims_enrolments',
      entityId: enrolmentId,
      diff: {
        employeeId, programmeKey: programme.programmeKey, roleKey, startedOn, endsOn,
        requiredHours, mentorRecorded: !!mentorId, managerRecorded: !!managerId,
      },
    });
  } catch (e: any) {
    // NEVER SWALLOWED IN A WRITE PATH.
    logFail('enrolIntern', e);
    return fail(WRITE_FAILED);
  }

  // ---- THE RELATIONSHIPS, AFTER the enrolment exists -------------------------------------------
  if (mentorId) {
    const r = await supersedeMentor(employeeId, mentorId, {
      createdByUserId: actorId,
      note: 'Recorded when enrolling onto the ' + programme.label + ' programme.',
    });
    if (!r.ok) {
      notes.push('The enrolment was recorded, but the mentor was NOT: ' + (r.error || 'the '
        + 'organization graph refused the change') + '. Until a mentor edge exists, nobody is named '
        + 'to verify this person\'s hours and their evidence will sit in no queue.');
    }
  } else {
    notes.push('No mentor was recorded. Verification is a per-row relationship, so until one is '
      + 'recorded this person\'s evidence reaches nobody\'s queue.');
  }

  if (managerId) {
    const r = await supersedeReportingManager(employeeId, managerId, {
      createdByUserId: actorId,
      note: 'Recorded when enrolling onto the ' + programme.label + ' programme.',
    });
    if (!r.ok) {
      notes.push('The enrolment was recorded, but the reporting manager was NOT: ' + (r.error
        || 'the organization graph refused the change') + '. Weekly schedules and credit weeks route '
        + 'to the reporting manager, so until one exists those requests halt with nobody named.');
    }
  } else {
    notes.push('No reporting manager was recorded. Proposed weekly schedules and credit weeks route '
      + 'to that person, so until one exists those requests halt carrying a sentence that says which '
      + 'link is missing.');
  }

  return { ok: true, id: enrolmentId, error: '', notes };
}

/**
 * CLOSE AN ENROLMENT: completed, or withdrawn.
 *
 * A WRITTEN REASON IS REQUIRED ON BOTH ANSWERS, exactly as decidePendingCreditWeek() requires one on
 * both. "Completed" without a reason reads as a formality; withdrawn without one reads as a
 * judgement. The reason is the record, and six months later it is the only thing that can say why.
 *
 * NOTHING IS DELETED and no hours change. Closing an enrolment ends the engagement; every activity,
 * every piece of evidence and every verified hour stays exactly where it is, because those are the
 * record of what the person actually did.
 */
export async function closeEnrolment(
  actor: Actor | null,
  input: { enrolmentId: string; state: 'completed' | 'withdrawn'; reason: string; closedOn?: string | null },
): Promise<{ ok: boolean; error: string }> {
  if (!can(actor as any, ENROL_PERMISSION)) {
    return { ok: false, error: 'You do not hold the desk that closes an enrolment.' };
  }
  const id = String(input?.enrolmentId || '');
  if (!isUuid(id)) return { ok: false, error: 'That enrolment does not exist.' };

  const state = String(input?.state || '');
  if (state !== 'completed' && state !== 'withdrawn') {
    return { ok: false, error: 'An enrolment closes as completed or as withdrawn. Nothing else.' };
  }
  const reason = String(input?.reason || '').trim();
  if (reason.length < MIN_CLOSE_REASON) {
    return {
      ok: false,
      error: 'Write why, in at least ' + MIN_CLOSE_REASON + ' characters. It is kept on the record and '
        + 'it is the only thing that can answer this question later.',
    };
  }
  const closedOn = input?.closedOn && isDate(String(input.closedOn).slice(0, 10))
    ? String(input.closedOn).slice(0, 10) : isoDate(new Date());
  const actorId = isUuid(actor?.id) ? String(actor!.id) : null;

  try {
    await ensureProgrammeSchema();
    // THE PRECONDITION REPEATS IN THE STATEMENT — `AND state = 'active'` — so two clicks cannot close
    // one enrolment twice with two different reasons.
    const w = rows(await db.execute(sql`
      UPDATE eims_enrolments
         SET state = ${state}, closed_on = ${closedOn}::date, closed_reason = ${reason.slice(0, 2000)},
             closed_by_user_id = ${actorId}::uuid, updated_at = NOW()
       WHERE id = ${id}::uuid AND state = 'active'
      RETURNING id, employee_id::text AS employee_id, programme_key`));
    if (!w.length) {
      return { ok: false, error: 'That enrolment is not open, so there was nothing to close. Nothing was changed.' };
    }
    await logAudit({
      userId: actorId,
      action: 'eims.enrolment.close',
      entity: 'eims_enrolments',
      entityId: id,
      diff: { state, closedOn, reason: reason.slice(0, 500), employeeId: String(w[0].employee_id) },
    });
    return { ok: true, error: '' };
  } catch (e: any) {
    logFail('closeEnrolment', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

/**
 * RECORD THE MENTOR AND THE REPORTING MANAGER for somebody already enrolled.
 *
 * Both edges are written through the Organization Graph and both are idempotent. Passing null for
 * either CLOSES that edge without opening a replacement, which is how "the mentor stepped away" is
 * recorded — and the sentence returned says so, because an intern with no mentor is a real state
 * somebody needs to see rather than an empty field.
 *
 * PASSING undefined LEAVES AN EDGE ALONE. That distinction matters: a form that posts only the
 * mentor must not silently disconnect the manager.
 */
export async function assignPeople(
  actor: Actor | null,
  input: {
    employeeId: string;
    mentorEmployeeId?: string | null;
    managerEmployeeId?: string | null;
    note?: string | null;
  },
): Promise<{ ok: boolean; error: string; notes: string[] }> {
  if (!can(actor as any, ENROL_PERMISSION)) {
    return { ok: false, error: 'You do not hold the desk that records a mentor or a reporting manager.', notes: [] };
  }
  const employeeId = String(input?.employeeId || '');
  if (!isUuid(employeeId)) return { ok: false, error: 'That is not an employee record.', notes: [] };

  const actorId = isUuid(actor?.id) ? String(actor!.id) : null;
  const note = String(input?.note || 'Recorded from the internship console.').slice(0, 500);
  const notes: string[] = [];
  let failed = '';

  if (input?.mentorEmployeeId !== undefined) {
    const mentorId = isUuid(input.mentorEmployeeId) ? String(input.mentorEmployeeId) : null;
    if (mentorId && mentorId === employeeId) {
      return { ok: false, error: 'Nobody can be their own mentor. Nothing was changed.', notes: [] };
    }
    const r = await supersedeMentor(employeeId, mentorId, { createdByUserId: actorId, note });
    if (!r.ok) failed = r.error || 'The mentor could not be recorded.';
    else {
      notes.push(mentorId
        ? 'Mentor recorded. Their evidence reaches that person\'s queue from now on; anything already '
          + 'verified stays verified by whoever verified it.'
        : 'The mentor edge was closed and no replacement was opened. Until a new mentor is recorded, '
          + 'this person\'s evidence reaches nobody\'s queue.');
      await logAudit({
        userId: actorId, action: 'eims.enrolment.mentor.set', entity: 'org_relationships',
        entityId: employeeId, diff: { mentorEmployeeId: mentorId },
      });
    }
  }

  if (!failed && input?.managerEmployeeId !== undefined) {
    const managerId = isUuid(input.managerEmployeeId) ? String(input.managerEmployeeId) : null;
    if (managerId && managerId === employeeId) {
      return { ok: false, error: 'Nobody can be their own reporting manager. Nothing else was changed.', notes };
    }
    const r = await supersedeReportingManager(employeeId, managerId, { createdByUserId: actorId, note });
    if (!r.ok) failed = r.error || 'The reporting manager could not be recorded.';
    else {
      notes.push(managerId
        ? 'Reporting manager recorded. Proposed weekly schedules and credit weeks route to them from '
          + 'now on.'
        : 'The reporting line was closed and no replacement was opened. Until a new manager is '
          + 'recorded, schedules and credit weeks halt with nobody named.');
      await logAudit({
        userId: actorId, action: 'eims.enrolment.manager.set', entity: 'org_relationships',
        entityId: employeeId, diff: { managerEmployeeId: managerId },
      });
    }
  }

  if (failed) return { ok: false, error: failed, notes };
  if (!notes.length) return { ok: false, error: 'Nothing was chosen, so nothing was changed.', notes };
  return { ok: true, error: '', notes };
}

// -------------------------------------------------------------------------------------------------
// THE HR VIEW
// -------------------------------------------------------------------------------------------------

/** The buckets a week's allocation falls into, for the workload distribution. */
export interface WorkloadBucket {
  key: 'under-half' | 'half-to-ceiling' | 'at-ceiling' | 'over-ceiling' | 'nothing-allocated';
  label: string;
  count: number;
  /** The interns in this bucket, named, so the figure can be acted on rather than admired. */
  people: { employeeId: string; name: string; hours: number }[];
}

export interface MentorLoad {
  mentorEmployeeId: string;
  mentorName: string;
  menteeCount: number;
  mentees: { employeeId: string; name: string }[];
}

export interface CohortOverview {
  ok: boolean;
  /** Every source that could NOT be read, named. No figure below is a measurement while this is non-empty. */
  unread: string[];

  weekStart: string;
  weekEnd: string;

  totalEnrolments: number;
  active: number;
  completed: number;
  withdrawn: number;

  /**
   * completed / (completed + withdrawn). NULL, never zero, while nothing has finished — a cohort in
   * its first month has no completion rate, and printing 0% for that is a false statement about
   * people who have not reached the end yet. `completionBasis` says the denominator out loud.
   */
  completionRatePct: number | null;
  completionBasis: string;

  /** Mean VERIFIED hours per active intern, over their whole enrolment. Null when nothing is verified. */
  averageVerifiedHours: number | null;
  verifiedHoursBasis: string;
  /** How many active interns have at least one verified hour. The mean above is over ALL of them. */
  withVerifiedHours: number;

  buckets: WorkloadBucket[];
  workloadBasis: string;

  mentorLoads: MentorLoad[];
  withoutMentor: { employeeId: string; name: string }[];
  withoutManager: { employeeId: string; name: string }[];
  relationshipsRead: boolean;

  certificatesIssued: number;
  certificatesDraft: number;
  certificatesWithdrawn: number;
  certificateBasis: string;

  notes: string[];
}

const BUCKET_LABELS: Record<WorkloadBucket['key'], string> = {
  'nothing-allocated': 'Nothing allocated this week',
  'under-half': 'Under half the ceiling',
  'half-to-ceiling': 'Half the ceiling, up to it',
  'at-ceiling': 'At the ceiling',
  'over-ceiling': 'Allocated ABOVE the ceiling',
};

/**
 * THE COHORT, IN THE FIGURES THE SPEC ASKS FOR: how many interns, how many active, the completion
 * rate, average verified hours, the workload distribution, mentor workload, certificate issuance.
 *
 * EVERY FIGURE STATES WHAT IT COUNTS AND OVER WHAT PERIOD, and none of them is derived from
 * attendance. Where a source cannot be read its name goes on `unread` and the figure it feeds is
 * null rather than zero — a zero that means "could not read" is the defect this whole phase exists
 * to remove, and it is at its most dangerous on a console somebody makes decisions from.
 *
 * FOUR GROUPED QUERIES AND TWO BATCHED GRAPH READS, not one query per head. A console that issues a
 * query per intern is the slowest page in the product by the second cohort.
 */
export async function cohortOverview(todayIso?: string | null): Promise<CohortOverview> {
  const today = isDate(String(todayIso || '').slice(0, 10)) ? String(todayIso).slice(0, 10) : isoDate(new Date());
  const weekStart = weekStartOf(today);
  const weekEnd = weekEndOf(weekStart);

  const out: CohortOverview = {
    ok: true, unread: [],
    weekStart, weekEnd,
    totalEnrolments: 0, active: 0, completed: 0, withdrawn: 0,
    completionRatePct: null,
    completionBasis: '',
    averageVerifiedHours: null,
    verifiedHoursBasis: '',
    withVerifiedHours: 0,
    buckets: [], workloadBasis: '',
    mentorLoads: [], withoutMentor: [], withoutManager: [], relationshipsRead: false,
    certificatesIssued: 0, certificatesDraft: 0, certificatesWithdrawn: 0, certificateBasis: '',
    notes: [],
  };

  // ---- 1. THE ENROLMENTS ------------------------------------------------------------------------
  const activePeople: { employeeId: string; name: string; startedOn: string }[] = [];
  try {
    await ensureProgrammeSchema();
    for (const r of rows(await db.execute(sql`
      SELECT state, COUNT(*)::int AS n FROM eims_enrolments GROUP BY state`))) {
      const n = Number(r.n) || 0;
      out.totalEnrolments += n;
      if (String(r.state) === 'active') out.active = n;
      else if (String(r.state) === 'completed') out.completed = n;
      else if (String(r.state) === 'withdrawn') out.withdrawn = n;
    }
    for (const r of rows(await db.execute(sql`
      SELECT en.employee_id::text AS employee_id, e.full_name, en.started_on
        FROM eims_enrolments en
        JOIN hr_employees e ON e.id = en.employee_id
       WHERE en.state = 'active'
       ORDER BY e.full_name ASC
       LIMIT ${MAX_ROWS}`))) {
      activePeople.push({
        employeeId: String(r.employee_id),
        name: String(r.full_name || 'Unnamed record'),
        startedOn: r.started_on ? String(r.started_on).slice(0, 10) : '',
      });
    }
  } catch (e: any) {
    logFail('cohortOverview enrolments', e);
    out.ok = false;
    out.unread.push('the enrolment record');
  }

  const ended = out.completed + out.withdrawn;
  out.completionRatePct = ended > 0 ? round2((out.completed / ended) * 100) : null;
  out.completionBasis = ended > 0
    ? out.completed + ' of ' + ended + ' enrolments that have ENDED were closed as completed. '
      + 'Enrolments still running are not in the denominator, because a person who has not finished '
      + 'has neither completed nor failed to.'
    : 'No enrolment has ended yet, so there is no completion rate to state. That is not a rate of '
      + 'zero: nobody has reached the end of a programme.';

  const ids = activePeople.map((p) => p.employeeId);
  const nameById = new Map(activePeople.map((p) => [p.employeeId, p.name]));
  const startById = new Map(activePeople.map((p) => [p.employeeId, p.startedOn]));

  // ---- 2. VERIFIED HOURS, ONE GROUPED QUERY -----------------------------------------------------
  //
  // Verified hours ONLY. Not attendance, not reported effort, not allocation: the figure a completion
  // record rests on is what a named mentor stated actually happened.
  if (ids.length) {
    try {
      const verified = new Map<string, number>();
      for (const r of rows(await db.execute(sql`
        SELECT t.employee_id::text AS employee_id, COALESCE(SUM(t.verified_hours), 0) AS hours
          FROM employee_tasks t
         WHERE t.employee_id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
           AND t.verified_at IS NOT NULL
           AND t.status NOT IN ('cancelled', 'archived')
         GROUP BY t.employee_id`))) {
        verified.set(String(r.employee_id), round2(Number(r.hours) || 0));
      }
      let sum = 0;
      for (const id of ids) {
        const h = verified.get(id) || 0;
        sum += h;
        if (h > 0) out.withVerifiedHours += 1;
      }
      out.averageVerifiedHours = ids.length ? round2(sum / ids.length) : null;
      out.verifiedHoursBasis = 'Mean VERIFIED hours per active intern, counted over each person\'s '
        + 'whole enrolment to date and divided across all ' + ids.length + ' of them, including the '
        + (ids.length - out.withVerifiedHours) + ' with nothing verified yet. Verified means a named '
        + 'mentor looked at the evidence and said the hours happened. It is not attendance, not '
        + 'reported effort and not what was allocated.';
    } catch (e: any) {
      // The columns are asserted by eims-activity's own guard. On a database where that has not run,
      // this SELECT throws — and the honest answer is null with the reason named, never zero.
      logFail('cohortOverview verified hours', e);
      out.unread.push('verified activity hours');
      out.averageVerifiedHours = null;
      out.verifiedHoursBasis = 'Verified hours could not be read, so there is no average to show. '
        + 'That is a failure to read them, not a cohort with nothing verified.';
    }
  } else {
    out.verifiedHoursBasis = 'No active enrolments, so there is nobody to average over.';
  }

  // ---- 3. WORKLOAD DISTRIBUTION FOR THE CURRENT WEEK --------------------------------------------
  //
  // ALLOCATED hours against each person's own ceiling, for the seven days of this week. It answers
  // "is anybody being over-committed", which is the question the ceiling exists for, and it has to
  // be allocation rather than verification because an over-commitment must be visible BEFORE the
  // week is worked rather than after.
  const bucketOf = new Map<WorkloadBucket['key'], { employeeId: string; name: string; hours: number }[]>();
  for (const k of ['over-ceiling', 'at-ceiling', 'half-to-ceiling', 'under-half', 'nothing-allocated'] as WorkloadBucket['key'][]) {
    bucketOf.set(k, []);
  }
  if (ids.length) {
    try {
      const allocated = new Map<string, number>();
      for (const r of rows(await db.execute(sql`
        SELECT t.employee_id::text AS employee_id, COALESCE(SUM(t.allocated_hours), 0) AS hours
          FROM employee_tasks t
         WHERE t.employee_id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
           AND t.due_on BETWEEN ${weekStart}::date AND ${weekEnd}::date
           AND t.status NOT IN ('cancelled', 'archived')
         GROUP BY t.employee_id`))) {
        allocated.set(String(r.employee_id), round2(Number(r.hours) || 0));
      }

      // The ceiling is resolved per person, because a twenty-hour intern's "at the ceiling" is
      // twenty. Bounded by the cohort size and it is the only per-head read on this page.
      for (const p of activePeople.slice(0, 200)) {
        const hours = allocated.get(p.employeeId) || 0;
        const ceiling = await resolveWeeklyCeiling(p.employeeId);
        const cap = ceiling ? ceiling.hours : DEFAULT_WEEKLY_CEILING_HOURS;
        let key: WorkloadBucket['key'] = 'nothing-allocated';
        if (hours <= 0) key = 'nothing-allocated';
        else if (hours > cap) key = 'over-ceiling';
        else if (hours === cap) key = 'at-ceiling';
        else if (hours >= cap / 2) key = 'half-to-ceiling';
        else key = 'under-half';
        bucketOf.get(key)!.push({ employeeId: p.employeeId, name: p.name, hours });
      }
      out.workloadBasis = 'Hours ALLOCATED into ' + weekStart + ' to ' + weekEnd + ', against each '
        + 'person\'s own weekly ceiling. Allocation rather than verification, because a week that has '
        + 'been over-committed needs to be seen before it is worked, not after.';
    } catch (e: any) {
      logFail('cohortOverview workload', e);
      out.unread.push('this week\'s allocations');
      out.workloadBasis = 'This week\'s allocations could not be read, so there is no distribution to '
        + 'show. Nobody is shown as unallocated on the strength of a failed read.';
    }
  } else {
    out.workloadBasis = 'No active enrolments, so there is no week to distribute.';
  }
  out.buckets = (['over-ceiling', 'at-ceiling', 'half-to-ceiling', 'under-half', 'nothing-allocated'] as WorkloadBucket['key'][])
    .map((key) => ({ key, label: BUCKET_LABELS[key], count: bucketOf.get(key)!.length, people: bucketOf.get(key)! }));

  // ---- 4. MENTOR WORKLOAD, from the Organization Graph -------------------------------------------
  if (ids.length) {
    try {
      const mentors = await getMentorsFor(ids);
      const managers = await getManagersFor(ids);
      out.relationshipsRead = true;

      // OrgPerson.employeeId IS NULLABLE, and grouping by it unguarded is not merely a type
      // complaint: every mentor edge that resolves to no employee record would share the single map
      // key `null`, so several different mentors would be added together into ONE row carrying
      // whichever name arrived first. A workload panel that under-reports the number of mentors and
      // over-reports one person's load is worse than no panel, because somebody rebalances from it.
      // Such an edge is counted separately and named on screen instead.
      const byMentor = new Map<string, MentorLoad>();
      let mentorEdgeUnresolved = 0;
      for (const id of ids) {
        const name = nameById.get(id) || 'Unnamed record';
        const m = mentors.get(id);
        const mentorEmployeeId = m && m.employeeId ? String(m.employeeId) : '';
        if (mentorEmployeeId) {
          const existing: MentorLoad = byMentor.get(mentorEmployeeId) || {
            mentorEmployeeId,
            mentorName: (m && m.fullName) || 'Unnamed record',
            menteeCount: 0,
            mentees: [],
          };
          existing.menteeCount += 1;
          existing.mentees.push({ employeeId: id, name });
          byMentor.set(mentorEmployeeId, existing);
        } else if (m) {
          // A mentor edge EXISTS. It just does not resolve to an employee record, so this person
          // cannot be counted into anybody's load. They are not "without a mentor" and saying so
          // would send somebody to assign one who is already assigned.
          mentorEdgeUnresolved += 1;
        } else {
          out.withoutMentor.push({ employeeId: id, name });
        }
        if (!managers.get(id)) out.withoutManager.push({ employeeId: id, name });
      }
      if (mentorEdgeUnresolved > 0) {
        out.notes.push(mentorEdgeUnresolved + ' intern(s) have a recorded mentor whose edge does not '
          + 'resolve to an employee record, so they are in nobody\'s load below. They are not without '
          + 'a mentor, and the mentor workload figures are short by that many.');
      }
      out.mentorLoads = Array.from(byMentor.values()).sort((a, b) => b.menteeCount - a.menteeCount);
    } catch (e: any) {
      logFail('cohortOverview relationships', e);
      out.unread.push('the mentor and reporting relationships');
      out.relationshipsRead = false;
    }
  }

  // ---- 5. CERTIFICATE ISSUANCE -------------------------------------------------------------------
  try {
    for (const r of rows(await db.execute(sql`
      SELECT state, COUNT(*)::int AS n FROM eims_final_records GROUP BY state`))) {
      const n = Number(r.n) || 0;
      const s = String(r.state || '');
      if (s === 'issued') out.certificatesIssued = n;
      else if (s === 'withdrawn') out.certificatesWithdrawn = n;
      else out.certificatesDraft += n;
    }
    out.certificateBasis = 'Final internship records in the credential ledger, counted by state, over '
      + 'the whole history of the platform rather than this week. A record is a frozen document with '
      + 'a public verification page; ' + PLATFORM_ROLE_SENTENCE;
  } catch (e: any) {
    logFail('cohortOverview certificates', e);
    out.unread.push('the final internship records');
    out.certificateBasis = 'The final records could not be read, so these counts are missing rather '
      + 'than zero.';
  }

  // ---- WHAT THE SCREEN SHOULD SAY ---------------------------------------------------------------
  if (out.unread.length) {
    out.ok = false;
    out.notes.push('These could not be read: ' + out.unread.join(', ') + '. Every figure they feed is '
      + 'shown as unavailable rather than as zero, because a zero here reads as a fact about people.');
  }
  if (out.relationshipsRead && out.withoutMentor.length) {
    out.notes.push(out.withoutMentor.length + ' active intern(s) have no mentor recorded. Verification '
      + 'is a per-row relationship, so their evidence currently reaches nobody\'s queue.');
  }
  if (out.relationshipsRead && out.withoutManager.length) {
    out.notes.push(out.withoutManager.length + ' active intern(s) have no reporting manager recorded. '
      + 'Proposed schedules and credit weeks route to that person, so those requests halt naming the '
      + 'missing link.');
  }
  const over = out.buckets.find((b) => b.key === 'over-ceiling');
  if (over && over.count > 0) {
    out.notes.push(over.count + ' intern(s) are carrying MORE allocated hours this week than their '
      + 'ceiling allows. The ceiling is a limit on what may be recognised, so the hours above it '
      + 'would be worked and not counted. Reduce or move the allocations.');
  }
  out.notes.push(NOT_ATTENDANCE_SENTENCE);
  return out;
}

/** The role choices an enrolment form offers, resolved to plain strings for the markup. */
export function roleOptions(): { value: string; label: string }[] {
  return ROLE_KEYS.map((r) => ({ value: String(r), label: String(ROLE_LABELS[r]) }));
}

/** The programme states a form offers, resolved to plain strings for the markup. */
export function programmeStateOptions(): { value: string; label: string }[] {
  return PROGRAMME_STATES.map((s) => ({ value: String(s), label: PROGRAMME_STATE_LABELS[s] }));
}

export type { OrgPerson, WeeklyCeiling };
