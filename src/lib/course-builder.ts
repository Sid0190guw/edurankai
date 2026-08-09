// src/lib/course-builder.ts — WHAT A COURSE STILL NEEDS BEFORE ANYBODY CAN BE OFFERED IT.
//
// =================================================================================================
// WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
// =================================================================================================
//
// This is the READINESS REPORT behind /admin/courses/build/[id]. It reads a course the way a person
// about to publish it would have to, and answers, per step: is this finished, is it not finished, or
// could we not tell.
//
// IT IS NOT A WIZARD, AND IT HOLDS NO STATE OF ITS OWN. There is no builder table, no draft, no
// "step 4 of 11" cursor stored anywhere, and no partially-saved course sitting in a side table
// waiting to be committed. Every step reads and writes THE REAL COURSE — the same training_courses,
// training_modules, training_lessons, training_lesson_blocks, live_classes and pricing columns every
// other screen and both learner players read. That is the whole reason a person can leave in the
// middle and come back: there is nothing to lose, because nothing was ever held.
//
// A wizard with its own draft store would have needed a migration, a resume rule, an abandonment
// policy and a reconciliation job, and the first time it disagreed with the course row the draft
// would have been the thing people believed. This project already has four course editors writing
// one table; a fifth writing a shadow copy would be worse than all four.
//
// =================================================================================================
// THREE STATES, THREE SENTENCES. NEVER TWO.
// =================================================================================================
//
//   complete    the check RAN and PASSED.
//   incomplete  the check RAN and FOUND something missing, named in words.
//   unreadable  the check DID NOT RUN. We do not know. It is not a pass and it is not a failure.
//
// The third state is the one that matters and the one that is normally missing. `catch (_) {}`
// around a read turns "the database refused" into "there is nothing here", and a step that could
// not be checked then draws a green tick. Every read in this file goes through safeRows/safeRow from
// src/lib/page-safety.ts, which keeps "empty" and "failed" apart, and every step that could not run
// says so in its own sentence and CANNOT render as done.
//
// PUBLICATION IS REFUSED WHILE A CHECK CANNOT BE RUN. That is a deliberate position, stated on the
// screen: a check that did not run is not a pass, and a course put in front of learners on the
// strength of a question nobody could answer is exactly the class of failure this codebase keeps
// paying for. The refusal names the read that failed and the reason the database gave.
//
// =================================================================================================
// EVERY REFUSAL CARRIES THE STEP THAT FIXES IT
// =================================================================================================
//
// A Blocker is never a bare sentence. It carries `stepId`, so the screen renders it as a link to the
// step where the thing is actually changed. A validation message that does not say where to go is a
// dead end, and a person who cannot find the field gives up and publishes something else.
//
// =================================================================================================
// OWNERSHIP — WHAT THIS FILE CALLS RATHER THAN REIMPLEMENTS
// =================================================================================================
//
//   src/lib/course-pricing.ts    price, currency, fee model, audience, the minimum-charge floor
//   src/lib/course-sessions.ts   the timetable, its schema check, time zones, session state
//   src/lib/video-embed.ts       what a pasted video address actually is
//   src/lib/lesson-video.ts      how a stored lesson video reads back
//   src/lib/learning-admin.ts    the catalogue writer, the lesson list, the completion rule
//   src/lib/workflow.ts          THE approval engine — fee waivers are read from it, never modelled
//
// None of those files is edited here. Where this module needs something they do not expose, it says
// so in a comment rather than growing a second copy of their logic.
//
// =================================================================================================
// HOUSE RULES OBSERVED
// =================================================================================================
//   - postgres-js returns PLAIN ARRAYS. Every read goes through safeRows(); never r.rows[0].
//   - the real Postgres reason is on e.cause — dbReason() in page-safety does that unwrapping.
//   - every const is declared above the function that reads it.
//   - NO DDL AT ALL in this file. It creates no table and alters no column, so there is no
//     ensureOnce key here and nothing for a swallowed DDL failure to hide.
//   - nothing is swallowed in a write path: publishCourse() reports the reason it refused.
//   - NO BACKTICK inside a sql template literal, not even in a comment.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { safeRows, safeRow, dbReason } from '@/lib/page-safety';
import { lessonsForCourse, completionRuleFor, setCoursePublished, editCourse,
  COMPLETION_KIND_LABELS, type AdminLesson, type CompletionRule } from '@/lib/learning-admin';
import { getCoursePricing, ensureCoursePricingSchema, formatPrice, feeModelOf,
  FEE_MODEL_LABELS, MIN_CHARGE_INR_PAISE, isPurchasable, type CoursePricing } from '@/lib/course-pricing';
import { listCourseSessions, ensureCourseSessionSchema, isValidTimeZone, sessionState,
  formatInZone, type CourseSessionView } from '@/lib/course-sessions';
import { lessonVideo } from '@/lib/lesson-video';
import { logAudit } from '@/lib/audit';

// Declared before every function that reads them. `const` is not hoisted, and a handler that
// reaches a later declaration throws on its first line while the page above it still looks fine.
const MOD = '[course-builder]';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): boolean => typeof v === 'string' && UUID_RE.test(v.trim());
const logFail = (tag: string, e: any) => console.error(MOD + ' ' + tag + ' -', dbReason(e));
const clean = (v: unknown, max: number): string => String(v ?? '').trim().slice(0, max);

// -------------------------------------------------------------------------------------------------
// THE STEPS. Section 49's order, unchanged, because it is the order a person actually thinks in.
// -------------------------------------------------------------------------------------------------

export type StepState = 'complete' | 'incomplete' | 'unreadable';

export interface BuildStep {
  id: string;
  label: string;
  /** One sentence saying what this step decides. Rendered above the controls. */
  purpose: string;
}

