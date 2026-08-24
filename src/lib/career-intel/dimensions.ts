// src/lib/career-intel/dimensions.ts — THE PROFILE MODEL, AND THE LINE DRAWN THROUGH IT.
//
// =================================================================================================
// WHAT THIS FILE IS
// =================================================================================================
//
// The vocabulary of everything Career Intelligence may know about a person, and the shape each
// piece of knowledge is stored in. No database, no network, no model. Pure types and pure
// functions, so it can be imported from .astro frontmatter, from an API route and from a test.
//
// =================================================================================================
// A DIMENSION IS NOT A LABEL, AND A SIGNAL IS NOT A FACT
// =================================================================================================
//
// The failure this model is built against is the one where "I like freedom in how I work, but I
// need clear goals, and for hard problems I want silence while brainstorming is better with loud
// people" is stored as environment = structured. Everything that made the answer true is thrown
// away, and what remains is a box the person did not choose to stand in.
//
// So a preference is never a label. It is a Signal: a value, a CONFIDENCE, where it came from,
// whether the person has confirmed it, which interpreter produced it, and which of their own
// sentences it came out of. And the sentence itself is kept, verbatim, in rawResponses —
// separately from the interpretation, so that a better interpreter can be run over the original
// words later. An interpretation is a reading of the evidence, not the evidence.
//
// CONTEXT IS FIRST-CLASS. contextDependencies exists because "it depends" is the most common
// honest answer to a work-style question and the one a single scalar cannot hold. A person who
// wants quiet for deep work and noise for brainstorming has TWO true answers, and both are stored.
//
// =================================================================================================
// THE LINE: WHAT MAY REACH MATCHING, AND WHAT MAY NEVER
// =================================================================================================
//
// Three kinds of thing get collected here and they are NOT interchangeable:
//
//   A. JOB-RELEVANT        interests, skills, career stage, what the person does not want, and the
//                          preferences they stated about the WORK ITSELF (how they like to think,
//                          how they like to work). These may order recommendations and must be
//                          quoted back as the reason.
//
//   B. PERSONAL EXPLORATION  energy rhythm, self-reported behavioural tendencies. Interesting to
//                          the person. NOT an input to which opportunities are shown or in what
//                          order. "Night owls cannot perform this role" is not a sentence this
//                          system is capable of producing, because the rhythm group is not
//                          readable by the ranker.
//
//   C. REFLECTION          the optional astrology layer (src/lib/career-intel/reflection.ts). Same
//                          rule as B, enforced harder: rank.ts does not import that module at all.
//
// The enforcement is RELEVANCE_GROUPS below plus relevanceDimensions(), which is the ONLY way the
// ranker is allowed to read dimensions. A group added to the vocabulary is exploration-only until
// somebody deliberately adds it to that list, and a test asserts the list's contents.
//
// AND NONE OF THE THREE TOUCHES ELIGIBILITY. Whether a posting may be shown at all is decided by
// src/lib/xscale/roles-ext.ts from the posting's own status and deadline. No property of a person
// makes a posting disappear. That is not a nicety: a system that can hide jobs from people based on
// an inferred personality trait is a rejection engine with a recommendation engine's manners.

/* ------------------------------------------------------------------------------ model version */

/**
 * Stamped onto every signal this build produces. Bump it when the interpreter's reading of the
 * same words would change, so that stored interpretations can be told apart from fresh ones and
 * the raw responses can be re-read by a later version.
 */
export const MODEL_VERSION = 'ci-lex-1';

/** Bumped when the SHAPE of a stored profile changes. Read by the store before trusting a row. */
export const PROFILE_VERSION = 1;

/* ---------------------------------------------------------------------------------- vocabulary */

export type DimensionGroup =
  | 'workstyle'    // how they like to work
  | 'cognitive'    // how they like to think about a problem
  | 'rhythm'       // when they have energy — exploration only
  | 'behavioural'; // self-reported tendencies — exploration only, non-diagnostic

