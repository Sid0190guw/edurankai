// src/lib/eims-anomaly.ts — THE ADVISORY LAYER. IT POINTS. IT NEVER DECIDES.
//
// =================================================================================================
// READ THIS BEFORE CHANGING A SINGLE WORD IN THIS FILE
// =================================================================================================
//
// EVERY SENTENCE PRODUCED HERE IS SHOWN TO A HUMAN ABOUT A STUDENT. A false positive is not a
// nuisance in this domain: it is an accusation against somebody at the start of their career, made
// by a system they cannot argue with, on a record a university may read. So the wording carries the
// doubt, always, and the conclusion is fixed:
//
//     "Potential discrepancy detected, mentor review required."
//
// THAT IS THE ONLY CONCLUSION THIS MODULE CAN REACH. It is a module-level constant, exported so no
// screen writes its own version, and there is no second sentence, no severity word, no "likely", no
// "suspicious", no "fraud", no score, and no place to add one. When several signals fire, the
// conclusion does not get stronger — it is the same sentence, and only the list of things to look at
// is longer.
//
// =================================================================================================
// WHAT THIS MODULE CANNOT DO, BY CONSTRUCTION AND NOT BY POLICY
// =================================================================================================
//
//   - IT WRITES NOTHING. There is no INSERT, no UPDATE and no table in this file. A finding cannot
//     be stored, so it cannot become a record about a person, cannot be counted, cannot be trended,
//     and cannot appear on a document. It is computed when a mentor opens their screen and it is
//     gone when they close it.
//   - IT CHANGES NO NUMBER. It cannot reduce a reported hour, refuse a verification, or move an
//     activity. It has no import that could: the only things it reads are readers.
//   - IT BLOCKS NOTHING. There is no gate anywhere in this codebase that consults it.
//   - IT NOTIFIES NOBODY. Not the intern, not HR, not the founder, and not — deliberately — even the
//     mentor. A notification is a push into somebody's day about somebody else's honesty; a mentor
//     who opens the queue they already open every morning sees it in the context of the actual work.
//     There is no notify() import in this file and adding one would be a policy change, not a
//     mechanism change.
//   - IT LABELS NOBODY. There is no vocabulary here for a person at all: every observation is about
//     a NUMBER or a DATE, and the subject of every sentence is the record, never the student.
//   - IT WATCHES NOBODY. No webcam, no screenshot, no keystroke, no location, no idle timer, and no
//     seam where one could be switched on. Everything below is computed from work somebody recorded
//     on purpose.
//
// =================================================================================================
// A SIGNAL BUILT ON AN UNREAD SOURCE IS AN ACCUSATION BUILT ON NOTHING
// =================================================================================================
//
// The single most dangerous failure available to this file is to read zero evidence rows because the
// evidence table could not be read, and then report "large hours claimed against little evidence".
// So every signal declares the sources it needs, and a signal whose source could not be read DOES
// NOT FIRE — the source is named in `unread` instead, and the mentor is told the check could not be
// run. Silence from this module means "nothing to point at OR nothing could be read", and the
// difference is always stated.
//
// =================================================================================================
// THE SIX SIGNALS, AND WHAT EACH ONE HONESTLY MEANS
// =================================================================================================
//
// Each is stated with the innocent explanation attached, because the innocent explanation is usually
// the true one and a mentor reading these needs it in front of them:
//
//   1. HOURS WITHOUT EVIDENCE  — hours reported on activities that REQUIRE evidence, with little or
//      no evidence filed in the same period. Usually: the work happened and the links were not filed
//      yet, or were filed against a different period.
//   2. REPEATED IDENTICAL SUBMISSION — the same link filed more than once, or the same title with
//      the same hours on different days. Usually: a resubmission after a revision request, or one
//      artefact that genuinely covers several days of work.
//   3. DORMANT THEN BULK — a long gap with nothing recorded, then a great deal recorded at once.
//      Usually: exams, illness, or somebody catching up on paperwork for work that really happened.
//   4. COMPLETED WITHOUT REQUIRED EVIDENCE — an activity marked complete whose type requires
//      evidence, with none attached. Usually: the status was moved before the link was filed.
//   5. WORKLOAD WITHOUT RECORDED PROJECT ACTIVITY — project hours reported while nothing recorded
//      moved on any project. Usually: the project is tracked somewhere this platform cannot see,
//      which is a gap in the record and not a fact about the person.
//   6. REPEATED MISSED DEADLINES — several activities past their deadline and still open. Usually:
//      over-allocation, which is a failure of planning rather than of the intern — and the ceiling
//      exists precisely to make that visible.
//
// =================================================================================================
// THRESHOLDS ARE EXPORTED SO THE SCREEN CAN SAY WHAT THEY ARE
// =================================================================================================
//
// A person shown a flag is entitled to know the rule that produced it. Every threshold is a named,
// exported constant and every observation quotes the numbers that met it, so a mentor can see the
// arithmetic rather than trust it. Nothing here is a model, nothing here learns, and nothing here
// has an opinion that cannot be read off the page.

