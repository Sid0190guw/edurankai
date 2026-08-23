// src/lib/horizon/access.ts — WHO MAY OPEN WHICH TAB, DECIDED BEFORE ANYTHING IS READ.
//
// =================================================================================================
// THE ORDER MATTERS AND IT IS NOT NEGOTIABLE
// =================================================================================================
//
//   1. resolve who the person is (the id graph, and nothing else)
//   2. resolve which tabs this viewer may open
//   3. write the access log for every sensitive tab, and CHECK IT LANDED
//   4. only then read anything
//
// Step 3 before step 4 is the rule src/lib/legal-hold.ts already enforces on this project: the audit
// row IS the control, so a sensitive section whose access could not be recorded does not render. A
// screen that shows a colleague's behaviour reading while the record of who looked at it failed to
// write is worse than a screen that shows nothing, because the second one is honest about it.
//
// This module does no fetch-then-hide. A withheld section is not read and then blanked; it is not
// read. `resolveHorizonAccess()` is pure and synchronous precisely so that it can run before the
// first query and be tested without a database.
//
// =================================================================================================
// THIS IS NOT A SECOND AUTHORIZATION SYSTEM
// =================================================================================================
//
// `holds` is passed IN. This module imports no authorization engine, resolves no role and reads no
// grant table. It asks the question the console already answers (`can(user, key)`) and turns the
// answer into a per-tab decision with a sentence attached. The three-layer rule on this project
// keeps Authorization one layer; a module that started resolving its own capabilities would be a
// second one.
// =================================================================================================

import type { HorizonSectionKey, MeirSubject } from './contracts';
import {
  HORIZON_SECTIONS,
  PROPOSED_CAPABILITY_MEANING,
  sectionDef,
  type HorizonSectionDef,
} from './sections';

// -------------------------------------------------------------------------------------------------
// TYPES
// -------------------------------------------------------------------------------------------------

export interface HorizonViewer {
  userId: string;
  employeeId: string | null;
  role: string;
  name: string | null;
}

export type GrantOutcome = 'granted' | 'withheld' | 'awaiting_ratification';

export interface SectionGrant {
  section: HorizonSectionKey;
  outcome: GrantOutcome;
  granted: boolean;
  /** The capability the decision turned on, or null for the roll-up tab. */
  capability: string | null;
  /** Why, in one sentence, printed on the tab. */
  because: string;
  sensitive: boolean;
  /** Set once the access log write has been attempted. */
  accessLogged: boolean;
  accessLogNote: string | null;
}

export interface HorizonAccess {
  viewer: HorizonViewer;
  subject: MeirSubject;
  grants: SectionGrant[];
  granted: HorizonSectionKey[];
  withheld: HorizonSectionKey[];
  awaitingRatification: HorizonSectionKey[];
  /** Whether this viewer may see anything at all. */
  anyGranted: boolean;
  /** The sentence at the top of the page. */
  sentence: string;
  /** True when the viewer is looking at their own record. Printed; it changes no grant. */
  isSelf: boolean;
}

// -------------------------------------------------------------------------------------------------
// THE DECISION
// -------------------------------------------------------------------------------------------------

const SELF_NOTE = 'This is your own record. That does not widen what you may see here — the same capabilities apply — but it is worth knowing you are reading yourself.';

