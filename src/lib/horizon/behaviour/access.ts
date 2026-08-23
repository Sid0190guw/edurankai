// src/lib/behaviour/access.ts — PATCH 04: who may read a behavioural profile, on what ground, and why.
//
// NOTHING IN THIS PATCH READS A ROW ABOUT A PERSON UNTIL THIS FILE HAS SAID YES AND THE ACCESS LOG
// HAS SAID IT WROTE. That order is not a preference. `src/lib/legal-hold.ts` already establishes it
// on this codebase — logAccess() must succeed BEFORE anything renders — and the reason is that an
// access log which fails silently is indistinguishable from no access log at all, on exactly the
// screens where somebody would later need to prove who looked.
//
// =================================================================================================
// THE THREE LAYERS, KEPT APART — and this file is where the distinction gets tested
// =================================================================================================
//
//   ORGANIZATION  resolves PER ROW, from the org graph: is this viewer THIS person's reporting
//                 manager. It is asked of `org_relationships` and never inferred from a role.
//   AUTHORIZATION resolves PER USER: does the account hold a capability. It answers "across the
//                 organisation, with no relationship", which is why holding one is not, and must
//                 never become, a way of being somebody's manager.
//   WORKFLOW      is not in this file at all.
//
// Merging them is the specific failure the standing rule exists to prevent: `performance.manage`
// says in the registry that it "makes nobody anybody's manager", and a gate here that admitted its
// holders as managers would quietly make that sentence false everywhere it is printed.
//
// =================================================================================================
// THE TWO CAPABILITY KEYS, AND WHY THIS PATCH DOES NOT EDIT THE REGISTRY
// =================================================================================================
//
// `hasPermission(userId, key)` takes `key: string`, and `resolvePermissions()` unions the built-in
// role grants with everything an admin has granted a custom role in `role_permissions`. So a key
// declared HERE is checkable immediately and grantable through the existing admin surface, WITHOUT
// this patch editing `Permission` in src/lib/auth/permissions.ts or PERMS_BY_ROLE.
//
// That restraint is deliberate. Adding a key to PERMS_BY_ROLE decides which roles hold it, and that
// is a POLICY change — the standing rule on this project is that mechanism may ship and policy needs
// explicit approval. The exact BUILTIN_PERMISSIONS entries for the Authorization owner to add, when
// approved, are in docs/behavioural-intelligence.md and in REGISTRY_ENTRIES below. Until then these
// keys are held by nobody except super_admin, which holds them through the wildcard.
import type { AccessBasis, AccessDecision, BehaviourPurpose } from './types';
import { BEHAVIOUR_PURPOSES } from './types';
import { hasPermission } from '@/lib/auth/registry';
import { isReportingManager, getHeadedDepartmentIds } from '@/lib/org-graph';
import { resolveEmployeeIdentity } from '@/lib/workforce/identity';
import { logAudit, logAuditOrThrow } from '@/lib/audit';
import { sql } from 'drizzle-orm';

let _db: any = null;
async function database(): Promise<any> {
  if (!_db) _db = (await import('@/lib/db')).db;
  return _db;
}

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const logFail = (tag: string, e: any) =>
  console.error('[behaviour/access] ' + tag, e?.cause?.message || e?.message);

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Read anyone's behavioural profile, across the organisation, with no relationship to them. */
export const CAP_BEHAVIOUR_VIEW_ORG = 'behaviour.view_org';

/** Read the profiles of people in a department this account heads. Still resolved per row. */
export const CAP_BEHAVIOUR_VIEW_DEPARTMENT = 'behaviour.view_department';

/**
 * The registry entries the Authorization owner adds when the policy is approved. Kept here as data
 * so the handoff and the code cannot drift, and so nothing has to be retyped from a document.
 */
