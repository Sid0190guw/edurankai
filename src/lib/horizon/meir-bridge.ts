// src/lib/horizon/meir-bridge.ts — PATCH 11 CONSUMING THE MASTER EMPLOYEE INTELLIGENCE RECORD.
//
// =================================================================================================
// WHY THIS FILE EXISTS AT ALL
// =================================================================================================
//
// Patch 11 is a VIEW and was written against its own consumer-side contract (./contracts.ts) so that
// it could be built before the producing patches existed. Those patches now exist, and the shared
// HORIZON contract owns the real vocabulary:
//
//     src/lib/horizon/types.ts    DataLayer, EvidenceClass, Evidence, Confidence, IntelligenceResult,
//                                 Signal, DimensionRef, DIMENSION_FAMILIES
//     src/lib/horizon/record.ts   composeRecord(), MeirProvider, registerProvider() — the MEIR
//     src/lib/horizon/visibility.ts  VisibilityClass, HorizonAudience, redaction
//
// THIS FILE IS THE ONLY PLACE THE TWO VOCABULARIES MEET. Not one line of the shared contract is
// re-declared here and not one line of it is edited; this is a translation, in one direction, with
// every mapping written down beside the reason for it. The alternative — teaching twelve tab
// renderers to speak both vocabularies — is how two screens end up disagreeing about what "high"
// means for the same person.
//
// =================================================================================================
// THE MAPPING IS NOT NEUTRAL, SO IT IS WRITTEN DOWN
// =================================================================================================
//
// Every translation below either PRESERVES or WEAKENS a claim. None of them strengthens one:
//
//   - `inferred` evidence becomes `model_inference`, which sits BELOW every human account and below
//     every organisational record in this patch's weight order. Rule 22.
//   - `non_evidential` becomes `birth_based_inference`, the floor. That is the class the traditional
//     computation family lands in, and the floor is where the brief puts it.
//   - `ai_interpretation` stays `ai_interpretation`. A reading is never promoted to a fact by
//     passing through a translation layer.
//   - A result whose `scoreOrLevel.kind` is `not_computed` renders its REASON, never a zero. An
//     empty result drawn as a number is a lie about a person, and the shared contract made
//     `not_computed` a first-class member of the union precisely so this layer cannot flatten it.
//
// =================================================================================================
// WITHHELD MEANS NOT READ, ALL THE WAY DOWN
// =================================================================================================
//
// `composeRecord()` is called with the FAMILIES the viewer was actually granted. A tab this viewer
// may not open does not become a section that is fetched and then dropped — the provider for it is
// never asked. That is the same rule src/lib/digital-twin.ts enforces with its per-aspect column
// lists, applied at the provider boundary instead of the column boundary.
// =================================================================================================

import {
  composeRecord,
  listProviders,
  type MasterIntelligenceRecord,
  type RecordSection,
} from './record';
import { employeeSubject, DEFAULT_ORGANISATION_ID, newHorizonId, type SubjectRef } from './ids';
import {
  DIMENSION_FAMILY_LABELS,
  EVIDENCE_CLASS_LABELS,
  type Confidence as HznConfidence,
  type DataLayer,
  type DimensionFamily,
  type Evidence as HznEvidence,
  type EvidenceClass,
  type IntelligenceResult,
  type ScoreOrLevel,
  type Signal as HznSignal,
} from './types';
import {
  bandOf,
  screenTerminology,
  type Confidence,
  type DataClass,
  type EvidenceRef,
  type HorizonSectionKey,
  type MeirSubject,
  type SectionPayload,
  type Signal,
  type SignalWeightClass,
} from './contracts';

// -------------------------------------------------------------------------------------------------
// MODULE CONSTANTS — every one above the functions that read it.
// -------------------------------------------------------------------------------------------------

/**
 * WHICH TAB A DIMENSION FAMILY BELONGS ON.
 *
 * `temporal_pattern` is the shared contract's NEUTRAL NAME for the traditional-computation family —
 * types.ts says so in as many words, and its own suite asserts the older word appears in no exported
 * label. It therefore lands on Personal Intelligence Summary, which is the tab that carries the
 * interpretive refusals, NOT on Time Intelligence. Those two are different things with confusingly
 * similar names and getting it wrong would put a birth-based reading behind an attendance
 * capability, which is precisely the exposure rule 18 forbids.
 *
 * `wellbeing_aggregate` lands on Work Sustainability and nowhere else. The name carries its own
 * limit: aggregate. No individual health record reaches this view through any route.
 */
