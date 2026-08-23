// src/lib/fusion/horizon-bridge.ts — HOW THIS ENGINE MEETS THE HORIZON SHARED CONTRACTS.
//
// =================================================================================================
// TWO NUMBERING SCHEMES EXIST IN THIS TREE. THIS FILE DOES NOT TRY TO RESOLVE THEM.
// =================================================================================================
//
// src/lib/horizon/sections.ts assigns "PATCH-06" to Work Sustainability and numbers the others
// differently again (PATCH-03 Behaviour Intelligence, PATCH-05 Personal Intelligence, PATCH-08
// Feedback Intelligence). The brief this module was built to numbers them differently: 06 is the
// fusion engine, 03 is the professional interpretation, 04 is behavioural evidence, 05 is feedback.
//
// THAT DISAGREEMENT IS REPORTED, NOT SILENTLY PICKED. Renumbering somebody else's section map to
// match a brief they never saw is exactly the "never overwrite another agent's implementation" rule,
// and guessing which numbering is canonical is not this module's call to make. So:
//
//   - This engine keeps its own namespace (src/lib/fusion, hif_* tables). Nothing collides.
//   - It CLAIMS NO SECTION KEY in the horizon registry. registerHorizonProvider() treats a key
//     claimed twice as a registration error, and claiming `work_sustainability` — which their map
//     already owes to somebody — would be exactly that.
//   - It offers the two adapters below. Whoever owns the profile composer can wire either one in a
//     line when the numbering is settled by a human. Until then nothing is auto-registered, because
//     auto-registering into a contested key is how one agent's work silently displaces another's.
//
// =================================================================================================
// WHAT THE TWO ADAPTERS DO
// =================================================================================================
//
//   fusionSignalsFromHorizon()   Their Signal -> our Signal. Their weight-class ladder maps onto our
//                                five source classes cleanly, and Rule 22 survives the mapping
//                                because their ladder and our ceiling say the same thing.
//
//   asSectionPayload()           Our FusionProfile -> their SectionPayload, so the ten readings can
//                                render inside the twelve-tab profile without that patch importing
//                                anything from here except this one function.
import {
  SOURCE_CLASS_LABELS,
  isFusionDimension,
  type DimensionReading,
  type FusionDimension,
  type FusionProfile,
  type Signal,
  type SourceClass,
} from './types';
import type {
  Signal as HorizonSignal,
  SignalWeightClass,
  SectionPayload,
  HorizonSectionKey,
  EvidenceRef as HorizonEvidenceRef,
} from '@/lib/horizon/contracts';

// -------------------------------------------------------------------------------------------------
// THEIR LADDER ONTO OUR FIVE CLASSES
// -------------------------------------------------------------------------------------------------

/**
 * HORIZON's seven weight classes onto this engine's five source classes.
 *
 * `self_reported` MAPS TO NOTHING, and that is the mapping rather than an omission. A person's word
 * about themselves is a real thing worth showing and it is not a demonstration of anything —
 * src/lib/evidence-graph.ts settled that for this whole product, and this engine's providers already
 * treat a self-recorded skill level the same way. A self-reported signal is reported as read and
 * counted as nothing.
 *
 * `birth_based_inference` and `model_inference` BOTH map to the inferred foundation, which is where
 * the ceiling, the inadmissibility rules and the deference rule all apply. That is deliberate: a
 * model's guess about a person gets no more standing here than any other inference.
 */
export const WEIGHT_CLASS_TO_SOURCE: Record<SignalWeightClass, SourceClass | null> = {
  birth_based_inference: 'inferred_foundation',
  model_inference: 'inferred_foundation',
  self_reported: null,
  peer_report: 'peer_evidence',
  manager_report: 'manager_evidence',
  organisational_record: 'observed_evidence',
  demonstrated_work: 'observed_evidence',
};

export function sourceClassForWeightClass(w: SignalWeightClass): SourceClass | null {
  return WEIGHT_CLASS_TO_SOURCE[w] ?? null;
}

const ADVISORY_NOTICE =
  'An interpretive input, not a finding about this person’s work. It is not presented as scientific '
  + 'fact, it cannot produce a reading on its own, and demonstrated evidence displaces it.';

/** Their confidence is 0..1 and null is valid. Ours is a strength 0..1. Null becomes a weak signal. */
const strengthOf = (s: HorizonSignal): number => {
  const v = s?.confidence?.value;
  if (typeof v !== 'number' || !isFinite(v)) return 0.4;
  return Math.max(0, Math.min(1, v));
};

const firstEvidence = (refs: readonly HorizonEvidenceRef[] | undefined) =>
  (refs && refs.length ? refs[0] : null);

export interface HorizonMapReport {
  signals: Signal[];
  /** Signals that were read and deliberately counted as nothing, with the reason. Never silent. */
  notCounted: { id: string; label: string; because: string }[];
}

/**
 * Map HORIZON signals into this engine.
 *
 * THE CALLER SAYS WHICH DIMENSION. Their Signal carries no dimension and nothing in this file will
 * guess one from its label — a keyword match onto a dimension is how a remark about punctuality
 * becomes a reading about leadership. A signal the caller cannot place is reported in `notCounted`
 * rather than dropped or filed somewhere plausible.
 *
 * A DISPUTED SIGNAL IS NOT COUNTED. Their contract records `disputed` when a named human has
 * challenged it. Feeding a challenged statement into an arithmetic that produces a number about the
 * person who challenged it is the exact shape of "one person's view becomes organisational truth".
 * It is reported, and it does not contribute.
 */