export const REGISTRY_ENTRIES = {
  [CAP_BEHAVIOUR_VIEW_ORG]: {
    label: 'Read working-pattern summaries for anyone',
    group: 'People',
    sensitive: true,
    description:
      'Open the recorded working patterns of any employee: how quickly assigned work was accepted and picked up, how often it was completed by its due date, how often submitted work came back for changes, and how those have moved over a named period. Every figure arrives with the rows behind it, how many records it rests on, what could not be read and what it could not establish. It is not a productivity measure, it reads no attendance, location, message or health data, it never compares one person against another, and nothing behind it decides anything: a human reads it, may disagree with every line, and decides.',
  },
  [CAP_BEHAVIOUR_VIEW_DEPARTMENT]: {
    label: 'Read working-pattern summaries inside a department you head',
    group: 'People',
    sensitive: true,
    description:
      'The same assembled view as the organisation-wide key, limited to people in a department this account heads as of today, resolved from the Organization Graph one person at a time. Holding it makes the holder nobody’s manager and grants nothing outside those departments. A reporting manager reads their own reports through the reporting line and needs neither key.',
  },
} as const;

/**
 * WHICH PURPOSES EACH GROUND ADMITS. Purpose limitation, enforced rather than recorded.
 *
 * A field that captures the purpose and accepts any value is a text box, and a text box is not a
 * limitation. Reading somebody's record "for org oversight" when the only ground for reading it is
 * that you manage them is a different act from managing them, and it is refused here.
 */
const PURPOSES_BY_BASIS: Record<AccessBasis, BehaviourPurpose[]> = {
  // A person reading their own record is exercising subject access. It is not "people management"
  // and must not be recorded as though somebody had been assessed.
  self: ['self_review'],
  reporting_manager: ['people_management', 'performance_cycle', 'workload_review'],
  department_head: ['people_management', 'performance_cycle', 'workload_review', 'org_oversight'],
  // No 'people_management': holding an org-wide key is not a relationship with anybody, and the
  // registry says so in words about every other key in its group.
  org_capability: ['performance_cycle', 'org_oversight'],
};

/**
 * ONE SENTENCE FOR EVERY REFUSAL.
 *
 * It never says whether the employee exists, whether they have any records, or what would have been
 * needed — a refusal that varies with the target turns this endpoint into a way of enumerating the
 * organisation, which is the same reasoning behind NOT_AVAILABLE in src/lib/employee-tasks.ts.
 */
const REFUSED =
  'That working-pattern summary is not available to this account. A person may always open their own; ' +
  'a reporting manager opens their own reports’; anything wider needs a capability granted for it.';

// -------------------------------------------------------------------------------------------------
// CONSENT — an interface, not somebody else's module
// -------------------------------------------------------------------------------------------------

/**
 * THE CONSENT SEAM.
 *
 * PATCH 04 does not own a consent register and must not build one — a second store of who agreed to
 * what would start agreeing with the first and end up disagreeing, and consent is the last place
 * that should happen. So this is an INTERFACE with a default, and the patch that owns consent
 * injects the real check.
 *
 * The default is written down rather than assumed: these are organisational work records, processed
 * for the management of work, and a person may always read their own. Where a deployment needs
 * explicit opt-in before a third party may read a derived profile, `setConsentCheck()` is the seam.
 *
 * AN INJECTED CHECK THAT THROWS FAILS CLOSED. A consent register that is down is not consent.
 */
export interface ConsentContext {
  subjectEmployeeId: string;
  viewerUserId: string;
  basis: AccessBasis;
  purpose: BehaviourPurpose;
}

export type BehaviourConsentCheck = (ctx: ConsentContext) => Promise<{ allowed: boolean; reason: string }>;

const defaultConsentCheck: BehaviourConsentCheck = async (ctx) => ({
  allowed: true,
  reason:
    ctx.basis === 'self'
      ? 'The subject is reading their own record.'
      : 'Processed as organisational work records for the management of work; no consent register is installed on this deployment.',
});

let consentCheck: BehaviourConsentCheck = defaultConsentCheck;

