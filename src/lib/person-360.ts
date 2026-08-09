// src/lib/person-360.ts — ONE PERSON, ASSEMBLED, WITH EVERY PANEL SAYING HOW IT KNOWS.
//
// =================================================================================================
// WHAT THIS ASSEMBLES, AND WHAT IT REFUSES TO
// =================================================================================================
//
// The founder spec draws an Employee 360. The dangerous reading of that phrase is "put everything we
// hold about a person on one screen", and this module is deliberately not that. It assembles what a
// person's CAPABILITY and EMPLOYMENT record consists of, panel by panel, and each panel carries the
// assertion type of what is in it so a reader can never mistake a statement for a check.
//
// WHAT IT NEVER READS, and the absence is the enforcement:
//
//   WELLNESS. src/lib/wellness.ts is women-only and gated server-side, and no admin — not the
//   founder — may see one person's cycle, symptoms or consult messages. There is no import of it in
//   this file and there must never be one. A 360 that quietly included a wellness panel would
//   contradict the entire premise of that system on the screen most likely to be shown to a room.
//
//   SALARY, BANK DETAILS, DATE OF BIRTH, GENDER. None of them is capability, none of them may be a
//   decision variable, and a 360 is read while decisions are being made.
//
//   ANY SURVEILLANCE SIGNAL. No communication volume, no activity metric, no login times, no
//   monitoring. src/lib/person-assertions.ts refuses the subjects by name; this file simply never
//   asks.
//
//   ANY SCORE, RATING OR PREDICTION ABOUT THE PERSON. There is no number on this record summarising
//   a human. The panels count records; they never rate a person.
//
// =================================================================================================
// ASSEMBLED PER VIEWER
// =================================================================================================
//
// The same function serves the admin surface and the person's own surface. `audience` decides the
// wording, not the truthfulness: nothing is softened for the person it is about, and nothing extra
// is revealed to an administrator. The one real difference is that the person's own view leads with
// the inference panel — if we hold an inference about somebody, the first thing they should be able
// to find is that it is an inference.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { rowsOf, logFail, isUuid } from '@/lib/performance-scope';
import { getManager, isInitialized, type OrgPerson } from '@/lib/org-graph';
import { skillsForEmployee, type EmployeeSkill } from '@/lib/skills';
import { getCertificatesForUser } from '@/lib/certificates';
import { passedAssessmentsFor } from '@/lib/learning-doors';
import {
  personFor,
  identitiesFor,
  readSentence,
  IDENTITY_KIND_LABELS,
  type Read,
  type PersonIdentity,
} from '@/lib/person-spine';
import {
  assertionForSkillSource,
  skillSourceActor,
  assertionLabel,
  assertionSentence,
  toAssertionType,
  type AssertionType,
} from '@/lib/person-assertions';
import { SKILL_LEVEL_LABELS } from '@/lib/skills';

const MOD = 'person-360';

export type Audience = 'admin' | 'self';

export interface TwinItem {
  /** The label on the left of the row. */
  name: string;
  /** The value, already turned into a string by whoever knows what it means. */
  value: string;
  assertion: AssertionType;
  /** The sentence under the value. Printed, not hovered — see mustSayInWords. */
  note: string;
  /** Where the underlying record can be seen, when it can be. */
  url: string | null;
  at: string | null;
}

export interface TwinPanel {
  key: string;
  title: string;
  /** What this panel is, in one sentence, before any values. */
  intro: string;
  items: TwinItem[];
  /** 'ok' | 'not_configured' | 'empty' | 'unreadable' — three different sentences, never one. */
  state: 'ok' | 'not_configured' | 'empty' | 'unreadable';
  /** The sentence for a non-ok state. Empty when state is ok. */
  stateSentence: string;
}

export interface PersonTwin {
  personId: string | null;
  displayName: string;
  employeeId: string | null;
  userId: string | null;
  audience: Audience;
  panels: TwinPanel[];
  /** Every inference this system holds about this person, gathered in one place. */
  inferences: TwinItem[];
  /** What this record deliberately does not contain, said out loud on the screen. */
  notHere: string[];
  state: 'ok' | 'unreadable';
  sentence: string;
}

