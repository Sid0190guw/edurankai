// src/lib/learning-doors.ts — WHERE "OPEN THE COURSE" ACTUALLY GOES, AND WHAT IS NEXT.
//
// =================================================================================================
// WHAT THIS IS, AND WHAT IT REFUSES TO BE
// =================================================================================================
//
// It is a door, not a system. It computes NO percentage and records NO completion: the one
// definition of progress lives in src/lib/learning-progress.ts and this module asks it rather than
// counting anything of its own. Two modules counting lessons is exactly the defect that put 40% on
// one screen and 60% on another, and adding a third counter to fix it would be the joke telling
// itself.
//
// What it adds is the part a learner actually needs and no module owned: given an assigned course,
// WHICH LESSON IS NEXT and WHICH PLAYER CAN SHOW IT.
//
// =================================================================================================
// WHY THE PLAYER CHOICE IS NOT COSMETIC
// =================================================================================================
//
// There are two players over one catalogue and they render different things:
//
//   /portal/courses/[slug]                        renders training_lessons.content and video_url.
//   /aquintutor/courses/[slug]/learn/[lessonSlug] renders training_lesson_blocks, through listBlocks().
//
// A lesson authored in the AquinTutor block editor has its content in training_lesson_blocks and
// NOTHING in training_lessons.content. Open it in the portal player and the page renders blank — no
// error, no message, just an empty lesson — and that is the player the employee learning surface has
// always linked to. So a course can be assigned, be perfectly authored, and be a wall.
//
// This module sends a block-authored course to the runner that can show it, deep-linked to the first
// lesson that is not finished, and when it cannot do that it SAYS SO on the card rather than handing
// over a link that quietly shows nothing.
//
// EduRankAI is the technology platform. Nothing here claims a qualification; a course completion is
// a record of work done on this platform and accredited partners award credentials.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { completedLessonIds } from '@/lib/learning-progress';

// -------------------------------------------------------------------------------------------------
// CONSTANTS AND HELPERS — declared ABOVE every function that reads them. `const` is not hoisted, and
// a function reaching a later declaration throws on its own first line while the page reports
// success. That has taken pages down on this project.
// -------------------------------------------------------------------------------------------------

const MOD = 'learning-doors';

/** postgres-js resolves to a PLAIN ARRAY, never `{ rows }`. `r.rows[0]` is always a bug here. */
const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** The real Postgres reason is on `e.cause`; `e.message` is only the SQL that failed. */
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const logFail = (tag: string, e: any) => console.error('[' + MOD + '] ' + tag, reasonOf(e));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** A bound-parameter IN (...) fragment. Never string concatenation, even for ids from our own DB. */
const uuidList = (ids: readonly string[]) => sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);

/** How many courses one page will resolve a door for. A learning path is a list, not a report. */
const MAX_DOORS = 24;

/**
 * "That table is not here" is a different fact from "that read failed". 42P01 is undefined_table:
 * training_lesson_blocks is created by the authoring library on first use, so on a database where
 * nobody has opened the block editor it genuinely does not exist. That is "no blocks", not an
 * outage, and it must not put a warning on a healthy learner's screen.
 */
const isMissingTable = (e: any): boolean =>
  String(e?.cause?.code || '') === '42P01' || /relation .* does not exist/i.test(reasonOf(e));

export type DoorRead = 'ok' | 'unreadable';

export interface LessonStep {
  id: string;
  title: string;
  slug: string | null;
  /** 1-based position in the course, so a screen can say "lesson 3 of 8". */
  position: number;
  done: boolean;
}

export interface CourseDoor {
  courseId: string;
  /** 'unreadable' means we could not work out where to send them, and the screen must say so. */
  read: DoorRead;
  kind: 'aquintutor' | 'portal' | 'closed';
  href: string | null;
  label: string;
  /** An honest caveat, or null. Never decoration. */
  note: string | null;
  totalLessons: number;
  doneLessons: number;
  /** The first unfinished lesson, in order. Null when everything is finished or nothing is known. */
  nextStep: LessonStep | null;
}

function unreadableDoor(courseId: string): CourseDoor {
  return {
    courseId,
    read: 'unreadable',
    kind: 'closed',
    href: null,
    label: 'Open the course',
    note: 'We could not read this course just now, so there is nothing safe to link to. This is a '
      + 'fault on our side, not a course that has been taken away.',
    totalLessons: 0,
    doneLessons: 0,
    nextStep: null,
  };
}

/**
 * Order the lessons the way a learner meets them.
 *
 * sort_order is what the portal player orders by; order_in_module arrived later on the same table
 * and is what the AquinTutor editors write. Neither is guaranteed on a legacy row, so the chain ends
 * at created_at, which every row has. The rows are read with SELECT * for the same reason: this
 * table has been ALTERed additively by three separate features, and naming a column that has not
 * landed on some database turns a working page into an outage.
 */