import {
  readActivitiesInRange,
  type ActivityRow,
} from '@/lib/eims-activity';
import {
  listEvidenceForEmployee,
  type EvidenceRow,
} from '@/lib/eims-evidence';
// The db handle is resolved LAZILY. Importing it at module scope makes src/lib/db throw
// DATABASE_URL is not set the moment ANY importer loads, which put the credit arithmetic — pure
// functions with no database in them — permanently out of reach of a test. A calculation that
// decides somebody academic credit should be provable without a production connection.
let _db: any = null;
async function database(): Promise<any> {
  if (!_db) _db = (await import('@/lib/db')).db;
  return _db;
}
import { sql } from 'drizzle-orm';
import { isoDate } from '@/lib/credit-week';

// -------------------------------------------------------------------------------------------------
// MODULE CONSTANTS — every one declared ABOVE the function that reads it. `const` is not hoisted.
// -------------------------------------------------------------------------------------------------

/** postgres-js resolves to a PLAIN ARRAY, never { rows }. */
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** The real Postgres reason is on e.cause; e.message is only the SQL that failed. */
const logFail = (tag: string, e: any) =>
  console.error('[eims-anomaly] ' + tag, e?.cause?.message || e?.message);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v: unknown): v is string => typeof v === 'string' && DATE_RE.test(v);

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * THE ONLY CONCLUSION THIS MODULE CAN REACH. One sentence, for a mentor, whatever fired and however
 * much of it fired. Exported so that no screen writes a variant of it, and so that a search for the
 * wording finds exactly one definition.
 */
export const MENTOR_SENTENCE = 'Potential discrepancy detected, mentor review required.';

/** What the sentence is NOT, said out loud where a screen can print it under the sentence. */
export const NOT_A_FINDING_SENTENCE =
  'This is a prompt to look, not a finding about a person. Nothing has been decided, no hours have '
  + 'changed, no record has been marked, and nobody else has been told. The usual explanation is the '
  + 'ordinary one, and a mentor is the only person who can tell.';

export const ADVISORY_SENTENCE =
  'These observations are advisory. They never label anybody, never block anything, never reduce an '
  + 'hour and never reach anyone but the mentor reading this screen. A human decides.';

// ---- THRESHOLDS. Named, exported, and quoted in the sentence they produce. -----------------------

/** Below this many reported hours in the window, nothing about hours-versus-evidence is worth saying. */
export const HOURS_FLOOR = 12;
/** Hours per piece of evidence above which the ratio is worth a look. */
export const HOURS_PER_EVIDENCE = 20;
/** Two or more filings of the same link, or the same title at the same hours, in the window. */
export const DUPLICATE_MIN = 2;
/** Days with nothing recorded at all that count as dormant. */
export const DORMANT_DAYS = 10;
/** Items filed on a single day that count as a bulk submission. */
export const BULK_ITEMS = 4;
/** Hours reported on a single day that count as a bulk submission. */
export const BULK_HOURS = 14;
/** Activities past their deadline and still open, in the window, that count as repeated. */
export const MISSED_DEADLINE_MIN = 3;
/** Project hours in the window above which the absence of any recorded project movement is worth a look. */
export const PROJECT_HOURS_FLOOR = 15;
/** How many days back the review looks by default. */
export const DEFAULT_WINDOW_DAYS = 28;

