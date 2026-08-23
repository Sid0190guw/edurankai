// src/lib/horizon/adapters.ts — THE FIVE SECTIONS PATCH 11 CAN FILL FROM RECORDS THAT ALREADY EXIST.
//
// =================================================================================================
// WHY A VIEW PATCH HAS ADAPTERS AT ALL
// =================================================================================================
//
// Patch 11 owns no employee data and creates no table. But five of the twelve tabs — Overview,
// Professional Profile, Performance & Work Records, Evidence & Records, Audit Trail — are asking for
// things this repository ALREADY holds, behind modules that already enforce their own scope:
//
//     src/lib/digital-twin.ts    one person composed from the records that exist, every field
//                                carrying who asserted it, with per-aspect grants resolved BEFORE
//                                anything is read
//     src/lib/evidence-graph.ts  claim -> evidence -> source -> document -> locator -> timestamp
//     audit_log                  who did what to whom, and when
//
// Building a second copy of any of that would be exactly the duplication rule 11 forbids. So these
// are ADAPTERS: they call the owning module, translate its answer into this view's payload shape,
// and add nothing. Every one of them is a pure transform over a call — there is no business logic in
// this file, and there is no place in it where a number could be invented.
//
// If a producing patch later registers a provider for one of these sections, the provider wins and
// the adapter stops being called. That is decided in src/lib/horizon/profile.ts, in one place.
//
// =================================================================================================
// WHAT AN ADAPTER MUST NEVER DO
// =================================================================================================
//
// It must never turn an unread aspect into an empty one. The twin already distinguishes withheld
// (not read, by decision), unreadable (read failed) and empty (read, nothing there), and every
// adapter below carries that distinction through instead of flattening it into a blank panel.
//
// It must never widen. `buildDigitalTwin` was handed the viewer's own capability test; an adapter
// that reached past a withheld aspect would be defeating the grant the twin already made.
// =================================================================================================

import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { rowsOf, logFail } from '@/lib/performance-scope';
import {
  ASSERTION_LABELS,
  type Asserted,
  type DigitalTwin,
  type TwinAspect,
} from '@/lib/digital-twin';
import {
  claimsForSubject,
  EVIDENCE_LEVEL_LABELS,
  EVIDENCE_LEVEL_MEANING,
  type ClaimRow,
  type EvidenceLevel,
} from '@/lib/evidence-graph';
import {
  bandOf,
  NO_CONFIDENCE,
  type Confidence,
  type EvidenceRef,
  type MeirSubject,
  type SectionPayload,
  type Signal,
  type SignalWeightClass,
} from './contracts';
import { HORIZON_AUDIT_ENTITY } from './access';

const MOD = 'horizon-adapters';

// -------------------------------------------------------------------------------------------------
// MODULE CONSTANTS — all above the functions that read them.
// -------------------------------------------------------------------------------------------------

const OWNER_LOCAL = 'PATCH-11 (this patch)';

/**
 * Evidence level -> how much weight a reader is allowed to put on it.
 *
 * This is a TRANSLATION between two vocabularies that already exist, not a new judgement. The
 * evidence graph's ladder is about what supports a claim; this view's weight class is about what may
 * outrank what when a human reads the page. `inferred` lands on model_inference because the graph
 * says in as many words that an inferred level is advisory and carries the relation it rests on.
 */
const WEIGHT_BY_LEVEL: Record<EvidenceLevel, SignalWeightClass> = {
  claimed: 'self_reported',
  explicit: 'self_reported',
  inferred: 'model_inference',
  demonstrated: 'demonstrated_work',
  professionally_demonstrated: 'demonstrated_work',
  production_demonstrated: 'demonstrated_work',
  externally_verified: 'demonstrated_work',
};

/**
 * Confidence per level. Stated, and stated as a BASIS rather than a bare number, because a decimal
 * beside a person's name with no sentence under it is the opaque score this whole system refuses.
 */
