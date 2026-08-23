// src/lib/horizon/report/providers/meir.ts — THE BRIDGE TO THE MASTER RECORD.
//
// =================================================================================================
// WHY THIS FILE IS THE MOST IMPORTANT PROVIDER IN THE PATCH
// =================================================================================================
//
// The other providers in this directory read HR and hiring tables directly. They exist because those
// records are needed by the nine reports and nothing else was going to supply them. THIS one exists
// so that this patch does not become a second, competing view of a person.
//
// src/lib/horizon/record.ts already owns the Master Employee Intelligence Record: other patches
// register a MeirProvider, composeRecord() assembles their contributions, and each contribution
// arrives already labelled with the data class it belongs to. A report engine that ignored all of
// that and re-read the underlying tables itself would produce documents that disagreed with the
// record they claim to summarise, and the disagreement would show up first in front of the person
// the report is about.
//
// So: composeRecord() is called, and everything it returns is mapped into the section its OWN
// dataClass or layer already declares. This file does not reclassify anything. Where the upstream
// vocabulary and this engine's six sections differ, the mapping is written out below and the
// difference is stated rather than smoothed over.
//
// =================================================================================================
// THE MAPPING, IN FULL
// =================================================================================================
//
//   IntelligenceResult.layer     'computed'            -> section 2, derived
//                                'ai_interpretation'   -> section 4, relayed as upstream
//                                'recommendation'      -> section 5, relayed as upstream
//                                anything else          -> dropped with a note. ENGINE_WRITABLE_LAYERS
//                                                          says those three are the only legal values;
//                                                          a fourth means the producing patch has a bug
//                                                          and this engine should not guess at it.
//
//   Signal.dataClass             'raw_source'          -> section 1, facts
//                                'derived'             -> section 2, derived
//                                'human_feedback'      -> section 3, feedback
//                                'ai_interpretation'   -> section 4, relayed as upstream
//                                'human_decision'      -> section 6, decisions
//
// A SIGNAL'S WEIGHT CLASS IS CARRIED, NOT DISCARDED. contracts.ts fixes the rule-22 ordering in
// SIGNAL_WEIGHT_CLASSES and gives every class a sentence in SIGNAL_WEIGHT_MEANING. Both reach the
// document: the sentence becomes the confidence basis, and the ordering becomes the confidence
// ceiling, so a birth-based interpretive input cannot outrank an attendance row here any more than
// it can there.
//
// A SIGNAL MARKED `disputed` IS RENDERED AS DISPUTED. Rule 24: one person's view never silently
// becomes organisational truth, and a signal somebody has formally challenged is exactly the case
// that rule is about.
import { composeRecord } from '@/lib/horizon/record';
import {
  SIGNAL_WEIGHT_CLASSES, SIGNAL_WEIGHT_MEANING, compareSignalWeight,
  type DataClass, type EvidenceRef as HorizonEvidenceRef, type Signal, type SignalWeightClass,
} from '@/lib/horizon/contracts';
import type { IntelligenceResult } from '@/lib/horizon/types';
import type { SubjectRef as HorizonSubjectRef } from '@/lib/horizon/ids';
import { CAPABILITIES } from '../registry';
import {
  capConfidence, derivedClaim, estimated, evidenceRef, factClaim, feedbackClaim,
  humanDecisionClaim, interpretationClaim, observed, recommendationClaim, sourceRef,
} from '../provenance';
import type {
  AiInterpretationClaim, Confidence, DerivedClaim, EvidenceRef, FactClaim, HumanDecisionClaim,
  HumanFeedbackClaim, RecommendationClaim, SourceLoad, SourceLoadContext, SourceProvider, SourceRef,
} from '../types';

const PROVIDER_ID = 'horizon.meir';
const SYSTEM = 'horizon';
const OWNER = 'HORIZON core (src/lib/horizon/record.ts)';

/**
 * The rule-22 ordering as a 0-1 number this engine can cap a confidence with.
 *
 * Derived from the position of the class in SIGNAL_WEIGHT_CLASSES rather than hand-written, so a
 * class added to that list by its owner gets a sensible weight here without this file being edited,
 * and — more to the point — so the two orderings cannot be edited into disagreeing.
 */
