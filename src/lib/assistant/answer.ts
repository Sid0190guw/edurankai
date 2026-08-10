// src/lib/assistant/answer.ts — THE ANSWER ENGINE. One assistant, two audiences, and a shape that
// cannot hold a fabrication.
//
// =================================================================================================
// GROUNDING IS THE PRODUCT, AND IT IS ENFORCED BY THE TYPE
// =================================================================================================
//
// An Answer is a union of exactly two things:
//
//   GroundedAnswer   claims: readonly [Claim, ...Claim[]]   — a NON-EMPTY TUPLE, and every Claim has
//                    a required `source`. `claims: []` is a compile error; a Claim without a citation
//                    is a compile error. There is no code path that produces a sentence with nothing
//                    behind it, because there is no VALUE that can hold one.
//   UnknownAnswer    no claims at all, a named reason, and the human who can help.
//
// This is deliberately a shape rather than a rule. A rule ("always cite") is obeyed by whoever
// remembers it; a shape is obeyed by the compiler, by every future caller, and by whatever gets
// bolted on next year in a hurry. A confident wrong answer about notice period, leave entitlement, a
// fee or a refund is a real harm to a real person, and it arrives wearing exactly the same clothes as
// a right one — so the defence cannot be vigilance.
//
// =================================================================================================
// THE PIPELINE, AND EVERY STAGE REFUSES
// =================================================================================================
//
//   question
//     -> forbidden subject?           -> UnknownAnswer, and NOTHING is searched (corpus.ts)
//     -> resolve the asker            -> visitor | employee | manager | hr | admin (corpus.ts)
//     -> build the corpus for THEM    -> authorization scopes RETRIEVAL, not output (corpus.ts)
//     -> retrieve                     -> ranked passages, each carrying its document
//     -> below the relevance floor?   -> UnknownAnswer that says WHERE it looked
//     -> assemble FROM THE RETRIEVED TEXT, with a citation per claim
//     -> attach the escalation route  -> on EVERY answer, including the good ones
//
// =================================================================================================
// IT ANSWERS. IT DOES NOT ACT.
// =================================================================================================
//
// Section 67 of the HCM spec. Nothing in this module imports a writer — no applyLeave, no
// submitClaim, no decideLeave, no acknowledgePolicy, no createTicket. Every answer carries `actions`,
// which are LINKS to the screen where a person does the thing themselves. An assistant that can act
// is an assistant that can be talked into acting, and the way to make that impossible is to not give
// it hands.
//
// =================================================================================================
// PERSONAL FACTS COME FROM THE FACT FUNCTIONS, NEVER FROM A RE-QUERY
// =================================================================================================
//
// getBalances() knows the leave year turns over in LEAVE_TIME_ZONE and that comp-off comes from the
// ledger. payslipsForEmployeeResult() keeps "none" apart from "could not read". learningPathRead()
// does the same, and the progress percentage is learning-progress.ts's reconciliation across two
// completion tables. Re-querying any of that here would produce a SECOND number for one person, and
// an assistant is the worst possible place for it because it sounds authoritative.
//
// AND A FAILED READ IS NEVER A ZERO. Every fact carries `read`, and only 'ok' may contain a figure.
// 'unreadable' means the function said it failed; 'ambiguous' means the function cannot tell an empty
// list from a failed one (claimsForEmployee and listBenefits both return [] on error), so no count is
// stated at all. "You have 0 days left" assembled out of a pooler timeout is the exact defect this
// project has shipped before.
//
// =================================================================================================
// THE MODEL, IF THERE IS ONE
// =================================================================================================
//
// A generative model may only RE-PHRASE text that was already retrieved, one claim at a time, each
// validated against its OWN source passage by guardRephrase(). A proposal that introduces a digit, a
// link, a currency symbol or a university claim that is not in the source is REFUSED and the template
// stands. That is foundation.ts's intent() shape: the model proposes, a caller-supplied validator
// disposes, and a failed proposal is a refusal with a reason rather than a partly-accepted value.
//
// With no model configured, the answer templates from the sources and nothing degrades except the
// prose. Never from an answer to nothing, and never from an answer to an invention.
import {
  RELEVANCE_FLOOR,
  forbiddenTopic,
  mayReadFactsFor,
  retrieve,
  type Asker,
  type AskerKind,
  type Passage,
  type Retrieval,
  type SearchedSource,
} from '@/lib/assistant/corpus';

// -------------------------------------------------------------------------------------------------
// CONSTANTS — every one above the function that reads it. `const` is not hoisted.
// -------------------------------------------------------------------------------------------------

