// src/lib/intelligence/self-view.ts — THE TEN SECTIONS, COMPOSED FROM RECORDS THIS PATCH DOES NOT OWN.
//
// =================================================================================================
// THE SHAPE: I/O AT THE EDGE, JUDGEMENT IN PURE FUNCTIONS
// =================================================================================================
//
// buildSelfIntelligence() is the only function here that touches a database. Everything that decides
// what a person reads about themselves is a pure function of already-fetched rows, exported, and
// tested without a database — because the properties worth defending here are properties of the
// COMPOSITION, not of the queries:
//
//   - a section with nothing behind it says which KIND of nothing it is;
//   - no sentence outruns its evidence;
//   - a feedback summary under the suppression floor is not rendered;
//   - nothing anywhere becomes a prediction or a verdict.
//
// A test that needs a live Postgres to check the third of those is a test that does not run.
//
// =================================================================================================
// THREE DIFFERENT EMPTIES, NEVER COLLAPSED
// =================================================================================================
//
//   NOTHING RECORDED   the ordinary state early in a person's time here. Says so warmly.
//   SUPPRESSED         there IS something, and showing it would identify a colleague.
//   UNREADABLE         the query did not come back. This is the one that must never render as
//                      "you have none" — the same failure mode as a green flash over a failed write.
//
// =================================================================================================
// WHAT IS NOT HERE
// =================================================================================================
//
// No score. No rank. No percentile. No comparison to any other person, in any section, including
// the ones where a comparison would be easy and tempting. No prediction — not of attrition, not of
// performance, not of readiness for a role. And no statement derived from anything other than work
// records this platform holds and the employee's own words: this view has no other input, and there
// is no seam here where one could be added without rewriting the composer.
import type {
  Confidence, EvidenceRef, Insight, SelfSection, SelfSectionView,
} from './contract';
import {
  MIN_FEEDBACK_NOTES, NOTHING_YET_SENTENCE, SECTION_LABELS, SECTION_PURPOSE,
  SELF_SECTIONS, SUPPRESSED_FEEDBACK_SENTENCE, UNREADABLE_SENTENCE, renderableInsight,
} from './contract';

/* ================================================================================================
 * THE INPUT BUNDLE
 * ============================================================================================= */

/**
 * Everything the composer is allowed to see, flattened out of the modules that own it.
 *
 * DELIBERATELY NARROW. The composer receives the fields it uses and not the row they came from, so
 * a widening of one of those modules' shapes cannot silently widen what appears on this screen. Each
 * group carries its own `ok`, because "no skills" and "the skills query failed" are two different
 * screens and a single bundle-wide flag would collapse them.
 */
export interface SelfSources {
  /** ISO instant the view was built. Passed in rather than read, so the composer is deterministic. */
  now: string;

  skills: {
    ok: boolean;
    rows: { name: string; level: number; levelLabel: string; assertion: string; basis: string; recordedAt: string | null }[];
  };
  competencies: {
    ok: boolean;
    rows: { name: string; dimension: string; status: string; verifiedByNamedPerson: boolean; recordedAt: string | null }[];
  };
  certifications: {
    ok: boolean;
    rows: { certNumber: string; courseTitle: string | null; issuedAt: string | null }[];
  };
  /** Requirements written down for this person's role, and whether the link to a role exists at all. */
  roleRequirements: {
    ok: boolean;
    /** False when nothing connects this employee record to a role whose requirements could be read. */
    roleLinked: boolean;
    roleLabel: string | null;
    rows: { skillName: string; necessity: string; minLevel: number }[];
  };
  learning: {
    ok: boolean;
    rows: { courseTitle: string; required: boolean; dueOn: string | null; completedAt: string | null; progressPct: number | null }[];
  };
  goals: {
    ok: boolean;
    rows: { title: string; status: string; progressPct: number; lastProgressAt: string | null; targetDate: string | null }[];
  };
  tasks: {
    ok: boolean;
    rows: { title: string; state: string; createdAt: string | null; completedAt: string | null; isOverdue: boolean }[];
  };
  evidence: {
    ok: boolean;
    rows: { title: string; occurredOn: string; status: string; hoursVerified: number; reviewedAt: string | null }[];
  };
  /** THEMES AND COUNTS ONLY. Author identity never enters this bundle, so it cannot leave it. */
  feedback: {
    ok: boolean;
    rows: { theme: string; createdAt: string | null }[];
  };
  reflections: {
    ok: boolean;
    count: number;
    latestAt: string | null;
  };
  /** From consent. Governs the suggestion arm of the development plan and nothing else. */
  suggestionsAllowed: boolean;
}

export interface SelfIntelligence {
  sections: SelfSectionView[];
  generatedAt: string;
  /** Which underlying reads succeeded, named, so the page can be honest at the top as well as inline. */
  sourceHealth: { source: string; ok: boolean }[];
}

/* ================================================================================================
 * SMALL HELPERS
 * ============================================================================================= */

const iso = (v: any): string | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
};

