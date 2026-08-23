// src/lib/hr-intelligence/access.ts — WHO MAY OPEN THIS, HOW DEEP, AND WHAT GETS WRITTEN DOWN.
//
// =================================================================================================
// RESOLVED BEFORE ANYTHING IS READ
// =================================================================================================
//
// Every decision in this file is made BEFORE the first query of the view runs. A section the viewer
// may not see is ABSENT from the assembled object — the query that would have carried it is never
// issued, and the columns it would have selected are never named in any SQL. That is the precedent
// twinAccess() set in digital-twin.ts, and it is the difference between a boundary and a CSS class:
// there is no code path where a withheld value existed in memory on a screen not allowed to have it.
//
// A WITHHELD SECTION IS NAMED. It renders as a heading and a sentence saying what it would have
// contained and what would be needed to see it. Silently dropping it teaches a reader that the
// screen shows everything, which is the belief that makes a partial view dangerous.
//
// =================================================================================================
// THE THREE LAYERS, KEPT APART
// =================================================================================================
//
// Organization / Authorization / Workflow are independent layers on this project and are never
// merged. This module asks each of them separately and never one in place of another:
//
//   AUTHORIZATION   `holds(key)` — the caller's wildcard-aware capability test, passed in. This
//                   module imports no authorization engine and must never become one.
//   ORGANIZATION    canSeePerformanceOf() — the per-ROW relationship, resolved from the org graph
//                   by the module that owns it. A capability cannot express "this person and not
//                   that one", so a relationship question is never answered with a capability.
//   WORKFLOW        not asked here at all. Nothing in this view starts or advances one.
//
// =================================================================================================
// THE DEPTH BOUNDARY
// =================================================================================================
//
// The HR desk key resolves to `actionable` AND NOTHING ELSE. That is the patch requirement stated
// as code: HR sees actionable intelligence and does not automatically receive foundational
// computation detail.
//
// `foundational` needs THREE independent things, checked separately, in this order:
//
//   1. the capability `people.intelligence.foundational`, which is granted to no built-in role;
//   2. a stated PURPOSE for this particular read — not a setting, a sentence typed now;
//   3. the subject's CONSENT on record and unexpired, resolved through the consent reader below.
//
// Failing any one of them yields `actionable`, and the reason is named. They are separate because a
// single combined check is a single place to accidentally weaken all three.
//
// =================================================================================================
// NO ACCESS ROW, NO VIEW
// =================================================================================================
//
// recordAccess() must SUCCEED before the view is assembled. That is the trade legal-hold.ts already
// makes on this project — logAccess() succeeds before anything renders — and the cost is named
// rather than hidden: if the log cannot be written, the HR intelligence view is unavailable and
// says so, instead of quietly becoming an unlogged read of a person's development record.
//
// The cost is bounded by the schema bootstrapping itself, so "the table does not exist" is a
// first-run condition that resolves on the first call rather than an outage.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { logEvent } from '@/lib/logger';
import { canSeePerformanceOf, type PerfViewer } from '@/lib/performance-scope';
import { ensureHrIntelSchema } from '@/lib/hr-intelligence/schema';
import {
  SECTION_KEYS,
  sectionLabel,
  type SectionKey,
  type IntelligenceDepth,
  type HrActionKind,
  HR_ACTION_KINDS,
  actionLabel,
} from '@/lib/hr-intelligence/types';

const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const logFail = (tag: string, e: any) =>
  logEvent('error', 'hr-intelligence/access:' + tag, { message: reasonOf(e) });

const clean = (v: unknown, max: number): string => String(v ?? '').trim().slice(0, max);

// =================================================================================================
// THE KEYS
// =================================================================================================

/**
 * The HR desk key. Already exists, already held by the `hr` and `super_admin` built-in roles, and
 * already described in the registry as reaching every employee record without a relationship.
 *
 * REUSED RATHER THAN REPLACED. A new key for "may open the HR intelligence view" would be a new
 * policy decision — it would ship held by nobody, and the screen would be dead until an
 * administrator guessed that it needed granting. The population that may open this is the
 * population that already opens the people console, which is a decision somebody already made.
 */
