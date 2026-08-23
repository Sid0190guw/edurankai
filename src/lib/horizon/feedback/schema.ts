// src/lib/horizon/feedback/schema.ts — the DDL PATCH 05 owns. Additive to a table it does not own.
//
// =================================================================================================
// WHY THERE IS NO SECOND FEEDBACK TABLE HERE
// =================================================================================================
//
// `hr_feedback` already exists. src/lib/performance-schema.ts declares it and src/lib/performance.ts
// writes and reads it, and its header states the reasoning this file is obeying: "before creating a
// table, find the existing one and extend it. A second goals table or a second appraisal table
// would not be a feature, it would be a defect that takes a year to notice — two screens, two
// numbers, and no way to say which is the employee's rating."
//
// A structured feedback item and a note somebody left after a good week are THE SAME THING with
// different amounts filled in: an author, a subject, a body, a date. So this patch adds columns
// rather than a table. The cost of getting that wrong is exactly the defect quoted above, with the
// added edge that two feedback tables means two answers to "may this person read this", which is a
// disclosure bug rather than a reporting one.
//
// EVERY COLUMN BELOW IS NULLABLE OR DEFAULTED. That is the whole backward-compatibility contract:
//   - giveFeedback() in performance.ts inserts eight columns and none of them changes.
//   - feedbackFor() / feedbackIGave() do SELECT f.* and map named fields; extra columns are ignored.
//   - A legacy row has source_type NULL, which is precisely how readStructuredItems() tells an
//     unstructured note from a structured item. Legacy rows are NOT retro-fitted into the aggregate:
//     a note with no dimension ratings has nothing to contribute to a dimension score, and guessing
//     a source type for it would invent the one field the weighting reasons about.
//
// THIS FILE DOES NOT EDIT src/lib/performance-schema.ts. It runs its own ensure, after that one, so
// the two can be developed by different people without either overwriting the other.
//
// =================================================================================================
// SELF-BOOTSTRAPPING, AND WHERE THE ERROR HANDLING LIVES
// =================================================================================================
//
// There are no migrations on this project. Everything is CREATE TABLE IF NOT EXISTS / ADD COLUMN IF
// NOT EXISTS, sent as ONE ensureBatch() rather than one statement per round trip — a round trip to
// this database measures ~139ms from the deployed function, so twenty statements sent singly is ~2.8s
// of pure latency on every cold instance.
//
// ensureOnce() swallows for the caller and logs `e.cause.message` (the real Postgres reason; the
// e.message is only the failed SQL) under `[ensure-once] horizon_feedback_v1 failed:`, and deletes
// its cache entry so the next request retries. So there is no try/catch here: adding one would
// swallow the rejection ensureBatch needs to let out.
//
// NO FOREIGN KEY FROM hr_feedback_dimensions TO anything but hr_feedback. hr_employees is reached
// through the parent row, which already has that constraint.
import { ensureBatch } from '@/lib/ensure-once';
import { ensurePerformanceSchema } from '@/lib/performance-schema';

