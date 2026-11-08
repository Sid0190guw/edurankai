// SAMARTH state machines. PURE: every rule about which status may follow which, who may move it,
// and what must be true first, lives here and is unit-tested. The store calls canTransition()
// before every status write and writes with `WHERE status = <from>`, so a stale screen cannot move a
// record that somebody else already moved.
//
// FOUR MACHINES:
//   application   the consultation request: registration, details, requirements, booking fee,
//                 call booking, consultant assignment, the call itself
//   engagement    any LATER commercial engagement (a consultancy package, an engineering build, a
//                 government proposal, an infrastructure project, implementation). Each has its own
//                 quotation that must be approved internally and accepted by the client.
//   partner       a technology partner in the registry, through due diligence
//   x             a SAMARTH X candidate, from any of the three entry channels
//
// Two honesty rules are encoded here rather than trusted to copy:
//   - a government proposal is never shown as awarded: isContracted() is true only once delivery
//     has started on the strength of a recorded contract or payment.
//   - no machine has a "paid" transition a person can click: payment is a FACT recorded by the
//     gateway path or by an explicit offline-payment record, never a status a screen sets.

export type Actor = 'applicant' | 'staff' | 'system';

export interface TransitionRule {
  to: string;
  actors: Actor[];
  /** Names of the context facts that must hold. Checked by canTransition(). */
  requires?: GuardName[];
  /** A note is mandatory (a reason for declining, cancelling, approving). */
  needsNote?: boolean;
}

export interface StatusDef {
  value: string;
  label: string;
  /** What the applicant (or partner, or candidate) is told this status means. */
  public: string;
  terminal?: boolean;
  next: TransitionRule[];
}

export type GuardName =
  | 'detailsComplete' | 'requirementsComplete' | 'feeQuoted' | 'termsAccepted' | 'paymentConfirmed'
  | 'slotsGiven' | 'consultantSet' | 'callTimeSet'
  | 'quotationValid' | 'approvalNoteGiven' | 'notExpired' | 'paidOrContracted'
  | 'dueDiligenceComplete'
  | 'enoughReviews' | 'incubationSlotFree' | 'agreementRecorded' | 'cohortSet';

export type GuardContext = Partial<Record<GuardName, boolean>>;

export const GUARD_MESSAGES: Record<GuardName, string> = {
  detailsComplete: 'The applicant details are not complete.',
  requirementsComplete: 'The project requirements are not complete.',
  feeQuoted: 'No approved booking fee has been quoted for this applicant category and currency.',
  termsAccepted: 'The applicant has not accepted the booking fee and its terms.',
  paymentConfirmed: 'No confirmed payment is recorded.',
  slotsGiven: 'Give at least one preferred time for the call.',
  consultantSet: 'Assign a consultant first.',
  callTimeSet: 'Set the call time first.',
  quotationValid: 'The quotation is incomplete: it needs a title, scope, amount, currency, terms and a validity date.',
  approvalNoteGiven: 'Approving a quotation needs an approval note.',
  notExpired: 'The quotation has passed its validity date. Issue a revised quotation.',
  paidOrContracted: 'Delivery starts only against a recorded payment or a recorded contract, purchase order or award reference.',
  dueDiligenceComplete: 'Due diligence is not complete: every required check must pass or be marked not applicable.',
  enoughReviews: 'Selection needs at least the minimum number of completed reviews.',
  incubationSlotFree: 'All six incubation places in this cohort are taken.',
  agreementRecorded: 'Record the incubation agreement reference (IP, resources and any equity terms) first.',
  cohortSet: 'Set the cohort first.',
};

// -------------------------------------------------------------------------------------------------
// APPLICATION (the consultation request)
// -------------------------------------------------------------------------------------------------

const S: Actor[] = ['staff'];
const A: Actor[] = ['applicant'];
const AS: Actor[] = ['applicant', 'staff'];

