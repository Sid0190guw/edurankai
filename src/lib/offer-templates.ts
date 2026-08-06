/**
 * OFFER LETTER TEMPLATES — one per engagement level, held as DATA.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A real offer went out to a Chief AI Officer reading "we are pleased to extend this formal offer
 * of an internship", and "This Full-Time is offered on an unpaid basis in accordance with
 * EduRankAI's Internship Policy", and promising a Certificate of Completion. The cause was not a
 * typo. It was one template set, chosen by hand on a form, with `intern` as the fallback — so the
 * most junior possible reading of a person was also the default reading of a person.
 *
 * Three things are fixed here, and they are fixed structurally rather than by convention:
 *
 *  1. THE TEMPLATE IS SELECTED FROM THE AGREED FIELDS — level, engagement type, role title — not
 *     picked on a form and then trusted. A human may still request one, but the request is an
 *     override: it is validated, it is recorded, and it loses when it contradicts the fields.
 *
 *  2. THERE IS NO INTERN FALLBACK. When nothing matches, selection falls to `neutral`, which is
 *     the most NEUTRAL template and never the most junior. `neutral` carries no unpaid clause and
 *     no certificate, so an unmatched offer says less rather than something false.
 *
 *  3. UNPAID-INTERNSHIP LANGUAGE AND COMPLETION CERTIFICATES EXIST ONLY INSIDE THE INTERNSHIP AND
 *     APPRENTICESHIP TEMPLATE OBJECTS. There is no shared branch that can emit them for anybody
 *     else, because there is no shared branch at all — the sentence is a property of the template.
 *     A senior template has no code path that produces those words. On top of that,
 *     `templatePermits()` re-checks the FINAL choice and drops to `neutral` if a trainee-only
 *     template ever ends up against a level above trainee, whatever route it took to get there.
 *
 * ONE SOURCE OF TRUTH. Both renderers of an offer letter — the HTML letter and the PDF data in
 * src/pages/portal/offer/[token].astro — read their sentences from here. Two copies of this text
 * is exactly how the two renderers drifted and one of them kept saying internship.
 *
 * DATES AND MONEY ARE STRINGS IN, STRINGS OUT. This module formats nothing and computes nothing
 * about a date or an amount; the caller passes display-ready text. That keeps the templates
 * readable and keeps timezone handling in the one place that already does it correctly.
 */

// ---------------------------------------------------------------------------------------------
// Vocabulary. `RoleLevel` mirrors levelEnum in src/lib/db/schema.ts exactly; if that enum gains a
// value, this union fails to compile against it, which is the reminder we want.
// ---------------------------------------------------------------------------------------------

export type RoleLevel = 'C-Level' | 'Lead' | 'Senior' | 'Mid' | 'Junior' | 'Intern' | 'Apprentice';

export type EngagementKind =
  | 'full-time'
  | 'part-time'
  | 'contract'
  | 'internship'
  | 'apprenticeship';

export type SummaryFieldKey =
  | 'roleTitle'
  | 'department'
  | 'employmentType'
  | 'workMode'
  | 'duration'
  | 'hoursCommitment'
  | 'joiningDate'
  | 'reportingTo'
  | 'compensation';

/**
 * Seniority ranking. Only used to answer one question: "is this person senior to a trainee?"
 * Intern and Apprentice share the bottom rank because neither is more junior than the other —
 * they are different programmes, not different rungs.
 */
const LEVEL_RANK: Record<RoleLevel, number> = {
  'C-Level': 6,
  Lead: 5,
  Senior: 4,
  Mid: 3,
  Junior: 2,
  Intern: 1,
  Apprentice: 1,
};

/** Anything above this rank may never be described by an unpaid-programme template. */
const TRAINEE_RANK = 1;

export function levelRank(level: RoleLevel | null | undefined): number {
  return level ? LEVEL_RANK[level] : 0;
}

export const ROLE_LEVELS: readonly RoleLevel[] = [
  'C-Level', 'Lead', 'Senior', 'Mid', 'Junior', 'Intern', 'Apprentice',
];

export const ENGAGEMENT_KINDS: readonly EngagementKind[] = [
  'full-time', 'part-time', 'contract', 'internship', 'apprenticeship',
];

/** Display text for an engagement kind, used when the offer records no employment type of its own. */
const ENGAGEMENT_LABELS: Record<EngagementKind, string> = {
  'full-time': 'Full-Time',
  'part-time': 'Part-Time',
  contract: 'Contract',
  internship: 'Internship',
  apprenticeship: 'Apprenticeship',
};

export function engagementLabel(kind: EngagementKind | null | undefined): string {
  return kind ? ENGAGEMENT_LABELS[kind] : '';
}

// ---------------------------------------------------------------------------------------------
// The template shape.
// ---------------------------------------------------------------------------------------------

export interface OfferTemplate {
  /** Stable id. Stored on an offer as an override request; never shown to a candidate. */
  readonly id: string;
  readonly label: string;
  /** One line of plain English for the admin catalogue, describing who this is for. */
  readonly description: string;

  /** The ONLY levels this template may describe. Selection cannot cross this line. */
  readonly levels: readonly RoleLevel[];
  /** The ONLY engagement kinds this template may describe. */
  readonly engagements: readonly EngagementKind[];

  /**
   * True only for programmes that are unpaid unless a stipend is explicitly recorded. Owning this
   * flag is what entitles a template to hold `engagementTerms` text containing the word unpaid —
   * and `templatePermits()` refuses any such template for a level above trainee.
   */
  readonly unpaidUnlessStipend: boolean;
  /** True only for programmes that end in a Certificate of Completion. */
  readonly awardsCompletionCertificate: boolean;

  /** The opening sentence: what is being offered, to whom, for what role. */
  readonly opening: string;
  /** The human line that follows it — why this person, in the register their level deserves. */
  readonly welcome: string;
  /** The engagement-terms paragraph. Used when no stipend is recorded. */
  readonly engagementTerms: string;
  /** Used instead, when a stipend IS recorded. Present only on unpaid-by-default programmes. */
  readonly engagementTermsWithStipend?: string;
  /** The review / progression paragraph. */
  readonly progression: string;
  /** The completion paragraph. Present ONLY where `awardsCompletionCertificate` is true. */
  readonly completion?: string;
  /** The policy acknowledgement that closes the letter. */
  readonly closing: string;

  /** Which summary fields are relevant to this engagement, in the order they should be read. */
  readonly summaryFields: readonly SummaryFieldKey[];
  /** The two or three facts worth pulling out above the terms. */
  readonly glanceFields: readonly SummaryFieldKey[];