export const HR_DESK = 'employee.manage';

/** The assembled-record key. Whoever may open one person as one record may open this reading of it. */
export const PERSON_360 = 'people.view_360';

/** Appraisals across the organization. Opens the performance-backed sections without a relationship. */
export const PERF_MANAGE = 'performance.manage';

/** The skill catalogue and levels. Opens the skill-backed sections without a relationship. */
export const SKILLS_MANAGE = 'skills.manage';

/** Assigning learning. Required for the two actions that write through the learning module. */
export const LEARNING_ASSIGN = 'learning.assign';

/** Reading the open-role catalogue. Required for the mobility section and its action. */
export const ROLES_VIEW = 'roles.view';

/**
 * THE DEEP TIER, AND IT IS GRANTED TO NO BUILT-IN ROLE.
 *
 * Holding it is necessary and not sufficient: see the depth boundary in the header. It is
 * catalogued in the permission registry so that an administrator can see the key exists and read
 * what it means before granting it to anybody, which is the opposite of a key that only appears in
 * code.
 */
export const FOUNDATIONAL = 'people.intelligence.foundational';

// =================================================================================================
// CONSENT
// =================================================================================================

/**
 * Consent for a foundational-computation read.
 *
 * THIS MODULE OWNS NO CONSENT TABLE. Consent is scattered across this codebase today — hr-bgv.ts
 * records it for background checks, mail-contacts.ts for messaging, live-egress.ts for streaming —
 * and a fourth private copy here would be a fourth place for it to be withdrawn and not honoured.
 *
 * So this is an INTERFACE with a default implementation that answers NO. `no consent on record` is
 * the correct and safe answer on a platform that has no consent registry for this purpose, and it
 * is a complete answer rather than a stub: the section renders `no_consent` and says what would be
 * needed. Whoever builds the consent registry registers a reader here and nothing else changes.
 */
export interface ConsentReader {
  id: string;
  /** Resolve consent for one subject and one purpose. Must never throw; return the refusal. */
  read(input: { employeeId: string; purpose: string }): Promise<
    { granted: true; consentRecordId: string; expiresAt: string | null }
    | { granted: false; sentence: string }
  >;
}

let CONSENT: ConsentReader | null = null;

export function registerConsentReader(r: ConsentReader): void {
  CONSENT = r;
}

export function consentReader(): ConsentReader | null {
  return CONSENT;
}

/** Exported for the test that proves the platform ships with no consent reader registered. */
export function clearConsentReader(): void {
  CONSENT = null;
}

const NO_CONSENT_REGISTRY =
  'There is no consent registry on this platform for foundational computation, so no consent can '
  + 'be on record for anybody. The absence is the answer, not a gap in the check: without a '
  + 'recorded, unexpired consent naming this purpose, this section is not read for anyone.';

async function resolveConsent(
  employeeId: string,
  purpose: string,
): Promise<{ granted: boolean; consentRecordId: string | null; sentence: string }> {
  const reader = CONSENT;
  if (!reader) {
    return { granted: false, consentRecordId: null, sentence: NO_CONSENT_REGISTRY };
  }
  try {
    const answer = await reader.read({ employeeId, purpose });
    if (answer.granted) {
      return {
        granted: true,
        consentRecordId: answer.consentRecordId,
        sentence: 'Consent is on record'
          + (answer.expiresAt ? ', and expires ' + answer.expiresAt + '.' : ' and does not expire.'),
      };
    }
    return { granted: false, consentRecordId: null, sentence: answer.sentence };
  } catch (e: any) {
    logFail('consent', e);
    return {
      granted: false,
      consentRecordId: null,
      sentence: 'Consent could not be checked: ' + reasonOf(e)
        + '. A check that did not run is treated as consent that is not on record.',
    };
  }
}

