// src/lib/lms/schema.ts — THE LMS SPINE'S TABLES, CREATED ONCE, ADDITIVELY, AT FIRST USE.
//
// This follows the pattern already established by src/lib/enrolment.ts and
// src/lib/aquintutor-authoring.ts: CREATE TABLE IF NOT EXISTS at first call, never a destructive
// migration, never a DROP. Nothing here touches an existing table's data. The only ALTERs are
// ADD COLUMN IF NOT EXISTS, which is how this file stays safe to run against a database that
// already has an earlier version of these tables.
//
// WHAT THIS SPINE IS BUILT ON, AND WHY
//
// The course object is `training_courses`. Not a new one. There are already three content models in
// this repository (documented at length in src/lib/learning-object.ts) and adding a fourth course
// table would have produced a gradebook that grades courses nobody is enrolled in. Every table here
// hangs off training_courses(id) and, optionally, off a SECTION — a cohort of that course running
// in a term. section_id is nullable throughout: a self-paced open course has no section, and the
// whole spine works with section_id NULL.
//
// FOREIGN KEYS ARE DECLARED WHERE THE PARENT IS CERTAIN AND OMITTED WHERE IT IS NOT.
// training_courses exists on every database this runs against, so course_id references it and
// cascades. `users` likewise. Cross-model references (a lesson id, an assessment object id) are
// stored as plain UUIDs, because those live in more than one table depending on which content model
// authored them, and a broken FK would take the whole bootstrap down.

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
export { rows };

let booted: Promise<void> | null = null;

async function ctx() {
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  return { db, sql };
}

/** Create the LMS tables if they are not there. Idempotent, additive, safe to call on every request
 *  (it memoises). A failure resets the memo so the next request retries rather than serving a page
 *  that silently has no tables. */