  /** Exactly one template carries this: the one selection falls back to. */
  readonly isNeutralFallback?: boolean;
}

// ---------------------------------------------------------------------------------------------
// The templates.
//
// Placeholders are resolved by `resolveFields()` below. Values that always have a sensible neutral
// default are written inline ({roleTitle}, {joiningDate}, {workMode}, {duration}, {hoursCommitment},
// {compensation}, {employmentType}, {org}). Genuinely optional facts are written as *clauses*
// ({departmentClause}, {reportingClause}, {compensationClause}) so that an absent value removes a
// sentence rather than leaving a gap or a lie in the middle of one.
//
// **double asterisks** mark emphasis. `emphasize()` turns them into <strong> without ever handing
// a field value to set:html.
// ---------------------------------------------------------------------------------------------

const CLOSING =
  'By accepting, you confirm that you have read and agree to {org}’s Recruitment and Work ' +
  'Policy and Code of Conduct.';

const EXECUTIVE: OfferTemplate = {
  id: 'executive',
  label: 'Executive (C-Level)',
  description: 'Chief officers and equivalent. No probationary programme, no fixed term, reviewed with the leadership group.',
  levels: ['C-Level'],
  engagements: ['full-time', 'part-time', 'contract'],
  unpaidUnlessStipend: false,
  awardsCompletionCertificate: false,
  opening:
    'We are glad to extend this formal offer to join the leadership of {org} as **{roleTitle}**{departmentClause}. ' +
    'This appointment was weighed carefully, and we would like you to take it on.',
  welcome:
    'Serious people were considered for this. You are here because of the judgement and the standard you ' +
    'brought to every conversation, and because of the work we expect you to lead.',
  engagementTerms:
    'This is a **{employmentType}** appointment commencing **{joiningDate}**, working **{workMode}**. ' +
    'Compensation is **{compensation}**.{reportingClause} The appointment is subject to the pre-appointment ' +
    'checks already described to you, and every term of your engagement is confirmed with you in writing ' +
    'before your start date rather than assumed.',
  progression:
    'Your work is reviewed against objectives agreed directly with you, on the cycle set for the leadership ' +
    'group. There is no probationary programme and no fixed assessment term attached to this appointment.',
  closing: CLOSING,
  summaryFields: ['roleTitle', 'department', 'employmentType', 'workMode', 'joiningDate', 'reportingTo', 'compensation'],
  glanceFields: ['workMode', 'joiningDate', 'compensation'],
};

const LEADERSHIP: OfferTemplate = {
  id: 'leadership',
  label: 'Leadership (Lead)',
  description: 'Leads, heads and principals who carry a team as well as the work.',
  levels: ['Lead'],
  engagements: ['full-time', 'part-time', 'contract'],
  unpaidUnlessStipend: false,
  awardsCompletionCertificate: false,
  opening:
    'We are pleased to extend this formal offer for the position of **{roleTitle}**{departmentClause} at {org}, ' +
    'leading the team and the work that goes with it.',
  welcome:
    'Plenty of capable people applied. You are here because of the judgement and the standard you brought to ' +
    'every conversation, and we are looking forward to the work you will lead.',
  engagementTerms:
    'This is a **{employmentType}** engagement commencing **{joiningDate}**, working **{workMode}**. ' +
    'Compensation is **{compensation}**.{reportingClause} Onboarding details, including the team you will be ' +
    'accountable for, are confirmed within seven days of your acceptance.',
  progression:
    'Your work is reviewed against objectives agreed with you after joining, on the cycle that applies to leads, ' +
    'alongside the progress of the people you are accountable for.',
  closing: CLOSING,
  summaryFields: ['roleTitle', 'department', 'employmentType', 'workMode', 'joiningDate', 'reportingTo', 'compensation'],
  glanceFields: ['workMode', 'joiningDate', 'compensation'],
};

const SENIOR: OfferTemplate = {
  id: 'senior',
  label: 'Senior',
  description: 'Senior individual contributors. Reviewed on the standard cycle, with a standard-setting expectation.',
  levels: ['Senior'],
  engagements: ['full-time', 'part-time', 'contract'],
  unpaidUnlessStipend: false,
  awardsCompletionCertificate: false,
  opening:
    'We are pleased to extend this formal offer for the position of **{roleTitle}**{departmentClause} at {org}.',
  welcome:
    'Plenty of capable people applied. You are here because of the judgement and the standard you brought to ' +
    'every conversation, and we are looking forward to the work you will do here.',
  engagementTerms:
    'This is a **{employmentType}** engagement commencing **{joiningDate}**, working **{workMode}**. ' +
    'Compensation is **{compensation}**.{reportingClause} The offer is subject to the pre-employment ' +
    'requirements already described to you; onboarding details follow within seven days of acceptance.',
  progression:
    'Your work is reviewed against objectives agreed with you after joining, on the review cycle that applies to ' +
    'your role. Senior colleagues are also asked to help set the standard for the people around them, and that ' +
    'is part of what is reviewed.',
  closing: CLOSING,
  summaryFields: ['roleTitle', 'department', 'employmentType', 'workMode', 'joiningDate', 'reportingTo', 'compensation'],
  glanceFields: ['workMode', 'joiningDate', 'compensation'],
};

const PROFESSIONAL: OfferTemplate = {
  id: 'professional',
  label: 'Professional (Mid)',
  description: 'Experienced individual contributors on a standard employment engagement.',
  levels: ['Mid'],
  engagements: ['full-time', 'part-time'],
  unpaidUnlessStipend: false,
  awardsCompletionCertificate: false,
  opening:
    'We are pleased to extend this formal offer for the position of **{roleTitle}**{departmentClause} at {org}.',
  welcome:
    'Plenty of capable people applied. You are here because of how you thought about the work and the standard ' +
    'you held yourself to while doing it.',
  engagementTerms:
    'This is a **{employmentType}** engagement commencing **{joiningDate}**, working **{workMode}**, committing ' +
    '**{hoursCommitment}**. Compensation is **{compensation}**.{reportingClause} The offer is subject to the ' +
    'pre-employment requirements already described to you; onboarding details follow within seven days of acceptance.',
  progression:
    'Your work is reviewed against objectives agreed with you after joining, on the review cycle that applies to ' +
    'your role. The first of those comes early enough to be useful rather than ceremonial.',
  closing: CLOSING,
  summaryFields: ['roleTitle', 'department', 'employmentType', 'workMode', 'hoursCommitment', 'joiningDate', 'reportingTo', 'compensation'],
  glanceFields: ['workMode', 'joiningDate', 'compensation'],
};