export const APPLICATION_STATUSES: readonly StatusDef[] = [
  {
    value: 'DRAFT', label: 'Registered', public: 'You have registered. Next: your details.',
    next: [
      { to: 'DETAILS_COMPLETE', actors: A, requires: ['detailsComplete'] },
      { to: 'WITHDRAWN', actors: A },
      { to: 'DECLINED', actors: S, needsNote: true },
    ],
  },
  {
    value: 'DETAILS_COMPLETE', label: 'Details complete', public: 'Your details are saved. Next: your project requirements.',
    next: [
      { to: 'REQUIREMENTS_COMPLETE', actors: A, requires: ['detailsComplete', 'requirementsComplete'] },
      { to: 'WITHDRAWN', actors: A },
      { to: 'DECLINED', actors: S, needsNote: true },
    ],
  },
  {
    value: 'REQUIREMENTS_COMPLETE', label: 'Requirements complete', public: 'Your requirements are saved. Next: the consultation booking fee.',
    next: [
      { to: 'FEE_PENDING', actors: A, requires: ['detailsComplete', 'requirementsComplete', 'feeQuoted', 'termsAccepted'] },
      { to: 'DETAILS_COMPLETE', actors: A },
      { to: 'WITHDRAWN', actors: A },
      { to: 'DECLINED', actors: S, needsNote: true },
    ],
  },
  {
    value: 'FEE_PENDING', label: 'Booking fee due', public: 'The booking fee is due. Your consultation call can be booked once the payment is confirmed.',
    next: [
      // No actor can click this: 'system' is the gateway path; staff use recordOfflineFeePayment(),
      // which checks the same guard. Both must show a confirmed payment.
      { to: 'FEE_PAID', actors: ['system', 'staff'], requires: ['paymentConfirmed'] },
      { to: 'REQUIREMENTS_COMPLETE', actors: A },
      { to: 'WITHDRAWN', actors: A },
      { to: 'DECLINED', actors: S, needsNote: true },
    ],
  },
  {
    value: 'FEE_PAID', label: 'Fee paid', public: 'Your booking fee is confirmed. Next: tell us when you can take the call.',
    next: [
      { to: 'BOOKING_REQUESTED', actors: A, requires: ['slotsGiven'] },
      { to: 'CANCELLED', actors: S, needsNote: true },
    ],
  },
  {
    value: 'BOOKING_REQUESTED', label: 'Call requested', public: 'Your call request is with the SAMARTH team. A consultant will be assigned to you.',
    next: [
      { to: 'CONSULTANT_ASSIGNED', actors: S, requires: ['consultantSet'] },
      { to: 'FEE_PAID', actors: AS },
      { to: 'CANCELLED', actors: S, needsNote: true },
    ],
  },
  {
    value: 'CONSULTANT_ASSIGNED', label: 'Consultant assigned', public: 'A SAMARTH consultant has been assigned and will confirm the call time.',
    next: [
      { to: 'CALL_SCHEDULED', actors: S, requires: ['consultantSet', 'callTimeSet'] },
      { to: 'BOOKING_REQUESTED', actors: S },
      { to: 'CANCELLED', actors: S, needsNote: true },
    ],
  },
  {
    value: 'CALL_SCHEDULED', label: 'Call scheduled', public: 'Your consultation call is scheduled.',
    next: [
      { to: 'CALL_COMPLETED', actors: S },
      { to: 'CONSULTANT_ASSIGNED', actors: S },
      { to: 'CANCELLED', actors: S, needsNote: true },
    ],
  },
  {
    value: 'CALL_COMPLETED', label: 'Call completed', public: 'Your consultation call has taken place. Any further work is proposed separately, with its own quotation and terms.',
    next: [{ to: 'CLOSED', actors: S }],
  },
  { value: 'CLOSED', label: 'Closed', public: 'This consultation is closed.', terminal: true, next: [] },
  { value: 'WITHDRAWN', label: 'Withdrawn', public: 'You withdrew this request.', terminal: true, next: [] },
  { value: 'DECLINED', label: 'Declined', public: 'SAMARTH declined this request. The reason is shown below.', terminal: true, next: [] },
  { value: 'CANCELLED', label: 'Cancelled', public: 'This consultation was cancelled. The reason is shown below. Any refund is handled separately and confirmed to you in writing.', terminal: true, next: [] },
];

