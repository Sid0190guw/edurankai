// src/lib/content-crud.ts — THE WRITE LAYER THE CONTENT HIERARCHY NEVER HAD.
//
// =================================================================================================
// WHAT WAS WRONG
// =================================================================================================
//
// /admin/hr/training — the door the founder actually uses — supports exactly five actions:
// create_course, add_module, add_lesson, toggle_publish, delete_course. There is no UPDATE of
// anything. A course cannot be renamed, re-levelled, re-categorised, re-timed or reassigned; a
// module cannot be renamed or reordered; a lesson cannot be edited. A course was created with a
// misspelt title and published with the typo, because the only repair the screen offers is DELETE.
//
// That is the dangerous half. A system whose only repair for a spelling mistake is deletion will
// eventually delete something that has a person's learning inside it. There are FIVE hard
// `DELETE FROM training_courses` statements in this repository and not one of them counts an
// enrolment, a completion or a certificate first.
//
// =================================================================================================
// WHAT THIS MODULE IS
// =================================================================================================
//
// One write layer for course / module / lesson: update, reorder, move, duplicate, archive, restore,
// and a delete that REFUSES when anything depends on the row. It creates no new content tables and
// no second catalogue — it writes the same training_courses / training_modules / training_lessons
// every existing player and admin screen reads.
//
// THE DELETION RULE, which is the point of the module: a course, module or lesson with ANY
// enrolment, progress row, completion, quiz attempt, discussion or certificate attached is NOT
// deletable. The attempt returns a refusal that NAMES what depends on it and how many, and offers
// archive instead. Archiving unpublishes and hides, and leaves every record standing — because a
// person who completed something completed it, and tidying a catalogue does not change that.
//
// FAIL CLOSED. If the dependency count cannot be READ, the delete is refused with the reason. A
// count that could not run is not a count that found nothing.
//
// =================================================================================================
// WHAT IT DELIBERATELY DOES NOT DO
// =================================================================================================
//
// - IT DOES NOT DELETE CERTIFICATES, EVER. course_certificates is a hash chain (src/lib/certificates.ts):
//   removing a block invalidates every certificate issued after it, including certificates belonging
//   to people who did nothing wrong. A certificate is a reason to refuse a delete, never a casualty.
// - IT DOES NOT ADD A "UNIT" LEVEL. There is none. The hierarchy is course -> module -> lesson ->
//   block, plus the lesson-version side table. See NO_UNIT_LEVEL below.
// - IT DOES NOT BRIDGE LEARNING OBJECTS. Kernel learning objects (src/lib/kernel-content.ts) are not
//   joined to training_modules/training_lessons anywhere, and inventing that join here would create a
//   second, competing definition of a lesson. See LEARNING_OBJECTS_NOT_BRIDGED below.
// - IT DOES NOT TOUCH BLOCK CONTENT. src/lib/aquintutor-authoring.ts owns blocks and lesson versions
//   and remains the only writer of them; this module copies them wholesale on a duplicate and
//   otherwise leaves them alone.
//
// =================================================================================================
// THE TWO-SPELLING PROBLEM, AND WHY EVERY WRITE HERE WRITES BOTH
// =================================================================================================
//
// Half this codebase orders modules by `sort_order` and half by `order_in_course`; half orders
// lessons by `sort_order` and half by `order_in_module`; a lesson's length is `duration_mins` on one
// screen and `estimated_minutes` on another; its preview flag is `is_preview` on one and
// `preview_allowed` on another; a module's text is `summary` on one and `description` on another.
// Every pair has different writers and different readers. A reorder that writes one column of a pair
// leaves the curriculum in two orders at once — the learner sees one sequence and the author sees
// another. So every write below writes BOTH names of every pair, in one statement where the columns
// share a table, and a mirror whose failure is REPORTED rather than swallowed where they do not.
//
// Lesson `sort_order` is COURSE-wide (the HR page computes MAX+1 across the course) while
// `order_in_module` is MODULE-wide. They are not the same number and cannot be kept in step by
// copying one into the other. Reordering therefore renumbers the WHOLE COURSE: modules in their new
// order, lessons inside each module in theirs, and a course-wide running sequence written to
// sort_order. That is the only assignment under which both halves of the product agree.
//
// =================================================================================================
// CONCURRENCY
// =================================================================================================
//
// Every update carries the updated_at the editor loaded, and refuses if the row moved underneath
// them, naming who changed it and when. Silently overwriting a colleague's work is the failure
// people never report and never forgive. The comparison is made INSIDE the UPDATE's WHERE clause, so
// there is no window between the check and the write.
//
// =================================================================================================
// AUTHORIZATION
// =================================================================================================
//
// Capability keys only, and only keys that already exist in BOTH src/lib/auth/permissions.ts (the
// Permission union AND PERMS_BY_ROLE) and src/lib/auth/registry.ts BUILTIN_PERMISSIONS. A key
// outside the union is a permanent 403 for everybody including the founder, so nothing here invents
// one. Editing content that is already PUBLISHED needs the publish capability as well as the author
// one: renaming a live course is a change to something learners have already seen. Deleting needs
// `learning.rules.manage`, which registry.ts marks sensitive.
//
// EduRankAI is the technology platform; accredited partners award credentials. Nothing in this module
// claims otherwise, and no message here calls a course a qualification.
import type { User } from '@/lib/db/schema';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { can } from '@/lib/auth/permissions';
import { logAudit } from '@/lib/audit';
import { ensureOnce } from '@/lib/ensure-once';
import { rowsOf, isUuid, clean, logFail } from '@/lib/performance-scope';
import { resolveVideoLink, type VideoLinkResult } from '@/lib/video-embed';
import { persistLessonVideo } from '@/lib/lesson-video';
import { textIn } from '@/lib/pg-array';

// =================================================================================================
// CONSTANTS. Every one declared ABOVE the functions that read them — `const` is not hoisted, and a
// const read before its declaration has taken pages down on this project more than once.
// =================================================================================================

const MOD = 'content-crud';

const WRITE_FAILED = 'We could not save that just now. Nothing was changed.';

/**
 * The capability keys. Spelled ONCE, and every one of them already exists in permissions.ts (union
 * + PERMS_BY_ROLE) and registry.ts BUILTIN_PERMISSIONS. An invented key answers false for everybody.
 */
export const AUTHOR = 'lessons.author' as const;
export const PUBLISH = 'lessons.publish' as const;
export const MANAGE = 'learning.rules.manage' as const;

/** What each capability is FOR, in one line, for the "you cannot do this" sentences. */
const NEED_AUTHOR = 'Changing teaching material needs the "Write lessons" permission.';
const NEED_PUBLISH =
  'This item is published, so learners can already see it. Changing or retiring it needs the '
  + '"Publish lessons" permission as well as "Write lessons".';
const NEED_MANAGE =
  'Deleting content permanently needs the "Set what counts as finishing a course" permission, which '
  + 'is a sensitive one. Archiving needs less and loses nothing.';

/**
 * THERE IS NO UNIT LEVEL. Stated as data so a caller can render the fact rather than guess at it.
 * The hierarchy is course -> module -> lesson -> block (+ training_lesson_versions, lesson-scoped).
 */
export const NO_UNIT_LEVEL =
  'There is no "unit" level in this product. A course holds modules, a module holds lessons, and a '
  + 'lesson holds blocks. Nothing in the training tables sits between a module and a lesson.';

/**
 * Kernel learning objects exist (src/lib/kernel-content.ts) and are NOT joined to training_modules
 * or training_lessons anywhere in this repository. Saying so is better than quietly building a
 * second definition of a lesson that nothing else reads.
 */
export const LEARNING_OBJECTS_NOT_BRIDGED =
  'Kernel learning objects are a separate library and are not attached to modules or lessons. This '
  + 'editor does not pretend they are.';

/**
 * FIELDS THE CREATION FORM COLLECTS AND DOES NOT SAVE. The brief for this module was: if the form
 * collects a field that has no column, say so — do not silently drop it a second time. These are the
 * two, and both are now editable through updateCourse() below.
 */
export const CREATE_FORM_FIELDS_NOT_SAVED = [
  {
    field: 'is_free',
    problem:
      'The create form on /admin/hr/training has no control for it, but the handler reads '
      + 'is_free !== "false" from the submission — so it is ALWAYS true and every course created '
      + 'there is marked free at birth, silently. The column exists; only the control was missing.',
  },
  {
    field: 'slug',
    problem:
      'The web address is generated from the title once, at creation, with a timestamp on the end, '
      + 'and never recomputed. Correcting a title therefore does NOT correct the address the course '
      + 'is published at. It is editable here, and changing it breaks existing links on purpose '
      + 'rather than by accident.',
  },
] as const;

/** Nothing about a person is ever carried into a copy. Exported so the test can assert on it. */
export const DUPLICATE_NEVER_COPIES = [
  'training_enrollments',
  'training_progress',
  'training_lesson_progress',
  'training_lesson_completions',
  'training_quiz_attempts',
  'training_certificates',
  'course_certificates',
  'training_lesson_discussions',
  'training_lesson_versions',
] as const;

/** Access types, kept identical to the ones the catalogue already offers. */
export const ACCESS_TYPES = ['public', 'both', 'employees', 'applicants'] as const;

/** Lesson kinds the HR create form offers. */
export const LESSON_TYPES = ['video', 'text', 'quiz', 'assignment', 'live'] as const;

/**
 * THE DEPENDENCY REGISTRY — what makes a row undeletable, and what it is called in a sentence a
 * human reads. `scope` says how the table is joined to the thing being deleted.
 *
 * Every table here is counted BEFORE any delete, and a table that does not exist on this database is
 * skipped rather than fatal (several of them are created lazily by whichever module ran first).
 */
export interface DependentCount {
  table: string;
  /** Plural, lower case, for "3 enrolments". */
  label: string;
  count: number;
}

/** The columns this module adds, all additive, verified against information_schema before use. */
const ADDED_COLUMNS: { table: string; column: string }[] = [
  { table: 'training_courses', column: 'archived_at' },
  { table: 'training_courses', column: 'archived_by_user_id' },
  { table: 'training_courses', column: 'updated_by_user_id' },
  { table: 'training_courses', column: 'catalogue_order' },
  { table: 'training_modules', column: 'archived_at' },
  { table: 'training_modules', column: 'archived_by_user_id' },
  { table: 'training_modules', column: 'updated_by_user_id' },
  { table: 'training_lessons', column: 'archived_at' },
  { table: 'training_lessons', column: 'archived_by_user_id' },
  { table: 'training_lessons', column: 'updated_by_user_id' },
];

/** Columns other modules add that this one MIRRORS when they are present. */
const MIRROR_COLUMNS: { table: string; column: string }[] = [
  { table: 'training_modules', column: 'description' },
  { table: 'training_modules', column: 'order_in_course' },
  { table: 'training_lessons', column: 'estimated_minutes' },
  { table: 'training_lessons', column: 'preview_allowed' },
  { table: 'training_lessons', column: 'order_in_module' },
  { table: 'training_lessons', column: 'status' },
  { table: 'training_lessons', column: 'published_at' },
];