export interface DimensionDef {
  key: string;
  group: DimensionGroup;
  /** How the person's own summary refers to it: "You value independence in how you work." */
  affirm: string;
  /** The opposite reading, for a low value. Some dimensions have no meaningful opposite. */
  deny?: string;
  /** What a posting would have to look like for this to matter. Absent on exploration-only dims. */
  roleSignal?: string;
}

/**
 * THE DIMENSIONS. Deliberately a flat list rather than a tree: a tree invites "which branch is this
 * person" and the whole point is that they can be several at once.
 */
export const DIMENSIONS: DimensionDef[] = [
  // ---- work style ----
  { key: 'autonomy', group: 'workstyle', affirm: 'You value independence and freedom in how you work.', deny: 'You would rather work inside a defined approach than invent one.', roleSignal: 'Work scoped as a problem rather than as a task list.' },
  { key: 'structure', group: 'workstyle', affirm: 'You work well with a clear structure around you.', deny: 'You are comfortable when the structure is still being worked out.', roleSignal: 'Established practice and a known way of doing the work.' },
  { key: 'goal_clarity', group: 'workstyle', affirm: 'Clear objectives matter to you.', roleSignal: 'Postings with written deliverables and evaluation criteria.' },
  { key: 'flexibility', group: 'workstyle', affirm: 'You want room to change how and when you approach things.', roleSignal: 'Work whose sequence is yours to choose.' },
  { key: 'deep_focus', group: 'workstyle', affirm: 'You prefer quiet, uninterrupted stretches for hard problems.', roleSignal: 'Long-horizon problems rather than a queue of short ones.' },
  { key: 'collaboration', group: 'workstyle', affirm: 'You do your best thinking with other people in the room.', deny: 'You would rather work through a problem on your own first.', roleSignal: 'Postings that name who the work is done with.' },
  { key: 'social_energy', group: 'workstyle', affirm: 'You draw energy from the people around you.', roleSignal: 'Teaching, facilitation, and work done in front of people.' },
  { key: 'pace', group: 'workstyle', affirm: 'You like work that moves quickly.', deny: 'You would rather go carefully than quickly.', roleSignal: 'Delivery cadence rather than a research horizon.' },
  { key: 'ambiguity_tolerance', group: 'workstyle', affirm: 'You are comfortable when the answer is not known yet.', roleSignal: 'Speculative and exploratory work.' },
  { key: 'routine', group: 'workstyle', affirm: 'You like knowing what your day looks like.', roleSignal: 'Operational work with a repeating shape.' },

  // ---- cognitive ----
  { key: 'analytical', group: 'cognitive', affirm: 'You like reasoning a problem through carefully.', roleSignal: 'Analysis, modelling and quantitative work.' },
  { key: 'experimental', group: 'cognitive', affirm: 'You would rather try it and see what happens.', roleSignal: 'Experimental and instrumentation work.' },
  { key: 'research_orientation', group: 'cognitive', affirm: 'You are drawn to questions nobody has answered properly yet.', roleSignal: 'Research classifications and open problems.' },
  { key: 'systems_thinking', group: 'cognitive', affirm: 'You like seeing how the parts of something fit together.', roleSignal: 'Architecture, platforms and infrastructure.' },
  { key: 'creativity', group: 'cognitive', affirm: 'You like making things that did not exist before.', roleSignal: 'Design, authoring and product invention.' },
  { key: 'abstraction', group: 'cognitive', affirm: 'You are comfortable working with ideas before they are concrete.', roleSignal: 'Theoretical and mathematical work.' },
  { key: 'implementation', group: 'cognitive', affirm: 'You want to build the working thing, not only describe it.', roleSignal: 'Engineering, delivery and applied work.' },

  // ---- rhythm (exploration only) ----
  { key: 'morning_energy', group: 'rhythm', affirm: 'Your sharpest thinking happens early in the day.' },
  { key: 'evening_energy', group: 'rhythm', affirm: 'Your sharpest thinking happens later in the day.' },
  { key: 'sustained_focus', group: 'rhythm', affirm: 'You can hold one thing for a long stretch.' },
  { key: 'burst_focus', group: 'rhythm', affirm: 'You work in intense bursts, with real recovery between them.' },

  // ---- behavioural (exploration only, self-reported, non-diagnostic) ----
  { key: 'initiative', group: 'behavioural', affirm: 'You tend to start things rather than wait to be asked.' },
  { key: 'persistence', group: 'behavioural', affirm: 'You stay with a problem after it stops being fun.' },
  { key: 'feedback_openness', group: 'behavioural', affirm: 'You want your work argued with.' },
  { key: 'detail_orientation', group: 'behavioural', affirm: 'You notice the small thing that is wrong.' },
];