const CONFIDENCE_BY_LEVEL: Record<EvidenceLevel, Confidence> = {
  claimed: { value: 0.1, band: bandOf(0.1), basis: 'Somebody wrote it down and nothing on record supports it yet.' },
  explicit: { value: 0.2, band: bandOf(0.2), basis: 'The person stated it about themselves as a record. Still their word.' },
  inferred: { value: 0.25, band: bandOf(0.25), basis: 'Worked out from a relation between skills. Advisory only.' },
  demonstrated: { value: 0.6, band: bandOf(0.6), basis: 'They did something and this platform holds the record of it.' },
  professionally_demonstrated: { value: 0.8, band: bandOf(0.8), basis: 'Done as employed work, and a named human who answers for that work said so.' },
  production_demonstrated: { value: 0.85, band: bandOf(0.85), basis: 'It went into production and a named human recorded what and where.' },
  externally_verified: { value: 0.9, band: bandOf(0.9), basis: 'Confirmed by a third party outside this platform.' },
};

/** How far back the Audit Trail tab looks. Bounded, so one open of this page cannot scan the table. */
const AUDIT_WINDOW_DAYS = 180;
const AUDIT_ROW_LIMIT = 100;

// -------------------------------------------------------------------------------------------------
// SHARED HELPERS
// -------------------------------------------------------------------------------------------------

const iso = (v: any): string | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
};

/** A payload skeleton, so every adapter agrees about the fields it is not filling. */
function shell<T>(key: SectionPayload<T>['key'], owedBy: string): SectionPayload<T> {
  return {
    key,
    status: 'empty',
    sentence: '',
    owedBy,
    signals: [],
    patterns: [],
    requiredCapability: null,
    accessLogged: false,
    accessLogNote: null,
  };
}

/**
 * Was this twin aspect READ, and if not, why not. Three different answers, never collapsed.
 */
function aspectState(twin: DigitalTwin, aspect: TwinAspect): { read: boolean; because: string } {
  const withheld = (twin.withheld || []).find((w) => w.aspect === aspect);
  if (withheld) return { read: false, because: withheld.because };
  const bad = (twin.unreadable || []).find((u) => u.aspect === aspect);
  if (bad) return { read: false, because: bad.because };
  return { read: (twin.aspects || []).indexOf(aspect) >= 0, because: '' };
}

/** Render one Asserted<T> as a display row without losing who said it. */
export interface AssertedRow {
  label: string;
  value: string;
  assertion: string;
  assertionLabel: string;
  basis: string;
  source: string;
  recordedAt: string | null;
}

function row(label: string, a: Asserted<any> | null | undefined): AssertedRow | null {
  if (!a || a.value === null || a.value === undefined || a.value === '') return null;
  const p = a.provenance;
  return {
    label,
    value: String(a.value),
    assertion: p.assertion,
    assertionLabel: ASSERTION_LABELS[p.assertion] || p.assertion,
    basis: p.basis,
    source: p.source,
    recordedAt: p.recordedAt || null,
  };
}

// =================================================================================================
// 1. OVERVIEW — THE SUMMARY RUNG
// =================================================================================================

export interface OverviewData {
  displayName: string | null;
  /** The identity spine's own sentence about how the records were linked. Printed verbatim. */
  linkageSentence: string;
  fullyLinked: boolean;
  states: { kind: string; label: string; current: boolean }[];
  edges: { from: string; to: string; status: string; via: string; sentence: string }[];
  /** Records that look like this person but were never confirmed. Never used to compose anything. */
  unconfirmed: { kind: string; sentence: string }[];
  identity: AssertedRow[];
  employment: AssertedRow[];
  /** What this model refuses to hold for anybody, printed so its absence is not read as an oversight. */
  neverComposed: readonly { what: string; because: string }[];
  /** The twin's own account of which aspects it could not read. */
  unreadableAspects: { aspect: string; because: string }[];
}

