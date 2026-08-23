// src/lib/hr-intelligence/signals.ts — WHAT THE HR DESK IS SHOWN, AND WHAT EACH THING WAS READ FROM.
//
// =================================================================================================
// ONE ASSEMBLY, PER VIEWER, AFTER THE ACCESS ROW IS WRITTEN
// =================================================================================================
//
// buildHrIntelligence() is the only entry point. It takes an access decision that has ALREADY been
// resolved and an access row that has ALREADY been written, and it assembles only the sections that
// decision granted. A withheld section's query is never issued: the builder for it is not called,
// and the section renders its refusal sentence instead of its rows.
//
// EVERY SECTION IS WRAPPED INDEPENDENTLY. A table that does not exist on this database degrades
// THAT section to `unreadable` with a sentence naming the reason. It never blanks the screen, and
// it never renders as "nothing on record", which would be a false statement about a person.
//
// =================================================================================================
// NOTHING HERE WRITES
// =================================================================================================
//
// This module issues SELECTs and nothing else. Every write in this patch is in actions.ts, behind a
// capability belonging to the module that owns the table being written. A read module that can also
// write is a read module that will eventually write from a render path.
//
// =================================================================================================
// NO SCORES, AND THE ABSENCES ARE THE FEATURE
// =================================================================================================
//
// There is no readiness score, no fit percentage, no engagement index and no rating of a person
// anywhere in this file. Sections COUNT records and NAME conditions; they never rate a human.
// requirementCoverage() in evidence-graph.ts already refuses to total a requirement list and says
// why, and this module keeps that refusal rather than quietly totalling it one layer up.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { logEvent } from '@/lib/logger';
import { MIN_GROUP } from '@/lib/analytics-workforce';
import {
  hrSignal,
  sectionLabel,
  sectionSubtitle,
  SECTION_KEYS,
  FOUNDATIONAL_WITHHELD_SENTENCE,
  foundationalProvider,
  sortByWeight,
  type HrSection,
  type HrSignal,
  type SectionKey,
  type SectionState,
  type EvidenceRef,
  type SignalInput,
  type HrActionKind,
  type FoundationalResult,
} from '@/lib/hr-intelligence/types';
import type { HrIntelAccess } from '@/lib/hr-intelligence/access';

const MOD = 'hr-intelligence/signals';
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const logFail = (tag: string, e: any) => logEvent('error', MOD + ':' + tag, { message: reasonOf(e) });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const iso = (v: any): string | null => {
  if (!v) return null;
  try { return new Date(v).toISOString(); } catch { return null; }
};

const dayOf = (v: any): string | null => {
  const s = iso(v);
  return s ? s.slice(0, 10) : null;
};

/** Whole days between two instants, floored. Null when either end is missing. */
function daysBetween(from: any, to: any): number | null {
  const a = from ? new Date(from).getTime() : NaN;
  const b = to ? new Date(to).getTime() : NaN;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.floor((b - a) / 86400000);
}

// =================================================================================================
// THE ASSEMBLED VIEW
// =================================================================================================

export interface HrIntelligence {
  employeeId: string;
  /** The person's name and current role, so a screen never has to re-read them. */
  displayName: string | null;
  designation: string | null;
  departmentId: string | null;
  sections: HrSection[];
  /** Every signal on the page, in one list, strongest first. */
  allSignals: HrSignal[];
  access: HrIntelAccess;
  /** The hri_access_log row this assembly was recorded under. */
  accessRecordId: string;
  /** The foundational tier's answer, which on this platform is always that there is no provider. */
  foundational: FoundationalResult;
  assembledAt: string;
  /** What could not be read at all, named, so an empty screen is never mistaken for an empty record. */
  unreadable: string[];
}

export interface BuildInput {
  employeeId: string;
  access: HrIntelAccess;
  accessRecordId: string;
  /** Passed through to a foundational provider, which is the only consumer. */
  purpose: string;
}

/** A section the viewer was not granted. Its builder is never called. */
function withheldSection(key: SectionKey, because: string): HrSection {
  return {
    key,
    label: sectionLabel(key),
    subtitle: sectionSubtitle(key),
    state: 'not_permitted',
    sentence: because,
    signals: [],
    actions: [],
  };
}

function section(
  key: SectionKey,
  state: SectionState,
  sentence: string,
  signals: HrSignal[],
  actions: HrActionKind[],
): HrSection {
  return {
    key,
    label: sectionLabel(key),
    subtitle: sectionSubtitle(key),
    state,
    sentence,
    signals: sortByWeight(signals),
    actions,
  };
}

function unreadableSection(key: SectionKey, e: any): HrSection {
  return section(
    key,
    'unreadable',
    'This section could not be read: ' + reasonOf(e) + '. That is not the same as there being '
      + 'nothing on record, and it is shown as a failure rather than as an empty list.',
    [],
    [],
  );
}

/** Only offer an action the viewer was actually granted. */
function allowed(access: HrIntelAccess, wanted: HrActionKind[]): HrActionKind[] {
  return wanted.filter((k) => access.grantedActions.indexOf(k) >= 0);
}

// =================================================================================================
// SECTION 1 — CURRENT ROLE STATUS
// =================================================================================================
//
// Reads hr_employees and names EVERY column it selects. The SELECT list is the enforcement: salary,
// bank details, date of birth, gender, blood group, PAN and Aadhaar are not on it, so no code path
// on this screen can fetch them and then choose not to show them.

async function buildRoleStatus(employeeId: string, access: HrIntelAccess): Promise<HrSection> {
  try {
    const r = await db.execute(sql`
      SELECT id, full_name, designation, department_id::text AS department_id, employment_type,
             work_mode, employment_status, onboarding_status, joining_date, probation_end_date,
             confirmation_date, is_active
        FROM hr_employees
       WHERE id = ${employeeId}
       LIMIT 1`);
    const rows = rowsOf(r);
    if (!rows.length) {
      return section('role_status', 'empty',
        'There is no employee record with this id. Nothing else on this page was assembled for it.',
        [], []);
    }
    const e: any = rows[0];
    const input: SignalInput = {
      ownerModule: 'the people desk (hr_employees)',
      table: 'hr_employees',
      rowsRead: 1,
    };
    const ev = (summary: string): EvidenceRef => ({
      recordId: 'hr_employees:' + String(e.id),
      table: 'hr_employees',
      ownerModule: 'the people desk',
      summary,
      providedBy: 'the people desk',
      assertion: 'provided',
      occurredAt: iso(e.joining_date),
      href: '/admin/people/employees',
    });

    const signals: HrSignal[] = [];

    signals.push(hrSignal({
      id: 'role_status:designation',
      section: 'role_status',
      label: 'Role on record',
      value: {
        kind: 'text', number: null, unit: null,
        display: (e.designation ? String(e.designation) : 'No designation recorded')
          + (e.employment_type ? ' — ' + String(e.employment_type) : '')
          + (e.work_mode ? ', ' + String(e.work_mode) : ''),
      },
      processing: 'Read straight from the employment record. A designation is what somebody at the '
        + 'people desk typed; it is not derived and it is not verified against anything.',
      inputs: [input],
      evidence: [ev('Designation, employment type and work mode as recorded.')],
      decisionUse: 'not_a_decision_input',
      actions: [],
    }));

    const tenureDays = daysBetween(e.joining_date, new Date());
    signals.push(hrSignal({
      id: 'role_status:tenure',
      section: 'role_status',
      label: 'Time with the organisation',
      value: tenureDays === null
        ? { kind: 'text', number: null, unit: null, display: 'No joining date is recorded, so tenure cannot be counted.' }
        : { kind: 'duration', number: tenureDays, unit: 'days', display: tenureDays + ' days since the recorded joining date' },
      processing: 'Whole days between hr_employees.joining_date and today. Nothing is inferred when '
        + 'the date is absent; the absence is printed instead.',
      inputs: [input],
      evidence: tenureDays === null ? [] : [ev('Joining date ' + dayOf(e.joining_date) + '.')],
      decisionUse: 'not_a_decision_input',
      actions: [],
    }));

    const status = String(e.employment_status || 'unknown');
    const confirmed = !!e.confirmation_date;
    const probationEnds = dayOf(e.probation_end_date);
    signals.push(hrSignal({
      id: 'role_status:stage',
      section: 'role_status',
      label: 'Stage of employment',
      value: {
        kind: 'text', number: null, unit: null,
        display: confirmed
          ? 'Confirmed on ' + dayOf(e.confirmation_date) + '. Status: ' + status + '.'
          : probationEnds
            ? 'Not confirmed. Probation is recorded as ending ' + probationEnds + '. Status: ' + status + '.'
            : 'Not confirmed, and no probation end date is recorded. Status: ' + status + '.',
      },
      processing: 'confirmation_date, probation_end_date and employment_status, read as stored. '
        + 'This module does not decide whether somebody should be confirmed and does not compute a '
        + 'date from tenure.',
      inputs: [input],
      evidence: [ev('Onboarding ' + String(e.onboarding_status || 'unknown') + ', status ' + status + '.')],
      decisionUse: 'not_a_decision_input',
      actions: [],
    }));

    return section('role_status', 'ready',
      'Three facts, all typed by a person at the people desk. Nothing on this section is derived, '
        + 'and pay, bank details, date of birth and gender were not selected by the query behind it.',
      signals, allowed(access, ['schedule_review']));
  } catch (e: any) {
    logFail('role_status', e);
    return unreadableSection('role_status', e);
  }
}