const EARLY_CAREER: OfferTemplate = {
  id: 'early-career',
  label: 'Early career (Junior)',
  description: 'Junior employees. An employment engagement with structured support — NOT an internship, and it carries no certificate.',
  levels: ['Junior'],
  engagements: ['full-time', 'part-time'],
  unpaidUnlessStipend: false,
  awardsCompletionCertificate: false,
  opening:
    'We are pleased to extend this formal offer for the position of **{roleTitle}**{departmentClause} at {org}.',
  welcome:
    'You are early in your career, and this role is written for exactly that. You are here because of how you ' +
    'thought about the problems we put in front of you.',
  engagementTerms:
    'This is a **{employmentType}** engagement commencing **{joiningDate}**, working **{workMode}**, committing ' +
    '**{hoursCommitment}**. Compensation is **{compensation}**.{reportingClause} The offer is subject to the ' +
    'pre-employment requirements already described to you; onboarding details follow within seven days of acceptance.',
  progression:
    'You are given a named person to learn from and regular one-to-one reviews through your first months, then ' +
    'the review cycle that applies to your role. Nothing in this letter assumes you already know everything.',
  closing: CLOSING,
  summaryFields: ['roleTitle', 'department', 'employmentType', 'workMode', 'hoursCommitment', 'joiningDate', 'reportingTo', 'compensation'],
  glanceFields: ['workMode', 'joiningDate', 'compensation'],
};

const CONTRACT: OfferTemplate = {
  id: 'contract',
  label: 'Contract engagement',
  description: 'Fixed-term contract or consulting engagements at any level. Reviewed against a statement of work, not an employment cycle.',
  levels: ['C-Level', 'Lead', 'Senior', 'Mid', 'Junior'],
  engagements: ['contract'],
  unpaidUnlessStipend: false,
  awardsCompletionCertificate: false,
  opening:
    'We are pleased to extend this contract engagement for the position of **{roleTitle}**{departmentClause} at {org}.',
  welcome:
    'We came to you for specific work and a specific standard, and we are glad you are willing to take it on.',
  engagementTerms:
    'This is a **{employmentType}** engagement running for **{duration}**, commencing **{joiningDate}**, working ' +
    '**{workMode}**. Fees are **{compensation}**.{reportingClause} Deliverables, milestones and any change of ' +
    'scope are recorded in the statement of work accompanying this letter.',
  progression:
    'Progress is reviewed against the deliverables in the statement of work rather than an employment review ' +
    'cycle. Either side may raise a change of scope in writing at any point in the engagement.',
  closing: CLOSING,
  summaryFields: ['roleTitle', 'department', 'employmentType', 'workMode', 'duration', 'joiningDate', 'reportingTo', 'compensation'],
  glanceFields: ['duration', 'workMode', 'compensation'],
};

/**
 * INTERNSHIP — one of only two templates in this file that is allowed to contain the words unpaid,
 * Internship Policy, mid-point review or Certificate of Completion. `levels: ['Intern']` plus the
 * trainee-rank check in `templatePermits()` is what makes it structurally unable to describe a
 * Chief Officer, whatever a form says.
 */
const INTERNSHIP: OfferTemplate = {
  id: 'internship',
  label: 'Internship',
  description: 'Interns only. Unpaid unless a stipend is explicitly recorded. The only template, with apprenticeship, that mentions a completion certificate.',
  levels: ['Intern'],
  engagements: ['internship'],
  unpaidUnlessStipend: true,
  awardsCompletionCertificate: true,
  opening:
    'We are pleased to extend this formal offer of an internship for the position of ' +
    '**{roleTitle}**{departmentClause} at {org}.',
  welcome:
    'Plenty of people applied. You are here because of how you thought about the problems we put in front of ' +
    'you, and we are looking forward to what you build while you are with us.',
  engagementTerms:
    'This internship is offered on an **unpaid** basis, in accordance with {org}’s Internship Policy. ' +
    'You will work **{workMode}**, committing **{hoursCommitment}** of focused effort, for **{duration}**, ' +
    'commencing **{joiningDate}**.{reportingClause}{compensationClause}',
  engagementTermsWithStipend:
    'This internship carries a stipend of **{compensation}**. You will work **{workMode}**, committing ' +
    '**{hoursCommitment}** of focused effort, for **{duration}**, commencing **{joiningDate}**.{reportingClause}',
  progression:
    'You will have a mid-point review and a final review, both assessed against {org}’s published rubric so ' +
    'that you can see how the judgement was reached rather than only what it was.',
  completion:
    'Interns who complete the internship successfully receive a Certificate of Completion recording the work ' +
    'they did here. It is a record of the internship and not an academic qualification. Interns whose work ' +
    'stands out may also be offered a Letter of Recommendation.',
  closing: CLOSING,
  summaryFields: ['roleTitle', 'department', 'employmentType', 'workMode', 'duration', 'hoursCommitment', 'joiningDate', 'reportingTo', 'compensation'],
  glanceFields: ['duration', 'hoursCommitment', 'compensation'],
};

const APPRENTICESHIP: OfferTemplate = {
  id: 'apprenticeship',
  label: 'Apprenticeship',
  description: 'Apprentices only. A structured competency pathway, unpaid unless a stipend is explicitly recorded.',
  levels: ['Apprentice'],
  engagements: ['apprenticeship'],
  unpaidUnlessStipend: true,
  awardsCompletionCertificate: true,
  opening:
    'We are pleased to extend this formal offer of an apprenticeship for the position of ' +
    '**{roleTitle}**{departmentClause} at {org}.',
  welcome:
    'An apprenticeship is a commitment on both sides. You are here because of how you approached the work we ' +
    'set you, and we intend to teach you the rest properly.',
  engagementTerms:
    'This apprenticeship is offered on an **unpaid** basis, in accordance with {org}’s published hiring ' +
    'policy. You will work **{workMode}**, committing **{hoursCommitment}**, for **{duration}**, commencing ' +
    '**{joiningDate}**.{reportingClause}{compensationClause}',
  engagementTermsWithStipend:
    'This apprenticeship carries a stipend of **{compensation}**. You will work **{workMode}**, committing ' +
    '**{hoursCommitment}**, for **{duration}**, commencing **{joiningDate}**.{reportingClause}',
  progression:
    'Apprentices follow a structured competency pathway. Your progress is assessed at agreed checkpoints against ' +
    'that pathway rather than against a general performance cycle.',
  completion:
    'Apprentices who complete the pathway successfully receive a Certificate of Completion recording the ' +
    'competencies demonstrated. It is a record of the apprenticeship and not an academic qualification: {org} ' +
    'is the technology platform, and where an accredited credential is involved it is awarded by an accredited ' +
    'partner rather than by us.',
  closing: CLOSING,
  summaryFields: ['roleTitle', 'department', 'employmentType', 'workMode', 'duration', 'hoursCommitment', 'joiningDate', 'reportingTo', 'compensation'],
  glanceFields: ['duration', 'hoursCommitment', 'compensation'],
};