export function overviewSection(twin: DigitalTwin): SectionPayload<OverviewData> {
  const p = shell<OverviewData>('overview', OWNER_LOCAL);
  const idState = aspectState(twin, 'identity');

  const data: OverviewData = {
    displayName: twin.person.described ? twin.person.displayName : null,
    linkageSentence: twin.person.sentence,
    fullyLinked: !!twin.person.fullyLinked,
    states: (twin.person.states || []).map((s) => ({ kind: s.kind, label: s.label, current: s.current })),
    edges: (twin.person.edges || []).map((e) => ({
      from: e.from, to: e.to, status: e.status, via: e.via, sentence: e.sentence,
    })),
    unconfirmed: (twin.person.unconfirmed || []).map((u) => ({ kind: u.kind, sentence: u.sentence })),
    identity: [
      row('Name', twin.identity?.name),
      row('Employee code', twin.identity?.employeeCode),
      row('Work email', twin.identity?.workEmail),
    ].filter(Boolean) as AssertedRow[],
    employment: [
      row('Designation', twin.employment?.designation),
      row('Department', twin.employment?.departmentName),
      row('Employment type', twin.employment?.employmentType),
      row('Work mode', twin.employment?.workMode),
      row('Status', twin.employment?.employmentStatus),
      row('Joined', twin.employment?.joiningDate),
      row('Confirmed', twin.employment?.confirmationDate),
    ].filter(Boolean) as AssertedRow[],
    neverComposed: twin.neverComposed || [],
    unreadableAspects: (twin.unreadable || []).map((u) => ({ aspect: u.aspect, because: u.because })),
  };

  if (twin.person.readFailed) {
    p.status = 'unreadable';
    p.sentence = 'Part of the identity graph could not be read, so this profile is INCOMPLETE rather than empty. '
      + 'Nothing here says a record does not exist.';
    p.data = data;
    return p;
  }
  if (!idState.read && data.employment.length === 0) {
    p.status = 'withheld';
    p.sentence = idState.because || 'Nothing about who this is was read.';
    return p;
  }

  p.status = 'ok';
  p.sentence = twin.person.sentence;
  p.data = data;

  // The trajectory is the closest thing the Overview has to a signal: each step is something the
  // organisation recorded happening, at a time, with a source.
  const traj = twin.trajectory?.steps || [];
  p.signals = traj.slice(0, 12).map((s, i) => ({
    id: 'traj:' + i,
    label: s.what.slice(0, 80),
    statement: s.what,
    weightClass: 'organisational_record' as SignalWeightClass,
    dataClass: 'raw_source' as const,
    confidence: { value: 0.9, band: bandOf(0.9), basis: 'This organisation recorded the event as it happened.' },
    observedAt: s.at,
    producedBy: OWNER_LOCAL,
    evidence: [{
      ownerModule: s.provenance.source,
      sourceTable: s.provenance.source,
      sourceId: null,
      locator: s.provenance.basis,
      documentUrl: s.provenance.evidenceUrl,
      occurredAt: s.at,
      verificationStatus: s.provenance.assertion,
      sentence: s.provenance.basis,
      href: null,
    }],
    patternIds: [],
    disputed: false,
  }));

  return p;
}

// =================================================================================================
// 2. PROFESSIONAL PROFILE
// =================================================================================================

export interface ProfessionalData {
  employment: AssertedRow[];
  reportingLine: {
    graphReady: boolean;
    sentence: string;
    manager: string | null;
    chain: string[];
    directReports: string[];
  } | null;
  education: { label: string; detail: string | null; period: string | null; assertion: string; verified: string | null }[];
  experience: { label: string; detail: string | null; period: string | null; assertion: string }[];
  skills: { name: string; category: string; level: string; assertion: string; basis: string }[];
  claimed: { keyword: string; from: string; resolved: boolean }[];
  certifications: { certNumber: string; courseTitle: string | null; issuedAt: string | null }[];
  competencies: { name: string; dimension: string; status: string }[];
  /** Aspects the twin did not read, and why. Printed under the panel rather than left blank. */
  notRead: { aspect: string; because: string }[];
}

