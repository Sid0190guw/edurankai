// src/lib/intelligence/sources.ts — THE I/O EDGE. EVERY READ THE PERSONAL VIEW MAKES, IN ONE PLACE.
//
// =================================================================================================
// WHY THE READS ARE SEPARATED FROM THE COMPOSITION
// =================================================================================================
//
// self-view.ts decides what a person is told about themselves and is a pure function. This file is
// the only place that talks to a database, and it does exactly two things: call the modules that own
// each record, and NARROW what comes back to the fields the composer is allowed to see.
//
// The narrowing is the point. feedbackFor() returns the note body and the author's name; the bundle
// this file hands the composer carries a theme and a date. An author identity cannot leak out of a
// summary that never received one, and no future edit to the composer can widen that, because the
// widening would have to happen here, in a file whose whole job is visible in one screen.
//
// =================================================================================================
// EVERY READ IS INDEPENDENT, AND A FAILURE IS A FACT ABOUT ONE SOURCE
// =================================================================================================
//
// Ten reads, run together, each with its own ok flag. One that fails marks its own source unreadable
// and the other nine still render. The alternative — one try/catch around the lot — turns a hiccup
// in the certificate table into a page that tells somebody they have no skills.
//
// They run through Promise.allSettled rather than Promise.all: allSettled is what makes "this one
// source failed" survivable, where all() would reject the whole bundle on the first failure and
// hand the page nothing.
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { buildDigitalTwin } from '@/lib/digital-twin';
import { jobRequirements } from '@/lib/job-twin';
import { listGoals } from '@/lib/goals';
import { myTasksView } from '@/lib/employee-tasks';
import { listEvidenceForEmployee } from '@/lib/eims-evidence';
import { feedbackFor } from '@/lib/performance';
import { learningPathFor } from '@/lib/performance-learning';
import type { PerfViewer } from '@/lib/performance-scope';
import { hasConsent } from './consent';
import { reflectionSummary } from './reflection';
import { composeSelfIntelligence, type SelfIntelligence, type SelfSources } from './self-view';

const MOD = 'intelligence/sources';
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const logFail = (tag: string, e: any) =>
  console.error('[' + MOD + '] ' + tag, e?.cause?.message || e?.message || e);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const iso = (v: any): string | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
};

/** Unwrap an allSettled result into a value plus whether the read actually happened. */
function settled<T>(r: PromiseSettledResult<T>, fallback: T, tag: string): { ok: boolean; value: T } {
  if (r.status === 'fulfilled') return { ok: true, value: r.value };
  logFail(tag, r.reason);
  return { ok: false, value: fallback };
}

/* ================================================================================================
 * THE ROLE LINK
 * ============================================================================================= */

export interface RoleLink {
  ok: boolean;
  roleId: string | null;
  roleTitle: string | null;
}

/**
 * WHICH ROLE'S REQUIREMENTS APPLY TO THIS PERSON, AND HOW HONESTLY WE KNOW IT.
 *
 * hr_employees carries a `designation` — free text somebody typed — and NO role_id. So there is no
 * direct link from an employee to a row in `roles`, and matching the designation string against role
 * titles would be exactly the keyword-as-proof failure job-twin.ts refuses to make on the job side.
 *
 * The one real link is the hiring path: hr_employees.application_id -> applications.role_id -> roles.
 * That is a recorded fact, not a guess. Its LIMIT is that it names the role the person was hired
 * into, which may not be the role they hold now — so the section that uses it says so in words
 * rather than presenting a stale comparison as a current one.
 *
 * Where there is no application link, this returns roleId null and the section reports that nothing
 * connects the record to a role. That is a gap in the organisation's data, and it is described as
 * one.
 */
export async function roleLinkFor(employeeId: string): Promise<RoleLink> {
  if (!isUuid(employeeId)) return { ok: true, roleId: null, roleTitle: null };
  try {
    const r = rowsOf(await db.execute(sql`
      SELECT a.role_id, ro.title
        FROM hr_employees e
        JOIN applications a ON a.id = e.application_id
        LEFT JOIN roles ro ON ro.id = a.role_id
       WHERE e.id = ${employeeId}::uuid
       LIMIT 1`))[0];
    const roleId = r?.role_id ? String(r.role_id) : null;
    return { ok: true, roleId, roleTitle: r?.title ? String(r.title) : null };
  } catch (e: any) {
    logFail('roleLinkFor', e);
    return { ok: false, roleId: null, roleTitle: null };
  }
}

