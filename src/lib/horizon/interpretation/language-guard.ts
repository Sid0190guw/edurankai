// src/lib/horizon/interpretation/language-guard.ts — THE VOCABULARY FIREWALL.
//
// =================================================================================================
// WHY A GUARD AND NOT A STYLE RULE
// =================================================================================================
//
// PATCH 03 has four language obligations, and every one of them is the kind of rule that holds
// perfectly until the day somebody adds a template, pastes an upstream note into a tooltip, or wires
// a new surface in a hurry:
//
//   1. The underlying methodology is never named in standard UI language.
//   2. Nothing is stated as a deterministic prediction.
//   3. Nothing reads as a health or clinical statement.
//   4. Nothing reads as an employment decision.
//
// A rule written in a document cannot fail a build. This module can. Every string that leaves the
// interpretation layer for a human — generated explanations, implications, limitations, and any note
// that arrived from upstream — passes through guardText() first, and a string that fails is REPLACED
// rather than trimmed. A half-redacted sentence still leaks its shape; a substituted one does not.
//
// The engine records every substitution on the interpretation (`redactions`), so a guard that fires
// is visible on the surface and in the audit trail rather than being a silent rewrite of what a
// system said about a person.
//
// =================================================================================================
// NEGATION, AND WHY THREE OF THE FOUR GROUPS ALLOW IT
// =================================================================================================
//
// The honest disclaimers this layer is REQUIRED to print necessarily name the things it is
// disclaiming: "this is not a prediction", "this is not a health assessment", "must not be used to
// support a hiring decision". A naive denylist would reject exactly the sentences that make the
// output safe.
//
// So the prediction, health and decision groups are NEGATION-AWARE: a term is allowed when a negator
// appears earlier in the SAME SENTENCE. "It is not a prediction about tenure" passes; "a prediction
// about tenure" does not.
//
// THE METHODOLOGY GROUP IS NOT NEGATION-AWARE, DELIBERATELY. The obligation there is that the
// vocabulary does not appear in standard UI language AT ALL — a denial still puts the word on the
// screen, still invites the question, and still frames the output as the thing it is denying. There
// is no sentence in this layer that needs those words, so there is no exemption for them.

export type GuardGroupId = 'methodology' | 'prediction' | 'health' | 'decision';

export interface GuardGroup {
  id: GuardGroupId;
  label: string;
  /** What this group protects against, in one line, for the audit record. */
  reason: string;
  /** Whether a negator earlier in the same sentence exempts a match. */
  negationExempt: boolean;
  pattern: RegExp;
}

const w = (terms: string[]): string => '\\b(?:' + terms.join('|') + ')\\b';

// -------------------------------------------------------------------------------------------------
// 1. METHODOLOGY. The upstream tradition's vocabulary, in the forms it actually appears in.
//
// Deliberately wide. Over-redaction here costs a neutral sentence; under-redaction costs the single
// guarantee this layer exists to provide. Terms are matched only in narrative text produced by or
// passed through this layer — never against a person's name, a department, or any identity field,
// which is why words that are also names can safely be on the list.
// -------------------------------------------------------------------------------------------------
const METHODOLOGY_TERMS = [
  'astrolog\\w*', 'astrologer', 'horoscop\\w*', 'zodiac\\w*', 'natal', 'nativity', 'ephemeri\\w*',
  'sidereal', 'kundli', 'kundali', 'janam\\w*', 'jyotish\\w*', 'rashi', 'raashi', 'rasi',
  'nakshatra\\w*', 'dasha', 'dasa', 'mahadasha', 'antardasha', 'antar\\s*dasha', 'lagna', 'ascendant',
  'retrograde', 'combust', 'exalted', 'debilitat\\w*', 'panchang\\w*', 'muhurta', 'muhurat',
  'numerolog\\w*', 'tarot', 'palmistr\\w*', 'palm\\s*reading', 'vastu', 'feng\\s*shui',
  'gemstone\\w*', 'talisman\\w*', 'amulet\\w*', 'mantra\\w*', 'remedial\\s*measure\\w*',
  'sun\\s*sign\\w*', 'moon\\s*sign\\w*', 'star\\s*sign\\w*', 'rising\\s*sign\\w*',
  'aries', 'taurus', 'gemini', 'leo', 'virgo', 'libra', 'scorpio', 'sagittarius', 'capricorn',
  'aquarius', 'pisces',
  'sun', 'moon', 'mars', 'mercury', 'jupiter', 'venus', 'saturn', 'rahu', 'ketu', 'planetary',
  'surya', 'chandra', 'mangal', 'mangala', 'budha', 'brihaspati', 'shukra', 'shani', 'shanti',
  'celestial', 'cosmic', 'astral', 'occult', 'esoteric', 'divinat\\w*', 'clairvoyan\\w*', 'psychic',
];