function grantFor(
  def: HorizonSectionDef,
  holds: (key: string) => boolean,
  otherGrantedCount: () => number,
): SectionGrant {
  const base = {
    section: def.key,
    capability: def.capability,
    sensitive: def.sensitive,
    accessLogged: false,
    accessLogNote: null as string | null,
  };

  // The roll-up tab. It reads nothing of its own and shows only what other granted tabs surfaced,
  // so gating it on a capability of its own would be gating a view of things already shown.
  if (def.capability === null) {
    const n = otherGrantedCount();
    return {
      ...base,
      outcome: n > 0 ? 'granted' : 'withheld',
      granted: n > 0,
      because: n > 0
        ? 'This lists only the signals the ' + n + ' section(s) you were already granted surfaced. It reads nothing of its own.'
        : 'You were granted no section, so there are no signals to roll up. Nothing was read.',
    };
  }

  let ok = false;
  try {
    ok = holds(def.capability) === true;
  } catch {
    // A holds() that throws is a broken composition, not a grant. Fail closed.
    ok = false;
  }

  if (ok) {
    return {
      ...base,
      outcome: 'granted',
      granted: true,
      because: 'You hold ' + def.capability + '.',
    };
  }

  if (def.proposed) {
    return {
      ...base,
      outcome: 'awaiting_ratification',
      granted: false,
      because:
        'This tab is behind ' + def.capability + ', which does not exist in the permission registry yet, '
        + 'so it answers no for every role including super admin. Nothing was read. '
        + 'Ratifying it would permit: ' + (PROPOSED_CAPABILITY_MEANING[def.capability] || 'see the patch handoff document.'),
    };
  }

  return {
    ...base,
    outcome: 'withheld',
    granted: false,
    because:
      'Withheld. This tab needs ' + def.capability + ' and you do not hold it. Nothing was read, and nothing here '
      + 'says the record is empty.',
  };
}

/**
 * Decide every tab, before any read. Pure: no database, no session lookup, no clock.
 *
 * `holds` is the caller's wildcard-aware capability test — `(k) => can(user, k)` in the admin
 * console. An invented key answers false for every role, which is what puts the three proposed tabs
 * into `awaiting_ratification` rather than quietly open.
 */
export function resolveHorizonAccess(
  viewer: HorizonViewer,
  subject: MeirSubject,
  holds: (key: string) => boolean,
): HorizonAccess {
  // Two passes, because the roll-up tab's answer depends on the others. The first pass skips it.
  const first: SectionGrant[] = [];
  for (const def of HORIZON_SECTIONS) {
    if (def.capability === null) continue;
    first.push(grantFor(def, holds, () => 0));
  }
  const grantedCount = first.filter((g) => g.granted).length;

  const grants: SectionGrant[] = HORIZON_SECTIONS.map((def) => {
    if (def.capability === null) return grantFor(def, holds, () => grantedCount);
    return first[first.findIndex((g) => g.section === def.key)];
  });

  const granted = grants.filter((g) => g.granted).map((g) => g.section);
  const withheld = grants.filter((g) => g.outcome === 'withheld').map((g) => g.section);
  const awaiting = grants.filter((g) => g.outcome === 'awaiting_ratification').map((g) => g.section);

  const isSelf =
    (!!subject.employeeId && subject.employeeId === viewer.employeeId)
    || (!!subject.userId && subject.userId === viewer.userId);

  const parts: string[] = [];
  if (granted.length === 0) {
    parts.push('You may not open any part of this profile. Nothing was read.');
  } else {
    parts.push('You may open ' + granted.length + ' of ' + HORIZON_SECTIONS.length + ' sections.');
    if (withheld.length) {
      parts.push(withheld.length + ' are withheld and were never read.');
    }
    if (awaiting.length) {
      parts.push(
        awaiting.length + ' are switched off for everybody until a capability is ratified — the tab names which one.',
      );
    }
  }
  if (isSelf) parts.push(SELF_NOTE);

  return {
    viewer,
    subject,
    grants,
    granted,
    withheld,
    awaitingRatification: awaiting,
    anyGranted: granted.length > 0,
    sentence: parts.join(' '),
    isSelf,
  };
}

export function grantOf(access: HorizonAccess, section: HorizonSectionKey): SectionGrant {
  const g = access.grants.find((x) => x.section === section);
  if (g) return g;
  const def = sectionDef(section);
  return {
    section,
    outcome: 'withheld',
    granted: false,
    capability: def ? def.capability : null,
    because: 'No decision was recorded for this section, so it is treated as withheld.',
    sensitive: !!def && def.sensitive,
    accessLogged: false,
    accessLogNote: null,
  };
}

// -------------------------------------------------------------------------------------------------
// THE ACCESS LOG — RULE 17, AND THE ORDER IT HAS TO HAPPEN IN
// -------------------------------------------------------------------------------------------------

/** The audit entity every row this module writes is filed under. One name, so the trail is findable. */
export const HORIZON_AUDIT_ENTITY = 'horizon_profile';
export const ACTION_PROFILE_OPEN = 'horizon.profile.open';
export const ACTION_SECTION_VIEW = 'horizon.section.view';
export const ACTION_DRILL = 'horizon.drill';

