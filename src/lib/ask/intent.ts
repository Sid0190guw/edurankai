// src/lib/ask/intent.ts — WHAT WAS ASKED, AND WHAT MUST NOT BE ANSWERED.
//
// =================================================================================================
// PURE, AND DELIBERATELY DUMB
// =================================================================================================
//
// No database, no model, no network. Word lists and shapes. Every function here is synchronous and
// total, which is why it can be tested exhaustively — and it IS tested, in intent.test.ts, because
// this file decides which questions get refused and a refusal rule nobody can execute in a test is
// a refusal rule nobody can trust.
//
// A CLASSIFIER IS NOT A GATE. Nothing in this file grants anything. It decides which retrieval to
// run, and which three shapes of question to refuse before any retrieval runs at all. Authorization
// is done in the WHERE clause of the retrieval, by the caller, from the session — see
// src/lib/ask/employee.ts. If this file were bypassed entirely the corpus would still be correctly
// scoped; what would be lost is the refusal of questions that are wrong to answer even from a
// correctly scoped corpus.
//
// =================================================================================================
// THE THREE REFUSALS, AND WHY EACH IS COARSE ON PURPOSE
// =================================================================================================
//
// 1. HEALTH AND WELLNESS. Individual health data is out of bounds to everyone, including the
//    founder. src/lib/wellness.ts deliberately contains no "read any user's log" helper so that no
//    screen can be built on one, and this module inherits that: there is no retrieval path to
//    wellness data here, not even a filtered one. The word test exists so a question about it is
//    answered with a person rather than with a handbook search that might surface something
//    adjacent.
//
//    THE WORD "PERIOD" IS NOT IN THE LIST, and that is not an oversight. "What is my notice period"
//    and "the leave period" are ordinary workplace questions, and a health filter that swallows them
//    makes the assistant useless at exactly the questions people most need answered.
//
// 2. ANOTHER PERSON. An employee may ask about THEIR leave, THEIR payslip, THEIR training. Any
//    question that would return a row about somebody else is refused. The net is coarse and it
//    catches innocent questions: a false positive costs one refusal with a named human attached, and
//    a false negative is one person reading another person's record. Those are not comparable, so
//    the net stays coarse and the refusal stays polite.
//
//    A manager legitimately needs some of these answers. This assistant is not where they get them:
//    /portal/approvals and /portal/team already resolve that per row through the organization graph,
//    and duplicating a per-row relationship check inside a question box would be a second answer to a
//    question that already has one — and the two would disagree within a release.
//
// 3. AN ACTION. It answers, it does not act. No approving leave, no changing a record, no submitting
//    a claim. The test is shaped rather than keyword-based, because "how do I apply for leave" and
//    "apply for leave for me" share their most important word. An assistant that can act is an
//    assistant that can be talked into acting.

/** Coarse buckets. The employee retrieval switches on these. */
export type EmployeeIntent =
  | 'leave.balance'
  | 'leave.apply'
  | 'leave.approver'
  | 'training.assigned'
  | 'expense.claim'
  | 'payslip.where'
  | 'payslip.line'
  | 'benefits.mine'
  | 'manager.who'
  | 'policy.find'
  | 'unknown';

/** Coarse buckets for the public side. */
export type VisitorIntent =
  | 'programmes'
  | 'courses'
  | 'apply'
  | 'partner.awards'
  | 'fees'
  | 'cohort.start'
  | 'page.find'
  | 'unknown';

/** Longer than this and it is not a question, it is a paste. Truncated, never rejected. */
export const QUESTION_MAX = 300;
/** Shorter than this and there is nothing to retrieve on. */
export const QUESTION_MIN = 3;

/** Trim, collapse whitespace, cap. The one place a raw question becomes a usable one. */
export function normalizeQuestion(raw: unknown): string {
  return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, QUESTION_MAX);
}

function has(text: string, words: readonly string[]): boolean {
  for (const w of words) if (text.indexOf(w) >= 0) return true;
  return false;
}

// -------------------------------------------------------------------------------------------------
// REFUSAL 1 — HEALTH AND WELLNESS
// -------------------------------------------------------------------------------------------------