/** Every panel says this when it has nothing, and none of them says "none". */
function emptyPanel(key: string, title: string, intro: string, sentence: string): TwinPanel {
  return { key, title, intro, items: [], state: 'empty', stateSentence: sentence };
}

/**
 * Assemble the twin.
 *
 * `employeeId` may be null — a person who has only ever been a candidate is a person, and a screen
 * that cannot render them is a screen that treats employment as the condition of existing here.
 */
export async function personTwin(input: {
  personId?: string | null;
  employeeId?: string | null;
  userId?: string | null;
  displayName?: string | null;
  audience: Audience;
}): Promise<PersonTwin> {
  const audience: Audience = input?.audience === 'self' ? 'self' : 'admin';
  const employeeId = isUuid(input?.employeeId || '') ? String(input.employeeId) : null;
  let userId = isUuid(input?.userId || '') ? String(input.userId) : null;
  let personId = isUuid(input?.personId || '') ? String(input.personId) : null;
  let displayName = String(input?.displayName || '').trim() || 'This person';

  const panels: TwinPanel[] = [];
  const inferences: TwinItem[] = [];

  // ---- WHO THIS IS, ACROSS THE SURFACES -----------------------------------------------------------
  if (!personId && employeeId) {
    const p = await personFor('employee', employeeId);
    if (p.data) personId = p.data.id;
  }

  if (employeeId && !userId) {
    try {
      const r = rowsOf(await db.execute(sql`
        SELECT user_id::text AS user_id, full_name FROM hr_employees WHERE id = ${employeeId}::uuid LIMIT 1`));
      if (r.length) {
        userId = r[0].user_id ? String(r[0].user_id) : null;
        if (r[0].full_name && displayName === 'This person') displayName = String(r[0].full_name);
      }
    } catch (e: any) {
      logFail(MOD, 'twin:employeeRow', e);
    }
  }

  panels.push(await identityPanel(personId, employeeId, inferences));
  panels.push(await employmentPanel(employeeId));
  panels.push(await skillsPanel(employeeId, audience));
  panels.push(await platformPanel(userId));
  panels.push(await organizationPanel(employeeId));

  // ---- WHAT IS NOT HERE, AND WHY ------------------------------------------------------------------
  const notHere = [
    'No health or wellness information. The wellness system is gated so that no administrator, and not '
      + 'the founder, can see one person\'s record. This screen does not read it.',
    'No pay, bank details, date of birth or gender. None of them is capability, and this record is read '
      + 'while decisions are being made.',
    'No score, rating, ranking or prediction about ' + (audience === 'self' ? 'you' : 'this person')
      + '. There is no attrition risk, no flight risk, no potential rating and no culture-fit judgement '
      + 'anywhere in this system — those are refused by name in the code, not merely unbuilt.',
    'Nothing derived from monitoring. No communication volume, no activity metric, no login patterns. '
      + 'Performance is never inferred from surveillance here.',
  ];

  return {
    personId,
    displayName,
    employeeId,
    userId,
    audience,
    panels,
    inferences,
    notHere,
    state: 'ok',
    sentence: '',
  };
}

// -------------------------------------------------------------------------------------------------
// THE PANELS
// -------------------------------------------------------------------------------------------------