const logFail = (tag: string, e: any) =>
  console.error('[assistant/answer] ' + tag, e?.cause?.message || e?.message);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** Claims carried into one answer. More than this is a reading list, not an answer. */
const MAX_CLAIMS = 4;

/** How many claims a model is allowed to rephrase. Each costs a request and a validation. */
const MAX_REPHRASED = 3;

/** How much of a passage is quoted in a claim. Long enough to carry a caveat with its rule. */
const CLAIM_MAX_CHARS = 420;

/** Where a member of staff reaches a person. The helpdesk that already exists, not a new channel. */
const STAFF_ESCALATION = {
  label: 'Ask the helpdesk',
  href: '/portal/employee/support',
  note: 'Raise it with the desk that owns it and a person will answer. Nothing here decides anything about your record.',
};

/**
 * Where a visitor reaches a person.
 *
 * /founder IS DELIBERATELY NOT OFFERED. That route is a PAID direct line with booked slots and a
 * payment step; sending somebody there because they asked what a course costs would be routing them
 * at a paywall. The live help chat on every public page reaches a real inbox, and connect@ is the
 * general address — hr@ is careers only.
 */
const VISITOR_ESCALATION = {
  label: 'Talk to a person',
  href: '/contact',
  note: 'A person reads this. You can also use the help chat on any page, or write to connect@edurankai.in.',
};

/**
 * The screens this assistant points at instead of acting. Every href is a route that exists, and not
 * one of them is called — they are rendered as links for a human to open.
 */
const ACTION_ROUTES: readonly { pattern: RegExp; label: string; href: string }[] = [
  { pattern: /\b(leave|holiday|time off|absence|comp off|compoff)\b/i, label: 'Your leave', href: '/portal/employee/leave' },
  { pattern: /\b(expense|claim|reimburse\w*|advance)\b/i, label: 'Your expense claims', href: '/portal/employee/expenses' },
  { pattern: /\b(payslip|salary slip|pay slip|net pay|gross|deduction)\b/i, label: 'Your payslips', href: '/portal/employee/payslips' },
  { pattern: /\b(training|course|learning|assigned|module)\b/i, label: 'Your learning', href: '/portal/employee/learning' },
  { pattern: /\b(benefit|insurance|medical cover|gratuity)\b/i, label: 'Your benefits', href: '/portal/employee/benefits' },
  { pattern: /\b(polic\w+|handbook|guideline|procedure)\b/i, label: 'The handbook', href: '/portal/employee/knowledge' },
];

/** The public screens a visitor is pointed at. No price-first framing: the catalogue leads. */
const PUBLIC_ACTION_ROUTES: readonly { pattern: RegExp; label: string; href: string }[] = [
  { pattern: /\b(programme|program|degree|diploma|certificate|bachelor|master)\b/i, label: 'Programmes', href: '/aquintutor/programs' },
  { pattern: /\b(course|class|subject|syllabus|curriculum)\b/i, label: 'Courses', href: '/aquintutor/courses' },
  { pattern: /\b(apply|admission|enrol\w*|enroll\w*|join|cohort|start date)\b/i, label: 'How to apply', href: '/apply' },
];

// -------------------------------------------------------------------------------------------------
// THE TYPES. THIS IS THE PRODUCT.
// -------------------------------------------------------------------------------------------------

/**
 * Where a claim came from. Every field is required: a citation that can be partly filled in is a
 * citation that will be partly filled in.
 */
export interface Citation {
  /** What the document is called, including the section when there is one. */
  label: string;
  /** The route a reader opens to check it. */
  href: string;
  /** Which part of the corpus this was: the handbook, a published page, the catalogue. */
  sourceLabel: string;
  /** Why this document came back, in words. */
  why: string;
}

/**
 * ONE STATEMENT AND THE DOCUMENT IT CAME FROM.
 *
 * `source` is not optional and never will be. A Claim is the only thing an answer is made of, so a
 * sentence with no document behind it has nowhere to live.
 */
export interface Claim {
  readonly text: string;
  readonly source: Citation;
  /** True when a model rephrased `text` from the source. The facts are still the source's. */
  readonly rephrased: boolean;
}

/** A route to a human. Present on EVERY answer, including the ones that worked. */
export interface EscalationRoute {
  label: string;
  href: string;
  note: string;
}

/** A screen where the person does the thing themselves. This engine links; it never acts. */
export interface ActionLink {
  label: string;
  href: string;
}

export const UNKNOWN_REASONS = ['too-short', 'forbidden', 'below-floor', 'nothing-found', 'not-yours'] as const;
export type UnknownReason = (typeof UNKNOWN_REASONS)[number];