export const DIMENSION_BY_KEY: Record<string, DimensionDef> =
  Object.fromEntries(DIMENSIONS.map((d) => [d.key, d]));

export function isDimension(k: unknown): boolean {
  return typeof k === 'string' && Object.prototype.hasOwnProperty.call(DIMENSION_BY_KEY, k);
}

/**
 * THE ALLOWLIST. The only dimension groups the ranker may read.
 *
 * Adding 'rhythm' or 'behavioural' here would turn a self-reported tendency into a reason a job
 * ranks lower for somebody. That is the decision this constant exists to make visible, and
 * separation.test.ts asserts its exact contents so it cannot be widened quietly.
 */
export const RELEVANCE_GROUPS: readonly DimensionGroup[] = ['workstyle', 'cognitive'] as const;

/** Groups collected for the person's own interest, and never read by matching. */
export const EXPLORATION_ONLY_GROUPS: readonly DimensionGroup[] = ['rhythm', 'behavioural'] as const;

export function isRelevanceDimension(key: string): boolean {
  const d = DIMENSION_BY_KEY[key];
  return !!d && RELEVANCE_GROUPS.includes(d.group);
}

/* -------------------------------------------------------------------------------- signal types */

export type SignalSource =
  | 'stated'    // they typed it
  | 'selected'  // they picked an option
  | 'inferred'; // read out of something else they said

export type Confirmation =
  | 'unconfirmed' // interpreted, not yet shown back
  | 'confirmed'   // shown back and agreed
  | 'adjusted'    // shown back and edited
  | 'rejected';   // shown back and denied — kept, so it is not re-inferred

export interface Signal {
  /** 0..1. Not a score and not a percentage of anything; a strength of preference. */
  value: number;
  confidence: number;
  source: SignalSource;
  confirmation: Confirmation;
  modelVersion: string;
  at: string;
  /** ids of the rawResponses this reading came out of. */
  from: string[];
}

/** A named thing rather than a scalar: an interest, a skill, something they do not want. */
export interface Tag {
  key: string;
  label: string;
  confidence: number;
  source: SignalSource;
  confirmation: Confirmation;
  from: string[];
}

export interface RawResponse {
  id: string;
  at: string;
  /** null for the opening free text; otherwise the question that was asked. */
  questionId: string | null;
  /** Option ids picked, in the order picked. */
  selected: string[];
  /** EXACTLY what was typed. Never normalised, never rewritten, never replaced. */
  text: string;
  /** Which interpreter read it, so a later one can tell it has not read this yet. */
  modelVersion: string;
}

/**
 * "Quiet when I am solving something hard, loud people when I am brainstorming" — two readings of
 * the same person, each true in its own context. Stored beside the scalars, not instead of them.
 */
export interface ContextDependency {
  context: string;
  label: string;
  dimensions: Record<string, number>;
  /** Their words. Shown back in the confirmation panel so the reading can be checked against them. */
  quote: string;
}

export type CareerStage = 'student' | 'early' | 'experienced' | 'senior' | 'unknown';

export interface ReflectionBlock {
  /** What they gave us. Only ever a date, and only when they typed one. */
  birthDate: string | null;
  sign: string | null;
  /** Always true. Present so a reader of a stored profile cannot mistake this for a match input. */
  excludedFromMatching: true;
  at: string;
}