export function professionalProfileSection(twin: DigitalTwin): SectionPayload<ProfessionalData> {
  const p = shell<ProfessionalData>('professional_profile', OWNER_LOCAL);
  const aspects: TwinAspect[] = ['employment', 'relationships', 'education', 'experience', 'skills', 'certifications', 'competencies', 'claimed_capabilities'];
  const notRead = aspects
    .map((a) => ({ a, s: aspectState(twin, a) }))
    .filter((x) => !x.s.read)
    .map((x) => ({ aspect: x.a, because: x.s.because || 'This aspect was not part of what you were granted.' }));

  const data: ProfessionalData = {
    employment: [
      row('Designation', twin.employment?.designation),
      row('Department', twin.employment?.departmentName),
      row('Employment type', twin.employment?.employmentType),
      row('Work mode', twin.employment?.workMode),
      row('Status', twin.employment?.employmentStatus),
      row('Joined', twin.employment?.joiningDate),
      row('Confirmed', twin.employment?.confirmationDate),
      row('Tenure (days)', twin.employment?.tenureDays as any),
    ].filter(Boolean) as AssertedRow[],
    reportingLine: twin.relationships
      ? {
        graphReady: !!twin.relationships.graphReady,
        sentence: twin.relationships.sentence,
        manager: twin.relationships.manager?.value ? String((twin.relationships.manager.value as any).name || '') : null,
        chain: ((twin.relationships.chain?.value as any[]) || []).map((o) => String(o?.name || '')).filter(Boolean),
        directReports: ((twin.relationships.directReports?.value as any[]) || []).map((o) => String(o?.name || '')).filter(Boolean),
      }
      : null,
    education: (twin.education || []).map((e) => ({
      label: e.label,
      detail: e.detail,
      period: e.period,
      assertion: ASSERTION_LABELS[e.provenance.assertion] || e.provenance.assertion,
      verified: e.verification ? String((e.verification.value as any)?.status || '') : null,
    })),
    experience: (twin.experience || []).map((e) => ({
      label: e.label,
      detail: e.detail,
      period: e.period,
      assertion: ASSERTION_LABELS[e.provenance.assertion] || e.provenance.assertion,
    })),
    skills: (twin.skills || []).map((s) => ({
      name: s.skillName,
      category: s.category,
      level: s.levelLabel,
      assertion: ASSERTION_LABELS[s.provenance.assertion] || s.provenance.assertion,
      basis: s.provenance.basis,
    })),
    claimed: (twin.claimedCapabilities || []).map((c) => ({
      keyword: c.keyword,
      from: c.from,
      resolved: !!c.resolvedSkillId,
    })),
    certifications: (twin.certifications || []).map((c) => ({
      certNumber: c.certNumber,
      courseTitle: c.courseTitle,
      issuedAt: c.issuedAt,
    })),
    competencies: (twin.competencies || []).map((c) => ({ name: c.name, dimension: c.dimension, status: c.status })),
    notRead,
  };

  const anything = data.employment.length + data.education.length + data.experience.length
    + data.skills.length + data.claimed.length + data.certifications.length + data.competencies.length;

  if (anything === 0 && notRead.length === aspects.length) {
    p.status = 'withheld';
    p.sentence = 'No part of the professional record was read. ' + (notRead[0]?.because || '');
    return p;
  }

  p.status = anything > 0 ? 'ok' : 'empty';
  p.sentence = anything > 0
    ? 'Every value below carries who asserted it. A checked level and a stated one are different things and are shown differently.'
    : 'The professional record was read and there is genuinely nothing on it yet.';
  p.data = data;

  // A skill this platform can back is a demonstrated-work signal; a keyword somebody typed is not.
  p.signals = [
    ...(twin.skills || []).slice(0, 25).map((s, i) => ({
      id: 'skill:' + s.skillId + ':' + i,
      label: s.skillName,
      statement: s.skillName + ' at ' + s.levelLabel + '. ' + s.provenance.basis,
      weightClass: (s.provenance.assertion === 'verified' || s.provenance.assertion === 'factual'
        ? 'demonstrated_work'
        : 'self_reported') as SignalWeightClass,
      dataClass: (s.provenance.assertion === 'verified' || s.provenance.assertion === 'factual'
        ? 'raw_source'
        : 'human_feedback') as any,
      confidence: NO_CONFIDENCE,
      observedAt: s.provenance.recordedAt,
      producedBy: OWNER_LOCAL,
      evidence: [{
        ownerModule: 'skills',
        sourceTable: s.provenance.source,
        sourceId: s.skillId,
        locator: s.provenance.basis,
        documentUrl: s.provenance.evidenceUrl,
        occurredAt: s.provenance.recordedAt,
        verificationStatus: s.provenance.assertion,
        sentence: s.provenance.basis,
        href: null,
      }],
      patternIds: [],
      disputed: false,
    })),
  ];

  return p;
}