export const BUILD_STEPS: BuildStep[] = [
  { id: 'basics', label: 'Basics', purpose: 'What this course is called, where it lives, and who teaches it.' },
  { id: 'pricing', label: 'Pricing and access', purpose: 'Who may take it, and what it costs them.' },
  { id: 'scholarship', label: 'Scholarship and waiver', purpose: 'Requests to be excused the fee, and where they are decided.' },
  { id: 'curriculum', label: 'Curriculum', purpose: 'The modules and lessons, in the order a learner meets them.' },
  { id: 'content', label: 'Content', purpose: 'Whether every lesson actually has something in it that plays or reads.' },
  { id: 'sessions', label: 'Live sessions', purpose: 'Scheduled classes, each with a real clock and a real way in.' },
  { id: 'assessment', label: 'Assessment', purpose: 'What a learner is asked to do to show they finished.' },
  { id: 'certification', label: 'Certification', purpose: 'What is issued at the end, and what it claims.' },
  { id: 'preview', label: 'Preview', purpose: 'The course as a learner sees it, before anybody does.' },
  { id: 'review', label: 'Review', purpose: 'Everything that is still standing between this and publication.' },
  { id: 'publish', label: 'Publish', purpose: 'Offer it, or withdraw it, and say what changed.' },
];

const STEP_LABEL = new Map<string, string>(BUILD_STEPS.map((s) => [s.id, s.label]));

export function isBuildStep(id: unknown): boolean {
  return BUILD_STEPS.some((s) => s.id === String(id || ''));
}

/**
 * A reason publication is refused, and WHERE IT IS FIXED.
 *
 * `stepId` is not decoration. The screen turns it into a link, and that link is the difference
 * between a validation message and a dead end.
 */
export interface Blocker {
  stepId: string;
  stepLabel: string;
  message: string;
  /** True when the reason is "we could not check", not "we checked and it is missing". */
  unknown: boolean;
}

export interface StepReport {
  id: string;
  label: string;
  purpose: string;
  state: StepState;
  /** The state, in a sentence. A different sentence for each of the three, never a shared one. */
  sentence: string;
  /** Supporting facts, already phrased for a person. */
  detail: string[];
  /** Reasons on THIS step that refuse publication. */
  blockers: Blocker[];
}

export interface BuildReport {
  /** Did the COURSE ROW read? When false nothing below can be trusted and the screen says only that. */
  ok: boolean;
  error: string;
  courseId: string;
  title: string;
  slug: string | null;
  shortDesc: string | null;
  category: string | null;
  level: string | null;
  accessType: string | null;
  instructorName: string | null;
  instructorTitle: string | null;
  isPublished: boolean;
  archivedAt: string | null;
  steps: StepReport[];
  /** Every blocker across every step, in step order. */
  blockers: Blocker[];
  /** True only when every step ran AND none of them refused. */
  publishable: boolean;
  /** Counts for the header line, so a person sees the shape before reading eleven cards. */
  completeCount: number;
  incompleteCount: number;
  unreadableCount: number;
  /** Facts the steps need to render their own controls, read once. */
  pricing: CoursePricing | null;
  pricingReadable: boolean;
  lessons: AdminLesson[];
  sessions: CourseSessionView[];
  rule: CompletionRule | null;
  faculty: { id: string; name: string }[];
  facultyReadable: boolean;
  waivers: { id: string; state: string; summary: string | null; requestedByUserId: string | null; createdAt: string | null }[];
  waiversReadable: boolean;
}

// -------------------------------------------------------------------------------------------------
// Small builders, so a step never has to remember the shape.
// -------------------------------------------------------------------------------------------------

function blocker(stepId: string, message: string, unknown = false): Blocker {
  return { stepId, stepLabel: STEP_LABEL.get(stepId) || stepId, message, unknown };
}

function step(
  id: string,
  state: StepState,
  sentence: string,
  detail: string[] = [],
  blockers: Blocker[] = [],
): StepReport {
  const def = BUILD_STEPS.find((s) => s.id === id) as BuildStep;
  return {
    id,
    label: def.label,
    purpose: def.purpose,
    state,
    sentence,
    detail: detail.filter(Boolean),
    blockers,
  };
}

// -------------------------------------------------------------------------------------------------
// THE REPORT
// -------------------------------------------------------------------------------------------------

/**
 * Read one course and say, per step, whether it is ready.
 *
 * Never throws. A course that cannot be read comes back ok:false with the database's own reason, and
 * the screen renders that one sentence instead of eleven cards of guesses.
 */
