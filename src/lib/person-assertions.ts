// src/lib/person-assertions.ts — HOW A THING ABOUT A PERSON CAME TO BE KNOWN.
//
// =================================================================================================
// READ THIS FIRST: WHY THIS FILE IS NOT CALLED provenance.ts
// =================================================================================================
//
// It should be. While this spine was being written, another workflow was writing
// src/lib/provenance.ts in the same worktree — a fuller model with frozen elements, a provenance
// table carrying a CHECK constraint, a verify() that cannot be called without a named human, and a
// value fingerprint so a verification goes stale when the column underneath it changes. That is the
// better long-term home for this vocabulary and this file does not compete with it.
//
// So the SEVEN VALUES BELOW ARE ITS SEVEN VALUES, spelled identically, deliberately:
//
//   factual  explicitly_provided  inferred  calculated  verified  predicted  recommended
//
// They are also the seven the founder spec names. That is not a coincidence and it is the whole
// convergence plan: when src/lib/provenance.ts exports its type, this file's ASSERTION_TYPES is
// deleted and `export type AssertionType` here becomes a re-export of that one. No stored value
// changes, because the strings written to hr_person_identities.assertion_type and
// hr_role_requirements.assertion_type are already those strings. It is a one-line change and no data
// migration, which is exactly what "aligned rather than forked" has to mean to be worth saying.
//
// WHAT THIS FILE DOES THAT THE OTHER ONE DOES NOT, AND WHY IT SURVIVES EITHER WAY: it is the RENDER
// CONTRACT. It answers "given this assertion type, what is a screen allowed to say", which is a
// presentation question the storage model should not own. assertionSentence(), mustSayInWords,
// chainAssertion() and the EvidenceChain shape are read by every surface in the spine.
//
// =================================================================================================
// THE RULE THIS EXISTS FOR
// =================================================================================================
//
// This codebase already stores a great deal about people, and stores almost all of it as an
// undifferentiated fact. `applications.education` is what an applicant typed. `hr_employees.designation`
// is what HR typed. `training_enrollments.progress_pct` is computed. `hr_employee_skills.level` is a
// number somebody picked from a dropdown about their own ability. On a screen they all render the
// same way: a value, in a box, with a label. A reader cannot tell which of them anybody checked.
//
// A screen that shows a self-recorded skill level the same way it shows a signed certificate is a
// screen making a claim nobody made. Hence:
//
//   NEVER CONVERT AN INFERENCE INTO A FACT.
//
// There is no promote(), no upgrade() and no function here that takes a weaker assertion and returns
// a stronger one. chainAssertion() only ever moves DOWNWARDS.
//
// This module is pure: no database, no I/O, no side effects.
//
// =================================================================================================
// WHY THIS EXTENDS hr_employee_skills.source RATHER THAN REPLACING IT
// =================================================================================================
//
// That column already holds self | manager | course | assessment, already has labels, and already
// has a writer that REFUSES an unconfirmed evidence reference (src/lib/skills.ts re-reads the
// completion through learning-progress.ts and the passed attempt through learning-doors.ts). Adding
// assertion-type values to that enum that nothing writes would be decoration: a wider enum with no
// writer is a wider enum, not a better record. So the mapping lives here as a pure function —
// assertionForSkillSource() — and the column keeps its meaning.
//
// =================================================================================================
// PREDICTED IS DECLARED, AND EMITTED BY NOTHING
// =================================================================================================
//
// The vocabulary is complete on purpose: a type that does not exist cannot be labelled, and an
// unlabelled prediction is exactly what gets read as a fact. But nothing in this repository produces
// a `predicted` value about a person, and assertAllowedAboutPerson() below exists so the first thing
// that tries has to delete a named check rather than simply not notice a rule. Attrition risk,
// flight risk, potential and culture fit are not "not built yet" — they are refused, with a reason.

/**
 * The seven ways something about a person can be known here.
 *
 * ORDER IS MEANINGFUL. STRENGTH below reads this for the narrow purpose of choosing which of two
 * records to keep on a merge, and for capping a chain at its weakest link. It is NOT a score, it is
 * never summed, and it never becomes a number on a screen.
 */