/**
 * NEUTRAL — the fallback, and deliberately the most neutral rather than the most junior template.
 * It claims no seniority, promises no certificate, and never says unpaid. When the agreed fields do
 * not identify an engagement, an offer written from here says less; it does not say something false
 * about the person reading it.
 */
const NEUTRAL: OfferTemplate = {
  id: 'neutral',
  label: 'Neutral (fallback)',
  description: 'Used whenever the agreed fields do not identify a level and engagement. Claims no seniority, promises no certificate, never says unpaid.',
  levels: ['C-Level', 'Lead', 'Senior', 'Mid', 'Junior', 'Intern', 'Apprentice'],
  engagements: ['full-time', 'part-time', 'contract', 'internship', 'apprenticeship'],
  unpaidUnlessStipend: false,
  awardsCompletionCertificate: false,
  opening:
    'We are pleased to extend this formal offer for the position of **{roleTitle}**{departmentClause} at {org}. ' +
    'Following a thorough evaluation of your application and our conversations, we are confident you bring the ' +
    'capability, character and commitment we look for.',
  welcome:
    'Plenty of capable people applied. You are here because of the judgement and the standard you brought to ' +
    'every conversation.',
  engagementTerms:
    'This engagement commences **{joiningDate}**, working **{workMode}**.{employmentTypeClause}{durationClause} ' +
    'Compensation is **{compensation}**.{reportingClause} Anything not stated in this letter is confirmed with ' +
    'you in writing before your start date rather than assumed.',
  progression:
    'Your work is reviewed against objectives agreed with you after joining, on the cycle that applies to your role.',
  closing: CLOSING,
  summaryFields: ['roleTitle', 'department', 'employmentType', 'workMode', 'duration', 'hoursCommitment', 'joiningDate', 'reportingTo', 'compensation'],
  glanceFields: ['workMode', 'joiningDate', 'compensation'],
  isNeutralFallback: true,
};

export const OFFER_TEMPLATES: readonly OfferTemplate[] = [
  EXECUTIVE, LEADERSHIP, SENIOR, PROFESSIONAL, EARLY_CAREER,
  CONTRACT, INTERNSHIP, APPRENTICESHIP, NEUTRAL,
];

export const NEUTRAL_TEMPLATE_ID = NEUTRAL.id;

export function getOfferTemplate(id: string | null | undefined): OfferTemplate | null {
  if (!id) return null;
  const key = String(id).trim().toLowerCase();
  return OFFER_TEMPLATES.find((t) => t.id === key) || null;
}

// ---------------------------------------------------------------------------------------------
// Reading the agreed fields.
// ---------------------------------------------------------------------------------------------

export interface AgreedFields {
  /** applications.level / roles.level, when recorded. */
  level?: string | null;
  roleTitle?: string | null;
  employmentType?: string | null;
  department?: string | null;
  workMode?: string | null;
  duration?: string | null;
  hoursCommitment?: string | null;
  /** Display-ready. This module never formats a date. */
  joiningDate?: string | null;
  reportingTo?: string | null;
  compensation?: string | null;
  candidateName?: string | null;
  /** Defaults to EduRankAI. Present so the same templates serve a partner brand letter. */
  org?: string | null;
}

/**
 * \b intern (?!al) is the same word-boundary pattern src/lib/auth/admin-access.ts uses, so an
 * "Internal Auditor" is never read as an intern. Every pattern below is anchored on word
 * boundaries for the same reason: "Principal" must not match inside another word, and "Head of
 * Design" must match while "Overhead" does not.
 */
const INTERN_PATTERN = /\bintern(?!al)\w*/i;
const APPRENTICE_PATTERN = /\bapprentice\w*/i;

/**
 * Title patterns, most senior first. Order is the safety property: a title is read at the HIGHEST
 * seniority it matches, so "Senior Intern" resolves to Senior and can never reach the internship
 * template. Reading a person more junior than their title is the failure this file exists to stop.
 */
const TITLE_LEVEL_PATTERNS: readonly { pattern: RegExp; level: RoleLevel }[] = [
  { pattern: /\b(chief|c[-\s]?level|cxo|c\.?[teofimdps]\.?o\.?|president|vice[-\s]president|\bvp\b)\b/i, level: 'C-Level' },
  { pattern: /\b(head\s+of|director|principal|lead|leader|manager|architect)\b/i, level: 'Lead' },
  { pattern: /\b(senior|sr\.?|staff)\b/i, level: 'Senior' },
  { pattern: /\b(mid[-\s]?level|associate)\b/i, level: 'Mid' },
  { pattern: /\b(junior|jr\.?|graduate|trainee|entry[-\s]level)\b/i, level: 'Junior' },
  { pattern: APPRENTICE_PATTERN, level: 'Apprentice' },
  { pattern: INTERN_PATTERN, level: 'Intern' },
];

/** Turns whatever is stored in a level column into one of the seven, or null. */
export function normalizeLevel(raw: string | null | undefined): RoleLevel | null {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase().replace(/[\s_]+/g, '-');
  const found = ROLE_LEVELS.find((l) => l.toLowerCase() === s);
  if (found) return found;
  if (s === 'clevel' || s === 'c-level' || s === 'exec' || s === 'executive') return 'C-Level';
  return null;
}

export function inferLevelFromTitle(title: string | null | undefined): RoleLevel | null {
  if (!title) return null;
  const t = String(title);
  for (const entry of TITLE_LEVEL_PATTERNS) {
    if (entry.pattern.test(t)) return entry.level;
  }
  return null;
}

const ENGAGEMENT_PATTERNS: readonly { pattern: RegExp; kind: EngagementKind }[] = [
  { pattern: APPRENTICE_PATTERN, kind: 'apprenticeship' },
  { pattern: INTERN_PATTERN, kind: 'internship' },
  { pattern: /\b(contract|contractor|consult\w*|freelance|retainer|sow)\b/i, kind: 'contract' },
  { pattern: /\bpart[-\s]?time\b/i, kind: 'part-time' },
  { pattern: /\b(full[-\s]?time|permanent|fulltime|employee|employment)\b/i, kind: 'full-time' },
];

export function inferEngagement(raw: string | null | undefined): EngagementKind | null {
  if (!raw) return null;
  const s = String(raw);
  for (const entry of ENGAGEMENT_PATTERNS) {
    if (entry.pattern.test(s)) return entry.kind;
  }
  return null;
}