export async function courseBuildReport(courseId: string): Promise<BuildReport> {
  const empty: BuildReport = {
    ok: false, error: 'That is not a course.', courseId: String(courseId || ''),
    title: '', slug: null, shortDesc: null, category: null, level: null, accessType: null,
    instructorName: null, instructorTitle: null, isPublished: false, archivedAt: null,
    steps: [], blockers: [], publishable: false,
    completeCount: 0, incompleteCount: 0, unreadableCount: 0,
    pricing: null, pricingReadable: false, lessons: [], sessions: [], rule: null,
    faculty: [], facultyReadable: false, waivers: [], waiversReadable: false,
  };
  if (!isUuid(courseId)) return empty;

  // ---- the course row itself -------------------------------------------------------------------
  // SELECT the columns by name rather than *, so a column added by another workflow cannot change
  // what this file thinks it is holding. instructor_name / instructor_title are the free-text pair
  // /admin/courses/[id]/edit writes; they are read here and never assumed to exist beyond that.
  const courseRead = await safeRow<any>(MOD + ' course row', () => db.execute(sql`
    SELECT id, title, slug, short_desc, category, level, access_type, is_published, archived_at,
           instructor_name, instructor_title
      FROM training_courses
     WHERE id = ${courseId}::uuid
     LIMIT 1`));

  if (!courseRead.ok) {
    return { ...empty, ok: false, error: 'This course could not be read: ' + courseRead.error };
  }
  if (!courseRead.row) {
    return { ...empty, ok: false, error: 'There is no course with that id. It may have been deleted.' };
  }

  const c = courseRead.row;
  const title = clean(c.title, 200);
  const slug = c.slug ? clean(c.slug, 200) : null;
  const shortDesc = c.short_desc ? String(c.short_desc) : null;
  const accessType = c.access_type ? String(c.access_type) : null;
  const isPublished = c.is_published === true;
  const archivedAt = c.archived_at ? new Date(c.archived_at).toISOString() : null;
  const instructorName = c.instructor_name ? clean(c.instructor_name, 200) : null;
  const instructorTitle = c.instructor_title ? clean(c.instructor_title, 200) : null;

  // ---- everything else, read once, in parallel -------------------------------------------------
  // Each read carries its own ok flag. A failure in one does not contaminate another step, and no
  // step is allowed to read a neighbour's empty array as a finding.
  const [
    facultyRead, moduleRead, lessonRes, videoRead, pricingSchemaOk, sessionSchema, sessionRes,
    ruleProbe, waiverRes, enrolRead,
  ] = await Promise.all([
    // The faculty register. A separate table that predates this repo, so its absence is a
    // could-not-read, never "this course has no instructor".
    safeRows<any>(MOD + ' course faculty', () => db.execute(sql`
      SELECT i.id, i.name
        FROM training_course_instructors ci
        JOIN training_instructors i ON i.id = ci.instructor_id
       WHERE ci.course_id = ${courseId}::uuid
       LIMIT 50`)),
    safeRows<any>(MOD + ' modules', () => db.execute(sql`
      SELECT m.id, m.title,
             (SELECT COUNT(*)::int FROM training_lessons l WHERE l.module_id = m.id) AS lesson_count
        FROM training_modules m
       WHERE m.course_id = ${courseId}::uuid
       LIMIT 200`)),
    lessonsForCourse(courseId),
    // The raw video columns. lessonsForCourse() does not carry them — it is not this build's file —
    // so they are read here and resolved through the module that owns the question.
    safeRows<any>(MOD + ' lesson video links', () => db.execute(sql`
      SELECT id, title, video_url, video_embed_url, video_link_kind
        FROM training_lessons
       WHERE course_id = ${courseId}::uuid
       LIMIT 500`)),
    ensureCoursePricingSchema().catch((e: any) => { logFail('pricing schema', e); return false; }),
    ensureCourseSessionSchema(),
    listCourseSessions(courseId),
    // Readability of the completion-rule table. completionRuleFor() answers with the DEFAULT rule on
    // a failed read, which is the right thing for a player and the wrong thing for a readiness
    // report — it would report a rule nobody set as a rule somebody set.
    safeRows<any>(MOD + ' completion rule', () => db.execute(sql`
      SELECT course_id FROM learning_completion_rules WHERE course_id = ${courseId}::uuid LIMIT 1`)),
    // Fee-waiver requests, read from THE approval engine. No second waiver model is created here.
    //
    // THE KEY IS A CONTAINMENT MATCH, AND THAT IS SAID OUT LOUD ON THE STEP. workflow_instances
    // stores whatever record id the waiver module chose; that module owns the format and this file
    // must not invent one. Matching the course id anywhere inside the key finds requests written as
    // '<course>', '<course>:<user>' or 'course:<course>' alike — and the step tells the reader that
    // is what it did, so a zero here is never presented as proof that nobody asked.
    safeRows<any>(MOD + ' waiver requests', () => db.execute(sql`
      SELECT id, state, summary, requested_by_user_id, created_at
        FROM workflow_instances
       WHERE domain = 'fee_waiver' AND POSITION(${courseId} IN record_id) > 0
       ORDER BY created_at DESC
       LIMIT 50`)),
    safeRow<any>(MOD + ' enrolment count', () => db.execute(sql`
      SELECT COUNT(*)::int AS n FROM training_enrollments WHERE course_id = ${courseId}::uuid`)),
  ]);

  const lessons = lessonRes.lessons;
  const sessions = sessionRes.sessions;
  const faculty = facultyRead.rows.map((r: any) => ({ id: String(r.id), name: clean(r.name, 200) || 'Unnamed' }));
  const enrolments = Number(enrolRead.row?.n) || 0;

  // The pricing read is separate from the schema check, because "the columns are not there" and
  // "the row would not read" are two different sentences and only one of them is fixable here.
  let pricing: CoursePricing | null = null;
  let pricingError = '';
  try {
    pricing = await getCoursePricing(courseId);
  } catch (e: any) {
    logFail('getCoursePricing', e);
    pricingError = dbReason(e);
  }

  const rule: CompletionRule | null = ruleProbe.ok ? await completionRuleFor(courseId) : null;

  const steps: StepReport[] = [];

  // =============================================================================================
  // 1. BASICS
  // =============================================================================================
  {
    const missing: Blocker[] = [];
    const detail: string[] = [];

    if (!title) missing.push(blocker('basics', 'This course has no title. Every list, certificate and receipt prints it, so it cannot be left blank.'));
    if (!slug) {
      missing.push(blocker('basics', 'This course has no web address. /aquintutor/courses/<address> is what a learner opens, and without one the course cannot be reached even after it is published.'));
    } else if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      missing.push(blocker('basics', 'The web address "' + slug + '" contains characters that will not survive a URL. Use lower-case letters, numbers and hyphens.'));
    }

    // "No instructor assigned" — satisfied by EITHER signal, because this platform records teaching
    // in two places and neither is wrong. The faculty register is the richer one; instructor_name is
    // what three existing screens write and what the public course page prints.
    const hasFaculty = faculty.length > 0;
    const hasNamed = !!instructorName;
    if (!hasFaculty && !hasNamed) {
      if (!facultyRead.ok) {
        missing.push(blocker(
          'basics',
          'We could not check whether a member of faculty is attached to this course (' + facultyRead.error
            + '), and no instructor name is set on the course either. Publication is refused while the answer is unknown.',
          true,
        ));
      } else {
        missing.push(blocker('basics', 'No instructor is assigned. A learner is told who is teaching before they are asked to commit time to it, and a certificate names the person who taught.'));
      }
    } else {
      if (hasFaculty) detail.push('Faculty attached: ' + faculty.map((f) => f.name).join(', ') + '.');
      if (hasNamed) detail.push('Named on the course: ' + instructorName + (instructorTitle ? ', ' + instructorTitle : '') + '.');
      if (!facultyRead.ok) detail.push('The faculty register could not be read (' + facultyRead.error + '), so only the name written on the course is being counted.');
    }

    if (!shortDesc) detail.push('There is no short description. The catalogue card will show the title alone.');
    if (archivedAt) detail.push('This course is archived. Archived courses are not offered, and publishing one is refused until it is restored.');

    if (archivedAt) {
      missing.push(blocker('basics', 'This course is archived. Restore it before publishing — an archived course is deliberately kept out of every catalogue.'));
    }

    const unreadable = !facultyRead.ok && !hasNamed;
    steps.push(step(
      'basics',
      unreadable ? 'unreadable' : (missing.length ? 'incomplete' : 'complete'),
      unreadable
        ? 'This step could not be checked, so nothing here is being reported as done.'
        : missing.length
          ? 'This step has been checked and something is still missing.'
          : 'This step has been checked and it is finished.',
      detail,
      missing,
    ));
  }

  // =============================================================================================
  // 2. PRICING AND ACCESS
  // =============================================================================================
  {
    const missing: Blocker[] = [];
    const detail: string[] = [];
    let state: StepState;

    if (!pricing) {
      state = 'unreadable';
      detail.push(pricingError
        ? 'The database refused the read: ' + pricingError
        : 'The pricing read returned nothing for this course, which should not happen for a course that exists.');
      if (!pricingSchemaOk) {
        detail.push('The pricing columns are not confirmed present on training_courses. Until they are, a price entered here would be a price nobody is charged.');
      }
      missing.push(blocker('pricing', 'What this course costs could not be read, so we cannot say whether it is priced. Publication is refused while that is unknown.', true));
    } else {
      const purchasable = isPurchasable(pricing.accessType);
      detail.push('Audience: ' + audienceSentence(pricing.accessType) + '.');
      detail.push('Fee model: ' + (FEE_MODEL_LABELS[pricing.feeModel] || pricing.feeModel) + '.');

      if (!pricingSchemaOk) {
        // The columns could not be confirmed. A price shown from legacy columns may not be the price
        // charged, and that is a different fact from "no price".
        detail.push('The three pricing columns could not be confirmed present on this database, so what is shown may have been read from the older columns.');
      }

      if (pricing.feeModel === 'free_to_all') {
        detail.push('Nothing is charged, so there is nothing further to configure here.');
      } else if (!purchasable) {
        detail.push('This course is closed — nobody can buy it, whatever the price says. That is a deliberate setting, not an omission.');
      } else if (pricing.priceMinor <= 0) {
        missing.push(blocker('pricing', 'This course is set up to be paid for, and no price has been configured. A learner reaching the checkout would be asked for nothing and let in for nothing.'));
      } else if (pricing.priceMinor < MIN_CHARGE_INR_PAISE) {
        missing.push(blocker(
          'pricing',
          'The price is ' + formatPrice(pricing.priceMinor, pricing.currency) + ', which is below the smallest amount the payment path will take. '
            + 'Amounts are entered in whole units, so a course meant to cost five hundred and saved as five hundred paise charges five rupees. '
            + 'This exact mistake has already taken a real payment on this platform.',
        ));
      } else {
        detail.push('Price: ' + formatPrice(pricing.priceMinor, pricing.currency)
          + (pricing.employeesFree ? ', and employees are not charged.' : ', charged to everyone in the audience.'));
      }

      state = missing.length ? 'incomplete' : 'complete';
    }

    steps.push(step(
      'pricing',
      state!,
      state! === 'unreadable'
        ? 'This step could not be checked, so nothing here is being reported as done.'
        : state! === 'incomplete'
          ? 'This step has been checked and something is still missing.'
          : 'This step has been checked and it is finished.',
      detail,
      missing,
    ));
  }

  // =============================================================================================
  // 3. SCHOLARSHIP AND WAIVER
  //
  // NOTHING HERE BLOCKS PUBLICATION, and that is a decision rather than an omission: a paid course
  // that offers no scholarship is a legitimate course. What this step must never do is print a
  // confident zero over a read that failed, because "no-one has asked to be excused the fee" and
  // "we could not look" are very different things to tell a person about their own money.
  // =============================================================================================
  {
    const detail: string[] = [];
    let state: StepState;

    if (!waiverRes.ok) {
      state = 'unreadable';
      detail.push('The approval engine could not be read: ' + waiverRes.error);
      detail.push('That means we cannot say whether anybody has asked to be excused the fee on this course.');
    } else {
      const pending = waiverRes.rows.filter((r: any) => String(r.state) === 'pending').length;
      const decided = waiverRes.rows.length - pending;
      if (pricing && pricing.feeModel === 'free_to_all') {
        state = 'complete';
        detail.push('Nothing is charged for this course, so there is no fee to be excused.');
      } else {
        state = 'complete';
        detail.push(waiverRes.rows.length === 0
          ? 'No fee-waiver request has been made against this course.'
          : pending + ' request' + (pending === 1 ? '' : 's') + ' waiting on a decision, ' + decided + ' already decided.');
      }
      detail.push('Waivers are decided one request at a time on the waiver desk, through the one approval engine. This platform stores no per-course scholarship policy, so nothing on this step promises a learner anything.');
      detail.push('Requests are found by looking for this course’s id inside the approval record’s key, because the waiver module owns that key’s format. A count of none here means none carrying this id, not a guarantee that nobody asked.');
    }

    steps.push(step(
      'scholarship',
      state!,
      state! === 'unreadable'
        ? 'This step could not be checked, so nothing here is being reported as done.'
        : 'This step has been checked and it is finished.',
      detail,
      [],
    ));
  }

  // =============================================================================================
  // 4. CURRICULUM
  // =============================================================================================
  {
    const missing: Blocker[] = [];
    const detail: string[] = [];
    let state: StepState;

    if (!lessonRes.ok) {
      state = 'unreadable';
      detail.push('The lesson list could not be read: ' + (lessonRes.error || 'unknown reason'));
      missing.push(blocker('curriculum', 'The lessons on this course could not be read, so we cannot say whether it has any. Publication is refused while that is unknown.', true));
    } else {
      if (lessons.length === 0) {
        missing.push(blocker('curriculum', 'This course has no lessons. Publishing it would offer a learner an empty course.'));
      } else {
        detail.push(lessons.length + ' lesson' + (lessons.length === 1 ? '' : 's') + ' in this course.');
      }

      if (!moduleRead.ok) {
        detail.push('The module list could not be read (' + moduleRead.error + '), so the grouping below is not being reported on.');
      } else if (moduleRead.rows.length) {
        const emptyModules = moduleRead.rows.filter((m: any) => Number(m.lesson_count) === 0);
        detail.push(moduleRead.rows.length + ' module' + (moduleRead.rows.length === 1 ? '' : 's') + '.');
        if (emptyModules.length) {
          detail.push(emptyModules.length + ' module' + (emptyModules.length === 1 ? ' has' : 's have')
            + ' no lessons in them: ' + emptyModules.map((m: any) => clean(m.title, 60) || 'Untitled').join(', ')
            + '. An empty module draws as a heading with nothing under it.');
        }
      }

      // Ordering. training_modules carries BOTH order_in_course and sort_order and half the surfaces
      // read each; this report does not try to reconcile them, it reads the lesson order the two
      // players actually use and reports a collision rather than silently repairing one.
      const orders = lessons.map((l) => l.sortOrder);
      const dupes = orders.filter((v, i) => orders.indexOf(v) !== i);
      if (dupes.length) {
        detail.push('Some lessons share the same position number, so their order depends on the title as a tie-break and may differ between the two players. Nothing is broken; it is simply not deterministic.');
      }

      state = missing.length ? 'incomplete' : 'complete';
    }

    steps.push(step(
      'curriculum',
      state!,
      state! === 'unreadable'
        ? 'This step could not be checked, so nothing here is being reported as done.'
        : state! === 'incomplete'
          ? 'This step has been checked and something is still missing.'
          : 'This step has been checked and it is finished.',
      detail,
      missing,
    ));
  }

  // =============================================================================================
  // 5. CONTENT
  //
  // A LESSON CAN CARRY CONTENT IN THREE PLACES and the two players do not read the same ones:
  //   training_lessons.content        the portal player renders this
  //   training_lesson_blocks          the AquinTutor runner renders these
  //   training_lessons.video_url      a video, resolved through src/lib/video-embed.ts
  // A lesson with none of the three is empty in BOTH players and is refused. A lesson with content
  // in only one is not refused — it renders somewhere — but it is named, because an author who put
  // twenty blocks on a lesson usually did not mean for the portal to show a blank page.
  // =============================================================================================
  {
    const missing: Blocker[] = [];
    const detail: string[] = [];
    let state: StepState;

    if (!lessonRes.ok) {
      state = 'unreadable';
      detail.push('The lesson list could not be read, so the content on it could not be checked either.');
      missing.push(blocker('content', 'Lesson content could not be checked because the lesson list would not read. Publication is refused while that is unknown.', true));
    } else if (!videoRead.ok) {
      state = 'unreadable';
      detail.push('The video links could not be read: ' + videoRead.error);
      missing.push(blocker('content', 'The video address on each lesson could not be read, so we cannot say whether any of them will play. Publication is refused while that is unknown.', true));
    } else {
      const videoById = new Map<string, any>();
      for (const r of videoRead.rows) videoById.set(String(r.id), r);

      const emptyLessons: AdminLesson[] = [];
      const blocksOnly: AdminLesson[] = [];
      const refusedVideos: { title: string; reason: string; canLinkOut: boolean }[] = [];
      let playable = 0;

      for (const l of lessons) {
        const raw = videoById.get(l.id);
        const v = raw ? lessonVideo(raw) : null;
        if (v && v.ok) playable++;
        if (v && !v.ok) {
          refusedVideos.push({ title: l.title, reason: v.reason, canLinkOut: v.canLinkOut });
        }
        const hasAnything = l.hasInlineContent || l.blockCount > 0 || (v !== null && v.ok);
        if (!hasAnything && !(v && !v.ok)) emptyLessons.push(l);
        if (!l.hasInlineContent && l.blockCount > 0) blocksOnly.push(l);
      }

      if (emptyLessons.length) {
        missing.push(blocker(
          'content',
          emptyLessons.length + ' lesson' + (emptyLessons.length === 1 ? '' : 's')
            + ' have nothing in them at all - no text, no blocks and no video: '
            + emptyLessons.slice(0, 6).map((l) => l.title).join(', ')
            + (emptyLessons.length > 6 ? ', and ' + (emptyLessons.length - 6) + ' more' : '') + '.',
        ));
      }

      for (const r of refusedVideos) {
        missing.push(blocker(
          'content',
          'The video on "' + r.title + '" was never recognised: ' + r.reason
            + (r.canLinkOut ? ' It can still be saved as a link that opens elsewhere, which is a choice somebody has to make deliberately.' : ''),
        ));
      }

      if (playable) detail.push(playable + ' lesson' + (playable === 1 ? ' has' : 's have') + ' a video that will play.');
      if (blocksOnly.length) {
        detail.push(blocksOnly.length + ' lesson' + (blocksOnly.length === 1 ? '' : 's')
          + ' have blocks but no text in the older content column, so they render in one player and appear blank in the other: '
          + blocksOnly.slice(0, 6).map((l) => l.title).join(', ') + '.');
      }

      // WHAT THIS DEPLOYMENT'S STORAGE CANNOT DO, stated once, here, where a person is choosing
      // video. An unavailable capability is a state, not a silence.
      detail.push('This deployment has no media pipeline: there is no transcoding, no adaptive bitrate, no second resolution and no generated captions. A video plays at whatever it was uploaded or published as. No screen here offers a quality selector, because there is only ever one file behind it.');

      state = missing.length ? 'incomplete' : 'complete';
    }

    steps.push(step(
      'content',
      state!,
      state! === 'unreadable'
        ? 'This step could not be checked, so nothing here is being reported as done.'
        : state! === 'incomplete'
          ? 'This step has been checked and something is still missing.'
          : 'This step has been checked and it is finished.',
      detail,
      missing,
    ));
  }

  // =============================================================================================
  // 6. LIVE SESSIONS
  //
  // A course with no live sessions is a complete course — most are. What is refused is a SCHEDULED
  // session that cannot actually happen: no zone on the clock, or no way in.
  // =============================================================================================
  {
    const missing: Blocker[] = [];
    const detail: string[] = [];
    let state: StepState;

    if (!sessionSchema.ok || !sessionRes.ok) {
      state = 'unreadable';
      detail.push(sessionRes.error || sessionSchema.error || 'The timetable could not be read.');
      if (sessionSchema.missing.length) {
        detail.push('The timetable is missing: ' + sessionSchema.missing.join(', ') + '.');
      }
      missing.push(blocker('sessions', 'The timetable could not be read, so we cannot say whether this course has live classes or whether they are usable. Publication is refused while that is unknown.', true));
    } else {
      const upcoming = sessions.filter((s) => {
        const st = sessionState(s);
        return st !== 'ended' && st !== 'cancelled';
      });

      if (sessions.length === 0) {
        detail.push('This course has no live classes. That is a complete answer, not a missing one — most courses are taken at the learner’s own pace.');
      } else {
        detail.push(sessions.length + ' session' + (sessions.length === 1 ? '' : 's') + ' on the timetable, ' + upcoming.length + ' still to come.');
      }

      for (const s of upcoming) {
        if (!s.timeZone || !isValidTimeZone(s.timeZone)) {
          missing.push(blocker(
            'sessions',
            'The session "' + s.title + '" has no valid time zone. An instant with no zone is a class that starts at a different hour for everybody who reads it, and the first person in another country misses it.',
          ));
        }
        if (!s.startIso || !Number.isFinite(Date.parse(s.startIso))) {
          missing.push(blocker('sessions', 'The session "' + s.title + '" has no start time. Nobody can be told when to be there.'));
        }
        if (!s.hasLink) {
          missing.push(blocker('sessions', 'The session "' + s.title + '" has no way in — no meeting link and no in-house room. It is a class nobody can attend.'));
        }
      }

      // ATTENDANCE, STATED HONESTLY. live_class_enrollments records a RESERVED SEAT, written when a
      // learner presses join on /portal/liveclass. Nothing anywhere records that a person was
      // actually present. The dashboards report the seat and never call it attendance.
      if (sessions.length) {
        detail.push('This platform records a reserved seat, not a verified presence. Nothing here can tell you who was actually in the room.');
      }

      state = missing.length ? 'incomplete' : 'complete';
    }

    steps.push(step(
      'sessions',
      state!,
      state! === 'unreadable'
        ? 'This step could not be checked, so nothing here is being reported as done.'
        : state! === 'incomplete'
          ? 'This step has been checked and something is still missing.'
          : 'This step has been checked and it is finished.',
      detail,
      missing,
    ));
  }

  // =============================================================================================
  // 7. ASSESSMENT
  // =============================================================================================
  {
    const missing: Blocker[] = [];
    const detail: string[] = [];
    let state: StepState;

    if (!ruleProbe.ok || !rule) {
      state = 'unreadable';
      detail.push('What counts as finishing this course could not be read: ' + (ruleProbe.error || 'unknown reason'));
      missing.push(blocker('assessment', 'The completion rule could not be read, so we cannot say what a learner has to do to finish. Publication is refused while that is unknown.', true));
    } else {
      detail.push('Finishing this course means: ' + ruleSentence(rule) + '.');
      if (rule.isDefault) {
        detail.push('No rule has been set, so the default applies: every lesson viewed. That is the behaviour both players already have.');
      }

      if (rule.kind === 'assessment_passed' || rule.kind === 'mark_threshold') {
        if (!rule.testId) {
          missing.push(blocker(
            'assessment',
            'Completion is set to depend on an assessment and no assessment has been chosen. Every learner would finish every lesson and still never be recorded as complete.',
          ));
        } else {
          const testRead = await safeRow<any>(MOD + ' completion test', () => db.execute(sql`
            SELECT id, title FROM tests WHERE id::text = ${rule.testId} LIMIT 1`));
          if (!testRead.ok) {
            detail.push('The chosen assessment could not be looked up (' + testRead.error + '), so its title is not shown.');
            missing.push(blocker('assessment', 'The assessment this course depends on could not be looked up. Publication is refused while it is unknown whether it still exists.', true));
          } else if (!testRead.row) {
            missing.push(blocker('assessment', 'Completion depends on an assessment that no longer exists. Nobody could ever satisfy it.'));
          } else {
            detail.push('The assessment is "' + clean(testRead.row.title, 120) + '".');
          }
        }
        // THE DEAD END WORTH NAMING. The completion rules read the pre-existing test engine
        // (tests / test_attempts). A course authored against the kernel assessment module
        // (edu_assessment_items / edu_attempts) can never satisfy one of these rules.
        detail.push('These rules are satisfied by the assessment engine the proctoring stack attaches to. A quiz built inside a lesson block, or an assessment authored in the kernel, does not feed them.');
      }

      if (rule.kind === 'lessons_viewed' && lessonRes.ok && lessons.length === 0) {
        // Already blocked by the curriculum step; named here so the reason reads correctly on both.
        detail.push('With no lessons, a rule of "lessons viewed" can be satisfied by doing nothing.');
      }

      state = missing.length ? 'incomplete' : 'complete';
    }

    steps.push(step(
      'assessment',
      state!,
      state! === 'unreadable'
        ? 'This step could not be checked, so nothing here is being reported as done.'
        : state! === 'incomplete'
          ? 'This step has been checked and something is still missing.'
          : 'This step has been checked and it is finished.',
      detail,
      missing,
    ));
  }

  // =============================================================================================
  // 8. CERTIFICATION
  //
  // Nothing here refuses publication. What it does is state, before anybody earns one, exactly what
  // the artefact says — because EduRankAI is the technology platform and accredited partners award
  // credentials, and a course screen is where that gets quietly overclaimed.
  // =============================================================================================
  {
    const detail: string[] = [];
    const issuedRead = await safeRow<any>(MOD + ' certificates issued', () => db.execute(sql`
      SELECT COUNT(*)::int AS n FROM course_certificates WHERE course_id = ${courseId}::uuid`));

    let state: StepState;
    if (!issuedRead.ok) {
      state = 'unreadable';
      detail.push('The certificate ledger could not be read: ' + issuedRead.error);
      detail.push('That is a read of the record, not of this course’s settings — nothing about publication depends on it.');
    } else {
      state = 'complete';
      const n = Number(issuedRead.row?.n) || 0;
      detail.push(n === 0
        ? 'No certificate has been issued for this course yet.'
        : n + ' certificate' + (n === 1 ? ' has' : 's have') + ' been issued for this course.');
      detail.push('A certificate is issued automatically the moment the completion rule above is satisfied, into the hash-chained ledger, signed, with a verification address a third party can check.');
      detail.push('It records work done on this platform. It is not a degree and it is not awarded by a university — accredited partners award credentials, and nothing issued here claims to be one.');
    }

    steps.push(step(
      'certification',
      state!,
      state! === 'unreadable'
        ? 'This step could not be checked, so nothing here is being reported as done.'
        : 'This step has been checked and it is finished.',
      detail,
      [],
    ));
  }

  // =============================================================================================
  // 9. PREVIEW
  // =============================================================================================
  {
    const detail: string[] = [];
    const missing: Blocker[] = [];
    let state: StepState;

    if (!slug) {
      state = 'incomplete';
      missing.push(blocker('preview', 'There is no web address to preview. Set one on Basics.'));
    } else {
      state = 'complete';
      detail.push('The public catalogue page is /aquintutor/courses/' + slug + '. It only resolves once the course is published AND its audience includes the public.');
      detail.push('The signed-in player is /portal/courses/' + slug + '.');
      if (accessType && accessType !== 'public' && accessType !== 'both') {
        detail.push('This course’s audience is ' + audienceSentence(accessType) + ', so the public page will not resolve for a visitor however it is published.');
      }
      if (!isPublished) {
        detail.push('It is not published, so both addresses will refuse a learner right now. That is what publishing changes.');
      }
    }

    steps.push(step(
      'preview',
      state!,
      state! === 'incomplete'
        ? 'This step has been checked and something is still missing.'
        : 'This step has been checked and it is finished.',
      detail,
      missing,
    ));
  }

  // =============================================================================================
  // 10 + 11. REVIEW AND PUBLISH — derived from everything above, so they are appended after the
  // roll-up rather than computing anything of their own.
  // =============================================================================================
  const earlier = steps.slice();
  const allBlockers = earlier.reduce<Blocker[]>((acc, s) => acc.concat(s.blockers), []);
  const anyUnreadable = earlier.some((s) => s.state === 'unreadable');

  steps.push(step(
    'review',
    allBlockers.length ? (anyUnreadable ? 'unreadable' : 'incomplete') : 'complete',
    allBlockers.length
      ? anyUnreadable
        ? 'This step could not be checked, so nothing here is being reported as done.'
        : 'This step has been checked and something is still missing.'
      : 'This step has been checked and it is finished.',
    allBlockers.length
      ? ['There ' + (allBlockers.length === 1 ? 'is 1 reason' : 'are ' + allBlockers.length + ' reasons')
         + ' publication would be refused. Each one below links to the step that fixes it.']
      : ['Every check ran and every check passed. Publishing is the only thing left.'],
    [],
  ));

  steps.push(step(
    'publish',
    isPublished ? 'complete' : (allBlockers.length ? (anyUnreadable ? 'unreadable' : 'incomplete') : 'incomplete'),
    isPublished
      ? 'This step has been checked and it is finished.'
      : anyUnreadable && allBlockers.length
        ? 'This step could not be checked, so nothing here is being reported as done.'
        : 'This step has been checked and something is still missing.',
    isPublished
      ? ['This course is published. It can be withdrawn from here without anybody losing progress.',
         enrolments + ' ' + (enrolments === 1 ? 'person is' : 'people are') + ' enrolled.']
      : ['This course is not published, so nobody outside this console can open it.'],
    [],
  ));

  const completeCount = steps.filter((s) => s.state === 'complete').length;
  const incompleteCount = steps.filter((s) => s.state === 'incomplete').length;
  const unreadableCount = steps.filter((s) => s.state === 'unreadable').length;

  return {
    ok: true,
    error: '',
    courseId,
    title, slug, shortDesc,
    category: c.category ? String(c.category) : null,
    level: c.level ? String(c.level) : null,
    accessType,
    instructorName, instructorTitle,
    isPublished, archivedAt,
    steps,
    blockers: allBlockers,
    publishable: allBlockers.length === 0,
    completeCount, incompleteCount, unreadableCount,
    pricing,
    pricingReadable: pricing !== null,
    lessons,
    sessions,
    rule,
    faculty,
    facultyReadable: facultyRead.ok,
    waivers: waiverRes.rows.map((r: any) => ({
      id: String(r.id),
      state: String(r.state || ''),
      summary: r.summary ? String(r.summary) : null,
      requestedByUserId: r.requested_by_user_id ? String(r.requested_by_user_id) : null,
      createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    })),
    waiversReadable: waiverRes.ok,
  };
}