export const ASSERTION_TYPES = [
  'factual',
  'verified',
  'explicitly_provided',
  'calculated',
  'inferred',
  'predicted',
  'recommended',
] as const;

export type AssertionType = (typeof ASSERTION_TYPES)[number];

// -------------------------------------------------------------------------------------------------
// DRIFT GUARD — ONE VOCABULARY, ENFORCED BY THE COMPILER RATHER THAN BY A COMMENT
//
// src/lib/provenance.ts owns this vocabulary for the whole system, and the seven strings above are
// its seven, spelled identically. They are DECLARED here rather than re-exported for one reason:
// this module is pure — it has no runtime imports at all, and four spine modules depend on that —
// while provenance.ts imports @/lib/db, which calls dotenv.config() and constructs a postgres client
// at import time. A value re-export would drag a database connection into every screen that only
// wanted to know what a word means.
//
// So the coupling is TYPE-ONLY and erased at compile time: nothing is added to the emitted
// JavaScript and no import appears at runtime. What it buys is that the two lists can no longer
// drift apart quietly. Add a word here that provenance.ts does not have, or drop one it does, and
// this file stops compiling with a named error — instead of two modules disagreeing about what
// "verified" means while every screen reports success.
// -------------------------------------------------------------------------------------------------
import type { AssertionType as ProvenanceAssertionType } from '@/lib/provenance';

/** Both must resolve to `never`: neither list may hold a word the other does not. */
type _WordsNotInProvenance = Exclude<AssertionType, ProvenanceAssertionType>;
type _WordsMissingHere = Exclude<ProvenanceAssertionType, AssertionType>;

const _vocabulariesAgree: [_WordsNotInProvenance, _WordsMissingHere] extends [never, never]
  ? true
  : 'src/lib/person-assertions.ts and src/lib/provenance.ts disagree about the seven assertion types'
  = true;
void _vocabulariesAgree;

export function isAssertionType(v: unknown): v is AssertionType {
  return typeof v === 'string' && (ASSERTION_TYPES as readonly string[]).indexOf(v) >= 0;
}

/** A stored value that is not one of the seven is treated as the weakest honest reading, never the strongest. */
export function toAssertionType(v: unknown): AssertionType {
  return isAssertionType(v) ? v : 'explicitly_provided';
}

export interface AssertionMeta {
  /** The word on the screen. Short, because it sits in a chip beside a value. */
  label: string;
  /** One sentence a reader can act on, printed beside the value. Never jargon. */
  meaning: string;
  /**
   * Must the screen say this in WORDS, not only in a colour or an icon?
   *
   * True for everything that is not a record this system owns and checked. A grey chip is not a
   * disclosure: a person reading their own record has to be able to see the word "inferred" in a
   * sentence, not decode a palette.
   */
  mustSayInWords: boolean;
  /** May a consequential decision about a person rest on this ALONE, with nothing beside it? */
  sufficientAlone: boolean;
}

export const ASSERTION_META: Record<AssertionType, AssertionMeta> = {
  factual: {
    label: 'Recorded here',
    meaning: 'A record this platform created and owns. It says an event happened on this system, and nothing more.',
    mustSayInWords: false,
    sufficientAlone: true,
  },
  verified: {
    label: 'Checked',
    meaning: 'Checked against an independent record, and the record it was checked against is named and linked.',
    mustSayInWords: false,
    sufficientAlone: true,
  },
  explicitly_provided: {
    label: 'Stated',
    meaning: 'Somebody stated this. It is recorded honestly as their statement, and nobody has checked it.',
    mustSayInWords: true,
    sufficientAlone: false,
  },
  calculated: {
    label: 'Worked out',
    meaning: 'Worked out from records already held, by a rule that can be named and re-run. It is only as good as what it read.',
    mustSayInWords: true,
    sufficientAlone: false,
  },
  inferred: {
    label: 'Inferred',
    meaning: 'A judgement nobody stated and nothing proved. It may be wrong, and it must never be read as a fact about this person.',
    mustSayInWords: true,
    sufficientAlone: false,
  },
  predicted: {
    label: 'Predicted',
    meaning: 'A statement about what has not happened. Nothing in this system produces one about a person.',
    mustSayInWords: true,
    sufficientAlone: false,
  },
  recommended: {
    label: 'Suggested',
    meaning: 'Something this system suggests a human considers. It decides nothing, and it is not a finding about the person.',
    mustSayInWords: true,
    sufficientAlone: false,
  },
};