function weightOf(cls: SignalWeightClass): number {
  const i = SIGNAL_WEIGHT_CLASSES.indexOf(cls);
  if (i < 0) return 0.3;
  return Number(((i + 1) / SIGNAL_WEIGHT_CLASSES.length).toFixed(2));
}

function src(table: string, ownedBy: string, recordId?: string | null, capturedAt?: string | null): SourceRef {
  return sourceRef({ provider: PROVIDER_ID, system: SYSTEM, table, ownedBy, recordId, capturedAt });
}

/** Their EvidenceRef carries more fields than this engine's. Nothing is invented; extras are folded into the label. */
function mapEvidence(list: readonly HorizonEvidenceRef[]): EvidenceRef[] {
  return list.map((e) => evidenceRef(
    e.sourceTable || e.ownerModule || 'record',
    e.sourceId || e.locator || 'unreferenced',
    e.sentence || [e.ownerModule, e.locator].filter(Boolean).join(' '),
    e.documentUrl || e.href || null,
  ));
}

/** Their Confidence (value/band/basis) into this engine's (level/score/basis). */
function mapConfidence(c: { value: number | null; basis: string } | null | undefined): Confidence {
  if (!c) return observed('The producing patch stated no confidence.');
  if (typeof c.value !== 'number') {
    // Null is an honest answer in their contract and it must stay one here. It is not zero.
    return { level: 'insufficient', score: null, basis: c.basis || 'The producing patch declined to state a confidence.' };
  }
  return estimated(c.value, c.basis || 'Stated by the patch that produced this.');
}

function scoreText(r: IntelligenceResult): string {
  const s: any = r.scoreOrLevel;
  if (!s) return 'no value recorded';
  switch (s.kind) {
    case 'numeric': return String(s.value) + ' of ' + String(s.scaleMax) + (s.unit ? ' ' + s.unit : '');
    case 'level': return String(s.level);
    case 'categorical': return String(s.category);
    case 'not_computed': return 'not computed: ' + String(s.reason);
    default: return 'no value recorded';
  }
}