export const FAMILY_TO_SECTION: Readonly<Record<DimensionFamily, HorizonSectionKey>> = Object.freeze({
  capability: 'professional_profile',
  contribution: 'performance_work_records',
  growth: 'performance_work_records',
  collaboration: 'behaviour_intelligence',
  reliability: 'behaviour_intelligence',
  risk: 'behaviour_intelligence',
  wellbeing_aggregate: 'work_sustainability',
  temporal_pattern: 'personal_intelligence_summary',
});

/**
 * PATCH-LEVEL OVERRIDES, applied before the family map.
 *
 * A patch whose whole contribution belongs on one tab regardless of the families it declares is
 * named here. Time Intelligence is the case that matters: the temporal patch computes windows over
 * real work records and its results would otherwise scatter across three tabs by family.
 *
 * An unknown patch id is NOT an error and is NOT dropped — it falls through to the family map, and
 * a result whose family is unrecognised lands on Signals with its own sentence. A later patch does
 * not need this file edited to appear on the screen.
 */
export const PATCH_TO_SECTION: Readonly<Record<string, HorizonSectionKey>> = Object.freeze({
  'horizon-temporal': 'time_intelligence',
  'horizon-time': 'time_intelligence',
  'horizon-feedback': 'feedback_intelligence',
  'horizon-hiring-decision': 'decisions_interventions',
  'horizon-decisions': 'decisions_interventions',
  'horizon-interpretation': 'personal_intelligence_summary',
  'horizon-behaviour': 'behaviour_intelligence',
  'horizon-sustainability': 'work_sustainability',
});

/** The reverse of FAMILY_TO_SECTION, so a grant list can become a families filter. */
const SECTION_TO_FAMILIES: Record<string, DimensionFamily[]> = (() => {
  const out: Record<string, DimensionFamily[]> = {};
  for (const fam of Object.keys(FAMILY_TO_SECTION) as DimensionFamily[]) {
    const sec = FAMILY_TO_SECTION[fam];
    (out[sec] = out[sec] || []).push(fam);
  }
  return out;
})();

/**
 * DATA LAYER -> THE FIVE KINDS OF STATEMENT THIS VIEW KEEPS APART.
 *
 * The shared contract names seven layers; rule 13 of the brief names five kinds. `computed` and
 * `observed` both land on the coarser word that is true of them, and NOTHING lands on
 * `human_decision` except an actual human decision. A reading never becomes a decision by being
 * rendered.
 */
const DATA_CLASS_BY_LAYER: Readonly<Record<string, DataClass>> = Object.freeze({
  raw: 'raw_source',
  computed: 'derived',
  observed: 'raw_source',
  human_feedback: 'human_feedback',
  ai_interpretation: 'ai_interpretation',
  recommendation: 'ai_interpretation',
  human_decision: 'human_decision',
});

/**
 * EVIDENCE CLASS -> WEIGHT ORDER. Rule 22, as a table.
 *
 * `non_evidential` is the class the shared contract gives to anything carrying no evidential weight,
 * which is where a traditional computational input sits. It maps to this patch's floor. Nothing in
 * this file can move it above a record of work, because `compareSignalWeight` orders by the array in
 * contracts.ts and this map only chooses a member of it.
 */
const WEIGHT_BY_EVIDENCE_CLASS: Readonly<Record<EvidenceClass, SignalWeightClass>> = Object.freeze({
  demonstrated: 'demonstrated_work',
  observed: 'organisational_record',
  attested: 'manager_report',
  stated: 'self_reported',
  inferred: 'model_inference',
  non_evidential: 'birth_based_inference',
});

/** Signal category -> weight, for a signal that carries no evidence class of its own. */
const WEIGHT_BY_SIGNAL_LAYER: Readonly<Record<string, SignalWeightClass>> = Object.freeze({
  raw: 'organisational_record',
  computed: 'organisational_record',
  observed: 'organisational_record',
  human_feedback: 'peer_report',
  ai_interpretation: 'model_inference',
  recommendation: 'model_inference',
  human_decision: 'manager_report',
});