// =================================================================================================
// SECTION 2 — DEVELOPMENT NEEDS
// =================================================================================================
//
// A NEED IS NEVER INVENTED HERE. Each one is a record somebody else already wrote: an appraisal
// outcome of 'needs_support' written by a named reviewer, a learning assignment past its due date,
// or feedback a named human filed under 'improvement'. This module counts them and says who wrote
// each one. It does not read prose and conclude that somebody is struggling.

async function buildDevelopmentNeeds(employeeId: string, access: HrIntelAccess): Promise<HrSection> {
  const signals: HrSignal[] = [];
  const failures: string[] = [];

  // --- appraisal outcomes asking for support -----------------------------------------------------
  try {
    const r = await db.execute(sql`
      SELECT r.id, r.outcome, r.outcome_note, r.improvements, r.updated_at, r.submitted_at,
             c.title AS cycle_title, c.period_end
        FROM hr_performance_reviews r
        LEFT JOIN hr_review_cycles c ON c.id = r.cycle_id
       WHERE r.employee_id = ${employeeId}
         AND r.outcome = 'needs_support'
       ORDER BY COALESCE(r.submitted_at, r.updated_at) DESC
       LIMIT 20`);
    const rows = rowsOf(r);
    const evidence: EvidenceRef[] = rows.map((x: any) => ({
      recordId: 'hr_performance_reviews:' + String(x.id),
      table: 'hr_performance_reviews',
      ownerModule: 'the appraisal module',
      summary: 'Outcome recorded as needing support in "'
        + String(x.cycle_title || 'an appraisal cycle') + '"'
        + (x.outcome_note ? ': ' + String(x.outcome_note).slice(0, 160) : '') + '.',
      providedBy: 'the reviewer who recorded the outcome',
      assertion: 'provided',
      occurredAt: iso(x.submitted_at || x.updated_at),
      href: '/admin/hr/performance',
    }));
    signals.push(hrSignal({
      id: 'development_needs:outcomes',
      section: 'development_needs',
      label: 'Appraisals that recorded a need for support',
      value: {
        kind: 'count', number: rows.length, unit: 'appraisals',
        display: rows.length === 0
          ? 'No appraisal on record has recorded a need for support.'
          : rows.length + ' appraisal(s) recorded an outcome of needing support.',
      },
      processing: 'hr_performance_reviews rows for this employee whose outcome column is exactly '
        + '"needs_support". A rating is not read here and no threshold is applied to one: the '
        + 'outcome is a word a named reviewer chose.',
      inputs: [{ ownerModule: 'src/lib/performance.ts', table: 'hr_performance_reviews', rowsRead: rows.length }],
      evidence,
      decisionUse: 'supporting',
      actions: allowed(access, ['initiate_development_plan', 'record_intervention']),
    }));
  } catch (e: any) {
    logFail('development_needs:outcomes', e);
    failures.push('appraisal outcomes (' + reasonOf(e) + ')');
  }

  // --- learning that is past its due date ---------------------------------------------------------
  try {
    const r = await db.execute(sql`
      SELECT a.id, a.course_id, a.due_on, a.status, a.reason, a.required, a.created_at
        FROM hr_learning_assignments a
       WHERE a.employee_id = ${employeeId}
         AND a.due_on IS NOT NULL
         AND a.due_on < CURRENT_DATE
         AND a.status <> 'completed'
       ORDER BY a.due_on ASC
       LIMIT 30`);
    const rows = rowsOf(r);
    const evidence: EvidenceRef[] = rows.map((x: any) => ({
      recordId: 'hr_learning_assignments:' + String(x.id),
      table: 'hr_learning_assignments',
      ownerModule: 'the learning module',
      summary: 'Assigned learning due ' + dayOf(x.due_on) + ', still ' + String(x.status || 'assigned')
        + (x.required ? ', marked required' : '') + '.',
      providedBy: 'this platform',
      assertion: 'factual',
      occurredAt: iso(x.created_at),
      href: '/admin/hr/training',
    }));
    signals.push(hrSignal({
      id: 'development_needs:overdue_learning',
      section: 'development_needs',
      label: 'Assigned learning past its due date',
      value: {
        kind: 'count', number: rows.length, unit: 'assignments',
        display: rows.length === 0
          ? 'Nothing assigned to this person is past its due date.'
          : rows.length + ' assignment(s) are past their due date.',
      },
      processing: 'hr_learning_assignments with a due date in the past and a status other than '
        + 'completed. An assignment with no due date is not counted as late, because nobody said '
        + 'when it was due.',
      inputs: [{ ownerModule: 'src/lib/performance-learning.ts', table: 'hr_learning_assignments', rowsRead: rows.length }],
      evidence,
      decisionUse: 'supporting',
      actions: allowed(access, ['initiate_development_plan', 'schedule_review']),
    }));
  } catch (e: any) {
    logFail('development_needs:learning', e);
    failures.push('assigned learning (' + reasonOf(e) + ')');
  }

  // --- feedback filed as an area to improve -------------------------------------------------------
  try {
    const r = await db.execute(sql`
      SELECT id, author_user_id, author_name, body, created_at
        FROM hr_feedback
       WHERE subject_employee_id = ${employeeId}
         AND theme = 'improvement'
       ORDER BY created_at DESC
       LIMIT 30`);
    const rows = rowsOf(r);
    const evidence: EvidenceRef[] = rows.map((x: any) => ({
      recordId: 'hr_feedback:' + String(x.id),
      table: 'hr_feedback',
      ownerModule: 'the feedback module',
      summary: String(x.body || '').slice(0, 200),
      providedBy: x.author_name ? String(x.author_name) : 'an unnamed author',
      providedByUserId: x.author_user_id ? String(x.author_user_id) : null,
      assertion: 'provided',
      occurredAt: iso(x.created_at),
      href: '/admin/hr/performance',
    }));
    const authors = new Set(evidence.map((x) => x.providedByUserId || x.providedBy)).size;
    signals.push(hrSignal({
      id: 'development_needs:feedback',
      section: 'development_needs',
      label: 'Feedback filed as an area to improve',
      value: {
        kind: 'count', number: rows.length, unit: 'notes',
        display: rows.length === 0
          ? 'No feedback on record is filed under improvement.'
          : rows.length + ' note(s) from ' + authors + ' author(s).',
      },
      processing: 'hr_feedback rows whose theme is exactly "improvement". The body text is shown as '
        + 'written and is not summarised, classified or scored. Who wrote each one is named, '
        + 'because ' + (authors === 1 ? 'all of these came from one person' : 'the count of authors changes what the count of notes means') + '.',
      inputs: [{ ownerModule: 'src/lib/performance.ts', table: 'hr_feedback', rowsRead: rows.length }],
      evidence,
      decisionUse: authors <= 1 ? 'advisory' : 'supporting',
      actions: allowed(access, ['request_feedback', 'initiate_development_plan']),
    }));
  } catch (e: any) {
    logFail('development_needs:feedback', e);
    failures.push('feedback (' + reasonOf(e) + ')');
  }

  if (!signals.length) {
    return section('development_needs', 'unreadable',
      'None of the sources behind this section could be read: ' + failures.join('; ') + '.',
      [], []);
  }

  const anything = signals.some((s) => (s.value.number || 0) > 0);
  return section('development_needs',
    anything ? 'ready' : 'empty',
    anything
      ? 'Every item here is a record a named person already wrote. Nothing on this section was '
        + 'concluded by reading somebody\'s work and forming an opinion about them.'
        + (failures.length ? ' Not everything could be read: ' + failures.join('; ') + '.' : '')
      : 'The sources were read and none of them records a development need for this person. The '
        + 'absence is the finding, not an empty screen.',
    signals, allowed(access, ['initiate_development_plan', 'request_feedback', 'record_intervention']));
}

// =================================================================================================
// SECTION 3 — SKILL GAPS
// =================================================================================================
//
// TWO KINDS OF GAP, AND THEY ARE NEVER MIXED:
//
//   1. THE RECORDED MATRIX. hr_employee_skills is the level of record and src/lib/skills.ts is its
//      only writer. This section READS it and never writes it.
//
//   2. THE ROLE'S REQUIREMENTS. `roles.skills` is a list of strings somebody typed on a job advert.
//      Resolving one to a catalogue skill is a NAME MATCH, and a name match is not evidence. Any
//      requirement that does not resolve is REPORTED as unresolved rather than dropped, because a
//      requirement silently missing from a gap list reads as a requirement that was met.
//
// THE ROLE IS MATCHED BY DESIGNATION, WHICH IS ALSO A NAME MATCH, and the section says so in the
// same words every time. There is no employee-to-role foreign key on this platform.