/**
 * Legacy `offer_letters.template_type` values. They predate this file and are still written by the
 * offer form, so they are read here as an override REQUEST expressed in the old vocabulary — never
 * as an instruction. `fulltime` mapped to no template at all: it is a statement about the
 * engagement, not about seniority, so it is used only as an engagement hint below.
 */
const LEGACY_TEMPLATE_ALIASES: Record<string, string | null> = {
  intern: 'internship',
  interns: 'internship',
  internship: 'internship',
  apprentice: 'apprenticeship',
  apprenticeship: 'apprenticeship',
  contract: 'contract',
  contractor: 'contract',
  leadership: 'leadership',
  executive: 'executive',
  senior: 'senior',
  fulltime: null,
  'full-time': null,
  standard: null,
  default: null,
};

const LEGACY_ENGAGEMENT_HINTS: Record<string, EngagementKind> = {
  intern: 'internship',
  interns: 'internship',
  internship: 'internship',
  apprentice: 'apprenticeship',
  apprenticeship: 'apprenticeship',
  contract: 'contract',
  contractor: 'contract',
  fulltime: 'full-time',
  'full-time': 'full-time',
  leadership: 'full-time',
  executive: 'full-time',
  senior: 'full-time',
};

/** Resolves an override request (new id or legacy value) to a template id, or null for "no request". */
export function resolveRequestedTemplateId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const key = String(raw).trim().toLowerCase();
  if (!key) return null;
  if (Object.prototype.hasOwnProperty.call(LEGACY_TEMPLATE_ALIASES, key)) {
    return LEGACY_TEMPLATE_ALIASES[key];
  }
  return getOfferTemplate(key) ? key : null;
}

// ---------------------------------------------------------------------------------------------
// Selection. Rules are data, evaluated in order; the first match wins; no match means NEUTRAL.
// ---------------------------------------------------------------------------------------------

interface SelectionRule {
  readonly levels?: readonly RoleLevel[];
  readonly engagements?: readonly EngagementKind[];
  /**
   * Allows the rule to fire when no level is recorded anywhere. Set ONLY on the two programme
   * rules, and only because their engagement kind is itself the positive statement: an engagement
   * type reading "Internship" IS the fields saying intern. It is not a fallback — a title or a
   * level naming any seniority makes `level` non-null and the rule stops matching immediately.
   */
  readonly allowUnknownLevel?: boolean;
  readonly use: string;
}

/**
 * Every rule requires a POSITIVE match on both dimensions it names. A rule naming levels does not
 * fire on an unknown level (unless it opts in above), and a rule naming engagements does not fire
 * on an unknown engagement. That is what removes the intern fallback: an internship letter now
 * requires the fields to say internship, and anything short of that lands on NEUTRAL.
 *
 * Note the asymmetry, and that it is deliberate: the seniority templates do NOT opt into an
 * unknown level, because their copy claims a seniority the fields have not established. An
 * unmatched full-time offer is written from the neutral template and says less. Only the trainee
 * programmes may be identified by their engagement alone, and they are the ones the safety check
 * below refuses for anybody above trainee rank.
 */
const SELECTION_RULES: readonly SelectionRule[] = [
  { levels: ['Intern'], engagements: ['internship'], allowUnknownLevel: true, use: INTERNSHIP.id },
  { levels: ['Apprentice'], engagements: ['apprenticeship'], allowUnknownLevel: true, use: APPRENTICESHIP.id },
  { levels: ['C-Level'], engagements: ['full-time', 'part-time'], use: EXECUTIVE.id },
  { levels: ['C-Level'], engagements: ['contract'], use: EXECUTIVE.id },
  { levels: ['Lead'], engagements: ['full-time', 'part-time'], use: LEADERSHIP.id },
  { levels: ['Senior'], engagements: ['full-time', 'part-time'], use: SENIOR.id },
  { levels: ['Mid'], engagements: ['full-time', 'part-time'], use: PROFESSIONAL.id },
  { levels: ['Junior'], engagements: ['full-time', 'part-time'], use: EARLY_CAREER.id },
  { engagements: ['contract'], use: CONTRACT.id },
];

/**
 * THE LAST LINE. Applied to the FINAL choice no matter how it was reached — rule, human override,
 * or a future bug in either. A template may only describe a level and an engagement it declares,
 * and an unpaid-programme template may never describe anyone above trainee rank. NEUTRAL permits
 * everything, so falling back always terminates.
 */
export function templatePermits(
  template: OfferTemplate,
  level: RoleLevel | null,
  engagement: EngagementKind | null,
): boolean {
  if (level && !template.levels.includes(level)) return false;
  if (engagement && !template.engagements.includes(engagement)) return false;
  if (
    (template.unpaidUnlessStipend || template.awardsCompletionCertificate) &&
    level &&
    levelRank(level) > TRAINEE_RANK
  ) {
    return false;
  }
  return true;
}

export interface OfferTemplateDecision {
  readonly template: OfferTemplate;
  readonly level: RoleLevel | null;
  /** Where the level came from, so an admin can see why the letter reads as it does. */
  readonly levelSource: 'recorded' | 'title' | 'recorded+title' | 'unknown';
  readonly engagement: EngagementKind | null;
  readonly engagementSource: 'employment-type' | 'role-title' | 'legacy-template' | 'unknown';
  /** Raw value the human asked for, exactly as stored. Null when nothing was requested. */
  readonly overrideRequested: string | null;
  readonly overrideResolvedId: string | null;
  readonly overrideAccepted: boolean;
  /** Human-readable record of every refusal and conflict. Written into the audit trail on signing. */
  readonly notes: readonly string[];
  /** True when nothing matched and the neutral template carried the letter. */
  readonly usedNeutralFallback: boolean;
}