const monthsBetween = (from: string | null, now: string): number => {
  const a = from ? new Date(from) : null;
  const b = new Date(now);
  if (!a || isNaN(a.getTime()) || isNaN(b.getTime())) return Number.POSITIVE_INFINITY;
  return (b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
};

const withinMonths = (at: string | null, now: string, months: number): boolean =>
  monthsBetween(at, now) <= months;

/** The most recent of a set of timestamps, or null when none of them is a date. */
const latestOf = (dates: (string | null)[]): string | null => {
  let best: number | null = null;
  for (const d of dates) {
    if (!d) continue;
    const t = new Date(d).getTime();
    if (isNaN(t)) continue;
    if (best === null || t > best) best = t;
  }
  return best === null ? null : new Date(best).toISOString();
};

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** A section with no insights, carrying the right kind of nothing. */
function emptySection(section: SelfSection, reason: string, unreadable = false): SelfSectionView {
  return {
    section,
    label: SECTION_LABELS[section],
    purpose: SECTION_PURPOSE[section],
    insights: [],
    emptyReason: reason,
    unreadable,
  };
}

/**
 * Assemble a section, dropping anything that cannot carry its own receipt.
 *
 * renderableInsight() is applied HERE rather than trusted to each composer, so a new section added
 * later cannot bypass it by forgetting to call it.
 */
function section(section: SelfSection, insights: Insight[], unreadable: boolean): SelfSectionView {
  const kept = insights.filter(renderableInsight);
  if (kept.length === 0) {
    return emptySection(section, unreadable ? UNREADABLE_SENTENCE : NOTHING_YET_SENTENCE, unreadable);
  }
  return {
    section,
    label: SECTION_LABELS[section],
    purpose: SECTION_PURPOSE[section],
    insights: kept,
    emptyReason: null,
    unreadable,
  };
}

const ref = (label: string, owner: string, href: string | null, occurredAt: string | null): EvidenceRef =>
  ({ label, owner, href, occurredAt });

/* ================================================================================================
 * 1. STRENGTHS
 * ============================================================================================= */

/**
 * A STRENGTH IS SOMETHING SOMEBODY CONFIRMED OR SOMETHING THAT WAS ASSESSED. A self-declared skill
 * is not one, and it does not appear here — it appears under skill development, labelled as what it
 * is. That distinction is the whole difference between this section and a list of words off a CV.
 */
export function composeStrengths(s: SelfSources): SelfSectionView {
  const unreadable = !s.skills.ok || !s.competencies.ok || !s.certifications.ok;
  const insights: Insight[] = [];

  const confirmedSkills = s.skills.rows.filter(
    (r) => r.assertion === 'verified' || r.assertion === 'factual',
  );

  for (const r of confirmedSkills.slice(0, 8)) {
    insights.push({
      key: 'skill:' + r.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      section: 'strengths',
      inputs: ['Your skill record', 'The module that confirmed it'],
      processing:
        'A skill appears here when its record was confirmed against the module that owns the underlying fact, or by a named person, rather than being entered as a statement about yourself.',
      output:
        r.name + ' is on your record at ' + r.levelLabel.toLowerCase() + ', and the entry was '
        + (r.assertion === 'verified' ? 'confirmed rather than self-declared.' : 'recorded by this platform as something that happened.'),
      evidence: [ref('Skill record: ' + r.name, 'performance (hr_employee_skills)', '/portal/employee/profile', r.recordedAt)],
      confidence: r.assertion === 'verified' ? 'corroborated' : 'observed',
      observedAt: r.recordedAt,
    });
  }

  const verifiedComps = s.competencies.rows.filter((c) => c.verifiedByNamedPerson);
  if (verifiedComps.length > 0) {
    insights.push({
      key: 'competencies:verified',
      section: 'strengths',
      inputs: ['Your competency record'],
      processing:
        'Counts the competencies on your record that a named person signed off, and names the most recent ones.',
      output:
        verifiedComps.length + ' ' + plural(verifiedComps.length, 'competency has', 'competencies have')
        + ' been signed off by a named person: ' + verifiedComps.slice(0, 5).map((c) => c.name).join(', ') + '.',
      evidence: verifiedComps.slice(0, 5).map((c) =>
        ref('Competency: ' + c.name, 'performance (competencies)', '/portal/employee/performance', c.recordedAt)),
      confidence: 'corroborated',
      observedAt: latestOf(verifiedComps.map((c) => c.recordedAt)),
    });
  }

  if (s.certifications.rows.length > 0) {
    const certs = s.certifications.rows.slice(0, 6);
    insights.push({
      key: 'certificates',
      section: 'strengths',
      inputs: ['Certificates issued on this platform'],
      processing: 'Lists certificates issued to you, each identified by its certificate number.',
      output:
        s.certifications.rows.length + ' ' + plural(s.certifications.rows.length, 'certificate has', 'certificates have')
        + ' been issued to you on this platform.',
      evidence: certs.map((c) =>
        ref((c.courseTitle || 'Certificate') + ' — ' + c.certNumber, 'performance-learning', '/portal/employee/learning', c.issuedAt)),
      confidence: 'corroborated',
      observedAt: latestOf(certs.map((c) => c.issuedAt)),
    });
  }

  return section('strengths', insights, unreadable);
}

/* ================================================================================================
 * 2. ROLE ALIGNMENT
 * ============================================================================================= */

/**
 * REQUIREMENTS AGAINST EVIDENCE, AND A HONEST ANSWER WHEN THERE ARE NO REQUIREMENTS.
 *
 * job-twin.ts is explicit that a job with no recorded requirements cannot be matched, and that
 * falling back to the keyword strings on the role is the trap the whole model exists to avoid. This
 * section holds the same line from the employee's side: with nothing written down for the role, it
 * says the record is missing and points at whose gap it is — which is the organisation's, not the
 * reader's. Printing "0 of 0 met" or a cheerful percentage over an empty requirement set would tell
 * somebody they were perfectly aligned with nothing.
 */
export function composeRoleAlignment(s: SelfSources): SelfSectionView {
  const unreadable = !s.roleRequirements.ok || !s.skills.ok;

  if (!unreadable && !s.roleRequirements.roleLinked) {
    return {
      section: 'role_alignment',
      label: SECTION_LABELS.role_alignment,
      purpose: SECTION_PURPOSE.role_alignment,
      insights: [{
        key: 'role:not-linked',
        section: 'role_alignment',
        inputs: ['Your employee record', 'The role requirement catalogue'],
        processing:
          'Looks for requirements written down against the role your employee record names, and compares them with your evidenced capabilities.',
        output:
          'Your employee record does not connect to a role whose requirements have been written down, so there is nothing to compare against yet. '
          + 'That is a gap in what the organisation has recorded about the role, and it is not counted against you anywhere.',
        evidence: [],
        confidence: 'insufficient',
        observedAt: null,
      }],
      emptyReason: null,
      unreadable: false,
    };
  }

  if (!unreadable && s.roleRequirements.rows.length === 0) {
    return {
      section: 'role_alignment',
      label: SECTION_LABELS.role_alignment,
      purpose: SECTION_PURPOSE.role_alignment,
      insights: [{
        key: 'role:no-requirements',
        section: 'role_alignment',
        inputs: ['The role requirement catalogue'],
        processing: 'Reads the requirements recorded against your role.',
        output:
          'No requirements have been written down for '
          + (s.roleRequirements.roleLabel ? s.roleRequirements.roleLabel : 'your role')
          + ' yet, so nothing is being compared. Until they are, any alignment figure would be about the empty list rather than about your work.',
        evidence: [],
        confidence: 'insufficient',
        observedAt: null,
      }],
      emptyReason: null,
      unreadable: false,
    };
  }

  const held = new Map<string, { level: number; assertion: string; recordedAt: string | null }>();
  for (const r of s.skills.rows) held.set(r.name.trim().toLowerCase(), r);

  const met: string[] = [];
  const notYet: string[] = [];
  const evidence: EvidenceRef[] = [];

  for (const req of s.roleRequirements.rows) {
    const h = held.get(req.skillName.trim().toLowerCase());
    // MET means the level is there AND the entry was not merely self-declared. A requirement
    // satisfied by somebody's own statement about themselves is not satisfied.
    const confirmed = !!h && (h.assertion === 'verified' || h.assertion === 'factual');
    if (confirmed && (h as any).level >= req.minLevel) {
      met.push(req.skillName);
      evidence.push(ref('Requirement met: ' + req.skillName, 'job-twin + skill record', '/portal/employee/profile', (h as any).recordedAt));
    } else {
      notYet.push(req.skillName + (req.necessity === 'required' ? '' : ' (preferred)'));
    }
  }

  // THE REQUIREMENT LIST IS ITSELF EVIDENCE, and it has to be cited even when nothing is covered.
  // Without this the zero-coverage case had no evidence rows, renderableInsight() dropped it, and
  // the section fell through to "nothing is on record for this yet" — which is the opposite of the
  // truth for somebody who has three unmet requirements and needs to see them. The count came from
  // this list; naming it is both accurate and what keeps the sentence renderable.
  evidence.unshift(ref(
    'Requirements recorded for ' + (s.roleRequirements.roleLabel || 'your role'),
    'job-twin (job_requirements)',
    null,
    null,
  ));

  const total = s.roleRequirements.rows.length;
  const insights: Insight[] = [{
    key: 'role:coverage',
    section: 'role_alignment',
    inputs: ['Requirements recorded for your role', 'Your evidenced skill record'],
    processing:
      'Compares each recorded requirement against your skill record, counting a requirement as covered only where the entry was confirmed rather than self-declared, and where the recorded level reaches the minimum.',
    output:
      met.length + ' of ' + total + ' recorded ' + plural(total, 'requirement is', 'requirements are')
      + ' covered by evidence on your record'
      + (notYet.length > 0 ? '. Not yet evidenced: ' + notYet.slice(0, 8).join(', ') + '.' : '.'),
    evidence: evidence.slice(0, 8),
    confidence: met.length === 0 ? 'partial' : 'observed',
    observedAt: latestOf(evidence.map((e) => e.occurredAt)),
  }];

  return section('role_alignment', insights, unreadable);
}

/* ================================================================================================
 * 3. GROWTH AREAS
 * ============================================================================================= */

/**
 * A GAP IN THE RECORD, NAMED AS A GAP IN THE RECORD.
 *
 * Every sentence in this section is about what is or is not on file. None of them is about the
 * person: "nothing is recorded yet for X" is true and useful; "you are weak at X" is neither, and
 * languageProblems() would refuse it.
 */
export function composeGrowthAreas(s: SelfSources): SelfSectionView {
  const unreadable = !s.skills.ok || !s.roleRequirements.ok || !s.learning.ok;
  const insights: Insight[] = [];

  const selfDeclared = s.skills.rows.filter((r) => r.assertion !== 'verified' && r.assertion !== 'factual');
  if (selfDeclared.length > 0) {
    insights.push({
      key: 'growth:unevidenced-skills',
      section: 'growth_areas',
      inputs: ['Your skill record'],
      processing:
        'Finds skills on your record that were entered as statements rather than confirmed against something that happened, and names them as places evidence could be attached.',
      output:
        selfDeclared.length + ' ' + plural(selfDeclared.length, 'skill on your record has', 'skills on your record have')
        + ' nothing evidencing ' + plural(selfDeclared.length, 'it', 'them') + ' yet: '
        + selfDeclared.slice(0, 6).map((r) => r.name).join(', ')
        + '. Filing a piece of work against one is how it moves.',
      evidence: selfDeclared.slice(0, 6).map((r) =>
        ref('Skill entry: ' + r.name, 'performance (hr_employee_skills)', '/portal/employee/evidence', r.recordedAt)),
      confidence: 'observed',
      observedAt: latestOf(selfDeclared.map((r) => r.recordedAt)),
    });
  }

  if (s.roleRequirements.roleLinked && s.roleRequirements.rows.length > 0) {
    const held = new Set(
      s.skills.rows
        .filter((r) => r.assertion === 'verified' || r.assertion === 'factual')
        .map((r) => r.name.trim().toLowerCase()),
    );
    const missing = s.roleRequirements.rows.filter((r) => !held.has(r.skillName.trim().toLowerCase()));
    if (missing.length > 0) {
      insights.push({
        key: 'growth:role-gaps',
        section: 'growth_areas',
        inputs: ['Requirements recorded for your role', 'Your evidenced skill record'],
        processing: 'Lists recorded requirements that have no confirmed entry on your skill record.',
        output:
          missing.length + ' recorded ' + plural(missing.length, 'requirement has', 'requirements have')
          + ' no confirmed entry yet: ' + missing.slice(0, 8).map((r) => r.skillName).join(', ')
          + '. These are the places where adding evidence would change the picture most.',
        evidence: [ref('Requirements for your role', 'job-twin', null, null)],
        confidence: 'observed',
        observedAt: null,
      });
    }
  }

  const overdue = s.learning.rows.filter(
    (l) => !l.completedAt && l.dueOn && new Date(l.dueOn).getTime() < new Date(s.now).getTime(),
  );
  if (overdue.length > 0) {
    insights.push({
      key: 'growth:learning-open',
      section: 'growth_areas',
      inputs: ['Learning assigned to you'],
      processing: 'Counts assigned learning that has passed its date without a completion recorded.',
      output:
        overdue.length + ' assigned ' + plural(overdue.length, 'course is', 'courses are')
        + ' past ' + plural(overdue.length, 'its', 'their') + ' date: '
        + overdue.slice(0, 5).map((l) => l.courseTitle).join(', ')
        + '. If a date no longer fits the work, that is worth saying rather than absorbing.',
      evidence: overdue.slice(0, 5).map((l) =>
        ref('Assigned: ' + l.courseTitle, 'performance-learning', '/portal/employee/learning', l.dueOn)),
      confidence: 'observed',
      observedAt: null,
    });
  }

  return section('growth_areas', insights, unreadable);
}

/* ================================================================================================
 * 4. SKILL DEVELOPMENT
 * ============================================================================================= */

export function composeSkillDevelopment(s: SelfSources): SelfSectionView {
  const unreadable = !s.skills.ok;
  const insights: Insight[] = s.skills.rows.slice(0, 20).map((r) => ({
    key: 'skilldev:' + r.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    section: 'skill_development' as SelfSection,
    inputs: ['Your skill record', 'How that entry was recorded'],
    processing:
      'Shows each skill with the strongest thing standing behind it, and says plainly which of the two it is: something confirmed, or something stated.',
    output:
      r.name + ' — ' + r.levelLabel.toLowerCase() + '. '
      + (r.assertion === 'verified'
        ? 'Confirmed rather than self-declared.'
        : r.assertion === 'factual'
          ? 'Recorded by this platform as something that happened.'
          : r.assertion === 'inferred'
            ? 'Worked out by the system from a related entry, so it is advisory and not evidence.'
            : 'Entered as a statement. Nothing on record supports it yet, which is an ordinary place to start.'),
    evidence: [ref(r.basis || ('Skill entry: ' + r.name), 'performance (hr_employee_skills)', '/portal/employee/profile', r.recordedAt)],
    confidence: (r.assertion === 'verified' ? 'corroborated' : r.assertion === 'factual' ? 'observed' : 'partial') as Confidence,
    observedAt: r.recordedAt,
  }));

  return section('skill_development', insights, unreadable);
}

/* ================================================================================================
 * 5. BEHAVIOURAL TRENDS
 * ============================================================================================= */

/**
 * PATTERNS IN WORK RECORDS. NOT IN A PERSON.
 *
 * Every input here is something the employee already sees on another page of their own portal: work
 * they filed, work a mentor verified, tasks they closed. There is no clock, no screenshot, no
 * keystroke record and no attendance-derived character judgement, and there is no seam here where
 * one could be added — the composer receives a fixed bundle and cannot reach for anything else.
 *
 * A COUNT WITH ITS WINDOW, NEVER AN ADJECTIVE. "In the last six months, 14 of 17 tasks were closed"
 * is a fact somebody can check and dispute. "You are reliable" is a verdict, and a verdict about a
 * person is exactly what this system may not produce.
 *
 * THE FLOOR IS REAL. Under MIN_TREND_POINTS the section says there is not enough yet rather than
 * drawing a line through two dots, because a trend from two data points is noise with a direction.
 */
export const MIN_TREND_POINTS = 4;

export function composeBehaviouralTrends(s: SelfSources): SelfSectionView {
  const unreadable = !s.tasks.ok || !s.evidence.ok;
  const insights: Insight[] = [];

  const recentTasks = s.tasks.rows.filter((t) => withinMonths(t.createdAt, s.now, 6));
  if (recentTasks.length >= MIN_TREND_POINTS) {
    const closed = recentTasks.filter((t) => !!t.completedAt);
    insights.push({
      key: 'trend:task-closure',
      section: 'behavioural_trends',
      inputs: ['Your task board'],
      processing:
        'Counts tasks created in the last six months and how many of them have a completion recorded. It is a count over a window, not a rate you are being held to.',
      output:
        'In the last six months, ' + closed.length + ' of ' + recentTasks.length + ' '
        + plural(recentTasks.length, 'task on your board has', 'tasks on your board have')
        + ' a completion recorded.',
      evidence: [ref('Your task board', 'employee-tasks', '/portal/tasks', latestOf(recentTasks.map((t) => t.completedAt)))],
      confidence: 'observed',
      observedAt: latestOf(recentTasks.map((t) => t.completedAt || t.createdAt)),
    });
  } else {
    insights.push({
      key: 'trend:task-closure',
      section: 'behavioural_trends',
      inputs: ['Your task board'],
      processing:
        'Needs at least ' + MIN_TREND_POINTS + ' tasks in the window before it describes a pattern.',
      output:
        'There are fewer than ' + MIN_TREND_POINTS + ' tasks on your board in the last six months, so nothing is described as a pattern here. A line drawn through two points is noise with a direction.',
      evidence: [],
      confidence: 'insufficient',
      observedAt: null,
    });
  }

  const recentEvidence = s.evidence.rows.filter((e) => withinMonths(e.occurredOn, s.now, 6));
  if (recentEvidence.length >= MIN_TREND_POINTS) {
    const verified = recentEvidence.filter((e) => e.hoursVerified > 0);
    const hours = verified.reduce((a, e) => a + (Number(e.hoursVerified) || 0), 0);
    insights.push({
      key: 'trend:evidence-filing',
      section: 'behavioural_trends',
      inputs: ['Work you filed as evidence', 'Verifications by a named reviewer'],
      processing:
        'Counts evidence you filed in the last six months and how much of it a named reviewer verified, with the verified hours those verdicts recognised.',
      output:
        'You filed ' + recentEvidence.length + ' ' + plural(recentEvidence.length, 'piece', 'pieces')
        + ' of evidence in the last six months, and a named reviewer verified ' + verified.length + ' of them'
        + (hours > 0 ? ', recognising ' + hours.toFixed(2).replace(/\.?0+$/, '') + ' hours.' : '.'),
      evidence: [ref('Your filed evidence', 'eims-evidence', '/portal/employee/evidence', latestOf(recentEvidence.map((e) => e.reviewedAt)))],
      confidence: verified.length > 0 ? 'corroborated' : 'observed',
      observedAt: latestOf(recentEvidence.map((e) => e.reviewedAt || e.occurredOn)),
    });
  }

  const done = s.learning.rows.filter((l) => l.completedAt && withinMonths(l.completedAt, s.now, 12));
  if (s.learning.ok && done.length > 0) {
    insights.push({
      key: 'trend:learning-cadence',
      section: 'behavioural_trends',
      inputs: ['Learning completions'],
      processing: 'Counts learning you completed in the last twelve months.',
      output:
        'You completed ' + done.length + ' assigned ' + plural(done.length, 'course', 'courses')
        + ' in the last twelve months.',
      evidence: done.slice(0, 5).map((l) =>
        ref('Completed: ' + l.courseTitle, 'performance-learning', '/portal/employee/learning', l.completedAt)),
      confidence: 'observed',
      observedAt: latestOf(done.map((l) => l.completedAt)),
    });
  }

  return section('behavioural_trends', insights, unreadable);
}

/* ================================================================================================
 * 6. DEVELOPMENT PLAN
 * ============================================================================================= */

/**
 * ASSIGNED LEARNING AND OWN GOALS ALWAYS; SUGGESTIONS ONLY WITH CONSENT.
 *
 * The first two are records that already exist and that the person can already see elsewhere;
 * showing them here is not new processing. A SUGGESTION is new processing — it reads the record to
 * produce something that was not in it — so it sits behind the `development_suggestions` purpose,
 * and when that is off the section says so rather than quietly showing less.
 */
export function composeDevelopmentPlan(s: SelfSources): SelfSectionView {
  const unreadable = !s.learning.ok || !s.goals.ok;
  const insights: Insight[] = [];

  const open = s.learning.rows.filter((l) => !l.completedAt);
  if (open.length > 0) {
    insights.push({
      key: 'plan:assigned-learning',
      section: 'development_plan',
      inputs: ['Learning assigned to you'],
      processing: 'Lists assigned learning with no completion recorded yet.',
      output:
        open.length + ' assigned ' + plural(open.length, 'course is', 'courses are') + ' open: '
        + open.slice(0, 6).map((l) => l.courseTitle + (l.required ? ' (required)' : '')).join(', ') + '.',
      evidence: open.slice(0, 6).map((l) =>
        ref('Assigned: ' + l.courseTitle, 'performance-learning', '/portal/employee/learning', l.dueOn)),
      confidence: 'observed',
      observedAt: null,
    });
  }

  const liveGoals = s.goals.rows.filter((g) => g.status !== 'closed' && g.status !== 'cancelled');
  if (liveGoals.length > 0) {
    insights.push({
      key: 'plan:goals',
      section: 'development_plan',
      inputs: ['Goals you set'],
      processing: 'Lists your open goals with the progress recorded against each.',
      output:
        liveGoals.length + ' open ' + plural(liveGoals.length, 'goal', 'goals') + ': '
        + liveGoals.slice(0, 6).map((g) => g.title + ' (' + g.progressPct + '% recorded)').join('; ') + '.',
      evidence: liveGoals.slice(0, 6).map((g) =>
        ref('Goal: ' + g.title, 'goals', '/portal/employee/performance', g.lastProgressAt)),
      confidence: 'observed',
      observedAt: latestOf(liveGoals.map((g) => g.lastProgressAt)),
    });
  }

  if (!s.suggestionsAllowed) {
    insights.push({
      key: 'plan:suggestions-off',
      section: 'development_plan',
      inputs: ['Your consent decisions'],
      processing: 'Checks whether you have allowed your own records to be read to suggest next steps.',
      output:
        'Suggestions are switched off for your account, so none are shown. Your learning and goals above are unaffected, and you can turn suggestions on from the Privacy tab.',
      evidence: [],
      confidence: 'insufficient',
      observedAt: null,
    });
  } else {
    for (const sug of suggestFromRecord(s)) insights.push(sug);
  }

  return section('development_plan', insights, unreadable);
}

/**
 * The suggestion rules, written out as rules.
 *
 * Each one is a plain condition over records the person can see, and each says what it read. There
 * is no model here and no hidden weighting — a suggestion nobody can trace back to a condition is a
 * suggestion nobody can argue with, and every one of these is meant to be arguable. All of them are
 * phrased as an option, never as an instruction and never as a consequence.
 */
export function suggestFromRecord(s: SelfSources): Insight[] {
  const out: Insight[] = [];

  const unevidenced = s.skills.rows.filter((r) => r.assertion === 'claimed' || r.assertion === 'provided');
  if (unevidenced.length > 0 && s.evidence.ok) {
    out.push({
      key: 'suggest:evidence-a-claim',
      section: 'development_plan',
      inputs: ['Your skill record', 'Your filed evidence'],
      processing:
        'Where a skill is on your record with nothing supporting it, and this platform has a way to file supporting work, it offers that as an option.',
      output:
        'One option: pick a piece of work you have already done and file it against '
        + unevidenced[0].name + '. That is the step that moves an entry from stated to evidenced.',
      evidence: [ref('Filing evidence', 'eims-evidence', '/portal/employee/evidence', null)],
      confidence: 'partial',
      observedAt: null,
    });
  }

  const stale = s.goals.rows.filter(
    (g) => g.status !== 'closed' && g.status !== 'cancelled' && !withinMonths(g.lastProgressAt, s.now, 3),
  );
  if (stale.length > 0) {
    out.push({
      key: 'suggest:revisit-goal',
      section: 'development_plan',
      inputs: ['Goals you set'],
      processing:
        'Names open goals with no progress recorded in the last three months, in case the goal has changed rather than stalled.',
      output:
        plural(stale.length, 'One open goal has', stale.length + ' open goals have')
        + ' had no progress recorded for three months: ' + stale.slice(0, 3).map((g) => g.title).join(', ')
        + '. Sometimes that means the work moved on and the goal should follow it.',
      evidence: stale.slice(0, 3).map((g) => ref('Goal: ' + g.title, 'goals', '/portal/employee/performance', g.lastProgressAt)),
      confidence: 'observed',
      observedAt: latestOf(stale.map((g) => g.lastProgressAt)),
    });
  }

  if (s.reflections.ok && s.reflections.count === 0) {
    out.push({
      key: 'suggest:first-reflection',
      section: 'development_plan',
      inputs: ['Your reflections'],
      processing: 'Offered once, where nothing has been written yet.',
      output:
        'Nothing is written in your reflections yet. They are private to you, and the entry most people find useful later is the one about what went well and why.',
      evidence: [ref('Your reflections', 'intelligence/reflection', '/portal/employee/intelligence?tab=reflection', null)],
      confidence: 'partial',
      observedAt: null,
    });
  }

  return out;
}

/* ================================================================================================
 * 7. ACHIEVEMENTS
 * ============================================================================================= */

export function composeAchievements(s: SelfSources): SelfSectionView {
  const unreadable = !s.evidence.ok || !s.certifications.ok || !s.learning.ok;
  const insights: Insight[] = [];

  const verified = s.evidence.rows
    .filter((e) => e.hoursVerified > 0 && withinMonths(e.reviewedAt || e.occurredOn, s.now, 6))
    .slice(0, 6);
  if (verified.length > 0) {
    insights.push({
      key: 'achieve:verified-work',
      section: 'achievements',
      inputs: ['Work you filed', 'Verdicts by a named reviewer'],
      processing: 'Lists work filed in the last six months that a named reviewer verified.',
      output:
        verified.length + ' ' + plural(verified.length, 'piece', 'pieces') + ' of your work '
        + plural(verified.length, 'was', 'were') + ' verified in the last six months: '
        + verified.map((e) => e.title).join('; ') + '.',
      evidence: verified.map((e) => ref(e.title, 'eims-evidence', '/portal/employee/evidence', e.reviewedAt || e.occurredOn)),
      confidence: 'corroborated',
      observedAt: latestOf(verified.map((e) => e.reviewedAt || e.occurredOn)),
    });
  }

  const recentCerts = s.certifications.rows.filter((c) => withinMonths(c.issuedAt, s.now, 12)).slice(0, 6);
  if (recentCerts.length > 0) {
    insights.push({
      key: 'achieve:certificates',
      section: 'achievements',
      inputs: ['Certificates issued on this platform'],
      processing: 'Lists certificates issued to you in the last twelve months.',
      output:
        recentCerts.length + ' ' + plural(recentCerts.length, 'certificate was', 'certificates were')
        + ' issued to you in the last twelve months.',
      evidence: recentCerts.map((c) =>
        ref((c.courseTitle || 'Certificate') + ' — ' + c.certNumber, 'performance-learning', '/portal/employee/learning', c.issuedAt)),
      confidence: 'corroborated',
      observedAt: latestOf(recentCerts.map((c) => c.issuedAt)),
    });
  }

  const doneGoals = s.goals.rows.filter((g) => g.status === 'closed' && withinMonths(g.lastProgressAt, s.now, 12)).slice(0, 6);
  if (s.goals.ok && doneGoals.length > 0) {
    insights.push({
      key: 'achieve:goals-closed',
      section: 'achievements',
      inputs: ['Goals you set'],
      processing: 'Lists goals you closed in the last twelve months.',
      output:
        doneGoals.length + ' ' + plural(doneGoals.length, 'goal was', 'goals were') + ' closed in the last twelve months: '
        + doneGoals.map((g) => g.title).join('; ') + '.',
      evidence: doneGoals.map((g) => ref('Goal: ' + g.title, 'goals', '/portal/employee/performance', g.lastProgressAt)),
      confidence: 'observed',
      observedAt: latestOf(doneGoals.map((g) => g.lastProgressAt)),
    });
  }

  return section('achievements', insights, unreadable);
}

/* ================================================================================================
 * 8. TIME-BASED INSIGHTS
 * ============================================================================================= */

export interface MonthBucket {
  /** YYYY-MM */
  month: string;
  evidenceFiled: number;
  hoursVerified: number;
  tasksCompleted: number;
  learningCompleted: number;
}

const monthKey = (v: string | null): string | null => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 7);
};