async function buildSkillGaps(
  employeeId: string,
  designation: string | null,
  access: HrIntelAccess,
): Promise<HrSection> {
  try {
    // The matrix, as recorded.
    const heldRows = rowsOf(await db.execute(sql`
      SELECT es.id, es.skill_id, es.level, es.source, es.evidence, es.assessed_at,
             s.name AS skill_name, s.category
        FROM hr_employee_skills es
        JOIN hr_skills s ON s.id = es.skill_id
       WHERE es.employee_id = ${employeeId}
       ORDER BY es.level ASC, s.name ASC
       LIMIT 200`));

    const held = new Map<string, any>();
    for (const h of heldRows) held.set(String(h.skill_name || '').toLowerCase(), h);

    const signals: HrSignal[] = [];

    // Skills recorded at the lowest level are a gap the matrix itself states.
    const lowest = heldRows.filter((h: any) => Number(h.level) <= 1);
    signals.push(hrSignal({
      id: 'skill_gaps:recorded_low',
      section: 'skill_gaps',
      label: 'Skills recorded at the lowest level',
      value: {
        kind: 'count', number: lowest.length, unit: 'skills',
        display: lowest.length === 0
          ? 'No skill is recorded at the lowest level.'
          : lowest.length + ' skill(s) recorded at the lowest level: '
            + lowest.slice(0, 8).map((h: any) => String(h.skill_name)).join(', ')
            + (lowest.length > 8 ? ' and others' : '') + '.',
      },
      processing: 'hr_employee_skills rows for this employee with level 1. The level is the skill '
        + 'matrix\'s own value, written by the module that owns it; this section does not compute a '
        + 'level and cannot change one.',
      inputs: [{ ownerModule: 'src/lib/skills.ts', table: 'hr_employee_skills', rowsRead: heldRows.length }],
      evidence: lowest.slice(0, 25).map((h: any) => ({
        recordId: 'hr_employee_skills:' + String(h.id),
        table: 'hr_employee_skills',
        ownerModule: 'the skill matrix',
        summary: String(h.skill_name) + ' at level ' + String(h.level)
          + ', recorded by ' + String(h.source || 'self') + '.',
        providedBy: String(h.source) === 'self' ? 'the employee' : 'the ' + String(h.source || 'record'),
        assertion: String(h.source) === 'assessment' || String(h.source) === 'course' ? 'factual' : 'provided',
        occurredAt: iso(h.assessed_at),
        href: '/admin/hr/performance/skills',
      })),
      decisionUse: 'supporting',
      actions: allowed(access, ['assign_training', 'initiate_development_plan']),
    }));

    // The role's requirements, if a role can be matched by name.
    const title = String(designation || '').trim();
    if (!title) {
      signals.push(hrSignal({
        id: 'skill_gaps:no_role',
        section: 'skill_gaps',
        label: 'Requirements of the role',
        value: {
          kind: 'text', number: null, unit: null,
          display: 'No designation is recorded for this person, so there is no role to read '
            + 'requirements from. This is not a statement that the role has no requirements.',
        },
        processing: 'The role is matched by comparing hr_employees.designation with roles.title. '
          + 'With no designation there is nothing to compare.',
        inputs: [{ ownerModule: 'the people desk', table: 'hr_employees', rowsRead: 1 }],
        evidence: [],
        decisionUse: 'not_a_decision_input',
        actions: [],
      }));
    } else {
      const roleRows = rowsOf(await db.execute(sql`
        SELECT id, title, skills
          FROM roles
         WHERE lower(title) = lower(${title})
         ORDER BY is_open DESC, updated_at DESC
         LIMIT 1`));

      if (!roleRows.length) {
        signals.push(hrSignal({
          id: 'skill_gaps:no_role_match',
          section: 'skill_gaps',
          label: 'Requirements of the role',
          value: {
            kind: 'text', number: null, unit: null,
            display: 'No role in the catalogue is titled "' + title + '", so this person\'s '
              + 'requirements could not be read. There is no employee-to-role link on this '
              + 'platform; the only join available is the two titles matching exactly.',
          },
          processing: 'lower(roles.title) = lower(hr_employees.designation). A name match, and it '
            + 'found nothing.',
          inputs: [{ ownerModule: 'the hiring desk', table: 'roles', rowsRead: 0 }],
          evidence: [],
          decisionUse: 'not_a_decision_input',
          actions: [],
        }));
      } else {
        const role: any = roleRows[0];
        const wanted: string[] = Array.isArray(role.skills) ? role.skills.map((s: any) => String(s)) : [];
        const missing = wanted.filter((w) => !held.has(w.toLowerCase()));
        const covered = wanted.filter((w) => held.has(w.toLowerCase()));

        signals.push(hrSignal({
          id: 'skill_gaps:role_requirements',
          section: 'skill_gaps',
          label: 'Role requirements with nothing recorded against them',
          value: {
            kind: 'count', number: missing.length, unit: 'requirements',
            display: wanted.length === 0
              ? 'The matched role lists no skills, so there is nothing to compare against.'
              : missing.length + ' of ' + wanted.length + ' listed requirement(s) have no entry in '
                + 'this person\'s skill matrix'
                + (missing.length ? ': ' + missing.slice(0, 10).join(', ') + '.' : '.'),
          },
          processing: 'The role was matched to "' + String(role.title) + '" by title alone, which '
            + 'is a NAME MATCH and not a recorded link. Its skills list is free text somebody typed '
            + 'on a job advert; each entry is compared case-insensitively with the names in this '
            + 'person\'s skill matrix. A requirement with no matrix entry is listed as having '
            + 'nothing recorded against it — which is not the same as the person lacking it, and '
            + 'there is deliberately no percentage over this comparison.',
          inputs: [
            { ownerModule: 'the hiring desk', table: 'roles', rowsRead: 1 },
            { ownerModule: 'src/lib/skills.ts', table: 'hr_employee_skills', rowsRead: heldRows.length },
          ],
          evidence: covered.slice(0, 20).map((w) => {
            const h = held.get(w.toLowerCase());
            return {
              recordId: 'hr_employee_skills:' + String(h.id),
              table: 'hr_employee_skills' as const,
              ownerModule: 'the skill matrix',
              summary: w + ' is recorded at level ' + String(h.level) + '.',
              providedBy: String(h.source) === 'self' ? 'the employee' : 'the ' + String(h.source || 'record'),
              assertion: (String(h.source) === 'assessment' || String(h.source) === 'course'
                ? 'factual' : 'provided') as 'factual' | 'provided',
              occurredAt: iso(h.assessed_at),
              href: '/admin/hr/performance/skills',
            };
          }),
          decisionUse: 'advisory',
          actions: allowed(access, ['assign_training', 'initiate_development_plan', 'initiate_mobility_review']),
        }));
      }
    }

    const anyGap = signals.some((s) => (s.value.number || 0) > 0);
    return section('skill_gaps', heldRows.length || anyGap ? 'ready' : 'empty',
      heldRows.length
        ? 'The skill matrix is read here and never written. A gap on this list is a missing RECORD, '
          + 'which is not the same as a missing capability: somebody can be excellent at something '
          + 'nobody has written down.'
        : 'This person has no skills recorded in the matrix at all, so every requirement will read '
          + 'as having nothing recorded against it. That is a recording gap, not a capability gap.',
      signals, allowed(access, ['assign_training', 'initiate_development_plan']));
  } catch (e: any) {
    logFail('skill_gaps', e);
    return unreadableSection('skill_gaps', e);
  }
}

// =================================================================================================
// SECTION 4 — TRAINING RECOMMENDATIONS
// =================================================================================================
//
// A RECOMMENDATION HERE IS A KEYWORD MATCH AND SAYS SO IN THE PROCESSING LINE. There is no
// course-to-skill mapping on this platform: training_courses has a title, a category and a level,
// and hr_skills has a name, and nothing joins them. Inventing a relevance score over that gap would
// be keyword overlap wearing a number.
//
// So the match is stated plainly, its decisionUse is `advisory`, and the assign action carries the
// gap as the written reason so that whoever reads the assignment later knows what it was for.

async function buildTraining(
  employeeId: string,
  gapNames: string[],
  access: HrIntelAccess,
): Promise<HrSection> {
  try {
    const assigned = rowsOf(await db.execute(sql`
      SELECT a.id, a.course_id, a.status, a.due_on, a.reason, a.required, a.created_at
        FROM hr_learning_assignments a
       WHERE a.employee_id = ${employeeId}
       ORDER BY a.created_at DESC
       LIMIT 50`));

    const signals: HrSignal[] = [];

    signals.push(hrSignal({
      id: 'training:assigned',
      section: 'training',
      label: 'Learning already assigned',
      value: {
        kind: 'count', number: assigned.length, unit: 'assignments',
        display: assigned.length === 0
          ? 'Nothing has been assigned to this person.'
          : assigned.length + ' assignment(s), of which '
            + assigned.filter((a: any) => String(a.status) === 'completed').length + ' are complete.',
      },
      processing: 'Every hr_learning_assignments row for this employee, complete or not. This is '
        + 'what was ASKED of them; what they actually did lives in the learning module\'s own '
        + 'progress record and is not restated here.',
      inputs: [{ ownerModule: 'src/lib/performance-learning.ts', table: 'hr_learning_assignments', rowsRead: assigned.length }],
      evidence: assigned.slice(0, 25).map((a: any) => ({
        recordId: 'hr_learning_assignments:' + String(a.id),
        table: 'hr_learning_assignments' as const,
        ownerModule: 'the learning module',
        summary: 'Status ' + String(a.status || 'assigned')
          + (a.due_on ? ', due ' + dayOf(a.due_on) : ', no due date')
          + (a.reason ? ' — ' + String(a.reason).slice(0, 120) : '') + '.',
        providedBy: 'this platform',
        assertion: 'factual' as const,
        occurredAt: iso(a.created_at),
        href: '/admin/hr/training',
      })),
      decisionUse: 'not_a_decision_input',
      actions: allowed(access, ['assign_training']),
    }));

    // Courses whose title or category contains a gap word.
    const words = gapNames.map((g) => String(g || '').trim()).filter((g) => g.length >= 3).slice(0, 12);
    if (words.length) {
      const pattern = '%(' + words.map((w) => w.replace(/[%_\\]/g, '\\$&')).join('|') + ')%';
      const courses = rowsOf(await db.execute(sql`
        SELECT id, title, category, level, duration_hours
          FROM training_courses
         WHERE is_published = true
           AND (access_type IS NULL OR access_type IN ('public', 'both', 'employees'))
           AND (title ~* ${pattern} OR COALESCE(category, '') ~* ${pattern})
         ORDER BY title ASC
         LIMIT 25`));

      signals.push(hrSignal({
        id: 'training:matched_courses',
        section: 'training',
        label: 'Published courses whose title or category names a gap',
        value: {
          kind: 'count', number: courses.length, unit: 'courses',
          display: courses.length === 0
            ? 'No published course names any of the gaps found above in its title or category.'
            : courses.length + ' published course(s) name one of: ' + words.join(', ') + '.',
        },
        processing: 'A CASE-INSENSITIVE WORD MATCH between the gap names found in the skills section '
          + 'and the title or category of published courses. Nothing on this platform maps a course '
          + 'to a skill, so this is the honest extent of what can be offered: a list to choose from, '
          + 'not a ranking, and no relevance figure. A course that teaches the gap under a different '
          + 'name will not appear here, and one that merely mentions the word will.',
        inputs: [{ ownerModule: 'src/lib/performance-learning.ts', table: 'hr_learning_assignments', rowsRead: assigned.length }],
        evidence: [],
        confidence: {
          level: 'low',
          why: 'A keyword match between two lists that were never designed to join. It is a starting '
            + 'point for a human choosing a course, and nothing stronger.',
        },
        decisionUse: 'advisory',
        actions: allowed(access, ['assign_training']),
      }));

      // The matched courses travel with the section so the assign form can offer them.
      (signals[signals.length - 1] as any).matchedCourses = courses.map((c: any) => ({
        id: String(c.id),
        title: String(c.title || 'Untitled course'),
        category: c.category ? String(c.category) : null,
        level: c.level ? String(c.level) : null,
      }));
    }

    return section('training', 'ready',
      'A suggestion is a list to choose from. Assigning is a separate act, it goes through the '
        + 'learning module, and the reason you type is what the employee sees on their own path.',
      signals, allowed(access, ['assign_training', 'schedule_review']));
  } catch (e: any) {
    logFail('training', e);
    return unreadableSection('training', e);
  }
}