// =================================================================================================
// 3. PERFORMANCE & WORK RECORDS
// =================================================================================================

export interface PerformanceData {
  reviews: { cycle: string | null; rating: number | null; outcome: string | null; stage: string | null; basis: string }[];
  goals: { title: string; kind: string; status: string; progressPct: number }[];
  projects: { title: string; kind: string; status: string; url: string | null; reviewedAt: string | null }[];
  achievements: { label: string; detail: string | null; url: string | null }[];
  learning: { courseTitle: string; assignedAt: string | null; dueAt: string | null; complete: boolean }[];
  notRead: { aspect: string; because: string }[];
}

export function performanceSection(twin: DigitalTwin): SectionPayload<PerformanceData> {
  const p = shell<PerformanceData>('performance_work_records', OWNER_LOCAL);
  const aspects: TwinAspect[] = ['performance', 'goals', 'projects', 'achievements', 'learning'];
  const notRead = aspects
    .map((a) => ({ a, s: aspectState(twin, a) }))
    .filter((x) => !x.s.read)
    .map((x) => ({ aspect: x.a, because: x.s.because || 'This aspect was not part of what you were granted.' }));

  const data: PerformanceData = {
    reviews: (twin.performance || []).map((r) => ({
      cycle: r.cycleTitle,
      rating: r.rating,
      outcome: r.outcome,
      stage: r.stage,
      basis: r.provenance.basis,
    })),
    goals: (twin.goals || []).map((g) => ({ title: g.title, kind: g.kind, status: g.status, progressPct: g.progressPct })),
    projects: (twin.projects || []).map((x) => ({ title: x.title, kind: x.kind, status: x.status, url: x.url, reviewedAt: x.reviewedAt })),
    achievements: (twin.achievements || []).map((a) => ({ label: a.label, detail: a.detail, url: a.url })),
    learning: (twin.learning || []).map((l) => ({ courseTitle: l.courseTitle, assignedAt: l.assignedAt, dueAt: l.dueAt, complete: l.complete })),
    notRead,
  };

  const anything = data.reviews.length + data.goals.length + data.projects.length + data.achievements.length + data.learning.length;
  if (anything === 0 && notRead.length === aspects.length) {
    p.status = 'withheld';
    p.sentence = 'No part of the work record was read. ' + (notRead[0]?.because || '');
    return p;
  }

  p.status = anything > 0 ? 'ok' : 'empty';
  p.sentence = anything > 0
    ? 'These are the rows the owning modules stored. A rating here is a named human’s verdict in a review cycle, not a system score.'
    : 'The work record was read and there is genuinely nothing on it yet.';
  p.data = data;

  p.signals = [
    ...(twin.performance || []).slice(0, 12).map((r, i) => ({
      id: 'review:' + i,
      label: (r.cycleTitle || 'Review') + (r.outcome ? ' — ' + r.outcome : ''),
      statement: 'Review cycle ' + (r.cycleTitle || 'unnamed') + ': '
        + (r.rating !== null && r.rating !== undefined ? 'rating ' + r.rating + '. ' : '')
        + (r.outcome ? 'Outcome ' + r.outcome + '. ' : '')
        + r.provenance.basis,
      weightClass: 'manager_report' as SignalWeightClass,
      dataClass: 'human_feedback' as const,
      confidence: NO_CONFIDENCE,
      observedAt: r.provenance.recordedAt,
      producedBy: OWNER_LOCAL,
      evidence: [{
        ownerModule: 'performance',
        sourceTable: r.provenance.source,
        sourceId: null,
        locator: r.cycleTitle,
        documentUrl: null,
        occurredAt: r.provenance.recordedAt,
        verificationStatus: r.stage,
        sentence: r.provenance.basis,
        href: null,
      }],
      patternIds: [],
      disputed: false,
    })),
    ...(twin.projects || []).slice(0, 12).map((x, i) => ({
      id: 'project:' + i,
      label: x.title,
      statement: 'Work submitted: ' + x.title + ' (' + x.kind + '), status ' + x.status + '.',
      weightClass: 'demonstrated_work' as SignalWeightClass,
      dataClass: 'raw_source' as const,
      confidence: NO_CONFIDENCE,
      observedAt: x.reviewedAt,
      producedBy: OWNER_LOCAL,
      evidence: [{
        ownerModule: 'projects',
        sourceTable: x.provenance.source,
        sourceId: null,
        locator: x.title,
        documentUrl: x.url,
        occurredAt: x.reviewedAt,
        verificationStatus: x.status,
        sentence: x.provenance.basis,
        href: x.url,
      }],
      patternIds: [],
      disputed: false,
    })),
  ];

  return p;
}