function lessonOrder(a: any, b: any): number {
  const key = (r: any) => {
    const s = r?.sort_order;
    if (s !== null && s !== undefined && isFinite(Number(s))) return Number(s);
    const o = r?.order_in_module;
    if (o !== null && o !== undefined && isFinite(Number(o))) return Number(o);
    return Number.MAX_SAFE_INTEGER;
  };
  const d = key(a) - key(b);
  if (d !== 0) return d;
  const ta = new Date(a?.created_at || 0).getTime();
  const tb = new Date(b?.created_at || 0).getTime();
  if (ta !== tb) return ta - tb;
  return String(a?.id || '').localeCompare(String(b?.id || ''));
}

/**
 * Work out, for each course, which lesson comes next and which player can render it.
 *
 * One query for the catalogue rows, one for the lessons and one for the block-authored courses —
 * then the completed-lesson set per course from learning-progress.ts, which is the only thing in
 * this product allowed to say what "finished" means.
 */
export async function doorsFor(
  userId: string,
  courseIds: readonly string[],
): Promise<Record<string, CourseDoor>> {
  const ids = Array.from(new Set(courseIds.filter(isUuid))).slice(0, MAX_DOORS);
  const out: Record<string, CourseDoor> = {};
  if (!isUuid(userId) || ids.length === 0) return out;
  for (const id of ids) out[id] = unreadableDoor(id);

  let courseRows: any[] = [];
  try {
    courseRows = rowsOf(await db.execute(sql`
      SELECT id::text AS id, slug, is_published
        FROM training_courses
       WHERE id IN (${uuidList(ids)})
       LIMIT ${MAX_DOORS}`));
  } catch (e: any) {
    logFail('doorsFor/courses', e);
    return out; // every door stays 'unreadable', which is the truth about what we know.
  }

  let lessonRows: any[] = [];
  try {
    lessonRows = rowsOf(await db.execute(sql`
      SELECT * FROM training_lessons WHERE course_id IN (${uuidList(ids)}) LIMIT 2000`));
  } catch (e: any) {
    logFail('doorsFor/lessons', e);
    return out;
  }

  const blockCourses = new Set<string>();
  try {
    for (const r of rowsOf(await db.execute(sql`
      SELECT DISTINCT l.course_id::text AS course_id
        FROM training_lesson_blocks b
        JOIN training_lessons l ON l.id = b.lesson_id
       WHERE l.course_id IN (${uuidList(ids)})
       LIMIT ${MAX_DOORS}`))) blockCourses.add(String(r.course_id));
  } catch (e: any) {
    // Absent means nothing has ever been authored in the block editor here. The door falls back to
    // the portal player, which is where that content would then live.
    if (!isMissingTable(e)) logFail('doorsFor/blocks', e);
  }

  const byCourse = new Map<string, any[]>();
  for (const r of lessonRows) {
    const cid = String(r?.course_id || '');
    if (!cid) continue;
    const list = byCourse.get(cid) || [];
    list.push(r);
    byCourse.set(cid, list);
  }

  for (const c of courseRows) {
    const courseId = String(c.id);
    const slug = c.slug ? String(c.slug) : null;
    const published = c.is_published === true;

    // WHAT IS FINISHED IS NOT THIS MODULE'S OPINION. completedLessonIds() throws rather than
    // answering "nothing" when it cannot tell, and a door built on a false "nothing" would send
    // somebody back to the first lesson of a course they have nearly finished.
    let doneIds: Set<string>;
    try {
      doneIds = new Set(await completedLessonIds(userId, courseId));
    } catch (e: any) {
      logFail('doorsFor/completions/' + courseId, e);
      out[courseId] = unreadableDoor(courseId);
      continue;
    }

    const steps: LessonStep[] = (byCourse.get(courseId) || []).slice().sort(lessonOrder)
      .map((l: any, i: number) => ({
        id: String(l.id),
        title: l.title ? String(l.title) : 'Lesson ' + (i + 1),
        slug: l.slug ? String(l.slug) : null,
        position: i + 1,
        done: doneIds.has(String(l.id)),
      }));
    const doneLessons = steps.filter((s) => s.done).length;
    const nextStep = steps.find((s) => !s.done) || null;
    const base = { courseId, read: 'ok' as DoorRead, totalLessons: steps.length, doneLessons, nextStep };

    if (!slug || !published) {
      out[courseId] = {
        ...base,
        kind: 'closed',
        href: null,
        label: 'Open the course',
        note: 'This course is not published, so there is nothing to open. Ask whoever assigned it.',
      };
      continue;
    }
    if (steps.length === 0) {
      out[courseId] = {
        ...base,
        kind: 'portal',
        href: '/portal/courses/' + encodeURIComponent(slug),
        label: 'Open the course',
        note: 'No lessons have been added to this course yet, so there is nothing to work through.',
      };
      continue;
    }

    const blockAuthored = blockCourses.has(courseId);
    if (blockAuthored && nextStep && nextStep.slug) {
      out[courseId] = {
        ...base,
        kind: 'aquintutor',
        href: '/aquintutor/courses/' + encodeURIComponent(slug) + '/learn/' + encodeURIComponent(nextStep.slug),
        label: 'Open lesson ' + nextStep.position + ': ' + nextStep.title,
        note: null,
      };
      continue;
    }

    out[courseId] = {
      ...base,
      kind: 'portal',
      href: nextStep
        ? '/portal/courses/' + encodeURIComponent(slug) + '?lesson=' + encodeURIComponent(nextStep.id)
        : '/portal/courses/' + encodeURIComponent(slug),
      label: nextStep ? 'Open lesson ' + nextStep.position + ': ' + nextStep.title : 'Open the course',
      note: blockAuthored
        ? 'Part of this course is written in the course engine, and this player may show those '
          + 'lessons as empty. Tell whoever assigned it if a lesson looks blank.'
        : null,
    };
  }

  return out;
}