// =================================================================================================
// THE DECISION
// =================================================================================================

export interface SectionDecision {
  section: SectionKey;
  granted: boolean;
  /** Why, in the vocabulary of the three layers: a relationship, a capability, or the depth tier. */
  because: string;
}

export interface ActionDecision {
  kind: HrActionKind;
  granted: boolean;
  because: string;
}

export interface HrIntelAccess {
  /** Can this viewer open the view at all. Everything below is meaningless when false. */
  mayOpen: boolean;
  depth: IntelligenceDepth;
  /** Why the depth is what it is. Always a sentence, including when it is the deeper tier. */
  depthReason: string;
  /** The consent row that permitted a foundational read. Null in every other case. */
  consentRecordId: string | null;
  sections: SectionDecision[];
  granted: SectionKey[];
  withheld: { section: SectionKey; because: string }[];
  actions: ActionDecision[];
  grantedActions: HrActionKind[];
  /** The capability that actually opened the door, recorded on the access row. */
  capabilityUsed: string | null;
  sentence: string;
}

export interface AccessInput {
  viewer: PerfViewer;
  subjectEmployeeId: string;
  /** The caller's wildcard-aware capability test — composeWorkspace().holds. */
  holds: (key: string) => boolean;
  /**
   * Why this person's record is being opened, typed by the viewer for this read.
   * Required. Purpose limitation with an optional purpose is a placeholder.
   */
  purpose: string;
  /** Set only when the viewer explicitly asked for the deeper tier. Never a default. */
  requestFoundational?: boolean;
}

/**
 * Resolve, before any data is read, exactly what this viewer may see of this person and what they
 * may do about it.
 */
