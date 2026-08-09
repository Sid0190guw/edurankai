// src/lib/eims-workload.ts — THE WEEK, AND THE CEILING ON IT.
//
// =================================================================================================
// THE LOAD-BEARING RULE
// =================================================================================================
//
// FORTY HOURS A WEEK IS A CEILING ON EVERYTHING RECOGNISED, AND HOLISTIC FITNESS AND WELL-BEING ARE
// INSIDE IT. Never forty plus two. The published internship policy already states the same
// arithmetic — six days of five hours' project work plus one hour forty minutes of well-being is two
// thousand four hundred minutes, forty hours exactly — and src/lib/engagement-policy.ts is
// structurally incapable of printing the total without the split. This file is where that stops
// being a description and becomes a refusal.
//
// BEFORE ANY ALLOCATION IS WRITTEN the week is projected. If the new activity would take the week
// past the ceiling the allocation is REFUSED, in a sentence that names what is already allocated,
// what was being added, what the total would have been, what the maximum is, and what to do about
// it. It is never silently allowed, and it is never silently truncated to fit — quietly writing four
// hours where somebody asked for six is a lie the person only discovers on a completion letter.
//
// =================================================================================================
// THE CEILING IS NOT THE FLOOR, AND THIS FILE IS WHERE THEY STOPPED BEING THE SAME NUMBER
// =================================================================================================
//
// src/lib/credit-week.ts tests forty as a FLOOR to reach: measured hours below required hours is a
// blocker on the automatic credit. That test is about whether a week was completed. This file tests
// forty as a CEILING on what may be planned and recognised. Both are true and they are different
// questions, so they are asked by different functions and the answers are labelled differently
// everywhere they are shown.
//
// THE WEEK IS THE ISO WEEK, Monday to Sunday, imported from credit-week.ts rather than restated. A
// second week boundary would give one person two different weekly totals with no way to tell which
// was right, which is exactly the class of defect this phase exists to remove.
//
// =================================================================================================
// WHY ALLOCATION LIVES HERE AND NOT IN eims-activity.ts
// =================================================================================================
//
// An allocation that has not been projected against the ceiling is the overload this system exists
// to prevent. So there is exactly ONE function anywhere that writes allocated_hours, it is in this
// file, and the projection happens inside it rather than beside it. eims-activity.ts deliberately
// exports no allocation writer at all: a second door, however well-behaved its callers were on the
// day it was added, is how the ceiling stops being a ceiling.
//
// =================================================================================================
// PER PROGRAMME, CONFIGURABLE, DEFAULTING TO FORTY
// =================================================================================================
//
// `eims_workload_policy` holds one ceiling per programme key and is seeded with a 'default' row at
// forty. It is a WORKLOAD POLICY table, deliberately not a programme registry: this codebase has no
// programme entity yet, and inventing a half one here would be the second thing a real one would
// have to reconcile with. Until there is one, the programme key is the engagement level the
// published policy already resolves (Intern, Apprentice), and an explicit key can be passed in by
// whatever builds the real programme model.
//
// THE TIGHTEST APPLICABLE LIMIT WINS. A person with recorded weekly hours of twenty is capped at
// twenty, not at the programme's forty — their contract is the narrower fact. Nothing may exceed the
// statutory weekly ceiling in engagement-policy.ts under any configuration.
//
// EduRankAI is the technology platform. Hours recognised here are a record of work done on this
// platform; accredited partners award credentials, and nothing in this file confers one.

// Resolved LAZILY. A top-level db import makes src/lib/db throw DATABASE_URL is not set the moment
// any importer loads, which puts every pure function in this module — and in anything that imports
// it — out of reach of a test that needs no database at all.
let _db: any = null;
async function database(): Promise<any> {
  if (!_db) _db = (await import('@/lib/db')).db;
  return _db;
}
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';
import { logAudit } from '@/lib/audit';
import { weekStartOf, weekEndOf, weekLabel } from '@/lib/credit-week';
import {
  STATUTORY, resolveEngagementPolicy, isInternshipPolicy, hoursPerWeek,
} from '@/lib/engagement-policy';
import {
  ensureActivitySchema, readActivitiesForWeek, readActivitiesInRange, activityTypeFor,
  listActivityTypes, mayAllocateTo,
  getActivity, hoursWord, isEvidenceRequirement, UNCLASSIFIED_TYPE_KEY,
  type ActivityRow, type ActivityType, type EvidenceRequirement,
} from '@/lib/eims-activity';

// -------------------------------------------------------------------------------------------------
// MODULE CONSTANTS — every one declared ABOVE the function that reads it. `const` is not hoisted.
// -------------------------------------------------------------------------------------------------

/** postgres-js resolves to a PLAIN ARRAY, never { rows }. */
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** The real Postgres reason is on e.cause; e.message is only the SQL that failed. */
const logFail = (tag: string, e: any) =>
  console.error('[eims-workload] ' + tag, e?.cause?.message || e?.message);

const WRITE_FAILED = 'Something went wrong saving that. Nothing was changed. Try again in a moment.';
const NOT_AVAILABLE = 'That activity is not available.';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * FORTY. The default and the number every sentence quotes when nothing narrower is recorded.
 *
 * It is a ceiling on TOTAL recognised engagement — project work, learning, meetings, assessment,
 * documentation, professional development and holistic fitness together. There is no category that
 * sits outside it and no configuration that can put one there.
 */
export const DEFAULT_WEEKLY_CEILING_HOURS = 40;

/** The key the default row is stored under. Every unknown programme resolves to it. */
export const DEFAULT_PROGRAMME_KEY = 'default';

/** A ceiling below this is not a ceiling, it is a typo. Refused rather than stored. */
const MIN_CEILING_HOURS = 1;

const normaliseKey = (v: unknown): string =>
  String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);

// -------------------------------------------------------------------------------------------------
// SCHEMA. Its own ensureOnce key: a key that has already run in a process never runs again, so
// statements appended to another module's key would never appear on an environment that has booted.
// -------------------------------------------------------------------------------------------------

export function ensureWorkloadSchema(): Promise<void> {
  return ensureOnce('eims_workload_v1', async () => {
    try {
      await createWorkloadTables();
    } catch (e: any) {
      // Re-thrown after logging: ensureOnce drops a failed run from its cache so the next call
      // retries, and swallows the rejection for callers.
      logFail('ensureWorkloadSchema', e);
      throw e;
    }
  });
}