export function decideOfferTemplate(
  fields: AgreedFields,
  requestedTemplateType?: string | null,
): OfferTemplateDecision {
  const notes: string[] = [];

  // --- level -------------------------------------------------------------------------------
  const recorded = normalizeLevel(fields.level);
  const fromTitle = inferLevelFromTitle(fields.roleTitle);
  let level: RoleLevel | null = null;
  let levelSource: OfferTemplateDecision['levelSource'] = 'unknown';

  if (recorded && fromTitle) {
    // The MORE SENIOR of the two wins. A letter is never allowed to describe someone as more
    // junior than their own job title says they are.
    level = levelRank(fromTitle) > levelRank(recorded) ? fromTitle : recorded;
    levelSource = 'recorded+title';
    if (recorded !== fromTitle) {
      notes.push(
        'The recorded level (' + recorded + ') and the role title (' + String(fields.roleTitle || '').trim() +
        ', which reads as ' + fromTitle + ') disagree. The letter uses ' + level +
        ', the more senior of the two, and never the more junior.',
      );
    }
  } else if (recorded) {
    level = recorded;
    levelSource = 'recorded';
  } else if (fromTitle) {
    level = fromTitle;
    levelSource = 'title';
  }

  // --- engagement --------------------------------------------------------------------------
  let engagement = inferEngagement(fields.employmentType);
  let engagementSource: OfferTemplateDecision['engagementSource'] = 'employment-type';
  if (!engagement) {
    engagement = inferEngagement(fields.roleTitle);
    engagementSource = 'role-title';
  }
  if (!engagement && requestedTemplateType) {
    const hint = LEGACY_ENGAGEMENT_HINTS[String(requestedTemplateType).trim().toLowerCase()];
    if (hint) {
      engagement = hint;
      engagementSource = 'legacy-template';
    }
  }
  if (!engagement) engagementSource = 'unknown';

  // A senior level against an unpaid programme is the exact shape of the failure. Say so out loud
  // before selection, so the record explains the neutral letter rather than leaving it mysterious.
  if (
    engagement &&
    (engagement === 'internship' || engagement === 'apprenticeship') &&
    level &&
    levelRank(level) > TRAINEE_RANK
  ) {
    notes.push(
      'The engagement type reads as an ' + engagement + ' but the level is ' + level +
      '. No unpaid-programme letter can describe a ' + level +
      ' engagement, so the neutral template is used and this needs a human decision.',
    );
  }

  // --- rule match --------------------------------------------------------------------------
  let chosen: OfferTemplate = NEUTRAL;
  let matchedRule = false;
  for (const rule of SELECTION_RULES) {
    if (rule.levels) {
      if (level) {
        if (!rule.levels.includes(level)) continue;
      } else if (!rule.allowUnknownLevel) {
        continue;
      }
    }
    if (rule.engagements && (!engagement || !rule.engagements.includes(engagement))) continue;
    const candidate = getOfferTemplate(rule.use);
    if (candidate && templatePermits(candidate, level, engagement)) {
      chosen = candidate;
      matchedRule = true;
      break;
    }
  }
  if (!matchedRule) {
    notes.push(
      'No template matched the agreed fields (level: ' + (level || 'not recorded') +
      ', engagement: ' + (engagement || 'not recorded') +
      '). The neutral template was used. It is never the intern template.',
    );
  }

  // --- human override ----------------------------------------------------------------------
  // A human may ask for a specific template. The request is honoured only when the agreed fields
  // permit it; otherwise it is refused and the refusal is recorded. This is the rule that keeps a
  // hand-picked intern template off a Chief Officer's letter.
  const overrideRequested = requestedTemplateType ? String(requestedTemplateType).trim() : null;
  const overrideResolvedId = resolveRequestedTemplateId(requestedTemplateType);
  let overrideAccepted = false;

  if (overrideResolvedId) {
    const requested = getOfferTemplate(overrideResolvedId);
    if (!requested) {
      notes.push('Template "' + overrideRequested + '" was requested but no such template exists. Ignored.');
    } else if (requested.id === chosen.id) {
      overrideAccepted = true;
    } else if (templatePermits(requested, level, engagement)) {
      const displacedLabel = chosen.label;
      chosen = requested;
      overrideAccepted = true;
      notes.push(
        'Template "' + requested.label + '" was chosen by hand instead of "' + displacedLabel +
        '". The agreed fields permit it, so it was accepted and recorded here.',
      );
    } else {
      const why = (requested.unpaidUnlessStipend || requested.awardsCompletionCertificate) &&
        level && levelRank(level) > TRAINEE_RANK
        ? 'that template carries unpaid-programme language and cannot describe a ' + level + ' engagement'
        : 'the agreed fields (level: ' + (level || 'not recorded') + ', engagement: ' +
          (engagement || 'not recorded') + ') do not permit it';
      notes.push(
        'REFUSED: template "' + requested.label + '" was requested by hand, but ' + why +
        '. The letter was written from "' + chosen.label + '" instead.',
      );
    }
  }

  // --- the last line -----------------------------------------------------------------------
  if (!templatePermits(chosen, level, engagement)) {
    notes.push(
      'Safety check: "' + chosen.label + '" is not permitted for level ' + (level || 'unknown') +
      ' / engagement ' + (engagement || 'unknown') + '. Fell back to the neutral template.',
    );
    chosen = NEUTRAL;
  }

  return {
    template: chosen,
    level,
    levelSource,
    engagement,
    engagementSource,
    overrideRequested,
    overrideResolvedId,
    overrideAccepted,
    notes,
    usedNeutralFallback: chosen.id === NEUTRAL.id,
  };
}

// ---------------------------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------------------------

const FIELD_LABELS: Record<SummaryFieldKey, string> = {
  roleTitle: 'Position',
  department: 'Department',
  employmentType: 'Engagement Type',
  workMode: 'Work Mode',
  duration: 'Duration',
  hoursCommitment: 'Working Hours',
  joiningDate: 'Joining Date',
  reportingTo: 'Reporting To',
  compensation: 'Compensation',
};

export function summaryFieldLabel(key: SummaryFieldKey): string {
  return FIELD_LABELS[key];
}

const DEFAULT_ORG = 'EduRankAI';

function txt(v: string | null | undefined): string {
  return v == null ? '' : String(v).trim();
}

/**
 * Does the recorded compensation amount to a stipend? A field reading "Unpaid", "None", "N/A" or
 * "To be discussed" is not a stipend, and neither is an empty field. Anything else is treated as a
 * stipend having been explicitly recorded — which is the direction the house rule points: an
 * internship is unpaid UNLESS a stipend is explicitly recorded.
 */
const NO_STIPEND_PATTERN =
  /^\s*(unpaid|none|nil|n\/?a|not applicable|no stipend|no compensation|tbd|to be (discussed|confirmed|decided))\b/i;

export function stipendIsRecorded(compensation: string | null | undefined): boolean {
  const s = txt(compensation);
  if (!s) return false;
  return !NO_STIPEND_PATTERN.test(s);
}

/**
 * True when the compensation field says something beyond the bare word "Unpaid" — the internship
 * presets append conversion rewards and completion awards to it, and those must reach the letter
 * even though the engagement itself is unpaid.
 */