interface AnswerBase {
  question: string;
  askerKind: AskerKind;
  /**
   * WHERE IT LOOKED, source by source, whether or not anything came back. Being told "no results"
   * without knowing what was searched is not an answer either — it is indistinguishable from a
   * broken index, and it gives the person nothing to do next.
   */
  searched: readonly SearchedSource[];
  /** One sentence about what this asker's corpus was. Rendered verbatim. */
  scopeNote: string;
  /** ALWAYS PRESENT. Nobody should be trapped in a conversation with software about their own pay. */
  escalation: EscalationRoute;
  /** Links, never calls. */
  actions: readonly ActionLink[];
  /** True when something that exists could not be read. The answer may be incomplete. */
  degraded: boolean;
}

export interface GroundedAnswer extends AnswerBase {
  kind: 'grounded';
  /**
   * A NON-EMPTY TUPLE. `[]` does not typecheck, so an answer with no source cannot be represented —
   * not merely avoided. groundedAnswer() re-checks at runtime as well, for the JavaScript callers
   * TypeScript cannot see.
   */
  claims: readonly [Claim, ...Claim[]];
}

export interface UnknownAnswer extends AnswerBase {
  kind: 'unknown';
  reason: UnknownReason;
  /** What to say. Written here so every surface says the same thing about the same state. */
  sentence: string;
}

export type Answer = GroundedAnswer | UnknownAnswer;

/** Narrowing helper, so a surface never reads `.claims` off an unknown answer. */
export function isGrounded(a: Answer): a is GroundedAnswer {
  return a.kind === 'grounded';
}

// -------------------------------------------------------------------------------------------------
// PERSONAL FACTS
// -------------------------------------------------------------------------------------------------

/**
 * THREE READ STATES, AND ONLY ONE OF THEM MAY CONTAIN A FIGURE.
 *
 *   ok          the fact function answered. `sentence` may contain numbers.
 *   unreadable  the fact function said it failed. `sentence` says so and contains no figure.
 *   ambiguous   the fact function cannot tell an empty result from a failed one — claimsForEmployee()
 *               and listBenefits() both return [] on error — so no count is stated at all. This state
 *               exists because "you have no claims" and "we could not read your claims" are different
 *               sentences and that function cannot tell us which is true.
 */
export type FactRead = 'ok' | 'unreadable' | 'ambiguous';

export interface PersonalFact {
  key: string;
  label: string;
  read: FactRead;
  /** The whole sentence. On anything but 'ok' it contains no figure of any kind. */
  sentence: string;
  /** The screen that holds this record. */
  href: string;
  /** The system of record this was read from, named. */
  sourceLabel: string;
}

/** A fact that could not be read. Never a zero, never an empty list, never a reassuring guess. */
export function unreadableFact(key: string, label: string, href: string, sourceLabel: string): PersonalFact {
  return {
    key,
    label,
    read: 'unreadable',
    sentence: 'I could not read your ' + label.toLowerCase() + ' just now, so I am not going to put a '
      + 'figure here. Open the screen below, or ask the helpdesk.',
    href,
    sourceLabel,
  };
}

/** A fact whose source cannot distinguish "none" from "failed". Says so, and states no count. */
export function ambiguousFact(key: string, label: string, href: string, sourceLabel: string, detail: string): PersonalFact {
  return { key, label, read: 'ambiguous', sentence: detail, href, sourceLabel };
}

/**
 * A personal fact as a Claim, cited to the SYSTEM OF RECORD it was read from.
 *
 * This is grounding of a different kind from a document, and it is honest: the citation names the
 * register the figure came out of and links to the screen where the person can see the same figure
 * rendered by the same function.
 */
export function factClaim(fact: PersonalFact): Claim {
  return {
    text: fact.sentence,
    source: {
      label: fact.label,
      href: fact.href,
      sourceLabel: fact.sourceLabel,
      why: fact.read === 'ok'
        ? 'Read from ' + fact.sourceLabel + ' for your own record.'
        : 'This is what ' + fact.sourceLabel + ' told us about the read itself.',
    },
    rephrased: false,
  };
}

/**
 * WHICH PERSONAL FACT, IF ANY, THIS QUESTION IS ASKING FOR.
 *
 * Keyword selection, deterministic, and it selects a FUNCTION TO CALL — it never supplies a value.
 * The worst a wrong match can do is read the wrong register and say so.
 */