const HEALTH_WORDS: readonly string[] = [
  'wellness', 'wellbeing', 'well-being', 'menstrual', 'menstruation', 'cycle log', 'my cycle',
  'symptom', 'pregnan', 'fertility', 'contracept', 'gynae', 'gynec', 'mental health', 'therapy',
  'therapist', 'counsell', 'diagnos', 'medical record', 'health record', 'prescription',
  'consult message', 'sick note', 'medical certificate',
];

/**
 * Is this a question about health or wellness data?
 *
 * TRUE MEANS REFUSE, for everybody, at every level of authority. There is no capability that makes
 * this answerable and no admin surface that may show it. Callers must not ask a second question
 * after this one returns true.
 */
export function isHealthQuestion(question: string): boolean {
  return has(String(question || '').toLowerCase(), HEALTH_WORDS);
}

// -------------------------------------------------------------------------------------------------
// REFUSAL 2 — SOMEBODY ELSE
// -------------------------------------------------------------------------------------------------

const OTHER_PERSON_PHRASES: readonly string[] = [
  'someone else', 'somebody else', 'anyone else', 'anybody else', 'another employee',
  'another person', 'other people', 'my colleague', 'my teammate', 'my team member',
  'my report', 'my reports', 'direct report',
  'his salary', 'her salary', 'their salary', 'his pay', 'her pay', 'their pay',
  'his leave', 'her leave', 'their leave', 'his payslip', 'her payslip', 'their payslip',
  'his balance', 'her balance', 'who is on leave', 'who else',
  'list of employees', 'staff list', 'everyone in my team', 'my whole team',
];