async function createWorkloadTables(): Promise<void> {
  await (await database()).execute(sql`CREATE TABLE IF NOT EXISTS eims_workload_policy (
    programme_key TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    ceiling_hours NUMERIC(5,2) NOT NULL DEFAULT 40,
    note TEXT,
    updated_by_user_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  for (const stmt of [
    'ALTER TABLE eims_workload_policy ADD COLUMN IF NOT EXISTS note TEXT',
    'ALTER TABLE eims_workload_policy ADD COLUMN IF NOT EXISTS updated_by_user_id UUID',
    'ALTER TABLE eims_workload_policy ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
  ]) {
    await (await database()).execute(sql.raw(stmt));
  }

  // Seeded, never overwritten: an administrator's change to a ceiling must survive a deploy.
  try {
    const seeds: { key: string; label: string; note: string }[] = [
      {
        key: DEFAULT_PROGRAMME_KEY,
        label: 'Default',
        note: 'The ceiling used when no programme sets its own. Forty hours of total recognised '
          + 'engagement a week, holistic fitness and well-being included.',
      },
      {
        key: 'Intern',
        label: 'Internship',
        note: 'The published internship policy: six days a week, five hours a day of project work '
          + 'plus one hour forty minutes a day of well-being. Forty hours in total, not forty plus.',
      },
      {
        key: 'Apprentice',
        label: 'Apprenticeship',
        note: 'The same weekly shape as the internship, over a longer programme.',
      },
    ];
    for (const s of seeds) {
      await (await database()).execute(sql`
        INSERT INTO eims_workload_policy (programme_key, label, ceiling_hours, note)
        VALUES (${s.key}, ${s.label}, ${DEFAULT_WEEKLY_CEILING_HOURS}, ${s.note})
        ON CONFLICT (programme_key) DO NOTHING`);
    }
  } catch (e: any) {
    logFail('seed workload policy', e);
  }
}

// -------------------------------------------------------------------------------------------------
// THE CEILING
// -------------------------------------------------------------------------------------------------

export interface ProgrammeCeiling {
  programmeKey: string;
  label: string;
  ceilingHours: number;
  note: string;
}

/** The configured ceilings, for an admin screen. Falls back to the default when unreadable. */
export async function listProgrammeCeilings(): Promise<{ ok: boolean; programmes: ProgrammeCeiling[] }> {
  const fallback: ProgrammeCeiling[] = [{
    programmeKey: DEFAULT_PROGRAMME_KEY,
    label: 'Default',
    ceilingHours: DEFAULT_WEEKLY_CEILING_HOURS,
    note: 'Shown from the built-in default because the workload policy table could not be read.',
  }];
  try {
    await ensureWorkloadSchema();
    const list = rows(await (await database()).execute(sql`
      SELECT programme_key, label, ceiling_hours, note
        FROM eims_workload_policy
       ORDER BY (programme_key = ${DEFAULT_PROGRAMME_KEY}) DESC, label ASC
       LIMIT 200`)).map((r) => ({
      programmeKey: String(r.programme_key),
      label: String(r.label || r.programme_key),
      ceilingHours: round2(Number(r.ceiling_hours ?? DEFAULT_WEEKLY_CEILING_HOURS)),
      note: String(r.note || ''),
    }));
    return { ok: true, programmes: list.length ? list : fallback };
  } catch (e: any) {
    logFail('listProgrammeCeilings', e);
    return { ok: false, programmes: fallback };
  }
}

/**
 * Set a programme's ceiling. CONFIGURABLE means an administrator, not a deploy.
 *
 * IT WILL NOT WRITE A CEILING ABOVE THE STATUTORY WEEKLY MAXIMUM. engagement-policy.ts states nine
 * hours a day and forty-eight a week for a commercial establishment, and a configuration screen must
 * not be the place that quietly exceeds a statute.
 */
export async function setProgrammeCeiling(input: {
  programmeKey: string;
  label?: string | null;
  ceilingHours: number;
  note?: string | null;
  actorUserId?: string | null;
}): Promise<{ ok: boolean; error: string }> {
  const key = normaliseKey(input.programmeKey);
  if (!key) return { ok: false, error: 'Name the programme this ceiling applies to.' };

  const hours = Number(input.ceilingHours);
  if (!Number.isFinite(hours) || hours < MIN_CEILING_HOURS) {
    return { ok: false, error: 'Give the weekly ceiling as a number of hours, for example 40.' };
  }
  if (hours > STATUTORY.maxHoursPerWeek) {
    return {
      ok: false,
      error: 'The weekly ceiling cannot be set above ' + STATUTORY.maxHoursPerWeek + ' hours, which '
        + 'is the maximum the applicable Shops and Establishments Act allows for a working week. '
        + 'Nothing was changed.',
    };
  }

  const label = String(input.label || key).trim().slice(0, 120);
  const note = String(input.note || '').trim().slice(0, 1000);
  // A malformed id reaching a ::uuid cast throws. It is recorded when it is one and null when it is
  // not, rather than taking the write down over a provenance field.
  const actorId = isUuid(input.actorUserId) ? String(input.actorUserId) : null;

  try {
    await ensureWorkloadSchema();
    await (await database()).execute(sql`
      INSERT INTO eims_workload_policy (programme_key, label, ceiling_hours, note, updated_by_user_id)
      VALUES (${key}, ${label}, ${round2(hours)}, ${note}, ${actorId}::uuid)
      ON CONFLICT (programme_key) DO UPDATE SET
        label = EXCLUDED.label,
        ceiling_hours = EXCLUDED.ceiling_hours,
        note = EXCLUDED.note,
        updated_by_user_id = EXCLUDED.updated_by_user_id,
        updated_at = NOW()`);

    await logAudit({
      userId: actorId,
      action: 'eims.workload.ceiling.set',
      entity: 'eims_workload_policy',
      entityId: key,
      diff: { ceilingHours: round2(hours), label },
    });
    return { ok: true, error: '' };
  } catch (e: any) {
    logFail('setProgrammeCeiling', e);
    return { ok: false, error: WRITE_FAILED };
  }
}

export interface WeeklyCeiling {
  employeeId: string;
  fullName: string;
  /** The maximum total hours that may be allocated or recognised in one week. */
  hours: number;
  /** Where the figure came from, verbatim, for the record and for the screen. */
  basis: string;
  source: 'recorded-contract' | 'programme-policy' | 'default';
  programmeKey: string;
  programmeCeilingHours: number;
  recordedWeeklyHours: number | null;
  /** True only for an engagement whose hours are the certified deliverable. */
  countedEngagement: boolean;
  engagementLabel: string;
}

interface EmployeeRow {
  id: string;
  fullName: string;
  employmentType: string;
  designation: string;
  weeklyHours: number | null;
  isActive: boolean;
}

/**
 * The person, read tolerantly.
 *
 * `weekly_hours` is asserted at runtime by another module and may not exist on a database where no
 * engagement terms have ever been saved. A missing column must degrade to "no recorded contract",
 * which is a real answer, and never to a failed read, which is not.
 */
async function readEmployee(employeeId: string): Promise<EmployeeRow | null> {
  if (!isUuid(employeeId)) return null;
  const map = (r: any): EmployeeRow => ({
    id: String(r.id),
    fullName: String(r.full_name || 'this intern'),
    employmentType: String(r.employment_type || ''),
    designation: String(r.designation || ''),
    weeklyHours: r.weekly_hours == null ? null : Number(r.weekly_hours),
    isActive: !(r.is_active === false || r.is_active === 'f'),
  });
  try {
    const r = rows(await (await database()).execute(sql`
      SELECT e.id::text AS id, e.full_name, e.employment_type, e.designation, e.weekly_hours, e.is_active
        FROM hr_employees e WHERE e.id = ${employeeId}::uuid LIMIT 1`))[0];
    return r ? map(r) : null;
  } catch (e: any) {
    logFail('readEmployee weekly_hours', e);
    try {
      const r = rows(await (await database()).execute(sql`
        SELECT e.id::text AS id, e.full_name, e.employment_type, e.designation,
               NULL AS weekly_hours, e.is_active
          FROM hr_employees e WHERE e.id = ${employeeId}::uuid LIMIT 1`))[0];
      return r ? map(r) : null;
    } catch (e2: any) {
      logFail('readEmployee', e2);
      return null;
    }
  }
}

async function programmeCeilingFor(programmeKey: string): Promise<{ hours: number; label: string; found: boolean }> {
  const key = normaliseKey(programmeKey);
  try {
    await ensureWorkloadSchema();
    const r = rows(await (await database()).execute(sql`
      SELECT programme_key, label, ceiling_hours FROM eims_workload_policy
       WHERE lower(programme_key) IN (${key}, ${DEFAULT_PROGRAMME_KEY})
       ORDER BY (lower(programme_key) = ${key}) DESC
       LIMIT 1`))[0];
    if (r) {
      const h = Number(r.ceiling_hours);
      if (Number.isFinite(h) && h >= MIN_CEILING_HOURS) {
        return {
          hours: round2(h),
          label: String(r.label || r.programme_key),
          found: String(r.programme_key || '').toLowerCase() === key,
        };
      }
    }
  } catch (e: any) {
    logFail('programmeCeilingFor', e);
  }
  return { hours: DEFAULT_WEEKLY_CEILING_HOURS, label: 'Default', found: false };
}

/**
 * THE CEILING FOR ONE PERSON'S WEEK.
 *
 * The tightest applicable limit wins, and the basis sentence says which one bound it:
 *
 *   1. THE RECORDED CONTRACT, when it is narrower. A twenty-hour-a-week intern is capped at twenty.
 *      A contract recorded ABOVE the programme's ceiling does not raise it — a keying error on one
 *      employee record must never be able to lift the rule for that person.
 *   2. OTHERWISE THE PROGRAMME'S CEILING, from eims_workload_policy.
 *   3. OTHERWISE FORTY.
 *
 * And nothing may exceed the statutory weekly maximum under any of the three.
 */
export async function resolveWeeklyCeiling(
  employeeId: string,
  opts?: { programmeKey?: string | null },
): Promise<WeeklyCeiling | null> {
  const emp = await readEmployee(employeeId);
  if (!emp) return null;

  const policy = resolveEngagementPolicy({
    employmentType: emp.employmentType || null,
    roleTitle: emp.designation || null,
  });
  const programmeKey = normaliseKey(opts?.programmeKey) || normaliseKey(policy.level) || DEFAULT_PROGRAMME_KEY;
  const programme = await programmeCeilingFor(programmeKey);

  const recorded = Number(emp.weeklyHours);
  const hasRecorded = Number.isFinite(recorded) && recorded > 0;

  let hours = programme.hours;
  let source: WeeklyCeiling['source'] = programme.found ? 'programme-policy' : 'default';
  let basis = programme.found
    ? 'The ' + programme.label + ' programme sets a weekly ceiling of ' + hoursWord(programme.hours) + '.'
    : 'No programme ceiling is recorded, so the default of ' + hoursWord(programme.hours) + ' applies.';

  if (hasRecorded && round2(recorded) < programme.hours) {
    hours = round2(recorded);
    source = 'recorded-contract';
    basis = 'Recorded weekly hours on the employee record: ' + hoursWord(recorded) + ' a week, which '
      + 'is narrower than the ' + hoursWord(programme.hours) + ' the programme allows.';
  } else if (hasRecorded && round2(recorded) > programme.hours) {
    basis = 'The employee record says ' + hoursWord(recorded) + ' a week, which is above the '
      + hoursWord(programme.hours) + ' ceiling this programme allows. The ceiling is the lower of the '
      + 'two.';
  }

  if (hours > STATUTORY.maxHoursPerWeek) {
    hours = STATUTORY.maxHoursPerWeek;
    basis += ' Reduced to the statutory weekly maximum of ' + hoursWord(STATUTORY.maxHoursPerWeek) + '.';
  }

  const counted = isInternshipPolicy(policy);
  const policyWeek = hoursPerWeek(policy);
  if (!counted) {
    basis += ' This engagement is on the ' + policy.label + ' model, where hours are not the certified '
      + 'deliverable; the ceiling still applies to anything allocated here.';
  } else if (policyWeek != null) {
    basis += ' The published ' + policy.label + ' policy is ' + hoursWord(policyWeek) + ' of total '
      + 'engagement a week, holistic fitness and well-being included.';
  }

  return {
    employeeId: emp.id,
    fullName: emp.fullName,
    hours: round2(hours),
    basis,
    source,
    programmeKey,
    programmeCeilingHours: programme.hours,
    recordedWeeklyHours: hasRecorded ? round2(recorded) : null,
    countedEngagement: counted,
    engagementLabel: policy.label,
  };
}

// -------------------------------------------------------------------------------------------------
// THE PROJECTION AND THE REFUSAL
// -------------------------------------------------------------------------------------------------

export interface CeilingProjection {
  ok: boolean;
  currentAllocatedHours: number;
  addedHours: number;
  projectedHours: number;
  ceilingHours: number;
  remainingCapacityHours: number;
  /** The sentence. Populated on a refusal, and on an acceptance that leaves the week full. */
  sentence: string;
}

/**
 * PURE. The same rule the form previews and the write enforces.
 *
 * A client-side regex beside a server-side one is how a form starts accepting what the server
 * refuses; a client-side ceiling beside a server-side one is how somebody is told their week fits
 * and then told it does not.
 *
 * THE REFUSAL NAMES FIVE THINGS, because a refusal that names fewer is a wall: what is already
 * allocated, what was being added, what the total would have been, what the maximum is, and what to
 * do next. It never proposes a truncated figure as though it had been accepted.
 */
export function ceilingProjection(input: {
  currentAllocatedHours: number;
  addedHours: number;
  ceilingHours: number;
  activityTitle: string;
  weekLabel: string;
  personName?: string | null;
}): CeilingProjection {
  const current = round2(Math.max(0, Number(input.currentAllocatedHours) || 0));
  const added = round2(Math.max(0, Number(input.addedHours) || 0));
  const ceiling = round2(Math.max(0, Number(input.ceilingHours) || 0));
  const projected = round2(current + added);
  const remaining = round2(Math.max(0, ceiling - current));
  const who = String(input.personName || '').trim() || 'This intern';
  const title = String(input.activityTitle || 'this activity').trim().slice(0, 200);
  const label = String(input.weekLabel || '').trim();

  const base: CeilingProjection = {
    ok: true,
    currentAllocatedHours: current,
    addedHours: added,
    projectedHours: projected,
    ceilingHours: ceiling,
    remainingCapacityHours: round2(Math.max(0, ceiling - projected)),
    sentence: '',
  };

  if (projected <= ceiling) {
    if (round2(ceiling - projected) === 0) {
      return {
        ...base,
        sentence: 'That fills the week exactly: ' + hoursWord(projected) + ' allocated against a '
          + 'maximum of ' + hoursWord(ceiling) + '. Nothing further can be allocated for '
          + (label || 'this week') + '.',
      };
    }
    return base;
  }

  const whatToDo = remaining > 0
    ? 'Reduce this activity to ' + hoursWord(remaining) + ' or less, move it to a week with room, or '
      + 'reduce an existing allocation first.'
    : 'There is no capacity left in this week. Move this activity to a week with room, or reduce an '
      + 'existing allocation first.';

  return {
    ...base,
    ok: false,
    remainingCapacityHours: remaining,
    sentence: 'Not allocated. ' + who + ' already has ' + hoursWord(current) + ' allocated for the '
      + 'week of ' + (label || 'this week') + '. Adding "' + title + '" at ' + hoursWord(added)
      + ' would bring the week to ' + hoursWord(projected) + ', and the maximum that may be allocated '
      + 'or recognised in any one week is ' + hoursWord(ceiling) + ', holistic fitness and well-being '
      + 'included. ' + whatToDo + ' Nothing was changed.',
  };
}

/** Allocated hours already standing in a week. Cancelled and archived work is owed by nobody. */
function allocatedFrom(activities: ActivityRow[], excludeActivityId?: string | null): number {
  let total = 0;
  for (const a of activities) {
    if (a.closed) continue;
    if (excludeActivityId && a.id === excludeActivityId) continue;
    if (a.allocatedHours != null) total += a.allocatedHours;
  }
  return round2(total);
}

export interface AllocationProjection extends CeilingProjection {
  /** False when the week or the person could not be read. A projection is never guessed. */
  measured: boolean;
  weekStart: string;
  weekEnd: string;
  ceiling: WeeklyCeiling | null;
  /** Names what could NOT be read. A projection built on a gap says so. */
  unread: string[];
}

/**
 * What would this week look like if this activity were allocated?
 *
 * Exported so a screen can show the projection BEFORE somebody submits, using the same reads and the
 * same sentence the write will use.
 */
export async function projectAllocation(input: {
  employeeId: string;
  deadline: string;
  hours: number;
  title: string;
  /** Set when re-allocating an existing activity, so its own current hours are not double-counted. */
  excludeActivityId?: string | null;
  programmeKey?: string | null;
}): Promise<AllocationProjection> {
  const weekStart = DATE_RE.test(String(input.deadline || '').slice(0, 10))
    ? weekStartOf(String(input.deadline).slice(0, 10)) : '';
  const weekEnd = weekStart ? weekEndOf(weekStart) : '';

  const empty: AllocationProjection = {
    ok: false, measured: false,
    currentAllocatedHours: 0, addedHours: round2(Math.max(0, Number(input.hours) || 0)),
    projectedHours: 0, ceilingHours: DEFAULT_WEEKLY_CEILING_HOURS, remainingCapacityHours: 0,
    sentence: '', weekStart, weekEnd, ceiling: null, unread: [],
  };

  if (!weekStart) {
    return { ...empty, sentence: 'Give the deadline as YYYY-MM-DD. The week an activity belongs to is '
      + 'the week its deadline falls in, so without one it belongs to no week.' };
  }

  const ceiling = await resolveWeeklyCeiling(input.employeeId, { programmeKey: input.programmeKey });
  if (!ceiling) {
    return { ...empty, sentence: 'That employee record could not be read, so this week cannot be '
      + 'projected. Nothing was changed.' };
  }

  const read = await readActivitiesForWeek(input.employeeId, weekStart);
  if (!read.ok) {
    return {
      ...empty, ceiling, ceilingHours: ceiling.hours, unread: read.unread,
      sentence: read.error || 'This week\'s activities could not be read, so the ceiling cannot be '
        + 'checked. Nothing was changed.',
    };
  }
  if (read.unread.length) {
    // Hours that could not be read are not zero hours. Refuse rather than project on a gap.
    return {
      ...empty, ceiling, ceilingHours: ceiling.hours, unread: read.unread,
      sentence: 'The hours already allocated for this week could not be read (' + read.unread.join(', ')
        + '), so allocating more could take the week over the ceiling without anybody seeing it. '
        + 'Nothing was changed.',
    };
  }

  const current = allocatedFrom(read.activities, input.excludeActivityId);
  const projection = ceilingProjection({
    currentAllocatedHours: current,
    addedHours: Number(input.hours) || 0,
    ceilingHours: ceiling.hours,
    activityTitle: input.title,
    weekLabel: weekLabel(weekStart),
    personName: ceiling.fullName,
  });

  return { ...projection, measured: true, weekStart, weekEnd, ceiling, unread: [] };
}

// -------------------------------------------------------------------------------------------------
// STATE ONE: ALLOCATION. The only writer of allocated_hours anywhere in this codebase.
// -------------------------------------------------------------------------------------------------

export interface AllocationResult {
  ok: boolean;
  error: string;
  activityId: string | null;
  activity: ActivityRow | null;
  /** Always present on a refusal caused by the ceiling, so a screen can show the arithmetic. */
  projection: AllocationProjection | null;
  notes: string[];
}

const allocFail = (error: string, projection: AllocationProjection | null = null): AllocationResult =>
  ({ ok: false, error, activityId: null, activity: null, projection, notes: [] });

/**
 * ALLOCATE AN ACTIVITY, OR RE-ALLOCATE ONE.
 *
 * THE ORDER IS THE DESIGN:
 *   1. Validate the shape of everything, and refuse in words.
 *   2. Resolve the type from the CONFIGURED taxonomy. An activity may not carry a type nobody
 *      configured, because a type is what an evidence requirement and a well-being split are read
 *      from.
 *   3. Check authority per row, from the Organization Graph. Never from users.role, never from a job
 *      title, and never from the intern themself.
 *   4. PROJECT THE WEEK. If it would exceed the ceiling, refuse with the sentence and write nothing.
 *   5. Only then write.
 *
 * RE-ALLOCATION IS REFUSED ONCE THE ACTIVITY IS VERIFIED. A mentor's finding was made against a
 * stated allocation, and moving the allocation underneath it would silently change what that finding
 * recognised. The way back is reopenVerification() in eims-activity.ts, which is a named act with a
 * written reason.
 */
export async function allocateActivity(input: {
  employeeId: string;
  allocatorUserId: string;
  title: string;
  activityType: string;
  allocatedHours: number;
  /** YYYY-MM-DD. It is the deadline AND what puts the activity in a week. */
  deadline: string;
  description?: string | null;
  /** The mentor who will verify these hours. Defaults to the mentor the org graph names. */
  mentorUserId?: string | null;
  evidenceRequirement?: EvidenceRequirement | null;
  learningOutcomes?: string | null;
  learningAssignmentId?: string | null;
  /** Re-allocate an existing activity instead of creating one. */
  activityId?: string | null;
  programmeKey?: string | null;
  ipAddress?: string | null;
}): Promise<AllocationResult> {
  const employeeId = String(input.employeeId || '').trim();
  const allocator = String(input.allocatorUserId || '').trim();
  if (!isUuid(employeeId) || !isUuid(allocator)) return allocFail(NOT_AVAILABLE);

  const title = String(input.title || '').trim().slice(0, 300);
  if (title.length < 3) return allocFail('Give the activity a title.');

  const hours = Number(input.allocatedHours);
  if (!Number.isFinite(hours) || hours <= 0) {
    return allocFail('Give the hours this activity is worth, for example 4 or 4.5. Every activity '
      + 'carries allocated hours: it is what "completed" and "verified" are later measured against.');
  }

  const deadline = String(input.deadline || '').trim().slice(0, 10);
  if (!DATE_RE.test(deadline)) {
    return allocFail('Give the deadline as YYYY-MM-DD. The week an activity belongs to is the week '
      + 'its deadline falls in.');
  }

  const existingId = String(input.activityId || '').trim();
  if (existingId && !isUuid(existingId)) return allocFail(NOT_AVAILABLE);

  // ---- the type, from the configured taxonomy ---------------------------------------------------
  const type: ActivityType = await activityTypeFor(input.activityType);
  if (type.key === UNCLASSIFIED_TYPE_KEY) {
    const known = await listActivityTypes();
    return allocFail('Choose what kind of activity this is. The configured categories are: '
      + known.types.map((t) => t.label).join(', ') + '.');
  }
  if (!type.active) {
    return allocFail('The category "' + type.label + '" has been retired, so nothing new can be '
      + 'allocated against it. Choose a current category.');
  }

  const evidence: EvidenceRequirement = isEvidenceRequirement(input.evidenceRequirement)
    ? input.evidenceRequirement : type.defaultEvidence;

  // ---- authority, per row, from the Organization Graph ------------------------------------------
  const authority = await mayAllocateTo(allocator, employeeId);
  if (!authority.ok) return allocFail(authority.reason || NOT_AVAILABLE);

  // ---- the activity being re-allocated ----------------------------------------------------------
  let existing: ActivityRow | null = null;
  if (existingId) {
    existing = await getActivity(existingId);
    if (!existing || existing.employeeId !== employeeId) return allocFail(NOT_AVAILABLE);
    if (existing.closed) {
      return allocFail('This activity is ' + existing.statusLabel.toLowerCase() + ', so its hours '
        + 'cannot be re-allocated. Nothing was changed.');
    }
    if (existing.verified) {
      return allocFail('These hours have already been verified by a mentor, so the allocation can no '
        + 'longer be changed. Ask the mentor to reopen the verification first. Nothing was changed.');
    }
  }

  // ---- THE CEILING. Projected before anything is written ----------------------------------------
  const projection = await projectAllocation({
    employeeId,
    deadline,
    hours,
    title,
    excludeActivityId: existingId || null,
    programmeKey: input.programmeKey || null,
  });
  if (!projection.measured) return allocFail(projection.sentence || WRITE_FAILED, projection);
  if (!projection.ok) return allocFail(projection.sentence, projection);

  const mentorUserId = isUuid(input.mentorUserId) ? String(input.mentorUserId) : null;
  const description = String(input.description || '').trim().slice(0, 4000) || null;
  const outcomes = String(input.learningOutcomes || '').trim().slice(0, 4000) || null;
  const learningAssignmentId = isUuid(input.learningAssignmentId)
    ? String(input.learningAssignmentId) : null;
  const notes: string[] = [];
  if (projection.sentence) notes.push(projection.sentence);

  try {
    await ensureActivitySchema();

    if (existingId) {
      const r = rows(await (await database()).execute(sql`
        UPDATE employee_tasks
           SET title = ${title},
               description = ${description},
               activity_type = ${type.key},
               allocated_hours = ${round2(hours)},
               allocated_by_user_id = ${allocator}::uuid,
               allocated_at = NOW(),
               due_on = ${deadline}::date,
               mentor_user_id = ${mentorUserId}::uuid,
               evidence_requirement = ${evidence},
               learning_outcomes = ${outcomes},
               learning_assignment_id = ${learningAssignmentId}::uuid,
               updated_at = NOW()
         WHERE id = ${existingId}::uuid
           AND employee_id = ${employeeId}::uuid
           AND verified_at IS NULL
           AND status NOT IN ('cancelled', 'archived')
        RETURNING id`))[0];

      if (!r?.id) {
        return allocFail('That could not be recorded: the activity was verified or closed while this '
          + 'page was open. Nothing was changed.');
      }

      await logAudit({
        userId: allocator,
        action: 'eims.activity.reallocate',
        entity: 'employee_task',
        entityId: existingId,
        diff: {
          employeeId, title, type: type.key, allocatedHours: round2(hours), deadline,
          previousHours: existing?.allocatedHours ?? null, via: authority.via,
          weekTotalAfter: projection.projectedHours, ceiling: projection.ceilingHours,
        },
        ipAddress: input.ipAddress || undefined,
      });

      return {
        ok: true, error: '', activityId: existingId, activity: await getActivity(existingId),
        projection, notes,
      };
    }

    // The INSERT ... SELECT evaluates the target's own row in the same statement, so there is no
    // read-then-write gap in which an employee could be deactivated. Authority was resolved from the
    // Organization Graph above; this clause is existence and activity, not authorisation.
    const r = rows(await (await database()).execute(sql`
      INSERT INTO employee_tasks (
        employee_id, assigned_by_user_id, title, description, priority, status, due_on,
        activity_type, allocated_hours, allocated_by_user_id, allocated_at,
        mentor_user_id, evidence_requirement, learning_outcomes, learning_assignment_id)
      SELECT e.id, ${allocator}::uuid, ${title}, ${description}, 'normal', 'assigned', ${deadline}::date,
             ${type.key}, ${round2(hours)}, ${allocator}::uuid, NOW(),
             ${mentorUserId}::uuid, ${evidence}, ${outcomes}, ${learningAssignmentId}::uuid
        FROM hr_employees e
       WHERE e.id = ${employeeId}::uuid
         AND e.is_active = true
      RETURNING id`))[0];

    if (!r?.id) {
      return allocFail('That person\'s employee record is not active, so work cannot be allocated to '
        + 'them. Nothing was changed.');
    }

    const newId = String(r.id);
    await logAudit({
      userId: allocator,
      action: 'eims.activity.allocate',
      entity: 'employee_task',
      entityId: newId,
      diff: {
        employeeId, title, type: type.key, allocatedHours: round2(hours), deadline,
        evidence, mentorUserId, via: authority.via,
        weekTotalAfter: projection.projectedHours, ceiling: projection.ceilingHours,
      },
      ipAddress: input.ipAddress || undefined,
    });

    if (!mentorUserId) {
      notes.push('No mentor was named on this activity, so whoever the Organization Graph records as '
        + 'this person\'s mentor, reporting manager, department head or reviewer may verify it.');
    }

    return { ok: true, error: '', activityId: newId, activity: await getActivity(newId), projection, notes };
  } catch (e: any) {
    // NEVER SWALLOWED. The caller is told nothing was written, and the log carries the real Postgres
    // reason rather than the SQL that failed.
    logFail('allocateActivity', e);
    return allocFail(WRITE_FAILED, projection);
  }
}

// -------------------------------------------------------------------------------------------------
// THE ONE FUNCTION EVERY SURFACE READS
// -------------------------------------------------------------------------------------------------

export interface WorkloadTypeLine {
  key: string;
  label: string;
  wellbeing: boolean;
  activities: number;
  allocatedHours: number;
  completedHours: number;
  verifiedHours: number;
  outstandingHours: number;
}

export interface InternWeek {
  ok: boolean;
  /** Empty when ok. A sentence for a person, never a database message. */
  error: string;

  employeeId: string;
  fullName: string;
  weekStart: string;
  weekEnd: string;
  label: string;

  ceilingHours: number;
  ceilingBasis: string;
  ceiling: WeeklyCeiling | null;

  /** STATE ONE: the plan. Never summed into the recognised figure. */
  allocatedHours: number;
  /** STATE TWO: what the intern reported. Recorded honestly, above the allocation and above the ceiling. */
  completedHours: number;
  /** STATE THREE: what a mentor verified. */
  verifiedHours: number;

  /**
   * THE AUTHORITATIVE FIGURE FOR THE WEEK: verified activity hours, capped at the ceiling.
   * This is the number a credit week and a completion letter must read. Nothing else is.
   */
  recognisedHours: number;
  /** Verified hours above the ceiling. Recorded, shown, and NOT recognised. */
  aboveCeilingHours: number;
  /** True when the cap actually bit, so a screen can say so rather than showing a quietly lower number. */
  ceilingApplied: boolean;
  /** Reported effort above what the allocations allow. Recorded, not recognised without an uplift. */
  aboveAllocationHours: number;
  /** Hours recognised above an allocation because somebody wrote a reason for it. */
  upliftHours: number;

  /** Allocated work not yet verified. What is still owed inside this week. */
  outstandingHours: number;
  /** How much more may be allocated into this week before the ceiling is reached. */
  remainingCapacityHours: number;

  /** The well-being split, INSIDE the totals above and never added to them. */
  wellbeingAllocatedHours: number;
  wellbeingVerifiedHours: number;

  byType: WorkloadTypeLine[];
  activities: ActivityRow[];

  /** Activities carrying no allocated hours, and activities carrying no type. Named, never hidden. */
  unallocatedCount: number;
  unclassifiedCount: number;

  /** What could NOT be read. A total built on a gap says so instead of reading as a fact. */
  unread: string[];
  /** Sentences worth putting on the screen, in the order a person would read them. */
  notes: string[];
}

const emptyWeek = (employeeId: string, weekStart: string, error: string): InternWeek => ({
  ok: false, error,
  employeeId, fullName: '', weekStart, weekEnd: weekStart ? weekEndOf(weekStart) : '',
  label: weekStart ? weekLabel(weekStart) : '',
  ceilingHours: DEFAULT_WEEKLY_CEILING_HOURS, ceilingBasis: '', ceiling: null,
  allocatedHours: 0, completedHours: 0, verifiedHours: 0,
  recognisedHours: 0, aboveCeilingHours: 0, ceilingApplied: false,
  aboveAllocationHours: 0, upliftHours: 0,
  outstandingHours: 0, remainingCapacityHours: 0,
  wellbeingAllocatedHours: 0, wellbeingVerifiedHours: 0,
  byType: [], activities: [],
  unallocatedCount: 0, unclassifiedCount: 0,
  unread: [], notes: [],
});

/**
 * ONE INTERN, ONE WEEK. Allocated, completed, verified, outstanding, remaining capacity, and the
 * per-type breakdown. EVERY SURFACE READS THIS.
 *
 * WHY ONE FUNCTION AND NOT SIX. Five different numbers for one person's seven days already exist in
 * this codebase — attendance-measured, credit-hours, intern-hours, timesheet minutes, time-log hours
 * — and they disagree in direction, not just in magnitude, on a document somebody shows a
 * university. A second rollup written for a second screen is how a sixth arrives. If a screen needs
 * a figure this does not return, the figure is added HERE.
 *
 * WHAT EACH NUMBER MEANS IS FIXED HERE AND NOWHERE ELSE:
 *   allocated   the plan. Bounded by the ceiling at the moment it was written.
 *   completed   what the intern reported. Kept as reported, including above the allocation.
 *   verified    what a mentor stated actually happened.
 *   recognised  verified, capped at the ceiling. THE AUTHORITATIVE FIGURE.
 *   outstanding allocated work not yet verified.
 *   remaining   ceiling minus allocated: how much more may be planned into this week.
 *
 * ATTENDANCE IS NOT IN THIS FUNCTION AT ALL. hr_attendance answers whether somebody was logged in.
 * It is presence and context, it may be displayed beside these figures, and it must never again be
 * summed into one of them.
 *
 * WHO MUST READ THIS RATHER THAN MEASURE AGAIN. `recognisedHours` is what hr_credit_weeks
 * .hours_measured has to be re-sourced from — the credit week stays the single weekly authority and
 * stops meaning "net clock time". src/lib/eims-credit.ts and the completion letter read this
 * function; src/lib/credit-hours.ts and src/lib/intern-hours.ts, which each derive their own weekly
 * total from attendance, are the ones being replaced and are listed as follow-ups rather than left
 * to disagree with this quietly.
 */
export async function internWeek(
  employeeId: string,
  weekStartIso: string,
  opts?: { programmeKey?: string | null },
): Promise<InternWeek> {
  const weekStart = weekStartOf(String(weekStartIso || '').slice(0, 10));
  if (!isUuid(employeeId)) return emptyWeek(employeeId, weekStart, NOT_AVAILABLE);
  if (!weekStart) {
    return emptyWeek(employeeId, '', 'Give the week as a date inside it, in YYYY-MM-DD form.');
  }

  const ceiling = await resolveWeeklyCeiling(employeeId, { programmeKey: opts?.programmeKey });
  if (!ceiling) {
    return emptyWeek(employeeId, weekStart, 'That employee record could not be read. That is a '
      + 'failure to read it, not an empty week.');
  }

  const read = await readActivitiesForWeek(employeeId, weekStart);
  const typeRead = await listActivityTypes(true);
  const typeByKey = new Map<string, ActivityType>(typeRead.types.map((t) => [t.key, t]));

  const week = emptyWeek(employeeId, weekStart, '');
  week.ok = read.ok;
  week.error = read.error;
  week.fullName = ceiling.fullName;
  week.weekEnd = weekEndOf(weekStart);
  week.label = weekLabel(weekStart);
  week.ceiling = ceiling;
  week.ceilingHours = ceiling.hours;
  week.ceilingBasis = ceiling.basis;
  week.activities = read.activities;
  week.unread = read.unread.slice();

  const lines = new Map<string, WorkloadTypeLine>();

  for (const a of read.activities) {
    if (a.closed) continue;

    const key = a.activityTypeKey;
    const type = typeByKey.get(key);
    const line = lines.get(key) || {
      key,
      label: a.activityTypeLabel,
      wellbeing: type ? type.wellbeing : a.wellbeing,
      activities: 0, allocatedHours: 0, completedHours: 0, verifiedHours: 0, outstandingHours: 0,
    };

    line.activities += 1;
    line.allocatedHours = round2(line.allocatedHours + (a.allocatedHours ?? 0));
    line.completedHours = round2(line.completedHours + (a.reportedHours ?? 0));
    line.verifiedHours = round2(line.verifiedHours + (a.verifiedHours ?? 0));
    line.outstandingHours = round2(line.outstandingHours + a.outstandingHours);
    lines.set(key, line);

    week.allocatedHours = round2(week.allocatedHours + (a.allocatedHours ?? 0));
    week.completedHours = round2(week.completedHours + (a.reportedHours ?? 0));
    week.verifiedHours = round2(week.verifiedHours + (a.verifiedHours ?? 0));
    week.outstandingHours = round2(week.outstandingHours + a.outstandingHours);
    week.aboveAllocationHours = round2(week.aboveAllocationHours + a.aboveAllocationHours);
    week.upliftHours = round2(week.upliftHours + a.upliftHours);

    if (a.wellbeing || line.wellbeing) {
      week.wellbeingAllocatedHours = round2(week.wellbeingAllocatedHours + (a.allocatedHours ?? 0));
      week.wellbeingVerifiedHours = round2(week.wellbeingVerifiedHours + (a.verifiedHours ?? 0));
    }
    if (a.allocatedHours == null) week.unallocatedCount += 1;
    if (key === UNCLASSIFIED_TYPE_KEY) week.unclassifiedCount += 1;
  }

  week.byType = Array.from(lines.values()).sort((a, b) => {
    const ta = typeByKey.get(a.key)?.sortOrder ?? 999;
    const tb = typeByKey.get(b.key)?.sortOrder ?? 999;
    return ta === tb ? a.label.localeCompare(b.label) : ta - tb;
  });

  // ---- THE CEILING, APPLIED TO RECOGNITION ------------------------------------------------------
  // The cap bites HERE and only here. The verified figure above is the honest total; the recognised
  // figure is what may be credited. Both are returned, because a screen that showed only the second
  // would be quietly discarding hours somebody worked, and a screen that showed only the first would
  // be promising hours nobody may credit.
  week.recognisedHours = round2(Math.min(week.verifiedHours, ceiling.hours));
  week.aboveCeilingHours = round2(Math.max(0, week.verifiedHours - ceiling.hours));
  week.ceilingApplied = week.aboveCeilingHours > 0;
  week.remainingCapacityHours = round2(Math.max(0, ceiling.hours - week.allocatedHours));

  // ---- what the screen should say ---------------------------------------------------------------
  const notes: string[] = [];
  notes.push('Maximum recognised in this week: ' + hoursWord(ceiling.hours)
    + ', holistic fitness and well-being included. ' + ceiling.basis);
  if (week.ceilingApplied) {
    notes.push('Verified ' + hoursWord(week.verifiedHours) + ' against a ceiling of '
      + hoursWord(ceiling.hours) + '. ' + hoursWord(week.aboveCeilingHours) + ' is recorded and is '
      + 'not recognised. The hours are not deleted and the record still shows them.');
  }
  if (week.aboveAllocationHours > 0) {
    notes.push(hoursWord(week.aboveAllocationHours) + ' of reported effort is above what was '
      + 'allocated. It is recorded. Recognising it needs a mentor or manager uplift with a written '
      + 'reason.');
  }
  if (week.allocatedHours > ceiling.hours) {
    notes.push('This week carries ' + hoursWord(week.allocatedHours) + ' of allocations against a '
      + 'ceiling of ' + hoursWord(ceiling.hours) + '. Nothing new can be allocated into it, and the '
      + 'existing allocations should be reduced or moved.');
  }
  if (week.unallocatedCount > 0) {
    notes.push(week.unallocatedCount + ' activity(s) carry no allocated hours. They are listed and '
      + 'they contribute nothing to this week until somebody records what they are worth.');
  }
  if (week.unclassifiedCount > 0) {
    notes.push(week.unclassifiedCount + ' activity(s) carry no category. Classifying them is what '
      + 'gives them an evidence requirement and puts them in the breakdown.');
  }
  if (week.unread.length) {
    notes.push('These could not be read: ' + week.unread.join(', ')
      + '. The figures above are incomplete, and that is a failure to read them rather than a fact '
      + 'about this week.');
  }
  if (!read.ok && !week.error) {
    week.error = 'This week could not be read in full.';
  }
  if (typeRead.fallback) {
    notes.push('The activity categories are being shown from the built-in list because the '
      + 'configured taxonomy could not be read.');
  }
  week.notes = notes;

  return week;
}

// -------------------------------------------------------------------------------------------------
// THE WHOLE INTERNSHIP SO FAR
// -------------------------------------------------------------------------------------------------
//
// WHY THIS IS HERE AND NOT ON THE PAGE THAT NEEDED IT. The intern's own screen needs five lifetime
// figures - required, allocated, completed, verified, outstanding - and internWeek() answers seven
// days. Summing seven-day rollups on a page would have produced the SIXTH weekly total this phase
// exists to remove, and it would have produced it in the one place a student reads their own record.
// The rule stated above internWeek() is therefore followed literally: a figure a surface needs is
// added HERE.
//
// THE CEILING IS APPLIED PER WEEK, NEVER TO THE TOTAL. Recognised hours are the sum over weeks of
// min(that week's verified, that week's ceiling). Capping a lifetime total at forty would be
// nonsense, and capping nothing at all would let a run of over-ceiling weeks accumulate into a
// completion figure no week was ever allowed to earn. So the cap bites once per week, exactly as it
// does on the weekly screen - and `aboveCeilingHours` carries what that cost, because those hours
// were still worked and the record still shows them.
//
// ATTENDANCE IS NOT IN THIS FUNCTION EITHER. Not one query below reads hr_attendance.

/** One activity category, rolled up over the whole span. The weekly line plus its recognised share. */
export interface ProgressTypeLine extends WorkloadTypeLine {
  /** This category's share of the recognised total. A SHARE, not a measurement - see below. */
  recognisedHours: number;
}

export interface ProgressWeekLine {
  weekStart: string;
  weekEnd: string;
  label: string;
  allocatedHours: number;
  completedHours: number;
  verifiedHours: number;
  recognisedHours: number;
  aboveCeilingHours: number;
  ceilingHours: number;
}

export interface InternProgress {
  ok: boolean;
  error: string;

  employeeId: string;
  fullName: string;

  /** The span these figures cover, and the sentence saying why it is that span. */
  fromIso: string;
  toIso: string;
  spanBasis: string;

  ceilingHours: number;
  ceilingBasis: string;

  /** The programme's total, or the person's override. NULL where nobody has recorded one. */
  requiredHours: number | null;
  requiredBasis: string;

  allocatedHours: number;
  completedHours: number;
  verifiedHours: number;
  /** Verified, capped week by week. The figure a completion record rests on. */
  recognisedHours: number;
  aboveCeilingHours: number;
  aboveAllocationHours: number;
  upliftHours: number;
  /** Allocated work not yet verified, across the whole span. */
  outstandingHours: number;

  /** recognised / required, as a percentage. NULL when no required total is recorded. */
  completionPct: number | null;
  completionBasis: string;

  wellbeingAllocatedHours: number;
  wellbeingVerifiedHours: number;

  byType: ProgressTypeLine[];
  byWeek: ProgressWeekLine[];
  /** The full ledger, newest first. The intern is entitled to read every row of this. */
  activities: ActivityRow[];

  activitiesTotal: number;
  activitiesOpen: number;
  activitiesInProgress: number;
  activitiesComplete: number;
  activitiesOverdue: number;

  unallocatedCount: number;
  unclassifiedCount: number;

  /** True when the ledger hit its row cap, so a screen can say the table is not the whole span. */
  truncated: boolean;

  unread: string[];
  notes: string[];
}

/** The ledger cap. A student with an eighteen-month record still has to render on a phone. */
const MAX_LEDGER_ROWS = 600;

const emptyProgress = (employeeId: string, error: string): InternProgress => ({
  ok: false, error,
  employeeId, fullName: '',
  fromIso: '', toIso: '', spanBasis: '',
  ceilingHours: DEFAULT_WEEKLY_CEILING_HOURS, ceilingBasis: '',
  requiredHours: null, requiredBasis: '',
  allocatedHours: 0, completedHours: 0, verifiedHours: 0,
  recognisedHours: 0, aboveCeilingHours: 0, aboveAllocationHours: 0, upliftHours: 0,
  outstandingHours: 0,
  completionPct: null, completionBasis: '',
  wellbeingAllocatedHours: 0, wellbeingVerifiedHours: 0,
  byType: [], byWeek: [], activities: [],
  activitiesTotal: 0, activitiesOpen: 0, activitiesInProgress: 0, activitiesComplete: 0,
  activitiesOverdue: 0,
  unallocatedCount: 0, unclassifiedCount: 0,
  truncated: false,
  unread: [], notes: [],
});

// THE CANONICAL VOCABULARY FROM src/lib/employee-tasks.ts, not a second one invented here. A status
// is mapped through canonicalStatus() before it ever reaches an ActivityRow, so the legacy spellings
// never arrive - and they are deliberately not listed, because a value that cannot occur, listed as
// though it can, is exactly how a second vocabulary starts. 'cancelled' and 'archived' appear in
// neither list: they are closed, they are skipped above, and nothing is owed on them.
const COMPLETE_STATUSES = ['completed', 'approved'];
const IN_PROGRESS_STATUSES = ['accepted', 'in_progress', 'blocked', 'under_review'];

/**
 * ONE INTERN, THE WHOLE ENROLMENT. Allocated, completed, verified, recognised and outstanding, with
 * the per-category and per-week breakdowns and the full activity ledger behind them.
 *
 * `requiredHours` IS PASSED IN, NOT LOOKED UP. It lives on the enrolment (src/lib/eims-programme.ts),
 * and reaching into that module from here would make two files responsible for one figure. The
 * caller already holds the enrolment; it hands over the number and the sentence explaining where it
 * came from. Passing nothing leaves it NULL, which renders as "nobody has recorded a required total"
 * and never as zero.
 */
export async function internProgress(
  employeeId: string,
  opts?: {
    fromIso?: string | null;
    toIso?: string | null;
    spanBasis?: string | null;
    requiredHours?: number | null;
    requiredBasis?: string | null;
    programmeKey?: string | null;
    todayIso?: string | null;
  },
): Promise<InternProgress> {
  if (!isUuid(employeeId)) return emptyProgress(employeeId, NOT_AVAILABLE);

  const today = DATE_RE.test(String(opts?.todayIso || '').slice(0, 10))
    ? String(opts!.todayIso).slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  const to = DATE_RE.test(String(opts?.toIso || '').slice(0, 10))
    ? String(opts!.toIso).slice(0, 10)
    : today;

  // A year back by default. It is a WINDOW, and spanBasis says so rather than letting the total read
  // as "everything this person has ever done".
  const defaultFrom = new Date(Date.parse(to + 'T00:00:00Z') - 364 * 86400000)
    .toISOString().slice(0, 10);
  const from = DATE_RE.test(String(opts?.fromIso || '').slice(0, 10))
    ? String(opts!.fromIso).slice(0, 10)
    : defaultFrom;

  if (to < from) return emptyProgress(employeeId, 'That is not a span of dates we can read.');

  const ceiling = await resolveWeeklyCeiling(employeeId, { programmeKey: opts?.programmeKey });
  if (!ceiling) {
    return emptyProgress(employeeId, 'That employee record could not be read. That is a failure to '
      + 'read it, not an empty record.');
  }

  const read = await readActivitiesInRange(employeeId, from, to, MAX_LEDGER_ROWS);
  const typeRead = await listActivityTypes(true);
  const typeByKey = new Map<string, ActivityType>(typeRead.types.map((t) => [t.key, t]));

  const out = emptyProgress(employeeId, read.error);
  out.ok = read.ok;
  out.fullName = ceiling.fullName;
  out.fromIso = from;
  out.toIso = to;
  out.spanBasis = String(opts?.spanBasis || '').trim()
    || ('Everything with a deadline between ' + from + ' and ' + to + '. That is the last twelve '
      + 'months rather than the whole of your record, because no enrolment start date was available '
      + 'to measure from.');
  out.ceilingHours = ceiling.hours;
  out.ceilingBasis = ceiling.basis;
  out.activities = read.activities;
  out.activitiesTotal = read.activities.length;
  out.truncated = read.activities.length >= MAX_LEDGER_ROWS;
  out.unread = read.unread.slice();

  const lines = new Map<string, ProgressTypeLine>();
  const weeks = new Map<string, ProgressWeekLine>();

  for (const a of read.activities) {
    // A cancelled or archived activity carries no allocation and owes nothing. It STAYS in the
    // ledger - the intern is entitled to see that it existed and was closed - and contributes to no
    // total. This is the rule a second mapper always forgets.
    if (a.closed) continue;

    const key = a.activityTypeKey;
    const type = typeByKey.get(key);
    const line = lines.get(key) || {
      key,
      label: a.activityTypeLabel,
      wellbeing: type ? type.wellbeing : a.wellbeing,
      activities: 0,
      allocatedHours: 0, completedHours: 0, verifiedHours: 0, outstandingHours: 0,
      recognisedHours: 0,
    };
    line.activities += 1;
    line.allocatedHours = round2(line.allocatedHours + (a.allocatedHours ?? 0));
    line.completedHours = round2(line.completedHours + (a.reportedHours ?? 0));
    line.verifiedHours = round2(line.verifiedHours + (a.verifiedHours ?? 0));
    line.outstandingHours = round2(line.outstandingHours + a.outstandingHours);
    lines.set(key, line);

    out.allocatedHours = round2(out.allocatedHours + (a.allocatedHours ?? 0));
    out.completedHours = round2(out.completedHours + (a.reportedHours ?? 0));
    out.verifiedHours = round2(out.verifiedHours + (a.verifiedHours ?? 0));
    out.outstandingHours = round2(out.outstandingHours + a.outstandingHours);
    out.aboveAllocationHours = round2(out.aboveAllocationHours + a.aboveAllocationHours);
    out.upliftHours = round2(out.upliftHours + a.upliftHours);

    if (a.wellbeing || line.wellbeing) {
      out.wellbeingAllocatedHours = round2(out.wellbeingAllocatedHours + (a.allocatedHours ?? 0));
      out.wellbeingVerifiedHours = round2(out.wellbeingVerifiedHours + (a.verifiedHours ?? 0));
    }
    if (a.allocatedHours == null) out.unallocatedCount += 1;
    if (key === UNCLASSIFIED_TYPE_KEY) out.unclassifiedCount += 1;

    // ---- the week this activity belongs to -----------------------------------------------------
    const ws = a.weekStart || weekStartOf(a.deadline || to);
    if (ws) {
      const w = weeks.get(ws) || {
        weekStart: ws,
        weekEnd: weekEndOf(ws),
        label: weekLabel(ws),
        allocatedHours: 0, completedHours: 0, verifiedHours: 0,
        recognisedHours: 0, aboveCeilingHours: 0,
        ceilingHours: ceiling.hours,
      };
      w.allocatedHours = round2(w.allocatedHours + (a.allocatedHours ?? 0));
      w.completedHours = round2(w.completedHours + (a.reportedHours ?? 0));
      w.verifiedHours = round2(w.verifiedHours + (a.verifiedHours ?? 0));
      weeks.set(ws, w);
    }

    // ---- the state of the work itself ----------------------------------------------------------
    const st = String(a.status);
    const isComplete = COMPLETE_STATUSES.indexOf(st) >= 0;
    if (isComplete) out.activitiesComplete += 1;
    else if (IN_PROGRESS_STATUSES.indexOf(st) >= 0) out.activitiesInProgress += 1;
    else out.activitiesOpen += 1;
    if (a.deadline && a.deadline < today && !a.verified && !isComplete) out.activitiesOverdue += 1;
  }

  // ---- THE CEILING, ONCE PER WEEK ---------------------------------------------------------------
  for (const w of weeks.values()) {
    w.recognisedHours = round2(Math.min(w.verifiedHours, w.ceilingHours));
    w.aboveCeilingHours = round2(Math.max(0, w.verifiedHours - w.ceilingHours));
    out.recognisedHours = round2(out.recognisedHours + w.recognisedHours);
    out.aboveCeilingHours = round2(out.aboveCeilingHours + w.aboveCeilingHours);
  }

  // A category's recognised figure is its verified hours scaled by how much of the whole verified
  // total survived the weekly cap. It is a SHARE and the screen says so, because the cap applies to
  // a week and not to a category - there is no honest way to say which category lost the hour.
  const shrink = out.verifiedHours > 0 ? out.recognisedHours / out.verifiedHours : 1;
  for (const line of lines.values()) {
    line.recognisedHours = round2(line.verifiedHours * shrink);
  }

  out.byType = Array.from(lines.values()).sort((a, b) => {
    const ta = typeByKey.get(a.key)?.sortOrder ?? 999;
    const tb = typeByKey.get(b.key)?.sortOrder ?? 999;
    return ta === tb ? a.label.localeCompare(b.label) : ta - tb;
  });
  out.byWeek = Array.from(weeks.values()).sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1));

  // ---- REQUIRED, AND THE FRACTION ---------------------------------------------------------------
  const req = Number(opts?.requiredHours);
  out.requiredHours = Number.isFinite(req) && req > 0 ? round2(req) : null;
  out.requiredBasis = String(opts?.requiredBasis || '').trim()
    || (out.requiredHours != null
      ? 'The total this programme asks for.'
      : 'Nobody has recorded a required total for this programme or this person, so progress cannot '
        + 'be expressed as a fraction of it. That is a gap in the configuration, not a zero.');

  if (out.requiredHours != null && out.requiredHours > 0) {
    out.completionPct = round2(Math.min(100, (out.recognisedHours / out.requiredHours) * 100));
    out.completionBasis = hoursWord(out.recognisedHours) + ' recognised against the '
      + hoursWord(out.requiredHours) + ' this programme requires. Recognised means verified by a '
      + 'named mentor and within the weekly ceiling. It is not attendance and it is not what you '
      + 'reported.';
  } else {
    out.completionPct = null;
    out.completionBasis = out.requiredBasis;
  }

  // ---- what the screen should say ---------------------------------------------------------------
  const notes: string[] = [];
  notes.push('These figures count ACTIVITIES, over ' + from + ' to ' + to + '. Not one of them is '
    + 'derived from attendance, a clock or a login.');
  if (out.aboveCeilingHours > 0) {
    notes.push(hoursWord(out.aboveCeilingHours) + ' of verified work is above the weekly ceiling of '
      + hoursWord(ceiling.hours) + ' in the week it fell in. It stays on the record and it is not '
      + 'recognised. Nothing was deleted and this is not a penalty.');
  }
  if (out.aboveAllocationHours > 0) {
    notes.push(hoursWord(out.aboveAllocationHours) + ' of reported effort is above what was '
      + 'allocated for it. It is recorded exactly as you reported it. Recognising it needs a mentor '
      + 'uplift with a written reason.');
  }
  if (out.outstandingHours > 0) {
    notes.push(hoursWord(out.outstandingHours) + ' is allocated and not yet verified. Outstanding '
      + 'means waiting on evidence or on a mentor. It does not mean missed.');
  }
  if (out.unallocatedCount > 0) {
    notes.push(out.unallocatedCount + ' activity(s) carry no allocated hours, so they count towards '
      + 'nothing above until somebody records what they are worth. They are still listed.');
  }
  if (out.unclassifiedCount > 0) {
    notes.push(out.unclassifiedCount + ' activity(s) carry no category, so they are in the totals '
      + 'but not in the breakdown by category.');
  }
  if (out.truncated) {
    notes.push('The ledger below is the most recent ' + MAX_LEDGER_ROWS + ' activities in this span, '
      + 'and the totals above cover those same rows. On a longer record they are a total of what is '
      + 'shown rather than of everything.');
  }
  if (out.unread.length) {
    notes.push('These could not be read: ' + out.unread.join(', ') + '. Every figure above is '
      + 'incomplete because of it, and that is a failure to read them rather than a fact about your '
      + 'work.');
  }
  if (typeRead.fallback) {
    notes.push('The categories are being shown from the built-in list because the configured '
      + 'taxonomy could not be read.');
  }
  out.notes = notes;

  return out;
}