const FACT_TOPICS: readonly { key: string; pattern: RegExp }[] = [
  { key: 'leave', pattern: /\b(leave|holiday|time off|annual leave|casual leave|sick leave|comp off|compoff|balance)\b/i },
  { key: 'learning', pattern: /\b(training|assigned|my course|my learning|module|mandatory course)\b/i },
  { key: 'payslip', pattern: /\b(payslip|pay slip|salary slip|net pay|gross pay|deduction|my pay)\b/i },
  { key: 'benefits', pattern: /\b(benefit|benefits|insurance|medical cover|gratuity|eligib\w*)\b/i },
  { key: 'expenses', pattern: /\b(expense|claim|reimburse\w*|advance)\b/i },
];

export function factTopicsFor(question: string): string[] {
  const q = String(question || '');
  return FACT_TOPICS.filter((t) => t.pattern.test(q)).map((t) => t.key);
}

/**
 * READ THIS PERSON'S OWN FACTS, through the existing functions and no others.
 *
 * `subjectEmployeeId` defaults to the asker's own record. Anything else is checked per row against
 * the ORG GRAPH by mayReadFactsFor(), and refused by default. There is no path here to a wellness
 * record for anybody: no wellness module is imported by this file or by corpus.ts.
 */
export async function personalFacts(
  asker: Asker,
  question: string,
  subjectEmployeeId?: string | null,
): Promise<{ facts: PersonalFact[]; refusal: string | null }> {
  const subject = isUuid(subjectEmployeeId) ? String(subjectEmployeeId) : asker.employeeId;
  const topics = factTopicsFor(question);
  if (topics.length === 0) return { facts: [], refusal: null };
  if (!subject) return { facts: [], refusal: null };

  const permitted = mayReadFactsFor(asker, subject);
  if (!permitted.ok) return { facts: [], refusal: permitted.reason };

  const facts: PersonalFact[] = [];

  if (topics.indexOf('leave') >= 0) {
    // strict:true ON PURPOSE. The tolerant path returns zeros on a failed read, so every allowance
    // reports ITSELF as remaining — which on a screen is merely wrong and in a sentence that begins
    // "you have" is a number somebody will plan around.
    try {
      const { getBalances, describeUnits } = await import('@/lib/hr-leave');
      const balances = await getBalances(subject, undefined, { strict: true });
      const stated = balances.filter((b) => b.source !== 'none');
      if (stated.length === 0) {
        facts.push(ambiguousFact(
          'leave',
          'Leave balance',
          '/portal/employee/leave',
          'the leave register',
          'No leave allowance is recorded against your record for this year. That is what the register '
            + 'says rather than a calculation, so the helpdesk is the place to correct it.',
        ));
      } else {
        const parts = stated.map((b) => b.name + ': ' + describeUnits('days', b.remaining, null) + ' left'
          + (b.pending > 0 ? ' (' + describeUnits('days', b.pending, null) + ' awaiting a decision)' : ''));
        facts.push({
          key: 'leave',
          label: 'Leave balance',
          read: 'ok',
          sentence: 'Your leave register shows ' + parts.join('; ') + '.',
          href: '/portal/employee/leave',
          sourceLabel: 'the leave register',
        });
      }
    } catch (e: any) {
      logFail('personalFacts.leave', e);
      facts.push(unreadableFact('leave', 'Leave balance', '/portal/employee/leave', 'the leave register'));
    }
  }

  if (topics.indexOf('learning') >= 0) {
    try {
      const { learningPathRead } = await import('@/lib/performance-learning');
      const res = await learningPathRead(subject);
      if (res.read === 'unreadable') {
        facts.push(unreadableFact('learning', 'Assigned training', '/portal/employee/learning', 'the learning register'));
      } else if (res.items.length === 0) {
        facts.push({
          key: 'learning',
          label: 'Assigned training',
          read: 'ok',
          sentence: 'Nothing is currently assigned to you in the learning register.',
          href: '/portal/employee/learning',
          sourceLabel: 'the learning register',
        });
      } else {
        // THE PERCENTAGE IS NOT RESTATED OR RECOMPUTED. progressPct is learning-progress.ts's
        // reconciliation across the two completion tables that two players write into; arithmetic
        // here would be the second number this file exists to prevent.
        const required = res.items.filter((i) => i.required);
        const names = res.items.slice(0, 4).map((i) => i.courseTitle
          + (i.dueOn ? ' (due ' + i.dueOn + ')' : '')
          + (i.progressPct == null ? '' : ' — ' + i.progressPct + '% done'));
        facts.push({
          key: 'learning',
          label: 'Assigned training',
          read: 'ok',
          sentence: 'The learning register lists ' + res.items.length + ' item(s) assigned to you'
            + (required.length ? ', of which ' + required.length + ' are required' : '')
            + ': ' + names.join('; ') + '.',
          href: '/portal/employee/learning',
          sourceLabel: 'the learning register',
        });
      }
    } catch (e: any) {
      logFail('personalFacts.learning', e);
      facts.push(unreadableFact('learning', 'Assigned training', '/portal/employee/learning', 'the learning register'));
    }
  }

  if (topics.indexOf('payslip') >= 0) {
    try {
      const { payslipsForEmployeeResult } = await import('@/lib/payroll');
      const res = await payslipsForEmployeeResult(subject, 6);
      if (!res.ok) {
        facts.push(unreadableFact('payslip', 'Payslips', '/portal/employee/payslips', 'the payroll register'));
      } else if (res.rows.length === 0) {
        facts.push({
          key: 'payslip',
          label: 'Payslips',
          read: 'ok',
          sentence: 'No payslip is recorded against your record yet.',
          href: '/portal/employee/payslips',
          sourceLabel: 'the payroll register',
        });
      } else {
        const latest = res.rows[0];
        // The figures are the register's own, restated and never re-derived. What a LINE means is a
        // question for the payslip renderer's own labels, which is why the answer points at the
        // payslip rather than explaining a component from memory.
        facts.push({
          key: 'payslip',
          label: 'Payslips',
          read: 'ok',
          sentence: 'Your most recent payslip is ' + latest.periodLabel + ' (' + latest.status + '). '
            + 'It is on your payslips screen, where each line is labelled as payroll issued it.',
          href: '/portal/employee/payslips',
          sourceLabel: 'the payroll register',
        });
      }
    } catch (e: any) {
      logFail('personalFacts.payslip', e);
      facts.push(unreadableFact('payslip', 'Payslips', '/portal/employee/payslips', 'the payroll register'));
    }
  }

  if (topics.indexOf('benefits') >= 0) {
    try {
      const { catalogueFor, describeRules } = await import('@/lib/benefits');
      const cat = await catalogueFor(subject);
      if (cat.entries.length === 0) {
        // listBenefits() returns [] on a failed read as well as on an empty catalogue, so a count
        // here would be a number that cannot tell the two apart.
        facts.push(ambiguousFact(
          'benefits',
          'Benefits',
          '/portal/employee/benefits',
          'the benefits catalogue',
          'No benefit came back for your record. This read cannot tell an empty catalogue from a failed '
            + 'one, so rather than state a count, open your benefits screen or ask the helpdesk.',
        ));
      } else {
        const eligible = cat.entries.filter((e) => e.eligibility?.eligible);
        const rules = eligible.length
          ? describeRules(eligible[0].benefit.rules || []).slice(0, 2).join(' ')
          : '';
        facts.push({
          key: 'benefits',
          label: 'Benefits',
          read: 'ok',
          sentence: 'Of ' + cat.entries.length + ' benefit(s) in the catalogue, you currently qualify for '
            + eligible.length + ': ' + eligible.map((e) => e.benefit.name).join(', ')
            + (rules ? '. The rule reads: ' + rules : '') + '.',
          href: '/portal/employee/benefits',
          sourceLabel: 'the benefits catalogue',
        });
      }
    } catch (e: any) {
      logFail('personalFacts.benefits', e);
      facts.push(unreadableFact('benefits', 'Benefits', '/portal/employee/benefits', 'the benefits catalogue'));
    }
  }

  if (topics.indexOf('expenses') >= 0) {
    // NO COUNT IS EVER STATED HERE. claimsForEmployee() returns [] both when there are no claims and
    // when the read failed, so any number derived from it is a figure that cannot distinguish the
    // two. The honest answer is the route to the register, which shows the truth either way.
    facts.push(ambiguousFact(
      'expenses',
      'Expense claims',
      '/portal/employee/expenses',
      'the expenses register',
      'Your claims and where each one has got to are on your expenses screen. I do not state a count '
        + 'here, because the read behind it cannot tell an empty list from a failed one.',
    ));
  }

  return { facts, refusal: null };
}