// -------------------------------------------------------------------------------------------------
// Sentences shared with the screen, so the report and the page never disagree.
// -------------------------------------------------------------------------------------------------

export function audienceSentence(accessType: string | null): string {
  switch (String(accessType || '')) {
    case 'public': return 'anybody signed in';
    case 'both': return 'anybody signed in, and the public catalogue';
    case 'employees': return 'employees only';
    case 'applicants': return 'applicants only';
    default: return 'not set, which the players read as employees only';
  }
}

export function ruleSentence(rule: CompletionRule): string {
  if (rule.kind === 'lessons_viewed') return rule.lessonsPct + '% of the lessons finished';
  if (rule.kind === 'mark_threshold') return 'a mark of ' + (rule.markPct === null ? 50 : rule.markPct) + '% or more on the chosen assessment';
  return 'a pass on the chosen assessment';
}

export function stateSentence(state: StepState): string {
  if (state === 'complete') return 'This step has been checked and it is finished.';
  if (state === 'incomplete') return 'This step has been checked and something is still missing.';
  return 'This step could not be checked, so nothing here is being reported as done.';
}

// -------------------------------------------------------------------------------------------------
// WRITES. Three, and every one of them re-checks at the moment of the write.
// -------------------------------------------------------------------------------------------------

export interface BuilderWriteResult {
  ok: boolean;
  info?: string;
  error?: string;
  /** Set when publication was refused. The reasons, each carrying the step that fixes it. */
  blockers?: Blocker[];
}