/** Every section this bridge can fill. A section not in here has a local adapter or no source yet. */
export const BRIDGED_SECTIONS: readonly HorizonSectionKey[] = Object.freeze([
  'professional_profile',
  'performance_work_records',
  'behaviour_intelligence',
  'personal_intelligence_summary',
  'work_sustainability',
  'time_intelligence',
  'feedback_intelligence',
  'decisions_interventions',
]);

// -------------------------------------------------------------------------------------------------
// PURE TRANSLATIONS
// -------------------------------------------------------------------------------------------------

export function toDataClass(layer: DataLayer | string | null | undefined): DataClass {
  return DATA_CLASS_BY_LAYER[String(layer || '')] || 'ai_interpretation';
}

export function toWeightClass(cls: EvidenceClass | string | null | undefined): SignalWeightClass {
  return (WEIGHT_BY_EVIDENCE_CLASS as any)[String(cls || '')] || 'model_inference';
}

/**
 * Their confidence to ours.
 *
 * Theirs has no 'none' band; ours does, and it is the honest answer when no value was produced. A
 * band with no number is preserved as a band with no number: inventing 0.5 to fill a field would be
 * fabricating the one figure the reader is most likely to act on.
 */
export function toConfidence(c: HznConfidence | null | undefined): Confidence {
  if (!c) {
    return { value: null, band: 'none', basis: 'The producing patch stated no confidence, so none is shown.' };
  }
  const value = typeof c.value === 'number' && isFinite(c.value) ? c.value : null;
  return {
    value,
    band: value === null ? (c.band as any) || 'none' : bandOf(value),
    basis: c.basis || 'No basis was recorded for this confidence.',
  };
}

/** Their Evidence to the pointer this view renders as the bottom rung of the ladder. */
export function toEvidenceRef(e: HznEvidence): EvidenceRef {
  const raw = e?.rawReference || ({} as any);
  const cls = EVIDENCE_CLASS_LABELS[e?.evidenceClass as EvidenceClass] || String(e?.evidenceClass || '');
  return {
    ownerModule: String(raw.ownerModule || 'unattributed'),
    sourceTable: raw.table ? String(raw.table) : null,
    sourceId: raw.recordId ? String(raw.recordId) : null,
    locator: raw.locator ? String(raw.locator) : null,
    documentUrl: raw.documentUrl ? String(raw.documentUrl) : null,
    occurredAt: e?.timestamp || null,
    verificationStatus: cls,
    sentence: e?.unreadable
      ? 'This evidence exists and could not be read: ' + String(e.unreadable)
      : (e?.summary || 'Evidence recorded by ' + String(raw.ownerModule || 'an unnamed module')) + ' (' + cls + ')',
    // No href. This patch does not invent routes into another patch's screens; where a producing
    // patch supplies a document link it is used, and where it does not the last rung says so.
    href: null,
  };
}

/** What a result actually says, in words, WITHOUT ever turning `not_computed` into a number. */
export function scoreText(v: ScoreOrLevel | null | undefined): string {
  if (!v) return 'No value was recorded.';
  switch (v.kind) {
    case 'numeric':
      return String(v.value) + (v.unit ? ' ' + v.unit : '') + ' (on ' + v.scaleMin + ' to ' + v.scaleMax + ')';
    case 'level':
      return v.level + (v.ladder && v.ladder.length ? ' (of ' + v.ladder.join(', ') + ')' : '');
    case 'categorical':
      return v.category;
    default:
      return 'Not computed. ' + (v.reason || 'No reason was given.');
  }
}

/** Where one result belongs. Patch id wins, then family, then the roll-up. */
export function sectionForResult(patchId: string, family: DimensionFamily | string | null): HorizonSectionKey {
  const byPatch = (PATCH_TO_SECTION as any)[String(patchId || '')];
  if (byPatch) return byPatch;
  const byFamily = (FAMILY_TO_SECTION as any)[String(family || '')];
  if (byFamily) return byFamily;
  return 'signals';
}

/** The families to ask for, given the tabs this viewer was granted. */
export function familiesForSections(granted: readonly HorizonSectionKey[]): DimensionFamily[] {
  const out = new Set<DimensionFamily>();
  for (const key of granted) {
    for (const fam of SECTION_TO_FAMILIES[key] || []) out.add(fam);
  }
  return Array.from(out);
}