// =================================================================================================
// SECTION 5 — MANAGER AND PEER FEEDBACK
// =================================================================================================
//
// ONE PERSON'S FEEDBACK IS NEVER ORGANISATIONAL TRUTH, AND THIS IS WHERE THAT IS ENFORCED.
//
// The section does four things and refuses a fifth:
//
//   - it lists every note, unaggregated, with its named author;
//   - it counts DISTINCT AUTHORS separately from notes, because ten notes from one person is one
//     person's opinion repeated;
//   - it names CONTRADICTIONS: the same author filing both a strength and an improvement, and
//     different authors disagreeing about the same period;
//   - it names OUTLIERS: an author whose notes are all of one theme when the rest are mixed;
//   - and it produces NO SENTIMENT SCORE, NO AVERAGE AND NO CONSENSUS FIGURE. There is no number
//     that summarises what a group of people think of a colleague.

async function buildFeedback(employeeId: string, access: HrIntelAccess): Promise<HrSection> {
  try {
    const rows = rowsOf(await db.execute(sql`
      SELECT id, kind, author_user_id, author_name, cycle_id, theme, body, created_at
        FROM hr_feedback
       WHERE subject_employee_id = ${employeeId}
       ORDER BY created_at DESC
       LIMIT 200`));

    const input: SignalInput = {
      ownerModule: 'src/lib/performance.ts',
      table: 'hr_feedback',
      rowsRead: rows.length,
    };

    const evidence: EvidenceRef[] = rows.slice(0, 60).map((x: any) => ({
      recordId: 'hr_feedback:' + String(x.id),
      table: 'hr_feedback',
      ownerModule: 'the feedback module',
      summary: '[' + String(x.theme || 'general') + '] ' + String(x.body || '').slice(0, 220),
      providedBy: x.author_name ? String(x.author_name) : 'an unnamed author',
      providedByUserId: x.author_user_id ? String(x.author_user_id) : null,
      assertion: 'provided',
      occurredAt: iso(x.created_at),
      href: '/admin/hr/performance',
    }));

    const authorKey = (x: any) => String(x.author_user_id || x.author_name || 'unknown');
    const authors = new Set(rows.map(authorKey));
    const byTheme = new Map<string, number>();
    for (const x of rows) {
      const t = String(x.theme || 'general');
      byTheme.set(t, (byTheme.get(t) || 0) + 1);
    }

    const signals: HrSignal[] = [];

    signals.push(hrSignal({
      id: 'feedback:volume',
      section: 'feedback',
      label: 'Notes on record, and how many people wrote them',
      value: {
        kind: 'count', number: rows.length, unit: 'notes',
        display: rows.length === 0
          ? 'No feedback has been recorded about this person.'
          : rows.length + ' note(s) from ' + authors.size + ' author(s): '
            + Array.from(byTheme.entries()).map(([t, n]) => n + ' ' + t).join(', ') + '.',
      },
      processing: 'A count of hr_feedback rows and a count of DISTINCT authors, kept apart on '
        + 'purpose. Many notes from one person is one person\'s account repeated, and a single '
        + 'total would hide that.',
      inputs: [input],
      evidence,
      decisionUse: authors.size <= 1 ? 'advisory' : 'supporting',
      actions: allowed(access, ['request_feedback']),
    }));

    // --- single-source warning ---------------------------------------------------------------------
    if (rows.length > 0 && authors.size === 1) {
      signals.push(hrSignal({
        id: 'feedback:single_source',
        section: 'feedback',
        label: 'Everything on record came from one person',
        value: {
          kind: 'text', number: null, unit: null,
          display: 'All ' + rows.length + ' note(s) were written by the same author. This is one '
            + 'person\'s account of a colleague, and it is not agreement.',
        },
        processing: 'Distinct author count is exactly one. Stated here as its own finding rather '
          + 'than left for a reader to notice from the list.',
        inputs: [input],
        evidence: evidence.slice(0, 5),
        confidence: { level: 'low', why: 'One source. One person stating something is not agreement.' },
        decisionUse: 'advisory',
        actions: allowed(access, ['request_feedback']),
      }));
    }

    // --- contradictions ----------------------------------------------------------------------------
    const themesByAuthor = new Map<string, Set<string>>();
    const nameByAuthor = new Map<string, string>();
    for (const x of rows) {
      const k = authorKey(x);
      if (!themesByAuthor.has(k)) themesByAuthor.set(k, new Set());
      themesByAuthor.get(k)!.add(String(x.theme || 'general'));
      if (x.author_name) nameByAuthor.set(k, String(x.author_name));
    }
    const mixed = Array.from(themesByAuthor.entries())
      .filter(([, t]) => t.has('strength') && t.has('improvement'));
    const strengthAuthors = new Set(rows.filter((x: any) => String(x.theme) === 'strength').map(authorKey));
    const improvementAuthors = new Set(rows.filter((x: any) => String(x.theme) === 'improvement').map(authorKey));
    const disagreeing = Array.from(strengthAuthors).filter((a) => !improvementAuthors.has(a)).length > 0
      && Array.from(improvementAuthors).filter((a) => !strengthAuthors.has(a)).length > 0;

    if (rows.length > 0) {
      const parts: string[] = [];
      if (mixed.length) {
        parts.push(mixed.length + ' author(s) recorded both a strength and an area to improve: '
          + mixed.map(([k]) => nameByAuthor.get(k) || 'an unnamed author').join(', ') + '.');
      }
      if (disagreeing) {
        parts.push('Some authors recorded only strengths while others recorded only areas to '
          + 'improve. The authors do not agree with each other.');
      }
      if (!parts.length) parts.push('No contradiction was found between the authors on record.');

      signals.push(hrSignal({
        id: 'feedback:disagreement',
        section: 'feedback',
        label: 'Where the authors disagree',
        value: { kind: 'text', number: null, unit: null, display: parts.join(' ') },
        processing: 'Two comparisons, both on the theme column only: authors who filed BOTH a '
          + 'strength and an improvement, and whether the set of authors filing strengths differs '
          + 'from the set filing improvements. THE BODY TEXT IS NOT READ, classified or scored — '
          + 'disagreement here means the recorded themes differ, not that a machine judged what '
          + 'anybody meant.',
        inputs: [input],
        evidence: evidence.filter((e) => e.summary.indexOf('[strength]') === 0 || e.summary.indexOf('[improvement]') === 0).slice(0, 20),
        decisionUse: 'advisory',
        actions: allowed(access, ['request_feedback', 'schedule_review']),
      }));
    }

    // --- outliers ----------------------------------------------------------------------------------
    if (authors.size >= 3) {
      const singleThemeAuthors = Array.from(themesByAuthor.entries())
        .filter(([, t]) => t.size === 1)
        .map(([k]) => nameByAuthor.get(k) || 'an unnamed author');
      signals.push(hrSignal({
        id: 'feedback:outliers',
        section: 'feedback',
        label: 'Authors whose notes are all of one kind',
        value: {
          kind: 'count', number: singleThemeAuthors.length, unit: 'authors',
          display: singleThemeAuthors.length === 0
            ? 'Every author on record has filed more than one kind of note.'
            : singleThemeAuthors.length + ' author(s) have only ever filed one kind of note: '
              + singleThemeAuthors.slice(0, 8).join(', ') + '.',
        },
        processing: 'Authors whose notes all carry the same theme, counted only where there are at '
          + 'least three authors — below that there is no distribution to be an outlier in. This '
          + 'is a note about the SHAPE of the record, not a judgement of the author or the subject, '
          + 'and it is not weighted into anything.',
        inputs: [input],
        evidence: [],
        confidence: {
          level: 'low',
          why: 'Derived from the theme column alone, across a small number of authors.',
        },
        decisionUse: 'not_a_decision_input',
        actions: [],
      }));
    }

    return section('feedback', rows.length ? 'ready' : 'empty',
      rows.length
        ? 'Every note is shown as written, with its author named. There is no sentiment score, no '
          + 'average and no consensus figure here: a group of people\'s views of a colleague do not '
          + 'reduce to a number, and disagreement is kept rather than resolved.'
        : 'The feedback table was read and holds nothing for this person. That is a real finding — '
          + 'nobody has written anything down — and it is often the thing worth acting on.',
      signals, allowed(access, ['request_feedback', 'schedule_review']));
  } catch (e: any) {
    logFail('feedback', e);
    return unreadableSection('feedback', e);
  }
}