// -------------------------------------------------------------------------------------------------
// THE MODEL CLAMP
// -------------------------------------------------------------------------------------------------

/** Digit runs, so "12" and "1" and "2026" are each compared as written. */
function digitRuns(s: string): string[] {
  return String(s || '').match(/\d+/g) || [];
}

/** Anything that looks like somewhere to go. A model must not invent a destination. */
function linkish(s: string): string[] {
  return String(s || '').match(/(https?:\/\/\S+|www\.\S+|\/[a-z0-9][\w\-/]*)/gi) || [];
}

/**
 * Claims this product may never make, whoever proposed them.
 *
 * EduRankAI is the technology platform; accredited partners award credentials. A model rephrasing a
 * programme description is exactly where "our university" appears for the first time, and it would be
 * a regulatory claim rather than a turn of phrase.
 */
const FORBIDDEN_CLAIM_PATTERNS: readonly RegExp[] = [
  /\b(our|the)\s+university\b/i,
  /\bwe\s+(are|is)\s+a\s+university\b/i,
  /\bwe\s+(award|confer|grant|issue)\s+(a\s+)?(degree|degrees|diploma|diplomas)\b/i,
  /\baccredited\s+by\s+us\b/i,
];

export type RephraseVerdict = { ok: true; text: string } | { ok: false; reason: string };

