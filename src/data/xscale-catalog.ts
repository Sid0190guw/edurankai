// src/data/xscale-catalog.ts — THE DEPARTMENT, ITS FIFTEEN DIVISIONS, AND EVERY POSTING IN IT.
//
// The division content lives in ./xscale-divisions-a.ts and ./xscale-divisions-b.ts. This file
// composes it into complete job descriptions and is the single source the importer at
// /admin/roles/divisions reads.
//
// WHY THIS IS NOT PART OF ROLE_CATALOG.
//
// The existing catalogue import (/admin/roles, "Import role catalog") already walks ~988 roles and
// is time-boxed against a 60-second serverless ceiling — it has to be clicked repeatedly as it is.
// Adding a hundred and seventy-nine more would make that worse, and it would create a WORSE failure
// than slowness: the existing importer knows nothing about divisions or research classifications, so
// it would insert base rows with no division, no scale range and no classification, and a posting in
// this department without its classification is exactly the misrepresentation the whole design is
// built to prevent. One importer, one order: department, then divisions, then roles, then their
// classifications.
//
// EVERY GENERATED POSTING CARRIES ITS OWN HONESTY. The `about` text of every role in this catalogue
// contains the scale disclaimer and the evidential-standing sentence for that specific posting, so
// the honesty survives being read through the EXISTING job detail page, the JSON feed, a search
// result, or anything else that renders `about` without knowing this department exists.
import type { CatalogDepartment, CatalogRole } from './role-catalog';
import { locationLabel } from '@/lib/work-mode';
import { ENGAGEMENT_POLICIES, hoursPerWeek, projectHoursPerDay, wellbeingHoursPerDay } from '@/lib/engagement-policy';
import {
  CAREER_LADDER, SCALE_DISCLAIMER, careerRung, classificationDef, classificationEvidence,
  roleLevelForRung, scaleRangeText, evidenceDef,
} from '@/lib/xscale/taxonomy';
import { XSCALE_DIVISIONS_A, type DivisionSeed, type PositionSeed } from './xscale-divisions-a';
import { XSCALE_DIVISIONS_B } from './xscale-divisions-b';

export type { DivisionSeed, PositionSeed };

/** A catalogue role plus the research facets. Purely additive — every extra field is optional. */
export interface XscaleCatalogRole extends CatalogRole {
  divisionId: string;
  researchClassification: string;
  scaleMinExp: number;
  scaleMaxExp: number;
  skillCategories: string[];
  careerLevel: number;
  jobStatus: string;
  preferredSkills: string[];
  tools: string[];
  deliverables: string[];
  evaluationCriteria: string[];
  reportingTo: string;
  collaboratesWith: string[];
  applicationInstructions: string;
  integrityNote: string;
}

export const XSCALE_DEPARTMENT_ID = 'extreme-scale-engineering';

export const XSCALE_DEPARTMENT: CatalogDepartment = {
  id: XSCALE_DEPARTMENT_ID,
  name: 'Extreme-Scale, Nano & Fundamental Engineering',
  icon: 'atom',
  description:
    'Research and engineering organised across a conceptual span from 10^-100 m to 10^100 m — from ultra-small '
    + 'theoretical and mathematical regimes through quantum, atomic, molecular, nano, micro, human, planetary and '
    + 'cosmological scales. The span is a research classification, not a claim of experimental reach: every '
    + 'opportunity states whether the work is theoretical, mathematical, computational, simulation, experimental, '
    + 'prototype, applied engineering, or long-horizon frontier research.',
};

export const XSCALE_DIVISIONS: DivisionSeed[] = [...XSCALE_DIVISIONS_A, ...XSCALE_DIVISIONS_B];

// -------------------------------------------------------------------------------------------------
//   COMPOSITION
// -------------------------------------------------------------------------------------------------

// Work mode comes from the one policy module, never from a constant typed per file. Eleven copies of
// 'Remote / Hybrid (India)' is how every advertised role on this site once came to claim remote work.
const PERMANENT_LOCATION = locationLabel('on-site');
const TRAINEE_LOCATION = locationLabel('hybrid');

const INTERN_POLICY = ENGAGEMENT_POLICIES['Intern'];

const STANDARD_TERMS = {
  internshipMode: 'Full-Time' as const,
  workingDaysPerWeek: INTERN_POLICY.daysPerWeek ?? 6,
  hoursPerWeek: hoursPerWeek(INTERN_POLICY) ?? 40,
  projectHoursPerDay: projectHoursPerDay(INTERN_POLICY) ?? 5,
  wellbeingHoursPerDay: wellbeingHoursPerDay(INTERN_POLICY) ?? 1.67,
};