// =================================================================================================
// SECTION 6 — BEHAVIOUR TRENDS
// =================================================================================================
//
// "BEHAVIOUR" HERE MEANS RECORDED ORGANISATIONAL EVENTS OVER TIME, AND NOTHING ELSE.
//
// It reads hr_events — the append-only organisational timeline — and employee_tasks. It does not
// read hr_clock_events (location, IP, device, a selfie per punch), it does not read the free-text
// reason on a leave request, and it does not read a message, a login time or a session. Those are
// absent from ADMISSIBLE_SOURCES, so a signal built on one throws at construction.
//
// AND IT DIAGNOSES NOTHING. A change in a count is reported as a change in a count. This module
// never suggests why a person's numbers moved, because the honest answers to that question are
// almost all things it must not hold an opinion about.

async function buildBehaviourTrends(employeeId: string, access: HrIntelAccess): Promise<HrSection> {
  const signals: HrSignal[] = [];
  const failures: string[] = [];

  try {
    const events = rowsOf(await db.execute(sql`
      SELECT id, event_type, assertion, occurred_at, source_module
        FROM hr_events
       WHERE subject_employee_id = ${employeeId}
       ORDER BY occurred_at DESC
       LIMIT 300`));

    const now = Date.now();
    const within = (days: number) => events.filter((e: any) => {
      const t = e.occurred_at ? new Date(e.occurred_at).getTime() : NaN;
      return Number.isFinite(t) && (now - t) <= days * 86400000;
    }).length;

    const last90 = within(90);
    const prior90 = events.filter((e: any) => {
      const t = e.occurred_at ? new Date(e.occurred_at).getTime() : NaN;
      if (!Number.isFinite(t)) return false;
      const age = now - t;
      return age > 90 * 86400000 && age <= 180 * 86400000;
    }).length;

    signals.push(hrSignal({
      id: 'behaviour_trends:events',
      section: 'behaviour_trends',
      label: 'Recorded events, last ninety days against the ninety before',
      value: {
        kind: 'count', number: last90, unit: 'events',
        display: events.length === 0
          ? 'The organisational timeline holds no events for this person.'
          : last90 + ' event(s) in the last ninety days, against ' + prior90 + ' in the ninety '
            + 'before that.',
      },
      processing: 'A count of hr_events rows for this employee in two adjacent ninety-day windows. '
        + 'hr_events is the append-only organisational timeline: joins, leave approvals, appraisal '
        + 'outcomes, course completions, verified skills. IT IS NOT A MONITORING FEED — there is no '
        + 'location, no device, no login time and no message behind any row. A difference between '
        + 'the two windows is reported as a difference between two counts and is not explained.',
      inputs: [{ ownerModule: 'src/lib/hr-events.ts', table: 'hr_events', rowsRead: events.length }],
      evidence: events.slice(0, 30).map((e: any) => ({
        recordId: 'hr_events:' + String(e.id),
        table: 'hr_events' as const,
        ownerModule: 'the organisational timeline',
        summary: String(e.event_type) + ', recorded by ' + String(e.source_module || 'a module') + '.',
        providedBy: 'this platform',
        assertion: (String(e.assertion) === 'verified' ? 'verified'
          : String(e.assertion) === 'explicitly_provided' ? 'provided'
          : String(e.assertion) === 'calculated' ? 'calculated' : 'factual') as any,
        occurredAt: iso(e.occurred_at),
        href: null,
      })),
      decisionUse: 'not_a_decision_input',
      actions: [],
    }));
  } catch (e: any) {
    logFail('behaviour_trends:events', e);
    failures.push('the organisational timeline (' + reasonOf(e) + ')');
  }

  try {
    const tasks = rowsOf(await db.execute(sql`
      SELECT id, status, due_on, completed_at, created_at
        FROM employee_tasks
       WHERE employee_id = ${employeeId}
       ORDER BY created_at DESC
       LIMIT 300`));

    const closed = tasks.filter((t: any) => !!t.completed_at);
    const late = closed.filter((t: any) => {
      if (!t.due_on || !t.completed_at) return false;
      return new Date(t.completed_at).getTime() > new Date(t.due_on).getTime() + 86400000;
    });

    signals.push(hrSignal({
      id: 'behaviour_trends:delivery',
      section: 'behaviour_trends',
      label: 'Tasks closed, and how many closed after their due date',
      value: {
        kind: 'count', number: closed.length, unit: 'tasks',
        display: tasks.length === 0
          ? 'No tasks are recorded for this person.'
          : closed.length + ' of ' + tasks.length + ' recorded task(s) are closed; ' + late.length
            + ' closed after the recorded due date.',
      },
      processing: 'employee_tasks rows for this employee. A task counts as late only when it has '
        + 'BOTH a due date and a completion time and the second is more than a day after the first. '
        + 'A task with no due date is never late, because nobody said when it was due. There is no '
        + 'on-time percentage here: the denominator would silently include work whose scope changed.',
      inputs: [{ ownerModule: 'src/lib/employee-tasks.ts', table: 'employee_tasks', rowsRead: tasks.length }],
      evidence: closed.slice(0, 25).map((t: any) => ({
        recordId: 'employee_tasks:' + String(t.id),
        table: 'employee_tasks' as const,
        ownerModule: 'the task module',
        summary: 'Closed ' + dayOf(t.completed_at) + (t.due_on ? ', due ' + dayOf(t.due_on) : ', no due date') + '.',
        providedBy: 'this platform',
        assertion: 'factual' as const,
        occurredAt: iso(t.completed_at),
        href: null,
      })),
      decisionUse: 'supporting',
      actions: allowed(access, ['schedule_review', 'record_intervention']),
    }));
  } catch (e: any) {
    logFail('behaviour_trends:tasks', e);
    failures.push('recorded tasks (' + reasonOf(e) + ')');
  }

  if (!signals.length) {
    return section('behaviour_trends', 'unreadable',
      'Neither source behind this section could be read: ' + failures.join('; ') + '.', [], []);
  }

  return section('behaviour_trends', 'ready',
    'Counts of records over time. No location, no device, no login times, no messages and no '
      + 'monitoring of any kind reaches this section, and none of it is stored anywhere this module '
      + 'could reach.'
      + (failures.length ? ' Not everything could be read: ' + failures.join('; ') + '.' : ''),
    signals, allowed(access, ['record_intervention', 'schedule_review']));
}

// =================================================================================================
// SECTION 7 — PROMOTION READINESS
// =================================================================================================
//
// THERE IS NO READINESS SCORE AND THERE WILL NOT BE ONE.
//
// Promotion is one of the six decisions src/lib/ai-boundary.ts reserves for a named human. What
// this section produces is a list of NAMED CONDITIONS, each answered independently from a record
// that already exists, each carrying its own evidence, and each answerable with "nothing on
// record". A reader who wants a single number is being asked to read four rows instead, on purpose:
// a number would be the most persuasive thing on the screen and the least answerable.
//
// The section also shows what has already been RECOMMENDED and what a human already DECIDED, read
// from ai_recommendations and ai_human_decisions, so that a reader can see the boundary working
// rather than take its existence on trust.