/**
 * The last N calendar months, oldest first, INCLUDING the empty ones.
 *
 * A quiet month has to appear as a quiet month. Dropping it would compress a gap out of the series
 * and make an interrupted run look continuous, which is the one distortion a time view exists to
 * prevent.
 */
export function monthlyBuckets(s: SelfSources, months = 6): MonthBucket[] {
  const end = new Date(s.now);
  if (isNaN(end.getTime())) return [];
  const keys: string[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i, 1));
    keys.push(d.toISOString().slice(0, 7));
  }
  const map = new Map<string, MonthBucket>();
  for (const k of keys) map.set(k, { month: k, evidenceFiled: 0, hoursVerified: 0, tasksCompleted: 0, learningCompleted: 0 });

  for (const e of s.evidence.rows) {
    const k = monthKey(e.occurredOn);
    const b = k ? map.get(k) : null;
    if (!b) continue;
    b.evidenceFiled += 1;
    b.hoursVerified += Number(e.hoursVerified) || 0;
  }
  for (const t of s.tasks.rows) {
    const k = monthKey(t.completedAt);
    const b = k ? map.get(k) : null;
    if (b) b.tasksCompleted += 1;
  }
  for (const l of s.learning.rows) {
    const k = monthKey(l.completedAt);
    const b = k ? map.get(k) : null;
    if (b) b.learningCompleted += 1;
  }

  return keys.map((k) => map.get(k) as MonthBucket);
}