export type ContentKind = 'course' | 'module' | 'lesson';

const KIND_LABEL: Record<ContentKind, string> = {
  course: 'course',
  module: 'module',
  lesson: 'lesson',
};

export interface ContentResult {
  ok: boolean;
  id?: string;
  error?: string;
  /** A true statement about what happened. Never a claim that a write succeeded when it did not. */
  info?: string;
  /** A true statement about a PART that did not save, when the rest did. */
  warning?: string;
  /** Present when a delete was refused: what depends on the row, and how many of each. */
  dependents?: DependentCount[];
  /** Present when an update was refused because the row moved underneath the editor. */
  conflict?: { changedBy: string; changedAt: string | null };
}

/**
 * THE TEST SEAM, AND IT IS ONLY THAT.
 *
 * Every statement in this module goes through ex(), which carries a TAG naming what the statement
 * is. In production the tag is ignored and the query runs. A test installs a hook, answers by tag,
 * and can then assert the thing that actually matters: that a refused delete executed NO statement
 * whose tag begins with "delete:", and that a duplicate executed no statement against a progress
 * table. There is no module-scope connection and no mutable handle: the transaction handle is passed
 * down the call chain, so two concurrent reorders cannot cross wires.
 */
export type ContentExec = (tag: string, query: any) => Promise<any[]>;
let hook: ContentExec | null = null;
export function __setContentExec(fn: ContentExec | null): void {
  hook = fn;
}

// =================================================================================================
// PURE HELPERS. No database, no capability, no side effect — so the parts that decide whether a
// delete may proceed, what a reorder renumbers to, and what a copy carries can be tested outright.
// =================================================================================================

function iso(v: any): string | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** Milliseconds since the epoch for the version an editor loaded, or null when the row has none. */
export function versionMs(v: any): number | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.getTime();
}

/** A web address a course can actually be served at. Never empty, never leading/trailing dashes. */
export function slugify(raw: unknown): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

/** A copy says it is a copy, in the title, before anybody opens it. */
export function copyTitle(title: unknown): string {
  const t = clean(title, 180) || 'Untitled';
  // A copy of a copy says so too, and does not silently collapse into one name.
  const again = t.match(/\(copy(?: (\d+))?\)$/i);
  if (!again) return t + ' (copy)';
  const n = again[1] ? Number(again[1]) + 1 : 2;
  return t.replace(/\(copy(?: \d+)?\)$/i, '(copy ' + n + ')');
}

/** A copy needs its own address; a timestamp is what the rest of the product already uses. */
export function copySlug(slug: unknown, now: number): string {
  const base = slugify(slug) || 'copy';
  return (base + '-copy-' + now).slice(0, 120);
}

/**
 * MOVE ONE ITEM INSIDE ITS PARENT, TOTALLY.
 *
 * Returns the FULL sibling order after the move — not a delta — because a reorder that writes one
 * row leaves every other row holding whatever number it happened to have, and the HR page and the
 * /admin/courses page both write 0 or 99 by default, so "whatever it happened to have" is very often
 * the same number twice. The caller writes every id in this list. Positions are 0..n-1: total, no
 * gaps, no duplicates, by construction.
 */
export function planReorder(siblingIds: string[], movedId: string, targetIndex: number): string[] {
  const ids = siblingIds.filter((x) => typeof x === 'string' && x.length > 0);
  const from = ids.indexOf(movedId);
  if (from < 0) return ids.slice();
  const rest = ids.slice(0, from).concat(ids.slice(from + 1));
  const at = Math.max(0, Math.min(rest.length, Math.floor(Number(targetIndex))));
  rest.splice(at, 0, movedId);
  return rest;
}

/** [{ id, position }] with position 0..n-1. The shape every reorder statement is built from. */
export function renumber(ids: string[]): { id: string; position: number }[] {
  return ids.map((id, i) => ({ id, position: i }));
}

/** True when a renumbering is total, gapless and free of duplicates. Used by the tests and by us. */
export function orderingIsSound(plan: { id: string; position: number }[]): boolean {
  const ids = new Set(plan.map((p) => p.id));
  if (ids.size !== plan.length) return false;
  const seen = plan.map((p) => p.position).sort((a, b) => a - b);
  return seen.every((p, i) => p === i);
}

/**
 * THE COURSE-WIDE LESSON SEQUENCE.
 *
 * `order_in_module` is module-scoped and `sort_order` is course-scoped, and different screens read
 * different ones. Given the modules in their order and the lessons in theirs, this produces the only
 * pair of numbers under which both screens show the same sequence: position inside the module, and a
 * running course-wide index. Lessons with no module come last, in their existing order, because that
 * is where every reader already puts them.
 */
export function planCourseOrder(
  modules: { id: string }[],
  lessons: { id: string; moduleId: string | null }[],
): { lessonId: string; orderInModule: number; sortOrder: number }[] {
  const out: { lessonId: string; orderInModule: number; sortOrder: number }[] = [];
  let running = 0;
  for (const m of modules) {
    let within = 0;
    for (const l of lessons) {
      if (l.moduleId === m.id) {
        out.push({ lessonId: l.id, orderInModule: within, sortOrder: running });
        within++;
        running++;
      }
    }
  }
  let loose = 0;
  for (const l of lessons) {
    if (!l.moduleId) {
      out.push({ lessonId: l.id, orderInModule: loose, sortOrder: running });
      loose++;
      running++;
    }
  }
  return out;
}

/** Total counts across a dependency probe. */
export function totalDependents(deps: DependentCount[]): number {
  return deps.reduce((n, d) => n + (Number(d.count) || 0), 0);
}

/**
 * THE REFUSAL, AS A SENTENCE. Names what depends on the row and how many of each, and offers the
 * alternative. Pure, so the wording is testable without a database.
 */
export function refusalSentence(kind: ContentKind, deps: DependentCount[]): string {
  const named = deps
    .filter((d) => Number(d.count) > 0)
    .map((d) => d.count + ' ' + d.label)
    .join(', ');
  return (
    'This ' + KIND_LABEL[kind] + ' was NOT deleted, and nothing was changed. People have used it: '
    + named + '. Deleting it would destroy the record that they did the work while leaving any '
    + 'certificate that names it still standing. Archive it instead — it disappears from the '
    + 'catalogue and from new enrolments, and every existing record stays exactly as it is.'
  );
}

