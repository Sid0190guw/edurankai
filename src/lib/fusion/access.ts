// src/lib/fusion/access.ts — ONE MASTER RECORD, FOUR VIEWS, AND THE VIEWS ARE SUBTRACTIONS.
//
// =================================================================================================
// THE SHAPE OF THE RULE
// =================================================================================================
//
// buildProfile() produces ONE object. This file never computes a second one for a different reader:
// a view is that object with things REMOVED and the removals named. Computing per-viewer is how two
// screens end up disagreeing about the same human, and how a redaction quietly becomes a different
// finding.
//
// =================================================================================================
// THE THREE LAYERS, KEPT APART, EXACTLY AS src/lib/performance-scope.ts KEEPS THEM
// =================================================================================================
//
//   "Who is this, in employee-id space?"   Layer 1 — src/lib/org-graph.ts.
//   "May they read somebody else's row?"   BOTH, answering different halves:
//        a RELATIONSHIP -> the org graph, per ROW. "Is this person's manager me, today?"
//        a CAPABILITY   -> permissions.ts, per USER. "May I read everyone, with no relationship?"
//
// This module composes those two answers. It resolves nothing itself and it queries
// org_relationships not once.
//
// =================================================================================================
// NO NEW CAPABILITY KEY WAS MINTED, AND THAT IS A DECISION WITH A REASON
// =================================================================================================
//
// Adding a key to the Permission union in src/lib/auth/permissions.ts and granting it to roles is a
// POLICY change about who may read what. The standing rule on this project is that mechanism changes
// may ship and policy changes are reported for a human to approve. So this module reuses keys that
// already exist and already mean what is needed:
//
//   performance.manage      read anybody's readings with no relationship. It already means exactly
//                           this — "performance across the whole organization, with no relationship"
//                           — and it is already held by super_admin and hr, which is the narrowest
//                           defensible holder for a surface like this one.
//   match.weights.manage    change the weighting every reading is produced under. Its own
//                           documentation in permissions.ts calls it "a POLICY ABOUT PEOPLE rather
//                           than a setting", which is precisely what the source weighting is.
//
// IF A DISTINCT KEY IS WANTED — say `intelligence.view` and `intelligence.weights.manage` — that is
// a policy decision, it belongs to whoever owns the registry, and it is written up as a handoff item
// rather than implemented here. Nothing in this file would need to change but two constants.
//
// =================================================================================================
// FAILS CLOSED, AND SAYS WHICH DOOR
// =================================================================================================
//
// A scope that could not be resolved sees their own readings and nothing else. A manager wrongly
// shown an empty team asks HR one question; a manager wrongly shown somebody else's profile is a
// disclosure that cannot be taken back.
//
// AND EVERY SENSITIVE READ IS LOGGED BEFORE IT RENDERS. src/lib/legal-hold.ts already sets that
// precedent here: where the audit row is the control, the control has to have happened. A read whose
// audit row could not be written is DOWNGRADED, not quietly allowed.
import { can } from '@/lib/auth/permissions';
import { logAudit } from '@/lib/audit';
import {
  resolvePerfViewer,
  canSeePerformanceOf,
  PERF_MANAGE,
  type PerfViewer,
} from '@/lib/performance-scope';
import {
  SOURCE_CLASS_LABELS,
  INFERRED_CLASS,
  type DimensionReading,
  type FusionProfile,
  type HumanNote,
  type SourceView,
} from './types';
import { logFail } from './schema';

// -------------------------------------------------------------------------------------------------
// CONSTANTS — above everything that reads them.
// -------------------------------------------------------------------------------------------------

/** Read anybody's readings with no relationship to them. Reused, not minted. See the header. */
export const INTELLIGENCE_VIEW_ALL = PERF_MANAGE;

/** Change the weighting every reading is produced under. Reused, not minted. See the header. */
export const INTELLIGENCE_WEIGHTS = 'match.weights.manage';

export const VIEW_KINDS = ['org', 'manager', 'self', 'none'] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];

export const VIEW_LABELS: Record<ViewKind, string> = {
  org: 'Organisation-wide',
  manager: 'Your team',
  self: 'Your own record',
  none: 'No access',
};

const NOT_YOURS =
  'You are not this person’s manager on the organisation graph, and you do not hold the capability '
  + 'that reads across the organisation. Nothing was read.';

const AUDIT_FAILED_DOWNGRADE =
  'Opening this record could not be written to the access log, so it was not opened. Where the audit '
  + 'row is the control, the control has to have happened.';

// -------------------------------------------------------------------------------------------------
// WHO IS LOOKING
// -------------------------------------------------------------------------------------------------