async function buildPromotionReadiness(
  employeeId: string,
  emp: any,
  access: HrIntelAccess,
): Promise<HrSection> {
  const signals: HrSignal[] = [];
  const failures: string[] = [];

  // Condition: confirmed in role.
  const confirmed = !!emp?.confirmation_date;
  signals.push(hrSignal({
    id: 'promotion_readiness:confirmed',
    section: 'promotion_readiness',
    label: 'Confirmed in the current role',
    value: {
      kind: 'text', number: null, unit: null,
      display: confirmed
        ? 'Yes — confirmation recorded on ' + dayOf(emp.confirmation_date) + '.'
        : 'Not on record. No confirmation date is stored for this person.',
    },
    processing: 'hr_employees.confirmation_date is present or it is not. A missing date means '
      + 'nobody recorded a confirmation; it does not mean the person failed one.',
    inputs: [{ ownerModule: 'the people desk', table: 'hr_employees', rowsRead: 1 }],
    evidence: confirmed ? [{
      recordId: 'hr_employees:' + String(emp.id),
      table: 'hr_employees',
      ownerModule: 'the people desk',
      summary: 'Confirmation date ' + dayOf(emp.confirmation_date) + '.',
      providedBy: 'the people desk',
      assertion: 'provided',
      occurredAt: iso(emp.confirmation_date),
      href: '/admin/people/employees',
    }] : [],
    decisionUse: 'supporting',
    actions: [],
  }));

  // Condition: appraisal history and its outcomes.
  try {
    const reviews = rowsOf(await db.execute(sql`
      SELECT r.id, r.outcome, r.status, r.submitted_at, r.updated_at, r.proposed_designation,
             c.title AS cycle_title
        FROM hr_performance_reviews r
        LEFT JOIN hr_review_cycles c ON c.id = r.cycle_id
       WHERE r.employee_id = ${employeeId}
       ORDER BY COALESCE(r.submitted_at, r.updated_at) DESC
       LIMIT 30`));

    const completed = reviews.filter((r: any) => !!r.submitted_at || String(r.status) === 'complete');
    const recommended = reviews.filter((r: any) => String(r.outcome) === 'promotion_recommended');
    const exceeded = reviews.filter((r: any) => String(r.outcome) === 'exceeded');

    const evidence: EvidenceRef[] = reviews.slice(0, 25).map((r: any) => ({
      recordId: 'hr_performance_reviews:' + String(r.id),
      table: 'hr_performance_reviews',
      ownerModule: 'the appraisal module',
      summary: String(r.cycle_title || 'An appraisal cycle') + ' — outcome '
        + String(r.outcome || 'not recorded')
        + (r.proposed_designation ? ', proposed ' + String(r.proposed_designation) : '') + '.',
      providedBy: 'the reviewer who recorded the outcome',
      assertion: 'provided',
      occurredAt: iso(r.submitted_at || r.updated_at),
      href: '/admin/hr/performance',
    }));

    signals.push(hrSignal({
      id: 'promotion_readiness:appraisals',
      section: 'promotion_readiness',
      label: 'Completed appraisals, and what each concluded',
      value: {
        kind: 'count', number: completed.length, unit: 'appraisals',
        display: reviews.length === 0
          ? 'No appraisal is on record for this person.'
          : completed.length + ' completed appraisal(s). '
            + recommended.length + ' recorded a promotion recommendation, '
            + exceeded.length + ' recorded that expectations were exceeded.',
      },
      processing: 'hr_performance_reviews for this employee, counted by their `outcome` column, '
        + 'which is a word a named reviewer chose from a fixed list. RATINGS ARE NOT AVERAGED AND '
        + 'NOT SHOWN HERE: an average of numbers written by different people in different cycles '
        + 'against different expectations is not a measurement of anybody.',
      inputs: [{ ownerModule: 'src/lib/performance.ts', table: 'hr_performance_reviews', rowsRead: reviews.length }],
      evidence,
      decisionUse: 'supporting',
      actions: [],
    }));
  } catch (e: any) {
    logFail('promotion_readiness:appraisals', e);
    failures.push('appraisals (' + reasonOf(e) + ')');
  }

  // Condition: evidenced capability, from the module that owns evidence.
  try {
    const claims = rowsOf(await db.execute(sql`
      SELECT id, evidence_level, skill_id, updated_at
        FROM capability_claims
       WHERE subject_kind = 'employee' AND subject_id = ${employeeId}
       LIMIT 200`));
    const strong = claims.filter((c: any) => {
      const lv = String(c.evidence_level || '');
      return lv === 'demonstrated' || lv === 'professionally_demonstrated'
        || lv === 'production_demonstrated' || lv === 'externally_verified';
    });
    signals.push(hrSignal({
      id: 'promotion_readiness:evidenced_capability',
      section: 'promotion_readiness',
      label: 'Capabilities with evidence behind them',
      value: {
        kind: 'count', number: strong.length, unit: 'capabilities',
        display: claims.length === 0
          ? 'No capability claims exist for this person in the evidence graph.'
          : strong.length + ' of ' + claims.length + ' claim(s) are at demonstrated level or above.',
      },
      processing: 'capability_claims for this employee, counted by the evidence level the evidence '
        + 'graph CALCULATED from the rows behind each claim. No caller can pass a level in, here or '
        + 'anywhere: a keyword somebody typed stays at "claimed" forever until a fact this platform '
        + 'owns or a named human\'s written verdict moves it.',
      inputs: [{ ownerModule: 'src/lib/evidence-graph.ts', table: 'capability_claims', rowsRead: claims.length }],
      evidence: strong.slice(0, 25).map((c: any) => ({
        recordId: 'capability_claims:' + String(c.id),
        table: 'capability_claims' as const,
        ownerModule: 'the evidence graph',
        summary: 'A claim standing at ' + String(c.evidence_level) + '.',
        providedBy: 'the evidence graph, from the rows behind it',
        assertion: 'verified' as const,
        occurredAt: iso(c.updated_at),
        href: null,
      })),
      decisionUse: 'supporting',
      actions: [],
    }));
  } catch (e: any) {
    // capability_claims is created by evidence-graph's own bootstrap and can genuinely be absent.
    logFail('promotion_readiness:claims', e);
    failures.push('the evidence graph (' + reasonOf(e) + ')');
  }

  // What has already been recommended, and what a human already decided.
  try {
    const recs = rowsOf(await db.execute(sql`
      SELECT id, decision_kind, conclusion, produced_by, created_at
        FROM ai_recommendations
       WHERE subject_employee_id = ${employeeId}
       ORDER BY created_at DESC
       LIMIT 20`));
    const decs = rowsOf(await db.execute(sql`
      SELECT id, decision_kind, decided_at
        FROM ai_human_decisions
       WHERE subject_employee_id = ${employeeId}
       ORDER BY decided_at DESC
       LIMIT 20`));

    signals.push(hrSignal({
      id: 'promotion_readiness:boundary',
      section: 'promotion_readiness',
      label: 'What was recommended, and what a human decided',
      value: {
        kind: 'text', number: null, unit: null,
        display: recs.length + ' recommendation(s) stored about this person, and '
          + decs.length + ' recorded human decision(s). A recommendation is inert: there is no '
          + 'status on it and nothing in this system acts on one.',
      },
      processing: 'ai_recommendations and ai_human_decisions for this subject, counted separately '
        + 'and never joined into a single "outcome". The gap between the two counts is the point: '
        + 'a recommendation nobody decided on is a sentence somebody read.',
      inputs: [
        { ownerModule: 'src/lib/ai-boundary.ts', table: 'ai_recommendations', rowsRead: recs.length },
        { ownerModule: 'src/lib/ai-boundary.ts', table: 'ai_human_decisions', rowsRead: decs.length },
      ],
      evidence: recs.slice(0, 10).map((x: any) => ({
        recordId: 'ai_recommendations:' + String(x.id),
        table: 'ai_recommendations' as const,
        ownerModule: 'the AI boundary',
        summary: String(x.decision_kind) + ': ' + String(x.conclusion || '').slice(0, 180),
        providedBy: String(x.produced_by || 'a module'),
        assertion: 'calculated' as const,
        occurredAt: iso(x.created_at),
        href: null,
      })),
      decisionUse: 'not_a_decision_input',
      actions: [],
    }));
  } catch (e: any) {
    logFail('promotion_readiness:boundary', e);
    failures.push('the recommendation and decision log (' + reasonOf(e) + ')');
  }

  return section('promotion_readiness', signals.length ? 'ready' : 'unreadable',
    'These are separate conditions, not parts of a total. NOTHING HERE IS A READINESS SCORE, and '
      + 'nothing here promotes anybody: a promotion is decided by a named human and recorded by the '
      + 'employee-lifecycle module through the approval chain it already has. A reader is free to '
      + 'disagree with every line.'
      + (failures.length ? ' Not everything could be read: ' + failures.join('; ') + '.' : ''),
    signals, allowed(access, ['schedule_review', 'initiate_development_plan']));
}

// =================================================================================================
// SECTION 8 — INTERNAL MOBILITY
// =================================================================================================

