// src/lib/capability-coverage.ts — WHAT A JOB ASKS FOR, AGAINST WHAT A PERSON HAS EVIDENCED.
//
// =================================================================================================
// THIS IS NOT A MATCH SCORE, AND IT REFUSES TO BECOME ONE
// =================================================================================================
//
// There is no candidate-to-job matching anywhere in this repository today — not keyword, not
// semantic, not any. That is a good position to be starting from, because the fastest way to violate
// "never treat a keyword as proof of competence" would be to build a percentage out of
// `roles.skills` (a jsonb array of free strings authored per role) against `applications.tech_skills`
// (a jsonb blob a candidate typed). Keyword overlap wearing a percentage is still keyword overlap,
// and a number on a hiring screen is the most load-bearing thing on it.
//
// So this module produces a COVERAGE VIEW: per requirement, one of a small number of named states,
// each carrying the full evidence chain behind it. It deliberately does NOT total them.
// coverageFor() returns `refusesTotal` with the sentence explaining why, and there is no function in
// this file that returns a single number about a person. If somebody adds one, they will have to add
// it deliberately, in a new function, past this comment.
//
// =================================================================================================
// THE FOUR STATES, AND THE ONE THAT MATTERS MOST
// =================================================================================================
//
//   evidenced   A checked record: a course completion or a passed assessment on this platform,
//               re-read at write time through the module that owns it (src/lib/skills.ts refuses an
//               evidence reference that does not confirm). This is the only state that demonstrates
//               anything.
//   stated      Somebody said so. A self-recorded level, a manager's assessment, or a keyword on a
//               form. All three are honest records of a statement and NONE of them is proof. A skill
//               on a CV is claimed, not demonstrated, and this state exists so a screen can say that
//               in those words instead of showing a number.
//   related     Nothing directly, but the person holds a skill the graph relates to this one, in the
//               direction that supports it. ALWAYS inferred — the edge is a human's curation and
//               nobody measured it.
//   nothing     Nothing on record. Which is a statement about OUR RECORDS and not about the person,
//               and every screen that renders it says so.
//
// Plus `unreadable`, because a read that failed must never render as a gap. A candidate shown as
// missing a requirement because a pooler timed out is a person harmed by an outage.
//
// AN UNRECORDED SKILL IS INDISTINGUISHABLE FROM AN ABSENT ONE. That sentence appears in the
// uncertainty of every single row, because it is true of every single row, and it is the thing a
// reader most needs to keep in mind while looking at a column of "nothing on record".
//
// =================================================================================================
// WHY THE PERSON ROOT IS LOAD-BEARING HERE
// =================================================================================================
//
// A candidate has no hr_employee_skills rows, because those are keyed on hr_employees.id. Until the
// person spine existed there was no path from an application to anything a person had demonstrated
// on this platform — the candidate's assessment attempts and the employee's evidenced skills were
// two islands with an email address between them. subjectFor() resolves the person root first, and
// reads evidence through EVERY surface a named human has linked to it. That is what the spine buys,
// and it is why this module reads person-spine.ts rather than following hr_employees.application_id
// backwards by itself.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { logAudit } from '@/lib/audit';
import { ensurePerformanceSchema } from '@/lib/performance-schema';
import { rowsOf, logFail, isUuid, clean, uuidList } from '@/lib/performance-scope';
import { ensureSpineSchema, personFor, employeeIdForPerson, readSentence, type Read } from '@/lib/person-spine';
import { relatedTo } from '@/lib/skill-graph';
import { getCertificatesForUser } from '@/lib/certificates';
import { passedAssessmentsFor } from '@/lib/learning-doors';
import {
  assertionForSkillSource,
  skillSourceActor,
  chainAssertion,
  protectedAttributeConcern,
  type AssertionType,
  type EvidenceChain,
  type EvidenceCitation,
} from '@/lib/person-assertions';
import { SKILL_LEVEL_LABELS } from '@/lib/skills';

const MOD = 'capability-coverage';
const WRITE_FAILED = 'We could not save that just now. Nothing was changed.';

/** Said on every row, because it is true on every row. */
const UNRECORDED_CAVEAT =
  'An unrecorded skill looks exactly like an absent one. This describes our records, not this person.';

// -------------------------------------------------------------------------------------------------
// WHAT A JOB ASKS FOR
// -------------------------------------------------------------------------------------------------

export const NECESSITY = ['essential', 'important', 'helpful'] as const;
export type Necessity = (typeof NECESSITY)[number];

export function isNecessity(v: unknown): v is Necessity {
  return typeof v === 'string' && (NECESSITY as readonly string[]).indexOf(v) >= 0;
}

export const NECESSITY_LABELS: Record<string, string> = {
  essential: 'Essential',
  important: 'Important',
  helpful: 'Helpful',
};

export interface Requirement {
  id: string;
  roleId: string;
  skillId: string;
  skillName: string;
  necessity: Necessity;
  minLevel: number | null;
  sourceText: string | null;
  assertion: AssertionType;
  basis: string;
}

function mapRequirement(r: any): Requirement {
  return {
    id: String(r?.id ?? ''),
    roleId: String(r?.role_id ?? ''),
    skillId: String(r?.skill_id ?? ''),
    skillName: r?.skill_name ? String(r.skill_name) : 'A retired skill',
    necessity: (isNecessity(r?.necessity) ? r.necessity : 'important') as Necessity,
    minLevel: r?.min_level === null || r?.min_level === undefined ? null : Number(r.min_level),
    sourceText: r?.source_text ? String(r.source_text) : null,
    assertion: (String(r?.assertion_type || 'explicitly_provided') as AssertionType),
    basis: r?.basis ? String(r.basis) : 'No basis was recorded.',
  };
}