export function ensureLmsSchema(): Promise<void> {
  if (booted) return booted;
  booted = (async () => {
    const { db, sql } = await ctx();
    const ex = async (statement: string) => {
      try {
        await db.execute(sql.raw(statement));
      } catch (e: any) {
        // The real Postgres reason is on e.cause; e.message is only the failed SQL.
        console.error('[lms/schema]', e?.cause?.message || e?.message, '\n  in:', statement.slice(0, 120));
        throw e;
      }
    };

    // ---------------------------------------------------------------- terms and sections (L3)
    await ex(`CREATE TABLE IF NOT EXISTS lms_terms (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      code TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      starts_on DATE,
      ends_on DATE,
      add_drop_until DATE,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);

    await ex(`CREATE TABLE IF NOT EXISTS lms_sections (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      course_id UUID NOT NULL REFERENCES training_courses(id) ON DELETE CASCADE,
      term_id UUID REFERENCES lms_terms(id) ON DELETE SET NULL,
      code TEXT NOT NULL,
      title TEXT,
      capacity INT,
      delivery TEXT NOT NULL DEFAULT 'online',
      meets TEXT,
      is_open BOOLEAN NOT NULL DEFAULT true,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await ex(`CREATE UNIQUE INDEX IF NOT EXISTS lms_sections_uq
      ON lms_sections (course_id, COALESCE(term_id, '00000000-0000-0000-0000-000000000000'::uuid), code)`);

    // A roster row is (section, user, role). The same person may be an instructor in one section and
    // a student in another, which is why role is part of the key rather than a property of the user.
    await ex(`CREATE TABLE IF NOT EXISTS lms_section_members (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      section_id UUID NOT NULL REFERENCES lms_sections(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      role TEXT NOT NULL DEFAULT 'student',
      status TEXT NOT NULL DEFAULT 'active',
      added_by UUID,
      added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (section_id, user_id, role))`);
    await ex(`CREATE INDEX IF NOT EXISTS lms_section_members_user_idx ON lms_section_members (user_id, role, status)`);

    // Course-level teaching staff, for courses with no sections at all.
    await ex(`CREATE TABLE IF NOT EXISTS lms_course_staff (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      course_id UUID NOT NULL REFERENCES training_courses(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      role TEXT NOT NULL DEFAULT 'instructor',
      added_by UUID,
      added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (course_id, user_id, role))`);

    // ---------------------------------------------------------------- grade structure (L2)
    await ex(`CREATE TABLE IF NOT EXISTS lms_grade_categories (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      course_id UUID NOT NULL REFERENCES training_courses(id) ON DELETE CASCADE,
      section_id UUID REFERENCES lms_sections(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      weight NUMERIC(6,2) NOT NULL DEFAULT 0,
      drop_lowest INT NOT NULL DEFAULT 0,
      position INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await ex(`CREATE INDEX IF NOT EXISTS lms_grade_categories_course_idx ON lms_grade_categories (course_id, position)`);

    await ex(`CREATE TABLE IF NOT EXISTS lms_grade_scales (
      course_id UUID PRIMARY KEY REFERENCES training_courses(id) ON DELETE CASCADE,
      bands JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_by UUID,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);

    // ---------------------------------------------------------------- rubrics (L2)
    await ex(`CREATE TABLE IF NOT EXISTS lms_rubrics (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      course_id UUID REFERENCES training_courses(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);

    await ex(`CREATE TABLE IF NOT EXISTS lms_rubric_criteria (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      rubric_id UUID NOT NULL REFERENCES lms_rubrics(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      description TEXT,
      points NUMERIC(8,2) NOT NULL DEFAULT 10,
      position INT NOT NULL DEFAULT 0)`);
    await ex(`CREATE INDEX IF NOT EXISTS lms_rubric_criteria_idx ON lms_rubric_criteria (rubric_id, position)`);

    // ---------------------------------------------------------------- assignments (L1)
    //
    // submission_kinds is deliberately {link,text} by default and there is NO upload column, in
    // this codebase's standing rule: documents of any kind are links (with open access), never
    // files this platform stores and pays to store.
    await ex(`CREATE TABLE IF NOT EXISTS lms_assignments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      course_id UUID NOT NULL REFERENCES training_courses(id) ON DELETE CASCADE,
      section_id UUID REFERENCES lms_sections(id) ON DELETE CASCADE,
      category_id UUID REFERENCES lms_grade_categories(id) ON DELETE SET NULL,
      rubric_id UUID REFERENCES lms_rubrics(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      instructions TEXT,
      kind TEXT NOT NULL DEFAULT 'essay',
      points NUMERIC(8,2) NOT NULL DEFAULT 100,
      due_at TIMESTAMPTZ,
      available_from TIMESTAMPTZ,
      closes_at TIMESTAMPTZ,
      allow_late BOOLEAN NOT NULL DEFAULT true,
      late_penalty_pct_per_day NUMERIC(6,2) NOT NULL DEFAULT 10,
      max_late_days INT NOT NULL DEFAULT 5,
      max_attempts INT NOT NULL DEFAULT 1,
      submission_kinds TEXT[] NOT NULL DEFAULT '{link,text}',
      min_words INT,
      peer_review_count INT NOT NULL DEFAULT 0,
      linked_assessment_id UUID,
      linked_lesson_id UUID,
      published BOOLEAN NOT NULL DEFAULT false,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await ex(`CREATE INDEX IF NOT EXISTS lms_assignments_course_idx ON lms_assignments (course_id, published, due_at)`);
    await ex(`CREATE INDEX IF NOT EXISTS lms_assignments_section_idx ON lms_assignments (section_id)`);

    // ---------------------------------------------------------------- submissions (L1)
    await ex(`CREATE TABLE IF NOT EXISTS lms_submissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      assignment_id UUID NOT NULL REFERENCES lms_assignments(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      attempt INT NOT NULL DEFAULT 1,
      body TEXT,
      link_url TEXT,
      links JSONB NOT NULL DEFAULT '[]'::jsonb,
      word_count INT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft',
      submitted_at TIMESTAMPTZ,
      is_late BOOLEAN NOT NULL DEFAULT false,
      days_late INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (assignment_id, user_id, attempt))`);
    await ex(`CREATE INDEX IF NOT EXISTS lms_submissions_user_idx ON lms_submissions (user_id, status)`);
    await ex(`CREATE INDEX IF NOT EXISTS lms_submissions_queue_idx ON lms_submissions (assignment_id, status, submitted_at)`);

    // ---------------------------------------------------------------- grades (L2)
    //
    // A grade is a row about a SUBMISSION, and `posted` is the difference between a grader's working
    // note and something a learner is allowed to read. Nothing on a learner surface may read a row
    // with posted = false.
    await ex(`CREATE TABLE IF NOT EXISTS lms_grades (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      submission_id UUID NOT NULL UNIQUE REFERENCES lms_submissions(id) ON DELETE CASCADE,
      assignment_id UUID NOT NULL REFERENCES lms_assignments(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      raw_points NUMERIC(8,2) NOT NULL DEFAULT 0,
      penalty_points NUMERIC(8,2) NOT NULL DEFAULT 0,
      points NUMERIC(8,2) NOT NULL DEFAULT 0,
      pct NUMERIC(6,2),
      feedback TEXT,
      rubric_scores JSONB NOT NULL DEFAULT '{}'::jsonb,
      excused BOOLEAN NOT NULL DEFAULT false,
      graded_by UUID,
      graded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      posted BOOLEAN NOT NULL DEFAULT false,
      posted_at TIMESTAMPTZ)`);
    await ex(`CREATE INDEX IF NOT EXISTS lms_grades_user_idx ON lms_grades (user_id, assignment_id)`);

    // Final course grade, computed from the roll-up and then FROZEN by a registrar. Recomputing it
    // on read would silently change a transcript after it was issued.
    await ex(`CREATE TABLE IF NOT EXISTS lms_final_grades (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      course_id UUID NOT NULL REFERENCES training_courses(id) ON DELETE CASCADE,
      section_id UUID REFERENCES lms_sections(id) ON DELETE SET NULL,
      user_id UUID NOT NULL,
      pct NUMERIC(6,2),
      letter TEXT,
      grade_points NUMERIC(4,2),
      credit_hours NUMERIC(5,2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'final',
      note TEXT,
      posted_by UUID,
      posted_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await ex(`CREATE UNIQUE INDEX IF NOT EXISTS lms_final_grades_uq
      ON lms_final_grades (course_id, user_id, COALESCE(section_id, '00000000-0000-0000-0000-000000000000'::uuid))`);

    // ---------------------------------------------------------------- course home (L4)
    await ex(`CREATE TABLE IF NOT EXISTS lms_announcements (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      course_id UUID NOT NULL REFERENCES training_courses(id) ON DELETE CASCADE,
      section_id UUID REFERENCES lms_sections(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      pinned BOOLEAN NOT NULL DEFAULT false,
      published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await ex(`CREATE INDEX IF NOT EXISTS lms_announcements_idx ON lms_announcements (course_id, published_at DESC)`);

    await ex(`CREATE TABLE IF NOT EXISTS lms_topics (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      course_id UUID NOT NULL REFERENCES training_courses(id) ON DELETE CASCADE,
      section_id UUID REFERENCES lms_sections(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT,
      kind TEXT NOT NULL DEFAULT 'discussion',
      locked BOOLEAN NOT NULL DEFAULT false,
      pinned BOOLEAN NOT NULL DEFAULT false,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_post_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await ex(`CREATE INDEX IF NOT EXISTS lms_topics_idx ON lms_topics (course_id, pinned DESC, last_post_at DESC)`);

    await ex(`CREATE TABLE IF NOT EXISTS lms_posts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      topic_id UUID NOT NULL REFERENCES lms_topics(id) ON DELETE CASCADE,
      parent_id UUID REFERENCES lms_posts(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      body TEXT NOT NULL,
      is_answer BOOLEAN NOT NULL DEFAULT false,
      hidden BOOLEAN NOT NULL DEFAULT false,
      hidden_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await ex(`CREATE INDEX IF NOT EXISTS lms_posts_topic_idx ON lms_posts (topic_id, created_at)`);

    await ex(`CREATE TABLE IF NOT EXISTS lms_syllabus (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      course_id UUID NOT NULL REFERENCES training_courses(id) ON DELETE CASCADE,
      section_id UUID REFERENCES lms_sections(id) ON DELETE CASCADE,
      body TEXT NOT NULL DEFAULT '',
      updated_by UUID,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await ex(`CREATE UNIQUE INDEX IF NOT EXISTS lms_syllabus_uq
      ON lms_syllabus (course_id, COALESCE(section_id, '00000000-0000-0000-0000-000000000000'::uuid))`);

    await ex(`CREATE TABLE IF NOT EXISTS lms_release_rules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      course_id UUID NOT NULL REFERENCES training_courses(id) ON DELETE CASCADE,
      section_id UUID REFERENCES lms_sections(id) ON DELETE CASCADE,
      target_kind TEXT NOT NULL,
      target_id UUID NOT NULL,
      release_at TIMESTAMPTZ,
      release_after_days INT,
      requires_lesson_id UUID,
      requires_assignment_id UUID,
      min_pct NUMERIC(6,2),
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await ex(`CREATE UNIQUE INDEX IF NOT EXISTS lms_release_rules_uq
      ON lms_release_rules (target_kind, target_id, COALESCE(section_id, '00000000-0000-0000-0000-000000000000'::uuid))`);

    // ---------------------------------------------------------------- interop (L6)
    //
    // xAPI statements are stored raw as well as shredded. The shredded columns are what the reports
    // read; the raw column is what lets a statement be re-read correctly after the shredding changes.
    await ex(`CREATE TABLE IF NOT EXISTS lms_xapi_statements (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_user_id UUID,
      actor_name TEXT,
      verb TEXT NOT NULL,
      object_id TEXT NOT NULL,
      object_name TEXT,
      course_id UUID,
      success BOOLEAN,
      completion BOOLEAN,
      score_scaled NUMERIC(6,4),
      duration_seconds INT,
      raw JSONB NOT NULL DEFAULT '{}'::jsonb,
      source TEXT NOT NULL DEFAULT 'internal',
      stored_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await ex(`CREATE INDEX IF NOT EXISTS lms_xapi_actor_idx ON lms_xapi_statements (actor_user_id, stored_at DESC)`);
    await ex(`CREATE INDEX IF NOT EXISTS lms_xapi_course_idx ON lms_xapi_statements (course_id, stored_at DESC)`);

    await ex(`CREATE TABLE IF NOT EXISTS lms_imports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      kind TEXT NOT NULL,
      course_id UUID,
      section_id UUID,
      filename TEXT,
      status TEXT NOT NULL DEFAULT 'ok',
      summary JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);

    // Additive repairs for databases carrying an earlier shape of these tables.
    await ex(`ALTER TABLE lms_assignments ADD COLUMN IF NOT EXISTS linked_assessment_id UUID`);
    await ex(`ALTER TABLE lms_assignments ADD COLUMN IF NOT EXISTS linked_lesson_id UUID`);
    await ex(`ALTER TABLE lms_assignments ADD COLUMN IF NOT EXISTS min_words INT`);
    await ex(`ALTER TABLE lms_grades ADD COLUMN IF NOT EXISTS excused BOOLEAN NOT NULL DEFAULT false`);
    await ex(`ALTER TABLE lms_submissions ADD COLUMN IF NOT EXISTS word_count INT NOT NULL DEFAULT 0`);
    await ex(`ALTER TABLE lms_final_grades ADD COLUMN IF NOT EXISTS credit_hours NUMERIC(5,2) NOT NULL DEFAULT 0`);
  })().catch((e) => {
    // Reset so the next request retries. A page that renders "no assignments" because the bootstrap
    // failed once is exactly the class of silent wrong answer this project has been bitten by.
    booted = null;
    throw e;
  });
  return booted;
}
