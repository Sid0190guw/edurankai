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