export async function resolveHrIntelAccess(input: AccessInput): Promise<HrIntelAccess> {
  const ask = (key: string): boolean => {
    try { return input.holds(key) === true; } catch { return false; }
  };

  const hrDesk = ask(HR_DESK);
  const person360 = ask(PERSON_360);
  const perfDesk = ask(PERF_MANAGE);
  const skillsDesk = ask(SKILLS_MANAGE);
  const learningDesk = ask(LEARNING_ASSIGN);
  const rolesDesk = ask(ROLES_VIEW);
  const deepKey = ask(FOUNDATIONAL);

  const isSelf = !!input.viewer.employeeId && input.viewer.employeeId === input.subjectEmployeeId;

  // THE RELATIONSHIP QUESTION, ASKED ONCE, PER ROW, OF THE MODULE THAT OWNS IT.
  let responsible = false;
  if (!isSelf && input.subjectEmployeeId) {
    try {
      responsible = await canSeePerformanceOf(input.viewer, input.subjectEmployeeId);
    } catch (e: any) {
      logFail('relationship', e);
      responsible = false;
    }
  }

  const mayOpen = hrDesk || person360;

  // -----------------------------------------------------------------------------------------------
  // THE DOOR
  //
  // THIS IS NOT THE MANAGER VIEW. A manager reading their own report's day-to-day work is Patch 14,
  // through a relationship, on a different screen. This screen is the HR desk's reading of a
  // person's development record across the whole organization, and a reporting relationship does
  // not open it — otherwise every team lead would hold the people desk's view of their reports by
  // virtue of the org chart, which nobody decided.
  //
  // SELF DOES NOT OPEN IT EITHER. An employee's own development record is their portal, written for
  // them; this one is written for somebody deciding what to do about them, and the two are not the
  // same document. That is a deliberate refusal and it is stated rather than left to be discovered.
  // -----------------------------------------------------------------------------------------------
  if (!mayOpen) {
    const because = isSelf
      ? 'This is your own record, and your own development record lives on your portal, written for '
        + 'you. This screen is the people desk\'s working view and is not the same document.'
      : responsible
        ? 'The Organization Graph records you as answering for this person\'s work, which opens the '
          + 'manager view of their delivery. It does not open the people desk\'s development record: '
          + 'that needs ' + HR_DESK + ' or ' + PERSON_360 + '.'
        : 'Opening one person\'s HR intelligence record needs ' + HR_DESK + ' or ' + PERSON_360 + '. '
          + 'Nothing was read.';
    return {
      mayOpen: false,
      depth: 'actionable',
      depthReason: 'No view was assembled, so no depth applies.',
      consentRecordId: null,
      sections: SECTION_KEYS.map((s) => ({ section: s, granted: false, because })),
      granted: [],
      withheld: SECTION_KEYS.map((s) => ({ section: s, because })),
      actions: HR_ACTION_KINDS.map((k) => ({ kind: k, granted: false, because })),
      grantedActions: [],
      capabilityUsed: null,
      sentence: because,
    };
  }

  // -----------------------------------------------------------------------------------------------
  // DEPTH
  // -----------------------------------------------------------------------------------------------
  let depth: IntelligenceDepth = 'actionable';
  let depthReason =
    'The people desk view is actionable intelligence. Foundational computation detail is a separate '
    + 'capability and was not requested.';
  let consentRecordId: string | null = null;

  if (input.requestFoundational) {
    if (!deepKey) {
      depthReason = 'Foundational computation detail needs ' + FOUNDATIONAL + ', which you do not '
        + 'hold. Holding the people desk key does not confer it, and that is the point of it being '
        + 'a separate key.';
    } else if (!clean(input.purpose, 400)) {
      depthReason = 'Foundational computation detail needs a stated purpose for this particular '
        + 'read. A saved setting is not a purpose.';
    } else {
      const consent = await resolveConsent(input.subjectEmployeeId, clean(input.purpose, 400));
      if (!consent.granted) {
        depthReason = consent.sentence;
      } else {
        depth = 'foundational';
        consentRecordId = consent.consentRecordId;
        depthReason = 'You hold ' + FOUNDATIONAL + ', you stated a purpose for this read, and '
          + consent.sentence.charAt(0).toLowerCase() + consent.sentence.slice(1);
      }
    }
  }

  // -----------------------------------------------------------------------------------------------
  // SECTIONS
  // -----------------------------------------------------------------------------------------------
  const hrWord = 'You hold ' + HR_DESK + ', which reaches every employee record without a relationship.';
  const p360Word = 'You hold ' + PERSON_360 + '.';
  const relWord = 'The Organization Graph records you as answering for this person\'s work.';
  const openWord = hrDesk ? hrWord : p360Word;

  const decisions: SectionDecision[] = [];
  const decide = (section: SectionKey, arms: { ok: boolean; word: string }[], needed: string) => {
    const hit = arms.find((a) => a.ok);
    decisions.push({
      section,
      granted: !!hit,
      because: hit
        ? hit.word
        : 'Withheld. ' + sectionLabel(section) + ' needs ' + needed + '. '
          + (input.viewer.initialized
            ? ''
            : 'The Organization Graph has not been set up yet, so no relationship can be confirmed '
              + 'for anybody — that is not the same as you having none. ')
          + 'The query that would have carried it was never issued.',
    });
  };

  const openArm = { ok: true, word: openWord };
  const perfArm = { ok: perfDesk, word: 'You hold ' + PERF_MANAGE + '.' };
  const skillArm = { ok: skillsDesk, word: 'You hold ' + SKILLS_MANAGE + '.' };
  const relArm = { ok: responsible, word: relWord };
  const rolesArm = { ok: rolesDesk, word: 'You hold ' + ROLES_VIEW + '.' };
  const hrArm = { ok: hrDesk, word: hrWord };

  decide('role_status', [openArm], 'the people desk key');
  decide('development_needs', [openArm], 'the people desk key');
  decide('skill_gaps', [hrArm, skillArm, relArm], SKILLS_MANAGE + ', ' + HR_DESK + ' or a reporting relationship');
  decide('training', [openArm], 'the people desk key');
  decide('feedback', [hrArm, perfArm, relArm], PERF_MANAGE + ', ' + HR_DESK + ' or a reporting relationship');
  decide('behaviour_trends', [openArm], 'the people desk key');
  decide('promotion_readiness', [hrArm, perfArm, relArm], PERF_MANAGE + ', ' + HR_DESK + ' or a reporting relationship');
  decide('mobility', [rolesArm, hrArm], ROLES_VIEW + ' or ' + HR_DESK);
  decide('interventions', [hrArm], HR_DESK);
  decide('org_development', [hrArm], HR_DESK);

  const granted = decisions.filter((d) => d.granted).map((d) => d.section);
  const withheld = decisions.filter((d) => !d.granted).map((d) => ({ section: d.section, because: d.because }));

  // -----------------------------------------------------------------------------------------------
  // ACTIONS
  //
  // An action is granted by the key of the module that OWNS the write, never by the key that opened
  // this screen. Assigning a course is the learning module's act and asks the learning module's
  // question; if this view granted it on the strength of the people desk key, this view would have
  // quietly widened who may assign learning to everybody in the organization.
  // -----------------------------------------------------------------------------------------------
  const actions: ActionDecision[] = [];
  const decideAction = (kind: HrActionKind, ok: boolean, needed: string, word: string) => {
    actions.push({
      kind,
      granted: ok,
      because: ok ? word : actionLabel(kind) + ' needs ' + needed + ', which you do not hold.',
    });
  };

  decideAction('request_feedback', hrDesk, HR_DESK, hrWord);
  decideAction('initiate_development_plan', hrDesk, HR_DESK, hrWord);
  decideAction('assign_training', learningDesk, LEARNING_ASSIGN + ' (the learning module owns assignments)',
    'You hold ' + LEARNING_ASSIGN + '.');
  decideAction('schedule_review', learningDesk, LEARNING_ASSIGN + ' (the training calendar owns scheduling)',
    'You hold ' + LEARNING_ASSIGN + '.');
  decideAction('record_intervention', hrDesk, HR_DESK, hrWord);
  decideAction('initiate_mobility_review', hrDesk && rolesDesk, HR_DESK + ' and ' + ROLES_VIEW,
    'You hold ' + HR_DESK + ' and ' + ROLES_VIEW + '.');

  const grantedActions = actions.filter((a) => a.granted).map((a) => a.kind);

  return {
    mayOpen: true,
    depth,
    depthReason,
    consentRecordId,
    sections: decisions,
    granted,
    withheld,
    actions,
    grantedActions,
    capabilityUsed: hrDesk ? HR_DESK : PERSON_360,
    sentence: 'You may see ' + granted.length + ' of ' + SECTION_KEYS.length + ' sections of this '
      + 'person\'s HR intelligence record'
      + (withheld.length ? '; the rest are named as withheld and were never read. ' : '. ')
      + 'You may take ' + grantedActions.length + ' of ' + HR_ACTION_KINDS.length + ' actions.',
  };
}

