// src/lib/horizon/intake/notice.ts — THE PURPOSE NOTICE, AND THE ONLY WORDS THIS PATCH MAY USE.
//
// =================================================================================================
// WHY THE NOTICE IS CODE AND NOT A DATABASE ROW
// =================================================================================================
//
// A consent record is worth exactly as much as the ability to say WHAT THE PERSON WAS SHOWN. Storing
// only a version string leaves that to memory; storing the text in a table lets it be edited after
// the fact by anybody with write access, with no trace.
//
// So the text lives here, in version control, where a change is a diff with an author and a date —
// and every consent row records the version AND the SHA-256 of the exact text. If the copy is ever
// edited without bumping the version, the stored hash stops matching what this file renders, and
// noticeIntegrity() says so. That is the difference between an auditable consent record and a
// reassuring one.
//
// A SUPERSEDED VERSION IS NEVER DELETED. Somebody consented under it; the record of what they were
// told has to outlive the copy change.
//
// =================================================================================================
// THE LANGUAGE RULE, ENFORCED RATHER THAN PROMISED
// =================================================================================================
//
// This information is described — everywhere a person can see it — as optional personal profile
// information used for personalised professional and long-term development insights. PROHIBITED_TERMS
// below lists the vocabulary that must never appear in applicant-facing, employee-facing or general
// HR-facing copy, and assertNeutralLanguage() is called by this patch's tests against every notice
// version and every user-facing label it ships. A rule nothing checks is a rule that lasts until the
// next hurried edit.
//
// NOTHING HERE TOUCHES THE DATABASE. Pure, synchronous and unit-testable.
import { createHash } from 'node:crypto';

// -------------------------------------------------------------------------------------------------
// PROHIBITED VOCABULARY
// -------------------------------------------------------------------------------------------------

/**
 * Words that must not appear in any string this patch shows to an applicant, an employee or a
 * general HR user.
 *
 * Matched case-insensitively on WORD BOUNDARIES, so "star" inside "start" is not a false positive
 * while "star sign" is caught. The list covers the English and the common transliterated forms,
 * because a rule that only catches one language is not a rule.
 */
export const PROHIBITED_TERMS: readonly string[] = [
  'astrology', 'astrological', 'astrologer', 'astrologically',
  'horoscope', 'horoscopic',
  'zodiac', 'star sign', 'sun sign', 'moon sign', 'rising sign', 'ascendant',
  'natal chart', 'birth chart', 'natal',
  'kundli', 'kundali', 'janam', 'janampatri', 'jyotish',
  'rashi', 'nakshatra', 'dasha', 'graha',
  'planetary position', 'planetary influence', 'celestial',
  'fortune', 'destiny', 'fate', 'prediction', 'predict',
  'psychic', 'clairvoyant', 'occult', 'esoteric', 'mystic', 'mystical',
];

/** One offending term and where it was found. */
export interface LanguageViolation {
  term: string;
  /** The surrounding text, trimmed, so a failing test names something a human can find. */
  context: string;
}

/**
 * PURE. Find every prohibited term in a string.
 *
 * Returns an empty array for neutral copy, so a caller can treat a truthy length as failure without
 * having to know the rule.
 */