/** Strongest first. Used ONLY for merge-keeping and chain-capping. Not a score. */
const STRENGTH: AssertionType[] = [
  'factual', 'verified', 'calculated', 'explicitly_provided', 'inferred', 'recommended', 'predicted',
];

/**
 * Which of two assertion types is the stronger record.
 *
 * Used when a skill merge has to keep one of two rows about the same person and the same skill. It
 * deliberately prefers a CHECKED row over a higher self-recorded level, because keeping the bigger
 * number would be a silent upgrade of a claim nobody made.
 */
export function strongerAssertion(a: AssertionType, b: AssertionType): AssertionType {
  return STRENGTH.indexOf(a) <= STRENGTH.indexOf(b) ? a : b;
}

/** The weaker of two — the one a chain is limited by. */
export function weakerAssertion(a: AssertionType, b: AssertionType): AssertionType {
  return STRENGTH.indexOf(a) >= STRENGTH.indexOf(b) ? a : b;
}

export function assertionLabel(a: AssertionType): string {
  return ASSERTION_META[a] ? ASSERTION_META[a].label : 'Unlabelled';
}

export function assertionMeaning(a: AssertionType): string {
  return ASSERTION_META[a]
    ? ASSERTION_META[a].meaning
    : 'Nothing records how this was established, so it must not be read as checked.';
}

export function mustSayInWords(a: AssertionType): boolean {
  return ASSERTION_META[a] ? ASSERTION_META[a].mustSayInWords : true;
}

/**
 * The sentence a screen prints beside a value, built from what the value IS.
 *
 * Callers pass the subject in their own words ("This skill level", "This reporting line") so the
 * sentence reads naturally where it lands, and so one assertion type never gets two wordings across
 * two screens.
 */
export function assertionSentence(a: AssertionType, subject: string): string {
  const s = String(subject || 'This').trim() || 'This';
  switch (a) {
    case 'factual': return s + ' is a record this platform created.';
    case 'verified': return s + ' was checked against the record named beside it.';
    case 'explicitly_provided': return s + ' was stated by a person. Nobody has checked it.';
    case 'calculated': return s + ' was worked out from records already held, not stated by anybody.';
    case 'inferred': return s + ' is inferred. Nobody stated it and nothing proves it.';
    case 'predicted': return s + ' would be a prediction, and this system makes none about a person.';
    case 'recommended': return s + ' is a suggestion for a human to consider. It decides nothing.';
    default: return s + ' has no recorded provenance, so nothing here should be read as checked.';
  }
}

// -------------------------------------------------------------------------------------------------
// WHAT MAY NEVER BE ASSERTED ABOUT A PERSON HERE
// -------------------------------------------------------------------------------------------------

/**
 * Subjects this system refuses to hold an assertion about, at any assertion type.
 *
 * These are not "unimplemented". Each is refused because there is no instrument behind it, no
 * validation, and no way to produce it that is not a proxy for a protected attribute or a
 * surveillance signal. The refusal is a FUNCTION rather than a comment so a future writer has to
 * delete a check rather than simply not notice a rule.
 */
export const REFUSED_SUBJECTS: { key: string; why: string }[] = [
  { key: 'attrition', why: 'Predicting whether somebody will leave has no labelled history here, and could only be built from attendance, activity or communication — all surveillance signals this system does not infer from.' },
  { key: 'flight risk', why: 'Same as attrition: there is no instrument, and the only available inputs are monitoring signals.' },
  { key: 'retention risk', why: 'Same as attrition.' },
  { key: 'potential', why: 'Potential has no definition here that is not a proxy for who somebody reminds a manager of.' },
  { key: 'culture fit', why: 'Culture fit is a protected-attribute proxy generator. Judge evidence and capability instead.' },
  { key: 'personality', why: 'There is no validated instrument behind this, and no partner administering one.' },
  { key: 'engagement score', why: 'Every available input is an activity or communication metric, which is surveillance-based inference.' },
  { key: 'sentiment', why: 'Reading tone out of somebody\'s work communication is monitoring, and it is not evidence of capability.' },
  { key: 'productivity index', why: 'Built from activity volume, which measures what is easy to count rather than what was done.' },
  { key: 'loyalty', why: 'Not measurable, and every proxy for it is a monitoring signal.' },
];

