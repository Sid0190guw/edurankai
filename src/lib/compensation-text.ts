// `roles.salary` is free text typed into /admin/roles, and ~80 rows seeded before EduRankAI's
// structure was settled still read "INR 80 LPA - 1.5 Cr base + meaningful equity". EduRankAI is a
// proprietorship: there is no ESOP, no stock, no shares and no equity programme at any level, so
// none of those rows may reach a candidate. They render on /careers/<slug> and are syndicated
// off-site by /api/jobs-feed, where a wrong string cannot be recalled once a board has mirrored it.
//
// Correcting the rows at source is the real fix (and the SQL for it is handed to the operator);
// this is the guard that holds until every row is clean, and a no-op afterwards.

/** Separators that reliably delimit one independent claim in a pay string.
 *  Deliberately NOT here: the hyphen, because a salary range is written "INR 50 LPA - 95 LPA" and
 *  splitting on it cuts the range in half; and " and " / " with " / " plus ", which join words
 *  inside a single clause far more often than they join two clauses. An earlier version split on
 *  both and turned "INR 50 LPA - 95 LPA base + meaningful equity. Compensation is commensurate
 *  with experience, capabilities, and expected contribution" into the nonsense
 *  "INR 50 LPA - 95 LPA base and expected contribution". */
const CLAUSE = /\s*[+;&|·]\s*/;

/** An ownership- or profit-linked promise. "shared" is not matched ("budget shared openly" is a
 *  statement about honesty, not a stake) because \b fails between "share" and the "d". */
const PROMISE =
  /\b(?:esops?|rsus?|equity|stock\s*options?|stocks?|shares?|shareholding|shareholders?|vest(?:ed|ing)?|ownership\s+stake|employee\s+ownership|profit[-\s]?shar\w*|revenue[-\s]?shar\w*|cap\s+table)\b/i;

/**
 * Return the monetary part of a stored pay string, or null when there is nothing left to show.
 *
 * Conservative by construction: it removes whole clauses, never fragments of a sentence, and when
 * the promise is welded into prose it cannot cut cleanly it drops the field entirely rather than
 * publish a garbled or half-true package. Omitting compensation is recoverable; syndicating an
 * ownership promise the firm does not offer is not.
 */
export function stripOwnershipPromise(raw: unknown): string | null {
  const stored = String(raw ?? '').trim();
  if (!stored) return null;
  if (!PROMISE.test(stored)) return stored;

  const kept = stored
    .split(CLAUSE)
    .map((clause) => clause.trim())
    .filter((clause) => clause && !PROMISE.test(clause));

  const cleaned = kept.join(' + ').replace(/^[\s+;&|·,.]+|[\s+;&|·,]+$/g, '').trim();
  if (!cleaned || PROMISE.test(cleaned)) return null;
  return cleaned;
}

// ─────────────────────────────────────────────────────────────────────────────
// Trainee pay policy
//
// Every internship and apprenticeship at EduRankAI is UNPAID. There is exactly one exception: the
// flagship Large Language Model (LLM) Engineering Internship (src/data/catalog-flagship-ai.ts,
// slug 'llm-engineering-intern'), whose performance-based stipend is part of its published terms.
//
// Paid/unpaid is decided HERE, from the slug, and never from the stored pay text. `roles.salary`
// is free text typed into /admin/roles and imported from several catalog files, and a row for
// 'ai-research-intern' carried "up to INR 3 LPA + research stipend" — which /careers/<slug> read as
// "this trainee role genuinely pays" and published as a gold "This is a paid internship" callout,
// and which /api/jobs-feed syndicated off-site, where a wrong pay claim cannot be recalled once a
// board has mirrored it. Reading the intent out of free text means any edit, import or seed can
// advertise an unpaid internship as paid. An allowlist cannot: a wrong row now renders as unpaid,
// which is the truth for every internship but one.
//
// Adding a slug here is a compensation policy decision, not a code change.
const PAID_TRAINEE_SLUGS = new Set(['llm-engineering-intern']);

/** The word, not the prefix: "Internal Auditor" is not an internship, and \b will not match it
 *  because "internal" continues into more word characters. Hyphens in a slug ARE word boundaries,
 *  so 'visvambhara-aerospace-research-engineering-intern' matches. */