async function buildMobility(
  employeeId: string,
  emp: any,
  access: HrIntelAccess,
): Promise<HrSection> {
  try {
    const held = rowsOf(await db.execute(sql`
      SELECT s.name AS skill_name
        FROM hr_employee_skills es
        JOIN hr_skills s ON s.id = es.skill_id
       WHERE es.employee_id = ${employeeId}
       LIMIT 200`));
    const heldNames = new Set(held.map((h: any) => String(h.skill_name || '').toLowerCase()));

    const roles = rowsOf(await db.execute(sql`
      SELECT id, title, skills, department_id::text AS department_id, level
        FROM roles
       WHERE is_open = true
       ORDER BY updated_at DESC
       LIMIT 60`));

    const scored = roles.map((r: any) => {
      const wanted: string[] = Array.isArray(r.skills) ? r.skills.map((s: any) => String(s)) : [];
      const covered = wanted.filter((w) => heldNames.has(w.toLowerCase()));
      return {
        id: String(r.id),
        title: String(r.title || 'Untitled role'),
        departmentId: r.department_id ? String(r.department_id) : null,
        wanted,
        covered,
        missing: wanted.filter((w) => !heldNames.has(w.toLowerCase())),
      };
    }).filter((r) => r.wanted.length > 0 && r.covered.length > 0)
      .sort((a, b) => b.covered.length - a.covered.length)
      .slice(0, 10);

    const existing = rowsOf(await db.execute(sql`
      SELECT id, role_id, role_title_snapshot, status, conclusion, created_at, concluded_at
        FROM hri_mobility_reviews
       WHERE employee_id = ${employeeId}
       ORDER BY created_at DESC
       LIMIT 20`));

    const signals: HrSignal[] = [];

    signals.push(hrSignal({
      id: 'mobility:candidate_roles',
      section: 'mobility',
      label: 'Open roles this person already has recorded skills for',
      value: {
        kind: 'count', number: scored.length, unit: 'roles',
        display: roles.length === 0
          ? 'There are no open roles in the catalogue.'
          : scored.length === 0
            ? 'No open role lists a skill this person has recorded in the matrix. That is a '
              + 'statement about what is written down, not about what they can do.'
            : scored.length + ' open role(s) list at least one skill this person has recorded: '
              + scored.slice(0, 5).map((r) => r.title + ' (' + r.covered.length + ' of ' + r.wanted.length + ')').join(', ') + '.',
      },
      processing: 'Open roles whose free-text skills list contains at least one name matching a '
        + 'skill in this person\'s matrix, case-insensitively, ordered by how many matched. THE '
        + 'ORDERING IS A COUNT OF MATCHED NAMES AND NOT A FIT SCORE: the two sides of this '
        + 'comparison have never shared a vocabulary, and a percentage over that gap would be '
        + 'keyword overlap wearing a number. A role is listed as a place to look, never as a '
        + 'conclusion, and nothing here moves anybody.',
      inputs: [
        { ownerModule: 'the hiring desk', table: 'roles', rowsRead: roles.length },
        { ownerModule: 'src/lib/skills.ts', table: 'hr_employee_skills', rowsRead: held.length },
      ],
      evidence: scored.slice(0, 10).map((r) => ({
        recordId: 'roles:' + r.id,
        table: 'roles' as const,
        ownerModule: 'the hiring desk',
        summary: r.title + ' — matched on ' + r.covered.slice(0, 6).join(', ')
          + (r.missing.length ? '; nothing recorded for ' + r.missing.slice(0, 6).join(', ') : '') + '.',
        providedBy: 'whoever wrote the role advert',
        assertion: 'provided' as const,
        occurredAt: null,
        href: '/admin/roles',
      })),
      confidence: {
        level: 'low',
        why: 'A name match between a job advert\'s free text and a skill catalogue. It narrows where '
          + 'to look and settles nothing.',
      },
      decisionUse: 'advisory',
      actions: allowed(access, ['initiate_mobility_review']),
    }));

    if (existing.length) {
      signals.push(hrSignal({
        id: 'mobility:reviews',
        section: 'mobility',
        label: 'Mobility reviews already opened',
        value: {
          kind: 'count', number: existing.length, unit: 'reviews',
          display: existing.length + ' review(s), of which '
            + existing.filter((x: any) => String(x.status) === 'concluded').length + ' have a written conclusion.',
        },
        processing: 'hri_mobility_reviews for this employee. A conclusion is free text a named human '
          + 'wrote; there is no verdict field and no status this system reached by itself.',
        inputs: [{ ownerModule: 'this module', table: 'hri_mobility_reviews', rowsRead: existing.length }],
        evidence: existing.slice(0, 20).map((x: any) => ({
          recordId: 'hri_mobility_reviews:' + String(x.id),
          table: 'hri_mobility_reviews' as const,
          ownerModule: 'the HR intelligence view',
          summary: String(x.role_title_snapshot || 'a role') + ' — ' + String(x.status)
            + (x.conclusion ? ': ' + String(x.conclusion).slice(0, 160) : ', no conclusion written yet') + '.',
          providedBy: 'the people desk',
          assertion: 'provided' as const,
          occurredAt: iso(x.concluded_at || x.created_at),
          href: null,
        })),
        decisionUse: 'not_a_decision_input',
        actions: [],
      }));
    }

    return section('mobility', 'ready',
      'Roles are listed as places to look. Opening a review records that somebody is looking; it '
        + 'moves nobody, notifies nobody, and a transfer remains a separate act through the '
        + 'approval chain that already owns it.',
      signals, allowed(access, ['initiate_mobility_review']));
  } catch (e: any) {
    logFail('mobility', e);
    return unreadableSection('mobility', e);
  }
}

// =================================================================================================
// SECTION 9 — INTERVENTION HISTORY
// =================================================================================================

async function buildInterventions(employeeId: string, access: HrIntelAccess): Promise<HrSection> {
  try {
    const rows = rowsOf(await db.execute(sql`
      SELECT id, kind, summary, prompted_by, recorded_by_name, occurred_on,
             outcome_note, outcome_recorded_at, plan_id, created_at
        FROM hri_interventions
       WHERE employee_id = ${employeeId}
       ORDER BY occurred_on DESC
       LIMIT 100`));

    const plans = rowsOf(await db.execute(sql`
      SELECT id, title, status, reason, target_on, opened_by_name, created_at, closed_at
        FROM hri_development_plans
       WHERE employee_id = ${employeeId}
       ORDER BY created_at DESC
       LIMIT 40`));

    const withOutcome = rows.filter((r: any) => !!r.outcome_recorded_at);

    const signals: HrSignal[] = [];

    signals.push(hrSignal({
      id: 'interventions:history',
      section: 'interventions',
      label: 'Support steps recorded, and how many have an outcome written',
      value: {
        kind: 'count', number: rows.length, unit: 'interventions',
        display: rows.length === 0
          ? 'No intervention has been recorded for this person.'
          : rows.length + ' intervention(s), of which ' + withOutcome.length
            + ' have an outcome recorded afterwards.',
      },
      processing: 'hri_interventions for this employee. THE OUTCOME IS A SEPARATE, LATER WRITE — '
        + 'the gap between the two counts is how many support steps nobody came back to. An '
        + 'intervention here is a support step: a conversation, a mentor, a workload change, a '
        + 'referral to training. It is NOT a disciplinary record; those live in the flags module '
        + 'with their own appeal path and are not read here.',
      inputs: [{ ownerModule: 'this module', table: 'hri_interventions', rowsRead: rows.length }],
      evidence: rows.slice(0, 30).map((r: any) => ({
        recordId: 'hri_interventions:' + String(r.id),
        table: 'hri_interventions' as const,
        ownerModule: 'the HR intelligence view',
        summary: String(r.kind) + ' on ' + dayOf(r.occurred_on) + ' — ' + String(r.summary || '').slice(0, 160)
          + (r.outcome_note ? ' Outcome: ' + String(r.outcome_note).slice(0, 120) : ' No outcome recorded yet.'),
        providedBy: r.recorded_by_name ? String(r.recorded_by_name) : 'the people desk',
        assertion: 'provided' as const,
        occurredAt: iso(r.occurred_on),
        href: null,
      })),
      decisionUse: 'supporting',
      actions: allowed(access, ['record_intervention']),
    }));

    signals.push(hrSignal({
      id: 'interventions:plans',
      section: 'interventions',
      label: 'Development plans opened',
      value: {
        kind: 'count', number: plans.length, unit: 'plans',
        display: plans.length === 0
          ? 'No development plan has been opened for this person.'
          : plans.length + ' plan(s), of which '
            + plans.filter((p: any) => String(p.status) === 'completed').length + ' are recorded as complete.',
      },
      processing: 'hri_development_plans for this employee. A plan is a shared record between the '
        + 'employee, whoever answers for their work and the people desk — not a personnel file '
        + 'about them.',
      inputs: [{ ownerModule: 'this module', table: 'hri_development_plans', rowsRead: plans.length }],
      evidence: plans.slice(0, 20).map((p: any) => ({
        recordId: 'hri_development_plans:' + String(p.id),
        table: 'hri_development_plans' as const,
        ownerModule: 'the HR intelligence view',
        summary: String(p.title) + ' — ' + String(p.status)
          + (p.target_on ? ', target ' + dayOf(p.target_on) : '') + '.',
        providedBy: p.opened_by_name ? String(p.opened_by_name) : 'the people desk',
        assertion: 'provided' as const,
        occurredAt: iso(p.created_at),
        href: null,
      })),
      decisionUse: 'not_a_decision_input',
      actions: allowed(access, ['initiate_development_plan']),
    }));

    return section('interventions', rows.length || plans.length ? 'ready' : 'empty',
      rows.length || plans.length
        ? 'What was done, who did it, and what followed. An intervention with no outcome recorded is '
          + 'shown as exactly that rather than assumed to have worked.'
        : 'Nothing has been recorded. That is a real answer, and on a person with development needs '
          + 'above it is usually the finding worth acting on.',
      signals, allowed(access, ['record_intervention', 'initiate_development_plan']));
  } catch (e: any) {
    logFail('interventions', e);
    return unreadableSection('interventions', e);
  }
}

// =================================================================================================
// SECTION 10 — ORGANISATIONAL DEVELOPMENT ACTIONS
// =================================================================================================
//
// THE ONLY SECTION THAT IS NOT ABOUT ONE PERSON, and the only one with a suppression rule.
//
// It answers "is this a person problem or a team problem", which is the question that stops an
// individual development plan being opened for something structural. Every figure is a count across
// the person's department, and any group below MIN_GROUP is withheld with its label — the same
// threshold and the same reasoning the workforce analytics module already applies, imported from
// it rather than restated, because two different minimums is how one screen leaks what the other
// suppresses.
//
// In a department of three, "two people have overdue learning" is not a statistic. It is a
// description of two named colleagues.

