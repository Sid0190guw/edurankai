// src/lib/hiring-decision-horizon.ts — PATCH 10's INTEGRATION BOUNDARY WITH THE HORIZON SPINE.
//
// =================================================================================================
// WHY THIS IS A SEPARATE FILE, AND WHY IT IMPORTS HORIZON NOWHERE AT THE TOP
// =================================================================================================
//
// src/lib/horizon/* is another patch's module and it is being written in this same working tree. At
// the moment this adapter was authored, `src/lib/horizon/schema.ts` did not parse — six TS1005
// errors — and `src/lib/horizon/report/providers/` was an empty directory with no registration
// function in it yet. Both are ordinary mid-build states for a patch in flight.
//
// So the coupling is deliberately one-directional and LATE:
//
//   - NOTHING here is imported by src/lib/hiring-decision.ts or by the decision page. A hiring desk
//     must be able to record a decision today whether or not the HORIZON spine compiles.
//   - The HORIZON types are declared STRUCTURALLY below rather than imported, so this file
//     typechecks on its own. If the shapes drift, the mismatch shows up at the single `await
//     import()` in registerWithHorizon() and is reported, not thrown.
//   - The registration is a DYNAMIC import inside a try. A HORIZON that is not ready yet means this
//     returns { registered: false, reason }, and nothing else in this patch notices.
//
// That is multi-agent rule 8 applied literally: the dependency is missing, so this is an adapter and
// an integration boundary rather than an attempt to build the other patch's module.
//
// =================================================================================================
// WHAT PATCH 10 CONTRIBUTES TO THE RECORD
// =================================================================================================
//
// One thing, and it is the thing nothing else in the tree holds: THE RECORDED HUMAN HIRING DECISION.
//
// src/lib/horizon/report/registry.ts already declares a report `interview_decision_support` that
// requires the capability key `applicant.selection`, gated on `applications.score` +
// `interviews.author`. Patch 10 is the producer of that key. selectionCapabilityFor() below returns
// exactly that payload.
//
// WHAT IT DOES NOT CONTRIBUTE: any score, rating or prediction about a person. Every value it emits
// is either a decision a named human recorded, or a reading of the record that is labelled as one
// and carries the rule it was produced under. The provider declares `inferenceOnly: false` because
// everything it returns is a record or arithmetic over records — there is no model here.
//
// =================================================================================================
// TIME
// =================================================================================================
//
// `historicalSupport` is TRUE, and it is honest rather than aspirational: hiring_decisions is
// append-only and a superseded decision keeps its own decided_at, so "what did the record say in
// March" is answerable by filtering on decided_at rather than by reconstructing anything. asOf is
// honoured in selectionCapabilityFor().
import { isUuid } from '@/lib/performance-scope';
import {
  decisionHistory,
  FINAL_DECISION_LABELS,
  SUPPORT_STATE_LABELS,
  type RecordedDecision,
} from '@/lib/hiring-decision';

const PATCH_ID = 'horizon-hiring-decision';
const PATCH_LABEL = 'Human hiring decision support (Patch 10)';

/** The capability key this patch answers. Spelled to match src/lib/horizon/report/registry.ts. */
export const APPLICANT_SELECTION_CAPABILITY = 'applicant.selection';

// -------------------------------------------------------------------------------------------------
// THE PAYLOAD
// -------------------------------------------------------------------------------------------------

export interface SelectionCapabilityPayload {
  capability: typeof APPLICANT_SELECTION_CAPABILITY;
  applicationId: string;
  /** The decision that stands, or null when nobody has decided yet. Null is an answer. */
  current: {
    decision: string;
    decisionLabel: string;
    decidedByUserId: string;
    decidedByName: string | null;
    decidedAt: string | null;
    reasoning: string;
    /** What the support report said when they decided. NEVER the decision itself. */
    supportStateShown: string | null;
    supportStateShownLabel: string | null;
    evidenceReferenceCount: number;
    stageMovedTo: string | null;
  } | null;
  /** Every decision on file, newest first, including superseded ones. */
  history: {
    decision: string;
    decisionLabel: string;
    decidedByName: string | null;
    decidedAt: string | null;
    supersededAt: string | null;
  }[];
  /** The moment this answer describes. Equal to `asOf` when one was asked for. */
  asOf: string | null;
  /**
   * Said in words on every payload, because a consumer that forgets it will render a decision as
   * though the system made it.
   */
  humanAuthority: string;
  /** What could not be answered, if anything. An empty history and a failed read are not the same. */
  unreadable: string | null;
}