// =================================================================================================
// 4. EVIDENCE & RECORDS — THE BOTTOM TWO RUNGS OF THE LADDER
// =================================================================================================

export interface EvidenceData {
  claims: {
    id: string;
    skill: string;
    category: string;
    level: EvidenceLevel;
    levelLabel: string;
    levelMeaning: string;
    source: string;
    sourceDetail: string | null;
    recordedAt: string | null;
    /** How this subject was reached from the one asked about, when it was reached through a link. */
    linkedVia: string | null;
    /** Route to the full chain: claim -> evidence -> source -> document -> locator -> timestamp. */
    href: string;
  }[];
  /** The identity joins the evidence graph followed to gather these. Printed, never assumed. */
  joins: string[];
  sentence: string;
}

export async function evidenceSection(subject: MeirSubject): Promise<SectionPayload<EvidenceData>> {
  const p = shell<EvidenceData>('evidence_records', OWNER_LOCAL);

  if (!subject.employeeId) {
    p.status = 'empty';
    p.sentence = 'This person has no employee record, so there is no employee subject for the evidence graph to hold claims against. '
      + 'That is a statement about the linkage, not about the person’s capabilities.';
    return p;
  }

  const r = await claimsForSubject({ kind: 'employee', id: subject.employeeId });
  if (!r.ok) {
    p.status = 'unreadable';
    p.sentence = r.sentence;
    return p;
  }

  const claims = (r.claims || []).map((c: ClaimRow) => ({
    id: c.id,
    skill: c.skillName,
    category: c.category,
    level: c.evidenceLevel,
    levelLabel: EVIDENCE_LEVEL_LABELS[c.evidenceLevel] || c.evidenceLevel,
    levelMeaning: EVIDENCE_LEVEL_MEANING[c.evidenceLevel] || '',
    source: c.source,
    sourceDetail: c.sourceDetail,
    recordedAt: c.levelComputedAt || c.createdAt,
    linkedVia: c.linkedVia,
    href: '/admin/skills/evidence?claim=' + encodeURIComponent(c.id),
  }));

  p.status = claims.length ? 'ok' : 'empty';
  p.sentence = r.sentence;
  p.data = { claims, joins: r.joins || [], sentence: r.sentence };

  p.signals = (r.claims || []).slice(0, 40).map((c: ClaimRow) => ({
    id: 'claim:' + c.id,
    label: c.skillName,
    statement: c.skillName + ' — ' + (EVIDENCE_LEVEL_LABELS[c.evidenceLevel] || c.evidenceLevel) + '. '
      + (EVIDENCE_LEVEL_MEANING[c.evidenceLevel] || ''),
    weightClass: WEIGHT_BY_LEVEL[c.evidenceLevel] || 'model_inference',
    dataClass: (c.evidenceLevel === 'inferred' ? 'ai_interpretation' : 'raw_source') as any,
    confidence: CONFIDENCE_BY_LEVEL[c.evidenceLevel] || NO_CONFIDENCE,
    observedAt: c.levelComputedAt || c.createdAt,
    producedBy: 'evidence-graph',
    evidence: [{
      ownerModule: 'evidence-graph',
      sourceTable: 'capability_claims',
      sourceId: c.id,
      locator: c.sourceDetail,
      documentUrl: null,
      occurredAt: c.levelComputedAt || c.createdAt,
      verificationStatus: c.evidenceLevel,
      sentence: 'Claim recorded from ' + c.source + '. Open it to walk down to the evidence rows and the original record.',
      href: '/admin/skills/evidence?claim=' + encodeURIComponent(c.id),
    }] as EvidenceRef[],
    patternIds: [],
    disputed: false,
  }));

  return p;
}