export function fusionSignalsFromHorizon(
  signals: readonly HorizonSignal[],
  placeDimension: (s: HorizonSignal) => FusionDimension | null,
  position: (s: HorizonSignal) => number,
): HorizonMapReport {
  const out: Signal[] = [];
  const notCounted: HorizonMapReport['notCounted'] = [];

  for (const s of signals || []) {
    const label = String(s?.label || s?.id || 'an unnamed signal');

    if (s?.disputed) {
      notCounted.push({
        id: String(s.id), label,
        because: 'A named human has disputed it. It stays on the record and it does not contribute to '
          + 'a number about anybody.',
      });
      continue;
    }

    const sourceClass = sourceClassForWeightClass(s?.weightClass);
    if (!sourceClass) {
      notCounted.push({
        id: String(s.id), label,
        because: 'It is the person’s own account of themselves. That is shown as their word and '
          + 'counted as nothing: a statement is not a demonstration.',
      });
      continue;
    }

    const dimension = placeDimension(s);
    if (!dimension || !isFusionDimension(dimension)) {
      notCounted.push({
        id: String(s.id), label,
        because: 'Nothing said which of the ten dimensions it speaks to, and this bridge does not '
          + 'guess one from its wording.',
      });
      continue;
    }

    const ref = firstEvidence(s.evidence);
    out.push({
      signalId: 'hz-' + String(s.id),
      dimension,
      sourceClass,
      providerKey: 'horizon.bridge',
      ownerModule: String(s.producedBy || 'src/lib/horizon'),
      sourceTable: ref?.sourceTable ?? null,
      sourceId: ref?.sourceId ?? null,
      position: Math.max(-1, Math.min(1, position(s))),
      strength: strengthOf(s),
      observedAt: s.observedAt ?? null,
      statement: String(s.statement || label),
      basis: String(s.confidence?.basis || 'Supplied through the HORIZON signal contract.'),
      assertion: sourceClass === 'inferred_foundation' ? 'inferred' : 'factual',
      evidenceUrl: ref?.documentUrl ?? null,
      locator: ref?.locator ?? null,
      attributedToUserId: null,
      attributedToRelationship: null,
      advisoryNotice: sourceClass === 'inferred_foundation' ? ADVISORY_NOTICE : null,
    });
  }

  return { signals: out, notCounted };
}

// -------------------------------------------------------------------------------------------------
// OUR PROFILE INTO THEIR TAB
// -------------------------------------------------------------------------------------------------

const readingLabel = (r: DimensionReading): string =>
  r.reading === null ? r.label + ' — no reading' : r.label + ' ' + r.reading + '/100';

/**
 * Render this engine's profile as one HORIZON section payload.
 *
 * IT PRODUCES NO NEW NUMBER. Every figure in here already exists on the profile, with its
 * explanation attached. There is no total, no average and no rank — the payload carries ten readings
 * and their sentences, exactly as the profile does.
 *
 * The caller supplies the section key, because which tab this belongs in is a decision for whoever
 * owns that map and not for this file. See the header.
 */
export function asSectionPayload(
  profile: FusionProfile,
  sectionKey: HorizonSectionKey,
  requiredCapability: string | null,
  accessLogged: boolean,
  accessLogNote: string | null,
): SectionPayload<{ dimensions: DimensionReading[]; weighting: FusionProfile['weighting'] }> {
  const read = profile.dimensions.filter((d) => d.reading !== null);
  const status = profile.unreadable.length && !read.length
    ? 'unreadable'
    : read.length ? 'ok' : 'empty';

  const sentence = status === 'ok'
    ? read.length + ' of ' + profile.dimensions.length + ' dimensions could be read: '
      + read.map(readingLabel).join(', ') + '. No figure here is a total and none of them decides anything.'
    : status === 'unreadable'
      ? 'The intelligence profile could not be read: ' + profile.unreadable.map((u) => u.because).join(' ')
      : 'Every dimension was computed and none of them had enough on record to produce a reading. '
        + 'That is an empty record, not a low one.';

  return {
    key: sectionKey,
    status: status as SectionPayload['status'],
    sentence,
    owedBy: 'Dynamic Human Intelligence Fusion Engine (src/lib/fusion)',
    data: status === 'ok' ? { dimensions: profile.dimensions, weighting: profile.weighting } : undefined,
    // The ten readings are interpretations, not signals, and this engine does not manufacture
    // HORIZON signals out of its own conclusions. Feeding a conclusion back in as evidence is how a
    // system starts confirming itself.
    signals: [],
    patterns: [],
    requiredCapability,
    accessLogged,
    accessLogNote,
  };
}

/** For a screen that wants to say what a source class is called in the other patch's words. */
export function describeMapping(): { horizon: SignalWeightClass; fusion: string }[] {
  return (Object.keys(WEIGHT_CLASS_TO_SOURCE) as SignalWeightClass[]).map((w) => {
    const c = WEIGHT_CLASS_TO_SOURCE[w];
    return { horizon: w, fusion: c ? SOURCE_CLASS_LABELS[c] : 'Counted as nothing' };
  });
}
