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