export interface CareerProfile {
  profileVersion: number;
  createdAt: string;
  updatedAt: string;
  rawResponses: RawResponse[];
  dimensions: Record<string, Signal>;
  contextDependencies: ContextDependency[];
  interests: Tag[];
  skills: Tag[];
  /** What they said they do NOT want. Used to demote, never to hide. */
  avoid: Tag[];
  stage: CareerStage;
  stageConfidence: number;
  /** Questions already put to them, so the engine does not repeat itself. */
  asked: string[];
  /** Questions they chose to skip. Never re-asked. */
  skipped: string[];
  /** Set only when they explicitly opted into the reflection layer. */
  reflection: ReflectionBlock | null;
}

/* ------------------------------------------------------------------------------- construction */

export function emptyProfile(now = new Date().toISOString()): CareerProfile {
  return {
    profileVersion: PROFILE_VERSION,
    createdAt: now,
    updatedAt: now,
    rawResponses: [],
    dimensions: {},
    contextDependencies: [],
    interests: [],
    skills: [],
    avoid: [],
    stage: 'unknown',
    stageConfidence: 0,
    asked: [],
    skipped: [],
    reflection: null,
  };
}

export const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);

/**
 * Fold a new reading of a dimension into an existing one.
 *
 * A CONFIRMED OR ADJUSTED SIGNAL IS NOT OVERWRITTEN BY AN INFERENCE. Once somebody has looked at
 * what we understood and said "yes" or "no, like this", a later guess drawn out of a different
 * sentence does not get to quietly move it back. It takes another statement from them to change it.
 */
export function mergeSignal(existing: Signal | undefined, incoming: Signal): Signal {
  const fresh: Signal = { ...incoming, value: clamp01(incoming.value), confidence: clamp01(incoming.confidence) };
  if (!existing) return fresh;

  const locked = existing.confirmation === 'confirmed'
    || existing.confirmation === 'adjusted'
    || existing.confirmation === 'rejected';
  if (locked && incoming.source === 'inferred') return existing;
  if (existing.confirmation === 'rejected' && incoming.source !== 'stated') return existing;

  // Confidence-weighted, so a firm statement moves the value further than a faint hint does.
  const wa = clamp01(existing.confidence);
  const wb = fresh.confidence;
  const total = wa + wb;
  const value = total > 0 ? (existing.value * wa + fresh.value * wb) / total : fresh.value;

  // AGREEMENT RAISES CONFIDENCE. DISAGREEMENT LOWERS IT.
  //
  // Two sentences pointing the same way are better evidence than either alone, so agreement moves
  // the result from the stronger of the two towards their noisy-OR union — which is always at least
  // the stronger one, and saturates below 1 rather than reaching certainty from repetition.
  //
  // Two pointing opposite ways are LESS certain than either alone, which is the half that a naive
  // "take the max" gets backwards: a model that grows more confident every time it is contradicted
  // will end up most sure about the people who told it the most complicated truth.
  const agree = 1 - Math.abs(existing.value - fresh.value);
  const strongest = Math.max(wa, wb);
  const union = 1 - (1 - wa) * (1 - wb);
  const confidence = clamp01(agree >= 0.5
    ? strongest + (union - strongest) * ((agree - 0.5) * 2)
    : strongest * (0.4 + 1.2 * agree));

  return {
    value: clamp01(value),
    confidence,
    source: incoming.source === 'stated' ? 'stated' : existing.source,
    confirmation: locked ? existing.confirmation : incoming.confirmation,
    modelVersion: incoming.modelVersion,
    at: incoming.at,
    from: Array.from(new Set([...existing.from, ...incoming.from])).slice(-8),
  };
}