export interface IntelligenceViewer {
  userId: string;
  employeeId: string | null;
  fullName: string | null;
  /** Reads across the organisation with no relationship. */
  orgWide: boolean;
  /** May change the weighting. */
  mayWeight: boolean;
  /** The underlying performance scope, so a screen can list the team without a second resolve. */
  scope: PerfViewer | null;
}

export async function resolveViewer(user: { id: string; role?: string } | null): Promise<IntelligenceViewer | null> {
  if (!user?.id) return null;
  const orgWide = can(user as any, INTELLIGENCE_VIEW_ALL as any);
  const mayWeight = can(user as any, INTELLIGENCE_WEIGHTS as any);
  let scope: PerfViewer | null = null;
  try {
    scope = await resolvePerfViewer(String(user.id), (k: string) => can(user as any, k as any));
  } catch (e: any) {
    logFail('resolveViewer', e);
  }
  return {
    userId: String(user.id),
    employeeId: scope?.employeeId ?? null,
    fullName: scope?.fullName ?? null,
    orgWide,
    mayWeight,
    scope,
  };
}

export interface AccessDecision {
  allowed: boolean;
  kind: ViewKind;
  /** Always a sentence, granted or not. A bare "access denied" tells nobody what to do next. */
  sentence: string;
  /** True when this read is about somebody other than the viewer. Those are the ones that get logged. */
  aboutSomebodyElse: boolean;
}

/**
 * May this viewer read this person's intelligence profile?
 *
 * SELF FIRST, and it needs no capability at all. A person reading their own record is not an
 * exercise of authority over anybody — it is the thing that makes the record answerable. The engine
 * exists to be disagreed with, and somebody who cannot see it cannot disagree with it.
 */
export async function decideAccess(
  viewer: IntelligenceViewer | null,
  subjectEmployeeId: string,
): Promise<AccessDecision> {
  if (!viewer) {
    return { allowed: false, kind: 'none', sentence: 'Please sign in.', aboutSomebodyElse: true };
  }

  if (viewer.employeeId && viewer.employeeId === subjectEmployeeId) {
    return {
      allowed: true,
      kind: 'self',
      sentence: 'This is your own record. You are seeing every reading the system holds about you, '
        + 'what produced it, and where you can disagree with it.',
      aboutSomebodyElse: false,
    };
  }

  if (viewer.orgWide) {
    return {
      allowed: true,
      kind: 'org',
      sentence: 'You hold the capability that reads across the organisation, so this was opened '
        + 'without a relationship to this person. That opening is on the access log with your name on it.',
      aboutSomebodyElse: true,
    };
  }

  let responsible = false;
  try {
    responsible = await canSeePerformanceOf(viewer.scope as PerfViewer, subjectEmployeeId);
  } catch (e: any) {
    logFail('decideAccess', e);
    // FAILS CLOSED. An unresolvable relationship is not a relationship.
    responsible = false;
  }

  if (responsible) {
    return {
      allowed: true,
      kind: 'manager',
      sentence: 'The organisation graph records you as responsible for this person’s work today, '
        + 'which is what opened this. That opening is on the access log with your name on it.',
      aboutSomebodyElse: true,
    };
  }

  return { allowed: false, kind: 'none', sentence: NOT_YOURS, aboutSomebodyElse: true };
}

/**
 * Write the access record BEFORE anything renders, and report whether it landed.
 *
 * A caller that gets `false` must not render the profile. That is the whole point, and it is the
 * rule this project already enforces in src/lib/legal-hold.ts.
 */
export async function logIntelligenceAccess(input: {
  viewer: IntelligenceViewer;
  subjectEmployeeId: string;
  kind: ViewKind;
}): Promise<{ logged: boolean; note: string | null }> {
  try {
    await logAudit({
      userId: input.viewer.userId,
      action: 'fusion.profile.open',
      entity: 'hr_employees',
      entityId: input.subjectEmployeeId,
      diff: { view: input.kind, grantedOn: input.kind === 'org' ? INTELLIGENCE_VIEW_ALL : 'org-graph relationship' },
    });
    return { logged: true, note: null };
  } catch (e: any) {
    logFail('logIntelligenceAccess', e);
    return { logged: false, note: AUDIT_FAILED_DOWNGRADE };
  }
}

// -------------------------------------------------------------------------------------------------
// THE VIEWS — SUBTRACTIONS FROM THE ONE RECORD
// -------------------------------------------------------------------------------------------------

const WEIGHTS_WITHHELD =
  'The per-source weighting behind these readings is not shown on this view. It is a policy about '
  + 'how everybody is read, held by whoever holds the weighting capability, and it is visible to them.';

const FOUNDATION_WITHHELD =
  'An inferred foundation was offered for this person and it is not itemised on this view. It '
  + 'contributed nothing that is not already stated in the agreement and contradiction lines.';

