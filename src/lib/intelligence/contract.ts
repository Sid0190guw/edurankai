// src/lib/intelligence/contract.ts — PATCH 15. THE EMPLOYEE'S OWN VIEW OF THEIR INTELLIGENCE RECORD:
// WHAT IT MAY SAY, WHAT IT MAY NEVER SAY, AND IN WHAT WORDS.
//
// =================================================================================================
// WHAT THIS PATCH OWNS, AND WHAT IT DELIBERATELY DOES NOT
// =================================================================================================
//
// Patch 15 is a VIEW. There is one Master Employee Intelligence Record in this codebase and this
// patch does not hold a second copy of it:
//
//   the person and their aspects   src/lib/digital-twin.ts        (buildDigitalTwin, twinAccess)
//   why a capability is believed   src/lib/evidence-graph.ts      (whyDoesTheSystemBelieve)
//   the job, in the same words     src/lib/job-twin.ts            (buildJobTwin, jobRequirements)
//   reviews, goals, feedback       src/lib/performance.ts
//   learning and certificates      src/lib/performance-learning.ts
//   filed work and verified hours  src/lib/eims-evidence.ts
//   who touched a record           audit_log, through src/lib/audit.ts
//
// Every one of those is another patch's module. This one READS them and composes. It writes to
// exactly three tables of its own, and every one of them holds something the employee themselves
// authored or decided: a reflection, a consent, a correction request. Nothing in this patch writes
// an assessment of a person, because an employee-facing view that scored people would be a scoring
// engine wearing a portal.
//
// =================================================================================================
// THE ENVELOPE. EVERY STATEMENT ON THE SCREEN CARRIES ITS OWN RECEIPT.
// =================================================================================================
//
//   INPUTS -> PROCESSING -> OUTPUT -> EVIDENCE -> CONFIDENCE -> TIMESTAMP
//
// An Insight that cannot fill all six is not rendered. That is not decoration: the difference
// between "you have been consistent with your learning" and the same words with the six fields
// attached is the difference between a system telling somebody who they are and a system showing
// somebody what it read. Only the second one can be argued with, and being able to argue with it is
// the point of the correction request at the bottom of the screen.
//
// CONFIDENCE IS NOT A PERCENTAGE. A number invites arithmetic that the underlying records cannot
// support, and a person shown "74% collaborative" will reasonably ask what the 74 is. It is an
// ordinal with a written meaning, and 'insufficient' is a first-class answer that renders.
//
// =================================================================================================
// THE LANGUAGE RULE, ENFORCED RATHER THAN REQUESTED
// =================================================================================================
//
// Supportive and non-deterministic is a property of the strings, so it is tested like one.
// DETERMINISTIC_PATTERNS below is the list of ways a sentence stops being a description of records
// and becomes a verdict on a person, and languageProblems() finds them. The test suite runs it over
// every fixed string this patch can emit. A sentence that fails does not ship.
//
// This is also where the vocabulary rule lives: nothing in this patch, on any surface, uses
// birth-based or traditional-computation vocabulary. It is not softened here, it is absent — this
// view composes demonstrated work records and the employee's own words, and there is no input to it
// that could carry such a signal.

/* ------------------------------------------------------------------------------------------------
 * SECTIONS
 * --------------------------------------------------------------------------------------------- */

/**
 * The ten things the employee can see about themselves, as one closed vocabulary.
 *
 * A section is not a permission. Every section here is about the reader and the reader alone, and
 * the whole surface is gated on being that person. The list exists so the page, the tests and the
 * handoff contract all name the same ten things.
 */
export const SELF_SECTIONS = [
  'strengths',
  'role_alignment',
  'growth_areas',
  'skill_development',
  'behavioural_trends',
  'development_plan',
  'achievements',
  'time_insights',
  'feedback_summary',
  'reflection',
] as const;

export type SelfSection = (typeof SELF_SECTIONS)[number];