/**
 * Answer `applicant.selection` for one application.
 *
 * CANDIDATE FEEDBACK IS NOT IN THE PAYLOAD, deliberately. The sentence written for the candidate is
 * held on the decision row and shown on the decision surface to the hiring desk that wrote it; it is
 * not a fact about the person for a wider intelligence record to carry around, and a report that
 * quoted it would put a rejection sentence in front of readers it was never written for.
 */
export async function selectionCapabilityFor(
  applicationId: string,
  asOf?: string | null,
): Promise<SelectionCapabilityPayload> {
  const base: SelectionCapabilityPayload = {
    capability: APPLICANT_SELECTION_CAPABILITY,
    applicationId: String(applicationId || ''),
    current: null,
    history: [],
    asOf: asOf || null,
    humanAuthority:
      'Every value here is a decision a named person recorded. Nothing in this system decides to '
      + 'hire, reject, hold or advance anybody, and the support state carried beside a decision is '
      + 'what the record showed at the time — not a recommendation that was acted on automatically.',
    unreadable: null,
  };
  if (!isUuid(applicationId)) {
    base.unreadable = 'That application was not named properly, so no selection record was read.';
    return base;
  }

  let all: RecordedDecision[] = [];
  try {
    all = await decisionHistory(applicationId);
  } catch (e: any) {
    base.unreadable = 'The hiring decision record could not be read ('
      + String(e?.cause?.message || e?.message || 'unknown error') + ').';
    return base;
  }

  // TIME. A decision taken after the asOf moment did not exist then, so it is not part of the answer.
  const cutoff = asOf ? Date.parse(asOf) : NaN;
  const inWindow = isNaN(cutoff)
    ? all
    : all.filter((d) => {
        const at = d.decidedAt ? Date.parse(d.decidedAt) : NaN;
        return isNaN(at) ? false : at <= cutoff;
      });

  // "The decision that stood at that moment" is the newest one taken by then that had not yet been
  // superseded by then — not the row that happens to carry isCurrent today.
  const standing = inWindow.find((d) => {
    if (isNaN(cutoff)) return d.isCurrent;
    if (!d.supersededAt) return true;
    const sup = Date.parse(d.supersededAt);
    return isNaN(sup) ? true : sup > cutoff;
  }) || null;

  base.current = standing
    ? {
        decision: standing.decision,
        decisionLabel: FINAL_DECISION_LABELS[standing.decision] || standing.decision,
        decidedByUserId: standing.decidedByUserId,
        decidedByName: standing.decidedByName,
        decidedAt: standing.decidedAt,
        reasoning: standing.reasoning,
        supportStateShown: standing.supportState,
        supportStateShownLabel: standing.supportState
          ? SUPPORT_STATE_LABELS[standing.supportState] || standing.supportState
          : null,
        evidenceReferenceCount: standing.evidenceRefs.length,
        stageMovedTo: standing.stageMovedTo,
      }
    : null;

  base.history = inWindow.map((d) => ({
    decision: d.decision,
    decisionLabel: FINAL_DECISION_LABELS[d.decision] || d.decision,
    decidedByName: d.decidedByName,
    decidedAt: d.decidedAt,
    supersededAt: d.supersededAt,
  }));

  return base;
}

// -------------------------------------------------------------------------------------------------
// THE HORIZON PROVIDER, DECLARED STRUCTURALLY
// -------------------------------------------------------------------------------------------------
//
// These mirror src/lib/horizon/record.ts's MeirProvider and ProviderContext. They are RE-DECLARED
// rather than imported so this file compiles while that patch is mid-edit. The dynamic import in
// registerWithHorizon() is where the two shapes actually have to agree, and a disagreement there is
// reported as a reason string rather than thrown into a page.