async function buildOrgDevelopment(emp: any): Promise<HrSection> {
  const departmentId = emp?.department_id ? String(emp.department_id) : null;
  if (!departmentId) {
    return section('org_development', 'empty',
      'This person has no department recorded, so there is no group to compare against. Nothing '
        + 'was read.',
      [], []);
  }

  try {
    const sizeRows = rowsOf(await db.execute(sql`
      SELECT COUNT(*)::int AS n
        FROM hr_employees
       WHERE department_id::text = ${departmentId} AND is_active = true`));
    const size = Number((sizeRows[0] as any)?.n || 0);

    if (size < MIN_GROUP) {
      return section('org_development', 'empty',
        'This department has fewer than ' + MIN_GROUP + ' active people, so every figure across it '
          + 'would describe named colleagues rather than a group. Nothing is shown, and the total '
          + 'is withheld with it so the missing numbers cannot be worked back out.',
        [], []);
    }

    const rows = rowsOf(await db.execute(sql`
      SELECT
        (SELECT COUNT(DISTINCT a.employee_id)::int
           FROM hr_learning_assignments a
           JOIN hr_employees e2 ON e2.id = a.employee_id
          WHERE e2.department_id::text = ${departmentId}
            AND e2.is_active = true
            AND a.due_on IS NOT NULL AND a.due_on < CURRENT_DATE
            AND a.status <> 'completed') AS overdue_people,
        (SELECT COUNT(DISTINCT r.employee_id)::int
           FROM hr_performance_reviews r
           JOIN hr_employees e3 ON e3.id = r.employee_id
          WHERE e3.department_id::text = ${departmentId}
            AND e3.is_active = true
            AND r.outcome = 'needs_support') AS needs_support_people`));
    const agg: any = rows[0] || {};
    const overdue = Number(agg.overdue_people || 0);
    const needsSupport = Number(agg.needs_support_people || 0);

    const input: SignalInput = {
      ownerModule: 'the people desk',
      table: 'hr_employees',
      rowsRead: size,
    };

    const signals: HrSignal[] = [
      hrSignal({
        id: 'org_development:overdue',
        section: 'org_development',
        label: 'People in this department with learning past its due date',
        value: {
          kind: 'count', number: overdue, unit: 'people',
          display: overdue + ' of ' + size + ' active people in this department have assigned '
            + 'learning past its due date.',
        },
        processing: 'Distinct employees in the same department with at least one overdue, '
          + 'incomplete assignment. Counted only because the department has at least ' + MIN_GROUP
          + ' active people. NO NAMES ARE READ and no row-per-person query is issued: this is a '
          + 'count, and a drill-down to who they are is deliberately not offered here.',
        inputs: [input, { ownerModule: 'src/lib/performance-learning.ts', table: 'hr_learning_assignments', rowsRead: overdue }],
        evidence: [],
        confidence: {
          level: 'moderate',
          why: 'A count over records this platform owns, across a group large enough to be a group.',
        },
        decisionUse: 'advisory',
        actions: [],
      }),
      hrSignal({
        id: 'org_development:needs_support',
        section: 'org_development',
        label: 'People in this department whose appraisal recorded a need for support',
        value: {
          kind: 'count', number: needsSupport, unit: 'people',
          display: needsSupport + ' of ' + size + ' active people in this department have an '
            + 'appraisal outcome recording a need for support.',
        },
        processing: 'Distinct employees in the same department with at least one appraisal outcome '
          + 'of "needs_support", at any time. If this number is high, an individual development '
          + 'plan may be answering a structural question with a personal one — which is the reason '
          + 'this section sits on a screen about one person.',
        inputs: [input, { ownerModule: 'src/lib/performance.ts', table: 'hr_performance_reviews', rowsRead: needsSupport }],
        evidence: [],
        confidence: {
          level: 'moderate',
          why: 'A count over records this platform owns, across a group large enough to be a group.',
        },
        decisionUse: 'advisory',
        actions: [],
      }),
    ];

    return section('org_development', 'ready',
      'Counts across this person\'s department, never a list of who. Groups below ' + MIN_GROUP
        + ' are withheld entirely, because in a small team a count is a description of named people.',
      signals, []);
  } catch (e: any) {
    logFail('org_development', e);
    return unreadableSection('org_development', e);
  }
}

// =================================================================================================
// THE FOUNDATIONAL TIER
// =================================================================================================

async function readFoundational(
  employeeId: string,
  access: HrIntelAccess,
  purpose: string,
): Promise<FoundationalResult> {
  if (access.depth !== 'foundational') {
    return { state: 'not_permitted', sentence: access.depthReason + ' ' + FOUNDATIONAL_WITHHELD_SENTENCE };
  }
  const provider = foundationalProvider();
  if (!provider) {
    return {
      state: 'no_provider',
      sentence: 'No foundational computation provider is registered on this platform, so there is '
        + 'nothing to read. This is the state the platform ships in, and the section exists so the '
        + 'boundary around it is real rather than theoretical.',
    };
  }
  if (!access.consentRecordId) {
    return {
      state: 'no_consent',
      sentence: 'The depth was resolved without a consent record id, which should not happen. '
        + 'Nothing was read.',
    };
  }
  try {
    const reading = await provider.read({
      employeeId,
      purpose,
      consentRecordId: access.consentRecordId,
    });
    // A provider that returns a reading which does not carry its own subordination or its own
    // disclaimer is REFUSED here rather than rendered. The type says it must; this checks it.
    if (reading.state === 'ready') {
      const r = reading.reading;
      if (r.notScientificFact !== true) {
        return {
          state: 'no_provider',
          sentence: 'The registered provider returned a reading that does not carry the statement '
            + 'that it is not established scientific fact. It was refused rather than rendered.',
        };
      }
      if (!Array.isArray(r.subordinateTo) || r.subordinateTo.length === 0) {
        return {
          state: 'no_provider',
          sentence: 'The registered provider returned a reading that does not name the demonstrated '
            + 'evidence which outranks it. A reading that cannot say what outweighs it is not shown.',
        };
      }
    }
    return reading;
  } catch (e: any) {
    logFail('foundational', e);
    return {
      state: 'no_provider',
      sentence: 'The registered provider failed: ' + reasonOf(e) + '. Nothing was read.',
    };
  }
}

// =================================================================================================
// THE ASSEMBLY
// =================================================================================================

/**
 * Assemble the HR intelligence view for one person.
 *
 * The access decision and the access row are BOTH required arguments and neither is resolved here:
 * a builder that could also decide who may read it is a builder that will eventually be called
 * without deciding.
 */
export async function buildHrIntelligence(input: BuildInput): Promise<HrIntelligence> {
  const employeeId = String(input.employeeId || '');
  const access = input.access;
  const assembledAt = new Date().toISOString();
  const unreadable: string[] = [];

  if (!isUuid(employeeId)) {
    throw new Error('buildHrIntelligence needs an hr_employees id.');
  }
  if (!access?.mayOpen) {
    throw new Error('buildHrIntelligence was called without a granted access decision. Resolve '
      + 'access first; this function does not decide who may read.');
  }
  if (!input.accessRecordId) {
    throw new Error('buildHrIntelligence was called without an access log row. The read is not '
      + 'assembled until the access has been recorded.');
  }

  const has = (k: SectionKey) => access.granted.indexOf(k) >= 0;
  const why = (k: SectionKey) =>
    access.withheld.find((w) => w.section === k)?.because || 'Withheld.';

  // The employment row is read once and passed down: three sections need it and three round trips
  // for one row is the pattern this project has already paid for.
  let emp: any = null;
  try {
    const r = await db.execute(sql`
      SELECT id, full_name, designation, department_id::text AS department_id, employment_type,
             work_mode, employment_status, onboarding_status, joining_date, probation_end_date,
             confirmation_date, is_active
        FROM hr_employees
       WHERE id = ${employeeId}
       LIMIT 1`);
    emp = rowsOf(r)[0] || null;
  } catch (e: any) {
    logFail('employee', e);
    unreadable.push('the employment record (' + reasonOf(e) + ')');
  }

  const designation = emp?.designation ? String(emp.designation) : null;

  // The gap names the training section matches on come from the skills section, so the skills read
  // happens first and its result is reused rather than repeated.
  let gapNames: string[] = [];
  if (has('skill_gaps') || has('training')) {
    try {
      const low = rowsOf(await db.execute(sql`
        SELECT s.name AS skill_name
          FROM hr_employee_skills es
          JOIN hr_skills s ON s.id = es.skill_id
         WHERE es.employee_id = ${employeeId} AND es.level <= 1
         ORDER BY s.name ASC
         LIMIT 20`));
      gapNames = low.map((x: any) => String(x.skill_name)).filter(Boolean);
    } catch (e: any) {
      logFail('gapNames', e);
    }
  }

  const built = await Promise.all([
    has('role_status') ? buildRoleStatus(employeeId, access) : Promise.resolve(withheldSection('role_status', why('role_status'))),
    has('development_needs') ? buildDevelopmentNeeds(employeeId, access) : Promise.resolve(withheldSection('development_needs', why('development_needs'))),
    has('skill_gaps') ? buildSkillGaps(employeeId, designation, access) : Promise.resolve(withheldSection('skill_gaps', why('skill_gaps'))),
    has('training') ? buildTraining(employeeId, gapNames, access) : Promise.resolve(withheldSection('training', why('training'))),
    has('feedback') ? buildFeedback(employeeId, access) : Promise.resolve(withheldSection('feedback', why('feedback'))),
    has('behaviour_trends') ? buildBehaviourTrends(employeeId, access) : Promise.resolve(withheldSection('behaviour_trends', why('behaviour_trends'))),
    has('promotion_readiness') ? buildPromotionReadiness(employeeId, emp, access) : Promise.resolve(withheldSection('promotion_readiness', why('promotion_readiness'))),
    has('mobility') ? buildMobility(employeeId, emp, access) : Promise.resolve(withheldSection('mobility', why('mobility'))),
    has('interventions') ? buildInterventions(employeeId, access) : Promise.resolve(withheldSection('interventions', why('interventions'))),
    has('org_development') ? buildOrgDevelopment(emp) : Promise.resolve(withheldSection('org_development', why('org_development'))),
  ]);

  // Rendered in the declared order, never in the order the queries happened to finish.
  const byKey = new Map<SectionKey, HrSection>();
  for (const s of built) byKey.set(s.key, s);
  const sections = SECTION_KEYS.map((k) => byKey.get(k)).filter(Boolean) as HrSection[];

  for (const s of sections) {
    if (s.state === 'unreadable') unreadable.push(sectionLabel(s.key));
  }

  const allSignals = sortByWeight(sections.flatMap((s) => s.signals));
  const foundational = await readFoundational(employeeId, access, input.purpose);

  return {
    employeeId,
    displayName: emp?.full_name ? String(emp.full_name) : null,
    designation,
    departmentId: emp?.department_id ? String(emp.department_id) : null,
    sections,
    allSignals,
    access,
    accessRecordId: input.accessRecordId,
    foundational,
    assembledAt,
    unreadable,
  };
}