export function composeTimeInsights(s: SelfSources): SelfSectionView {
  const unreadable = !s.evidence.ok || !s.tasks.ok || !s.learning.ok;
  const buckets = monthlyBuckets(s, 6);
  const active = buckets.filter((b) => b.evidenceFiled > 0 || b.tasksCompleted > 0 || b.learningCompleted > 0);

  if (active.length === 0) {
    return section('time_insights', [{
      key: 'time:none',
      section: 'time_insights',
      inputs: ['Your filed evidence', 'Your task board', 'Your learning completions'],
      processing: 'Buckets the last six months and counts what was recorded in each.',
      output: 'Nothing is recorded in the last six months, so there is no shape to describe yet.',
      evidence: [],
      confidence: 'insufficient',
      observedAt: null,
    }], unreadable);
  }

  const totalHours = buckets.reduce((a, b) => a + b.hoursVerified, 0);
  const insights: Insight[] = [{
    key: 'time:six-months',
    section: 'time_insights',
    inputs: ['Your filed evidence', 'Your task board', 'Your learning completions'],
    processing:
      'Splits the last six months into calendar months and counts what is recorded in each, keeping the empty months in place so a quiet period reads as a quiet period.',
    output:
      'Across the last six months, '
      + buckets.map((b) => b.month + ': ' + (b.evidenceFiled + b.tasksCompleted + b.learningCompleted)).join(', ')
      + ' recorded items'
      + (totalHours > 0 ? ', with ' + totalHours.toFixed(2).replace(/\.?0+$/, '') + ' hours verified in total.' : '.')
      + ' A month with nothing in it is a month with nothing recorded, which is not the same as a month with nothing done.',
    evidence: [
      ref('Your filed evidence', 'eims-evidence', '/portal/employee/evidence', null),
      ref('Your task board', 'employee-tasks', '/portal/tasks', null),
    ],
    confidence: active.length >= 3 ? 'observed' : 'partial',
    observedAt: s.now,
  }];

  return section('time_insights', insights, unreadable);
}

