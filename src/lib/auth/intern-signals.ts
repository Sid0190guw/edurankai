// src/lib/auth/intern-signals.ts — the ONE ordered answer to "is this person an intern?".
//
// WHY THIS FILE EXISTS. Two modules asked that question, and both asked it the same wrong way.
// src/lib/auth/workspace-access.ts GIVES an intern their own screen; src/lib/auth/intern-guard.ts
// BLOCKS an intern out of /admin and demotes the account. Each tested, in its own copy, whether
// employment_type or designation CONTAINED the letters i-n-t-e-r-n. "Internal Auditor" contains
// them. Those two are the same decision seen from opposite sides — the door that opens and the door
// that closes — and two copies of one rule disagree the moment either is touched. So there is one
// rule, here, and both import it.
//
// THE ORDER IS THE FIX, and it needs no new schema. Structured values from closed vocabularies are
// asked FIRST; the substring test survives only as the last arm, because for a record HR added by
// hand it is the only signal that exists at all.
//
//   1. hr_employees.classification = 'intern'            — the compliance register said so.
//   2. roles.level in ('Intern','Apprentice')            — the job role they were hired into.
//   3. a REVIEWED classification naming something else   — settles it as NOT an internship.
//   4. otherwise: the free text on employment_type / designation  (today's whole test).
//
// WHY ARM 3 DEMANDS THE REVIEW STAMP, and why this is the load-bearing line in the file.
// `classification` was added by `ALTER TABLE hr_employees ADD COLUMN ... DEFAULT 'permanent'`
// (src/lib/hr-classification.ts:15), so EVERY pre-existing row reads 'permanent' whether or not a
// human ever looked at it. Letting that default answer "not an intern" would un-intern every intern
// nobody has classified yet — which is to say it would hand the admin console back to exactly the
// people the 2026 promotion incident handed it to. `classification_reviewed_at` is stamped by the
// one writer that sets the value (/admin/hr/classification, index.astro:22), so its PRESENCE is the
// difference between a default and a statement. Arm 3 fires only on a statement.
//
// The vocabulary is read from CLASSIFICATIONS rather than restated, so there is one list of what a
// classification may be. A value outside it — that page performs no server-side validation, so a
// crafted POST can store any string — is NOT a settled answer and falls through to arm 4, which is
// today's behaviour and the safe direction.
//
// ARM 4 IS BORROWED, NOT WRITTEN AGAIN. src/lib/auth/admin-access.ts — the gate on the /admin door —
// already tightened the free-text test to `\bintern(?!al)` and its comment asks, by name, for these
// two callers to adopt it when they are fixed. This is that commit. There was a THIRD copy of the
// rule and now there is one expression: the door, the guard and the workspace gate all judge the
// free-text columns identically, so an "Internal Auditor" can no longer be waved through one and
// demoted by another.
import { CLASSIFICATIONS } from '@/lib/hr-classification';
import { isInternshipRecord } from '@/lib/auth/admin-access';

/**
 * Everything the rule may look at. Every field is optional and a caller supplies only what its
 * query could actually answer: a missing signal must degrade to the arm below it, never to a
 * confident "no". Both readers fetch the structured columns best-effort for that reason.
 */
export interface InternSignals {
  /** hr_employees.classification. */
  classification?: string | null;
  /** hr_employees.classification_reviewed_at. Only its PRESENCE is read — never its value. */
  classificationReviewedAt?: unknown;
  /** roles.level, reached through hr_employees.application_id -> applications.role_id. */
  seniority?: string | null;
  /** hr_employees.employment_type. Free text, written inconsistently ('Internship' vs 'full_time'). */
  employmentType?: string | null;
  /** hr_employees.designation. Free text. */
  designation?: string | null;
}

const norm = (v: unknown): string => String(v ?? '').trim().toLowerCase();

/** role_level values that ARE an internship. The enum is at src/lib/db/schema.ts:18-20. */
const INTERN_LEVELS: ReadonlySet<string> = new Set(['intern', 'apprentice']);

/**
 * Every classification that is not an internship, derived from the single vocabulary so a value
 * added there cannot be missed here. Declared before the function that reads it: `const` is not
 * hoisted, and a reader reaching a later declaration has taken pages down on this project.
 */
const SETTLED_NON_INTERN: ReadonlySet<string> = new Set(
  Object.keys(CLASSIFICATIONS).filter((k) => k !== 'intern').map((k) => k.toLowerCase()),
);

/**
 * Is this engagement an internship? First match wins, top to bottom.
 *
 * Issues no query and reads no session: it decides over a row already in hand, and the callers do
 * all the reading. (The module's imports do reach src/lib/db transitively — both of them are ordinary
 * application modules — so "pure" describes this function, not the import graph.)
 *
 * This is the only thing that decides. Anything that needs the answer calls it rather than repeating
 * the test, which is the entire point of the file.
 */
export function resolveIsIntern(signals: InternSignals | null | undefined): boolean {
  if (!signals) return false;

  const classification = norm(signals.classification);
  const seniority = norm(signals.seniority);

  // 1 and 2 — structured, and both only ever ADD an intern. A person the register calls an intern,
  // or who was hired into an Intern/Apprentice role, is one however their designation was typed.
  if (classification === 'intern') return true;
  if (INTERN_LEVELS.has(seniority)) return true;

  // 3 — the only arm that can REMOVE an intern, and the only one that needs evidence of a human.
  const reviewed = signals.classificationReviewedAt !== null
    && signals.classificationReviewedAt !== undefined
    && String(signals.classificationReviewedAt).trim() !== '';
  if (reviewed && SETTLED_NON_INTERN.has(classification)) return false;

  // 4 — the free text, and the only signal a hand-added record carries at all.
  return isInternshipRecord(signals.employmentType, signals.designation);
}