export const SECTION_LABELS: Record<SelfSection, string> = {
  strengths: 'Professional strengths',
  role_alignment: 'How your record lines up with your role',
  growth_areas: 'Areas you could grow into',
  skill_development: 'Skills and how they were evidenced',
  behavioural_trends: 'Patterns in your working record',
  development_plan: 'Your development plan',
  achievements: 'Recent achievements',
  time_insights: 'How this has changed over time',
  feedback_summary: 'What feedback has been about',
  reflection: 'Your own reflections',
};

/**
 * What each section is FOR, in the second person, printed on the screen above it.
 *
 * These are load-bearing. A section header with no statement of purpose is where a reader supplies
 * their own — usually a harsher one than the records support.
 */
export const SECTION_PURPOSE: Record<SelfSection, string> = {
  strengths:
    'Work this platform holds a record of, where somebody named confirmed it or you completed something that was assessed. It is a description of what is on file, not a ranking against your colleagues.',
  role_alignment:
    'Your recorded capabilities set beside the requirements written down for your role. Where a requirement has no evidence yet, that is a gap in the record as much as anything else.',
  growth_areas:
    'Places where the record is thin or a requirement is unmet. Nothing here is a criticism, and none of it is shared as a judgement of you.',
  skill_development:
    'Each skill on your record with the strongest evidence behind it, and how that evidence got there.',
  behavioural_trends:
    'Patterns across work you filed and work that was verified. These come from records you can already see, not from monitoring.',
  development_plan:
    'Learning assigned to you, goals you set, and suggestions you can accept or ignore. Nothing here is decided about you.',
  achievements:
    'Things recorded on this platform in the recent past: verified work, completed learning, certificates issued.',
  time_insights:
    'The same record, read over months rather than at one moment, so a quiet period reads as a quiet period rather than as who you are.',
  feedback_summary:
    'What colleagues have written about, grouped by theme. Individual notes and who wrote them are not shown here.',
  reflection:
    'Your own words, written by you, kept for you. Nobody is shown these unless you share them yourself.',
};

/* ------------------------------------------------------------------------------------------------
 * THE ENVELOPE
 * --------------------------------------------------------------------------------------------- */

/**
 * How much the record actually supports the sentence beside it.
 *
 * ORDINAL, NOT NUMERIC, and 'insufficient' renders rather than hiding. "There is not enough on
 * record to say anything about this yet" is a complete answer and a true one; an empty section with
 * no sentence is the same information delivered as a shrug.
 */
export const CONFIDENCE_LEVELS = ['insufficient', 'partial', 'observed', 'corroborated'] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export const CONFIDENCE_LABELS: Record<Confidence, string> = {
  insufficient: 'Not enough on record',
  partial: 'Based on part of the record',
  observed: 'Based on records held here',
  corroborated: 'Confirmed by a named person',
};

export const CONFIDENCE_MEANING: Record<Confidence, string> = {
  insufficient:
    'There is too little on file to say anything here yet. That is a fact about the records, not about you.',
  partial:
    'Some of what this would need is on file and some is not, so treat it as incomplete rather than as a conclusion.',
  observed:
    'This describes records this platform holds. It is what happened, not an interpretation of why.',
  corroborated:
    'A named person confirmed this in writing, or it was issued by a body outside this platform.',
};

/** A pointer back to the surface that owns the underlying record, so a statement can be checked. */
export interface EvidenceRef {
  /** What it is, in the reader's words. */
  label: string;
  /** The module that owns it. Named so a reader — or the next agent — can find the source. */
  owner: string;
  /** A route the employee can actually open, or null when the record has no self-service surface. */
  href: string | null;
  /** When the underlying thing happened, ISO date or null. */
  occurredAt: string | null;
}

/**
 * ONE STATEMENT ON THE SCREEN, WITH ITS RECEIPT.
 *
 * `output` is what the person reads. The other five fields are why they are allowed to read it, and
 * renderableInsight() refuses one that is missing any of them.
 */