// -------------------------------------------------------------------------------------------------
// WHAT ONE TAB RECEIVES
// -------------------------------------------------------------------------------------------------

export interface MeirFinding {
  id: string;
  patchId: string;
  dimensionKey: string;
  dimensionLabel: string;
  familyLabel: string;
  /** The sentence the producing patch wrote. Screened for terminology before it is stored here. */
  summary: string;
  /** The value in words. Never a bare number, and never a number where none was computed. */
  valueText: string;
  computed: boolean;
  confidence: Confidence;
  dataClass: DataClass;
  /** may_decide | supporting_only | advisory_only, verbatim from the producing patch. */
  decisionUse: string;
  /** Whether the method behind it is established, contested or explicitly non-scientific. */
  scientificStatus: string;
  humanReviewStatus: string;
  computedAt: string | null;
  /** engineId + version + the run it came from, so a disputed reading can be traced to a run. */
  engine: string;
  evidence: EvidenceRef[];
  /** Set when the producing patch could read the dimension but not compute it. */
  unreadable: string | null;
}

export interface MeirSectionData {
  findings: MeirFinding[];
  /** The patches that contributed, named, so a disputed panel has an owner. */
  contributingPatches: string[];
  /** Patches that failed. The section is INCOMPLETE, and that is not the same as empty. */
  degraded: string[];
  /** True when a provider could not answer historically and answered with today's data instead. */
  asOfUnsupported: boolean;
}

// -------------------------------------------------------------------------------------------------
// THE READ
// -------------------------------------------------------------------------------------------------

export interface BridgeOptions {
  /** Only these tabs are read. A tab that is not here has its provider left unasked. */
  granted: readonly HorizonSectionKey[];
  asOf?: string | null;
  requestId?: string;
  organisationId?: string;
}

export interface BridgeOutcome {
  /** One payload per bridged section that was granted. Absent keys were not read. */
  payloads: Map<HorizonSectionKey, SectionPayload<MeirSectionData>>;
  /** Signals from every granted section, already translated. The roll-up tab consumes these. */
  signals: Signal[];
  /** Null when the record could not be composed at all. */
  record: MasterIntelligenceRecord | null;
  /** Set when nothing was read, with the reason. */
  refusal: string | null;
  /** Patch ids registered right now, whether or not they were asked. For the wiring footer. */
  registeredPatches: string[];
}

/**
 * Compose the record for one person and split it across this patch's tabs.
 *
 * NEVER THROWS. `composeRecord()` already guarantees it returns a record whatever the providers do;
 * everything after it is pure translation, and the one thing that can still fail — resolving the
 * subject — is reported as a refusal rather than an exception, because a page that 500s tells the
 * operator less than a page that says which id it could not resolve.
 */