export interface AccessLogOutcome {
  logged: boolean;
  note: string | null;
}

/**
 * Record that this viewer opened this profile. Best-effort: the page-level row is context, not the
 * control, and a logging hiccup must not take the whole screen down.
 */
export async function logProfileOpen(input: {
  viewer: HorizonViewer;
  subject: MeirSubject;
  grantedSections: HorizonSectionKey[];
  ipAddress?: string | null;
}): Promise<AccessLogOutcome> {
  try {
    const { logAudit } = await import('@/lib/audit');
    const r = await logAudit({
      userId: input.viewer.userId || null,
      action: ACTION_PROFILE_OPEN,
      entity: HORIZON_AUDIT_ENTITY,
      entityId: input.subject.employeeId || input.subject.userId || input.subject.personKey || undefined,
      diff: {
        // Deliberately NOT the person's values. Who looked, at whom, and which tabs — nothing about
        // the person themselves goes into the audit diff, because audit_log has a wider read
        // audience than several of the sections it is recording access to.
        subject_employee_id: input.subject.employeeId,
        subject_user_id: input.subject.userId,
        sections_opened: input.grantedSections,
        viewer_role: input.viewer.role,
      },
      ipAddress: input.ipAddress || undefined,
    });
    return r.ok
      ? { logged: true, note: null }
      : { logged: false, note: 'The record of you opening this page could not be written: ' + (r.error || 'unknown reason') };
  } catch (e: any) {
    return {
      logged: false,
      note: 'The record of you opening this page could not be written: ' + (e?.cause?.message || e?.message || String(e)),
    };
  }
}

/**
 * Record access to ONE SENSITIVE SECTION, and say whether it landed.
 *
 * The caller must treat `logged: false` as a refusal to render that section. That is the whole
 * reason this returns a value instead of being fire-and-forget.
 */
export async function logSensitiveSectionAccess(input: {
  viewer: HorizonViewer;
  subject: MeirSubject;
  section: HorizonSectionKey;
  capability: string | null;
  ipAddress?: string | null;
}): Promise<AccessLogOutcome> {
  try {
    const { logAudit } = await import('@/lib/audit');
    const r = await logAudit({
      userId: input.viewer.userId || null,
      action: ACTION_SECTION_VIEW,
      entity: HORIZON_AUDIT_ENTITY,
      entityId: input.subject.employeeId || input.subject.userId || input.subject.personKey || undefined,
      diff: {
        section: input.section,
        granted_on: input.capability,
        subject_employee_id: input.subject.employeeId,
        viewer_role: input.viewer.role,
      },
      ipAddress: input.ipAddress || undefined,
    });
    if (r.ok) return { logged: true, note: null };
    return {
      logged: false,
      note:
        'This section is sensitive, so it renders only once the record of you opening it has been written — '
        + 'and that write failed (' + (r.error || 'unknown reason') + '). Nothing was read.',
    };
  } catch (e: any) {
    return {
      logged: false,
      note:
        'This section is sensitive, so it renders only once the record of you opening it has been written — '
        + 'and that write failed (' + (e?.cause?.message || e?.message || String(e)) + '). Nothing was read.',
    };
  }
}

/** Record a drill-down. One row per step, so "who followed this to the source record" is answerable. */
export async function logDrill(input: {
  viewer: HorizonViewer;
  subject: MeirSubject;
  section: HorizonSectionKey;
  rung: string;
  targetId: string | null;
}): Promise<AccessLogOutcome> {
  try {
    const { logAudit } = await import('@/lib/audit');
    const r = await logAudit({
      userId: input.viewer.userId || null,
      action: ACTION_DRILL,
      entity: HORIZON_AUDIT_ENTITY,
      entityId: input.subject.employeeId || input.subject.userId || undefined,
      diff: { section: input.section, rung: input.rung, target: input.targetId },
    });
    return r.ok ? { logged: true, note: null } : { logged: false, note: r.error || 'unknown reason' };
  } catch (e: any) {
    return { logged: false, note: e?.cause?.message || e?.message || String(e) };
  }
}