const METHODOLOGY_PHRASES = [
  'birth\\s*chart', 'birth\\s*star', 'birth\\s*sign', 'birth\\s*time', 'birth\\s*data',
  'birth\\s*details', 'birth[-\\s]*based', 'time\\s*of\\s*birth', 'place\\s*of\\s*birth',
  'chart\\s*(?:lord|ruler|reading)', 'house\\s*(?:lord|ruler|cusp)',
  '(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth)\\s+house',
  '(?:1st|2nd|3rd|4th|5th|6th|7th|8th|9th|10th|11th|12th)\\s+house',
  'planetary\\s*(?:position|transit|period|influence)\\w*',
];

// -------------------------------------------------------------------------------------------------
// 2. PREDICTION. Determinism, in the phrasings that actually turn an indication into a forecast.
//
// Bare "will" is NOT here and must not be: ordinary neutral sentences use it, including the
// disclaimer that says nothing here states what a person will do. What is caught is certainty —
// guarantees, inevitability, destiny, and the verb "predict" itself.
// -------------------------------------------------------------------------------------------------
const PREDICTION_TERMS = [
  'predict\\w*', 'forecast\\w*', 'foretell\\w*', 'prophec\\w*', 'prophesy\\w*',
  'destin\\w*', 'fated', 'preordained', 'predetermined', 'inevitab\\w*', 'unavoidab\\w*',
  'guarantee\\w*', 'certainty', 'infallib\\w*',
];

const PREDICTION_PHRASES = [
  'will\\s+(?:definitely|certainly|always|never|inevitably|invariably)',
  'is\\s+(?:certain|sure|bound|destined)\\s+to', 'are\\s+(?:certain|sure|bound|destined)\\s+to',
  'guaranteed\\s+to', 'without\\s+(?:doubt|fail)', 'proven\\s+to\\s+be',
  'scientifically\\s+(?:proven|established|validated)',
];

// -------------------------------------------------------------------------------------------------
// 3. HEALTH. Nothing in this layer may read as a clinical statement about a person.
// -------------------------------------------------------------------------------------------------
const HEALTH_TERMS = [
  'diagnos\\w*', 'prognos\\w*', 'clinical\\w*', 'psychiatr\\w*', 'psycholog(?:y|ist|ical)',
  'therap(?:y|ist|ies)', 'medicat\\w*', 'prescri\\w*', 'symptom\\w*', 'syndrome', 'disorder\\w*',
  'illness', 'disease\\w*', 'patholog\\w*', 'morbid\\w*', 'chronic',
  'depress(?:ion|ive)', 'anxiety', 'bipolar', 'schizophren\\w*', 'adhd', 'autis\\w*', 'ptsd',
  'burnout', 'burn[-\\s]out', 'fatigue', 'insomnia', 'addict\\w*', 'substance\\s*abuse',
  'disab(?:led|ility|ilities)', 'impairment\\w*', 'pregnan\\w*', 'menstrua\\w*',
  'wellbeing', 'well[-\\s]being', 'mental\\s*(?:health|state|illness|condition)',
  'physical\\s*(?:health|condition)', 'health',
];

// -------------------------------------------------------------------------------------------------
// 4. DECISION. No output of this layer may read as, or support, an employment decision.
// -------------------------------------------------------------------------------------------------
const DECISION_TERMS = [
  'hire', 'hires', 'hiring', 'hired', 'rejection', 'rejected', 'reject',
  'terminat\\w*', 'dismiss\\w*', 'redundan\\w*', 'sack\\w*', 'fired',
  'promot(?:e|ed|ion|ions)', 'demot\\w*', 'disciplinar\\w*', 'warning\\s*letter',
  'unfit', 'unsuitable', 'unemployable', 'blacklist\\w*',
  'attrition', 'flight[-\\s]*risk', 'retention\\s*risk', 'shortlist\\w*',
];