// =================================================================================================
// THE ACCESS ROW
// =================================================================================================

export interface AccessRecordResult {
  ok: boolean;
  id: string | null;
  error: string | null;
}

/**
 * Write the access row. THE VIEW IS NOT ASSEMBLED UNTIL THIS SUCCEEDS.
 *
 * The purpose is required and is not defaulted here: a caller that has no purpose to state has not
 * been given one by a person, and inventing "routine review" on their behalf is exactly the record
 * that makes an audit meaningless.
 */
export async function recordAccess(input: {
  viewerUserId: string | null;
  viewerName: string | null;
  subjectEmployeeId: string;
  depth: IntelligenceDepth;
  purpose: string;
  sectionsGranted: readonly string[];
  sectionsWithheld: readonly string[];
  capabilityUsed: string | null;
}): Promise<AccessRecordResult> {
  const purpose = clean(input.purpose, 600);
  if (!purpose) {
    return {
      ok: false,
      id: null,
      error: 'A purpose is required before this record can be opened. Purpose limitation with an '
        + 'optional purpose is a placeholder, so this is refused rather than defaulted.',
    };
  }

  const state = await ensureHrIntelSchema();
  if (!state.ok) {
    return {
      ok: false,
      id: null,
      error: 'The access log could not be prepared, so this record was not opened: '
        + (state.error || 'unknown reason')
        + '. An unlogged read of a person\'s development record is not offered as a fallback.',
    };
  }

  try {
    const r = await db.execute(sql`
      INSERT INTO hri_access_log
        (viewer_user_id, viewer_name, subject_employee_id, depth, purpose,
         sections_granted, sections_withheld, capability_used)
      VALUES
        (${input.viewerUserId}, ${clean(input.viewerName, 200) || null}, ${input.subjectEmployeeId},
         ${input.depth}, ${purpose},
         ${JSON.stringify(input.sectionsGranted || [])}::jsonb,
         ${JSON.stringify(input.sectionsWithheld || [])}::jsonb,
         ${input.capabilityUsed})
      RETURNING id`);
    const rows = rowsOf(r);
    const id = rows.length ? String((rows[0] as any).id) : null;
    if (!id) {
      return {
        ok: false,
        id: null,
        error: 'The access log insert returned no row, so the read was not recorded and the record '
          + 'was not opened.',
      };
    }
    return { ok: true, id, error: null };
  } catch (e: any) {
    // NEVER SWALLOWED. A bare catch here would be an unlogged read reported as a logged one.
    logFail('recordAccess', e);
    return {
      ok: false,
      id: null,
      error: 'The access could not be recorded: ' + reasonOf(e)
        + '. The record was not opened, because a read of a person\'s development record that '
        + 'nobody can trace is the thing this log exists to prevent.',
    };
  }
}