/**
 * THE VALIDATOR. The model proposes; this disposes.
 *
 * A rephrasing is accepted only when it introduces NO new fact:
 *   - every digit run in the proposal appears in the source;
 *   - every link-shaped token in the proposal appears in the source;
 *   - no currency symbol or percent sign that is not in the source;
 *   - no university or awarding claim, ever;
 *   - and it is a rephrasing, not an essay: bounded against the source's own length.
 *
 * A failed proposal is a REFUSAL WITH A REASON and the template stands. It is never partly accepted,
 * because a partly accepted rephrasing is a sentence nobody wrote.
 */
export function guardRephrase(sourceText: string, proposed: string): RephraseVerdict {
  const src = String(sourceText || '');
  const out = String(proposed || '').trim();
  if (!out) return { ok: false, reason: 'the model returned nothing' };
  if (out.length > Math.max(200, src.length * 2)) return { ok: false, reason: 'the rephrasing is longer than the source it came from' };
  if (out.length < Math.min(20, src.length)) return { ok: false, reason: 'the rephrasing dropped almost all of the source' };

  const srcDigits = digitRuns(src);
  for (const d of digitRuns(out)) {
    if (srcDigits.indexOf(d) < 0) return { ok: false, reason: 'it introduced a number (' + d + ') that is not in the source' };
  }

  const srcLinks = linkish(src).map((l) => l.toLowerCase());
  for (const l of linkish(out)) {
    if (srcLinks.indexOf(l.toLowerCase()) < 0) return { ok: false, reason: 'it introduced a link (' + l + ') that is not in the source' };
  }

  for (const sym of ['%', '₹', '$', '€', '£', 'INR', 'CHF']) {
    if (out.indexOf(sym) >= 0 && src.indexOf(sym) < 0) {
      return { ok: false, reason: 'it introduced a money or percentage symbol that is not in the source' };
    }
  }

  for (const re of FORBIDDEN_CLAIM_PATTERNS) {
    if (re.test(out)) return { ok: false, reason: 'it made a claim about awarding credentials that this platform does not make' };
  }

  return { ok: true, text: out };
}

/** The instruction. It is narrow on purpose: the model is a copy editor, not a source. */
const REPHRASE_SYSTEM = [
  'You rewrite one passage of an internal document so it reads as a direct answer to a question.',
  'You may only use information contained in the passage.',
  'Do not add a number, a date, an amount, a percentage, a link or a name that is not in the passage.',
  'Do not answer from general knowledge. Do not add advice.',
  'If the passage does not answer the question, return the passage in plainer words and nothing else.',
  'Never say or imply that this organization is a university or that it awards degrees.',
  'Reply with the rewritten passage only, in at most three sentences.',
].join(' ');

/**
 * Rephrase claims, if and only if a model is configured.
 *
 * Each claim is rephrased AGAINST ITS OWN SOURCE and validated on its own, so a citation never drifts
 * off the text it belongs to. isReady() decides; there is no 503 and no blank answer when nothing is
 * configured — the templated claim is already a complete answer.
 */
async function rephraseClaims(claims: Claim[], question: string): Promise<Claim[]> {
  try {
    const { effectiveConfig, isReady, complete } = await import('@/lib/llm/gateway');
    const cfg = await effectiveConfig();
    if (!isReady(cfg)) return claims;

    const out: Claim[] = [];
    for (let i = 0; i < claims.length; i++) {
      const c = claims[i];
      if (i >= MAX_REPHRASED) { out.push(c); continue; }
      const res = await complete({
        feature: 'assistant.answer',
        system: REPHRASE_SYSTEM,
        messages: [{ role: 'user', content: 'Question: ' + question + '\n\nPassage:\n' + c.text }],
        maxTokens: 300,
        temperature: 0.2,
        fallback: '',
      });
      // NOTHING IS CREDITED AGAINST A STUB. `configured` and `ok` are both required before the reply
      // is treated as real — the same rule ai-tutor.ts learned the hard way about awarding XP.
      if (!res.configured || !res.ok || !res.text) { out.push(c); continue; }
      const verdict = guardRephrase(c.text, res.text);
      if (!verdict.ok) {
        console.warn('[assistant/answer] rephrasing refused: ' + verdict.reason);
        out.push(c);
        continue;
      }
      out.push({ text: verdict.text, source: c.source, rephrased: true });
    }
    return out;
  } catch (e: any) {
    logFail('rephraseClaims', e);
    return claims;
  }
}