/** The conflict sentence. Names the person and the moment, because "try again" explains nothing. */
export function conflictSentence(kind: ContentKind, who: string, whenIso: string | null): string {
  const when = whenIso ? new Date(whenIso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'a moment ago';
  return (
    'Nothing was saved. This ' + KIND_LABEL[kind] + ' was changed by ' + who + ' at ' + when
    + ', after you opened it. Your edit would have overwritten theirs without either of you seeing '
    + 'it. Reload the page to see their version, then make your change again.'
  );
}

/**
 * THE ROW A DUPLICATED LESSON IS BUILT FROM. Pure, and the reason the "a copy carries no progress"
 * test can be an assertion about the code rather than a hope: the returned object is the COMPLETE
 * set of values inserted, and there is no field on it that belongs to a person.
 */
export function lessonCopyRow(
  src: {
    courseId: string; moduleId: string | null; title: string; slug: string | null; type: string | null;
    content: string | null; videoUrl: string | null; durationMins: number;
  },
  now: number,
): {
  courseId: string; moduleId: string | null; title: string; slug: string; type: string;
  content: string | null; videoUrl: string | null; durationMins: number;
  isPreview: false; status: 'draft'; publishedAt: null;
} {
  return {
    courseId: src.courseId,
    moduleId: src.moduleId,
    title: copyTitle(src.title),
    slug: copySlug(src.slug || src.title, now),
    type: src.type || 'text',
    content: src.content ?? null,
    videoUrl: src.videoUrl ?? null,
    durationMins: Number(src.durationMins) || 0,
    // A copy is a DRAFT and is not previewable. A duplicate that arrives live — or worse, already
    // complete for everybody — is worse than no duplicate at all.
    isPreview: false,
    status: 'draft',
    publishedAt: null,
  };
}

// =================================================================================================
// SCHEMA. Additive only, never a DROP, one ensureOnce key for this block.
//
// ensureOnce SWALLOWS failures by design, so its return proves NOTHING. Every function below asks
// information_schema which of these columns actually landed and degrades honestly when one did not,
// rather than issuing an UPDATE that names a column this database has never had — which is exactly
// how the twenty-column statement on /admin/courses/[id]/edit fails and takes the rename down with
// it.
// =================================================================================================

export function ensureContentCrudSchema(): Promise<void> {
  return ensureOnce('content-crud:schema:v1', async () => {
    const ex1 = async (tag: string, q: any) => {
      try {
        await db.execute(q);
      } catch (e: any) {
        console.error('[' + MOD + '] ensure ' + tag, e?.cause?.message || e?.message);
      }
    };

    // ARCHIVE, THE SAFE ALTERNATIVE TO DELETE. training_courses already has these two columns
    // (src/lib/learning-admin.ts adds them and setCourseArchived writes them); repeating the ADD
    // COLUMN IF NOT EXISTS costs nothing and means this module works on a database where that
    // module has never been loaded.
    await ex1('courses.archived_at', sql`ALTER TABLE training_courses ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`);
    await ex1('courses.archived_by', sql`ALTER TABLE training_courses ADD COLUMN IF NOT EXISTS archived_by_user_id UUID`);
    await ex1('modules.archived_at', sql`ALTER TABLE training_modules ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`);
    await ex1('modules.archived_by', sql`ALTER TABLE training_modules ADD COLUMN IF NOT EXISTS archived_by_user_id UUID`);
    await ex1('lessons.archived_at', sql`ALTER TABLE training_lessons ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`);
    await ex1('lessons.archived_by', sql`ALTER TABLE training_lessons ADD COLUMN IF NOT EXISTS archived_by_user_id UUID`);

    // WHO CHANGED IT LAST. Without this, a concurrency refusal can say that somebody else changed
    // the row but not who, which is a notification rather than an answer.
    await ex1('courses.updated_by', sql`ALTER TABLE training_courses ADD COLUMN IF NOT EXISTS updated_by_user_id UUID`);
    await ex1('modules.updated_by', sql`ALTER TABLE training_modules ADD COLUMN IF NOT EXISTS updated_by_user_id UUID`);
    await ex1('lessons.updated_by', sql`ALTER TABLE training_lessons ADD COLUMN IF NOT EXISTS updated_by_user_id UUID`);

    // A MODULE HAD NO updated_at ON EVERY DATABASE. Idempotent; aquintutor-authoring adds it too.
    await ex1('modules.updated_at', sql`ALTER TABLE training_modules ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);

    // COURSES HAVE NO ORDER AT ALL — every catalogue is ORDER BY created_at DESC, so the newest
    // course is always first and nobody can put a foundation course above an advanced one. The
    // column is added here and BACKFILLED IN CODE on first read (see backfillCatalogueOrder), not by
    // a migration. NOTHING READS IT YET: see CATALOGUE_ORDER_NOT_READ_YET below, which lists the
    // exact ORDER BY sites a catalogue would have to adopt. Storing an order nobody displays is
    // honest only if we say so, and we do.
    await ex1('courses.catalogue_order', sql`ALTER TABLE training_courses ADD COLUMN IF NOT EXISTS catalogue_order INT`);
  });
}

/**
 * The ORDER BY sites that would have to change for a course reorder to be visible. Named here rather
 * than left as a surprise: reorderCourses() writes a real column, and until one of these adopts it
 * the stored order changes nothing a learner sees.
 */
export const CATALOGUE_ORDER_NOT_READ_YET = [
  'src/pages/admin/hr/training.astro (ORDER BY created_at DESC)',
  'src/pages/admin/courses/index.astro (ORDER BY created_at DESC)',
  'src/pages/portal/courses/index.astro',
  'src/pages/aquintutor/courses/index.astro',
];

let columnCache: Promise<Set<string>> | null = null;

/**
 * WHICH COLUMNS ACTUALLY EXIST, asked of the database rather than assumed from an ensure that
 * swallows. Keys are "table.column". A probe that could not RUN returns an empty set and every
 * caller then behaves as if the optional columns are absent — degraded, never wrong.
 */
export async function presentColumns(): Promise<Set<string>> {
  if (!columnCache) {
    columnCache = (async () => {
      await ensureContentCrudSchema();
      const wanted = ADDED_COLUMNS.concat(MIRROR_COLUMNS);
      const names = Array.from(new Set(wanted.map((c) => c.column)));
      const tables = Array.from(new Set(wanted.map((c) => c.table)));
      try {
        const rows = await ex(db, 'select:information_schema.columns', sql`
          SELECT table_name, column_name
            FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name::text IN ${textIn(tables)}
             AND column_name::text IN ${textIn(names)}`);
        return new Set(rows.map((r: any) => String(r.table_name) + '.' + String(r.column_name)));
      } catch (e: any) {
        logFail(MOD, 'presentColumns', e);
        columnCache = null; // a failed probe must not poison the process for its lifetime
        return new Set<string>();
      }
    })();
  }
  return columnCache;
}

// =================================================================================================
// THE STATEMENT SEAM
// =================================================================================================

async function ex(handle: any, tag: string, query: any): Promise<any[]> {
  if (hook) return hook(tag, query);
  return rowsOf(await handle.execute(query));
}

/**
 * ONE TRANSACTION. A half-applied reorder leaves a curriculum in two orders at once, which is worse
 * than the order it started in, because nobody can see that it happened.
 */
async function tx<T>(fn: (handle: any) => Promise<T>): Promise<T> {
  if (hook) return fn(null);
  return (db as any).transaction(async (t: any) => fn(t));
}

// =================================================================================================
// READS — what an editor loads, including the version it must send back.
// =================================================================================================

export interface CourseForEdit {
  id: string;
  title: string;
  slug: string | null;
  shortDesc: string | null;
  description: string | null;
  category: string | null;
  level: string | null;
  durationHours: number;
  instructorName: string | null;
  instructorTitle: string | null;
  accessType: string | null;
  isFree: boolean;
  isPublished: boolean;
  archivedAt: string | null;
  /** Send this back with the update. It is what refuses a silent overwrite. */
  version: number | null;
}

export async function loadCourse(courseId: string): Promise<CourseForEdit | null> {
  if (!isUuid(courseId)) return null;
  const rows = await ex(db, 'select:course', sql`
    SELECT id, title, slug, short_desc, description, category, level, duration_hours,
           instructor_name, instructor_title, access_type, is_free, is_published, archived_at,
           COALESCE(updated_at, created_at) AS version_at
      FROM training_courses WHERE id = ${courseId}`);
  const r: any = rows[0];
  if (!r) return null;
  return {
    id: String(r.id),
    title: r.title ? String(r.title) : '',
    slug: r.slug ? String(r.slug) : null,
    shortDesc: r.short_desc ? String(r.short_desc) : null,
    description: r.description ? String(r.description) : null,
    category: r.category ? String(r.category) : null,
    level: r.level ? String(r.level) : null,
    durationHours: Number(r.duration_hours) || 0,
    instructorName: r.instructor_name ? String(r.instructor_name) : null,
    instructorTitle: r.instructor_title ? String(r.instructor_title) : null,
    accessType: r.access_type ? String(r.access_type) : null,
    isFree: r.is_free === true,
    isPublished: r.is_published === true,
    archivedAt: iso(r.archived_at),
    version: versionMs(r.version_at),
  };
}

export interface ModuleForEdit {
  id: string;
  courseId: string;
  title: string;
  summary: string | null;
  sortOrder: number;
  archivedAt: string | null;
  version: number | null;
}

export async function loadModule(moduleId: string): Promise<ModuleForEdit | null> {
  if (!isUuid(moduleId)) return null;
  const rows = await ex(db, 'select:module', sql`
    SELECT id, course_id, title, summary, sort_order, archived_at,
           COALESCE(updated_at, created_at) AS version_at
      FROM training_modules WHERE id = ${moduleId}`);
  const r: any = rows[0];
  if (!r) return null;
  return {
    id: String(r.id),
    courseId: String(r.course_id),
    title: r.title ? String(r.title) : '',
    summary: r.summary ? String(r.summary) : null,
    sortOrder: Number(r.sort_order) || 0,
    archivedAt: iso(r.archived_at),
    version: versionMs(r.version_at),
  };
}

export interface LessonForEdit {
  id: string;
  courseId: string;
  moduleId: string | null;
  title: string;
  slug: string | null;
  type: string | null;
  content: string | null;
  videoUrl: string | null;
  durationMins: number;
  isPreview: boolean;
  status: string | null;
  archivedAt: string | null;
  version: number | null;
}

export async function loadLesson(lessonId: string): Promise<LessonForEdit | null> {
  if (!isUuid(lessonId)) return null;
  const rows = await ex(db, 'select:lesson', sql`
    SELECT id, course_id, module_id, title, slug, type, content, video_url, duration_mins,
           is_preview, status, archived_at, COALESCE(updated_at, created_at) AS version_at
      FROM training_lessons WHERE id = ${lessonId}`);
  const r: any = rows[0];
  if (!r) return null;
  return {
    id: String(r.id),
    courseId: String(r.course_id),
    moduleId: r.module_id ? String(r.module_id) : null,
    title: r.title ? String(r.title) : '',
    slug: r.slug ? String(r.slug) : null,
    type: r.type ? String(r.type) : null,
    content: r.content ? String(r.content) : null,
    videoUrl: r.video_url ? String(r.video_url) : null,
    durationMins: Number(r.duration_mins) || 0,
    isPreview: r.is_preview === true,
    status: r.status ? String(r.status) : null,
    archivedAt: iso(r.archived_at),
    version: versionMs(r.version_at),
  };
}

// =================================================================================================
// DEPENDENTS — the count that stands between a button and somebody's record of work.
// =================================================================================================

interface Probe {
  table: string;
  label: string;
  query: any;
}

function courseProbes(id: string): Probe[] {
  return [
    { table: 'training_enrollments', label: 'enrolments', query: sql`SELECT COUNT(*)::int AS n FROM training_enrollments WHERE course_id = ${id}` },
    { table: 'hr_learning_assignments', label: 'assignments to employees', query: sql`SELECT COUNT(*)::int AS n FROM hr_learning_assignments WHERE course_id = ${id}` },
    { table: 'training_lesson_completions', label: 'lesson completions', query: sql`SELECT COUNT(*)::int AS n FROM training_lesson_completions WHERE course_id = ${id}` },
    { table: 'training_lesson_progress', label: 'lessons people have started', query: sql`SELECT COUNT(*)::int AS n FROM training_lesson_progress WHERE course_id = ${id}` },
    { table: 'training_progress', label: 'recorded lesson completions in the portal player', query: sql`SELECT COUNT(*)::int AS n FROM training_progress WHERE lesson_id IN (SELECT id FROM training_lessons WHERE course_id = ${id})` },
    { table: 'training_quiz_attempts', label: 'quiz attempts', query: sql`SELECT COUNT(*)::int AS n FROM training_quiz_attempts WHERE lesson_id IN (SELECT id FROM training_lessons WHERE course_id = ${id})` },
    { table: 'training_lesson_discussions', label: 'discussion messages', query: sql`SELECT COUNT(*)::int AS n FROM training_lesson_discussions WHERE lesson_id IN (SELECT id FROM training_lessons WHERE course_id = ${id})` },
    { table: 'training_certificates', label: 'certificates', query: sql`SELECT COUNT(*)::int AS n FROM training_certificates WHERE course_id = ${id}` },
    { table: 'course_certificates', label: 'certificates on the signed ledger', query: sql`SELECT COUNT(*)::int AS n FROM course_certificates WHERE course_id = ${id}` },
    { table: 'learning_completion_overrides', label: 'manual completion decisions', query: sql`SELECT COUNT(*)::int AS n FROM learning_completion_overrides WHERE course_id = ${id}` },
  ];
}

function moduleProbes(id: string): Probe[] {
  return [
    { table: 'training_lesson_completions', label: 'lesson completions', query: sql`SELECT COUNT(*)::int AS n FROM training_lesson_completions WHERE lesson_id IN (SELECT id FROM training_lessons WHERE module_id = ${id})` },
    { table: 'training_lesson_progress', label: 'lessons people have started', query: sql`SELECT COUNT(*)::int AS n FROM training_lesson_progress WHERE lesson_id IN (SELECT id FROM training_lessons WHERE module_id = ${id})` },
    { table: 'training_progress', label: 'recorded lesson completions in the portal player', query: sql`SELECT COUNT(*)::int AS n FROM training_progress WHERE lesson_id IN (SELECT id FROM training_lessons WHERE module_id = ${id})` },
    { table: 'training_quiz_attempts', label: 'quiz attempts', query: sql`SELECT COUNT(*)::int AS n FROM training_quiz_attempts WHERE lesson_id IN (SELECT id FROM training_lessons WHERE module_id = ${id})` },
    { table: 'training_lesson_discussions', label: 'discussion messages', query: sql`SELECT COUNT(*)::int AS n FROM training_lesson_discussions WHERE lesson_id IN (SELECT id FROM training_lessons WHERE module_id = ${id})` },
    { table: 'training_enrollments', label: 'enrolments that are resting on one of its lessons', query: sql`SELECT COUNT(*)::int AS n FROM training_enrollments WHERE last_lesson_id IN (SELECT id FROM training_lessons WHERE module_id = ${id})` },
  ];
}

function lessonProbes(id: string): Probe[] {
  return [
    { table: 'training_lesson_completions', label: 'completions', query: sql`SELECT COUNT(*)::int AS n FROM training_lesson_completions WHERE lesson_id = ${id}` },
    { table: 'training_lesson_progress', label: 'people who have started it', query: sql`SELECT COUNT(*)::int AS n FROM training_lesson_progress WHERE lesson_id = ${id}` },
    { table: 'training_progress', label: 'recorded completions in the portal player', query: sql`SELECT COUNT(*)::int AS n FROM training_progress WHERE lesson_id = ${id}` },
    { table: 'training_quiz_attempts', label: 'quiz attempts', query: sql`SELECT COUNT(*)::int AS n FROM training_quiz_attempts WHERE lesson_id = ${id}` },
    { table: 'training_lesson_discussions', label: 'discussion messages', query: sql`SELECT COUNT(*)::int AS n FROM training_lesson_discussions WHERE lesson_id = ${id}` },
    { table: 'training_enrollments', label: 'enrolments resting on it', query: sql`SELECT COUNT(*)::int AS n FROM training_enrollments WHERE last_lesson_id = ${id}` },
  ];
}

/**
 * WHICH OF THOSE TABLES EXIST. Several are created lazily by whichever module happened to load
 * first, so a missing one is normal and must not be fatal. A probe that cannot RUN throws, and the
 * caller refuses the delete — because "the count failed" and "the count was zero" are not the same
 * answer, and only one of them makes a delete safe.
 */
async function existingTables(handle: any, names: string[]): Promise<Set<string>> {
  const rows = await ex(handle, 'select:information_schema.tables', sql`
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_name::text IN ${textIn(names)}`);
  return new Set(rows.map((r: any) => String(r.table_name)));
}

/**
 * COUNT EVERYTHING THAT POINTS AT THIS ROW. Throws if the probe cannot be completed; callers turn
 * that into a refusal, never into a delete.
 */
export async function countDependents(kind: ContentKind, id: string, handle: any = db): Promise<DependentCount[]> {
  if (!isUuid(id)) throw new Error('That ' + KIND_LABEL[kind] + ' does not exist.');
  const probes = kind === 'course' ? courseProbes(id) : kind === 'module' ? moduleProbes(id) : lessonProbes(id);
  const present = await existingTables(handle, Array.from(new Set(probes.map((p) => p.table))));
  const out: DependentCount[] = [];
  for (const p of probes) {
    if (!present.has(p.table)) continue;
    const rows = await ex(handle, 'count:' + p.table, p.query);
    const n = Number((rows[0] as any)?.n) || 0;
    if (n > 0) out.push({ table: p.table, label: p.label, count: n });
  }
  return out;
}

// =================================================================================================
// GATES
// =================================================================================================

function gate(actor: User | null, needed: 'author' | 'publish' | 'manage', isPublished: boolean): string | null {
  if (!actor) return 'Sign in again — we could not tell who is making this change.';
  if (needed === 'manage') return can(actor, MANAGE) ? null : NEED_MANAGE;
  if (!can(actor, AUTHOR)) return NEED_AUTHOR;
  if ((needed === 'publish' || isPublished) && !can(actor, PUBLISH)) return NEED_PUBLISH;
  return null;
}

function actorId(actor: User | null): string | null {
  const id = actor?.id ? String(actor.id) : null;
  return id && isUuid(id) ? id : null;
}

/** Who last touched this row, for the conflict sentence. Falls back to an honest "somebody else". */
async function lastEditor(handle: any, table: 'training_courses' | 'training_modules' | 'training_lessons', id: string): Promise<string> {
  const cols = await presentColumns();
  if (!cols.has(table + '.updated_by_user_id')) return 'somebody else';
  try {
    const rows =
      table === 'training_courses'
        ? await ex(handle, 'select:last-editor:course', sql`SELECT u.name FROM training_courses c LEFT JOIN users u ON u.id = c.updated_by_user_id WHERE c.id = ${id}`)
        : table === 'training_modules'
          ? await ex(handle, 'select:last-editor:module', sql`SELECT u.name FROM training_modules c LEFT JOIN users u ON u.id = c.updated_by_user_id WHERE c.id = ${id}`)
          : await ex(handle, 'select:last-editor:lesson', sql`SELECT u.name FROM training_lessons c LEFT JOIN users u ON u.id = c.updated_by_user_id WHERE c.id = ${id}`);
    const n = (rows[0] as any)?.name;
    return n ? String(n) : 'somebody else';
  } catch (e: any) {
    // Not swallowed: logged with the real reason. The refusal still stands — we simply cannot name
    // the person, and we say "somebody else" rather than inventing one.
    logFail(MOD, 'lastEditor', e);
    return 'somebody else';
  }
}

/**
 * The stale-version guard, expressed as SQL so the check and the write are one statement.
 * The comparison is in milliseconds with a 1ms tolerance: timestamptz keeps microseconds and a
 * JavaScript Date does not, so exact equality would refuse every legitimate save.
 */
function versionGuard(expected: number | null): any {
  if (expected === null || !Number.isFinite(expected)) return sql`TRUE`;
  return sql`ABS(EXTRACT(EPOCH FROM COALESCE(updated_at, created_at)) * 1000 - ${expected}) < 1`;
}

const NO_VERSION_WARNING =
  'This row carries no last-changed time, so we could not check whether somebody else edited it '
  + 'while you had it open. Your change was saved.';

// =================================================================================================
// COURSE
// =================================================================================================

export interface CourseUpdate {
  courseId: string;
  /** The version loadCourse() returned. Sending null skips the guard and earns a warning. */
  version: number | null;
  title: string;
  slug?: string;
  shortDesc?: string;
  description?: string;
  category?: string;
  level?: string;
  durationHours?: number;
  instructorName?: string;
  instructorTitle?: string;
  accessType?: string;
  isFree?: boolean;
}

/**
 * RENAME, RE-LEVEL, RE-CATEGORISE, RE-TIME AND REASSIGN A COURSE — the update that did not exist.
 *
 * ONE STATEMENT, AND ONLY COLUMNS THIS DATABASE PROVABLY HAS. Every column written here is written
 * by the INSERT on /admin/hr/training that created the row, so a database that can create a course
 * can save this edit. The twenty-column statement on /admin/courses/[id]/edit names seven columns
 * that have no CREATE and no ADD COLUMN anywhere in the repository, and if any one of them is absent
 * the whole statement raises and the TITLE does not save either — which is the most likely reason
 * the typo is experienced as uncorrectable rather than merely hard to find. This one cannot fail
 * that way.
 */
export async function updateCourse(actor: User | null, input: CourseUpdate): Promise<ContentResult> {
  const courseId = String(input?.courseId || '');
  if (!isUuid(courseId)) return { ok: false, error: 'That course does not exist.' };

  const before = await loadCourse(courseId);
  if (!before) return { ok: false, error: 'That course no longer exists. Nothing was changed.' };

  const denied = gate(actor, 'author', before.isPublished);
  if (denied) return { ok: false, error: denied };

  const title = clean(input?.title, 200);
  if (!title) return { ok: false, error: 'A course needs a title. Nothing was changed.' };

  const slug = input?.slug === undefined ? (before.slug || '') : slugify(input.slug);
  if (!slug) return { ok: false, error: 'A course needs a web address. Nothing was changed.' };

  const shortDesc = input?.shortDesc === undefined ? before.shortDesc : (clean(input.shortDesc, 400) || null);
  const description = input?.description === undefined ? before.description : (String(input.description || '').trim() || null);
  const category = (input?.category === undefined ? before.category : clean(input.category, 60)) || 'general';
  const level = (input?.level === undefined ? before.level : clean(input.level, 40)) || 'beginner';
  const hours = input?.durationHours === undefined ? before.durationHours : (Number(input.durationHours) || 0);
  const instructor = input?.instructorName === undefined ? before.instructorName : (clean(input.instructorName, 200) || null);
  const instructorTitle = input?.instructorTitle === undefined ? before.instructorTitle : (clean(input.instructorTitle, 200) || null);
  const wantedAccess = input?.accessType === undefined ? before.accessType : String(input.accessType);
  const access = (ACCESS_TYPES as readonly string[]).includes(String(wantedAccess)) ? String(wantedAccess) : 'employees';
  const isFree = input?.isFree === undefined ? before.isFree : input.isFree === true;

  const who = actorId(actor);
  const cols = await presentColumns();
  const trackEditor = cols.has('training_courses.updated_by_user_id') && who !== null;

  try {
    // The slug clash is tested INSIDE the statement: two editors cannot both claim one address.
    const rows = await ex(db, 'update:course', sql`
      UPDATE training_courses
         SET title = ${title}, slug = ${slug}, short_desc = ${shortDesc}, description = ${description},
             category = ${category}, level = ${level}, duration_hours = ${hours},
             instructor_name = ${instructor}, instructor_title = ${instructorTitle},
             access_type = ${access}, is_free = ${isFree}, updated_at = NOW()
             ${trackEditor ? sql`, updated_by_user_id = ${who}` : sql``}
       WHERE id = ${courseId}
         AND ${versionGuard(input?.version ?? null)}
         AND NOT EXISTS (SELECT 1 FROM training_courses o WHERE o.slug = ${slug} AND o.id <> ${courseId})
      RETURNING id, COALESCE(updated_at, created_at) AS version_at`);

    if (!rows.length) {
      // Nothing was written. Say WHICH of the three reasons it was, from the row itself.
      const now = await loadCourse(courseId);
      if (!now) return { ok: false, error: 'Nothing was saved — that course was removed while you were editing it.' };
      if (now.slug !== slug) {
        const clash = await ex(db, 'select:slug-clash', sql`SELECT title FROM training_courses WHERE slug = ${slug} AND id <> ${courseId}`);
        if (clash.length) {
          return {
            ok: false,
            error: 'Nothing was saved. The web address /' + slug + ' already belongs to "'
              + String((clash[0] as any).title || 'another course') + '". Choose a different address.',
          };
        }
      }
      const whoElse = await lastEditor(db, 'training_courses', courseId);
      return {
        ok: false,
        error: conflictSentence('course', whoElse, iso(now.version)),
        conflict: { changedBy: whoElse, changedAt: iso(now.version) },
      };
    }

    await logAudit({
      userId: who,
      action: 'content.course.update',
      entity: 'training_courses',
      entityId: courseId,
      diff: diffOf(
        { title: before.title, slug: before.slug, shortDesc: before.shortDesc, description: before.description, category: before.category, level: before.level, durationHours: before.durationHours, instructorName: before.instructorName, instructorTitle: before.instructorTitle, accessType: before.accessType, isFree: before.isFree },
        { title, slug, shortDesc, description, category, level, durationHours: hours, instructorName: instructor, instructorTitle: instructorTitle, accessType: access, isFree },
      ),
    });

    // THE SECOND SPELLING OF "LEVEL". Two editors in this product write `difficulty` instead of
    // `level` and never reconcile them, so a re-levelled course shows the old value on the other
    // screen. Written as a SEPARATE statement whose failure is REPORTED, never swallowed, so a
    // database without that column still saves the rename.
    let warning = '';
    try {
      await ex(db, 'update:course-difficulty-mirror', sql`
        UPDATE training_courses SET difficulty = ${level} WHERE id = ${courseId}`);
    } catch (e: any) {
      logFail(MOD, 'difficulty mirror', e);
      warning = 'Saved. One thing did not: the second course screen keeps the level in its own '
        + 'column and that write failed (' + String(e?.cause?.message || e?.message || 'unknown reason').slice(0, 140)
        + '), so that screen may still show the old level.';
    }
    if (input?.version === null || input?.version === undefined) {
      warning = warning ? warning + ' ' + NO_VERSION_WARNING : NO_VERSION_WARNING;
    }

    const addressChanged = before.slug !== slug;
    return {
      ok: true,
      id: courseId,
      info:
        'Course saved.'
        + (addressChanged
          ? ' The web address changed from /' + (before.slug || '(none)') + ' to /' + slug
            + '. Any link anybody already has to the old address will stop working — that is what '
            + 'changing an address does, and nothing here can keep both alive.'
          : ' The web address is unchanged at /' + slug + ', so a typo in the title does not follow '
            + 'through to the address unless you change it here too.')
        + (before.isPublished ? ' It is published, so learners see this change now.' : ''),
      warning: warning || undefined,
    };
  } catch (e: any) {
    logFail(MOD, 'updateCourse', e);
    return { ok: false, error: 'Nothing was saved. Reason: ' + (e?.cause?.message || e?.message || WRITE_FAILED) };
  }
}

/** ARCHIVE A COURSE — the safe alternative to deletion, and the one the delete refusal offers. */
export async function archiveCourse(actor: User | null, courseId: string, archived: boolean): Promise<ContentResult> {
  if (!isUuid(courseId)) return { ok: false, error: 'That course does not exist.' };
  const before = await loadCourse(courseId);
  if (!before) return { ok: false, error: 'That course no longer exists.' };
  const denied = gate(actor, 'publish', before.isPublished);
  if (denied) return { ok: false, error: denied };
  const who = actorId(actor);
  const cols = await presentColumns();
  if (!cols.has('training_courses.archived_at')) {
    return {
      ok: false,
      error: 'Nothing was changed. This database does not have the archive column yet, and we will '
        + 'not offer a delete in its place.',
    };
  }
  try {
    const rows = archived
      ? await ex(db, 'update:course-archive', sql`
          UPDATE training_courses
             SET archived_at = NOW(), archived_by_user_id = ${who}, is_published = false, updated_at = NOW()
           WHERE id = ${courseId} RETURNING id`)
      : await ex(db, 'update:course-unarchive', sql`
          UPDATE training_courses
             SET archived_at = NULL, archived_by_user_id = NULL, updated_at = NOW()
           WHERE id = ${courseId} RETURNING id`);
    if (!rows.length) return { ok: false, error: 'Nothing was changed — that course no longer exists.' };
    await logAudit({
      userId: who,
      action: archived ? 'content.course.archive' : 'content.course.restore',
      entity: 'training_courses',
      entityId: courseId,
      diff: { from: { archivedAt: before.archivedAt, isPublished: before.isPublished }, to: { archived } },
    });
    return {
      ok: true,
      id: courseId,
      info: archived
        ? 'Course archived and unpublished. Every enrolment, completion and certificate that points '
          + 'at it is untouched — nothing was deleted.'
        : 'Course taken out of the archive. It stays unpublished until you publish it, so nothing '
          + 'reappeared in front of a learner without you deciding it should.',
    };
  } catch (e: any) {
    logFail(MOD, 'archiveCourse', e);
    return { ok: false, error: 'Nothing was changed. Reason: ' + (e?.cause?.message || e?.message || WRITE_FAILED) };
  }
}

/**
 * DELETE A COURSE — ONLY WHERE NOTHING DEPENDS ON IT.
 *
 * The five existing delete buttons in this product run an unconditional
 * `DELETE FROM training_courses WHERE id = $1` behind a browser confirm(). Whether that also removes
 * the lessons is not knowable from source — training_lessons has no CREATE TABLE anywhere in the
 * repository, so its foreign key and delete rule live only in the production catalogue. The three
 * possibilities are: the lessons cascade (and with them blocks, versions, per-lesson progress and
 * discussions), the delete raises, or the lessons are orphaned. Certificates have no foreign key at
 * all in any of the three, so they survive and go on asserting that somebody completed a course that
 * no longer exists.
 *
 * This function does not need to know which. It refuses while anything at all points at the course.
 */
export async function deleteCourse(actor: User | null, courseId: string): Promise<ContentResult> {
  if (!isUuid(courseId)) return { ok: false, error: 'That course does not exist.' };
  const before = await loadCourse(courseId);
  if (!before) return { ok: false, error: 'That course no longer exists.' };
  const denied = gate(actor, 'manage', before.isPublished);
  if (denied) return { ok: false, error: denied };
  const who = actorId(actor);

  let deps: DependentCount[];
  try {
    deps = await countDependents('course', courseId);
  } catch (e: any) {
    // FAIL CLOSED. A count that could not run is not a count that found nothing.
    logFail(MOD, 'countDependents:course', e);
    return {
      ok: false,
      error: 'Nothing was deleted. We could not check whether anybody has used this course ('
        + String(e?.cause?.message || e?.message || 'unknown reason').slice(0, 140)
        + '), and we will not delete a course we could not check. Archive it instead.',
    };
  }

  if (totalDependents(deps) > 0) {
    await logAudit({ userId: who, action: 'content.course.delete.refused', entity: 'training_courses', entityId: courseId, diff: { dependents: deps } });
    return { ok: false, error: refusalSentence('course', deps), dependents: deps };
  }

  if (before.isPublished) {
    return {
      ok: false,
      error: 'Nothing was deleted. This course is published. Unpublish it first, so that removing it '
        + 'is a decision taken twice rather than once.',
    };
  }

  try {
    const rows = await ex(db, 'delete:course', sql`DELETE FROM training_courses WHERE id = ${courseId} RETURNING id`);
    if (!rows.length) return { ok: false, error: 'Nothing was deleted — that course had already gone.' };
    await logAudit({
      userId: who,
      action: 'content.course.delete',
      entity: 'training_courses',
      entityId: courseId,
      diff: { from: { title: before.title, slug: before.slug, level: before.level, category: before.category }, to: null },
    });
    return { ok: true, id: courseId, info: 'Course deleted. Nothing depended on it — no enrolment, no progress, no completion and no certificate.' };
  } catch (e: any) {
    logFail(MOD, 'deleteCourse', e);
    return {
      ok: false,
      error: 'Nothing was deleted. Reason: ' + (e?.cause?.message || e?.message || WRITE_FAILED)
        + ' The course is unchanged.',
    };
  }
}

/**
 * REORDER THE CATALOGUE. Writes catalogue_order across every non-archived course in one transaction,
 * backfilling from the order the catalogue shows today. NOTHING READS IT YET — see
 * CATALOGUE_ORDER_NOT_READ_YET — and the returned info says so rather than implying a visible change.
 */
export async function reorderCourses(actor: User | null, movedId: string, targetIndex: number): Promise<ContentResult> {
  const denied = gate(actor, 'publish', true);
  if (denied) return { ok: false, error: denied };
  if (!isUuid(movedId)) return { ok: false, error: 'That course does not exist.' };
  const who = actorId(actor);
  const cols = await presentColumns();
  if (!cols.has('training_courses.catalogue_order')) {
    return { ok: false, error: 'Nothing was changed. This database has no course order column yet.' };
  }
  try {
    return await tx(async (h) => {
      const rows = await ex(h, 'select:courses-order', sql`
        SELECT id FROM training_courses
         WHERE archived_at IS NULL
         ORDER BY catalogue_order NULLS LAST, created_at DESC`);
      const ids = rows.map((r: any) => String(r.id));
      const planned = renumber(planReorder(ids, movedId, targetIndex));
      for (const p of planned) {
        await ex(h, 'update:course-order', sql`UPDATE training_courses SET catalogue_order = ${p.position} WHERE id = ${p.id}`);
      }
      await logAudit({ userId: who, action: 'content.course.reorder', entity: 'training_courses', entityId: movedId, diff: { from: ids, to: planned.map((p) => p.id) } });
      return {
        ok: true,
        id: movedId,
        info: 'Order saved for ' + planned.length + ' courses.',
        warning:
          'No catalogue reads this order yet — every course list in the product still sorts by the '
          + 'date it was created. The order is stored and will apply the moment a list adopts it.',
      };
    });
  } catch (e: any) {
    logFail(MOD, 'reorderCourses', e);
    return { ok: false, error: 'The order was not changed. Reason: ' + (e?.cause?.message || e?.message || WRITE_FAILED) };
  }
}

// =================================================================================================
// MODULE
// =================================================================================================

export async function updateModule(
  actor: User | null,
  input: { moduleId: string; version: number | null; title: string; summary?: string },
): Promise<ContentResult> {
  const moduleId = String(input?.moduleId || '');
  if (!isUuid(moduleId)) return { ok: false, error: 'That module does not exist.' };
  const before = await loadModule(moduleId);
  if (!before) return { ok: false, error: 'That module no longer exists. Nothing was changed.' };
  const course = await loadCourse(before.courseId);
  const denied = gate(actor, 'author', course?.isPublished === true);
  if (denied) return { ok: false, error: denied };

  const title = clean(input?.title, 300);
  if (!title) return { ok: false, error: 'A module needs a title. Nothing was changed.' };
  const summary = input?.summary === undefined ? before.summary : (String(input.summary || '').trim() || null);

  const who = actorId(actor);
  const cols = await presentColumns();
  const trackEditor = cols.has('training_modules.updated_by_user_id') && who !== null;
  const hasDescription = cols.has('training_modules.description');

  try {
    // BOTH SPELLINGS OF THE MODULE'S TEXT, in one statement: /admin/courses writes `description`
    // and the authoring library writes `summary`, and a module saved through one used to read as
    // empty through the other.
    const rows = await ex(db, 'update:module', sql`
      UPDATE training_modules
         SET title = ${title}, summary = ${summary}, updated_at = NOW()
             ${hasDescription ? sql`, description = ${summary}` : sql``}
             ${trackEditor ? sql`, updated_by_user_id = ${who}` : sql``}
       WHERE id = ${moduleId} AND ${versionGuard(input?.version ?? null)}
      RETURNING id`);
    if (!rows.length) {
      const now = await loadModule(moduleId);
      if (!now) return { ok: false, error: 'Nothing was saved — that module was removed while you were editing it.' };
      const whoElse = await lastEditor(db, 'training_modules', moduleId);
      return { ok: false, error: conflictSentence('module', whoElse, iso(now.version)), conflict: { changedBy: whoElse, changedAt: iso(now.version) } };
    }
    await logAudit({
      userId: who,
      action: 'content.module.update',
      entity: 'training_modules',
      entityId: moduleId,
      diff: diffOf({ title: before.title, summary: before.summary }, { title, summary }),
    });
    return {
      ok: true,
      id: moduleId,
      info: 'Module saved.',
      warning: hasDescription ? undefined : 'The module text was saved in one of its two columns; this database does not have the other one, so a second screen may still show the old text.',
    };
  } catch (e: any) {
    logFail(MOD, 'updateModule', e);
    return { ok: false, error: 'Nothing was saved. Reason: ' + (e?.cause?.message || e?.message || WRITE_FAILED) };
  }
}

/**
 * REORDER MODULES INSIDE A COURSE, AND RENUMBER EVERY LESSON WITH THEM.
 *
 * One transaction. Both spellings at both levels: modules get sort_order AND order_in_course; every
 * lesson in the course gets a fresh order_in_module and a fresh course-wide sort_order, because
 * moving a module changes where its lessons fall in the course-wide sequence that half the readers
 * use. Anything less leaves the curriculum in two orders at once.
 */
export async function reorderModules(actor: User | null, courseId: string, movedId: string, targetIndex: number): Promise<ContentResult> {
  if (!isUuid(courseId) || !isUuid(movedId)) return { ok: false, error: 'That module does not exist.' };
  const course = await loadCourse(courseId);
  if (!course) return { ok: false, error: 'That course no longer exists.' };
  const denied = gate(actor, 'author', course.isPublished);
  if (denied) return { ok: false, error: denied };
  const who = actorId(actor);
  const cols = await presentColumns();

  try {
    return await tx(async (h) => {
      const before = (await ex(h, 'select:modules-order', sql`
        SELECT id FROM training_modules WHERE course_id = ${courseId}
         ORDER BY sort_order ASC, created_at ASC`)).map((r: any) => String(r.id));
      const orderedIds = planReorder(before, movedId, targetIndex);
      const planned = renumber(orderedIds);
      for (const p of planned) {
        await ex(h, 'update:module-order', sql`
          UPDATE training_modules SET sort_order = ${p.position}, updated_at = NOW()
            ${cols.has('training_modules.order_in_course') ? sql`, order_in_course = ${p.position}` : sql``}
           WHERE id = ${p.id} AND course_id = ${courseId}`);
      }
      await renumberCourseLessons(h, courseId, orderedIds, cols);
      await logAudit({ userId: who, action: 'content.module.reorder', entity: 'training_modules', entityId: movedId, diff: { from: before, to: orderedIds } });
      return { ok: true, id: movedId, info: 'Order saved. ' + planned.length + ' modules renumbered, and every lesson in the course renumbered with them so both screens show the same sequence.' };
    });
  } catch (e: any) {
    logFail(MOD, 'reorderModules', e);
    return { ok: false, error: 'The order was not changed — nothing was half-applied. Reason: ' + (e?.cause?.message || e?.message || WRITE_FAILED) };
  }
}

/** Rewrite order_in_module and the course-wide sort_order for every lesson in the course. */
async function renumberCourseLessons(h: any, courseId: string, moduleIdsInOrder: string[], cols: Set<string>): Promise<void> {
  const lessonRows = await ex(h, 'select:lessons-order', sql`
    SELECT id, module_id FROM training_lessons WHERE course_id = ${courseId}
     ORDER BY sort_order ASC, created_at ASC`);
  const lessons = lessonRows.map((r: any) => ({ id: String(r.id), moduleId: r.module_id ? String(r.module_id) : null }));
  const plan = planCourseOrder(moduleIdsInOrder.map((id) => ({ id })), lessons);
  for (const p of plan) {
    await ex(h, 'update:lesson-order', sql`
      UPDATE training_lessons SET sort_order = ${p.sortOrder}, updated_at = NOW()
        ${cols.has('training_lessons.order_in_module') ? sql`, order_in_module = ${p.orderInModule}` : sql``}
       WHERE id = ${p.lessonId}`);
  }
}

/**
 * DUPLICATE A MODULE AND EVERYTHING UNDER IT — lessons, and each lesson's blocks.
 *
 * WHAT IS NOT COPIED: enrolments, progress, completions, quiz attempts, discussions, certificates
 * and version history. A duplicated lesson that arrives already complete for everybody is worse than
 * no duplicate at all. Every copied lesson is a DRAFT and is not previewable, so the copy cannot
 * appear in front of a learner because somebody pressed a button twice.
 */
export async function duplicateModule(actor: User | null, moduleId: string): Promise<ContentResult> {
  if (!isUuid(moduleId)) return { ok: false, error: 'That module does not exist.' };
  const src = await loadModule(moduleId);
  if (!src) return { ok: false, error: 'That module no longer exists.' };
  const course = await loadCourse(src.courseId);
  const denied = gate(actor, 'author', course?.isPublished === true);
  if (denied) return { ok: false, error: denied };
  const who = actorId(actor);
  const cols = await presentColumns();
  const now = Date.now();

  try {
    return await tx(async (h) => {
      const made = await ex(h, 'insert:module-copy', sql`
        INSERT INTO training_modules (course_id, title, summary, sort_order)
        SELECT ${src.courseId}, ${copyTitle(src.title)}, ${src.summary}, COALESCE(MAX(sort_order), -1) + 1
          FROM training_modules WHERE course_id = ${src.courseId}
        RETURNING id`);
      const newModuleId = String((made[0] as any)?.id || '');
      if (!newModuleId) throw new Error('The copied module did not come back with an id.');

      const lessons = await ex(h, 'select:module-lessons', sql`
        SELECT id, course_id, module_id, title, slug, type, content, video_url, duration_mins
          FROM training_lessons WHERE module_id = ${moduleId}
         ORDER BY sort_order ASC, created_at ASC`);

      let copied = 0;
      for (const l of lessons) {
        const row = lessonCopyRow(
          {
            courseId: src.courseId,
            moduleId: newModuleId,
            title: String((l as any).title || ''),
            slug: (l as any).slug ? String((l as any).slug) : null,
            type: (l as any).type ? String((l as any).type) : null,
            content: (l as any).content ? String((l as any).content) : null,
            videoUrl: (l as any).video_url ? String((l as any).video_url) : null,
            durationMins: Number((l as any).duration_mins) || 0,
          },
          now + copied,
        );
        const newId = await insertLessonCopy(h, row, cols);
        await copyBlocks(h, String((l as any).id), newId);
        copied++;
      }

      await logAudit({
        userId: who,
        action: 'content.module.duplicate',
        entity: 'training_modules',
        entityId: newModuleId,
        diff: { from: { moduleId, title: src.title }, to: { moduleId: newModuleId, title: copyTitle(src.title), lessonsCopied: copied } },
      });
      return {
        ok: true,
        id: newModuleId,
        info: 'Module copied with ' + copied + ' lessons. Every copied lesson is a draft, and no '
          + 'enrolment, progress, completion or quiz attempt came across — the copy is empty of '
          + 'people, which is the only honest thing a copy can be.',
      };
    });
  } catch (e: any) {
    logFail(MOD, 'duplicateModule', e);
    return { ok: false, error: 'Nothing was copied. Reason: ' + (e?.cause?.message || e?.message || WRITE_FAILED) };
  }
}

/** ARCHIVE A MODULE. Its lessons are archived and unpublished with it — that is what hides them. */
export async function archiveModule(actor: User | null, moduleId: string, archived: boolean): Promise<ContentResult> {
  if (!isUuid(moduleId)) return { ok: false, error: 'That module does not exist.' };
  const src = await loadModule(moduleId);
  if (!src) return { ok: false, error: 'That module no longer exists.' };
  const course = await loadCourse(src.courseId);
  const denied = gate(actor, 'publish', course?.isPublished === true);
  if (denied) return { ok: false, error: denied };
  const who = actorId(actor);
  const cols = await presentColumns();
  if (!cols.has('training_modules.archived_at') || !cols.has('training_lessons.archived_at')) {
    return { ok: false, error: 'Nothing was changed. This database does not have the archive columns yet, and we will not offer a delete in their place.' };
  }
  const hasStatus = cols.has('training_lessons.status');

  try {
    return await tx(async (h) => {
      const rows = archived
        ? await ex(h, 'update:module-archive', sql`
            UPDATE training_modules SET archived_at = NOW(), archived_by_user_id = ${who}, updated_at = NOW()
             WHERE id = ${moduleId} RETURNING id`)
        : await ex(h, 'update:module-unarchive', sql`
            UPDATE training_modules SET archived_at = NULL, archived_by_user_id = NULL, updated_at = NOW()
             WHERE id = ${moduleId} RETURNING id`);
      if (!rows.length) return { ok: false, error: 'Nothing was changed — that module no longer exists.' };

      // A module has no publish flag of its own, so archiving it must reach its lessons or it hides
      // nothing: every player counts lessons by status, not by their module.
      if (archived) {
        await ex(h, 'update:module-lessons-archive', sql`
          UPDATE training_lessons SET archived_at = NOW(), archived_by_user_id = ${who}, updated_at = NOW()
            ${hasStatus ? sql`, status = 'draft'` : sql``}
           WHERE module_id = ${moduleId}`);
      } else {
        await ex(h, 'update:module-lessons-unarchive', sql`
          UPDATE training_lessons SET archived_at = NULL, archived_by_user_id = NULL, updated_at = NOW()
           WHERE module_id = ${moduleId}`);
      }

      await logAudit({ userId: who, action: archived ? 'content.module.archive' : 'content.module.restore', entity: 'training_modules', entityId: moduleId, diff: { from: { archivedAt: src.archivedAt }, to: { archived } } });
      return {
        ok: true,
        id: moduleId,
        info: archived
          ? 'Module archived, and its lessons put back to draft so nothing in it is being taught. '
            + 'No completion, progress row or certificate was touched.'
          : 'Module taken out of the archive. Its lessons are back as DRAFTS — publish the ones that '
            + 'should teach again, because we will not put anything in front of a learner on your behalf.',
      };
    });
  } catch (e: any) {
    logFail(MOD, 'archiveModule', e);
    return { ok: false, error: 'Nothing was changed. Reason: ' + (e?.cause?.message || e?.message || WRITE_FAILED) };
  }
}

/** DELETE A MODULE — refused while anything under it has been used by a person. */
export async function deleteModule(actor: User | null, moduleId: string): Promise<ContentResult> {
  if (!isUuid(moduleId)) return { ok: false, error: 'That module does not exist.' };
  const src = await loadModule(moduleId);
  if (!src) return { ok: false, error: 'That module no longer exists.' };
  const course = await loadCourse(src.courseId);
  const denied = gate(actor, 'manage', course?.isPublished === true);
  if (denied) return { ok: false, error: denied };
  const who = actorId(actor);

  let deps: DependentCount[];
  try {
    deps = await countDependents('module', moduleId);
  } catch (e: any) {
    logFail(MOD, 'countDependents:module', e);
    return { ok: false, error: 'Nothing was deleted. We could not check whether anybody has used the lessons in this module (' + String(e?.cause?.message || e?.message || 'unknown reason').slice(0, 140) + '). Archive it instead.' };
  }
  if (totalDependents(deps) > 0) {
    await logAudit({ userId: who, action: 'content.module.delete.refused', entity: 'training_modules', entityId: moduleId, diff: { dependents: deps } });
    return { ok: false, error: refusalSentence('module', deps), dependents: deps };
  }

  try {
    const rows = await ex(db, 'delete:module', sql`DELETE FROM training_modules WHERE id = ${moduleId} AND course_id = ${src.courseId} RETURNING id`);
    if (!rows.length) return { ok: false, error: 'Nothing was deleted — that module had already gone.' };
    await logAudit({ userId: who, action: 'content.module.delete', entity: 'training_modules', entityId: moduleId, diff: { from: { title: src.title, courseId: src.courseId }, to: null } });
    return { ok: true, id: moduleId, info: 'Module deleted. Nothing under it had been used by anybody.' };
  } catch (e: any) {
    logFail(MOD, 'deleteModule', e);
    return { ok: false, error: 'Nothing was deleted. Reason: ' + (e?.cause?.message || e?.message || WRITE_FAILED) };
  }
}

// =================================================================================================
// LESSON
// =================================================================================================

export interface LessonUpdate {
  lessonId: string;
  version: number | null;
  title: string;
  type?: string;
  content?: string;
  durationMins?: number;
  isPreview?: boolean;
  /** The pasted address. An empty string clears the video; undefined leaves it alone. */
  videoUrl?: string;
  /** The author ticked "this one opens elsewhere" — it still has to pass every other check. */
  videoOpensElsewhere?: boolean;
}

/**
 * EDIT A LESSON — every field the create form offers, and both spellings of the two it duplicates.
 *
 * duration_mins and estimated_minutes are the same fact under two names with different readers, as
 * are is_preview and preview_allowed. Both are written. The mirrors live in a second statement so a
 * database missing one of them still saves the title, and the failure is reported rather than
 * swallowed.
 */
export async function updateLesson(actor: User | null, input: LessonUpdate): Promise<ContentResult> {
  const lessonId = String(input?.lessonId || '');
  if (!isUuid(lessonId)) return { ok: false, error: 'That lesson does not exist.' };
  const before = await loadLesson(lessonId);
  if (!before) return { ok: false, error: 'That lesson no longer exists. Nothing was changed.' };
  const denied = gate(actor, 'author', before.status === 'published');
  if (denied) return { ok: false, error: denied };

  const title = clean(input?.title, 300);
  if (!title) return { ok: false, error: 'A lesson needs a title. Nothing was changed.' };
  const type = (input?.type === undefined ? before.type : clean(input.type, 30)) || 'text';
  const content = input?.content === undefined ? before.content : (String(input.content || '').trim() || null);
  const mins = input?.durationMins === undefined ? before.durationMins : (Number(input.durationMins) || 0);
  const preview = input?.isPreview === undefined ? before.isPreview : input.isPreview === true;

  // THE LINK IS RESOLVED BEFORE ANYTHING IS WRITTEN. A link we cannot play is refused here, with the
  // reason, rather than stored to render as an empty rectangle in front of every enrolled learner.
  let video: VideoLinkResult | null = null;
  let videoUrl: string | null = before.videoUrl;
  if (input?.videoUrl !== undefined) {
    const raw = String(input.videoUrl || '').trim();
    if (!raw) {
      videoUrl = null;
    } else {
      video = resolveVideoLink(raw, { allowLinkOut: input?.videoOpensElsewhere === true });
      if (!video.ok) {
        return {
          ok: false,
          error: 'Nothing was saved. That video link was refused: ' + video.reason
            + (video.canLinkOut ? ' If it is meant to open in a new tab rather than play here, tick "opens elsewhere" and save again.' : ''),
        };
      }
      videoUrl = video.originalUrl;
    }
  }

  const who = actorId(actor);
  const cols = await presentColumns();
  const trackEditor = cols.has('training_lessons.updated_by_user_id') && who !== null;

  try {
    const rows = await ex(db, 'update:lesson', sql`
      UPDATE training_lessons
         SET title = ${title}, type = ${type}, content = ${content}, video_url = ${videoUrl},
             duration_mins = ${mins}, is_preview = ${preview}, updated_at = NOW()
             ${trackEditor ? sql`, updated_by_user_id = ${who}` : sql``}
       WHERE id = ${lessonId} AND ${versionGuard(input?.version ?? null)}
      RETURNING id`);
    if (!rows.length) {
      const now = await loadLesson(lessonId);
      if (!now) return { ok: false, error: 'Nothing was saved — that lesson was removed while you were editing it.' };
      const whoElse = await lastEditor(db, 'training_lessons', lessonId);
      return { ok: false, error: conflictSentence('lesson', whoElse, iso(now.version)), conflict: { changedBy: whoElse, changedAt: iso(now.version) } };
    }

    let warning = '';
    // THE OTHER SPELLINGS. Separate statement, reported failure, never a lost title.
    if (cols.has('training_lessons.estimated_minutes') || cols.has('training_lessons.preview_allowed')) {
      try {
        await ex(db, 'update:lesson-mirrors', sql`
          UPDATE training_lessons
             SET estimated_minutes = ${mins}, preview_allowed = ${preview}
           WHERE id = ${lessonId}`);
      } catch (e: any) {
        logFail(MOD, 'lesson mirrors', e);
        warning = 'Saved. One thing did not: the second lesson screen keeps the length and the '
          + 'preview flag in its own columns and that write failed ('
          + String(e?.cause?.message || e?.message || 'unknown reason').slice(0, 140)
          + '), so that screen may still show the old values.';
      }
    }

    // The derived player address, through the one module that owns those columns.
    if (input?.videoUrl !== undefined) {
      const persisted = await persistLessonVideo(lessonId, video);
      if (!persisted.derivedStored && persisted.note) warning = warning ? warning + ' ' + persisted.note : persisted.note;
    }
    if (input?.version === null || input?.version === undefined) {
      warning = warning ? warning + ' ' + NO_VERSION_WARNING : NO_VERSION_WARNING;
    }

    await logAudit({
      userId: who,
      action: 'content.lesson.update',
      entity: 'training_lessons',
      entityId: lessonId,
      diff: diffOf(
        { title: before.title, type: before.type, durationMins: before.durationMins, isPreview: before.isPreview, videoUrl: before.videoUrl, contentLength: before.content ? before.content.length : 0 },
        { title, type, durationMins: mins, isPreview: preview, videoUrl, contentLength: content ? content.length : 0 },
      ),
    });
    return {
      ok: true,
      id: lessonId,
      info: 'Lesson saved.' + (before.status === 'published' ? ' It is published, so learners see this change now.' : ''),
      warning: warning || undefined,
    };
  } catch (e: any) {
    logFail(MOD, 'updateLesson', e);
    return { ok: false, error: 'Nothing was saved. Reason: ' + (e?.cause?.message || e?.message || WRITE_FAILED) };
  }
}

/** REORDER LESSONS INSIDE ONE MODULE. Both spellings, whole course renumbered, one transaction. */
export async function reorderLessons(actor: User | null, courseId: string, moduleId: string | null, movedId: string, targetIndex: number): Promise<ContentResult> {
  if (!isUuid(courseId) || !isUuid(movedId)) return { ok: false, error: 'That lesson does not exist.' };
  const course = await loadCourse(courseId);
  if (!course) return { ok: false, error: 'That course no longer exists.' };
  const denied = gate(actor, 'author', course.isPublished);
  if (denied) return { ok: false, error: denied };
  const who = actorId(actor);
  const cols = await presentColumns();

  try {
    return await tx(async (h) => {
      const siblings = (await ex(h, 'select:module-lesson-order', moduleId
        ? sql`SELECT id FROM training_lessons WHERE course_id = ${courseId} AND module_id = ${moduleId} ORDER BY sort_order ASC, created_at ASC`
        : sql`SELECT id FROM training_lessons WHERE course_id = ${courseId} AND module_id IS NULL ORDER BY sort_order ASC, created_at ASC`)
      ).map((r: any) => String(r.id));
      if (!siblings.includes(movedId)) {
        return { ok: false, error: 'Nothing was changed — that lesson is not in that module any more. Reload the page.' };
      }
      const ordered = planReorder(siblings, movedId, targetIndex);
      await applyLessonOrder(h, courseId, ordered, moduleId, cols);
      await logAudit({ userId: who, action: 'content.lesson.reorder', entity: 'training_lessons', entityId: movedId, diff: { from: siblings, to: ordered } });
      return { ok: true, id: movedId, info: 'Order saved. Both the module sequence and the course-wide sequence were renumbered, so every screen shows the same order.' };
    });
  } catch (e: any) {
    logFail(MOD, 'reorderLessons', e);
    return { ok: false, error: 'The order was not changed — nothing was half-applied. Reason: ' + (e?.cause?.message || e?.message || WRITE_FAILED) };
  }
}

/**
 * MOVE A LESSON TO ANOTHER MODULE. The one reorder that crosses a parent, and the reason both source
 * and destination are renumbered in the same transaction.
 */
export async function moveLesson(actor: User | null, lessonId: string, toModuleId: string | null, targetIndex: number): Promise<ContentResult> {
  if (!isUuid(lessonId)) return { ok: false, error: 'That lesson does not exist.' };
  const before = await loadLesson(lessonId);
  if (!before) return { ok: false, error: 'That lesson no longer exists.' };
  const course = await loadCourse(before.courseId);
  const denied = gate(actor, 'author', course?.isPublished === true);
  if (denied) return { ok: false, error: denied };
  if (toModuleId !== null && !isUuid(toModuleId)) return { ok: false, error: 'That module does not exist.' };
  const who = actorId(actor);
  const cols = await presentColumns();

  try {
    return await tx(async (h) => {
      if (toModuleId) {
        const owns = await ex(h, 'select:module-owner', sql`SELECT id FROM training_modules WHERE id = ${toModuleId} AND course_id = ${before.courseId}`);
        if (!owns.length) {
          return { ok: false, error: 'Nothing was moved — that module belongs to a different course. A lesson cannot leave its course this way.' };
        }
      }
      await ex(h, 'update:lesson-module', sql`
        UPDATE training_lessons SET module_id = ${toModuleId}, updated_at = NOW()
          ${cols.has('training_lessons.updated_by_user_id') && who ? sql`, updated_by_user_id = ${who}` : sql``}
         WHERE id = ${lessonId}`);

      const dest = (await ex(h, 'select:module-lesson-order', toModuleId
        ? sql`SELECT id FROM training_lessons WHERE course_id = ${before.courseId} AND module_id = ${toModuleId} ORDER BY sort_order ASC, created_at ASC`
        : sql`SELECT id FROM training_lessons WHERE course_id = ${before.courseId} AND module_id IS NULL ORDER BY sort_order ASC, created_at ASC`)
      ).map((r: any) => String(r.id));
      const ordered = planReorder(dest, lessonId, targetIndex);
      await applyLessonOrder(h, before.courseId, ordered, toModuleId, cols);

      await logAudit({
        userId: who,
        action: 'content.lesson.move',
        entity: 'training_lessons',
        entityId: lessonId,
        diff: { from: { moduleId: before.moduleId }, to: { moduleId: toModuleId, position: ordered.indexOf(lessonId) } },
      });
      return {
        ok: true,
        id: lessonId,
        info: 'Lesson moved. Nobody’s progress on it changed — a completion records that a person '
          + 'did this lesson, not where in the course it sat that day.',
      };
    });
  } catch (e: any) {
    logFail(MOD, 'moveLesson', e);
    return { ok: false, error: 'The lesson was not moved — nothing was half-applied. Reason: ' + (e?.cause?.message || e?.message || WRITE_FAILED) };
  }
}

/** Write order_in_module for the given module's lessons, then the course-wide sort_order for all. */
async function applyLessonOrder(h: any, courseId: string, orderedIds: string[], moduleId: string | null, cols: Set<string>): Promise<void> {
  if (cols.has('training_lessons.order_in_module')) {
    for (const p of renumber(orderedIds)) {
      await ex(h, 'update:lesson-order', sql`UPDATE training_lessons SET order_in_module = ${p.position}, updated_at = NOW() WHERE id = ${p.id}`);
    }
  }
  const moduleIds = (await ex(h, 'select:modules-order', sql`
    SELECT id FROM training_modules WHERE course_id = ${courseId} ORDER BY sort_order ASC, created_at ASC`))
    .map((r: any) => String(r.id));
  const lessons = (await ex(h, 'select:lessons-order', sql`
    SELECT id, module_id FROM training_lessons WHERE course_id = ${courseId} ORDER BY sort_order ASC, created_at ASC`))
    .map((r: any) => ({ id: String(r.id), moduleId: r.module_id ? String(r.module_id) : null }));
  // The module being reordered uses the order we were just given, not the order the table still has.
  // planCourseOrder groups by module, so only the RELATIVE order of the lessons inside each module
  // matters here — built explicitly rather than left to a comparator that returns 0 for most pairs.
  const byId = new Map(lessons.map((l) => [l.id, l]));
  const moved = orderedIds.map((id) => byId.get(id)).filter((l): l is { id: string; moduleId: string | null } => !!l);
  const movedIds = new Set(moved.map((l) => l.id));
  const ranked = lessons.filter((l) => !movedIds.has(l.id)).concat(moved);
  const plan = planCourseOrder(moduleIds.map((id) => ({ id })), ranked);
  for (const p of plan) {
    await ex(h, 'update:lesson-order', sql`
      UPDATE training_lessons SET sort_order = ${p.sortOrder}, updated_at = NOW()
        ${cols.has('training_lessons.order_in_module') ? sql`, order_in_module = ${p.orderInModule}` : sql``}
       WHERE id = ${p.lessonId}`);
  }
}

/** DUPLICATE A LESSON WITH ITS BLOCKS, AND WITH NOBODY'S PROGRESS. */
export async function duplicateLesson(actor: User | null, lessonId: string): Promise<ContentResult> {
  if (!isUuid(lessonId)) return { ok: false, error: 'That lesson does not exist.' };
  const src = await loadLesson(lessonId);
  if (!src) return { ok: false, error: 'That lesson no longer exists.' };
  const course = await loadCourse(src.courseId);
  const denied = gate(actor, 'author', course?.isPublished === true);
  if (denied) return { ok: false, error: denied };
  const who = actorId(actor);
  const cols = await presentColumns();

  try {
    return await tx(async (h) => {
      const row = lessonCopyRow(
        {
          courseId: src.courseId, moduleId: src.moduleId, title: src.title, slug: src.slug,
          type: src.type, content: src.content, videoUrl: src.videoUrl, durationMins: src.durationMins,
        },
        Date.now(),
      );
      const newId = await insertLessonCopy(h, row, cols);
      const blocks = await copyBlocks(h, lessonId, newId);
      await logAudit({
        userId: who,
        action: 'content.lesson.duplicate',
        entity: 'training_lessons',
        entityId: newId,
        diff: { from: { lessonId, title: src.title }, to: { lessonId: newId, title: row.title, blocksCopied: blocks } },
      });
      return {
        ok: true,
        id: newId,
        info: 'Lesson copied as "' + row.title + '" with ' + blocks + ' blocks. It is a draft and is '
          + 'not previewable, and it carries no completion, progress row or quiz attempt from the '
          + 'original — a copy that arrived already finished for everybody would be worse than no copy at all.',
      };
    });
  } catch (e: any) {
    logFail(MOD, 'duplicateLesson', e);
    return { ok: false, error: 'Nothing was copied. Reason: ' + (e?.cause?.message || e?.message || WRITE_FAILED) };
  }
}

async function insertLessonCopy(h: any, row: ReturnType<typeof lessonCopyRow>, cols: Set<string>): Promise<string> {
  const made = await ex(h, 'insert:lesson-copy', sql`
    INSERT INTO training_lessons (course_id, module_id, title, slug, type, content, video_url, duration_mins, is_preview, sort_order)
    SELECT ${row.courseId}, ${row.moduleId}, ${row.title}, ${row.slug}, ${row.type}, ${row.content},
           ${row.videoUrl}, ${row.durationMins}, false, COALESCE(MAX(sort_order), -1) + 1
      FROM training_lessons WHERE course_id = ${row.courseId}
    RETURNING id`);
  const newId = String((made[0] as any)?.id || '');
  if (!newId) throw new Error('The copied lesson did not come back with an id.');
  // A copy must be a DRAFT wherever this database records that. Written separately because `status`
  // is an additive column that not every database has.
  if (cols.has('training_lessons.status')) {
    await ex(h, 'update:lesson-copy-draft', sql`
      UPDATE training_lessons SET status = 'draft'
        ${cols.has('training_lessons.published_at') ? sql`, published_at = NULL` : sql``}
        ${cols.has('training_lessons.preview_allowed') ? sql`, preview_allowed = false` : sql``}
       WHERE id = ${newId}`);
  }
  return newId;
}

/** Blocks are copied wholesale by the database; nothing about a person is in that table. */
async function copyBlocks(h: any, fromLessonId: string, toLessonId: string): Promise<number> {
  const made = await ex(h, 'insert:block-copy', sql`
    INSERT INTO training_lesson_blocks (lesson_id, kind, position, content)
    SELECT ${toLessonId}, kind, position, content FROM training_lesson_blocks WHERE lesson_id = ${fromLessonId}
    RETURNING id`);
  return made.length;
}

/** ARCHIVE A LESSON: marked, and put back to draft, which is what actually stops it being taught. */
export async function archiveLesson(actor: User | null, lessonId: string, archived: boolean): Promise<ContentResult> {
  if (!isUuid(lessonId)) return { ok: false, error: 'That lesson does not exist.' };
  const src = await loadLesson(lessonId);
  if (!src) return { ok: false, error: 'That lesson no longer exists.' };
  const denied = gate(actor, 'publish', src.status === 'published');
  if (denied) return { ok: false, error: denied };
  const who = actorId(actor);
  const cols = await presentColumns();
  if (!cols.has('training_lessons.archived_at')) {
    return { ok: false, error: 'Nothing was changed. This database does not have the archive column yet, and we will not offer a delete in its place.' };
  }
  const hasStatus = cols.has('training_lessons.status');

  try {
    const rows = archived
      ? await ex(db, 'update:lesson-archive', sql`
          UPDATE training_lessons SET archived_at = NOW(), archived_by_user_id = ${who}, is_preview = false, updated_at = NOW()
            ${hasStatus ? sql`, status = 'draft'` : sql``}
           WHERE id = ${lessonId} RETURNING id`)
      : await ex(db, 'update:lesson-unarchive', sql`
          UPDATE training_lessons SET archived_at = NULL, archived_by_user_id = NULL, updated_at = NOW()
           WHERE id = ${lessonId} RETURNING id`);
    if (!rows.length) return { ok: false, error: 'Nothing was changed — that lesson no longer exists.' };
    await logAudit({ userId: who, action: archived ? 'content.lesson.archive' : 'content.lesson.restore', entity: 'training_lessons', entityId: lessonId, diff: { from: { archivedAt: src.archivedAt, status: src.status }, to: { archived } } });
    return {
      ok: true,
      id: lessonId,
      info: archived
        ? 'Lesson archived and put back to draft, so it stops being taught. Every completion, '
          + 'progress row and quiz attempt against it is exactly as it was.'
        : 'Lesson taken out of the archive as a DRAFT. Publish it when it should teach again.',
    };
  } catch (e: any) {
    logFail(MOD, 'archiveLesson', e);
    return { ok: false, error: 'Nothing was changed. Reason: ' + (e?.cause?.message || e?.message || WRITE_FAILED) };
  }
}

/** DELETE A LESSON — refused while one person has read it, started it, answered it or finished it. */
export async function deleteLesson(actor: User | null, lessonId: string): Promise<ContentResult> {
  if (!isUuid(lessonId)) return { ok: false, error: 'That lesson does not exist.' };
  const src = await loadLesson(lessonId);
  if (!src) return { ok: false, error: 'That lesson no longer exists.' };
  const denied = gate(actor, 'manage', src.status === 'published');
  if (denied) return { ok: false, error: denied };
  const who = actorId(actor);

  let deps: DependentCount[];
  try {
    deps = await countDependents('lesson', lessonId);
  } catch (e: any) {
    logFail(MOD, 'countDependents:lesson', e);
    return { ok: false, error: 'Nothing was deleted. We could not check whether anybody has used this lesson (' + String(e?.cause?.message || e?.message || 'unknown reason').slice(0, 140) + '). Archive it instead.' };
  }
  if (totalDependents(deps) > 0) {
    await logAudit({ userId: who, action: 'content.lesson.delete.refused', entity: 'training_lessons', entityId: lessonId, diff: { dependents: deps } });
    return { ok: false, error: refusalSentence('lesson', deps), dependents: deps };
  }
  if (src.status === 'published') {
    return { ok: false, error: 'Nothing was deleted. This lesson is published. Unpublish or archive it first.' };
  }

  try {
    const rows = await ex(db, 'delete:lesson', sql`DELETE FROM training_lessons WHERE id = ${lessonId} RETURNING id`);
    if (!rows.length) return { ok: false, error: 'Nothing was deleted — that lesson had already gone.' };
    await ex(db, 'update:course-lesson-count', sql`
      UPDATE training_courses SET total_lessons = (SELECT COUNT(*) FROM training_lessons WHERE course_id = ${src.courseId})
       WHERE id = ${src.courseId}`);
    await logAudit({ userId: who, action: 'content.lesson.delete', entity: 'training_lessons', entityId: lessonId, diff: { from: { title: src.title, courseId: src.courseId, moduleId: src.moduleId }, to: null } });
    return { ok: true, id: lessonId, info: 'Lesson deleted. Nobody had started it, finished it, answered a question in it or written under it.' };
  } catch (e: any) {
    logFail(MOD, 'deleteLesson', e);
    return { ok: false, error: 'Nothing was deleted. Reason: ' + (e?.cause?.message || e?.message || WRITE_FAILED) };
  }
}

// =================================================================================================
// AUDIT SHAPE. Before and after, per field that actually changed — a diff that lists twenty
// unchanged fields is a diff nobody reads.
// =================================================================================================

export function diffOf(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown> {
  const from: Record<string, unknown> = {};
  const to: Record<string, unknown> = {};
  for (const k of Object.keys(after)) {
    if (JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)) {
      from[k] = before[k] ?? null;
      to[k] = after[k] ?? null;
    }
  }
  return { from, to };
}