/**
 * COMPENSATION IS NOT INVENTED HERE, AND THAT IS A DELIBERATE REFUSAL.
 *
 * The brief is explicit: do not generate misleading salary data. No band has been approved for any
 * of these positions, so publishing "INR 18,00,000 - 30,00,000" would be a number this system made
 * up, shown to somebody deciding whether to change jobs.
 *
 * It also has a mechanical consequence that is the right one. The job detail page parses this string
 * for Google Jobs structured data (parseSalaryINR in src/pages/careers/[slug].astro) and emits a
 * baseSalary ONLY when it can find a figure. A sentence with no figure in it therefore produces a
 * JobPosting with no salary claim at all, rather than a fabricated one.
 *
 * Interns keep the site-wide wording, which MUST begin with "Unpaid" — the detail page tests that
 * prefix to decide whether to render "this is a paid internship".
 */
const RESEARCH_COMPENSATION =
  'Compensation is set at offer, against the level of the role and the evidence you bring to it. '
  + 'No equity, profit share or ownership interest forms any part of it.';
const TRAINEE_COMPENSATION =
  'Unpaid — internship certificate, mentorship from working researchers, and real research work with your name on it.';

const STANDARD_PERKS = [
  'Internship Certificate',
  'Letter of Recommendation (performance based)',
  'Mentorship from researchers and engineers working on the problem',
  'Real research work with a written result, not a simulated exercise',
  'Access to the department\'s computational resources for the duration of the internship',
  'Outstanding performers may be considered for extended internships or future roles, subject to organisational requirements.',
];

const ENGAGEMENT_NOTES = [
  'Interns are expected to maintain professionalism, intellectual honesty, confidentiality, and timely completion of assigned work.',
  'Weekly reviews with a named supervisor, with written feedback.',
  'Every result is reported with its assumptions and its limits. A negative or inconclusive result is reported, never discarded.',
  'Compliance with organisational policies, intellectual property guidelines, research ethics and applicable safety requirements is mandatory.',
  'An internship does not constitute an offer of employment.',
];