export interface Insight {
  /** Stable within a section, so a correction request can name exactly what is being disputed. */
  key: string;
  section: SelfSection;
  /** The surfaces that were read. Named as surfaces, never as columns or internal computations. */
  inputs: string[];
  /** The rule, written out in one sentence, in words a non-engineer can disagree with. */
  processing: string;
  /** The sentence the person reads. Supportive, non-deterministic, checked by languageProblems(). */
  output: string;
  evidence: EvidenceRef[];
  confidence: Confidence;
  /** ISO timestamp of the most recent record behind this, or null when nothing dated it. */
  observedAt: string | null;
}

/** A section as it reaches the page: its insights, or the reason there are none. */
export interface SelfSectionView {
  section: SelfSection;
  label: string;
  purpose: string;
  insights: Insight[];
  /**
   * Set when the section is empty. THREE different empties, never collapsed:
   * nothing recorded yet / not enough to summarise without identifying somebody / could not be read.
   */
  emptyReason: string | null;
  /** True when a read failed. The page must not print "you have none" over this. */
  unreadable: boolean;
}

/**
 * Every field an Insight needs before it may be shown.
 *
 * A statement about a person with no inputs named, no rule written down and no evidence behind it is
 * exactly the thing this whole system exists to keep off a screen — so it is dropped here rather
 * than trusted to every caller to remember.
 */
export function renderableInsight(i: Insight | null | undefined): boolean {
  if (!i) return false;
  if (!i.key || !i.section) return false;
  if (!i.output || !i.output.trim()) return false;
  if (!i.processing || !i.processing.trim()) return false;
  if (!Array.isArray(i.inputs) || i.inputs.length === 0) return false;
  if (!Array.isArray(i.evidence)) return false;
  if (CONFIDENCE_LEVELS.indexOf(i.confidence) < 0) return false;
  // An insight with no evidence rows is allowed ONLY at 'insufficient', where the absence of
  // evidence is precisely what it is reporting.
  if (i.evidence.length === 0 && i.confidence !== 'insufficient') return false;
  return true;
}

/* ------------------------------------------------------------------------------------------------
 * THE EXPOSURE BOUNDARY
 * --------------------------------------------------------------------------------------------- */

/**
 * WHAT THIS SURFACE NEVER SHOWS, AND WHY.
 *
 * This list is printed on the page. A person told what is being withheld and for what reason can
 * ask about it; a person shown a screen that quietly omits things learns nothing and trusts less.
 *
 * Two of these protect the reader from a system, and two protect other people from the reader.
 */
export const NEVER_SHOWN: readonly { what: string; because: string }[] = Object.freeze([
  {
    what: 'Confidential HR notes',
    because:
      'Notes written by HR for HR are held under a different purpose from this view. They are not composed into it and no query behind this page reads them.',
  },
  {
    what: 'Who wrote a piece of feedback, where it was given in confidence',
    because:
      'Feedback here is summarised by theme and never attributed. Attribution would change what colleagues are willing to write, which would make the summary worse for you, not better.',
  },
  {
    what: 'Internal risk or review scoring not intended for you',
    because:
      'Any internal indicator that exists for a reviewer to act on is not a statement about you until a person has looked at it. It is not shown here in raw form, and nothing on this page is one.',
  },
  {
    what: 'Anything about another employee',
    because:
      'Every query behind this page is narrowed to your own record. Where a colleague appears at all it is because you named them.',
  },
  {
    what: 'The internal computation behind a summary',
    because:
      'The RULE behind every statement is written out beside it in plain words, which is the part you can check and dispute. The implementation detail is not the same thing and is not useful to you.',
  },
]);

/**
 * Key names that must never appear in a payload composed for the employee's own intelligence view.
 *
 * The same shape as digital-twin.ts's screenColumns(): a NAME-level screen, applied before anything
 * is rendered, so a future contributor who adds a field cannot quietly widen the surface. It is a
 * backstop and not the primary control — the primary control is that this patch never queries those
 * sources — but a backstop that fails loudly is worth its few lines.
 */