/* ================================================================================================
 * 9. FEEDBACK SUMMARY
 * ============================================================================================= */

export const FEEDBACK_THEME_WORDS: Record<string, string> = {
  strength: 'something that went well',
  improvement: 'something to work on',
  general: 'general observations',
};

/**
 * THEMES AND COUNTS. NO AUTHOR, NO BODY, NO EXCERPT.
 *
 * The bundle this reads cannot carry an author — SelfSources.feedback holds a theme and a date and
 * nothing else — so attribution cannot leak from here even by accident. What it produces is the
 * shape of what colleagues have written about, which is the part that is useful to the person and
 * the part that does not depend on knowing who said it.
 *
 * Under MIN_FEEDBACK_NOTES nothing is summarised at all. Not a softened version, not a partial
 * count: with two notes on file, any summary of them is a description of the one or two people who
 * wrote them.
 */
export function composeFeedbackSummary(s: SelfSources): SelfSectionView {
  if (!s.feedback.ok) return emptySection('feedback_summary', UNREADABLE_SENTENCE, true);

  const total = s.feedback.rows.length;
  if (total === 0) {
    return emptySection(
      'feedback_summary',
      'No feedback has been recorded about your work yet. Nothing is read into that.',
    );
  }
  if (total < MIN_FEEDBACK_NOTES) {
    return emptySection('feedback_summary', SUPPRESSED_FEEDBACK_SENTENCE);
  }

  const byTheme = new Map<string, number>();
  for (const f of s.feedback.rows) {
    const t = String(f.theme || 'general');
    byTheme.set(t, (byTheme.get(t) || 0) + 1);
  }

  const parts = Array.from(byTheme.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => n + ' about ' + (FEEDBACK_THEME_WORDS[t] || t));

  const insights: Insight[] = [{
    key: 'feedback:themes',
    section: 'feedback_summary',
    inputs: ['Feedback colleagues recorded about your work'],
    processing:
      'Groups the notes by the theme each was filed under and counts them. Who wrote a note is not read here and is not shown.',
    output:
      total + ' ' + plural(total, 'note has', 'notes have') + ' been recorded about your work: '
      + parts.join(', ') + '. The notes themselves are on your performance page.',
    evidence: [ref('Feedback about you', 'performance (hr_feedback)', '/portal/employee/performance', latestOf(s.feedback.rows.map((f) => f.createdAt)))],
    confidence: 'observed',
    observedAt: latestOf(s.feedback.rows.map((f) => f.createdAt)),
  }];

  return section('feedback_summary', insights, false);
}