function kebab(s: string): string {
  return String(s)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function cut(s: string, n: number): string {
  const t = String(s || '').trim();
  if (t.length <= n) return t;
  return t.slice(0, n - 1).trimEnd() + '.';
}

/** Deduplicated, order-preserving. Skills arrive from several places and repeat. */
function uniq(xs: (string | undefined | null)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const v = String(x || '').trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

/** Rung-specific responsibilities, layered on top of the division's shared ones. */
function responsibilitiesForRung(rung: number): string[] {
  if (rung <= 1) {
    return [
      'Work on one clearly scoped problem for the duration, with a written result at the end rather than a status update.',
      'Meet a named supervisor weekly and come to that meeting with what did not work as well as what did.',
    ];
  }
  if (rung === 2) {
    return [
      'Take independent responsibility for the correctness of one component of a larger piece of work.',
      'Write up what you did so that the person who inherits it does not need you to explain it.',
    ];
  }
  if (rung === 3) {
    return [
      'Own a whole problem end to end: framing it, doing the work, and reporting the result with its limits.',
      'Review a colleague\'s work when asked, and say plainly when a result is not supported by its method.',
    ];
  }
  if (rung === 4) {
    return [
      'Hold the deep technical authority on a specific method or subsystem that other people depend on.',
      'Make that method usable by others: documented, tested, and with its regime of validity written down.',
    ];
  }
  if (rung === 5) {
    return [
      'Carry several related problems at once without losing the thread of any of them.',
      'Raise the technical judgement of less experienced colleagues, in review and in person.',
    ];
  }
  if (rung === 6) {
    return [
      'Decide what this area works on, who works on it, and the standard the work is held to.',
      'Be accountable for the honesty of what leaves the division, including under time pressure.',
      'Recruit, develop and retain the people the programme needs.',
    ];
  }
  if (rung === 7 || rung === 8) {
    return [
      'Take on the hardest open problems the department holds, including the ones that may not resolve.',
      'Set the technical standard that other people\'s work is measured against, and defend it.',
      'Represent the department\'s scientific position accurately outside it.',
    ];
  }
  if (rung === 9) {
    return [
      'Decide how the department\'s computational, experimental and theoretical work fits together.',
      'Own the interfaces between divisions, which is where systems-level work actually fails.',
    ];
  }
  return [
    'Be accountable for the division or the department: its people, its programme, and its scientific integrity.',
    'Decide what is published, in what form, with what claims attached to it.',
    'Answer for a claim this department has made, in public, when it is challenged.',
  ];
}

function learningOutcomesFor(d: DivisionSeed, p: PositionSeed): string[] {
  return [
    'Frame a research question in ' + d.name.toLowerCase() + ' precisely enough that it can be answered.',
    'Carry out ' + (d.tools[0] ? 'work using ' + d.tools[0] + ' and the division\'s standard toolchain' : 'the division\'s standard analysis') + ' to a reproducible standard.',
    'State the assumptions behind a result separately from the conclusion, in writing.',
    'Report uncertainty, and report a negative result rather than discarding it.',
    'Produce a written result that a colleague in another division can act on without a conversation.',
    'Understand where this work sits on the evidence scale, and describe it accurately to somebody outside the field.',
  ];
}

function eligibilityFor(d: DivisionSeed, rung: number): string[] {
  const r = careerRung(rung);
  const out: string[] = [];
  if (r) {
    out.push('Education: ' + r.education);
    out.push('Experience: ' + r.experience);
    out.push('Scope of the role: ' + r.scope);
  }
  out.push('Must have: ' + d.mustHave.slice(0, 2).join(' Also: '));
  out.push('Portfolio: at least one piece of work — code, a written result, a thesis chapter, a preprint — that somebody outside your institution can read and assess. It does not need to be published.');
  if (rung <= 1) {
    out.push('Available for a full-time internship for the stated duration, working the hours set out under Terms of Engagement.');
  }
  return out;
}

/**
 * The full "about" text.
 *
 * THE DISCLAIMER IS IN HERE, NOT ONLY IN THE PAGE CHROME. Everything that renders a role renders
 * `about`: the existing job detail page, the JSON feed at /api/jobs-feed, an admin preview, a search
 * snippet. Putting the scale disclaimer and the evidence statement in the stored text is what makes
 * the honesty travel with the posting instead of depending on which surface it is read through.
 */
function aboutFor(d: DivisionSeed, p: PositionSeed, rung: number): string {
  const cls = classificationDef(p.classification || d.classification);
  const minExp = p.scaleMinExp ?? d.scaleMinExp;
  const maxExp = p.scaleMaxExp ?? d.scaleMaxExp;
  const ev = classificationEvidence(p.classification || d.classification, minExp, maxExp)
    || evidenceDef('theoretical');
  const rungDef = careerRung(rung);
  return [
    'Department of Extreme-Scale, Nano & Fundamental Engineering, Division ' + d.code + ': ' + d.name + '.',
    d.charter,
    'This position: ' + p.focus,
    'Scale range for this work: ' + scaleRangeText(minExp, maxExp) + '.',
    'Research classification: ' + (cls ? cls.label + '. ' + cls.summary : 'stated on the posting.'),
    'Evidential standing: ' + (ev ? ev.label + '. ' + ev.statement : ''),
    d.integrityNote,
    SCALE_DISCLAIMER,
    rungDef ? 'Level ' + rungDef.level + ' (' + rungDef.label + '). ' + rungDef.scope : '',
  ].filter(Boolean).join(' ');
}

const APPLICATION_INSTRUCTIONS =
  'Apply through this page. You will be asked for your education, your experience, and links to work '
  + 'we can actually read — a repository, a write-up, a thesis chapter, a preprint. Send the piece of work '
  + 'you would defend, not the one with the best title. If a result in it turned out to be wrong, say so; '
  + 'we would rather read that than not know. Every application is read by a person.';

const EQUAL_OPPORTUNITY =
  'We assess applications on evidence of the work. We do not filter on institution, on age, on gender, on '
  + 'caste, on religion, on disability, or on where you are from. If any part of this process is inaccessible '
  + 'to you, tell us and we will change it for you.';

const SCIENTIFIC_INTEGRITY =
  'Scientific integrity is a condition of every role in this department. Assumptions are stated separately from '
  + 'conclusions. Uncertainty is reported. Negative and inconclusive results are written up, not discarded. '
  + 'Speculative work is labelled speculative, including when that makes it less impressive. Fabrication, '
  + 'falsification, and presenting a simulation as a measurement end an engagement here.';

function buildRole(d: DivisionSeed, p: PositionSeed, title: string): XscaleCatalogRole {
  const rung = p.rung;
  const rungDef = careerRung(rung);
  const isTrainee = rung <= 1;
  const classification = p.classification || d.classification;
  const minExp = p.scaleMinExp ?? d.scaleMinExp;
  const maxExp = p.scaleMaxExp ?? d.scaleMaxExp;

  const mustHave = uniq([...d.mustHave, ...(p.extraSkills || []), ...d.programming]);
  const preferred = uniq([...d.shouldHave, ...d.niceToHave]);

  const responsibilities = [
    ...d.whatTheyDo,
    ...responsibilitiesForRung(rung),
  ];

  const role: XscaleCatalogRole = {
    slug: cut('xse-' + d.code.toLowerCase() + '-' + kebab(title), 200),
    departmentId: XSCALE_DEPARTMENT_ID,
    title: cut(title, 200),
    level: roleLevelForRung(rung),
    function: cut(p.focus, 300),
    engagementType: isTrainee ? 'Internship' : 'Full-Time',
    location: isTrainee ? TRAINEE_LOCATION : PERMANENT_LOCATION,
    duration: isTrainee ? '6 Months' : 'Permanent',
    salary: isTrainee ? TRAINEE_COMPENSATION : RESEARCH_COMPENSATION,
    about: aboutFor(d, p, rung),
    responsibilities,
    skills: mustHave,
    eligibility: eligibilityFor(d, rung),
    isFeatured: p.featured === true,
    openings: p.openings ?? 1,

    // ---- AICTE-format fields, populated for the trainee rungs the portal format is for ----
    keywords: uniq([
      ...d.keywords,
      classificationDef(classification)?.label || '',
      'Extreme-scale',
      d.name,
    ]),
    ...(isTrainee
      ? {
        learningOutcomes: learningOutcomesFor(d, p),
        qualificationType: 'UG / PG',
        qualifications: [rungDef?.education || 'Enrolled in a relevant undergraduate or postgraduate programme.'],
        specialisations: d.domains.slice(0, 8),
        noOfInterns: p.openings ?? 2,
        perks: STANDARD_PERKS,
        internshipMode: STANDARD_TERMS.internshipMode,
        workingDaysPerWeek: STANDARD_TERMS.workingDaysPerWeek,
        hoursPerWeek: STANDARD_TERMS.hoursPerWeek,
        projectHoursPerDay: STANDARD_TERMS.projectHoursPerDay,
        wellbeingHoursPerDay: STANDARD_TERMS.wellbeingHoursPerDay,
        engagementNotes: ENGAGEMENT_NOTES,
      }
      : {}),

    // ---- Research facets ----
    divisionId: d.id,
    researchClassification: classification,
    scaleMinExp: minExp,
    scaleMaxExp: maxExp,
    skillCategories: [...d.skillCategories],
    careerLevel: rung,
    // Every generated posting starts as a DRAFT. An import that publishes a hundred and seventy-nine
    // job advertisements to the public site the moment somebody clicks a button is not an import, it
    // is an accident. A human publishes each one, or publishes a division at a time, from
    // /admin/roles/divisions.
    jobStatus: 'DRAFT',
    preferredSkills: preferred,
    tools: [...d.tools],
    deliverables: [...d.deliverables],
    evaluationCriteria: [...d.evaluation],
    reportingTo: rung >= 10 ? 'Department Director' : (rung >= 6 ? 'Department Director' : d.name + ' Lead'),
    collaboratesWith: [...d.collaboratesWith],
    applicationInstructions: APPLICATION_INSTRUCTIONS + ' ' + EQUAL_OPPORTUNITY,
    integrityNote: d.integrityNote + ' ' + SCIENTIFIC_INTEGRITY,
  };
  return role;
}

/**
 * Titles repeat across divisions — "Quantum Materials Scientist" is a real position in both D03 and
 * D06, and they are different jobs. The slug already carries the division code so it stays unique,
 * but a careers listing showing the same title twice with no way to tell them apart is a listing
 * that wastes a candidate's time. A repeated title is qualified with its division.
 */
function resolveTitles(divisions: DivisionSeed[]): { d: DivisionSeed; p: PositionSeed; title: string }[] {
  const count = new Map<string, number>();
  for (const d of divisions) {
    for (const p of d.positions) {
      const k = p.title.toLowerCase();
      count.set(k, (count.get(k) || 0) + 1);
    }
  }
  const out: { d: DivisionSeed; p: PositionSeed; title: string }[] = [];
  for (const d of divisions) {
    for (const p of d.positions) {
      const repeated = (count.get(p.title.toLowerCase()) || 0) > 1;
      out.push({ d, p, title: repeated ? p.title + ' (' + d.name + ')' : p.title });
    }
  }
  return out;
}

export const XSCALE_ROLES: XscaleCatalogRole[] =
  resolveTitles(XSCALE_DIVISIONS).map(({ d, p, title }) => buildRole(d, p, title));

/** The department's positions grouped by division id — used by the division admin surface. */
export function xscaleRolesByDivision(): Record<string, XscaleCatalogRole[]> {
  const out: Record<string, XscaleCatalogRole[]> = {};
  for (const r of XSCALE_ROLES) {
    if (!out[r.divisionId]) out[r.divisionId] = [];
    out[r.divisionId].push(r);
  }
  return out;
}

/** Every career rung this department actually staffs, so the level filter offers no empty option. */
export function xscaleRungsInUse(): number[] {
  const used = new Set<number>(XSCALE_ROLES.map((r) => r.careerLevel));
  return CAREER_LADDER.map((r) => r.level).filter((l) => used.has(l));
}

export const XSCALE_ROLE_COUNT = XSCALE_ROLES.length;
export const XSCALE_DIVISION_COUNT = XSCALE_DIVISIONS.length;