const HORIZON_FEEDBACK_DDL = [
  // -----------------------------------------------------------------------------------------------
  // STRUCTURED COLUMNS ON hr_feedback. Every one nullable or defaulted; see the header.
  // -----------------------------------------------------------------------------------------------

  // WHO IS SPEAKING, as a kind. NULL on every pre-existing row, and NULL is the marker that says
  // "this is an unstructured note from the older feedback surface" — never a missing value to be
  // filled in with a guess.
  `ALTER TABLE hr_feedback ADD COLUMN IF NOT EXISTS source_type VARCHAR(24);`,
  // Did the Organization Graph confirm the claimed relationship AT THE TIME OF WRITING? Frozen on
  // purpose: a reorganisation next year must not retroactively turn a verified manager's feedback
  // into an unverified stranger's, and must not do the reverse either.
  `ALTER TABLE hr_feedback ADD COLUMN IF NOT EXISTS source_verified BOOLEAN NOT NULL DEFAULT false;`,
  `ALTER TABLE hr_feedback ADD COLUMN IF NOT EXISTS source_verified_note TEXT;`,

  // THE CIRCUMSTANCE and THE APPLICABLE PERIOD. Without these an aggregate cannot say what it is an
  // aggregate OF, and every disagreement between two raters looks like a disagreement about the
  // person rather than about two different fortnights.
  `ALTER TABLE hr_feedback ADD COLUMN IF NOT EXISTS context VARCHAR(40);`,
  `ALTER TABLE hr_feedback ADD COLUMN IF NOT EXISTS context_note TEXT;`,
  `ALTER TABLE hr_feedback ADD COLUMN IF NOT EXISTS period_start DATE;`,
  `ALTER TABLE hr_feedback ADD COLUMN IF NOT EXISTS period_end DATE;`,

  // THE WRITTEN EVIDENCE, kept separate from `body`. `body` is the existing free note and stays
  // exactly what it was; `evidence` is the answer to "what did you see that makes you say that",
  // which is a different question and is the one the weighting reads.
  `ALTER TABLE hr_feedback ADD COLUMN IF NOT EXISTS evidence TEXT;`,
  // COMPUTED AT CAPTURE AND FROZEN. Recomputing it on read would mean an edit to a text heuristic
  // silently changes every historical weight, and nobody could reconcile today's number with the
  // one they read last week.
  `ALTER TABLE hr_feedback ADD COLUMN IF NOT EXISTS evidence_quality VARCHAR(16);`,

  // WHO MAY READ IT. 'standard' or 'hr_channel'. This does not replace visible_to_manager — it is
  // the reason FOR it, and capture.ts writes both so that the existing reader
  // (performance.ts feedbackFor with asManager:true, which filters on visible_to_manager) keeps
  // giving the right answer without knowing this column exists.
  `ALTER TABLE hr_feedback ADD COLUMN IF NOT EXISTS confidentiality VARCHAR(20) NOT NULL DEFAULT 'standard';`,

  // THE LIFE OF THE ITEM. Default 'submitted' so every pre-existing row keeps counting as what it
  // already is. Nothing is ever deleted: withdrawal is a status plus a reason.
  `ALTER TABLE hr_feedback ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'submitted';`,
  `ALTER TABLE hr_feedback ADD COLUMN IF NOT EXISTS withdrawn_at TIMESTAMPTZ;`,
  `ALTER TABLE hr_feedback ADD COLUMN IF NOT EXISTS withdrawn_reason TEXT;`,
  `ALTER TABLE hr_feedback ADD COLUMN IF NOT EXISTS withdrawn_by_user_id UUID;`,

  // An overall rating the author may optionally give alongside the dimensions. It is NOT the
  // aggregate and is never mixed into one: it is one more opinion, from one source.
  `ALTER TABLE hr_feedback ADD COLUMN IF NOT EXISTS overall_rating NUMERIC(4,2);`,

  // THE READ PATH. Every aggregate query is "structured, submitted, about this person, newest
  // first", so that is the index. Partial on source_type IS NOT NULL, because the unstructured
  // notes are the majority of the table on an existing database and never appear in that query.
  `CREATE INDEX IF NOT EXISTS hr_feedback_structured_idx
     ON hr_feedback (subject_employee_id, created_at DESC)
     WHERE source_type IS NOT NULL;`,
  // The bias desk reads "everything this author has written", across subjects.
  `CREATE INDEX IF NOT EXISTS hr_feedback_author_struct_idx
     ON hr_feedback (author_user_id, created_at DESC)
     WHERE source_type IS NOT NULL;`,

  // -----------------------------------------------------------------------------------------------
  // hr_feedback_dimensions — GENUINELY NEW, because a row cannot hold a list.
  //
  // One rating per dimension per item. THERE IS NO ROW FOR A DIMENSION THE AUTHOR DID NOT RATE, and
  // that absence is the record of non-observation. A "not observed" row carrying a NULL rating and
  // a zero would both be worse: the first is the same information with a column to forget to check,
  // the second is a fabricated 0 that would drag every average it touched.
  // -----------------------------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS hr_feedback_dimensions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    feedback_id UUID NOT NULL REFERENCES hr_feedback(id) ON DELETE CASCADE,
    dimension VARCHAR(32) NOT NULL,
    rating NUMERIC(4,2) NOT NULL,
    comment TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT hr_feedback_dimensions_key UNIQUE (feedback_id, dimension)
  );`,
  `CREATE INDEX IF NOT EXISTS hr_feedback_dim_dimension_idx ON hr_feedback_dimensions (dimension);`,

  // -----------------------------------------------------------------------------------------------
  // hr_feedback_examples — the cited incidents.
  //
  // A LINK, NEVER AN UPLOAD. This platform stores no documents: an example points at something that
  // already lives where the work lives. `reference_url` is text and is rendered as a link with
  // rel="noopener noreferrer"; nothing here fetches it.
  //
  // An example is what turns evidence_quality from 'general' into 'specific', which is the single
  // largest lever on weight in this whole patch — so it has its own row, its own date and its own
  // dimension, and can be read on its own by somebody checking whether a rating was earned.
  // -----------------------------------------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS hr_feedback_examples (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    feedback_id UUID NOT NULL REFERENCES hr_feedback(id) ON DELETE CASCADE,
    dimension VARCHAR(32),
    occurred_on DATE,
    description TEXT NOT NULL,
    reference_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`,
  `CREATE INDEX IF NOT EXISTS hr_feedback_examples_fb_idx ON hr_feedback_examples (feedback_id);`,
].join('\n');

/**
 * Create and extend everything PATCH 05 owns. Idempotent; safe to call from any reader.
 *
 * ORDERED. ensurePerformanceSchema() has to finish first, because ADD COLUMN on hr_feedback needs
 * that module to have created it. It is awaited out here rather than folded into the batch for the
 * same reason performance-schema.ts awaits ensureLifecycleSchema() out of its own: it is another
 * module's ensure behind another module's cache key, it is itself an ensureOnce guard so repeating
 * it costs nothing after the first call in a process, and it never rejects.
 */
export async function ensureHorizonFeedbackSchema(): Promise<void> {
  await ensurePerformanceSchema();
  return ensureBatch('horizon_feedback_v1', HORIZON_FEEDBACK_DDL);
}