/** The six steps of the consultation workflow, in order, as the applicant sees them. */
export const APPLICATION_STEPS: readonly { key: string; label: string; reachedAt: string[] }[] = [
  { key: 'register', label: 'Registration', reachedAt: ['DRAFT'] },
  { key: 'details', label: 'Applicant details', reachedAt: ['DETAILS_COMPLETE'] },
  { key: 'requirements', label: 'Project requirements', reachedAt: ['REQUIREMENTS_COMPLETE'] },
  { key: 'fee', label: 'Booking fee', reachedAt: ['FEE_PENDING', 'FEE_PAID'] },
  { key: 'booking', label: 'Call booking', reachedAt: ['BOOKING_REQUESTED'] },
  { key: 'consultant', label: 'Consultant assigned', reachedAt: ['CONSULTANT_ASSIGNED', 'CALL_SCHEDULED', 'CALL_COMPLETED', 'CLOSED'] },
];

const APPLICATION_ORDER = ['DRAFT', 'DETAILS_COMPLETE', 'REQUIREMENTS_COMPLETE', 'FEE_PENDING', 'FEE_PAID', 'BOOKING_REQUESTED', 'CONSULTANT_ASSIGNED', 'CALL_SCHEDULED', 'CALL_COMPLETED', 'CLOSED'];

/**
 * Index of the furthest step reached, for the progress tracker. A step is DONE when the status has
 * moved past it: Registration is done at DETAILS_COMPLETE, the booking fee is done at FEE_PAID.
 */
export function applicationStepState(status: string): { key: string; label: string; state: 'done' | 'current' | 'todo' }[] {
  const at = APPLICATION_ORDER.indexOf(status);
  const doneAfter: Record<string, string> = {
    register: 'DRAFT', details: 'DETAILS_COMPLETE', requirements: 'REQUIREMENTS_COMPLETE',
    fee: 'FEE_PENDING', booking: 'BOOKING_REQUESTED', consultant: 'CALL_COMPLETED',
  };
  let currentGiven = false;
  return APPLICATION_STEPS.map((s) => {
    const doneIdx = APPLICATION_ORDER.indexOf(doneAfter[s.key]);
    if (at > doneIdx) return { key: s.key, label: s.label, state: 'done' as const };
    if (!currentGiven && at >= 0) { currentGiven = true; return { key: s.key, label: s.label, state: 'current' as const }; }
    return { key: s.key, label: s.label, state: 'todo' as const };
  });
}

/** Statuses at which the applicant may still edit their details and requirements. */
export const APPLICANT_EDITABLE = ['DRAFT', 'DETAILS_COMPLETE', 'REQUIREMENTS_COMPLETE'];

// -------------------------------------------------------------------------------------------------
// ENGAGEMENT (a later commercial engagement, with its own quotation)
// -------------------------------------------------------------------------------------------------

export const ENGAGEMENT_KINDS: readonly { value: string; label: string }[] = [
  { value: 'consultancy_package', label: 'Consultancy package' },
  { value: 'engineering', label: 'Engineering project' },
  { value: 'government_project', label: 'Government project proposal' },
  { value: 'infrastructure', label: 'Infrastructure project' },
  { value: 'technology_transfer', label: 'Technology transfer' },
  { value: 'implementation', label: 'Implementation' },
  { value: 'research', label: 'Research or feasibility study' },
  { value: 'support', label: 'Maintenance and support' },
  { value: 'custom', label: 'Other engagement' },
];

export function engagementKindLabel(v: unknown): string {
  return ENGAGEMENT_KINDS.find((k) => k.value === v)?.label || String(v || '');
}