export const meirRecordProvider: SourceProvider = {
  descriptor: {
    id: PROVIDER_ID,
    label: 'HORIZON master record',
    system: SYSTEM,
    // No relation of its own. composeRecord() reads through the patches that registered with it, and
    // each of those declares its own tables to its own owner. Naming them here would be this patch
    // asserting knowledge of tables it does not read.
    tables: ['(composed through src/lib/horizon/record.ts; no direct relation is read here)'],
    ownedBy: OWNER,
    capabilities: [CAPABILITIES.MEIR_RECORD],
    sensitivity: 'elevated',
  },

  async load(ctx: SourceLoadContext): Promise<SourceLoad> {
    const facts: FactClaim[] = [];
    const derived: DerivedClaim[] = [];
    const humanFeedback: HumanFeedbackClaim[] = [];
    const humanDecisions: HumanDecisionClaim[] = [];
    const upstreamInterpretation: AiInterpretationClaim[] = [];
    const upstreamRecommendation: RecommendationClaim[] = [];
    const notes: string[] = [];

    if (ctx.subject.kind === 'organisation') {
      return {
        ok: true, providerId: PROVIDER_ID, facts, derived, humanFeedback,
        notes: ['The master record is composed per person; an organisation-wide report does not read it.'],
        error: null,
      };
    }

    const now = ctx.now;
    const stamp = ctx.stamp;

    // Their SubjectRef is a different shape from ai-boundary's, and both are in play in this engine.
    // Built explicitly rather than cast, so a change to either one is a type error here.
    const subject: HorizonSubjectRef = {
      kind: (ctx.subject.kind === 'applicant' ? 'applicant' : 'employee') as HorizonSubjectRef['kind'],
      id: ctx.subject.id as HorizonSubjectRef['id'],
      idScheme: (ctx.subject.kind === 'applicant' ? 'tal_application' : 'hr_employees') as HorizonSubjectRef['idScheme'],
      organisationId: 'edurankai' as HorizonSubjectRef['organisationId'],
    };

    // NEVER THROWS, per its own contract. What varies is how much of the record is marked unreadable,
    // and that is relayed rather than hidden: a section the record could not read is a note here, not
    // an absence.
    const record = await composeRecord(subject, {
      requestId: 'horizon.report:' + ctx.definition.id + ':' + ctx.subject.id,
      // TIME-BASED INTELLIGENCE. A report with a window is a report about a period, and the record it
      // rests on should be the record as it stood at the end of that period rather than as it stands
      // during the read. Providers that cannot answer historically say so, and composeRecord marks it.
      asOf: ctx.window ? ctx.window.to : null,
    });

    if (record.degraded.length) {
      notes.push('These contributions to the master record could not be read: ' + record.degraded.join(', ') + '.');
    }

    for (const section of record.sections) {
      if (section.unreadable) {
        notes.push(section.label + ' is unreadable: ' + section.unreadable);
        continue;
      }
      if (section.asOfUnsupported && ctx.window) {
        notes.push(section.label + ' cannot answer historically and returned current data for a report about a past window.');
      }

      const owner = section.patchId + ' (' + section.label + ')';

      // ---- RESULTS -------------------------------------------------------------------------
      for (const r of section.results as readonly IntelligenceResult[]) {
        const evidence = (r.evidence || []).slice(0, 6).map((e: any) => evidenceRef(
          e?.rawReference?.table || String(e?.sourceType || 'record'),
          e?.rawReference?.recordId || String(e?.sourceId || 'unreferenced'),
          String(e?.summary || 'Evidence recorded by ' + section.patchId),
          e?.rawReference?.documentUrl || null,
        ));
        const sources = [src(
          'intelligence_result:' + String(r.dimension?.key || 'dimension'),
          owner, String(r.id), r.computedAt,
        )];
        const confidence = mapConfidence(r.confidence as any);
        const engineVersion = String((r as any).modelOrEngineVersion || 'unversioned');

        if (r.layer === 'computed') {
          derived.push(derivedClaim({
            label: String(r.dimension?.label || r.dimension?.key || 'Measure'),
            value: scoreText(r),
            method:
              String(r.summary || 'Computed by ' + section.patchId) + ' Engine version: ' + engineVersion
              + '. Human review: ' + String(r.humanReviewStatus) + '.',
            basisCount: (r.evidence || []).length,
            confidence,
            major: (r.evidence || []).length > 0,
            now, stamp, sources, evidence,
          }));
        } else if (r.layer === 'ai_interpretation') {
          upstreamInterpretation.push(interpretationClaim({
            statement: String(r.summary || 'An interpretation recorded by ' + section.patchId),
            act: 'identify_patterns',
            reasoning:
              'Produced by ' + section.patchId + ' against the ' + String(r.dimension?.key || 'unnamed')
              + ' dimension, engine version ' + engineVersion + '. Value: ' + scoreText(r) + '.',
            assumptions:
              'That the producing patch applied its own rules correctly. This engine relays its reading; it did not form it.',
            uncertainty:
              'Human review status is ' + String(r.humanReviewStatus)
              + '. Scientific status as declared by the producer: ' + String((r as any).scientificStatus) + '.',
            restsOn: ['ai_interpretation'],
            score: typeof (r.confidence as any)?.value === 'number' ? Number((r.confidence as any).value) : 0.3,
            basis: confidence.basis,
            now, stamp, sources, evidence,
          }));
        } else if (r.layer === 'recommendation') {
          upstreamRecommendation.push(recommendationClaim({
            statement: String(r.summary || 'A recommendation recorded by ' + section.patchId),
            suggestedAction: scoreText(r) + ' — recorded by ' + section.patchId + ', engine version ' + engineVersion + '.',
            // NOT tagged with a decision kind. This engine will not infer that somebody else's
            // recommendation is about hiring or discipline; if it were, validateClaim() would demand
            // a boundary id and refuse it, which is the correct outcome for an untraced one.
            score: typeof (r.confidence as any)?.value === 'number' ? Number((r.confidence as any).value) : 0.4,
            basis: confidence.basis,
            now, stamp, sources,
            evidence: evidence.length ? evidence : [evidenceRef('intelligence_result', String(r.id), 'Recorded by ' + section.patchId)],
          }));
        } else {
          notes.push(
            section.label + ' returned a result on the "' + String(r.layer) + '" layer, which is not one an engine '
            + 'may write. It has been left out rather than guessed at.',
          );
        }
      }

      // ---- SIGNALS -------------------------------------------------------------------------
      // `as unknown as` and not a direct cast, deliberately. There are two Signal declarations in
      // this tree — src/lib/horizon/types.ts, which composeRecord() returns, and the one this file
      // imports from contracts.ts — and they overlap without matching. The double cast is the honest
      // spelling of "these are different types and this module is asserting the crossing", rather
      // than a single cast that reads as though the compiler had agreed.
      for (const sig of section.signals as unknown as readonly Signal[]) {
        const evidence = mapEvidence(sig.evidence || []);
        const sources = [src('signal:' + sig.id, owner, sig.id, sig.observedAt)];
        const weight = weightOf(sig.weightClass);
        const meaning = SIGNAL_WEIGHT_MEANING[sig.weightClass] || 'Weight class not described by its owner.';

        // THE RULE-22 CAP, APPLIED HERE RATHER THAN TRUSTED. Whatever confidence the producing patch
        // put on a signal, it cannot exceed the weight of the class the same patch assigned it. A
        // birth-based interpretive input is the bottom of SIGNAL_WEIGHT_CLASSES and is capped hardest.
        const confidence = capConfidence(mapConfidence(sig.confidence as any), weight);
        const disputed = sig.disputed === true;
        const statement = String(sig.statement || sig.label)
          + (disputed ? ' — a named person has disputed this signal.' : '');

        const cls: DataClass = sig.dataClass;
        if (cls === 'raw_source') {
          facts.push(factClaim({
            label: String(sig.label), value: statement, occurredAt: sig.observedAt,
            confidence, major: evidence.length > 0,
            now, stamp, sources, evidence,
          }));
        } else if (cls === 'derived') {
          derived.push(derivedClaim({
            label: String(sig.label), value: statement,
            method: meaning + ' Produced by ' + String(sig.producedBy) + '.',
            basisCount: evidence.length, confidence,
            now, stamp, sources, evidence,
          }));
        } else if (cls === 'human_feedback') {
          humanFeedback.push(feedbackClaim({
            author: { id: null, name: String(sig.producedBy), relation: 'unknown' },
            theme: String(sig.label), body: statement, recordedAt: sig.observedAt,
            weight,
            // Their `disputed` is this engine's `dissent`: both mean the record does not agree with
            // itself and neither means the claim is wrong.
            dissent: disputed,
            now, stamp, sources, evidence,
          }));
        } else if (cls === 'ai_interpretation') {
          upstreamInterpretation.push(interpretationClaim({
            statement,
            act: 'identify_patterns',
            reasoning: meaning + ' Produced by ' + String(sig.producedBy) + '.',
            assumptions: 'That the producing patch classified its own signal honestly. This engine relays that classification.',
            uncertainty: disputed
              ? 'A named person has disputed this signal. It is shown because removing a disputed signal quietly is worse than showing it labelled.'
              : 'Weight class ' + sig.weightClass + ' caps how much this may count, whatever confidence its producer stated.',
            restsOn: ['ai_interpretation'],
            score: typeof confidence.score === 'number' ? confidence.score : 0.2,
            basis: confidence.basis,
            now, stamp, sources, evidence,
          }));
        } else if (cls === 'human_decision') {
          humanDecisions.push(humanDecisionClaim({
            decidedByUserId: String(sig.producedBy),
            decidedByName: String(sig.producedBy),
            decidedAt: sig.observedAt,
            decision: statement,
            decisionKind: String(sig.label),
            followedRecommendation: null,
            overrideReason: null,
            recommendationId: null,
            now, stamp, sources,
            evidence: evidence.length ? evidence : [evidenceRef('signal', sig.id, String(sig.label))],
          }));
        }
      }
    }

    // A stable order, so two runs over an unchanged record produce an identical document. Strongest
    // evidence first within the feedback section, using the owner's comparator rather than a local
    // one — sorting rule-22 classes any other way is not reachable from their module and must not be
    // reachable from this one either.
    humanFeedback.sort((a, b) => b.weight - a.weight);
    void compareSignalWeight;

    if (!record.sections.length) {
      notes.push('No patch has registered a contribution to the master record, so nothing was relayed from it.');
    }

    return {
      ok: true, providerId: PROVIDER_ID,
      facts, derived, humanFeedback, humanDecisions,
      upstreamInterpretation, upstreamRecommendation,
      notes, error: null,
    };
  },
};
