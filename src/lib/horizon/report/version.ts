// src/lib/horizon/report/version.ts — WHAT PRODUCED A REPORT, STATED IN THE REPORT.
//
// A report that cannot name the engine that produced it cannot be re-read six months later with any
// confidence about what it meant. Two runs of "the same report" on the same person can differ
// because the data moved, because the rules moved, or because the interpreter moved, and only the
// first of those is legitimate grounds for a person to change their mind. Stamping the version makes
// the other two visible.
//
// BUMP ENGINE_VERSION WHENEVER THE SHAPE OR THE MEANING OF A DOCUMENT CHANGES — a new section, a
// renamed claim field, a different redaction rule. Bump the INTERPRETER version (it carries its own,
// in interpret.ts) when the reasoning changes but the document shape does not. They are separate
// numbers because they answer separate questions: "can this JSON still be read" and "would this
// conclusion be reached again".
//
// Persisted on every hzn_report_run row, so a stored document always says which code wrote it.

/** Stable identifier for this engine. Never changes; the version does. */
export const ENGINE_ID = 'horizon.report';

/**
 * Semantic version of the DOCUMENT CONTRACT — the section set, the claim shapes, the provenance
 * requirements. Consumers may branch on this. Adding an optional field is a minor bump; removing or
 * renaming anything is a major one and needs the handoff contract updating with it.
 */
export const ENGINE_VERSION = '1.0.0';

/** Convenience for log lines and audit entries: `horizon.report@1.0.0`. */
export const ENGINE_TAG = ENGINE_ID + '@' + ENGINE_VERSION;

/**
 * The sentence every generated document carries, in every audience's view, without exception.
 *
 * It is a constant rather than page copy because three surfaces render these documents (the console,
 * the detail page, the JSON API) and a notice that appears on two of them is worse than none: it
 * teaches a reader that its absence means something.
 */
export const ADVISORY_NOTICE =
  'This report is advisory. It summarises records, derived measures and opinions already held by the ' +
  'organisation. It does not decide anything: hiring, rejection, promotion, compensation, discipline ' +
  'and ending employment are decisions a named person makes and records.';