// -------------------------------------------------------------------------------------------------
// ASSEMBLY
// -------------------------------------------------------------------------------------------------

function citationOf(p: Passage): Citation {
  return { label: p.label, href: p.href, sourceLabel: p.sourceLabel, why: p.why };
}

/** A passage becomes a claim of the passage's OWN WORDS, trimmed but never paraphrased by this file. */
export function claimFromPassage(p: Passage): Claim {
  const text = p.text.length > CLAIM_MAX_CHARS ? p.text.slice(0, CLAIM_MAX_CHARS - 1).trimEnd() + '…' : p.text;
  return { text, source: citationOf(p), rephrased: false };
}

export function escalationFor(asker: Asker): EscalationRoute {
  return asker.kind === 'visitor' ? { ...VISITOR_ESCALATION } : { ...STAFF_ESCALATION };
}

/** The screens a person opens to do the thing themselves. Never called from here. */
export function actionsFor(asker: Asker, question: string): ActionLink[] {
  const q = String(question || '');
  const table = asker.kind === 'visitor' ? PUBLIC_ACTION_ROUTES : ACTION_ROUTES;
  const out: ActionLink[] = [];
  for (const r of table) if (r.pattern.test(q) && out.length < 3) out.push({ label: r.label, href: r.href });
  return out;
}

/** What was searched, as one readable sentence. Never printed as "no results" on its own. */
export function whereItLooked(searched: readonly SearchedSource[]): string {
  const done = searched.filter((s) => s.searched).map((s) => s.label);
  const skipped = searched.filter((s) => !s.searched).map((s) => s.label);
  if (done.length === 0 && skipped.length === 0) return 'Nothing was searched.';
  const parts: string[] = [];
  if (done.length) parts.push('I looked in ' + done.join(', ') + '.');
  if (skipped.length) parts.push('Not searched: ' + skipped.join(', ') + '.');
  return parts.join(' ');
}

/**
 * THE FLOOR DECISION, as a pure function.
 *
 * It is extracted rather than left inline in ask() for one reason: this is the judgement that decides
 * whether a person is told a fact or told nobody knows, and a judgement that can only be exercised by
 * running the whole pipeline against a live database is a judgement nothing tests. It takes the
 * passages retrieval produced and the number of personal facts read, and answers with the reason —
 * never with prose, which belongs to the caller.
 *
 * A personal fact grounds an answer on its own: "your leave register shows..." is cited to the
 * register it was read from, and no document needs to mention the question for that to be true.
 */
export function groundingDecision(
  passages: readonly Passage[],
  factCount: number,
): { grounded: boolean; reason: UnknownReason | null } {
  const usable = passages.filter((p) => p && p.aboveFloor);
  if (usable.length > 0 || (Number(factCount) || 0) > 0) return { grounded: true, reason: null };
  // Something came back and every bit of it was too weak to answer from. That is a different failure
  // from an empty corpus, and the person deserves to be told which one happened.
  return { grounded: false, reason: passages.length > 0 ? 'below-floor' : 'nothing-found' };
}

/**
 * THE GROUNDED CONSTRUCTOR, and the only way to build one.
 *
 * The tuple type already makes an empty claim list a compile error. The runtime check below is for
 * the callers TypeScript cannot see — an API route handed a JSON body, a page written in a hurry —
 * and it does not throw: it returns the honest UnknownAnswer, which is the answer that was true all
 * along.
 */
export function groundedAnswer(base: AnswerBase, claims: readonly Claim[]): Answer {
  const usable = claims.filter((c) => c && c.text && c.source && c.source.label && c.source.href);
  if (usable.length === 0) {
    return unknownAnswer(base, 'nothing-found',
      'I could not find anything written down that answers this, so I am not going to answer it.');
  }
  const head = usable[0];
  const rest = usable.slice(1, MAX_CLAIMS);
  return { ...base, kind: 'grounded', claims: [head, ...rest] as unknown as readonly [Claim, ...Claim[]] };
}

/** The do-not-know answer. It still says where it looked and still offers a person. */
export function unknownAnswer(base: AnswerBase, reason: UnknownReason, sentence: string): UnknownAnswer {
  return { ...base, kind: 'unknown', reason, sentence };
}

