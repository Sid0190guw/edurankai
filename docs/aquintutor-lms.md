# The AquinTutor LMS spine (L1–L6)

What a course needed to stop being a lesson player and start being a course somebody is taught:
work that is set, submitted, marked, released, rolled up, and recorded. This document is the map,
including the parts that are deliberately not built.

## Where the code is

| Module | What it owns |
| --- | --- |
| `src/lib/lms/policy.ts` | **All the arithmetic, pure.** Lateness, late penalty, submission state, letter scale, weighted roll-up, GPA, rubric totals, release gating. No database, no clock of its own — every function that needs "now" is handed one. 71 tests in `policy.test.ts` and `interop.test.ts`. |
| `src/lib/lms/schema.ts` | Every `CREATE TABLE`, self-bootstrapping at first use, additive only. Same pattern as `enrolment.ts` and `aquintutor-authoring.ts`. |
| `src/lib/lms/access.ts` | Who may teach, grade or administer a course. Four sources of a teaching claim, resolved server-side from the session user. |
| `src/lib/lms/assignments.ts` | L1 — authoring, the learner board, drafts, submitting. |
| `src/lib/lms/gradebook.ts` | L2 — grading queue, rubric grading, roll-up, matrix, final grades. |
| `src/lib/lms/sections.ts` | L3 — terms, sections, rosters. |
| `src/lib/lms/course-home.ts` | L4 — announcements, syllabus, discussion, scheduled release. |
| `src/lib/lms/transcript.ts` | L5 — the academic record. |
| `src/lib/lms/interop.ts` | L6 — xAPI store, SCORM manifest parsing, roster CSV in, grades CSV out. |
| `src/lib/lms/notify.ts` | Grade released, announcement posted, deadline approaching. Through `edu-notify.ts`, honouring existing opt-outs. |

Built on `training_courses`. **Not a new course table** — there were already three content models
(see the essay at the top of `src/lib/learning-object.ts`) and a fourth would have produced a
gradebook grading courses nobody is enrolled in.

## Surfaces

**Learner**

- `/aquintutor/assignments` — the board by state
- `/aquintutor/assignments/[id]` — brief, rubric, attempts, grade, submit form
- `/aquintutor/homework` — what is due, soonest first, plus instructor announcements
- `/aquintutor/grades` — per-course standing, weighted, released grades only
- `/aquintutor/transcript` — the academic record
- `/aquintutor/course/[id]` — course home: announcements, syllabus, coursework, discussion

**Teaching**

- `/aquintutor/admin/lms` — console, scoped to courses you actually teach
- `/aquintutor/admin/lms/assignments` — set work, late policy, rubric, publish
- `/aquintutor/admin/lms/grade` — the queue, oldest first; save, release, return
- `/aquintutor/admin/lms/gradebook` — matrix, categories, letter scale, rubrics, CSV, final grades
- `/aquintutor/admin/lms/sections` — terms, sections, rosters, paste-in import
- `/aquintutor/admin/lms/course-home` — announcements, syllabus, release rules, moderation
- `/aquintutor/admin/lms/interop` — SCORM manifest import, xAPI statement log

**Routes**

- `GET /api/aquintutor/lms/export` — grade CSV, gated by the same teaching claim as the gradebook
- `POST|GET /api/aquintutor/lms/xapi` — statement endpoint; session or API key, never anonymous
- `GET|POST /api/cron/lms-reminders` — daily deadline reminders, `CRON_SECRET`, idempotent

## The five rules the whole thing hangs on

1. **Saved is not released.** A grade row exists the moment a grader saves it; the learner sees it
   only when `posted` is true. Every learner-side read filters on it.
2. **Lateness is frozen at submit time.** `lms_submissions.days_late` is decided when the work
   lands, never recomputed. Extending a deadline afterwards cannot retroactively make somebody late,
   and a grader opening a submission a fortnight later applies exactly the penalty the learner was
   warned about *before* they pressed submit.
3. **An ungraded category is unknown, not zero.** An early-term learner sees "92% on what is graded
   so far" with the ungraded weight named, not "18% overall" from an empty final exam.
4. **A course in progress has no grade.** It appears on the transcript, labelled, and is excluded
   from the GPA. A posted final grade is frozen and never recomputed on read.
5. **Submissions are links or typed text, never uploads.** Work stays in the learner's own drive
   with open link access; the platform stores the URL. There is no file column to write to, and
   `normaliseLinks()` rejects anything that is not `http(s)` — a `javascript:` "link" rendered into a
   grading screen is stored XSS.

## What is deliberately not built

- **A SCORM run-time.** The manifest import reads `imsmanifest.xml` into modules and lessons whose
  content is the launch link. It is not an RTE: a package served from another origin cannot reach a
  `window.API` object on our page — browsers forbid that across origins — so claiming `cmi.core`
  tracking would be claiming something that cannot work. Imported items track like any other lesson.
- **A conformant LRS.** The xAPI endpoint stores, shreds and reports statements. No statement
  signing, no attachments, no activity-state document API, and no conformance claim.
- **Account creation from a roster paste.** People with no account here are reported back by email.
  Inviting somebody is a different act with different consent.
- **Plagiarism detection and peer review.** `lms_assignments.peer_review_count` exists on the row and
  nothing reads it yet. It is a column, not a feature — do not describe it as one.
- **Anonymous grading and moderated grading (two markers, reconciled).** Neither is modelled.

## Verifying it in production

The schema bootstraps on first use — there is no migration to run. Load
`/aquintutor/admin/lms`, create an assignment, publish it, and it appears on the enrolled learner's
`/aquintutor/assignments`. `/api/health` reports whether `lms_assignments` has bootstrapped
(`BOOTSTRAP_MODULES` in `src/lib/observability-health.ts`).