/** Activity type keys treated as project work. Matched loosely, because taxonomies are configurable. */
const PROJECT_TYPE_HINT = /(project|engineering|build|develop|deliver)/i;

// -------------------------------------------------------------------------------------------------
// THE SIGNAL
// -------------------------------------------------------------------------------------------------

export const SIGNAL_KEYS = [
  'hours-without-evidence',
  'repeated-identical-submission',
  'dormant-then-bulk',
  'completed-without-required-evidence',
  'workload-without-recorded-project-activity',
  'repeated-missed-deadlines',
] as const;
export type SignalKey = (typeof SIGNAL_KEYS)[number];

export interface AnomalySignal {
  key: SignalKey;
  /** A neutral name for the pattern. It names the PATTERN, never the person. */
  label: string;
  /**
   * What was observed, in numbers and dates only. No adjective about anybody, no verb that anybody
   * is the subject of. This is the arithmetic, written out so a mentor can check it.
   */
  observation: string;
  /** The ordinary explanation, stated first-class so it is read alongside the observation. */
  ordinaryExplanation: string;
  /** What a mentor might usefully look at. A suggestion, never an instruction and never a verdict. */
  lookAt: string;
}

const LABELS: Record<SignalKey, string> = {
  'hours-without-evidence': 'Hours reported with little evidence filed',
  'repeated-identical-submission': 'The same submission more than once',
  'dormant-then-bulk': 'A quiet period followed by a large single filing',
  'completed-without-required-evidence': 'Completed with evidence still required',
  'workload-without-recorded-project-activity': 'Project hours with no recorded project movement',
  'repeated-missed-deadlines': 'Several deadlines passed with work still open',
};

// -------------------------------------------------------------------------------------------------
// THE PURE DETECTOR
// -------------------------------------------------------------------------------------------------

export interface AnomalyActivity {
  id: string;
  title: string;
  typeKey: string;
  status: string;
  closed: boolean;
  deadline: string | null;
  allocatedHours: number | null;
  reportedHours: number | null;
  verifiedHours: number | null;
  reportedAt: string | null;
  evidenceRequirement: string;
}

export interface AnomalyEvidence {
  id: string;
  url: string;
  title: string;
  occurredOn: string;
  submittedAt: string | null;
  hoursClaimed: number;
  /** Activity ids this item supports. Empty where it supports something without an id. */
  activityIds: string[];
}

export interface AnomalyInput {
  fromIso: string;
  toIso: string;
  todayIso: string;
  activities: AnomalyActivity[];
  evidence: AnomalyEvidence[];
  /**
   * How many project items (deliverables, milestones) recorded movement in the window. NULL means
   * "could not be read", and the project signal does not fire on a null. Zero means "read, and
   * nothing moved" — a different fact entirely.
   */
  projectMovements: number | null;
}

const dayOf = (stamp: string | null | undefined): string => {
  const s = String(stamp || '');
  return s.length >= 10 ? s.slice(0, 10) : '';
};

const daysBetween = (a: string, b: string): number => {
  const ms = Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z');
  return Number.isFinite(ms) ? Math.round(ms / 86400000) : 0;
};