/**
 * PUBLISH, OR WITHDRAW.
 *
 * The report is recomputed HERE, at the moment of the write, and not trusted from the page that
 * drew the button. A rendered button is not an authorisation and a rendered tick is not a
 * validation: the course may have changed in another tab, or another author may have removed the
 * last lesson while this screen was open.
 *
 * WITHDRAWING IS NEVER REFUSED. Taking a course off the shelf is always allowed and always safe —
 * nobody loses progress — so it does not wait on a validation that might itself be unreadable.
 *
 * The capability is checked by the SURFACE, which is the same shape every other writer in this
 * codebase uses. This function does not re-ask, and its callers all sit behind
 * canAccessSection(user, 'lms', 'edit') plus can(user, 'lessons.publish').
 */
export async function publishCourse(
  actorUserId: string,
  courseId: string,
  publish: boolean,
): Promise<BuilderWriteResult> {
  if (!isUuid(courseId)) return { ok: false, error: 'That course does not exist.' };

  if (!publish) {
    const r = await setCoursePublished(actorUserId, courseId, false);
    return r.ok ? { ok: true, info: r.info || 'Course withdrawn.' } : { ok: false, error: r.error || 'Nothing was changed.' };
  }

  const report = await courseBuildReport(courseId);
  if (!report.ok) return { ok: false, error: report.error };

  if (!report.publishable) {
    const unknown = report.blockers.filter((b) => b.unknown).length;
    return {
      ok: false,
      blockers: report.blockers,
      error: 'Publication was refused. '
        + report.blockers.length + ' ' + (report.blockers.length === 1 ? 'reason is' : 'reasons are') + ' listed below'
        + (unknown ? ', ' + unknown + ' of which ' + (unknown === 1 ? 'is' : 'are') + ' a check that could not be run at all' : '')
        + '. Nothing was changed.',
    };
  }

  const r = await setCoursePublished(actorUserId, courseId, true);
  if (!r.ok) return { ok: false, error: r.error || 'Nothing was changed.' };
  return { ok: true, info: r.info || 'Course published.' };
}