/** Install a real consent register. Pass null to return to the documented default. */
export function setConsentCheck(fn: BehaviourConsentCheck | null): void {
  consentCheck = fn || defaultConsentCheck;
}

// -------------------------------------------------------------------------------------------------
// THE GATE
// -------------------------------------------------------------------------------------------------

export interface ViewerContext {
  /** Astro.locals.user, or any object carrying id / role / isActive. */
  user: { id?: string | null; role?: string | null; isActive?: boolean | null } | null | undefined;
  /** Astro.locals, so resolvePermissions and the workspace lookup share their per-request memo. */
  locals?: any;
  ipAddress?: string;
}

/** The subject's department, for the department-head ground. One indexed read, and only when needed. */
async function subjectDepartmentId(employeeId: string): Promise<string | null> {
  try {
    const r = rows(
      await (await database()).execute(sql`
        SELECT department_id FROM hr_employees WHERE id = ${employeeId}::uuid LIMIT 1`),
    );
    const v = r[0]?.department_id;
    return v === null || v === undefined ? null : String(v);
  } catch (e: any) {
    logFail('subjectDepartmentId', e);
    return null;
  }
}

function refuse(purpose: BehaviourPurpose, reason = REFUSED): AccessDecision {
  return {
    allowed: false,
    basis: null,
    purpose,
    reason,
    logged: false,
    atIso: new Date().toISOString(),
  };
}

/**
 * MAY THIS ACCOUNT READ THIS PERSON'S BEHAVIOURAL PROFILE, FOR THIS STATED PURPOSE?
 *
 * The grounds are tried in order and the FIRST match wins, weakest-scope first: self, then the
 * reporting line, then a headed department, then the org-wide key. Ordering that way means the
 * recorded basis is the narrowest one that actually applies — a department head reading their own
 * report is logged as their manager, which is what happened, rather than as somebody exercising an
 * organisation-wide power.
 *
 * ON SUCCESS THE ACCESS LOG IS WRITTEN AND AWAITED. `logAuditOrThrow` throws when the row does not
 * land, and that throw is caught here and converted into a REFUSAL, not a warning: a read that
 * cannot be logged does not happen.
 */