export async function bridgeMeirSections(
  subject: MeirSubject,
  opts: BridgeOptions,
): Promise<BridgeOutcome> {
  const registeredPatches = listProviders().map((p) => p.patchId);
  const empty: BridgeOutcome = {
    payloads: new Map(),
    signals: [],
    record: null,
    refusal: null,
    registeredPatches,
  };

  if (!subject?.employeeId) {
    return {
      ...empty,
      refusal:
        'This person has no employee record, so there is no employee subject for the Master Employee '
        + 'Intelligence Record to be composed against. That is a statement about the linkage, not about the person.',
    };
  }

  const wanted = (opts.granted || []).filter((k) => BRIDGED_SECTIONS.indexOf(k) >= 0);
  if (wanted.length === 0) {
    return { ...empty, refusal: null };
  }

  const families = familiesForSections(wanted);
  const ref: SubjectRef = employeeSubject(
    subject.employeeId,
    (opts.organisationId as any) || DEFAULT_ORGANISATION_ID,
  );

  let record: MasterIntelligenceRecord;
  try {
    record = await composeRecord(ref, {
      requestId: opts.requestId || newHorizonId('computation'),
      asOf: opts.asOf ?? null,
      // A patch that declares only families this viewer was not granted is never asked. When the
      // grant covers no family at all we still pass an empty list rather than omitting the option,
      // because omitting it means "everything" in composeRecord and that would widen the read.
      families,
      organisationId: (opts.organisationId as any) || DEFAULT_ORGANISATION_ID,
    });
  } catch (e: any) {
    return {
      ...empty,
      refusal:
        'The master record could not be composed just now, so these sections are INCOMPLETE rather than empty. ('
        + String(e?.cause?.message || e?.message || e).slice(0, 200) + ')',
    };
  }

  // ---- SPLIT --------------------------------------------------------------------------------------
  const bySection = new Map<HorizonSectionKey, MeirSectionData>();
  const signals: Signal[] = [];
  const ensure = (key: HorizonSectionKey): MeirSectionData => {
    let d = bySection.get(key);
    if (!d) {
      d = { findings: [], contributingPatches: [], degraded: [], asOfUnsupported: false };
      bySection.set(key, d);
    }
    return d;
  };

  for (const section of record.sections || []) {
    routeSection(section, wanted, ensure, signals);
  }

  // ---- PAYLOADS ------------------------------------------------------------------------------------
  const payloads = new Map<HorizonSectionKey, SectionPayload<MeirSectionData>>();
  for (const key of wanted) {
    const data = bySection.get(key);
    const owedBy = ownerLabel(key, data);
    if (!data || (data.findings.length === 0 && data.degraded.length === 0)) {
      payloads.set(key, {
        key,
        status: 'not_supplied',
        sentence:
          'No registered patch contributed anything to this section for this person. '
          + (registeredPatches.length
            ? 'Registered right now: ' + registeredPatches.join(', ') + '. '
            : 'No HORIZON provider is registered in this process at all. ')
          + 'Nothing was read and nothing is assumed — an empty panel here does not mean an empty record.',
        owedBy,
        signals: [],
        patterns: [],
        requiredCapability: null,
        accessLogged: false,
        accessLogNote: null,
      });
      continue;
    }

    const hasFindings = data.findings.length > 0;
    payloads.set(key, {
      key,
      status: data.degraded.length && !hasFindings ? 'unreadable' : (hasFindings ? 'ok' : 'empty'),
      sentence: sectionSentence(data),
      owedBy,
      data,
      signals: signals.filter((s) => s.id.indexOf('meir:' + key + ':') === 0),
      patterns: [],
      requiredCapability: null,
      accessLogged: false,
      accessLogNote: null,
    });
  }

  return { payloads, signals, record, refusal: null, registeredPatches };
}

// -------------------------------------------------------------------------------------------------
// INTERNALS
// -------------------------------------------------------------------------------------------------

function routeSection(
  section: RecordSection,
  wanted: readonly HorizonSectionKey[],
  ensure: (k: HorizonSectionKey) => MeirSectionData,
  signals: Signal[],
): void {
  const patchId = String(section.patchId || 'unnamed-patch');
  const label = String(section.label || patchId);

  for (const r of section.results || []) {
    const key = sectionForResult(patchId, r?.dimension?.family as any);
    if (wanted.indexOf(key) < 0) continue;
    const d = ensure(key);
    if (d.contributingPatches.indexOf(label) < 0) d.contributingPatches.push(label);
    if (section.asOfUnsupported) d.asOfUnsupported = true;
    d.findings.push(toFinding(r, patchId));
  }

  for (const s of section.signals || []) {
    const key = sectionForResult(patchId, null);
    if (wanted.indexOf(key) < 0) continue;
    signals.push(toSignal(s, patchId, key));
  }

  if (section.unreadable) {
    // A failed provider is reported on EVERY tab it would have contributed to, because a tab that
    // silently omits a degraded patch reads as complete when it is not.
    const targets = new Set<HorizonSectionKey>();
    const byPatch = (PATCH_TO_SECTION as any)[patchId];
    if (byPatch) targets.add(byPatch);
    else for (const k of wanted) targets.add(k);
    for (const k of targets) {
      if (wanted.indexOf(k) < 0) continue;
      const d = ensure(k);
      if (d.degraded.indexOf(label) < 0) d.degraded.push(label);
    }
  }
}