async function identityPanel(
  personId: string | null,
  employeeId: string | null,
  inferences: TwinItem[],
): Promise<TwinPanel> {
  const intro = 'The records this system holds for one human, and how each of them was connected. A connection '
    + 'here is a statement somebody made, not something the system worked out on its own.';
  if (!personId) {
    return {
      key: 'identity',
      title: 'Which records are this person',
      intro,
      items: [],
      state: 'not_configured',
      stateSentence: 'No person record has been created yet, so the login, the application and the employee '
        + 'record are still three separate rows joined by nothing but an email address. Nothing links them '
        + 'automatically — that is deliberate, because an email match is an inference and this system does not '
        + 'convert one into a fact.',
    };
  }
  const read: Read<PersonIdentity[]> = await identitiesFor(personId);
  if (read.state === 'unreadable') {
    return { key: 'identity', title: 'Which records are this person', intro, items: [], state: 'unreadable', stateSentence: read.sentence };
  }
  if (!read.data.length) {
    return emptyPanel('identity', 'Which records are this person', intro, read.sentence);
  }
  const items: TwinItem[] = read.data.map((i) => {
    const assertion = toAssertionType(i.assertion);
    const live = !i.unlinkedAt;
    const item: TwinItem = {
      name: IDENTITY_KIND_LABELS[i.kind] || i.kind,
      value: (i.display || i.refId) + (live ? '' : ' — withdrawn'),
      assertion,
      note: (live ? '' : 'This link was withdrawn' + (i.unlinkReason ? ': ' + i.unlinkReason : '.') + ' ')
        + i.basis + ' ' + assertionSentence(assertion, 'This connection'),
      url: i.kind === 'employee' ? '/admin/people/' + i.refId : null,
      at: i.linkedAt,
    };
    if (live && assertion === 'inferred') inferences.push(item);
    return item;
  });
  return { key: 'identity', title: 'Which records are this person', intro, items, state: 'ok', stateSentence: '' };
}

/**
 * The employment facts.
 *
 * EVERY ONE OF THESE IS `explicitly_provided`, INCLUDING THE ONES THAT LOOK OFFICIAL. designation,
 * department and joining date are stored identically whether HR typed them or the hire handoff
 * copied them across from an offer letter, and nothing in the schema records which. Labelling them
 * as checked because they sit in the HR table would be the exact confusion this spine exists to
 * remove — so they are labelled as what they provably are: values somebody entered.
 */
async function employmentPanel(employeeId: string | null): Promise<TwinPanel> {
  const intro = 'What the employee record says. These values were entered by a person — the record does not '
    + 'distinguish between HR typing them and the hire handoff copying them from an offer letter, so none of '
    + 'them is shown as checked.';
  if (!employeeId) {
    return {
      key: 'employment', title: 'Employment record', intro, items: [],
      state: 'not_configured',
      stateSentence: 'No employee record is linked to this person. That is not a statement that they are not '
        + 'employed — it means no employee record has been connected here.',
    };
  }
  try {
    const r = rowsOf(await db.execute(sql`
      SELECT e.full_name, e.employee_code, e.designation, e.employment_type, e.work_mode,
             e.employment_status, e.joining_date, e.department_id::text AS department_id,
             d.name AS department_name
        FROM hr_employees e
        LEFT JOIN departments d ON d.id::text = e.department_id::text
       WHERE e.id = ${employeeId}::uuid LIMIT 1`));
    if (!r.length) {
      return emptyPanel('employment', 'Employment record', intro, 'That employee record does not exist.');
    }
    const row = r[0];
    const mk = (name: string, value: any, note: string): TwinItem | null => {
      const v = value === null || value === undefined || String(value).trim() === '' ? '' : String(value);
      if (!v) return null;
      return { name, value: v, assertion: 'explicitly_provided', note, url: null, at: null };
    };
    const items = [
      mk('Name on the record', row.full_name, 'The name as typed on the employee record. A person may be named differently on their application.'),
      mk('Employee code', row.employee_code, 'Generated by this system when the record was created.'),
      mk('Designation', row.designation, 'Entered by a person. A promotion is routed as a workflow and never written here directly.'),
      mk('Department', row.department_name || row.department_id, 'Entered by a person. Exactly one screen writes it, so many records have none.'),
      mk('Employment type', row.employment_type, 'Entered by a person.'),
      mk('Work mode', row.work_mode, 'Entered by a person.'),
      mk('Status', row.employment_status, 'Entered by a person, or set by the separation process.'),
      mk('Joining date', row.joining_date ? new Date(row.joining_date).toISOString().slice(0, 10) : '', 'Entered by a person.'),
    ].filter(Boolean) as TwinItem[];

    // The employee code is the one value this system genuinely created, so it is the one that is factual.
    for (const it of items) if (it.name === 'Employee code') it.assertion = 'factual';

    return items.length
      ? { key: 'employment', title: 'Employment record', intro, items, state: 'ok', stateSentence: '' }
      : emptyPanel('employment', 'Employment record', intro, 'The employee record exists but has nothing filled in on it.');
  } catch (e: any) {
    logFail(MOD, 'employmentPanel', e);
    return { key: 'employment', title: 'Employment record', intro, items: [], state: 'unreadable', stateSentence: readSentence('unreadable', 'employee record') };
  }
}