// -------------------------------------------------------------------------------------------------
// ASSESSMENTS — the OTHER thing a skill can rest on
// -------------------------------------------------------------------------------------------------

export interface AssessmentPass {
  attemptId: string;
  testTitle: string;
  testSlug: string | null;
  percentage: number | null;
  submittedAt: string | null;
}

export interface AssessmentsRead {
  items: AssessmentPass[];
  /** 'absent' — the assessment engine has never been used here. Not an outage. */
  read: 'ok' | 'absent' | 'unreadable';
}

/**
 * Assessments this learner has passed, from the engine a learner actually sits: tests /
 * test_attempts.
 *
 * The kernel's edu_attempts is a separate population on a separate id space (assessment items keyed
 * to kernel objects, not to training_courses), and joining the two here would invent a link this
 * repository does not have. That gap is reported, not papered over.
 */
export async function passedAssessmentsFor(userId: string): Promise<AssessmentsRead> {
  if (!isUuid(userId)) return { items: [], read: 'unreadable' };
  try {
    const items = rowsOf(await db.execute(sql`
      SELECT a.id::text AS id, a.percentage, a.submitted_at,
             t.title AS test_title, t.slug AS test_slug
        FROM test_attempts a
        LEFT JOIN tests t ON t.id = a.test_id
       WHERE a.candidate_id = ${userId}::uuid
         AND a.is_passed = true
         AND a.status IN ('submitted', 'auto_submitted')
       ORDER BY a.submitted_at DESC NULLS LAST
       LIMIT 50`)).map((r: any) => ({
        attemptId: String(r.id),
        testTitle: r.test_title ? String(r.test_title) : 'An assessment',
        testSlug: r.test_slug ? String(r.test_slug) : null,
        percentage: r.percentage === null || r.percentage === undefined ? null : Number(r.percentage),
        submittedAt: r.submitted_at ? new Date(r.submitted_at).toISOString() : null,
      }));
    return { items, read: 'ok' };
  } catch (e: any) {
    logFail('passedAssessmentsFor', e);
    return { items: [], read: isMissingTable(e) ? 'absent' : 'unreadable' };
  }
}

/**
 * Confirm one passed attempt belongs to this learner, and return the sentence to store beside a
 * skill level.
 *
 * A FORM CANNOT ASSERT ITS OWN EVIDENCE. "Evidenced by an assessment" is a stronger claim than a
 * self-recorded level; a hidden input is not a claim anybody checked. This re-reads the attempt,
 * keyed on the learner as well as the attempt, and returns null when it is not there.
 *
 * The sentence says what was done on this platform. It does not say qualified, certified or
 * accredited — accredited partners award credentials and a passed assessment here is not one.
 */
export async function verifyAssessmentEvidence(
  userId: string,
  attemptId: string,
): Promise<{ label: string; url: string | null } | null> {
  if (!isUuid(userId) || !isUuid(attemptId)) return null;
  try {
    const r = rowsOf(await db.execute(sql`
      SELECT a.percentage, a.submitted_at, t.title AS test_title
        FROM test_attempts a
        LEFT JOIN tests t ON t.id = a.test_id
       WHERE a.id = ${attemptId}::uuid AND a.candidate_id = ${userId}::uuid
         AND a.is_passed = true AND a.status IN ('submitted', 'auto_submitted')
       LIMIT 1`));
    if (!r.length) return null;
    const pct = r[0].percentage === null || r[0].percentage === undefined
      ? null
      : Math.round(Number(r[0].percentage));
    const day = r[0].submitted_at ? new Date(r[0].submitted_at).toISOString().slice(0, 10) : null;
    return {
      label: 'Passed the assessment ' + (r[0].test_title ? String(r[0].test_title) : 'on this platform')
        + (pct === null ? '' : ' at ' + pct + '%')
        + (day ? ' on ' + day : '')
        + ' on the EduRankAI platform',
      url: null,
    };
  } catch (e: any) {
    logFail('verifyAssessmentEvidence', e);
    return null;
  }
}