/* ================================================================================================
 * 10. REFLECTION
 * ============================================================================================= */

export function composeReflectionSummary(s: SelfSources): SelfSectionView {
  if (!s.reflections.ok) return emptySection('reflection', UNREADABLE_SENTENCE, true);
  if (s.reflections.count === 0) {
    return emptySection(
      'reflection',
      'Nothing written yet. These are private to you — nobody sees one unless you share that entry yourself.',
    );
  }
  return section('reflection', [{
    key: 'reflection:count',
    section: 'reflection',
    inputs: ['Your reflections'],
    processing:
      'Counts your own entries and names the most recent date. Nothing in this system reads what they say.',
    output:
      s.reflections.count + ' ' + plural(s.reflections.count, 'entry', 'entries') + ' written'
      + (s.reflections.latestAt ? ', the most recent on ' + String(s.reflections.latestAt).slice(0, 10) + '.' : '.')
      + ' Nothing analyses them and nobody else sees one unless you share it.',
    evidence: [ref('Your reflections', 'intelligence/reflection', '/portal/employee/intelligence?tab=reflection', s.reflections.latestAt)],
    confidence: 'observed',
    observedAt: s.reflections.latestAt,
  }], false);
}

/* ================================================================================================
 * THE WHOLE VIEW
 * ============================================================================================= */