// -------------------------------------------------------------------------------------------------
// ASK
// -------------------------------------------------------------------------------------------------

export interface AskOptions {
  /** Whose personal record the question is about. Defaults to the asker's own; checked per row. */
  subjectEmployeeId?: string | null;
  /** Set false to template the answer even where a model is configured. Retrieval is unaffected. */
  allowModel?: boolean;
}

/**
 * ASK. The whole pipeline, and every stage of it can refuse.
 *
 * The asker must already be resolved (corpus.resolveAsker) from the caller's own session, so this
 * function cannot be handed a wider scope than the request had.
 */
export async function ask(asker: Asker, question: string, opts: AskOptions = {}): Promise<Answer> {
  const q = String(question || '').trim();

  const baseOf = (searched: readonly SearchedSource[], degraded: boolean): AnswerBase => ({
    question: q,
    askerKind: asker.kind,
    searched,
    scopeNote: asker.explanation,
    escalation: escalationFor(asker),
    actions: actionsFor(asker, q),
    degraded,
  });

  // 1. A SUBJECT WITH NO PERMITTED RETRIEVAL. Refused before anything is searched, so that "nothing
  //    was found" can never be the sentence that covers for a read that should not exist.
  const banned = forbiddenTopic(q);
  if (banned) {
    const retrieval = await retrieve(asker, q);
    return unknownAnswer(
      baseOf(retrieval.searched, false),
      'forbidden',
      'I have no route to ' + banned + ', for anyone, including administrators and the founder. '
        + 'Nothing was searched. A person is the right place to take this.',
    );
  }

  // 2. RETRIEVE, against the corpus this asker's authorization built.
  let retrieval: Retrieval;
  try {
    retrieval = await retrieve(asker, q);
  } catch (e: any) {
    logFail('retrieve', e);
    return unknownAnswer(
      baseOf([], true),
      'nothing-found',
      'I could not search just now, so I am not going to answer from memory. Please ask a person.',
    );
  }

  const base = baseOf(retrieval.searched, retrieval.degraded);

  if (retrieval.tooShort) {
    return unknownAnswer(base, 'too-short', 'That is too short for me to search for. Ask it as a question and I will look.');
  }

  // 3. PERSONAL FACTS, from the existing fact functions, for this person's OWN record unless the org
  //    graph says otherwise. A refusal here is an answer, not an error.
  let facts: PersonalFact[] = [];
  let refusal: string | null = null;
  try {
    const got = await personalFacts(asker, q, opts.subjectEmployeeId);
    facts = got.facts;
    refusal = got.refusal;
  } catch (e: any) {
    logFail('personalFacts', e);
  }

  if (refusal) {
    return unknownAnswer(
      base,
      'not-yours',
      refusal + ' I can answer about your own record, and the helpdesk can route anything else.',
    );
  }

  // 4. THE FLOOR. Retrieval always returns something; below the floor the honest answer is that this
  //    was not found, plus where it was looked for.
  const usable = retrieval.passages.filter((p) => p.aboveFloor);
  const decision = groundingDecision(retrieval.passages, facts.length);

  if (!decision.grounded) {
    const lead = decision.reason === 'below-floor'
      ? 'I found documents that mention some of those words, but none of them close enough to the '
        + 'question for me to answer from. I am not going to guess.'
      : 'I could not find anything written down that answers this.';
    return unknownAnswer(base, decision.reason || 'nothing-found', lead + ' ' + whereItLooked(retrieval.searched));
  }

  // 5. ASSEMBLE FROM THE RETRIEVED TEXT. Personal facts first — they are the answer to "my" questions —
  //    then the documents, best first.
  const documentClaims = usable.slice(0, MAX_CLAIMS).map(claimFromPassage);
  const factClaims = facts.map(factClaim);

  // Only DOCUMENT text is offered to a model. A personal figure is never rephrased: there is no
  // rewording of "12 days" that is worth the chance of it becoming something else.
  const edited = opts.allowModel === false ? documentClaims : await rephraseClaims(documentClaims, q);

  return groundedAnswer(base, [...factClaims, ...edited]);
}

/**
 * Convenience for a public surface: resolve nothing, ask as a visitor.
 *
 * A visitor's corpus contains no staff document at all, which is why this is safe to expose on a page
 * with no session — the narrowing happened when the Asker was built, not when the answer was printed.
 */
export async function askAsVisitor(question: string, opts: AskOptions = {}): Promise<Answer> {
  const { visitorAsker } = await import('@/lib/assistant/corpus');
  return ask(visitorAsker(), question, opts);
}

/** Re-exported so a surface can render the floor it was judged against without importing two modules. */
export { RELEVANCE_FLOOR };