const TRAINEE_WORD = /\b(?:intern|interns|internship|internships|apprentice|apprenticeship)\b/i;

/** The stored pay line for an unpaid trainee role. Exported so the admin write path, the catalogs
 *  and db/unpaid-internships.sql all write the SAME string rather than three near-misses.
 *  Nothing tests for equality with these - the stored-value contract is the "Unpaid" PREFIX, which
 *  is what lets the Extreme-Scale and Campus Ambassador lines say something more specific and
 *  survive. These are only what to write when there is nothing better. */
export const UNPAID_INTERN_SALARY = 'Unpaid — internship certificate, mentorship, and real project experience';
export const UNPAID_APPRENTICE_SALARY = 'Unpaid — apprenticeship certificate, mentorship, and real project experience';

/** True when a stored pay string already declares itself unpaid. The PREFIX is the contract. */
export function declaresUnpaid(salary: unknown): boolean {
  return /^\s*unpaid\b/i.test(String(salary ?? ''));
}

/** A role whose engagement is training: internship or apprenticeship.
 *
 *  Four fields are checked, not one, because they are stored independently and disagree in
 *  production: 'visvambhara-aerospace-research-engineering-intern' is level 'Intern' with
 *  engagementType 'Full-Time', and reading either field alone gets it wrong. The title and slug are
 *  the last line: a row can be mislabelled in both structured fields, but a posting called
 *  "... Intern" is an internship whatever the columns say. Every check only ever moves a role
 *  towards unpaid, which is the safe direction - the cost of a false positive is a hidden pay band
 *  on a permanent role, the cost of a false negative is advertising a stipend nobody will be paid. */
export function isTraineeRole(
  role: { level?: unknown; engagementType?: unknown; title?: unknown; slug?: unknown } | null | undefined,
): boolean {
  const level = String(role?.level ?? '').trim().toLowerCase();
  const engagement = String(role?.engagementType ?? '').trim().toLowerCase();
  if (level === 'intern' || level === 'apprentice') return true;
  if (engagement === 'internship' || engagement === 'apprenticeship') return true;
  return TRAINEE_WORD.test(String(role?.title ?? '')) || TRAINEE_WORD.test(String(role?.slug ?? ''));
}

/** True only for the one trainee programme that actually pays a stipend. */
export function isPaidTrainee(slug: unknown): boolean {
  return PAID_TRAINEE_SLUGS.has(String(slug ?? '').trim().toLowerCase());
}

/**
 * The compensation string a public surface may publish for a role, or null when there is none to
 * publish. Null means "show the unpaid notice / omit the field" — never "compensation unknown".
 *
 * Unpaid trainee roles return null whatever their stored salary says. Everything else is the
 * ownership-sanitised pay string, so this is the single call a public surface needs.
 */