export interface AccessRow {
  id: string;
  viewerUserId: string | null;
  viewerName: string | null;
  depth: string;
  purpose: string;
  sectionsGranted: string[];
  sectionsWithheld: string[];
  capabilityUsed: string | null;
  accessedAt: string | null;
}

export type AccessHistory =
  | { ok: true; rows: AccessRow[] }
  | { ok: false; reason: string };

/**
 * Who has opened this person's record. Offered so the history is readable rather than merely
 * written — a log nobody can read is a log nobody can check.
 */
export async function accessHistory(employeeId: string, limit = 50): Promise<AccessHistory> {
  const state = await ensureHrIntelSchema();
  if (!state.ok) {
    return { ok: false, reason: 'The access log is not available: ' + (state.error || 'unknown reason') };
  }
  try {
    const cap = Math.max(1, Math.min(200, Math.floor(limit) || 50));
    const r = await db.execute(sql`
      SELECT id, viewer_user_id, viewer_name, depth, purpose,
             sections_granted, sections_withheld, capability_used, accessed_at
        FROM hri_access_log
       WHERE subject_employee_id = ${employeeId}
       ORDER BY accessed_at DESC
       LIMIT ${cap}`);
    const rows = rowsOf(r).map((x: any) => ({
      id: String(x.id),
      viewerUserId: x.viewer_user_id ? String(x.viewer_user_id) : null,
      viewerName: x.viewer_name ? String(x.viewer_name) : null,
      depth: String(x.depth || 'actionable'),
      purpose: String(x.purpose || ''),
      sectionsGranted: Array.isArray(x.sections_granted) ? x.sections_granted.map(String) : [],
      sectionsWithheld: Array.isArray(x.sections_withheld) ? x.sections_withheld.map(String) : [],
      capabilityUsed: x.capability_used ? String(x.capability_used) : null,
      accessedAt: x.accessed_at ? new Date(x.accessed_at).toISOString() : null,
    }));
    return { ok: true, rows };
  } catch (e: any) {
    logFail('accessHistory', e);
    return { ok: false, reason: 'The access history could not be read: ' + reasonOf(e) };
  }
}