/** The requirements a human has authored for this job, in the catalogue's vocabulary. */
export async function requirementsFor(roleId: string): Promise<Read<Requirement[]>> {
  if (!isUuid(roleId)) return { state: 'unreadable', sentence: 'That job was not named properly.', data: [] };
  try {
    await ensurePerformanceSchema();
    await ensureSpineSchema();
    const rows = rowsOf(await db.execute(sql`
      SELECT r.*, s.name AS skill_name
        FROM hr_role_requirements r
        LEFT JOIN hr_skills s ON s.id = r.skill_id
       WHERE r.role_id = ${roleId}::uuid
       ORDER BY CASE r.necessity WHEN 'essential' THEN 1 WHEN 'important' THEN 2 ELSE 3 END, s.name ASC
       LIMIT 200`));
    const data = rows.map(mapRequirement);
    return {
      state: data.length ? 'ok' : 'not_configured',
      sentence: data.length ? '' : 'This job has no requirements expressed in the skill catalogue yet, so there is '
        + 'nothing to compare anybody against. The job description almost certainly lists skills as free text; '
        + 'those are words, and words on two different forms cannot be compared honestly. Map them below first.',
      data,
    };
  } catch (e: any) {
    logFail(MOD, 'requirementsFor', e);
    return { state: 'unreadable', sentence: readSentence('unreadable', 'job requirements'), data: [] };
  }
}

export interface RequirementProposal {
  /** The exact string from roles.skills. */
  text: string;
  /** The catalogue skill it appears to name, when one matches. */
  skillId: string | null;
  skillName: string | null;
  /** How the match was made, for the screen to print beside the confirm control. */
  basis: string;
  /** Already a requirement on this job. */
  already: boolean;
}

/**
 * Turn the job description's free-text skill list into PROPOSALS against the catalogue.
 *
 * MATCHED ON THE NAME, CASE-INSENSITIVELY, AND ON NOTHING ELSE. No stemming, no fuzzy distance, no
 * embedding. A fuzzy matcher here would quietly map "React" to "Reactive systems" and nobody would
 * ever find out, because the only visible symptom is a candidate who looked slightly worse than they
 * were. An exact match either happens or it does not, and everything that does not match is REPORTED
 * as unmatched rather than dropped.
 *
 * NOTHING IS APPLIED. A human confirms each one, and the stored requirement records that they did.
 */
export async function proposeRequirements(roleId: string): Promise<Read<RequirementProposal[]>> {
  if (!isUuid(roleId)) return { state: 'unreadable', sentence: 'That job was not named properly.', data: [] };
  try {
    await ensurePerformanceSchema();
    await ensureSpineSchema();
    const role = rowsOf(await db.execute(sql`
      SELECT skills::text AS skills FROM roles WHERE id = ${roleId}::uuid LIMIT 1`));
    if (!role.length) return { state: 'empty', sentence: 'That job does not exist.', data: [] };

    let words: string[] = [];
    try {
      const parsed = JSON.parse(String(role[0].skills || '[]'));
      if (Array.isArray(parsed)) words = parsed.map((w) => String(w || '').trim()).filter(Boolean).slice(0, 100);
    } catch {
      // A malformed jsonb blob is a data problem, not a reason to render an empty page as "no skills".
      return {
        state: 'unreadable',
        sentence: 'The skills list on this job could not be read as a list, so nothing is proposed. That is a '
          + 'problem with the job record rather than with the catalogue.',
        data: [],
      };
    }
    if (!words.length) {
      return { state: 'empty', sentence: 'This job description lists no skills at all, so there is nothing to map.', data: [] };
    }

    const catalogue = rowsOf(await db.execute(sql`
      SELECT id::text AS id, name, lower(name) AS lname FROM hr_skills WHERE is_active = true LIMIT 1000`));
    const byName = new Map<string, { id: string; name: string }>();
    for (const c of catalogue) byName.set(String(c.lname), { id: String(c.id), name: String(c.name) });

    const existing = rowsOf(await db.execute(sql`
      SELECT skill_id::text AS skill_id FROM hr_role_requirements WHERE role_id = ${roleId}::uuid`));
    const have = new Set(existing.map((r: any) => String(r.skill_id)));

    const data: RequirementProposal[] = words.map((text) => {
      const hit = byName.get(text.toLowerCase());
      return {
        text,
        skillId: hit ? hit.id : null,
        skillName: hit ? hit.name : null,
        basis: hit
          ? 'The job description lists "' + text + '", which is the exact name of a skill in the catalogue.'
          : 'The job description lists "' + text + '", and no skill in the catalogue has that name. Add the skill '
            + 'to the catalogue first, or map this line to an existing skill by hand.',
        already: hit ? have.has(hit.id) : false,
      };
    });

    return { state: 'ok', sentence: '', data };
  } catch (e: any) {
    logFail(MOD, 'proposeRequirements', e);
    return { state: 'unreadable', sentence: readSentence('unreadable', 'job description'), data: [] };
  }
}

export interface CoverageWriteResult {
  ok: boolean;
  id?: string;
  error?: string;
  /** A non-blocking warning the screen prints beside the success message. */
  warning?: string;
}