const DECISION_PHRASES = [
  'should\\s+(?:be\\s+)?(?:hire|hired|appoint|appointed|select|selected|reject|rejected)',
  'do\\s+not\\s+(?:hire|appoint|select|promote)',
  'not\\s+(?:recommended|suitable)\\s+for\\s+(?:the\\s+)?(?:role|position|hire|employment)',
  'recommend\\w*\\s+(?:for\\s+)?(?:hire|hiring|promotion|termination|dismissal)',
];

export const GUARD_GROUPS: GuardGroup[] = [
  {
    id: 'methodology',
    label: 'Underlying methodology vocabulary',
    reason: 'The underlying computational method is never named in standard interface language.',
    negationExempt: false,
    pattern: new RegExp([...METHODOLOGY_PHRASES, w(METHODOLOGY_TERMS)].join('|'), 'gi'),
  },
  {
    id: 'prediction',
    label: 'Deterministic prediction',
    reason: 'Nothing here states what a person will certainly do; every output is an indication, not a forecast.',
    negationExempt: true,
    pattern: new RegExp([...PREDICTION_PHRASES, w(PREDICTION_TERMS)].join('|'), 'gi'),
  },
  {
    id: 'health',
    label: 'Health or clinical statement',
    reason: 'This layer makes no statement about anybody’s physical or mental health.',
    negationExempt: true,
    pattern: new RegExp(w(HEALTH_TERMS), 'gi'),
  },
  {
    id: 'decision',
    label: 'Employment decision',
    reason: 'No output of this layer may express or support a hiring, rejection, promotion, termination or disciplinary decision.',
    negationExempt: true,
    pattern: new RegExp([...DECISION_PHRASES, w(DECISION_TERMS)].join('|'), 'gi'),
  },
];