function compensationCarriesDetail(compensation: string | null | undefined): boolean {
  const s = txt(compensation);
  if (!s) return false;
  const stripped = s.replace(NO_STIPEND_PATTERN, '').replace(/^[\s.,;:-]+/, '');
  return stripped.length > 3;
}

interface ResolvedFields {
  [key: string]: string;
}

/**
 * A field value dropped into the MIDDLE of a sentence must not bring its own full stop with it.
 * The compensation presets end in one ("...(finalised at offer)."), and the template supplies the
 * sentence's own, which printed "offer).." on a real letter. Trailing punctuation is stripped for
 * inline use only; the value is untouched everywhere it is quoted whole.
 */
function inline(v: string): string {
  return v.replace(/[\s.;,]+$/, '');
}

/** A value quoted as a whole sentence keeps its punctuation, and is given one if it has none. */
function sentence(v: string): string {
  const s = v.trim();
  if (!s) return '';
  return /[.!?]$/.test(s) ? s : s + '.';
}

function resolveFields(fields: AgreedFields, decision: OfferTemplateDecision): ResolvedFields {
  const org = txt(fields.org) || DEFAULT_ORG;
  const department = txt(fields.department);
  const reportingTo = txt(fields.reportingTo);
  const compensation = txt(fields.compensation);
  const duration = txt(fields.duration);
  const employmentType = txt(fields.employmentType) || engagementLabel(decision.engagement);

  return {
    org,
    candidateName: txt(fields.candidateName),
    firstName: txt(fields.candidateName).split(' ')[0] || '',
    roleTitle: inline(txt(fields.roleTitle)) || 'the role described in this letter',
    department: inline(department),
    departmentClause: department ? ' within ' + inline(department) : '',
    employmentType: inline(employmentType) || 'the engagement described in this letter',
    employmentTypeClause: employmentType ? ' It is recorded as **' + inline(employmentType) + '**.' : '',
    workMode: inline(txt(fields.workMode)) || 'the agreed work arrangement',
    duration: inline(duration) || 'the agreed term',
    durationClause: duration ? ' It runs for **' + inline(duration) + '**.' : '',
    hoursCommitment: inline(txt(fields.hoursCommitment)) || 'the agreed hours',
    joiningDate: inline(txt(fields.joiningDate)) || 'a mutually agreed date',
    reportingTo: inline(reportingTo),
    reportingClause: reportingTo ? ' You will report to **' + inline(reportingTo) + '**.' : '',
    compensation: inline(compensation) || 'as recorded in the offer summary',
    // Quoted whole: the internship presets record a conversion reward and a completion award here,
    // and every word of that has to reach the person the letter is about.
    compensationClause: compensationCarriesDetail(compensation)
      ? ' The compensation terms recorded against this engagement are: ' + sentence(compensation)
      : '',
  };
}