export const ENGAGEMENT_STATUSES: readonly StatusDef[] = [
  {
    value: 'DRAFT', label: 'Draft quotation', public: '',
    next: [
      { to: 'PENDING_APPROVAL', actors: S, requires: ['quotationValid'] },
      { to: 'WITHDRAWN', actors: S, needsNote: true },
    ],
  },
  {
    value: 'PENDING_APPROVAL', label: 'Awaiting internal approval', public: '',
    next: [
      { to: 'APPROVED', actors: S, requires: ['quotationValid', 'approvalNoteGiven'], needsNote: true },
      { to: 'DRAFT', actors: S },
      { to: 'WITHDRAWN', actors: S, needsNote: true },
    ],
  },
  {
    value: 'APPROVED', label: 'Approved, not yet sent', public: '',
    next: [
      { to: 'SENT', actors: S, requires: ['quotationValid', 'notExpired'] },
      { to: 'DRAFT', actors: S },
      { to: 'WITHDRAWN', actors: S, needsNote: true },
    ],
  },
  {
    value: 'SENT', label: 'Quotation sent', public: 'A quotation is waiting for your decision. Review its scope, price and terms below.',
    next: [
      { to: 'ACCEPTED', actors: AS, requires: ['notExpired'] },
      { to: 'DECLINED', actors: AS },
      { to: 'EXPIRED', actors: ['staff', 'system'] },
      { to: 'WITHDRAWN', actors: S, needsNote: true },
    ],
  },
  {
    value: 'ACCEPTED', label: 'Accepted', public: 'You accepted this quotation. Delivery starts once payment or the agreed contract is in place.',
    next: [
      { to: 'IN_DELIVERY', actors: S, requires: ['paidOrContracted'] },
      { to: 'CANCELLED', actors: S, needsNote: true },
    ],
  },
  {
    value: 'IN_DELIVERY', label: 'In delivery', public: 'This engagement is being delivered.',
    next: [
      { to: 'COMPLETED', actors: S },
      { to: 'CANCELLED', actors: S, needsNote: true },
    ],
  },
  { value: 'COMPLETED', label: 'Completed', public: 'This engagement is complete.', terminal: true, next: [] },
  { value: 'DECLINED', label: 'Declined by the client', public: 'This quotation was declined.', terminal: true, next: [] },
  { value: 'EXPIRED', label: 'Expired', public: 'This quotation expired before it was accepted.', terminal: true, next: [] },
  { value: 'WITHDRAWN', label: 'Withdrawn', public: 'SAMARTH withdrew this quotation.', terminal: true, next: [] },
  { value: 'CANCELLED', label: 'Cancelled', public: 'This engagement was cancelled.', terminal: true, next: [] },
];

/** Statuses at which a quotation's commercial content may be edited. Anything later needs re-approval. */
export const ENGAGEMENT_EDITABLE = ['DRAFT'];
/** Statuses the client can see. Drafts and internal approvals are never shown to them. */
export const ENGAGEMENT_CLIENT_VISIBLE = ['SENT', 'ACCEPTED', 'IN_DELIVERY', 'COMPLETED', 'DECLINED', 'EXPIRED', 'CANCELLED'];

/**
 * Whether an engagement may be described as contracted or awarded. Spec Part 5.4: a proposal, a
 * meeting or an expression of interest is never an awarded project.
 */
export function isContracted(status: string, awardReference: string | null | undefined, paid: boolean): boolean {
  return (status === 'IN_DELIVERY' || status === 'COMPLETED') && (!!String(awardReference || '').trim() || paid);
}

// -------------------------------------------------------------------------------------------------
// PARTNER
// -------------------------------------------------------------------------------------------------