/**
 * The skill matrix, with a verified level and a stated level rendered as different things.
 *
 * This is the panel the whole spine is aimed at. Today one screen writes hr_employee_skills and a
 * person picks their own level from a dropdown; a course or assessment can be ATTACHED and that
 * attachment is checked, but the LEVEL is still somebody's choice. Both facts are on the row.
 */
async function skillsPanel(employeeId: string | null, audience: Audience): Promise<TwinPanel> {
  const intro = 'Recorded capability. A level that was attached to a completion or a passed assessment on this '
    + 'platform is marked as checked; a level somebody chose is marked as stated. They are not the same claim '
    + 'and this panel never shows them the same way.';
  if (!employeeId) {
    return {
      key: 'skills', title: 'Skills', intro, items: [],
      state: 'not_configured',
      stateSentence: 'Skills are recorded against an employee record, and none is linked here, so there is no '
        + 'matrix to read.',
    };
  }
  const skills: EmployeeSkill[] = await skillsForEmployee(employeeId);
  if (!skills.length) {
    return emptyPanel('skills', 'Skills', intro,
      (audience === 'self' ? 'You have' : 'This person has') + ' no recorded skills yet. Recording one is '
      + 'voluntary and exactly one screen writes them, so an empty matrix is common and says nothing about '
      + 'what somebody can do.');
  }
  const items: TwinItem[] = skills.map((s) => {
    const assertion = assertionForSkillSource(s.source);
    return {
      name: s.skillName,
      value: 'Level ' + s.level + ' — ' + (SKILL_LEVEL_LABELS[s.level] || s.levelLabel),
      assertion,
      note: 'Recorded by ' + skillSourceActor(s.source) + '. '
        + (s.evidence ? s.evidence + ' ' : '')
        + (assertion === 'factual'
          ? 'The attachment was confirmed against the record that owns it when it was saved — by this '
            + 'platform reading its own table, not by a person. The LEVEL itself was still chosen by '
            + 'somebody; it is not derived from the result, and nobody has verified it.'
          : 'Nobody has checked this.'),
      url: s.evidenceUrl,
      at: s.assessedAt,
    };
  });
  return { key: 'skills', title: 'Skills', intro, items, state: 'ok', stateSentence: '' };
}

/**
 * What this platform itself recorded: signed certificates and passed assessments.
 *
 * Read through the modules that own them — never by querying course_certificates or test_attempts
 * here. These are the strongest records in the product: the certificate ledger is hash-chained and
 * Ed25519-signed, and verifiable by anybody at /verify/<number>.
 *
 * EduRankAI is the technology platform. A completion here is a record of work done on this platform;
 * accredited partners award credentials, and nothing in this panel says qualified or accredited.
 */