/**
 * Attributes that must never be a decision variable, never be inferred, and never become a column,
 * a dimension or a job requirement.
 *
 * refuse — the term used ON ITS OWN is the attribute. There is no honest reading of a job
 *          requirement called "religion" or a skill called "caste".
 * review — the term appears inside a longer phrase, where it may be entirely legitimate
 *          ("Religious studies teaching", "Accessibility engineering", "Mental health first aid",
 *          "Occupational health and safety"). The spine does not block those; it names the concern
 *          and lets a human decide, because a filter that silently refuses real skills only teaches
 *          people to word around it, and a reviewer never sees what was reworded.
 */
const PROTECTED_TERMS = [
  'race', 'ethnicity', 'caste', 'religion', 'religious belief', 'faith',
  'politics', 'political', 'political view', 'union membership',
  'sexual orientation', 'sexuality', 'gender identity', 'gender', 'sex',
  'disability', 'disabled', 'handicap', 'impairment',
  'pregnancy', 'pregnant', 'maternity', 'fertility', 'menstrual', 'menopause',
  'health', 'health condition', 'medical', 'diagnosis', 'mental health',
  'age', 'date of birth', 'marital status', 'national origin', 'immigration status',
];

export interface ProtectedConcern {
  level: 'none' | 'review' | 'refuse';
  term: string | null;
  sentence: string;
}

/**
 * Does this text name a protected or sensitive attribute?
 *
 * Called before a skill enters the catalogue and before a requirement is attached to a job — the two
 * places in the spine where somebody could create the seam. It is NOT called on free text a person
 * wrote about their own life: refusing somebody a sentence about themselves is a different and worse
 * thing than refusing to make that sentence a decision variable.
 */
export function protectedAttributeConcern(text: string): ProtectedConcern {
  const raw = String(text || '').trim();
  if (!raw) return { level: 'none', term: null, sentence: '' };
  const norm = raw.toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (const term of PROTECTED_TERMS) {
    if (norm === term) {
      return {
        level: 'refuse',
        term,
        sentence: 'This names a protected or sensitive attribute (' + term + '). It cannot be a skill or a job '
          + 'requirement, because anything a decision is made against becomes a decision variable. Nothing here '
          + 'infers it either.',
      };
    }
  }
  for (const term of PROTECTED_TERMS) {
    const re = new RegExp('(^| )' + term + '( |$)');
    if (re.test(norm)) {
      return {
        level: 'review',
        term,
        sentence: 'This contains the word "' + term + '", which names a protected or sensitive attribute. It may be '
          + 'entirely legitimate — a subject taught, a field of practice, a safety qualification — so it is not '
          + 'refused. Read it once and make sure it describes work, not a person.',
      };
    }
  }
  return { level: 'none', term: null, sentence: '' };
}

/**
 * May this system hold an assertion about this subject at all?
 *
 * Returns the refusal sentence rather than a boolean alone, because a refusal a screen cannot print
 * is a refusal a screen will route around.
 */
export function assertAllowedAboutPerson(subject: string): { allowed: boolean; why: string } {
  const norm = String(subject || '').toLowerCase().trim();
  if (!norm) return { allowed: false, why: 'Nothing was named, so nothing can be asserted.' };
  for (const r of REFUSED_SUBJECTS) {
    if (norm.indexOf(r.key) >= 0) return { allowed: false, why: r.why };
  }
  const concern = protectedAttributeConcern(subject);
  if (concern.level === 'refuse') return { allowed: false, why: concern.sentence };
  return { allowed: true, why: '' };
}

// -------------------------------------------------------------------------------------------------
// THE BRIDGE TO WHAT IS ALREADY STORED
// -------------------------------------------------------------------------------------------------