export function findProhibitedTerms(text: string): LanguageViolation[] {
  const out: LanguageViolation[] = [];
  const haystack = String(text || '');
  for (const term of PROHIBITED_TERMS) {
    // Escaped because some terms contain a space; \b on both ends so substrings do not match.
    const re = new RegExp('\\b' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    const m = re.exec(haystack);
    if (m) {
      const from = Math.max(0, m.index - 30);
      const to = Math.min(haystack.length, m.index + m[0].length + 30);
      out.push({ term, context: haystack.slice(from, to).trim() });
    }
  }
  return out;
}

/**
 * Throw if a user-facing string uses prohibited vocabulary.
 *
 * Used by this patch's tests over every notice version and every exported label. Deliberately a
 * THROW and not a boolean: the only correct response to shipping this copy is to not ship it.
 */
export function assertNeutralLanguage(label: string, text: string): void {
  const bad = findProhibitedTerms(text);
  if (bad.length > 0) {
    throw new Error(
      'Prohibited vocabulary in ' + label + ': '
      + bad.map((b) => '"' + b.term + '" (near: ' + b.context + ')').join('; '),
    );
  }
}

// -------------------------------------------------------------------------------------------------
// THE NOTICE
// -------------------------------------------------------------------------------------------------

export interface PurposeNotice {
  /** Immutable once shipped. Date-stamped so the order is obvious without reading a table. */
  version: string;
  effectiveFrom: string;
  /** The short line above the tick box. */
  headline: string;
  /** What we would hold. One plain sentence per item. */
  dataCollected: readonly string[];
  /** What it would be used for. */
  purposes: readonly string[];
  /** What it will never be used for. As important as the purposes, and shown with them. */
  limits: readonly string[];
  /** Who can reach it. */
  access: readonly string[];
  /** How long, and how to end it. */
  retention: readonly string[];
  /** The exact sentence beside the tick box. This is the thing being agreed to. */
  affirmation: string;
  /** Where the person goes to withdraw. Shown in the notice, not buried in a policy page. */
  withdrawalUrl: string;
}

/**
 * v1. Written to be read by the person it is about, not by a lawyer.
 *
 * Three things it states plainly because they are the three that decide whether the consent is real:
 * providing nothing costs the applicant nothing; a person, never a computation, makes every decision;
 * and withdrawal deletes what is held rather than merely stopping future use.
 */
const NOTICE_V1: PurposeNotice = {
  version: 'pf-2026-08-23.v1',
  effectiveFrom: '2026-08-23',
  headline: 'Optional personal profile information',
  dataCollected: [
    'Your date of birth.',
    'Your time of birth, if you know it, and how precisely you know it.',
    'Your place of birth, and the time zone that place used at the time.',
    'Map coordinates for that place, only if you choose to type them in. We do not look your place up anywhere.',
  ],
  purposes: [
    'To build personalised professional and long-term development insights for you: suggested learning directions, the kinds of work that may suit you, and how your development could be supported over time.',
    'To let you see those insights about yourself in your own portal.',
  ],
  limits: [
    'This information is never the reason you are hired, not hired, promoted, moved or let go. Every one of those is a decision a person makes, on demonstrated work.',
    'Demonstrated, job-related evidence always carries more weight than anything inferred from this information.',
    'Nothing here is treated as scientific fact, and nothing here is a statement about your health.',
    'It is never shared outside this platform, and it is never sold.',
    'Leaving all of it blank has no effect on your application. There is no version of this form where declining costs you anything.',
  ],
  access: [
    'You, at any time, in your portal.',
    'The automated processing that produces your insights.',
    'A small number of authorised people, only for a recorded reason such as answering a request from you. Every one of those reads is written to an access log with who read it and why.',
  ],
  retention: [
    'It is stored encrypted, separately from your application.',
    'You can withdraw at any time. Withdrawal deletes what is stored, not just its future use, and the record that you withdrew is kept.',
    'Withdrawing does not affect your application, your account, or anything already decided.',
  ],
  affirmation:
    'I have read the above and I authorise EduRankAI to hold this optional personal profile information '
    + 'and use it to produce personalised professional and long-term development insights for me. '
    + 'I understand I can withdraw at any time and that withdrawing deletes what is held.',
  withdrawalUrl: '/portal/personal-profile-data',
};

/** Every version ever shipped, oldest first. A superseded version is kept, never removed. */
export const NOTICE_VERSIONS: readonly PurposeNotice[] = Object.freeze([NOTICE_V1]);

/** The version a NEW grant is recorded against. */
export const CURRENT_NOTICE: PurposeNotice = NOTICE_V1;
export const CURRENT_NOTICE_VERSION: string = NOTICE_V1.version;

/** PURE. Look up a version. Null for one this build does not know — never a silent fallback to current. */
export function noticeByVersion(version: string | null | undefined): PurposeNotice | null {
  if (!version) return null;
  return NOTICE_VERSIONS.find((n) => n.version === version) || null;
}

/**
 * PURE. The canonical text of a notice: every visible line, in a fixed order, newline separated.
 *
 * This is what gets hashed, so the ORDER AND CONTENT ARE THE CONTRACT. Adding a section means a new
 * version, not an edit to an old one.
 */
export function noticeCanonicalText(n: PurposeNotice): string {
  return [
    'version: ' + n.version,
    'effectiveFrom: ' + n.effectiveFrom,
    'headline: ' + n.headline,
    ...n.dataCollected.map((s) => 'data: ' + s),
    ...n.purposes.map((s) => 'purpose: ' + s),
    ...n.limits.map((s) => 'limit: ' + s),
    ...n.access.map((s) => 'access: ' + s),
    ...n.retention.map((s) => 'retention: ' + s),
    'affirmation: ' + n.affirmation,
    'withdrawalUrl: ' + n.withdrawalUrl,
  ].join('\n');
}

/** PURE. SHA-256 of the canonical text, lowercase hex. Stored on every consent row. */
export function noticeHash(n: PurposeNotice): string {
  return createHash('sha256').update(noticeCanonicalText(n), 'utf8').digest('hex');
}

/**
 * Does a stored (version, hash) pair still match what this build renders?
 *
 * `unknown-version` is not the same as `mismatch`: the first says an older deployment recorded a
 * notice this build has never heard of, the second says somebody edited shipped copy without
 * bumping the version. Both need a human; they need different humans.
 */
export function noticeIntegrity(version: string, hash: string):
  { ok: true } | { ok: false; problem: 'unknown-version' | 'mismatch'; expected?: string } {
  const n = noticeByVersion(version);
  if (!n) return { ok: false, problem: 'unknown-version' };
  const expected = noticeHash(n);
  return expected === hash ? { ok: true } : { ok: false, problem: 'mismatch', expected };
}

/**
 * Is a grant recorded against `version` still current?
 *
 * A stale grant is NOT revoked — the person agreed to something and that stands — but it must be
 * re-asked before the data is used under newer terms.
 */
export function isNoticeCurrent(version: string | null | undefined): boolean {
  return !!version && version === CURRENT_NOTICE_VERSION;
}

// -------------------------------------------------------------------------------------------------
// SHORT-FORM LABELS
// -------------------------------------------------------------------------------------------------

/**
 * The section heading, helper lines and control labels this patch's surfaces use.
 *
 * Centralised here for one reason: the language test walks this object. Copy written inline in an
 * .astro file is copy nothing checks.
 */
export const INTAKE_LABELS = {
  sectionTitle: 'Optional personal profile information',
  sectionLead:
    'Entirely optional. If you authorise it, we use this to build personalised professional and '
    + 'long-term development insights for you. It plays no part in whether you are hired, and leaving '
    + 'it blank costs you nothing.',
  dateOfBirth: 'Date of birth',
  timeOfBirth: 'Time of birth',
  timeOfBirthHelp: 'As recorded on your birth certificate, if you have it to hand.',
  timePrecision: 'How precisely do you know that time',
  birthCity: 'Place of birth: city or town',
  birthRegion: 'State, province or region',
  birthCountry: 'Country',
  timezone: 'Time zone of that place',
  timezoneHelp:
    'We use this to work out the exact moment, allowing for daylight saving as it was then. '
    + 'We do not guess it from the place name.',
  coordinates: 'Map coordinates for that place',
  coordinatesHelp:
    'Optional, and only if you already know them. We do not look your place of birth up anywhere.',
  latitude: 'Latitude',
  longitude: 'Longitude',
  coordinatesSource: 'Where these coordinates came from',
  consentHeading: 'Your authorisation',
  consentCheckbox: 'Yes, I authorise this. I can withdraw at any time.',
  declineNote: 'Not authorising this has no effect on your application.',
  withdrawTitle: 'Your personal profile information',
  withdrawLead:
    'This is the optional information you authorised us to hold for personalised professional and '
    + 'long-term development insights. You can withdraw at any time, and withdrawing deletes what is '
    + 'stored. Your application and your account are not affected.',
  withdrawButton: 'Withdraw and delete this information',
  regrantButton: 'Authorise again',
} as const;