/** Attach a requirement to a job. Refuses anything that names a protected or sensitive attribute. */
export async function setRequirement(input: {
  roleId: string;
  skillId: string;
  necessity: Necessity;
  minLevel?: number | null;
  sourceText?: string | null;
  actorUserId: string;
}): Promise<CoverageWriteResult> {
  const roleId = String(input?.roleId || '');
  const skillId = String(input?.skillId || '');
  const necessity = isNecessity(input?.necessity) ? input.necessity : 'important';
  const actor = isUuid(input?.actorUserId) ? String(input.actorUserId) : null;
  const sourceText = clean(input?.sourceText, 300) || null;
  const rawLevel = Number(input?.minLevel);
  const minLevel = isFinite(rawLevel) && rawLevel >= 1 && rawLevel <= 5 ? Math.round(rawLevel) : null;

  if (!isUuid(roleId) || !isUuid(skillId)) return { ok: false, error: 'Choose a job and a skill.' };
  if (!actor) return { ok: false, error: 'We could not tell who is making this change, so nothing was written.' };

  try {
    await ensurePerformanceSchema();
    await ensureSpineSchema();
    const s = rowsOf(await db.execute(sql`SELECT name FROM hr_skills WHERE id = ${skillId}::uuid LIMIT 1`));
    if (!s.length) return { ok: false, error: 'That skill is not in the catalogue.' };
    const skillName = String(s[0].name || '');

    // THE SEAM GUARD. A job requirement is the definition of a decision variable: it is the thing a
    // person is compared against. A protected attribute must never be one, so it is refused here
    // rather than noticed later.
    const concern = protectedAttributeConcern(skillName);
    if (concern.level === 'refuse') return { ok: false, error: concern.sentence };

    const rows = rowsOf(await db.execute(sql`
      INSERT INTO hr_role_requirements
        (role_id, skill_id, necessity, min_level, source_text, assertion_type, basis, created_by_user_id)
      VALUES
        (${roleId}::uuid, ${skillId}::uuid, ${String(necessity)}, ${minLevel}::int, ${sourceText}::text,
         'explicitly_provided',
         ${'Mapped to the catalogue by a named person on the job requirements screen'
           + (sourceText ? ', from the job description line "' + sourceText + '".' : '.')},
         ${actor}::uuid)
      ON CONFLICT (role_id, skill_id) DO UPDATE
        SET necessity = EXCLUDED.necessity,
            min_level = EXCLUDED.min_level,
            source_text = COALESCE(EXCLUDED.source_text, hr_role_requirements.source_text),
            basis = EXCLUDED.basis,
            created_by_user_id = EXCLUDED.created_by_user_id
      RETURNING id::text AS id`));
    if (!rows.length) return { ok: false, error: WRITE_FAILED };

    await logAudit({
      userId: actor,
      action: 'role.requirement.set',
      entity: 'hr_role_requirements',
      entityId: String(rows[0].id),
      diff: { roleId, skillId, skillName, necessity, minLevel },
    });
    return {
      ok: true,
      id: String(rows[0].id),
      warning: concern.level === 'review' ? concern.sentence : undefined,
    };
  } catch (e: any) {
    logFail(MOD, 'setRequirement', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

export async function removeRequirement(requirementId: string, actorUserId: string): Promise<CoverageWriteResult> {
  if (!isUuid(requirementId)) return { ok: false, error: 'That requirement does not exist.' };
  const actor = isUuid(actorUserId) ? String(actorUserId) : null;
  if (!actor) return { ok: false, error: 'We could not tell who is making this change, so nothing was written.' };
  try {
    await ensureSpineSchema();
    const rows = rowsOf(await db.execute(sql`
      DELETE FROM hr_role_requirements WHERE id = ${requirementId}::uuid
      RETURNING role_id::text AS role_id, skill_id::text AS skill_id`));
    if (!rows.length) return { ok: false, error: 'That requirement does not exist.' };
    await logAudit({
      userId: actor,
      action: 'role.requirement.remove',
      entity: 'hr_role_requirements',
      entityId: requirementId,
      diff: { roleId: String(rows[0].role_id), skillId: String(rows[0].skill_id) },
    });
    return { ok: true, id: requirementId };
  } catch (e: any) {
    logFail(MOD, 'removeRequirement', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

// -------------------------------------------------------------------------------------------------
// WHO IS BEING LOOKED AT
// -------------------------------------------------------------------------------------------------

export interface CoverageSubject {
  kind: 'employee' | 'application';
  id: string;
  name: string;
  /** The employee record, when one is linked. Null means no employee record is linked, not "not an employee". */
  employeeId: string | null;
  /** The login, which is also the learner account. See the header of person-spine.ts. */
  userId: string | null;
  personId: string | null;
  /** How the surfaces above were reached, in a sentence the screen prints. */
  resolution: string;
}

/**
 * Resolve every surface of one human, from whichever one the caller has.
 *
 * THE PERSON ROOT FIRST, THE STORED POINTER SECOND. When a human has linked the records, this reads
 * the link. When nobody has, it falls back to the unenforced pointer columns and SAYS SO in
 * `resolution`, because a fallback that renders identically to a confirmed link is a fallback that
 * gets trusted like one.
 */
export async function subjectFor(kind: 'employee' | 'application', id: string): Promise<Read<CoverageSubject | null>> {
  if ((kind !== 'employee' && kind !== 'application') || !isUuid(id)) {
    return { state: 'unreadable', sentence: 'That record was not named properly.', data: null };
  }
  try {
    await ensureSpineSchema();
    const person = await personFor(kind, id);
    if (person.state === 'unreadable') {
      return { state: 'unreadable', sentence: person.sentence, data: null };
    }
    const personId = person.data ? person.data.id : null;

    let name = 'Unnamed record';
    let employeeId: string | null = null;
    let userId: string | null = null;
    let resolution = '';

    if (kind === 'employee') {
      const r = rowsOf(await db.execute(sql`
        SELECT full_name, user_id::text AS user_id FROM hr_employees WHERE id = ${id}::uuid LIMIT 1`));
      if (!r.length) return { state: 'empty', sentence: 'That employee record does not exist.', data: null };
      name = String(r[0].full_name || 'Unnamed record');
      employeeId = id;
      userId = r[0].user_id ? String(r[0].user_id) : null;
      resolution = personId
        ? 'This employee record is linked to a person record, so evidence from every linked surface is read.'
        : 'This employee record is not linked to a person record. Only what is attached to the employee record '
          + 'itself is read, and anything from an earlier application is invisible here.';
    } else {
      const r = rowsOf(await db.execute(sql`
        SELECT first_name, last_name, applicant_user_id::text AS applicant_user_id
          FROM applications WHERE id = ${id}::uuid LIMIT 1`));
      if (!r.length) return { state: 'empty', sentence: 'That application does not exist.', data: null };
      name = String((r[0].first_name || '') + ' ' + (r[0].last_name || '')).trim() || 'Unnamed applicant';
      userId = r[0].applicant_user_id ? String(r[0].applicant_user_id) : null;
      if (personId) {
        employeeId = await employeeIdForPerson(personId);
        resolution = employeeId
          ? 'This application is linked to a person who also has an employee record, so what they have evidenced '
            + 'as an employee is read here. Without that link it would be invisible.'
          : 'This application is linked to a person record, but no employee record is linked to that person, so '
            + 'there are no recorded skill levels to read.';
      } else {
        resolution = 'This application is not linked to a person record. Nothing this candidate may have '
          + 'evidenced elsewhere on the platform can be read, and that is a gap in our records rather than in them.';
      }
    }

    // The person's own display name is not overwritten by the record's — a person record exists
    // precisely because one human can be named three different ways across three forms.
    if (person.data && person.data.displayName) name = person.data.displayName;

    return {
      state: 'ok',
      sentence: '',
      data: { kind, id, name, employeeId, userId, personId, resolution },
    };
  } catch (e: any) {
    logFail(MOD, 'subjectFor', e);
    return { state: 'unreadable', sentence: readSentence('unreadable', 'person record'), data: null };
  }
}

// -------------------------------------------------------------------------------------------------
// THE COVERAGE VIEW
// -------------------------------------------------------------------------------------------------

export type CoverageStatus = 'evidenced' | 'stated' | 'related' | 'nothing' | 'unreadable';

/** A grouping word for the screen. It is ALWAYS printed beside the status sentence, never alone. */
export type CoverageBand = 'strong' | 'partial' | 'gap' | 'unknown';

export const STATUS_LABELS: Record<CoverageStatus, string> = {
  evidenced: 'Evidenced',
  stated: 'Stated, not demonstrated',
  related: 'Related skill only',
  nothing: 'Nothing on record',
  unreadable: 'Could not read',
};

export interface CoverageRow {
  skillId: string;
  skillName: string;
  necessity: Necessity;
  minLevel: number | null;
  status: CoverageStatus;
  statusLabel: string;
  band: CoverageBand;
  /** The recorded level, when there is one. Never invented. */
  level: number | null;
  levelLabel: string | null;
  /** The seven questions, in full. A page that cannot render this does not render the row. */
  chain: EvidenceChain;
}

export interface Coverage {
  subject: CoverageSubject;
  rows: CoverageRow[];
  /** Counts per status, so a screen can say "4 evidenced, 3 stated" without ever totalling them. */
  counts: Record<CoverageStatus, number>;
  /** Named so nobody has to wonder whether the missing percentage was an oversight. */
  refusesTotal: string;
  /** Platform records that exist but map to no requirement. Read by a human, counted by nothing. */
  platformRecord: PlatformRecord;
  state: 'ok' | 'not_configured' | 'unreadable';
  sentence: string;
}

export interface PlatformRecord {
  certificates: { title: string; certNumber: string; url: string | null; issuedAt: string | null }[];
  assessments: { title: string; percentage: number | null; at: string | null }[];
  read: 'ok' | 'no_account' | 'unreadable';
  sentence: string;
}

/**
 * Certificates and passed assessments held by this person's login.
 *
 * READ THROUGH THE MODULES THAT OWN THEM — getCertificatesForUser() and passedAssessmentsFor() —
 * never by querying course_certificates or test_attempts here. That split has been fixed once on
 * this project already and the files document the damage.
 *
 * NOT ATTACHED TO ANY REQUIREMENT. There is no mapping in this repository from a course to a skill,
 * and inventing one would be exactly the theatre this module refuses. So these are shown to a human
 * as a platform record and nothing counts them.
 */
async function platformRecordFor(userId: string | null): Promise<PlatformRecord> {
  if (!isUuid(userId || '')) {
    return {
      certificates: [], assessments: [], read: 'no_account',
      sentence: 'No login account is linked to this person, so nothing they may have done on the learning '
        + 'platform can be read. That is a missing link in our records.',
    };
  }
  const uid = String(userId);
  let certificates: PlatformRecord['certificates'] = [];
  let certFailed = false;
  try {
    const rows = await getCertificatesForUser(uid);
    certificates = (Array.isArray(rows) ? rows : []).slice(0, 25).map((c: any) => ({
      title: String(c?.course_title || 'A course'),
      certNumber: String(c?.cert_number || ''),
      url: c?.verification_url ? String(c.verification_url) : (c?.cert_number ? '/verify/' + String(c.cert_number) : null),
      issuedAt: c?.issued_at ? new Date(c.issued_at).toISOString() : null,
    }));
  } catch (e: any) {
    logFail(MOD, 'platformRecord:certificates', e);
    certFailed = true;
  }

  const passed = await passedAssessmentsFor(uid);
  const assessments = passed.items.slice(0, 25).map((a) => ({
    title: a.testTitle,
    percentage: a.percentage,
    at: a.submittedAt,
  }));

  if (certFailed || passed.read === 'unreadable') {
    return {
      certificates, assessments, read: 'unreadable',
      sentence: 'Part of the platform record could not be read just now, so what is shown here is incomplete. '
        + 'Do not read a short list as a short record.',
    };
  }
  return {
    certificates, assessments, read: 'ok',
    sentence: certificates.length || assessments.length
      ? 'These are records this platform created. Nothing maps them to this job\'s requirements — there is no '
        + 'course-to-skill mapping in this system and guessing one would be inventing evidence. A human reads them.'
      : 'This person holds no certificates and has passed no assessments on this platform.',
  };
}

/**
 * THE COVERAGE VIEW for one person against one job.
 *
 * Every row carries its own evidence chain, so nothing on the screen is a conclusion whose basis is
 * one click away in a modal that nobody opens — the chain travels with the row.
 */
export async function coverageFor(roleId: string, subject: CoverageSubject): Promise<Coverage> {
  const emptyCounts: Record<CoverageStatus, number> = { evidenced: 0, stated: 0, related: 0, nothing: 0, unreadable: 0 };
  const refusesTotal =
    'There is no overall score on this page, and there will not be one. A single number would have to average '
    + 'a checked certificate against a keyword somebody typed on a form, and the only honest weighting between '
    + 'those two is that one of them is evidence and the other is not. Read the rows.';

  const platform = await platformRecordFor(subject.userId);

  const reqs = await requirementsFor(roleId);
  if (reqs.state === 'unreadable') {
    return {
      subject, rows: [], counts: { ...emptyCounts }, refusesTotal, platformRecord: platform,
      state: 'unreadable', sentence: reqs.sentence,
    };
  }
  if (reqs.state === 'not_configured' || !reqs.data.length) {
    return {
      subject, rows: [], counts: { ...emptyCounts }, refusesTotal, platformRecord: platform,
      state: 'not_configured', sentence: reqs.sentence,
    };
  }

  // WHAT THE PERSON HAS RECORDED, once, for every requirement at once.
  const skillIds = reqs.data.map((r) => r.skillId).filter(isUuid);
  const held = new Map<string, { level: number; source: string; evidence: string | null; evidenceUrl: string | null; at: string | null }>();
  let heldReadFailed = false;
  if (subject.employeeId && skillIds.length) {
    try {
      await ensurePerformanceSchema();
      const rows = rowsOf(await db.execute(sql`
        SELECT skill_id::text AS skill_id, level, source, evidence, evidence_url, assessed_at
          FROM hr_employee_skills
         WHERE employee_id = ${subject.employeeId}::uuid
           AND skill_id IN (${uuidList(skillIds)})`));
      for (const r of rows) {
        held.set(String(r.skill_id), {
          level: Number(r.level) || 1,
          source: String(r.source || 'self'),
          evidence: r.evidence ? String(r.evidence) : null,
          evidenceUrl: r.evidence_url ? String(r.evidence_url) : null,
          at: r.assessed_at ? new Date(r.assessed_at).toISOString() : null,
        });
      }
    } catch (e: any) {
      logFail(MOD, 'coverageFor:held', e);
      heldReadFailed = true;
    }
  }

  // EVERY SKILL THIS PERSON HOLDS, for the related-skill walk. Fetched separately because the walk
  // needs skills OUTSIDE the requirement list — that is the entire point of having a graph.
  const allHeld = new Map<string, { name: string; level: number; source: string }>();
  if (subject.employeeId && !heldReadFailed) {
    try {
      const rows = rowsOf(await db.execute(sql`
        SELECT es.skill_id::text AS skill_id, s.name, es.level, es.source
          FROM hr_employee_skills es JOIN hr_skills s ON s.id = es.skill_id
         WHERE es.employee_id = ${subject.employeeId}::uuid
         LIMIT 300`));
      for (const r of rows) {
        allHeld.set(String(r.skill_id), {
          name: String(r.name || ''), level: Number(r.level) || 1, source: String(r.source || 'self'),
        });
      }
    } catch (e: any) {
      logFail(MOD, 'coverageFor:allHeld', e);
    }
  }

  // THE CLAIMED KEYWORDS. Read as ONE text blob per surface and searched in memory, so a skill name
  // never becomes an ILIKE pattern against a jsonb column. These are CLAIMS: a keyword on a form is
  // the weakest thing in this file and it is labelled that way everywhere it appears.
  const claimBlobs: { where: string; text: string }[] = [];
  try {
    if (subject.kind === 'application') {
      const r = rowsOf(await db.execute(sql`
        SELECT COALESCE(tech_skills::text, '') AS tech FROM applications WHERE id = ${subject.id}::uuid LIMIT 1`));
      if (r.length && r[0].tech) claimBlobs.push({ where: 'the skills section of their application', text: String(r[0].tech).toLowerCase() });
    }
    if (subject.userId) {
      const r = rowsOf(await db.execute(sql`
        SELECT COALESCE(array_to_string(skills, ' '), '') AS s FROM applicant_profiles WHERE user_id = ${subject.userId}::uuid LIMIT 1`));
      if (r.length && r[0].s) claimBlobs.push({ where: 'their candidate profile', text: String(r[0].s).toLowerCase() });
    }
    if (subject.employeeId) {
      const r = rowsOf(await db.execute(sql`
        SELECT COALESCE(skills::text, '') AS s FROM hr_employee_profile WHERE employee_id = ${subject.employeeId}::uuid LIMIT 1`));
      if (r.length && r[0].s) claimBlobs.push({ where: 'their employee profile', text: String(r[0].s).toLowerCase() });
    }
  } catch (e: any) {
    // A missing optional profile table is not a failure of the page. It is logged and the claim
    // surfaces simply contribute nothing, which is honest: we did not read a claim, so we assert none.
    logFail(MOD, 'coverageFor:claims', e);
  }

  const rows: CoverageRow[] = [];
  const counts: Record<CoverageStatus, number> = { ...emptyCounts };

  for (const req of reqs.data) {
    const row = await coverageRow(req, subject, held, allHeld, claimBlobs, heldReadFailed);
    rows.push(row);
    counts[row.status] = (counts[row.status] || 0) + 1;
  }

  return {
    subject,
    rows,
    counts,
    refusesTotal,
    platformRecord: platform,
    state: 'ok',
    sentence: '',
  };
}

async function coverageRow(
  req: Requirement,
  subject: CoverageSubject,
  held: Map<string, { level: number; source: string; evidence: string | null; evidenceUrl: string | null; at: string | null }>,
  allHeld: Map<string, { name: string; level: number; source: string }>,
  claimBlobs: { where: string; text: string }[],
  heldReadFailed: boolean,
): Promise<CoverageRow> {
  const base = {
    skillId: req.skillId,
    skillName: req.skillName,
    necessity: req.necessity,
    minLevel: req.minLevel,
  };

  const commonAssumptions = [
    'It assumes the mapping from this job\'s description to the skill catalogue is right. A human made that '
      + 'mapping and it is recorded as their statement: ' + req.basis,
  ];
  const commonData = ['hr_role_requirements', 'hr_skills'];

  // 0. A FAILED READ IS NOT A GAP.
  if (heldReadFailed) {
    return {
      ...base,
      status: 'unreadable',
      statusLabel: STATUS_LABELS.unreadable,
      band: 'unknown',
      level: null,
      levelLabel: null,
      chain: {
        concluded: 'We could not read what this person has recorded against ' + req.skillName + ', so nothing is concluded.',
        why: 'The read of hr_employee_skills failed. A requirement shown as a gap because a database read failed '
          + 'would be a person harmed by an outage, so this says so instead.',
        evidence: [],
        assumptions: commonAssumptions,
        uncertain: ['Everything about this row. This is a failure to read, not a finding.'],
        dataRead: commonData,
        overridable: { yes: false, how: 'There is nothing to override. Reload in a moment.' },
        assertion: 'inferred',
      },
    };
  }

  // 1. DIRECTLY RECORDED.
  const direct = held.get(req.skillId);
  if (direct) {
    const assertion = assertionForSkillSource(direct.source);
    const citation: EvidenceCitation = {
      // 'factual', not 'verified': assertionForSkillSource() returns the platform's own record of a
      // completion or a passed assessment. No human verified anything here, and the word for a row
      // this platform wrote about its own act is a recorded fact.
      kind: assertion === 'factual' ? 'Record this platform holds' : 'Statement',
      label: direct.evidence
        || (SKILL_LEVEL_LABELS[direct.level] || String(direct.level)) + ' in ' + req.skillName
          + ', recorded by ' + skillSourceActor(direct.source) + '.',
      url: direct.evidenceUrl,
      assertion,
      at: direct.at,
    };
    const short = req.minLevel !== null && direct.level < req.minLevel;
    const status: CoverageStatus = assertion === 'factual' ? 'evidenced' : 'stated';
    const band: CoverageBand = status === 'evidenced' ? (short ? 'partial' : 'strong') : 'partial';
    return {
      ...base,
      status,
      statusLabel: STATUS_LABELS[status],
      band,
      level: direct.level,
      levelLabel: SKILL_LEVEL_LABELS[direct.level] || String(direct.level),
      chain: {
        concluded: status === 'evidenced'
          ? req.skillName + ' is evidenced at level ' + direct.level + ' ('
            + (SKILL_LEVEL_LABELS[direct.level] || direct.level) + ')'
            + (short ? ', which is below the level this job asks for.' : '.')
          : req.skillName + ' is recorded at level ' + direct.level + ' ('
            + (SKILL_LEVEL_LABELS[direct.level] || direct.level) + '), as a statement nobody has checked'
            + (short ? ', and it is below the level this job asks for.' : '.'),
        why: status === 'evidenced'
          ? 'The level is attached to a completion or a passed assessment on this platform. src/lib/skills.ts '
            + 're-read that record against this person\'s own learner account when the level was saved, and '
            + 'refuses a reference that does not confirm, so the attachment was checked at write time.'
          : 'The level was recorded by ' + skillSourceActor(direct.source) + '. That is an honest record of what '
            + 'somebody said, and it is not a demonstration. A level is never derived from evidence here — '
            + 'a person chooses it.',
        evidence: [citation],
        assumptions: commonAssumptions.concat(
          status === 'evidenced'
            ? ['It assumes the completion or assessment behind this level is relevant to the work this job needs. '
              + 'Nothing in this system checks that; a human does.']
            : ['It assumes the person recording the level meant what the level description says.'],
        ),
        uncertain: [
          UNRECORDED_CAVEAT,
          status === 'evidenced'
            ? 'A passed assessment is a pass. It does not say how far past the line, and the level beside it was '
              + 'still chosen by a person rather than derived from the result.'
            : 'Nobody has checked this. It is exactly as reliable as the person who entered it.',
        ].concat(short ? ['This is below the level the job asks for, which is a shortfall on record rather than an absence.'] : []),
        dataRead: commonData.concat(['hr_employee_skills'], direct.evidenceUrl ? ['course_certificates or test_attempts, through the module that owns it'] : []),
        overridable: {
          yes: true,
          how: 'Record a decision below saying the evidence is stronger or weaker than this, with your reason. '
            + 'It is kept beside this row and it does not change the person\'s record.',
        },
        assertion: chainAssertion([citation], 'calculated'),
      },
    };
  }

  // 2. RELATED THROUGH THE GRAPH.
  const related = await relatedTo(req.skillId);
  if (related.state === 'ok') {
    const supporting = related.data.filter((r) => r.supports && allHeld.has(r.skillId));
    const nonSupporting = related.data.filter((r) => !r.supports && allHeld.has(r.skillId));
    if (supporting.length) {
      const citations: EvidenceCitation[] = supporting.slice(0, 5).map((r) => {
        const h = allHeld.get(r.skillId);
        return {
          kind: 'Related skill',
          label: (h ? (SKILL_LEVEL_LABELS[h.level] || String(h.level)) + ' in ' + r.name : r.name)
            + ' — ' + r.path + '.',
          url: null,
          assertion: 'inferred' as AssertionType,
          at: null,
        };
      });
      return {
        ...base,
        status: 'related',
        statusLabel: STATUS_LABELS.related,
        band: 'partial',
        level: null,
        levelLabel: null,
        chain: {
          concluded: 'Nothing is recorded against ' + req.skillName + ' itself. This person holds '
            + supporting.map((r) => r.name).slice(0, 3).join(', ')
            + ', which the skill graph relates to it in the direction that supports it. That is an inference.',
          why: 'A relation in hr_skill_relations was walked from a skill this person holds towards this '
            + 'requirement. Direction matters: holding a specific case supports a requirement for the general '
            + 'skill, and holding the general one does not demonstrate the specific one.',
          evidence: citations,
          assumptions: commonAssumptions.concat([
            'It assumes the relation is right. A relation is one person\'s curation typed on the ontology '
              + 'screen; nothing measured it and nothing validated it.',
          ]),
          uncertain: [
            UNRECORDED_CAVEAT,
            'This is inferred and it is the weakest kind of row on this page. It must never be read as the '
              + 'person having this skill.',
            'The related skill itself may only be a statement nobody checked, in which case an unchecked claim '
              + 'is being carried across an unmeasured edge.',
          ],
          dataRead: commonData.concat(['hr_skill_relations', 'hr_employee_skills']),
          overridable: {
            yes: true,
            how: 'Record a decision below with your reason if this inference is wrong, or if it is right and '
              + 'stronger than it looks.',
          },
          assertion: 'inferred',
        },
      };
    }
    if (nonSupporting.length) {
      // The important negative: they hold the GENERAL skill and the job asks for the SPECIFIC one.
      return {
        ...base,
        status: 'nothing',
        statusLabel: STATUS_LABELS.nothing,
        band: 'gap',
        level: null,
        levelLabel: null,
        chain: {
          concluded: 'Nothing is recorded against ' + req.skillName + '. This person holds '
            + nonSupporting.map((r) => r.name).slice(0, 3).join(', ')
            + ', which is related, but not in a direction that demonstrates this requirement.',
          why: 'The graph relates those skills to this one, but the requirement is the more specific skill and '
            + 'the person holds the more general one. Holding the general case does not demonstrate the '
            + 'specific case, and counting it as cover would be the keyword trap wearing a hierarchy.',
          evidence: nonSupporting.slice(0, 5).map((r) => ({
            kind: 'Related, not supporting',
            label: r.name + ' — ' + r.path + '. This does not demonstrate ' + req.skillName + '.',
            url: null,
            assertion: 'inferred' as AssertionType,
            at: null,
          })),
          assumptions: commonAssumptions,
          uncertain: [
            UNRECORDED_CAVEAT,
            'The gap may be entirely a recording gap. Somebody who holds the general skill very often holds the '
              + 'specific one and has never been asked to record it.',
          ],
          dataRead: commonData.concat(['hr_skill_relations', 'hr_employee_skills']),
          overridable: { yes: true, how: 'Record a decision below with your reason.' },
          assertion: 'inferred',
        },
      };
    }
  }

  // 3. CLAIMED AS A KEYWORD.
  const needle = req.skillName.toLowerCase().trim();
  const claimHit = needle ? claimBlobs.find((b) => b.text.indexOf(needle) >= 0) : undefined;
  if (claimHit) {
    const citation: EvidenceCitation = {
      kind: 'Claimed on a form',
      label: 'The words "' + req.skillName + '" appear in ' + claimHit.where + '.',
      url: null,
      assertion: 'explicitly_provided',
      at: null,
    };
    return {
      ...base,
      status: 'stated',
      statusLabel: STATUS_LABELS.stated,
      band: 'partial',
      level: null,
      levelLabel: null,
      chain: {
        concluded: req.skillName + ' appears as a keyword in ' + claimHit.where + '. It is claimed. Nothing '
          + 'demonstrates it, and no level is recorded against it.',
        why: 'A text search for the skill name in the free-text skill lists this person filled in. It is a '
          + 'string comparison and nothing more.',
        evidence: [citation],
        assumptions: commonAssumptions.concat([
          'It assumes the word means the same thing on their form as it does in our catalogue. Often it does '
            + 'not, and there is no way to tell from here.',
        ]),
        uncertain: [
          UNRECORDED_CAVEAT,
          'A skill on a CV is claimed, not demonstrated. This row is the weakest possible positive: it says the '
            + 'word is present, which is not a statement about what the person can do.',
          'A keyword match can be a false positive from an unrelated sentence in the same field.',
        ],
        dataRead: commonData.concat([
          subject.kind === 'application' ? 'applications.tech_skills' : 'hr_employee_profile.skills',
          'applicant_profiles.skills',
        ]),
        overridable: { yes: true, how: 'Record a decision below with your reason.' },
        assertion: 'explicitly_provided',
      },
    };
  }

  // 4. NOTHING.
  return {
    ...base,
    status: 'nothing',
    statusLabel: STATUS_LABELS.nothing,
    band: 'gap',
    level: null,
    levelLabel: null,
    chain: {
      concluded: 'Nothing is recorded against ' + req.skillName + ' for this person.',
      why: 'No recorded level, no related skill in the graph, and the name does not appear in any skill list '
        + 'they filled in.',
      evidence: [],
      assumptions: commonAssumptions,
      uncertain: [
        UNRECORDED_CAVEAT,
        subject.employeeId
          ? 'Recording a skill is voluntary and one screen writes them. Most people have recorded very few.'
          : 'This person has no employee record linked, so there is no skill matrix to read at all. An empty '
            + 'row here is mostly a statement about the link, not about them.',
      ],
      dataRead: commonData.concat(['hr_employee_skills', 'hr_skill_relations']),
      overridable: {
        yes: true,
        how: 'Record a decision below if you know something this system does not. That is the normal case, '
          + 'not the exception.',
      },
      assertion: 'calculated',
    },
  };
}

// -------------------------------------------------------------------------------------------------
// THE HUMAN'S DECISION
// -------------------------------------------------------------------------------------------------

export const MATCH_DECISIONS = ['advance', 'not_now', 'override_stronger', 'override_weaker'] as const;
export type MatchDecision = (typeof MATCH_DECISIONS)[number];

export const DECISION_LABELS: Record<string, string> = {
  advance: 'Worth taking further',
  not_now: 'Not for this role, now',
  override_stronger: 'The evidence is stronger than this page shows',
  override_weaker: 'The evidence is weaker than this page shows',
};

export interface MatchDecisionRow {
  id: string;
  decision: MatchDecision;
  decisionLabel: string;
  reason: string;
  decidedByUserId: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
}

/**
 * Record what a human decided, and why.
 *
 * IT CHANGES NOTHING ELSE. It does not move the application's stage — that is
 * src/lib/application-stages.ts, which keeps its own actor history and is the only thing allowed to
 * move a candidate through the funnel. It does not start an approval, because this is not an
 * approval: nobody is being asked to sign anything off, and src/lib/workflow.ts is the only approval
 * engine in this product. It is a JUDGEMENT ABOUT AN ADVISORY VIEW, recorded beside the view, which
 * is precisely what "a human retains authority" has to mean if it is to mean anything.
 *
 * THE REASON IS REQUIRED. A recorded override with no reason is an opaque decision with a timestamp.
 */
export async function recordDecision(input: {
  roleId: string;
  subject: CoverageSubject;
  decision: MatchDecision;
  reason: string;
  /** What the screen was showing when they decided. Kept so the decision stays legible when data moves. */
  snapshot?: Record<string, unknown>;
  actorUserId: string;
}): Promise<CoverageWriteResult> {
  const roleId = String(input?.roleId || '');
  const subject = input?.subject;
  const decision = input?.decision;
  const reason = clean(input?.reason, 2000);
  const actor = isUuid(input?.actorUserId) ? String(input.actorUserId) : null;

  if (!isUuid(roleId) || !subject || !isUuid(subject.id)) return { ok: false, error: 'Choose a job and a person.' };
  if ((MATCH_DECISIONS as readonly string[]).indexOf(String(decision)) < 0) return { ok: false, error: 'Choose what you decided.' };
  if (!reason) {
    return { ok: false, error: 'Write down why. A recorded decision with no reason is an opaque decision with a '
      + 'timestamp on it, which is the thing this whole screen exists to avoid.' };
  }
  if (!actor) return { ok: false, error: 'We could not tell who is making this decision, so nothing was written.' };

  try {
    await ensureSpineSchema();
    const rows = rowsOf(await db.execute(sql`
      INSERT INTO hr_match_decisions
        (role_id, person_id, subject_kind, subject_id, decision, reason, coverage_snapshot, decided_by_user_id)
      VALUES
        (${roleId}::uuid, ${subject.personId}::uuid, ${String(subject.kind)}, ${String(subject.id)},
         ${String(decision)}, ${reason}, ${JSON.stringify(input?.snapshot || {})}::jsonb, ${actor}::uuid)
      RETURNING id::text AS id`));
    if (!rows.length) return { ok: false, error: WRITE_FAILED };
    await logAudit({
      userId: actor,
      action: 'match.decision.record',
      entity: 'hr_match_decisions',
      entityId: String(rows[0].id),
      diff: { roleId, subjectKind: subject.kind, subjectId: subject.id, decision, reason },
    });
    return { ok: true, id: String(rows[0].id) };
  } catch (e: any) {
    logFail(MOD, 'recordDecision', e);
    return { ok: false, error: e?.cause?.message || e?.message || WRITE_FAILED };
  }
}

/** Every decision recorded about this person for this job, newest first. Append-only, so this is the history. */
export async function decisionsFor(roleId: string, subjectKind: string, subjectId: string): Promise<Read<MatchDecisionRow[]>> {
  if (!isUuid(roleId) || !isUuid(subjectId)) {
    return { state: 'unreadable', sentence: 'That was not named properly.', data: [] };
  }
  try {
    await ensureSpineSchema();
    const rows = rowsOf(await db.execute(sql`
      SELECT d.id::text AS id, d.decision, d.reason, d.decided_by_user_id::text AS by_id,
             u.name AS by_name, d.decided_at
        FROM hr_match_decisions d
        LEFT JOIN users u ON u.id = d.decided_by_user_id
       WHERE d.role_id = ${roleId}::uuid AND d.subject_kind = ${String(subjectKind)} AND d.subject_id = ${String(subjectId)}
       ORDER BY d.decided_at DESC
       LIMIT 50`));
    const data: MatchDecisionRow[] = rows.map((r: any) => ({
      id: String(r.id),
      decision: String(r.decision) as MatchDecision,
      decisionLabel: DECISION_LABELS[String(r.decision)] || String(r.decision),
      reason: String(r.reason || ''),
      decidedByUserId: r.by_id ? String(r.by_id) : null,
      decidedByName: r.by_name ? String(r.by_name) : null,
      decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
    }));
    return { state: data.length ? 'ok' : 'empty', sentence: data.length ? '' : 'Nobody has recorded a decision here yet.', data };
  } catch (e: any) {
    logFail(MOD, 'decisionsFor', e);
    return { state: 'unreadable', sentence: readSentence('unreadable', 'recorded decisions'), data: [] };
  }
}

/** Candidates who applied for this job, for the list on the match screen. */
export async function candidatesForRole(roleId: string, limit = 50): Promise<Read<{ id: string; name: string; stage: string | null; appliedAt: string | null }[]>> {
  if (!isUuid(roleId)) return { state: 'unreadable', sentence: 'That job was not named properly.', data: [] };
  try {
    const rows = rowsOf(await db.execute(sql`
      SELECT id::text AS id, first_name, last_name, stage, created_at
        FROM applications
       WHERE role_id = ${roleId}::uuid
       ORDER BY created_at DESC
       LIMIT ${Math.min(Math.max(1, Math.round(limit)), 200)}`));
    const data = rows.map((r: any) => ({
      id: String(r.id),
      name: String((r.first_name || '') + ' ' + (r.last_name || '')).trim() || 'Unnamed applicant',
      stage: r.stage ? String(r.stage) : null,
      appliedAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    }));
    return {
      state: data.length ? 'ok' : 'empty',
      sentence: data.length ? '' : 'Nobody has applied for this job yet.',
      data,
    };
  } catch (e: any) {
    logFail(MOD, 'candidatesForRole', e);
    return { state: 'unreadable', sentence: readSentence('unreadable', 'applications'), data: [] };
  }
}