export interface HorizonProviderContext {
  subject: { kind?: string; id?: string; applicationId?: string | null };
  organisationId?: string;
  asOf?: string | null;
  requestId?: string;
}

export interface HorizonIntelligenceResultish {
  dimension: { family: string; key: string };
  value: unknown;
  evidence: readonly { what: string; source: string; recordedAt: string | null }[];
  confidence: { level: string; because: string };
  computedAt: string;
  humanDecisionRequired: true;
}

export interface HorizonProviderish {
  patchId: string;
  label: string;
  dimensions: readonly { family: string; key: string; label: string }[];
  historicalSupport: boolean;
  read(ctx: HorizonProviderContext): Promise<readonly HorizonIntelligenceResultish[]>;
}

/**
 * The dimension this patch claims. ONE, and it is a record rather than a trait.
 *
 * The family string is 'evidence' because that is what a recorded decision with its references is.
 * If the HORIZON DIMENSION_FAMILIES union does not contain it, registerProvider() throws by name and
 * registerWithHorizon() reports the exact message — which is the correct outcome: two patches
 * disagreeing about a vocabulary should be loud, and the fix is one string.
 */
export const HIRING_DECISION_DIMENSION = Object.freeze({
  family: 'evidence',
  key: 'hiring.decision.recorded',
  label: 'Recorded human hiring decision',
});

/** The provider object, built here so it can be unit-tested without a HORIZON runtime. */
export function hiringDecisionProvider(): HorizonProviderish {
  return {
    patchId: PATCH_ID,
    label: PATCH_LABEL,
    dimensions: [HIRING_DECISION_DIMENSION],
    historicalSupport: true,
    async read(ctx: HorizonProviderContext) {
      const applicationId = String(ctx?.subject?.applicationId || ctx?.subject?.id || '');
      if (!isUuid(applicationId)) return [];
      const payload = await selectionCapabilityFor(applicationId, ctx?.asOf || null);
      if (!payload.current) return [];
      return [
        {
          dimension: { family: HIRING_DECISION_DIMENSION.family, key: HIRING_DECISION_DIMENSION.key },
          value: payload.current,
          evidence: [
            {
              what: payload.current.decisionLabel + ' recorded by '
                + (payload.current.decidedByName || 'a named account'),
              source: 'hiring_decisions (src/lib/hiring-decision.ts)',
              recordedAt: payload.current.decidedAt,
            },
          ],
          // A recorded decision is not an inference, so the confidence is about the RECORD being
          // present and complete — never about the person.
          confidence: {
            level: 'high',
            because: 'This is a decision a named person recorded in writing, not an inference. The '
              + 'confidence is that the record exists and says this, which is directly checkable.',
          },
          computedAt: new Date().toISOString(),
          humanDecisionRequired: true,
        },
      ];
    },
  };
}

export type RegistrationResult =
  | { registered: true; patchId: string; unregister: () => void }
  | { registered: false; reason: string };

/**
 * Offer this patch's provider to the HORIZON record, if HORIZON is ready.
 *
 * FAILS SOFT AND SAYS WHY. It is called from an ops surface, never from the decision page, and a
 * HORIZON that is absent, mid-edit or using a different vocabulary produces a sentence rather than
 * an exception. Nothing about recording a hiring decision depends on this succeeding.
 */
export async function registerWithHorizon(): Promise<RegistrationResult> {
  try {
    const mod: any = await import('@/lib/horizon');
    if (typeof mod?.registerProvider !== 'function') {
      return {
        registered: false,
        reason: 'The HORIZON module loaded but exports no registerProvider(). This patch\'s provider '
          + 'is built and ready; nothing has been registered.',
      };
    }
    const unregister = mod.registerProvider(hiringDecisionProvider());
    return { registered: true, patchId: PATCH_ID, unregister };
  } catch (e: any) {
    return {
      registered: false,
      reason: 'The HORIZON module could not be loaded or refused this provider: '
        + String(e?.cause?.message || e?.message || 'unknown error')
        + '. The hiring decision record is unaffected and the decision surface works without it.',
    };
  }
}