/** Fold a tag into a list, keeping one entry per key and the better evidence for it. */
export function mergeTag(list: Tag[], incoming: Tag): Tag[] {
  const i = list.findIndex((t) => t.key === incoming.key);
  if (i < 0) return [...list, { ...incoming, confidence: clamp01(incoming.confidence) }];
  const prev = list[i];
  if (prev.confirmation === 'rejected' && incoming.source !== 'stated') return list;
  const next: Tag = {
    ...prev,
    label: incoming.label || prev.label,
    confidence: clamp01(Math.max(prev.confidence, incoming.confidence)),
    source: incoming.source === 'stated' ? 'stated' : prev.source,
    confirmation: prev.confirmation === 'confirmed' || prev.confirmation === 'adjusted'
      ? prev.confirmation
      : incoming.confirmation,
    from: Array.from(new Set([...prev.from, ...incoming.from])).slice(-8),
  };
  const out = list.slice();
  out[i] = next;
  return out;
}

/* --------------------------------------------------------------------------- reading a profile */

/** The dimensions the ranker is allowed to see. THE ONLY DOOR — rank.ts calls nothing else. */
export function relevanceDimensions(p: CareerProfile): Record<string, Signal> {
  const out: Record<string, Signal> = {};
  for (const [k, s] of Object.entries(p.dimensions || {})) {
    if (!isRelevanceDimension(k)) continue;
    if (s.confirmation === 'rejected') continue;
    out[k] = s;
  }
  return out;
}

/** Dimensions held for the person's own reading, which matching never sees. */
export function explorationDimensions(p: CareerProfile): Record<string, Signal> {
  const out: Record<string, Signal> = {};
  for (const [k, s] of Object.entries(p.dimensions || {})) {
    const d = DIMENSION_BY_KEY[k];
    if (!d || !EXPLORATION_ONLY_GROUPS.includes(d.group)) continue;
    if (s.confirmation === 'rejected') continue;
    out[k] = s;
  }
  return out;
}

/** Signals strong and confident enough to be worth acting on, or worth saying out loud. */
export function heldDimensions(p: CareerProfile, minValue = 0.55, minConfidence = 0.3): string[] {
  return Object.entries(p.dimensions || {})
    .filter(([, s]) => s.confirmation !== 'rejected' && s.value >= minValue && s.confidence >= minConfidence)
    .sort((a, b) => (b[1].value * b[1].confidence) - (a[1].value * a[1].confidence))
    .map(([k]) => k);
}

/**
 * How much this profile can currently support. 0 means nothing useful is known.
 *
 * NOT a percentage of a person and never shown as one. It is used for one decision only: whether
 * another question, or an offer to read a CV, would materially improve what can be shown.
 */
export function profileReadiness(p: CareerProfile): number {
  const kept = (l: Tag[]) => (l || []).filter((t) => t.confirmation !== 'rejected').length;
  const interests = Math.min(1, kept(p.interests) / 3);
  const skills = Math.min(1, kept(p.skills) / 4);
  const rel = Object.values(relevanceDimensions(p));
  const dims = Math.min(1, rel.reduce((n, s) => n + s.confidence, 0) / 4);
  const stage = p.stage === 'unknown' ? 0 : Math.max(0.4, p.stageConfidence);
  return clamp01(interests * 0.4 + skills * 0.2 + dims * 0.25 + stage * 0.15);
}

/** What is still missing, in the order it would help most. Read by the questions engine and shown. */
export function uncertainties(p: CareerProfile): string[] {
  const out: string[] = [];
  if ((p.interests || []).filter((t) => t.confirmation !== 'rejected').length === 0) {
    out.push('What kind of work interests you');
  }
  if (p.stage === 'unknown') out.push('Where you are in your career');
  if ((p.skills || []).length === 0) out.push('What you have actually worked with');
  const rel = relevanceDimensions(p);
  if (!rel.research_orientation && !rel.implementation && !rel.creativity) {
    out.push('Whether you lean towards research, building or creating');
  }
  if (!rel.collaboration && !rel.deep_focus) out.push('How you like to work day to day');
  return out;
}

/** Every raw response, newest first — the person's own words, for the edit-and-correct panel. */
export function ownWords(p: CareerProfile): RawResponse[] {
  return (p.rawResponses || []).slice().reverse();
}