/** Replaces {placeholders}. An unknown placeholder is removed rather than printed at a candidate. */
export function interpolate(template: string, values: ResolvedFields): string {
  return template
    .replace(/\{(\w+)\}/g, (_m, key: string) => (key in values ? values[key] : ''))
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export interface EmphasisPart {
  readonly text: string;
  readonly bold: boolean;
}

/**
 * Splits **emphasis** into parts. Deliberately returns data rather than HTML: the caller renders
 * <strong>{part.text}</strong> through normal JSX escaping, so a field value can never become
 * markup. Nothing in an offer letter is ever passed to set:html.
 */
export function emphasize(text: string): EmphasisPart[] {
  const parts: EmphasisPart[] = [];
  const pieces = String(text).split('**');
  for (let i = 0; i < pieces.length; i++) {
    if (!pieces[i]) continue;
    parts.push({ text: pieces[i], bold: i % 2 === 1 });
  }
  return parts.length > 0 ? parts : [{ text: '', bold: false }];
}

/** Same string with the emphasis markers removed — what the PDF and any plain-text copy needs. */
export function plain(text: string): string {
  return String(text).split('**').join('');
}

export interface SummaryEntry {
  readonly key: SummaryFieldKey;
  readonly label: string;
  readonly value: string;
}

export interface RenderedOffer {
  readonly templateId: string;
  readonly templateLabel: string;
  readonly level: RoleLevel | null;
  readonly engagement: EngagementKind | null;
  /** What to print where the letter names the engagement, e.g. in the Re: line. */
  readonly engagementLabel: string;

  readonly opening: string;
  readonly welcome: string;
  readonly engagementTerms: string;
  readonly progression: string;
  /** Empty string unless the template awards a completion certificate. */
  readonly completion: string;
  readonly closing: string;

  /** The letter, in order, with emphasis markers removed. This is what the PDF renders. */
  readonly paragraphs: readonly string[];

  readonly summary: readonly SummaryEntry[];
  readonly glance: readonly SummaryEntry[];
  readonly summaryKeys: readonly SummaryFieldKey[];

  readonly showsUnpaidClause: boolean;
  readonly awardsCompletionCertificate: boolean;
  readonly stipendRecorded: boolean;
}

export function renderOfferLetter(
  fields: AgreedFields,
  decision: OfferTemplateDecision,
): RenderedOffer {
  const t = decision.template;
  const values = resolveFields(fields, decision);
  const stipend = t.unpaidUnlessStipend && stipendIsRecorded(fields.compensation);

  // The unpaid sentence and the stipend sentence are two different properties of the same template.
  // No other template owns either one, so no other template can render either one.
  const termsSource = stipend && t.engagementTermsWithStipend
    ? t.engagementTermsWithStipend
    : t.engagementTerms;

  const opening = interpolate(t.opening, values);
  const welcome = interpolate(t.welcome, values);
  const engagementTerms = interpolate(termsSource, values);
  const progression = interpolate(t.progression, values);
  const completion = t.completion ? interpolate(t.completion, values) : '';
  const closing = interpolate(t.closing, values);

  const rawValues: Record<SummaryFieldKey, string> = {
    roleTitle: txt(fields.roleTitle),
    department: txt(fields.department),
    employmentType: txt(fields.employmentType) || engagementLabel(decision.engagement),
    workMode: txt(fields.workMode),
    duration: txt(fields.duration),
    hoursCommitment: txt(fields.hoursCommitment),
    joiningDate: txt(fields.joiningDate),
    reportingTo: txt(fields.reportingTo),
    compensation: txt(fields.compensation),
  };

  const pick = (keys: readonly SummaryFieldKey[]): SummaryEntry[] =>
    keys
      .filter((k) => rawValues[k].length > 0)
      .map((k) => ({ key: k, label: FIELD_LABELS[k], value: rawValues[k] }));

  const paragraphs = [opening, welcome, engagementTerms, progression, completion, closing]
    .filter((p) => p.length > 0)
    .map(plain);

  return {
    templateId: t.id,
    templateLabel: t.label,
    level: decision.level,
    engagement: decision.engagement,
    engagementLabel: rawValues.employmentType,
    opening,
    welcome,
    engagementTerms,
    progression,
    completion,
    closing,
    paragraphs,
    summary: pick(t.summaryFields),
    glance: pick(t.glanceFields),
    summaryKeys: t.summaryFields,
    showsUnpaidClause: t.unpaidUnlessStipend && !stipend,
    awardsCompletionCertificate: t.awardsCompletionCertificate,
    stipendRecorded: stipend,
  };
}

// ---------------------------------------------------------------------------------------------
// Self-audit. Renders on /admin/offer/templates so the structural claim is observable rather than
// asserted in a comment.
// ---------------------------------------------------------------------------------------------

const TRAINEE_ONLY_PHRASES: readonly { pattern: RegExp; name: string }[] = [
  { pattern: /\bunpaid\b/i, name: 'unpaid' },
  { pattern: /\bstipend\b/i, name: 'stipend' },
  { pattern: /internship policy/i, name: 'Internship Policy' },
  { pattern: /certificate of completion/i, name: 'Certificate of Completion' },
  { pattern: /successful(ly)? complet/i, name: 'successful completion' },
  { pattern: /mid[-\s]?point review/i, name: 'mid-point review' },
  { pattern: INTERN_PATTERN, name: 'intern' },
  { pattern: APPRENTICE_PATTERN, name: 'apprentice' },
];

export interface TemplateAuditResult {
  readonly templateId: string;
  readonly label: string;
  readonly ok: boolean;
  readonly violations: readonly string[];
}

/**
 * Checks the two invariants that the failure depended on:
 *   1. No template outside the unpaid programmes contains trainee-only language anywhere.
 *   2. No template carrying trainee-only language declares a level above trainee rank.
 */
export function auditTemplateCopy(): TemplateAuditResult[] {
  return OFFER_TEMPLATES.map((t) => {
    const violations: string[] = [];
    const isTraineeProgramme = t.unpaidUnlessStipend || t.awardsCompletionCertificate;
    const copy = [
      t.opening, t.welcome, t.engagementTerms, t.engagementTermsWithStipend || '',
      t.progression, t.completion || '', t.closing,
    ].join('\n');

    if (!isTraineeProgramme) {
      for (const phrase of TRAINEE_ONLY_PHRASES) {
        if (phrase.pattern.test(copy)) {
          violations.push('contains trainee-only language: "' + phrase.name + '"');
        }
      }
      if (t.completion) violations.push('declares completion copy without awarding a certificate');
    } else {
      for (const lvl of t.levels) {
        if (levelRank(lvl) > TRAINEE_RANK) {
          violations.push('declares level "' + lvl + '", which is above trainee rank');
        }
      }
      if (!t.engagementTermsWithStipend) {
        violations.push('is unpaid-by-default but has no stipend variant, so a recorded stipend could not be honoured');
      }
    }

    if (t.isNeutralFallback && (t.unpaidUnlessStipend || t.awardsCompletionCertificate)) {
      violations.push('is the fallback yet carries programme language; the fallback must be the most neutral template');
    }

    return { templateId: t.id, label: t.label, ok: violations.length === 0, violations };
  });
}

// ---------------------------------------------------------------------------------------------
// Precomputed selection grid, for the live preview in /admin/offer/blank.
//
// The preview updates as an admin types, so it cannot call decideOfferTemplate() on every
// keystroke from an inline script. Instead the grid below is computed HERE, by the real selector,
// for every employment type the form offers crossed with "the title reads senior" — and the
// preview does nothing but look up the answer. The copy and the decision both stay in this file;
// the browser holds neither.
// ---------------------------------------------------------------------------------------------

export interface TemplateGridEntry {
  readonly templateId: string;
  readonly label: string;
  readonly opening: string;
  readonly welcome: string;
  readonly engagementTerms: string;
  readonly engagementTermsWithStipend: string;
  readonly progression: string;
  readonly completion: string;
  readonly closing: string;
  readonly summaryFields: readonly SummaryFieldKey[];
}

export interface TemplateGrid {
  /** key: employmentType + '|' + (RoleLevel | 'unknown') */
  readonly byKey: Record<string, TemplateGridEntry>;
  /** Used when the preview sees an employment type the grid was not built for. Never the intern one. */
  readonly fallback: TemplateGridEntry;
  /**
   * The title-to-level patterns, IN ORDER, so the preview reads a role title exactly the way
   * inferLevelFromTitle() does — most senior match first — without holding a second copy of the
   * rules. Order is the safety property here, which is why it is shipped rather than reimplemented.
   */
  readonly titlePatterns: readonly { readonly source: string; readonly level: RoleLevel }[];
  readonly noStipendSource: string;
  /** Label for each summary field, so the preview does not keep its own copy of them. */
  readonly fieldLabels: Record<string, string>;
}

function gridEntry(templateId: string): TemplateGridEntry {
  const t = getOfferTemplate(templateId) || NEUTRAL;
  return {
    templateId: t.id,
    label: t.label,
    opening: t.opening,
    welcome: t.welcome,
    engagementTerms: t.engagementTerms,
    engagementTermsWithStipend: t.engagementTermsWithStipend || t.engagementTerms,
    progression: t.progression,
    completion: t.completion || '',
    closing: t.closing,
    summaryFields: t.summaryFields,
  };
}

/**
 * The grid is EXHAUSTIVE, not an approximation: every employment type the form offers, crossed
 * with every level the platform has plus "no level recorded", each cell decided by the real
 * selector. The preview reads a title into a level using the shipped patterns and looks the cell
 * up, so what it shows is what the issued letter will say.
 */
export function buildTemplateGrid(employmentTypes: readonly string[]): TemplateGrid {
  const byKey: Record<string, TemplateGridEntry> = {};
  const levelKeys: (RoleLevel | null)[] = [...ROLE_LEVELS, null];
  for (const et of employmentTypes) {
    for (const lvl of levelKeys) {
      const decision = decideOfferTemplate({ employmentType: et, level: lvl, roleTitle: '' });
      byKey[et + '|' + (lvl || 'unknown')] = gridEntry(decision.template.id);
    }
  }
  return {
    byKey,
    fallback: gridEntry(NEUTRAL.id),
    titlePatterns: TITLE_LEVEL_PATTERNS.map((p) => ({ source: p.pattern.source, level: p.level })),
    noStipendSource: NO_STIPEND_PATTERN.source,
    fieldLabels: { ...FIELD_LABELS },
  };
}