export function toFinding(r: IntelligenceResult, patchId: string): MeirFinding {
  const dim = r?.dimension || ({} as any);
  const engine = r?.modelOrEngineVersion || ({} as any);
  const computed = r?.scoreOrLevel?.kind !== 'not_computed';
  return {
    id: String(r?.id || ''),
    patchId,
    dimensionKey: String(dim.key || 'unnamed'),
    dimensionLabel: screenTerminology(String(dim.label || dim.key || 'Unnamed dimension')).text,
    familyLabel: (DIMENSION_FAMILY_LABELS as any)[String(dim.family || '')] || String(dim.family || ''),
    summary: screenTerminology(String(r?.summary || '')).text,
    valueText: scoreText(r?.scoreOrLevel),
    computed,
    confidence: toConfidence(r?.confidence),
    dataClass: toDataClass(r?.layer),
    decisionUse: String(r?.decisionUse || 'advisory_only'),
    scientificStatus: String(r?.scientificStatus || 'unstated'),
    humanReviewStatus: String(r?.humanReviewStatus || 'not_required'),
    computedAt: r?.computedAt || null,
    engine: [engine.engineId, engine.version].filter(Boolean).join(' ') || 'unversioned',
    evidence: (r?.evidence || []).map(toEvidenceRef),
    unreadable: r?.unreadable || (computed ? null : String((r?.scoreOrLevel as any)?.reason || 'Not computed.')),
  };
}

export function toSignal(s: HznSignal, patchId: string, section: HorizonSectionKey): Signal {
  const strongest = (s as any)?.strongestEvidenceClass;
  const weight: SignalWeightClass = strongest
    ? toWeightClass(strongest)
    : ((WEIGHT_BY_SIGNAL_LAYER as any)[String(s?.layer || '')] || 'model_inference');
  return {
    id: 'meir:' + section + ':' + String(s?.id || ''),
    label: screenTerminology(String(s?.title || 'Unnamed signal')).text,
    statement: screenTerminology(String(s?.explanation || '')).text,
    weightClass: weight,
    dataClass: toDataClass(s?.layer),
    confidence: toConfidence(s?.confidence),
    observedAt: s?.generatedAt || null,
    producedBy: patchId,
    // The shared Signal carries evidence IDS, not evidence rows — resolving them is the owning
    // patch's read, not this view's. The ids are surfaced as locators so a reader can still get to
    // them, and the sentence says plainly that the row itself was not fetched here.
    evidence: (s?.evidenceIds || []).map((id) => ({
      ownerModule: patchId,
      sourceTable: null,
      sourceId: String(id),
      locator: null,
      documentUrl: null,
      occurredAt: s?.generatedAt || null,
      verificationStatus: String(s?.severity || ''),
      sentence: 'Evidence ' + String(id) + ', held by ' + patchId + '. This view carries the reference, not the row.',
      href: null,
    })),
    patternIds: [],
    // A signal a human has rejected or overridden is DISPUTED, and stays on the screen saying so
    // rather than disappearing. Rule 24: one person's verdict does not delete the record either.
    disputed: s?.status === 'dismissed' || (s as any)?.humanReviewStatus === 'rejected',
  };
}

function ownerLabel(key: HorizonSectionKey, data: MeirSectionData | undefined): string {
  if (data && data.contributingPatches.length) return data.contributingPatches.join(', ');
  for (const patchId of Object.keys(PATCH_TO_SECTION)) {
    if ((PATCH_TO_SECTION as any)[patchId] === key) return patchId + ' (not registered in this process)';
  }
  return 'no patch has claimed this section';
}

function sectionSentence(d: MeirSectionData): string {
  const parts: string[] = [];
  if (d.findings.length) {
    parts.push(
      d.findings.length + ' reading' + (d.findings.length === 1 ? '' : 's') + ' from '
      + d.contributingPatches.join(', ') + '.',
    );
    const notComputed = d.findings.filter((f) => !f.computed).length;
    if (notComputed) {
      parts.push(notComputed + ' could not be computed and shows the reason instead of a figure.');
    }
    const advisory = d.findings.filter((f) => f.decisionUse !== 'may_decide').length;
    if (advisory === d.findings.length) {
      parts.push('Every reading here is advisory and none of them may carry a decision on its own.');
    }
  }
  if (d.degraded.length) {
    parts.push(
      d.degraded.join(', ') + ' could not be read, so this section is INCOMPLETE rather than empty.',
    );
  }
  if (d.asOfUnsupported) {
    parts.push('A patch could not answer for the date asked for and answered with current data instead.');
  }
  return parts.join(' ') || 'Read, and there is nothing on record here.';
}