const POSSESSIVE_NAME = /^[A-Z][a-z]{2,}(’s|'s)$/;

/**
 * Would answering this return a row about somebody who is not the asker?
 *
 * TWO TESTS, both coarse:
 *   - a phrase from the list above, or
 *   - a possessive on a capitalised word that is not the first word of the sentence
 *     ("what is Priya's leave balance"), which is how these questions are actually typed.
 *
 * The capitalisation test ignores the first word, so a sentence that merely STARTS with a capital
 * is not caught by it — that is ordinary typing, not a name.
 */
export function mentionsAnotherPerson(question: string): boolean {
  const q = String(question || '');
  if (has(q.toLowerCase(), OTHER_PERSON_PHRASES)) return true;
  const words = q.split(/\s+/).slice(1);
  for (const w of words) if (POSSESSIVE_NAME.test(w)) return true;
  return false;
}

// -------------------------------------------------------------------------------------------------
// REFUSAL 3 — AN ACTION
// -------------------------------------------------------------------------------------------------

const ACTION_VERBS: readonly string[] = [
  'approve', 'reject', 'decline', 'submit', 'file', 'raise', 'cancel', 'withdraw', 'delete',
  'change', 'update', 'edit', 'book', 'assign', 'enrol', 'enroll', 'pay', 'transfer', 'sign',
  'acknowledge', 'apply',
];

const ON_MY_BEHALF: readonly string[] = [
  'for me', 'on my behalf', 'do it for', 'can you do', 'please do',
];

const POLITENESS = /^(please|can you|could you|would you|will you|kindly|hey|hi|hello|i want you to|i need you to)\s+/;

/**
 * Is the asker telling the assistant to DO something rather than asking what to do?
 *
 * THE SHAPE, NOT THE WORD. "How do I apply for leave" is a question; "apply for leave" is an
 * instruction, and they share their most important word. So the test is whether the sentence OPENS
 * with an action verb once the politeness is stripped, or asks for something to be done "for me". A
 * question word (how, where, who, what, when, why, can I, do I) is what makes it a question, and
 * those never open with the verb.
 */
export function isActionRequest(question: string): boolean {
  const q = String(question || '').trim().toLowerCase();
  if (!q) return false;
  if (has(q, ON_MY_BEHALF)) return true;
  const stripped = q.replace(POLITENESS, '').trim();
  const first = stripped.split(/[^a-z]+/).filter(Boolean)[0] || '';
  return ACTION_VERBS.indexOf(first) >= 0;
}

// -------------------------------------------------------------------------------------------------
// THE CLASSIFIERS
// -------------------------------------------------------------------------------------------------

const LEAVE_WORDS: readonly string[] = ['leave', 'holiday', 'time off', 'vacation', 'day off', 'comp off', 'comp-off'];
const BALANCE_WORDS: readonly string[] = ['balance', 'how many', 'left', 'remaining', 'entitle', 'quota', 'allowance'];
const APPROVER_WORDS: readonly string[] = ['approve', 'approver', 'approval', 'who signs', 'sign off', 'authorise', 'authorize'];

/**
 * WHAT AN EMPLOYEE ASKED. Order matters: the more specific tests run first, and anything
 * recognisably about the workplace but not about a personal record falls to 'policy.find', which
 * searches the handbook. 'unknown' searches the handbook too — the difference between them is only
 * what the answer says when the handbook has nothing.
 */
export function classifyEmployee(question: string): EmployeeIntent {
  const q = String(question || '').toLowerCase();

  if (has(q, ['payslip', 'pay slip', 'salary slip', 'pay stub'])) {
    if (has(q, ['mean', 'meaning', 'component', 'deduction', 'line', 'hra', 'gross', 'net', 'tax'])) {
      return 'payslip.line';
    }
    return 'payslip.where';
  }
  if (has(q, ['reporting manager', 'my manager', 'who do i report', 'line manager'])) return 'manager.who';
  if (has(q, LEAVE_WORDS)) {
    if (has(q, APPROVER_WORDS)) return 'leave.approver';
    if (has(q, BALANCE_WORDS)) return 'leave.balance';
    if (has(q, ['how do i', 'how to', 'apply', 'request', 'book'])) return 'leave.apply';
    return 'leave.balance';
  }
  if (has(q, ['expense', 'reimburse', 'claim', 'advance', 'travel cost'])) return 'expense.claim';
  if (has(q, ['training', 'course', 'learning', 'module', 'assigned to me'])) return 'training.assigned';
  if (has(q, ['benefit', 'insurance', 'medical cover', 'perk'])) return 'benefits.mine';
  if (has(q, ['policy', 'handbook', 'rule', 'notice period', 'probation', 'code of conduct', 'where is'])) {
    return 'policy.find';
  }
  return 'unknown';
}

/** WHAT A VISITOR ASKED. Same shape, public corpus. */
export function classifyVisitor(question: string): VisitorIntent {
  const q = String(question || '').toLowerCase();

  if (has(q, ['fee', 'cost', 'price', 'how much', 'tuition', 'charge'])) return 'fees';
  if (has(q, ['apply', 'admission', 'enrol', 'enroll', 'sign up', 'join', 'application'])) return 'apply';
  if (has(q, ['partner', 'accredit', 'award', 'degree', 'certificate', 'credential', 'recognis', 'recogniz'])) {
    return 'partner.awards';
  }
  if (has(q, ['cohort', 'start date', 'when does', 'intake', 'batch', 'begins', 'starts'])) return 'cohort.start';
  if (has(q, ['programme', 'program', 'bachelor', 'master', 'diploma'])) return 'programmes';
  if (has(q, ['course', 'subject', 'syllabus', 'curriculum', 'learn'])) return 'courses';
  if (has(q, ['policy', 'privacy', 'terms', 'about', 'contact', 'refund'])) return 'page.find';
  return 'unknown';
}

/**
 * THE SUGGESTED QUESTIONS, seeded from what people genuinely ask in their first week.
 *
 * They are LINKS, not autocomplete. An as-you-type endpoint against a corpus scoped by who is asking
 * is a probe oracle with a nicer interface — a hit count that moves as somebody types a colleague's
 * surname confirms the colleague exists — and every keystroke is a database round trip on a phone.
 */
export const EMPLOYEE_SUGGESTIONS: readonly string[] = [
  'How do I apply for leave?',
  'Who approves my leave request?',
  'How much leave do I have left?',
  'What training is assigned to me?',
  'How do I claim an expense?',
  'Where is my payslip?',
  'Who is my reporting manager?',
  'What benefits apply to me?',
];

export const VISITOR_SUGGESTIONS: readonly string[] = [
  'What programmes are offered?',
  'What courses can I take?',
  'How do I apply?',
  'Who awards the credential?',
  'When does the next cohort start?',
];