const COMPOSERS: Record<SelfSection, (s: SelfSources) => SelfSectionView> = {
  strengths: composeStrengths,
  role_alignment: composeRoleAlignment,
  growth_areas: composeGrowthAreas,
  skill_development: composeSkillDevelopment,
  behavioural_trends: composeBehaviouralTrends,
  development_plan: composeDevelopmentPlan,
  achievements: composeAchievements,
  time_insights: composeTimeInsights,
  feedback_summary: composeFeedbackSummary,
  reflection: composeReflectionSummary,
};

/**
 * Compose all ten, in the declared order.
 *
 * PURE. Give it a bundle and it gives the same view every time, which is what lets the whole
 * exposure boundary be tested without a database in front of it.
 */
export function composeSelfIntelligence(s: SelfSources): SelfIntelligence {
  return {
    sections: SELF_SECTIONS.map((k) => COMPOSERS[k](s)),
    generatedAt: iso(s.now) || s.now,
    sourceHealth: [
      { source: 'Skills', ok: s.skills.ok },
      { source: 'Competencies', ok: s.competencies.ok },
      { source: 'Certificates', ok: s.certifications.ok },
      { source: 'Role requirements', ok: s.roleRequirements.ok },
      { source: 'Learning', ok: s.learning.ok },
      { source: 'Goals', ok: s.goals.ok },
      { source: 'Tasks', ok: s.tasks.ok },
      { source: 'Filed evidence', ok: s.evidence.ok },
      { source: 'Feedback', ok: s.feedback.ok },
      { source: 'Reflections', ok: s.reflections.ok },
    ],
  };
}