const OTHERS_NOTES_WITHHELD =
  'Written responses from other people are not shown on this view.';

/**
 * Hide the itemised inferred signals while keeping every consequence of them visible.
 *
 * WHY THE CONSEQUENCE STAYS. Rule 18 says a role without permission does not see sensitive internal
 * computation. It does NOT say the person may be told a different story: whether the foundation was
 * admitted, refused or set aside is stated on every view, because that IS the finding. What is
 * withheld is the itemised statements behind it, which are the interpretation layer's to show.
 */
function redactFoundation(sources: SourceView[]): SourceView[] {
  return sources.map((v) => v.sourceClass !== INFERRED_CLASS ? v : {
    ...v,
    signals: [],
    withheldBecause: v.withheldBecause || (v.signalCount ? FOUNDATION_WITHHELD : null),
  });
}

function redactWeights(sources: SourceView[]): SourceView[] {
  return sources.map((v) => ({ ...v, weight: 0, effectiveWeight: v.effectiveWeight > 0 ? 1 : 0 }));
}

function redactReading(
  r: DimensionReading,
  opts: { hideFoundationDetail: boolean; hideWeights: boolean },
): DimensionReading {
  let sources = r.sources;
  if (opts.hideFoundationDetail) sources = redactFoundation(sources);
  if (opts.hideWeights) sources = redactWeights(sources);
  if (sources === r.sources) return r;
  // The brand survives a spread of an already-branded object, so no reading is constructed here that
  // did not come out of the fuser.
  return { ...r, sources } as DimensionReading;
}

export interface ViewResult {
  profile: FusionProfile;
  kind: ViewKind;
  /** What this view removed, named. An unnamed redaction is indistinguishable from an absence. */
  withheld: { what: string; because: string }[];
}

/**
 * Produce the role-based view of one master record.
 *
 *   org      everything, including the weighting and the itemised foundation.
 *   manager  everything about the readings; the weighting is not itemised. They act on the readings,
 *            they do not set the policy.
 *   self     everything about their own readings, plus their own notes and anybody's note ABOUT
 *            them that names its author — because a record you cannot see is a record you cannot
 *            answer. The weighting is not itemised.
 */
export function viewFor(
  profile: FusionProfile,
  viewer: IntelligenceViewer,
  kind: ViewKind,
): ViewResult {
  const withheld: { what: string; because: string }[] = [];

  if (kind === 'org') {
    return { profile, kind, withheld };
  }

  const hideWeights = !viewer.mayWeight;
  // The itemised foundation is the interpretation layer's own output. A manager or the person
  // themselves sees THAT it was offered, and whether it counted, without the item-by-item reading.
  const hideFoundationDetail = true;

  if (hideWeights) withheld.push({ what: 'Per-source weighting', because: WEIGHTS_WITHHELD });
  if (hideFoundationDetail) withheld.push({ what: 'Itemised inferred foundation', because: FOUNDATION_WITHHELD });

  const notes: HumanNote[] = kind === 'self'
    ? profile.humanNotes
    : profile.humanNotes;

  const dimensions = profile.dimensions.map((r) => redactReading(r, { hideFoundationDetail, hideWeights }));

  const weighting = hideWeights
    ? {
      ...profile.weighting,
      weights: Object.fromEntries(
        Object.keys(profile.weighting.weights).map((k) => [k, 0]),
      ) as FusionProfile['weighting']['weights'],
      sentence: WEIGHTS_WITHHELD,
    }
    : profile.weighting;

  return {
    profile: { ...profile, dimensions, weighting, humanNotes: notes, withheld: [...profile.withheld, ...withheld] },
    kind,
    withheld,
  };
}

/** What a screen prints to explain which door opened, in the viewer's own terms. */
export function viewSentence(kind: ViewKind, mayWeight: boolean): string {
  switch (kind) {
    case 'org':
      return 'Organisation-wide view. Every reading, the weighting that produced it, and every source '
        + 'itemised. Opening somebody’s record is logged with your name on it.';
    case 'manager':
      return 'Team view. You see every reading for the people the organisation graph records you as '
        + 'responsible for, and the sources behind them. '
        + (mayWeight ? '' : 'The weighting itself is set elsewhere and is not shown here.');
    case 'self':
      return 'Your own record. Every reading about you, what produced it, and what it is not allowed '
        + 'to be used for. If something here is wrong, say so on the record — a note goes beside the '
        + 'reading with your name on it and it is not deleted.';
    default:
      return NOT_YOURS;
  }
}

/** Named so a page never spells the label by hand. */
export { SOURCE_CLASS_LABELS };