export const PARTNER_STATUSES: readonly StatusDef[] = [
  {
    value: 'REGISTERED', label: 'Registered', public: 'Your registration has been received. Registration is not approval and does not entitle you to any project.',
    next: [{ to: 'UNDER_REVIEW', actors: S }, { to: 'REJECTED', actors: S, needsNote: true }],
  },
  {
    value: 'UNDER_REVIEW', label: 'Under review', public: 'The SAMARTH team is reviewing your registration.',
    next: [{ to: 'DUE_DILIGENCE', actors: S }, { to: 'REJECTED', actors: S, needsNote: true }],
  },
  {
    value: 'DUE_DILIGENCE', label: 'Due diligence', public: 'Due diligence is in progress. We may ask you for documents or references.',
    next: [
      { to: 'APPROVED', actors: S, requires: ['dueDiligenceComplete'], needsNote: true },
      { to: 'REJECTED', actors: S, needsNote: true },
    ],
  },
  {
    value: 'APPROVED', label: 'Approved partner', public: 'You are an approved SAMARTH partner. Approval makes you eligible to be considered; no project is ever awarded automatically.',
    next: [{ to: 'SUSPENDED', actors: S, needsNote: true }],
  },
  {
    value: 'SUSPENDED', label: 'Suspended', public: 'Your partner approval is suspended.',
    next: [{ to: 'DUE_DILIGENCE', actors: S }, { to: 'REJECTED', actors: S, needsNote: true }],
  },
  {
    value: 'REJECTED', label: 'Not approved', public: 'Your registration was not approved.',
    next: [{ to: 'UNDER_REVIEW', actors: S, needsNote: true }],
  },
];

export const DUE_DILIGENCE_ITEMS: readonly { key: string; label: string; required: boolean }[] = [
  { key: 'identity', label: 'Organisation identity and legal registration verified', required: true },
  { key: 'technical', label: 'Technical capability assessed against the claimed domains', required: true },
  { key: 'certifications', label: 'Claimed certifications and accreditations checked with the issuer', required: true },
  { key: 'references', label: 'Previous-project references checked', required: true },
  { key: 'financial', label: 'Financial and commercial standing reviewed', required: false },
  { key: 'security', label: 'Security and data-protection assessment', required: true },
  { key: 'regulatory', label: 'Regulatory eligibility for regulated work confirmed', required: false },
  { key: 'conflicts', label: 'Conflicts of interest declared and reviewed', required: true },
  { key: 'insurance', label: 'Insurance and liability cover confirmed', required: false },
];

export type DdState = 'pending' | 'pass' | 'fail' | 'na';

/** Complete means every required item passed or is not applicable, and nothing failed. */
export function dueDiligenceComplete(checklist: Record<string, unknown> | null | undefined): boolean {
  const c = checklist || {};
  for (const item of DUE_DILIGENCE_ITEMS) {
    const v = String((c as any)[item.key] || 'pending');
    if (v === 'fail') return false;
    if (item.required && v !== 'pass' && v !== 'na') return false;
  }
  return true;
}

// -------------------------------------------------------------------------------------------------
// SAMARTH X
// -------------------------------------------------------------------------------------------------

/** Formal incubation is for the best six ventures (spec Part 10.5), per cohort. */
export const INCUBATION_PLACES = 6;
/** Completed reviews needed before a candidate can be selected. */
export const MIN_REVIEWS_TO_SELECT = 1;

export const X_CHANNELS: readonly { value: string; label: string }[] = [
  { value: 'eoi', label: 'Expression of interest' },
  { value: 'event', label: 'Event or competition' },
  { value: 'recruitment', label: 'Recruitment' },
];