async function platformPanel(userId: string | null): Promise<TwinPanel> {
  const intro = 'Records this platform created and can prove. A certificate here is verifiable by anybody at its '
    + 'own address. It is a record of work done on this platform, not a qualification — accredited partners '
    + 'award credentials.';
  if (!isUuid(userId || '')) {
    return {
      key: 'platform', title: 'Platform record', intro, items: [],
      state: 'not_configured',
      stateSentence: 'No login account is linked, so nothing done on the learning platform can be read. That is '
        + 'a missing link in our records rather than an empty record.',
    };
  }
  const uid = String(userId);
  const items: TwinItem[] = [];
  let failed = false;

  try {
    const certs = await getCertificatesForUser(uid);
    for (const c of (Array.isArray(certs) ? certs : []).slice(0, 30)) {
      const num = String(c?.cert_number || '');
      items.push({
        name: String(c?.course_title || 'A course'),
        value: 'Certificate ' + (num || 'issued'),
        assertion: 'factual',
        note: 'Issued by this platform and anchored in a hash-chained, signed ledger. Anybody can verify it.',
        url: c?.verification_url ? String(c.verification_url) : (num ? '/verify/' + num : null),
        at: c?.issued_at ? new Date(c.issued_at).toISOString() : null,
      });
    }
  } catch (e: any) {
    logFail(MOD, 'platformPanel:certificates', e);
    failed = true;
  }

  const passed = await passedAssessmentsFor(uid);
  for (const a of passed.items.slice(0, 30)) {
    items.push({
      name: a.testTitle,
      value: 'Passed' + (a.percentage === null ? '' : ' at ' + a.percentage + '%'),
      assertion: 'factual',
      note: 'A submitted attempt this platform marked as passed. It says the attempt cleared the pass mark and '
        + 'nothing about how far past it.',
      url: null,
      at: a.submittedAt,
    });
  }

  if (failed || passed.read === 'unreadable') {
    return {
      key: 'platform', title: 'Platform record', intro, items,
      state: 'unreadable',
      stateSentence: 'Part of this could not be read just now, so what is listed is incomplete. Do not read a '
        + 'short list here as a short record.',
    };
  }
  return items.length
    ? { key: 'platform', title: 'Platform record', intro, items, state: 'ok', stateSentence: '' }
    : emptyPanel('platform', 'Platform record', intro, 'No certificates and no passed assessments are recorded on this platform.');
}

/**
 * Who answers for this person's work.
 *
 * FROM THE ORGANIZATION GRAPH AND FROM NOWHERE ELSE. Never users.role, never a title, never
 * "same department". And `initialized` is carried so that "the graph is empty" and "this person has
 * no manager" render as different sentences — the second is a statement about a person and the first
 * is a statement about our setup.
 */
async function organizationPanel(employeeId: string | null): Promise<TwinPanel> {
  const intro = 'Reporting lines come from the Organization Graph, resolved per row. They are never read from an '
    + 'account type or a job title.';
  if (!employeeId) {
    return {
      key: 'organization', title: 'Reporting line', intro, items: [],
      state: 'not_configured',
      stateSentence: 'No employee record is linked, so no reporting line can be resolved.',
    };
  }
  try {
    const initialized = await isInitialized();
    if (!initialized) {
      return {
        key: 'organization', title: 'Reporting line', intro, items: [],
        state: 'not_configured',
        stateSentence: 'The Organization Graph has not been set up yet, so no reporting line can be resolved for '
          + 'anybody. That is not the same as this person having no manager.',
      };
    }
    const manager: OrgPerson | null = await getManager(employeeId);
    if (!manager) {
      return emptyPanel('organization', 'Reporting line', intro,
        'The Organization Graph records no reporting manager for this person.');
    }
    return {
      key: 'organization', title: 'Reporting line', intro,
      items: [{
        name: 'Reporting manager',
        value: String(manager.fullName || 'Unnamed record') + (manager.designation ? ' — ' + manager.designation : ''),
        assertion: 'factual',
        note: 'A live reporting_manager edge in the Organization Graph. It is dated, so it keeps answering '
          + 'correctly for a decision made before the last reorganisation.',
        url: manager.employeeId ? '/admin/people/' + manager.employeeId : null,
        at: null,
      }],
      state: 'ok', stateSentence: '',
    };
  } catch (e: any) {
    logFail(MOD, 'organizationPanel', e);
    return { key: 'organization', title: 'Reporting line', intro, items: [], state: 'unreadable', stateSentence: readSentence('unreadable', 'Organization Graph') };
  }
}

/** For a chip. Exported so the two pages cannot label an assertion differently from each other. */
export function chipLabel(a: AssertionType): string {
  return assertionLabel(a);
}