/** Words that make a mention a disclaimer rather than an assertion. */
const NEGATORS = /\b(?:not|never|no|none|nor|nothing|cannot|can't|without|neither|avoid|refus\w*|exclud\w*|prohibit\w*|forbid\w*|must\s+not|does\s+not|is\s+not|are\s+not)\b/gi;

/** Start index of the sentence containing `index`. Sentence enough for this purpose: the last
 *  terminator before the hit. Newlines count, so a bulleted list is a list of sentences rather than
 *  one long one — a negator on line 1 must not exempt an assertion on line 4. */
function sentenceStart(text: string, index: number): number {
  let start = 0;
  for (let i = Math.min(index, text.length) - 1; i >= 0; i--) {
    const c = text[i];
    if (c === '.' || c === '!' || c === '?' || c === '\n' || c === ';') {
      start = i + 1;
      break;
    }
  }
  return start;
}

function isNegated(text: string, index: number): boolean {
  const start = sentenceStart(text, index);
  const before = text.slice(start, index);
  NEGATORS.lastIndex = 0;
  return NEGATORS.test(before);
}

export interface GuardHit {
  group: GuardGroupId;
  /** The exact text that matched. Recorded so a false positive can be found and the pattern fixed. */
  term: string;
  index: number;
}

export interface GuardResult {
  /** True when nothing matched — the ONLY case in which the original text may be shown. */
  clean: boolean;
  /** What is safe to render: the original when clean, the fallback when not. Never a partial edit. */
  text: string;
  hits: GuardHit[];
  /** The distinct groups that fired, for the audit record. */
  groups: GuardGroupId[];
}

/**
 * Scan without substituting. Used by the self-check, by the tests, and by the engine when it needs
 * to know WHY a string was refused rather than merely that it was.
 */
export function scanText(text: unknown): GuardHit[] {
  const s = typeof text === 'string' ? text : '';
  if (!s) return [];
  const hits: GuardHit[] = [];
  for (const group of GUARD_GROUPS) {
    group.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = group.pattern.exec(s)) !== null) {
      if (m[0].length === 0) {
        group.pattern.lastIndex++;
        continue;
      }
      if (group.negationExempt && isNegated(s, m.index)) continue;
      hits.push({ group: group.id, term: m[0], index: m.index });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

/** The sentence shown in place of a string that failed the guard. Says what happened, because a
 *  silently blank explanation reads as "the system had nothing to say" rather than "the system
 *  refused to say it this way". */
export const DEFAULT_FALLBACK =
  'This wording was withheld because it did not meet the language rules for this layer. The indication itself is unchanged and the withheld wording is recorded for review.';

/**
 * The emit path. Returns the original text only when it is entirely clean.
 *
 * SUBSTITUTION, NOT REDACTION. Replacing the matched words would leave a sentence whose shape still
 * carries the meaning — "influenced by their ███ position" is not safer than the original. The whole
 * string is replaced, and the hit list travels with the result so the caller can record it.
 */
export function guardText(text: unknown, fallback: string = DEFAULT_FALLBACK): GuardResult {
  const s = typeof text === 'string' ? text : '';
  const hits = scanText(s);
  if (!hits.length) return { clean: true, text: s, hits: [], groups: [] };
  return {
    clean: false,
    text: fallback,
    hits,
    groups: [...new Set(hits.map((h) => h.group))],
  };
}

/** Guard a list, keeping only the entries that pass. Used for implications and limitations, where a
 *  single bad line should be dropped rather than replacing an otherwise good list with one sentence. */
export function guardList(items: readonly string[], fallbackNote?: string): { items: string[]; hits: GuardHit[] } {
  const out: string[] = [];
  const hits: GuardHit[] = [];
  for (const item of items || []) {
    const r = guardText(item, '');
    if (r.clean) out.push(item);
    else hits.push(...r.hits);
  }
  if (hits.length && fallbackNote) out.push(fallbackNote);
  return { items: out, hits };
}

/**
 * Upstream commentary, handled the strictest way: a note that fails the guard is DROPPED, not
 * substituted. An upstream note is optional context; there is no obligation to show anything in its
 * place, and a fallback sentence sitting where a note used to be invites somebody to go and look for
 * the original.
 */
export function guardUpstreamNote(note: unknown): { note: string | null; hits: GuardHit[] } {
  const r = guardText(note, '');
  if (r.clean) return { note: r.text || null, hits: [] };
  return { note: null, hits: r.hits };
}

/** Throws on any hit. For tests and for the module self-check — never on a request path, where a
 *  guard failure must degrade the sentence rather than the page. */
export function assertNeutral(text: string, where = 'text'): void {
  const hits = scanText(text);
  if (hits.length) {
    throw new Error(
      'Language guard refused ' + where + ': ' + hits.map((h) => h.group + '="' + h.term + '"').join(', '),
    );
  }
}

/**
 * Self-check, in the style this repository already uses (evidenceGraphSelfCheck). Returns a list of
 * problems; an empty list is a pass. Called by the admin surface so a guard regression is visible in
 * the product rather than only in CI.
 */
export function languageGuardSelfCheck(): string[] {
  const problems: string[] = [];

  // The guard must catch what it exists to catch.
  const mustCatch: Array<[string, GuardGroupId]> = [
    ['Their birth chart indicates strong focus.', 'methodology'],
    ['A planetary influence supports this reading.', 'methodology'],
    ['The tenth house governs career matters.', 'methodology'],
    ['This person is certain to succeed in the role.', 'prediction'],
    ['We predict consistent delivery next quarter.', 'prediction'],
    ['The candidate shows signs of burnout.', 'health'],
    ['This profile suggests an anxiety disorder.', 'health'],
    ['We recommend this candidate for hire.', 'decision'],
    ['Do not promote this employee.', 'decision'],
  ];
  for (const [sample, group] of mustCatch) {
    const hits = scanText(sample);
    if (!hits.some((h) => h.group === group)) {
      problems.push('Guard missed a ' + group + ' sample: "' + sample + '"');
    }
  }

  // And it must not catch the disclaimers this layer is required to print.
  const mustPass: string[] = [
    'This is not a prediction and states nothing about what this person will do.',
    'It is not a health assessment and contains no clinical statement of any kind.',
    'It must not be used to make or support a hiring, rejection, promotion, termination or disciplinary decision.',
    'Work involving investigation, root-cause analysis or option appraisal may be a good use of interest.',
    'Structured, scheduled learning with a clear finish point tends to work better than open-ended self study.',
  ];
  for (const sample of mustPass) {
    const hits = scanText(sample);
    if (hits.length) {
      problems.push(
        'Guard wrongly refused a required disclaimer: "' + sample + '" (' + hits.map((h) => h.term).join(', ') + ')',
      );
    }
  }
  return problems;
}