export const X_STATUSES: readonly StatusDef[] = [
  {
    value: 'RECEIVED', label: 'Received', public: 'Your application has been received. An expression of interest is an application for consideration, not admission.',
    next: [{ to: 'SCREENING', actors: S }, { to: 'NOT_SELECTED', actors: S, needsNote: true }, { to: 'WITHDRAWN', actors: AS }],
  },
  {
    value: 'SCREENING', label: 'Screening', public: 'Your application is being screened.',
    next: [{ to: 'TECHNICAL_ASSESSMENT', actors: S }, { to: 'NOT_SELECTED', actors: S, needsNote: true }, { to: 'WITHDRAWN', actors: AS }],
  },
  {
    value: 'TECHNICAL_ASSESSMENT', label: 'Technical assessment', public: 'Your work is being assessed by SAMARTH reviewers.',
    next: [{ to: 'SHORTLISTED', actors: S }, { to: 'NOT_SELECTED', actors: S, needsNote: true }, { to: 'WITHDRAWN', actors: AS }],
  },
  {
    value: 'SHORTLISTED', label: 'Shortlisted', public: 'You have been shortlisted.',
    next: [
      { to: 'SELECTED', actors: S, requires: ['enoughReviews'] },
      { to: 'NOT_SELECTED', actors: S, needsNote: true },
      { to: 'WITHDRAWN', actors: AS },
    ],
  },
  {
    value: 'SELECTED', label: 'Selected', public: 'You have been selected for SAMARTH X. Resources are allocated according to your project and progress.',
    next: [
      { to: 'INCUBATING', actors: S, requires: ['cohortSet', 'agreementRecorded', 'incubationSlotFree'] },
      { to: 'ALUMNI', actors: S },
      { to: 'WITHDRAWN', actors: AS },
    ],
  },
  {
    value: 'INCUBATING', label: 'In formal incubation', public: 'Your venture is in formal incubation, one of the best six in its cohort.',
    next: [{ to: 'ALUMNI', actors: S }, { to: 'WITHDRAWN', actors: AS }],
  },
  { value: 'ALUMNI', label: 'Alumni', public: 'Your venture has completed the programme.', terminal: true, next: [] },
  { value: 'NOT_SELECTED', label: 'Not selected', public: 'Your application was not selected this time.', terminal: true, next: [] },
  { value: 'WITHDRAWN', label: 'Withdrawn', public: 'This application was withdrawn.', terminal: true, next: [] },
];

// -------------------------------------------------------------------------------------------------
// THE ONE CHECK EVERY STATUS WRITE GOES THROUGH
// -------------------------------------------------------------------------------------------------

export type Machine = 'application' | 'engagement' | 'partner' | 'x';

export const MACHINES: Record<Machine, readonly StatusDef[]> = {
  application: APPLICATION_STATUSES,
  engagement: ENGAGEMENT_STATUSES,
  partner: PARTNER_STATUSES,
  x: X_STATUSES,
};

export function statusDef(machine: Machine, status: string): StatusDef | null {
  return MACHINES[machine].find((s) => s.value === status) || null;
}

export function statusLabel(machine: Machine, status: string): string {
  return statusDef(machine, status)?.label || status;
}

export function initialStatus(machine: Machine): string {
  return MACHINES[machine][0].value;
}

export interface TransitionCheck { ok: boolean; error?: string; rule?: TransitionRule }

export function canTransition(
  machine: Machine,
  from: string,
  to: string,
  actor: Actor,
  ctx: GuardContext = {},
  note?: string | null,
): TransitionCheck {
  const def = statusDef(machine, from);
  if (!def) return { ok: false, error: 'The record is in an unknown status (' + from + ').' };
  if (!statusDef(machine, to)) return { ok: false, error: 'Unknown status: ' + to + '.' };
  if (from === to) return { ok: false, error: 'It is already ' + def.label.toLowerCase() + '.' };
  const rule = def.next.find((r) => r.to === to);
  if (!rule) return { ok: false, error: def.label + ' cannot move to ' + statusLabel(machine, to).toLowerCase() + '.' };
  if (!rule.actors.includes(actor)) {
    return { ok: false, error: statusLabel(machine, to) + ' cannot be set from here.' };
  }
  for (const g of rule.requires || []) {
    if (!ctx[g]) return { ok: false, error: GUARD_MESSAGES[g] };
  }
  if (rule.needsNote && String(note || '').trim().length < 5) {
    return { ok: false, error: 'Write a short reason (at least five characters). It is kept with the record.' };
  }
  return { ok: true, rule };
}

/** The transitions this actor may attempt from `status`, for rendering buttons. */
export function availableTransitions(machine: Machine, status: string, actor: Actor): TransitionRule[] {
  return (statusDef(machine, status)?.next || []).filter((r) => r.actors.includes(actor));
}