/**
 * hr_employee_skills.source -> assertion type.
 *
 * self / manager      a person stated a level. Different people, same epistemic weight: nobody
 *                     checked either. The screen still shows WHO, because "my manager says" and
 *                     "I say" are different sentences even when both are unchecked.
 * course / assessment CHECKED. src/lib/skills.ts re-reads the completion or the passed attempt
 *                     through the module that owns it and refuses a reference that does not confirm,
 *                     so a row carrying one of these was verified at WRITE time, not at read time.
 *
 * An unknown value maps to explicitly_provided, never to verified: an unrecognised source is a
 * source nobody checked, and defaulting the other way would upgrade a claim by accident.
 */
export function assertionForSkillSource(source: string | null | undefined): AssertionType {
  switch (String(source || '').toLowerCase()) {
    case 'course':
    case 'assessment':
      return 'verified';
    case 'self':
    case 'manager':
      return 'explicitly_provided';
    default:
      return 'explicitly_provided';
  }
}

/** How a screen names the person or record behind a skill row, given its source. */
export function skillSourceActor(source: string | null | undefined): string {
  switch (String(source || '').toLowerCase()) {
    case 'self': return 'the employee, about themselves';
    case 'manager': return 'somebody the Organization Graph records as answering for their work';
    case 'course': return 'a course completion on this platform';
    case 'assessment': return 'a passed assessment on this platform';
    default: return 'an unrecorded source';
  }
}

// -------------------------------------------------------------------------------------------------
// THE SEVEN QUESTIONS
// -------------------------------------------------------------------------------------------------

export interface EvidenceCitation {
  /** What kind of record this is, in words: 'Course completion', 'Passed assessment', 'Stated by the employee'. */
  kind: string;
  /** The sentence the OWNING module wrote. Never re-worded here — two screens must not word one fact twice. */
  label: string;
  /** Where to see it, when it can be seen. */
  url: string | null;
  assertion: AssertionType;
  /** When the record was made, ISO, where known. */
  at: string | null;
}

/**
 * What every consequential conclusion in the spine must be able to answer, in full, on the screen
 * that shows it. The founder spec's seven questions, as a type.
 *
 * This is a TYPE rather than a convention, because a convention is what the fifth screen quietly
 * drops. A function returning a conclusion about a person returns this alongside it, and a page that
 * cannot render all seven does not render the conclusion.
 */
export interface EvidenceChain {
  /** 1. What was concluded, in a sentence a person could read about themselves. */
  concluded: string;
  /** 2. Why — the rule that produced it, named, not paraphrased. */
  why: string;
  /** 3. On what evidence — the specific records, with a link where one exists. */
  evidence: EvidenceCitation[];
  /** 4. Under what assumptions — every one, including the ones that are usually right. */
  assumptions: string[];
  /** 5. What is uncertain — what would change this, and what it cannot see. */
  uncertain: string[];
  /** 6. What data influenced it — the tables and records read, named. */
  dataRead: string[];
  /** 7. Can a human override it, and how they do that from here. */
  overridable: { yes: boolean; how: string };
  /** The assertion type of the conclusion itself. Never stronger than its weakest cited evidence. */
  assertion: AssertionType;
}

/**
 * A conclusion may never be stronger than the weakest thing it rests on.
 *
 * The failure this prevents is the most likely one in the whole spine: three checked certificates
 * plus one inferred skill-graph hop rendering as "checked". A chain is as good as its weakest link.
 *
 * `ceiling` caps it further. A conclusion ASSEMBLED by a rule is at best `calculated` even when every
 * input was checked, because the assembly is ours and nobody checked that either.
 */
export function chainAssertion(citations: readonly EvidenceCitation[], ceiling: AssertionType = 'verified'): AssertionType {
  if (!citations.length) return 'inferred';
  let weakest: AssertionType = 'factual';
  for (const c of citations) weakest = weakerAssertion(weakest, c.assertion);
  return weakerAssertion(weakest, ceiling);
}

/** An empty chain, so a caller that could not read anything still returns the shape and says so. */
export function unreadableChain(what: string, why: string): EvidenceChain {
  return {
    concluded: 'We could not read ' + what + ', so nothing is concluded.',
    why,
    evidence: [],
    assumptions: ['Nothing was assumed, because nothing was read.'],
    uncertain: ['Everything. This is a failure to read, not a finding about the person.'],
    dataRead: [],
    overridable: { yes: false, how: 'There is nothing to override. Try again in a moment.' },
    assertion: 'inferred',
  };
}