// =================================================================================================
// 5. AUDIT TRAIL — INCLUDING THIS VIEWER'S OWN OPENING OF THIS PAGE
// =================================================================================================

export interface AuditData {
  entries: {
    id: string;
    action: string;
    entity: string;
    at: string | null;
    byUserId: string | null;
    byName: string | null;
    byRole: string | null;
    /** The section, when the row is a HORIZON access row. Null otherwise. */
    section: string | null;
    ip: string | null;
    isHorizonAccess: boolean;
  }[];
  windowDays: number;
  limit: number;
  /** What this tab does NOT cover, said out loud. */
  caveats: string[];
}

export async function auditTrailSection(subject: MeirSubject): Promise<SectionPayload<AuditData>> {
  const p = shell<AuditData>('audit_trail', OWNER_LOCAL);

  const ids = [subject.employeeId, subject.userId].filter(Boolean) as string[];
  if (ids.length === 0) {
    p.status = 'empty';
    p.sentence = 'No employee id and no login id were resolved for this person, so there is nothing to look the audit trail up by.';
    return p;
  }

  const caveats = [
    'This covers the last ' + AUDIT_WINDOW_DAYS + ' days and at most ' + AUDIT_ROW_LIMIT + ' rows, newest first. It is a window, not the whole history.',
    'It shows rows filed against this person’s employee id or login id. An action recorded against a different entity id will not appear here even if it was about them.',
    'Your own opening of this page is written before the page renders, so it should be the first row.',
  ];

  try {
    // ONE query. `created_at` carries an index (audit_created_idx), and the window keeps the scan
    // bounded — this table grows without limit and an unbounded ORDER BY on it would get slower
    // every week the product is alive.
    //
    // The column is never cast. `entity_id::text = $1` would defeat the index on every row in the
    // table, which is a mistake this repository has already paid for elsewhere; the ids go in as
    // ordinary bound parameters and the comparison stays index-usable.
    const idList = sql.join(ids.map((i) => sql`${i}`), sql`, `);
    const r = await db.execute(sql`
      SELECT a.id, a.action, a.entity, a.entity_id, a.created_at, a.ip_address, a.diff,
             a.user_id, u.name AS by_name, u.role AS by_role
        FROM audit_log a
        LEFT JOIN users u ON u.id = a.user_id
       WHERE a.entity_id IN (${idList})
         AND a.created_at > NOW() - (${AUDIT_WINDOW_DAYS} * INTERVAL '1 day')
       ORDER BY a.created_at DESC
       LIMIT ${AUDIT_ROW_LIMIT}`);
    const rows = rowsOf(r);

    const entries = rows.map((x: any) => {
      const diff = x.diff && typeof x.diff === 'object' ? x.diff : {};
      return {
        id: String(x.id),
        action: String(x.action || ''),
        entity: String(x.entity || ''),
        at: iso(x.created_at),
        byUserId: x.user_id ? String(x.user_id) : null,
        byName: x.by_name ? String(x.by_name) : null,
        byRole: x.by_role ? String(x.by_role) : null,
        section: typeof diff.section === 'string' ? diff.section : null,
        ip: x.ip_address ? String(x.ip_address) : null,
        isHorizonAccess: String(x.entity || '') === HORIZON_AUDIT_ENTITY,
      };
    });

    p.status = entries.length ? 'ok' : 'empty';
    p.sentence = entries.length
      ? entries.length + ' audit row' + (entries.length === 1 ? '' : 's') + ' in the last ' + AUDIT_WINDOW_DAYS + ' days.'
      : 'The audit log was read and there is nothing filed against this person in the last ' + AUDIT_WINDOW_DAYS + ' days.';
    p.data = { entries, windowDays: AUDIT_WINDOW_DAYS, limit: AUDIT_ROW_LIMIT, caveats };
    return p;
  } catch (e: any) {
    logFail(MOD, 'auditTrail', e);
    p.status = 'unreadable';
    p.sentence = 'The audit log could not be read just now, so this tab is INCOMPLETE rather than empty. '
      + 'Do not read an empty audit tab as proof that nobody has opened this record. ('
      + String(e?.cause?.message || e?.message || e).slice(0, 200) + ')';
    return p;
  }
}