/* ================================================================================================
 * THE BUNDLE
 * ============================================================================================= */

export interface SelfViewInput {
  employeeId: string;
  userId: string;
  viewer: PerfViewer;
  /** The composed workspace's wildcard-aware capability test. Passed in; never resolved here. */
  holds: (key: string) => boolean;
  /** Injected so the view is deterministic in tests. Defaults to now. */
  now?: string;
}

/**
 * Read everything the personal view needs, narrowed to what the composer may see.
 *
 * THE VIEWER IS THE SUBJECT, ALWAYS. buildDigitalTwin() is called with this person as both viewer
 * and subject, so twinAccess() grants on the "it is you" arm and nothing here depends on the reader
 * holding an HR capability. A caller that passed somebody else's employeeId would be building a
 * different person's twin under this person's grants, so the two ids are checked against each other
 * before any read is issued.
 */
export async function loadSelfSources(input: SelfViewInput): Promise<SelfSources> {
  const now = input.now || new Date().toISOString();
  const employeeId = String(input.employeeId || '');
  const userId = String(input.userId || '');

  const empty: SelfSources = {
    now,
    skills: { ok: true, rows: [] },
    competencies: { ok: true, rows: [] },
    certifications: { ok: true, rows: [] },
    roleRequirements: { ok: true, roleLinked: false, roleLabel: null, rows: [] },
    learning: { ok: true, rows: [] },
    goals: { ok: true, rows: [] },
    tasks: { ok: true, rows: [] },
    evidence: { ok: true, rows: [] },
    feedback: { ok: true, rows: [] },
    reflections: { ok: true, count: 0, latestAt: null },
    suggestionsAllowed: false,
  };

  if (!isUuid(employeeId)) return empty;

  // THE SUBJECT AND THE VIEWER MUST BE THE SAME PERSON. This surface has exactly one reader and it
  // is the person it is about; a mismatch is a programming error, not a permission question, and it
  // returns an empty bundle rather than composing anything.
  if (input.viewer.employeeId && input.viewer.employeeId !== employeeId) {
    logFail('subject-mismatch', new Error('viewer.employeeId does not match the subject employeeId'));
    return empty;
  }

  const roleLink = await roleLinkFor(employeeId);

  const [
    twinR, learningR, goalsR, tasksR, evidenceR, feedbackR, reflectionR, requirementsR, consentR,
  ] = await Promise.allSettled([
    buildDigitalTwin({ employeeId, userId }, input.viewer, input.holds),
    learningPathFor(employeeId),
    listGoals(employeeId, { includePrivate: true, limit: 100 }),
    myTasksView(employeeId, 200),
    listEvidenceForEmployee(employeeId, { limit: 200 }),
    feedbackFor(employeeId, { limit: 200 }),
    reflectionSummary(employeeId),
    roleLink.roleId ? jobRequirements('role', roleLink.roleId) : Promise.resolve([]),
    hasConsent(employeeId, 'development_suggestions'),
  ]);

  const twin = settled(twinR, null as any, 'digital-twin');
  const learning = settled(learningR, [] as any[], 'learning');
  const goals = settled(goalsR, [] as any[], 'goals');
  const tasks = settled(tasksR, { ok: false, tasks: [] } as any, 'tasks');
  const evidence = settled(evidenceR, [] as any[], 'evidence');
  const feedback = settled(feedbackR, [] as any[], 'feedback');
  const reflections = settled(reflectionR, { ok: false, count: 0, latestAt: null } as any, 'reflections');
  const requirements = settled(requirementsR, [] as any[], 'requirements');
  const consent = settled(consentR, false, 'consent');

  // An aspect the twin names as UNREADABLE is not the same as an aspect that came back empty, and
  // the twin already keeps them apart. Honour that here rather than flattening both to "no rows".
  const twinUnreadable = new Set<string>(
    (twin.value?.unreadable || []).map((u: any) => String(u.aspect)),
  );
  const twinOk = (aspect: string) => twin.ok && !!twin.value && !twinUnreadable.has(aspect);

  return {
    now,

    skills: {
      ok: twinOk('skills'),
      rows: (twin.value?.skills || []).map((r: any) => ({
        name: String(r.skillName || ''),
        level: Number(r.level) || 0,
        levelLabel: String(r.levelLabel || ''),
        assertion: String(r.provenance?.assertion || 'provided'),
        basis: String(r.provenance?.basis || ''),
        recordedAt: iso(r.provenance?.recordedAt),
      })).filter((r: any) => !!r.name),
    },

    competencies: {
      ok: twinOk('competencies'),
      rows: (twin.value?.competencies || []).map((c: any) => ({
        name: String(c.name || ''),
        dimension: String(c.dimension || ''),
        status: String(c.status || ''),
        // A NAMED PERSON, NOT A NAME. Whether somebody signed it off is what the section reports;
        // who they were is not carried past this line.
        verifiedByNamedPerson: !!c.verifiedByUserId,
        recordedAt: iso(c.provenance?.recordedAt),
      })).filter((c: any) => !!c.name),
    },

    certifications: {
      ok: twinOk('certifications'),
      rows: (twin.value?.certifications || []).map((c: any) => ({
        certNumber: String(c.certNumber || ''),
        courseTitle: c.courseTitle ? String(c.courseTitle) : null,
        issuedAt: iso(c.issuedAt),
      })),
    },

    roleRequirements: {
      ok: roleLink.ok && requirements.ok,
      roleLinked: !!roleLink.roleId,
      roleLabel: roleLink.roleTitle,
      rows: (requirements.value || []).map((r: any) => ({
        skillName: String(r.skillName || ''),
        necessity: String(r.necessity || 'required'),
        minLevel: Number(r.minLevel) || 3,
      })).filter((r: any) => !!r.skillName),
    },

    learning: {
      ok: learning.ok,
      rows: (learning.value || []).map((l: any) => ({
        courseTitle: String(l.courseTitle || ''),
        required: l.required === true,
        dueOn: l.dueOn ? String(l.dueOn) : null,
        completedAt: iso(l.completedAt),
        progressPct: l.progressPct === null || l.progressPct === undefined ? null : Number(l.progressPct),
      })),
    },

    goals: {
      ok: goals.ok,
      rows: (goals.value || []).map((g: any) => ({
        title: String(g.title || ''),
        status: String(g.status || ''),
        progressPct: Number(g.progressPct) || 0,
        lastProgressAt: iso(g.lastProgressAt),
        targetDate: g.targetDate ? String(g.targetDate) : null,
      })),
    },

    tasks: {
      // myTasksView carries its own ok, which distinguishes "no tasks" from "the read failed" —
      // exactly the distinction this bundle exists to preserve. Both it and the settle must hold.
      ok: tasks.ok && tasks.value?.ok === true,
      rows: (tasks.value?.tasks || []).map((t: any) => ({
        title: String(t.title || ''),
        state: String(t.state || t.status || ''),
        createdAt: iso(t.createdAt),
        completedAt: iso(t.completedAt),
        isOverdue: t.isOverdue === true,
      })),
    },

    evidence: {
      ok: evidence.ok,
      rows: (evidence.value || []).map((e: any) => ({
        title: String(e.title || ''),
        occurredOn: String(e.occurredOn || ''),
        status: String(e.status || ''),
        hoursVerified: Number(e.hoursVerified) || 0,
        reviewedAt: iso(e.reviewedAt),
      })),
    },

    feedback: {
      ok: feedback.ok,
      // THEME AND DATE. NOTHING ELSE CROSSES THIS LINE — not the body, not the author, not the
      // author's user id, not whether it was visible to a manager.
      rows: (feedback.value || []).map((f: any) => ({
        theme: String(f.theme || 'general'),
        createdAt: iso(f.createdAt),
      })),
    },

    reflections: {
      ok: reflections.value?.ok !== false,
      count: Number(reflections.value?.count) || 0,
      latestAt: reflections.value?.latestAt || null,
    },

    // A FAILED CONSENT READ IS NOT A GRANT.
    suggestionsAllowed: consent.ok && consent.value === true,
  };
}

/** Load and compose in one call. The page uses this; the tests use composeSelfIntelligence directly. */
export async function buildSelfIntelligence(input: SelfViewInput): Promise<SelfIntelligence> {
  const sources = await loadSelfSources(input);
  return composeSelfIntelligence(sources);
}