/**
 * Basics. Title, category and level go through learning-admin's editCourse() because that is the
 * catalogue's writer and it writes the audit entry.
 *
 * ACCESS TYPE IS DELIBERATELY NOT CHANGED HERE. src/lib/course-pricing.ts writes the audience and
 * the price in ONE statement, on purpose, so the fee model can never be half-changed — a course that
 * is free to nobody and priced for everybody depending on which screen you opened. The Pricing step
 * owns that field; this one passes the current value straight back through.
 */
export async function saveBasics(
  actorUserId: string,
  input: { courseId: string; title: string; category: string; level: string; currentAccessType: string | null },
): Promise<BuilderWriteResult> {
  const r = await editCourse(actorUserId, {
    courseId: String(input?.courseId || ''),
    title: String(input?.title || ''),
    category: String(input?.category || ''),
    level: String(input?.level || ''),
    accessType: String(input?.currentAccessType || 'public'),
  });
  return r.ok ? { ok: true, info: r.info || 'Saved.' } : { ok: false, error: r.error || 'Nothing was saved.' };
}

/**
 * The short description and who is teaching.
 *
 * THESE THREE COLUMNS HAVE NO OWNING MODULE — /admin/courses/[id]/edit writes them with an inline
 * UPDATE and nothing else does. This is a plain column write with no derived state behind it, so a
 * second writer costs nothing; what it must not do is fail silently, which is why the row count is
 * checked and the real reason is returned rather than logged and dropped.
 */