/** A URL compared for sameness: scheme, case and trailing slash removed, query kept. */
const normaliseUrl = (u: string): string =>
  String(u || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/**
 * THE WHOLE OF THE DETECTION, AND IT IS PURE.
 *
 * Pure so that it can be tested exhaustively against hand-built cases — which matters more here than
 * anywhere else in this codebase, because the cost of a wrong answer is a sentence about a student.
 * It reads no database, has no clock of its own, and returns the same output for the same input
 * forever.
 *
 * IT RETURNS SIGNALS, NOT A JUDGEMENT. There is no total, no score, no ranking and no threshold at
 * which the module says something stronger. reviewFor() below attaches the one sentence, unchanged,
 * whether one signal fired or all six.
 */
export function detectAnomalies(input: AnomalyInput): AnomalySignal[] {
  const out: AnomalySignal[] = [];
  const activities = Array.isArray(input?.activities) ? input.activities : [];
  const evidence = Array.isArray(input?.evidence) ? input.evidence : [];
  const from = String(input?.fromIso || '');
  const to = String(input?.toIso || '');
  const period = from && to ? from + ' to ' + to : 'the period reviewed';

  const open = activities.filter((a) => !a.closed);

  // ---- 1. HOURS WITHOUT EVIDENCE ----------------------------------------------------------------
  // Only activities whose type REQUIRES evidence are counted. Reporting hours on an activity whose
  // configuration says evidence is optional and then filing none is exactly what the configuration
  // permits, and flagging it would be flagging somebody for following the rules.
  const requiring = open.filter((a) => a.evidenceRequirement === 'required');
  const hoursRequiringEvidence = round2(requiring.reduce((s, a) => s + (a.reportedHours || 0), 0));
  const evidenceCount = evidence.length;
  if (hoursRequiringEvidence >= HOURS_FLOOR) {
    const ratio = evidenceCount === 0 ? Infinity : round2(hoursRequiringEvidence / evidenceCount);
    if (ratio > HOURS_PER_EVIDENCE) {
      out.push({
        key: 'hours-without-evidence',
        label: LABELS['hours-without-evidence'],
        observation: hoursRequiringEvidence + ' ' + plural(hoursRequiringEvidence, 'hour', 'hours')
          + ' reported over ' + period + ' on ' + requiring.length + ' '
          + plural(requiring.length, 'activity', 'activities') + ' whose type requires evidence, with '
          + (evidenceCount === 0
            ? 'no evidence filed in that period at all'
            : evidenceCount + ' ' + plural(evidenceCount, 'item', 'items') + ' of evidence filed, which is '
              + ratio + ' hours per item')
          + '. The threshold for saying so is more than ' + HOURS_PER_EVIDENCE + ' hours per item, '
          + 'above ' + HOURS_FLOOR + ' hours total.',
        ordinaryExplanation: 'The most common reason by far is that the work happened and the links '
          + 'have not been filed yet, or were filed against a different date. Reported hours are kept '
          + 'as reported whatever happens here.',
        lookAt: 'Ask what the work was and where it lives. If it exists and is simply unlinked, the '
          + 'fix is a link, not a decision.',
      });
    }
  }

  // ---- 2. REPEATED IDENTICAL SUBMISSION ---------------------------------------------------------
  const byUrl = new Map<string, AnomalyEvidence[]>();
  const bySignature = new Map<string, AnomalyEvidence[]>();
  for (const e of evidence) {
    const u = normaliseUrl(e.url);
    if (u) {
      const list = byUrl.get(u) || [];
      list.push(e);
      byUrl.set(u, list);
    }
    const sig = String(e.title || '').trim().toLowerCase() + '|' + round2(e.hoursClaimed || 0);
    if (sig.length > 1) {
      const list = bySignature.get(sig) || [];
      list.push(e);
      bySignature.set(sig, list);
    }
  }
  const repeatedUrls = Array.from(byUrl.entries()).filter(([, list]) => list.length >= DUPLICATE_MIN);
  const repeatedTitles = Array.from(bySignature.entries()).filter(([, list]) => {
    if (list.length < DUPLICATE_MIN) return false;
    // Only when they are on DIFFERENT days: two items filed for the same day with the same title are
    // ordinary, and the same URL case is already covered above.
    const days = new Set(list.map((e) => e.occurredOn));
    const urls = new Set(list.map((e) => normaliseUrl(e.url)));
    return days.size > 1 && urls.size > 1;
  });
  if (repeatedUrls.length || repeatedTitles.length) {
    const parts: string[] = [];
    if (repeatedUrls.length) {
      const worst = repeatedUrls.slice().sort((a, b) => b[1].length - a[1].length)[0];
      parts.push(repeatedUrls.length + ' ' + plural(repeatedUrls.length, 'link', 'links')
        + ' filed more than once (one of them ' + worst[1].length + ' times, on '
        + Array.from(new Set(worst[1].map((e) => e.occurredOn))).sort().join(', ') + ')');
    }
    if (repeatedTitles.length) {
      parts.push(repeatedTitles.length + ' '
        + plural(repeatedTitles.length, 'submission', 'submissions')
        + ' carrying the same title and the same claimed hours on different days');
    }
    out.push({
      key: 'repeated-identical-submission',
      label: LABELS['repeated-identical-submission'],
      observation: 'Over ' + period + ': ' + parts.join('; ') + '.',
      ordinaryExplanation: 'One artefact often genuinely covers several days of work, and a link is '
        + 'legitimately refiled after a revision request. Neither is a duplicate in any meaningful '
        + 'sense.',
      lookAt: 'Whether the same hours are being claimed twice for the same work, or one piece of '
        + 'work is being pointed at from several days.',
    });
  }

  // ---- 3. DORMANT THEN BULK ---------------------------------------------------------------------
  // Built from the days something was RECORDED — evidence filed, effort reported — rather than from
  // days worked, because this module cannot and must not know when anybody was working.
  const recordDays = new Map<string, { items: number; hours: number }>();
  for (const e of evidence) {
    const d = dayOf(e.submittedAt) || e.occurredOn;
    if (!isDate(d)) continue;
    const slot = recordDays.get(d) || { items: 0, hours: 0 };
    slot.items += 1;
    slot.hours = round2(slot.hours + (e.hoursClaimed || 0));
    recordDays.set(d, slot);
  }
  for (const a of open) {
    const d = dayOf(a.reportedAt);
    if (!isDate(d) || !a.reportedHours) continue;
    const slot = recordDays.get(d) || { items: 0, hours: 0 };
    slot.items += 1;
    slot.hours = round2(slot.hours + a.reportedHours);
    recordDays.set(d, slot);
  }
  const sortedDays = Array.from(recordDays.keys()).sort();
  // THE LOOP STARTS AT THE SECOND RECORDED DAY, AND THAT IS THE WHOLE CORRECTNESS OF THIS SIGNAL.
  //
  // Measuring the first gap from the START OF THE WINDOW instead flags a pattern the window created:
  // a review that looks back four weeks over somebody who filed nothing in the first ten days — an
  // exam fortnight, a late start, a holiday, or simply a window that opens mid-quiet — reports "a
  // long silence, then a bulk" about a person who has done nothing unusual at all. It fired on the
  // most ordinary fixture there is the first time this was run.
  //
  // A quiet period is only observable BETWEEN two things somebody recorded. Where there is nothing
  // before the silence, this module has not seen a silence; it has seen the edge of its own window,
  // and it says nothing.
  for (let i = 1; i < sortedDays.length; i++) {
    const day = sortedDays[i];
    const previous = sortedDays[i - 1];
    const gap = isDate(previous) && isDate(day) ? daysBetween(previous, day) : 0;
    const slot = recordDays.get(day)!;
    if (gap >= DORMANT_DAYS && (slot.items >= BULK_ITEMS || slot.hours >= BULK_HOURS)) {
      out.push({
        key: 'dormant-then-bulk',
        label: LABELS['dormant-then-bulk'],
        observation: 'Nothing was recorded between ' + previous + ' and ' + day + ' — a gap of '
          + gap + ' days — and then on ' + day + ', ' + slot.items + ' '
          + plural(slot.items, 'item', 'items') + ' totalling ' + slot.hours + ' '
          + plural(slot.hours, 'hour', 'hours') + ' were recorded at once. The thresholds for saying '
          + 'so are a gap of ' + DORMANT_DAYS + ' days followed by ' + BULK_ITEMS + ' items or '
          + BULK_HOURS + ' hours in one day.',
        ordinaryExplanation: 'Interns are university students. Examinations, illness and a term '
          + 'timetable all produce exactly this shape, and so does somebody sitting down to file a '
          + 'fortnight of paperwork for work that really happened.',
        lookAt: 'Whether the dates the work is recorded AGAINST are spread across the quiet period. '
          + 'Filing late is not the same as working late, and neither is a fault.',
      });
      break; // One sentence per pattern. A list of every gap would read as a case being built.
    }
  }

  // ---- 4. COMPLETED WITHOUT REQUIRED EVIDENCE ---------------------------------------------------
  const evidencedActivityIds = new Set<string>();
  for (const e of evidence) {
    for (const id of e.activityIds || []) if (id) evidencedActivityIds.add(String(id));
  }
  const completedUnevidenced = open.filter((a) =>
    (a.status === 'completed' || a.status === 'approved' || a.status === 'under_review')
    && a.evidenceRequirement === 'required'
    && !evidencedActivityIds.has(a.id));
  if (completedUnevidenced.length > 0) {
    out.push({
      key: 'completed-without-required-evidence',
      label: LABELS['completed-without-required-evidence'],
      observation: completedUnevidenced.length + ' '
        + plural(completedUnevidenced.length, 'activity', 'activities')
        + ' in ' + period + ' ' + plural(completedUnevidenced.length, 'is', 'are')
        + ' marked as finished and ' + plural(completedUnevidenced.length, 'requires', 'require')
        + ' evidence, with none attached: '
        + completedUnevidenced.slice(0, 5).map((a) => a.title).join('; ')
        + (completedUnevidenced.length > 5 ? '; and ' + (completedUnevidenced.length - 5) + ' more' : '')
        + '.',
      ordinaryExplanation: 'The status is usually moved when the work finishes and the link is filed '
        + 'afterwards. Nothing has been recognised on these hours either way — verification is what '
        + 'recognises hours, and it has not happened.',
      lookAt: 'Whether the evidence exists somewhere and simply has not been linked. Nothing is '
        + 'lost by asking.',
    });
  }

  // ---- 5. WORKLOAD WITHOUT RECORDED PROJECT ACTIVITY --------------------------------------------
  // FIRES ONLY ON A SUCCESSFUL READ. projectMovements === null means the project tables could not be
  // read, and a signal built on that would be the exact failure this file's header warns about.
  if (input?.projectMovements !== null && input?.projectMovements !== undefined) {
    const projectHours = round2(open
      .filter((a) => PROJECT_TYPE_HINT.test(a.typeKey))
      .reduce((s, a) => s + (a.reportedHours || 0), 0));
    if (projectHours >= PROJECT_HOURS_FLOOR && Number(input.projectMovements) === 0) {
      out.push({
        key: 'workload-without-recorded-project-activity',
        label: LABELS['workload-without-recorded-project-activity'],
        observation: projectHours + ' ' + plural(projectHours, 'hour', 'hours')
          + ' reported against project work over ' + period + ', while nothing recorded moved on any '
          + 'project in this system during the same period — no deliverable due, accepted or updated. '
          + 'The threshold for saying so is ' + PROJECT_HOURS_FLOOR + ' hours.',
        ordinaryExplanation: 'THE MOST LIKELY EXPLANATION IS A GAP IN THE RECORD RATHER THAN IN THE '
          + 'WORK. A project tracked in a repository, a board or a document this platform cannot see '
          + 'will always produce this pattern, however well the work is going.',
        lookAt: 'Whether the project this person is working on is represented here at all. If it is '
          + 'not, this observation says nothing about them and recording the project is the fix.',
      });
    }
  }

  // ---- 6. REPEATED MISSED DEADLINES -------------------------------------------------------------
  const today = isDate(input?.todayIso) ? input.todayIso : to;
  const missed = open.filter((a) =>
    isDate(a.deadline)
    && String(a.deadline) < today
    && a.status !== 'completed'
    && a.status !== 'approved');
  if (missed.length >= MISSED_DEADLINE_MIN) {
    const allocated = round2(missed.reduce((s, a) => s + (a.allocatedHours || 0), 0));
    out.push({
      key: 'repeated-missed-deadlines',
      label: LABELS['repeated-missed-deadlines'],
      observation: missed.length + ' ' + plural(missed.length, 'activity', 'activities') + ' in '
        + period + ' passed ' + plural(missed.length, 'its', 'their') + ' deadline and '
        + plural(missed.length, 'is', 'are') + ' still open, carrying ' + allocated + ' allocated '
        + plural(allocated, 'hour', 'hours') + ' between them. The threshold for saying so is '
        + MISSED_DEADLINE_MIN + '.',
      ordinaryExplanation: 'Repeated over-run is most often a planning problem rather than a person '
        + 'problem: more was allocated into those weeks than the ceiling makes possible, or the '
        + 'estimates were low. The weekly ceiling exists to make exactly this visible.',
      lookAt: 'What was allocated into those weeks against the ceiling, before anything is asked of '
        + 'the intern.',
    });
  }

  return out;
}

// -------------------------------------------------------------------------------------------------
// THE READER
// -------------------------------------------------------------------------------------------------

export interface AnomalyReview {
  employeeId: string;
  fromIso: string;
  toIso: string;
  signals: AnomalySignal[];
  /**
   * THE ONE SENTENCE, or an empty string when nothing fired. It is never anything other than
   * MENTOR_SENTENCE, however many signals are in the list.
   */
  sentence: string;
  /** Sources that could NOT be read. Signals depending on them did not run and are not absent facts. */
  unread: string[];
  /** What the screen should say about the checks that could not run. Empty when everything read. */
  incompleteSentence: string;
}

const emptyReview = (employeeId: string, fromIso: string, toIso: string): AnomalyReview => ({
  employeeId, fromIso, toIso, signals: [], sentence: '', unread: [], incompleteSentence: '',
});

/**
 * HOW MANY PROJECT ITEMS RECORDED MOVEMENT IN THE WINDOW.
 *
 * NULL ON A FAILED READ, and the caller must not treat that as zero — signal 5 refuses to fire on a
 * null for that reason. project_deliverables is read tolerantly because it is another module's table
 * and this one has no business asserting its shape.
 */
async function projectMovementsFor(
  employeeId: string,
  fromIso: string,
  toIso: string,
): Promise<number | null> {
  try {
    const r = rows(await (await database()).execute(sql`
      SELECT COUNT(*)::int AS n
        FROM project_deliverables d
       WHERE d.owner_employee_id = ${employeeId}::uuid
         AND (
           (d.due_on BETWEEN ${fromIso}::date AND ${toIso}::date)
           OR (d.accepted_on BETWEEN ${fromIso}::date AND ${toIso}::date)
         )`))[0];
    return r ? Number(r.n) || 0 : 0;
  } catch (e: any) {
    logFail('projectMovementsFor', e);
    return null;
  }
}

/**
 * THE REVIEW FOR ONE INTERN, OVER A WINDOW. Read on the mentor's own screen, computed on the spot,
 * stored nowhere.
 *
 * THE SENTENCE IS ATTACHED HERE AND IT IS THE SAME SENTENCE EVERY TIME. There is no branch in this
 * function that produces a stronger one, and there is no count at which it changes.
 */
export async function reviewFor(
  employeeId: string,
  opts?: { fromIso?: string | null; toIso?: string | null; todayIso?: string | null },
): Promise<AnomalyReview> {
  const today = isDate(String(opts?.todayIso || '').slice(0, 10))
    ? String(opts!.todayIso).slice(0, 10)
    : isoDate(new Date());
  const to = isDate(String(opts?.toIso || '').slice(0, 10)) ? String(opts!.toIso).slice(0, 10) : today;
  const from = isDate(String(opts?.fromIso || '').slice(0, 10))
    ? String(opts!.fromIso).slice(0, 10)
    : isoDate(new Date(Date.parse(to + 'T00:00:00Z') - DEFAULT_WINDOW_DAYS * 86400000));

  const review = emptyReview(String(employeeId || ''), from, to);
  if (!isUuid(employeeId)) return review;

  // ---- ACTIVITIES ------------------------------------------------------------------------------
  const activityRead = await readActivitiesInRange(employeeId, from, to, 400);
  if (!activityRead.ok || activityRead.unread.length) {
    for (const u of activityRead.unread) review.unread.push(u);
    if (!activityRead.ok) review.unread.push('this period\'s activities');
  }
  const activities: AnomalyActivity[] = activityRead.activities.map((a: ActivityRow) => ({
    id: a.id,
    title: a.title,
    typeKey: a.activityTypeKey,
    status: String(a.status),
    closed: a.closed,
    deadline: a.deadline,
    allocatedHours: a.allocatedHours,
    reportedHours: a.reportedHours,
    verifiedHours: a.verifiedHours,
    reportedAt: a.reportedAt,
    evidenceRequirement: String(a.evidenceRequirement),
  }));

  // ---- EVIDENCE --------------------------------------------------------------------------------
  //
  // listEvidenceForEmployee() answers [] both for "nothing filed" and for a failed read, and those
  // are the two cases this module must never confuse. So the count is confirmed separately: when the
  // confirmation read fails, the evidence-dependent signals are withheld rather than fired on an
  // empty list.
  let evidence: AnomalyEvidence[] = [];
  let evidenceReadable = true;
  try {
    const filed: EvidenceRow[] = await listEvidenceForEmployee(employeeId, {
      fromIso: from, toIso: to, limit: 300,
    });
    evidence = filed.map((e) => ({
      id: e.id,
      url: e.url,
      title: e.title,
      occurredOn: e.occurredOn,
      submittedAt: e.submittedAt,
      hoursClaimed: Number(e.hoursClaimed) || 0,
      activityIds: (e.links || []).map((l) => String(l.activityId || '')).filter(Boolean),
    }));
    if (!filed.length) {
      // Confirm the emptiness. A thrown error here means the table could not be read.
      await (await database()).execute(sql`SELECT 1 FROM eims_evidence WHERE employee_id = ${employeeId}::uuid LIMIT 1`);
    }
  } catch (e: any) {
    logFail('reviewFor evidence', e);
    evidenceReadable = false;
    review.unread.push('the evidence filed in this period');
  }

  // ---- PROJECT MOVEMENT -------------------------------------------------------------------------
  const movements = await projectMovementsFor(employeeId, from, to);
  if (movements === null) review.unread.push('project deliverables');

  // ---- DETECT -----------------------------------------------------------------------------------
  //
  // WITHHELD, NOT ZEROED. Where evidence could not be read, the two signals that compare work against
  // evidence are removed from the result — reporting "no evidence" from a failed read is the one
  // mistake in this file that would be an accusation manufactured out of an outage.
  let signals = detectAnomalies({
    fromIso: from,
    toIso: to,
    todayIso: today,
    activities,
    evidence,
    projectMovements: movements,
  });
  if (!evidenceReadable) {
    signals = signals.filter((s) =>
      s.key !== 'hours-without-evidence'
      && s.key !== 'repeated-identical-submission'
      && s.key !== 'completed-without-required-evidence'
      && s.key !== 'dormant-then-bulk');
  }

  review.signals = signals;
  review.sentence = signals.length ? MENTOR_SENTENCE : '';
  if (review.unread.length) {
    review.incompleteSentence = 'Some checks could not be run because these could not be read: '
      + review.unread.join(', ') + '. Nothing is being reported from a source that failed, so silence '
      + 'on those checks means they did not run rather than that they passed.';
  }
  return review;
}

/**
 * REVIEWS FOR SEVERAL INTERNS, for a mentor whose queue lists more than one.
 *
 * Sequential and capped on purpose: each review is several reads, and a mentor with thirty mentees
 * pressing refresh must not be able to issue a hundred queries. The cap is stated to the caller
 * rather than applied silently.
 */
export async function reviewForMany(
  employeeIds: readonly string[],
  opts?: { fromIso?: string | null; toIso?: string | null; todayIso?: string | null; max?: number },
): Promise<{ reviews: Map<string, AnomalyReview>; examined: number; skipped: number }> {
  const ids = Array.from(new Set((employeeIds || []).filter(isUuid).map(String)));
  const max = Math.max(1, Math.min(40, Number(opts?.max) || 20));
  const take = ids.slice(0, max);
  const reviews = new Map<string, AnomalyReview>();
  for (const id of take) {
    try {
      reviews.set(id, await reviewFor(id, opts));
    } catch (e: any) {
      logFail('reviewForMany', e);
    }
  }
  return { reviews, examined: take.length, skipped: Math.max(0, ids.length - take.length) };
}