export const WITHHELD_KEY_SEGMENTS: readonly string[] = Object.freeze([
  'salary', 'ctc', 'compensation', 'bank', 'account number', 'ifsc', 'pan', 'aadhaar', 'passport',
  'risk score', 'flight risk', 'attrition risk', 'percentile', 'ranking',
  'hr note', 'hr notes', 'confidential', 'internal note', 'private note',
  'author', 'reviewer name', 'reviewer id',
  'gender', 'marital', 'religion', 'caste', 'disability', 'health', 'medical', 'symptom',
  'birth', 'nakshatra', 'rashi', 'horoscope', 'zodiac',
]);

export interface KeyScreen {
  allowed: string[];
  refused: { key: string; because: string }[];
}

const normaliseKey = (name: string): string[] =>
  String(name || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** True when this key name is one the employee view must not carry. */
export function isWithheldKey(name: string): boolean {
  const segs = normaliseKey(name);
  if (segs.length === 0) return false;
  return WITHHELD_KEY_SEGMENTS.some((bad) => {
    const badSegs = normaliseKey(bad);
    if (badSegs.length === 0) return false;
    // Match the bad name as a contiguous run of segments, so `pan` hits `pan_number` and
    // `employee_pan` but not `company` or `panel`.
    for (let i = 0; i + badSegs.length <= segs.length; i++) {
      let hit = true;
      for (let j = 0; j < badSegs.length; j++) {
        if (segs[i + j] !== badSegs[j]) { hit = false; break; }
      }
      if (hit) return true;
    }
    return false;
  });
}

/** Partition a set of key names into what may be composed and what is refused, with the reason. */
export function screenKeys(keys: readonly string[]): KeyScreen {
  const allowed: string[] = [];
  const refused: { key: string; because: string }[] = [];
  for (const k of keys) {
    if (isWithheldKey(k)) {
      refused.push({
        key: k,
        because:
          'This name matches something the personal intelligence view never carries. It was not read and is not on the page.',
      });
    } else {
      allowed.push(k);
    }
  }
  return { allowed, refused };
}

/**
 * Drop every withheld key from an object before it becomes a view model.
 *
 * Shallow ON PURPOSE. A deep strip would let a caller pass an arbitrary nested blob and assume it
 * had been made safe, which is the assumption this project has been bitten by before. Compose the
 * object you mean to show, then run this over it as a check.
 */
export function screenPayload<T extends Record<string, unknown>>(o: T): { safe: Partial<T>; refused: string[] } {
  const safe: Record<string, unknown> = {};
  const refused: string[] = [];
  for (const k of Object.keys(o || {})) {
    if (isWithheldKey(k)) refused.push(k);
    else safe[k] = (o as Record<string, unknown>)[k];
  }
  return { safe: safe as Partial<T>, refused };
}

/* ------------------------------------------------------------------------------------------------
 * SUPPRESSION
 * --------------------------------------------------------------------------------------------- */

/**
 * The floor below which a feedback summary is not shown.
 *
 * Same reasoning as MIN_GROUP in the wellness oversight screens, one step narrower because the
 * reader here is the subject: "one colleague described your work as needing improvement" is a
 * summary that names somebody to anybody who remembers who they spoke to last week. Three notes is
 * the point at which a theme is a theme rather than a person.
 */
export const MIN_FEEDBACK_NOTES = 3;

export const SUPPRESSED_FEEDBACK_SENTENCE =
  'There are fewer than ' + MIN_FEEDBACK_NOTES + ' notes on record, so nothing is summarised here yet. '
  + 'A summary built from one or two notes would point at the person who wrote them.';

/* ------------------------------------------------------------------------------------------------
 * LANGUAGE
 * --------------------------------------------------------------------------------------------- */

/**
 * The ways a sentence stops describing records and starts sentencing a person.
 *
 * Each pattern has a replacement direction, because "do not say that" without "say this instead"
 * gets worked around rather than followed.
 */
export const DETERMINISTIC_PATTERNS: readonly { pattern: RegExp; problem: string; instead: string }[] = Object.freeze([
  {
    pattern: /\byou are (?:a |an )?(?:poor|weak|strong|excellent|bad|good|low|high)\b/i,
    problem: 'States a fixed quality of the person.',
    instead: 'Describe the record: "the record shows ...", "what is on file is ...".',
  },
  {
    pattern: /\byou (?:will|won't|will not|cannot|can never)\b/i,
    problem: 'Predicts the person’s future.',
    instead: 'Stay in the past and present tense of what is recorded.',
  },
  {
    pattern: /\b(?:you lack|you fail|you failed to|you are failing|underperform(?:s|ing|er)?)\b/i,
    problem: 'Attributes a deficiency to the person rather than naming a gap in the record.',
    instead: 'Name what is missing from the record: "nothing is recorded yet for ...".',
  },
  {
    pattern: /\b(?:always|never) (?:deliver|complete|finish|miss|late)/i,
    problem: 'Absolute claim about behaviour.',
    instead: 'Give the count and the window: "in the last six months, N of M ...".',
  },
  {
    pattern: /\b(?:likely to|at risk of|predicted to|expected to) (?:leave|quit|resign|fail|underperform)\b/i,
    problem: 'A prediction about a person, which nothing in this system is entitled to make.',
    instead: 'Do not emit it. There is no supported version of this sentence.',
  },
  {
    pattern: /\b(?:personality|temperament|attitude problem|character flaw)\b/i,
    problem: 'Describes the person rather than their recorded work.',
    instead: 'Describe the work: what was filed, verified, completed.',
  },
  {
    pattern: /\byour score is\b|\bscored \d|\b\d{1,3}% (?:match|fit|aligned|collaborative|reliable)\b/i,
    problem: 'A number presented as a property of the person.',
    instead: 'Give the counts the number came from, or an ordinal confidence with its written meaning.',
  },
  {
    pattern: /\b(?:astrolog|horoscope|zodiac|nakshatra|rashi|birth chart|natal)\w*/i,
    problem: 'Birth-based vocabulary, which never appears on any surface in this product.',
    instead: 'Remove it. This view composes demonstrated work records only.',
  },
]);

export interface LanguageProblem {
  matched: string;
  problem: string;
  instead: string;
}

/**
 * Find every place a string stops being supportive and non-deterministic.
 *
 * Used by the test suite over every fixed string this patch can emit, and available to any future
 * patch that wants to add a sentence to this surface. It is a lint, not a sanitiser: it reports, it
 * does not rewrite, because a rewritten sentence about a person is a sentence nobody chose.
 */
export function languageProblems(text: string): LanguageProblem[] {
  const s = String(text || '');
  const out: LanguageProblem[] = [];
  for (const rule of DETERMINISTIC_PATTERNS) {
    const m = s.match(rule.pattern);
    if (m) out.push({ matched: m[0], problem: rule.problem, instead: rule.instead });
  }
  return out;
}

/**
 * The sentence at the top of the whole surface.
 *
 * It says the two things a person needs before reading anything else: nothing here decided anything
 * about them, and everything here can be argued with.
 */
export const SURFACE_PREAMBLE =
  'This page describes what this platform has on record about your work, and where each statement came from. '
  + 'Nothing on it is a decision, a rating against your colleagues, or a prediction. '
  + 'Where you think a record is wrong, the correction request on the Privacy tab goes to a person, not a system.';

/** Printed under any section that had to be built from an incomplete read. */
export const UNREADABLE_SENTENCE =
  'This could not be read just now, so it is missing rather than empty. Nothing here says there is no record.';

/** Printed where a section is genuinely empty. */
export const NOTHING_YET_SENTENCE =
  'Nothing is on record for this yet. That is ordinary early on, and it is not counted against you anywhere.';