export function publicCompensation(
  role: { slug?: unknown; level?: unknown; engagementType?: unknown; salary?: unknown } | null | undefined,
): string | null {
  if (isTraineeRole(role) && !isPaidTrainee(role?.slug)) return null;
  return stripOwnershipPromise(role?.salary);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pay claims hiding in the PROSE, not in the salary column
//
// Suppressing the salary field was not enough. /careers/ai-research-intern published
// "About this role: AI Research Intern — up to INR 3 LPA + research stipend." in its body copy, in
// its JSON-LD description, and through /api/jobs-feed's description field, while the compensation
// card beside it was correctly hidden. .dev-scripts/seed-hiring-posts.cjs builds `about` by
// interpolating the salary INTO the sentence, so correcting the column left the claim standing.
// /careers/ui-ux-design-intern rendered a "Compensation & Benefits" bullet promising
// "Stipend of up to 1,000 CHF during the internship period." from its AICTE perks list.
//
// A candidate reads the prose. So does a board mirroring the feed, and a wrong pay claim cannot be
// recalled once mirrored.
//
// Whole segments are removed - a sentence, or a bullet - never fragments, on the same principle as
// stripOwnershipPromise above: a half-cut sentence is worse than a missing one. It applies ONLY to
// unpaid trainee roles, so the flagship programme's stipend prose is untouched, and it never
// removes a segment that says the role is UNPAID - "not a stipend" has to survive.

/** A monetary promise: a currency with a number, an Indian pay unit, or a rate per period. */
const MONEY_CLAIM = /(?:INR|Rs\.?|CHF|USD|EUR|GBP|[₹$€£])\s*\d|\d[\d,.]*\s*(?:INR|Rs\.?|CHF|USD|EUR|GBP)\b|\d[\d,.]*\s*(?:LPA|lakhs?|crores?|k\b)|\d[\d,.]*\s*(?:\/|per\s+)(?:mo\b|month|annum|year|week|hour)|\bstipend\b[^.]*\d/i;

/** Says the engagement pays nothing. Such a segment must never be dropped as a "pay claim". */
const DECLARES_NO_PAY = /\bunpaid\b|\bno\s+stipend\b|\bnot\s+a\s+stipend\b|\bwithout\s+(?:a\s+)?stipend\b|\bnil\s+stipend\b/i;

function isPayClaim(segment: string): boolean {
  if (!segment.trim()) return false;
  if (DECLARES_NO_PAY.test(segment)) return false;
  return MONEY_CLAIM.test(segment);
}

/**
 * The compensation an OFFER LETTER may state for a role.
 *
 * The same policy roleSchema already enforces on the job advert (src/lib/validators.ts:60), applied
 * to the binding document. It was missing there entirely: publicCompensation() and isTraineeRole()
 * had no caller anywhere in the offer path, so the allowlist that guards what a posting may CLAIM
 * did not guard what an offer may PROMISE - and the offer form pre-filled its compensation box from
 * applications.compensation, which is the candidate's own expected CTC ("e.g. 25 LPA INR", the
 * placeholder on apply/step-5). An unpaid internship could therefore be offered a stipend of
 * whatever the applicant had asked for, and the internship template renders exactly that sentence:
 * "This internship carries a stipend of ...".
 *
 * NORMALISES RATHER THAN REJECTS, for the reason given on roleSchema: refusing the save would stop
 * an operator correcting an unrelated field on an offer whose pay string was already wrong.
 *
 * The slug is the ONLY thing that may make a trainee paid, and an unknown slug is treated as unpaid,
 * because every check here may only ever move a role towards unpaid.
 */
export function offerCompensationFor(
  role: { level?: unknown; engagementType?: unknown; title?: unknown; slug?: unknown } | null | undefined,
  typed: unknown,
): string {
  const t = String(typed ?? '').trim();
  if (!isTraineeRole(role)) return t;
  if (isPaidTrainee(role?.slug)) return t;
  // Already says unpaid, possibly in more specific words than the generic line. Left alone.
  if (declaresUnpaid(t)) return t;
  const apprentice = String(role?.level ?? '').trim().toLowerCase() === 'apprentice'
    || String(role?.engagementType ?? '').trim().toLowerCase() === 'apprenticeship';
  return apprentice ? UNPAID_APPRENTICE_SALARY : UNPAID_INTERN_SALARY;
}

/**
 * Remove money-promising sentences from free prose stored against an unpaid trainee role.
 *
 * Sentence-level, because that is the smallest unit droppable without leaving half a claim behind.
 * Returns the text unchanged when nothing matches, and an empty string when every sentence was a
 * pay claim - a caller should treat empty as "render nothing here".
 */
export function stripTraineePayProse(text: unknown): string {
  const raw = String(text ?? '');
  if (!raw.trim() || !MONEY_CLAIM.test(raw)) return raw;
  const paragraphs = raw.split(/\n\s*\n/).map((para) => {
    const sentences = para.match(/[^.!?]+[.!?]+[\s]*|[^.!?]+$/g) || [para];
    return sentences.filter((sentence) => !isPayClaim(sentence)).join('').trim();
  });
  return paragraphs.filter(Boolean).join('\n\n').trim();
}

/** The list form: drops whole bullets that promise money, preserving the order of the survivors. */
export function stripTraineePayItems(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  return items.map((x) => String(x ?? '')).filter((x) => x.trim() && !isPayClaim(x));
}

/** A trainee role that pays nothing - the only case the two strippers above apply to. */
export function isUnpaidTrainee(
  role: { slug?: unknown; level?: unknown; engagementType?: unknown; title?: unknown } | null | undefined,
): boolean {
  return isTraineeRole(role) && !isPaidTrainee(role?.slug);
}