export async function saveTeachingAndSummary(
  actorUserId: string,
  input: { courseId: string; shortDesc: string; instructorName: string; instructorTitle: string },
): Promise<BuilderWriteResult> {
  const courseId = String(input?.courseId || '');
  if (!isUuid(courseId)) return { ok: false, error: 'That course does not exist.' };
  const shortDesc = clean(input?.shortDesc, 500) || null;
  const name = clean(input?.instructorName, 200) || null;
  const title = clean(input?.instructorTitle, 200) || null;

  try {
    const r = await db.execute(sql`
      UPDATE training_courses
         SET short_desc = ${shortDesc},
             instructor_name = ${name},
             instructor_title = ${title},
             updated_at = NOW()
       WHERE id = ${courseId}::uuid
      RETURNING id`);
    const rows = Array.isArray(r) ? r : ((r as any)?.rows || []);
    if (!rows.length) return { ok: false, error: 'Nothing was changed — that course no longer exists.' };
    await logAudit({
      userId: actorUserId,
      action: 'learning.course.basics',
      entity: 'training_courses',
      entityId: courseId,
      diff: { shortDesc: !!shortDesc, instructorName: name },
    });
    return { ok: true, info: name ? 'Saved. ' + name + ' is now named as the instructor.' : 'Saved.' };
  } catch (e: any) {
    // NEVER swallowed. The author is told the real reason, which is on e.cause.
    logFail('saveTeachingAndSummary', e);
    return { ok: false, error: 'Nothing was saved: ' + dbReason(e) };
  }
}

/** Every course this console can build, newest first. Used for the picker when no id is given. */
export async function buildableCourses(limit = 200): Promise<{ ok: boolean; error: string; rows: { id: string; title: string; slug: string | null; isPublished: boolean; archivedAt: string | null }[] }> {
  const r = await safeRows<any>(MOD + ' buildable courses', () => db.execute(sql`
    SELECT id, title, slug, is_published, archived_at
      FROM training_courses
     ORDER BY updated_at DESC NULLS LAST, title ASC
     LIMIT ${Math.min(Math.max(limit, 1), 500)}`));
  return {
    ok: r.ok,
    error: r.error || '',
    rows: r.rows.map((x: any) => ({
      id: String(x.id),
      title: clean(x.title, 200) || 'Untitled course',
      slug: x.slug ? String(x.slug) : null,
      isPublished: x.is_published === true,
      archivedAt: x.archived_at ? new Date(x.archived_at).toISOString() : null,
    })),
  };
}

// Re-exported so the screen renders a session clock, a fee model and a completion rule through the
// modules that own those questions, rather than importing five files to draw one card.
export { formatInZone, sessionState, feeModelOf, COMPLETION_KIND_LABELS };
export type { CourseSessionView, CoursePricing, AdminLesson, CompletionRule };