export async function authoriseBehaviourRead(
  subjectEmployeeId: string,
  purpose: BehaviourPurpose,
  ctx: ViewerContext,
): Promise<AccessDecision> {
  const atIso = new Date().toISOString();

  if (!BEHAVIOUR_PURPOSES.includes(purpose)) {
    return refuse(
      'self_review',
      'A stated purpose is required, and it must be one this system recognises.',
    );
  }
  if (!UUID_RE.test(String(subjectEmployeeId || ''))) return refuse(purpose);

  const viewerUserId = String(ctx.user?.id || '').trim();
  if (!viewerUserId) return refuse(purpose, 'Sign in to open a working-pattern summary.');

  // The viewer's own employee record. Resolved through the shared identity helper so this file does
  // not become a tenth copy of the same lookup — and it costs no round trip when the workspace is
  // already memoised on this request.
  const identity = await resolveEmployeeIdentity(ctx.user as any);
  const viewerEmployeeId = identity.ok ? identity.identity.employeeId : null;

  let basis: AccessBasis | null = null;
  let relationshipSource: AccessDecision['relationshipSource'] = 'none';

  if (viewerEmployeeId && viewerEmployeeId === subjectEmployeeId) {
    basis = 'self';
  }

  if (!basis && viewerEmployeeId) {
    // PER ROW, from the graph. Not from `hr_employees.reporting_manager_id`, which this codebase
    // has established is written by zero lines of application code and therefore proves nothing.
    try {
      if (await isReportingManager(viewerEmployeeId, subjectEmployeeId)) {
        basis = 'reporting_manager';
        relationshipSource = 'graph';
      }
    } catch (e: any) {
      logFail('isReportingManager', e);
    }
  }

  if (!basis && viewerEmployeeId) {
    try {
      if (await hasPermission(viewerUserId, CAP_BEHAVIOUR_VIEW_DEPARTMENT, { locals: ctx.locals })) {
        const headed = await getHeadedDepartmentIds(viewerEmployeeId);
        if (headed.length > 0) {
          const dept = await subjectDepartmentId(subjectEmployeeId);
          // Compared as TEXT, never cast: departments.id is a varchar slug in one schema file and a
          // uuid in the other, and a cast throws on half the estate.
          if (dept && headed.some((h) => String(h).trim() === dept.trim())) {
            basis = 'department_head';
            relationshipSource = 'graph';
          }
        }
      }
    } catch (e: any) {
      logFail('departmentHeadGround', e);
    }
  }

  if (!basis) {
    try {
      if (await hasPermission(viewerUserId, CAP_BEHAVIOUR_VIEW_ORG, { locals: ctx.locals })) {
        basis = 'org_capability';
      }
    } catch (e: any) {
      logFail('orgCapabilityGround', e);
    }
  }

  if (!basis) {
    // A refusal is logged too, and on the non-throwing writer: a failed log must not turn a denial
    // into a 500, because the denial is the safe outcome and it has already been decided.
    await logAudit({
      userId: viewerUserId,
      action: 'behaviour.profile.refused',
      entity: 'hr_employee',
      entityId: subjectEmployeeId,
      diff: { purpose, reason: 'no-ground' },
      ipAddress: ctx.ipAddress,
    });
    return refuse(purpose);
  }

  if (!PURPOSES_BY_BASIS[basis].includes(purpose)) {
    await logAudit({
      userId: viewerUserId,
      action: 'behaviour.profile.refused',
      entity: 'hr_employee',
      entityId: subjectEmployeeId,
      diff: { purpose, basis, reason: 'purpose-not-permitted-for-basis' },
      ipAddress: ctx.ipAddress,
    });
    return refuse(
      purpose,
      'That reason for looking is not one this ground of access allows. Ask for the reading to be raised under a purpose that fits, or under a capability granted for it.',
    );
  }

  let consent: { allowed: boolean; reason: string };
  try {
    consent = await consentCheck({ subjectEmployeeId, viewerUserId, basis, purpose });
  } catch (e: any) {
    logFail('consentCheck', e);
    // FAIL CLOSED. A consent register that cannot answer has not answered yes.
    consent = { allowed: false, reason: 'The consent register could not be reached, so this read did not proceed.' };
  }

  if (!consent.allowed) {
    await logAudit({
      userId: viewerUserId,
      action: 'behaviour.profile.refused',
      entity: 'hr_employee',
      entityId: subjectEmployeeId,
      diff: { purpose, basis, reason: 'consent', detail: consent.reason },
      ipAddress: ctx.ipAddress,
    });
    return refuse(purpose, consent.reason);
  }

  try {
    await logAuditOrThrow({
      userId: viewerUserId,
      action: 'behaviour.profile.read',
      entity: 'hr_employee',
      entityId: subjectEmployeeId,
      diff: { purpose, basis, relationshipSource, consent: consent.reason },
      ipAddress: ctx.ipAddress,
    });
  } catch (e: any) {
    logFail('accessLog', e);
    return refuse(
      purpose,
      'This reading could not be recorded in the access log, so it did not go ahead. Try again shortly.',
    );
  }

  return {
    allowed: true,
    basis,
    purpose,
    relationshipSource,
    reason:
      basis === 'self'
        ? 'Your own record.'
        : basis === 'reporting_manager'
          ? 'You are recorded as this person’s reporting manager, resolved from the Organization Graph.'
          : basis === 'department_head'
            ? 'This person is in a department you are recorded as heading.'
            : 'Opened under an organisation-wide capability granted to this account. This is not a management relationship.',
    logged: true,
    atIso,
  };
}
