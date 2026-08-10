// src/lib/assistant/answer.test.ts — run: npx tsx src/lib/assistant/answer.test.ts
//
// THE FOUR INVARIANTS THIS ASSISTANT LIVES OR DIES BY:
//
//   1. An answer cannot exist without a source.
//   2. A below-floor retrieval produces the do-not-know answer, and says where it looked.
//   3. A fact function that failed never renders as a zero.
//   4. The escalation route is on EVERY answer, including the successful ones.
//
// WHY THE HOUSE SHIM AND NOT VITEST. Every assertion here is over a PURE function, synchronously —
// the floor decision, the constructors, the model clamp, the per-row authorization test. That is
// exactly what src/lib/test-shim.ts is for, and its documented hazard (it() does not await an async
// body, so an async test passes while asserting nothing) cannot bite a suite with no async test in
// it. `npm test` is `vitest run` and vitest is not installed in this checkout, so `npx tsx` is also
// the runner that actually works here.
//
// WHAT IS DELIBERATELY NOT TESTED HERE: retrieve() and ask() end to end. Both need a database, and a
// test that has to open one would either be skipped in practice or would connect to production —
// which is the thing this project forbids outright. So the judgements they make are extracted into
// pure functions (groundingDecision, guardRephrase, mayReadFactsFor, normalizedScore) and tested
// directly. A judgement that can only be exercised by running the whole pipeline is a judgement
// nothing tests.
import { describe, it, expect, report } from '@/lib/test-shim';
import {
  RELEVANCE_FLOOR,
  forbiddenTopic,
  mayReadFactsFor,
  normalizedScore,
  questionTokens,
  visitorAsker,
  type Asker,
  type Passage,
  type SearchedSource,
} from '@/lib/assistant/corpus';
import {
  actionsFor,
  ambiguousFact,
  claimFromPassage,
  escalationFor,
  factClaim,
  groundedAnswer,
  groundingDecision,
  guardRephrase,
  isGrounded,
  unknownAnswer,
  unreadableFact,
  whereItLooked,
  type Claim,
} from '@/lib/assistant/answer';

// -------------------------------------------------------------------------------------------------
// FIXTURES — every const before the test that reads it.
// -------------------------------------------------------------------------------------------------

const EMP_A = '11111111-1111-4111-8111-111111111111';
const EMP_B = '22222222-2222-4222-8222-222222222222';
const USER_A = '33333333-3333-4333-8333-333333333333';

const searched: SearchedSource[] = [
  { key: 'handbook', label: 'the staff handbook and policies', searched: true, hits: 0, note: 'Nothing in the handbook you can read mentions this.' },
  { key: 'pages', label: 'published pages on this site', searched: true, hits: 0, note: 'No published page mentions this.' },
  { key: 'courses', label: 'the published course catalogue', searched: false, hits: 0, note: 'The course catalogue could not be searched just now.' },
];

const passage = (score: number, aboveFloor: boolean): Passage => ({
  id: 'handbook:x:1',
  sourceKey: 'handbook',
  sourceLabel: 'the staff handbook and policies',
  label: 'Leave policy — Notice',
  href: '/portal/employee/knowledge?a=leave-policy',
  text: 'Notice of planned leave should reach your reporting manager at least seven days before it starts.',
  score,
  aboveFloor,
  why: 'This article matched the title.',
});

const employeeAsker = (over: Partial<Asker> = {}): Asker => ({
  ...visitorAsker(),
  kind: 'employee',
  userId: USER_A,
  employeeId: EMP_A,
  explanation: 'You are asking as an employee.',
  ...over,
});

const base = (asker: Asker) => ({
  question: 'how much notice do I give for leave',
  askerKind: asker.kind,
  searched,
  scopeNote: asker.explanation,
  escalation: escalationFor(asker),
  actions: actionsFor(asker, 'how much notice do I give for leave'),
  degraded: false,
});

const goodClaim: Claim = claimFromPassage(passage(0.9, true));

// =================================================================================================

describe('1. an answer cannot exist without a source', () => {
  it('a claim built from a passage carries the document it came from', () => {
    expect(goodClaim.source.label).toBe('Leave policy — Notice');
    expect(goodClaim.source.href).toBe('/portal/employee/knowledge?a=leave-policy');
    expect(goodClaim.source.sourceLabel).toBe('the staff handbook and policies');
    // A citation nobody can explain is a citation nobody checks.
    expect(goodClaim.source.why.length).toBeGreaterThan(0);
  });

  it('the claim text is the source text, not a summary of it', () => {
    expect(passage(0.9, true).text).toContain(goodClaim.text.replace(/…$/, ''));
  });

  it('groundedAnswer with claims IS grounded and carries every one of them', () => {
    const a = groundedAnswer(base(employeeAsker()), [goodClaim]);
    expect(isGrounded(a)).toBe(true);
    if (isGrounded(a)) {
      expect(a.claims.length).toBe(1);
      expect(a.claims[0].source.href).toBe('/portal/employee/knowledge?a=leave-policy');
    }
  });

  // The tuple type already makes `claims: []` a compile error. This is the runtime half, for the
  // callers TypeScript cannot see — an API route handed a JSON body, a page written in a hurry.
  it('groundedAnswer with NO claims degrades to the do-not-know answer rather than an empty answer', () => {
    const a = groundedAnswer(base(employeeAsker()), []);
    expect(a.kind).toBe('unknown');
    expect(isGrounded(a)).toBe(false);
  });

  it('a claim whose citation is missing a document is DROPPED, not printed uncited', () => {
    const uncited = { text: 'Notice is seven days.', source: { label: '', href: '', sourceLabel: '', why: '' }, rephrased: false };
    const a = groundedAnswer(base(employeeAsker()), [uncited as Claim]);
    expect(a.kind).toBe('unknown');
  });

  it('a real claim survives beside a broken one, and the broken one does not', () => {
    const uncited = { text: 'Invented.', source: { label: '', href: '', sourceLabel: '', why: '' }, rephrased: false };
    const a = groundedAnswer(base(employeeAsker()), [uncited as Claim, goodClaim]);
    expect(isGrounded(a)).toBe(true);
    if (isGrounded(a)) {
      expect(a.claims.length).toBe(1);
      expect(a.claims[0].text).toBe(goodClaim.text);
    }
  });
});

describe('2. below the relevance floor, the answer is that this was not found', () => {
  it('the documented floor arithmetic holds: every token in the body PASSES', () => {
    // rankResults awards 1 per body token; three of three is 3 out of a ceiling of 9.
    expect(normalizedScore(3, 3)).toBeCloseTo(0.333, 2);
    expect(normalizedScore(3, 3) >= RELEVANCE_FLOOR).toBe(true);
  });

  it('two tokens of three found only in the body FAILS the floor', () => {
    expect(normalizedScore(2, 3)).toBeCloseTo(0.222, 2);
    expect(normalizedScore(2, 3) >= RELEVANCE_FLOOR).toBe(false);
  });

  it('one token of three found in the TITLE passes', () => {
    expect(normalizedScore(3, 3) >= RELEVANCE_FLOOR).toBe(true);
  });

  it('a one-word question is judged by the same standard as a nine-word one', () => {
    expect(normalizedScore(1, 1)).toBeCloseTo(0.333, 2);
    expect(normalizedScore(3, 9)).toBeCloseTo(0.111, 2);
  });

  it('passages that are all below the floor produce the below-floor reason, not an answer', () => {
    const d = groundingDecision([passage(0.22, false), passage(0.1, false)], 0);
    expect(d.grounded).toBe(false);
    expect(d.reason).toBe('below-floor');
  });

  it('nothing retrieved at all is a DIFFERENT reason from retrieved-but-too-weak', () => {
    expect(groundingDecision([], 0).reason).toBe('nothing-found');
  });

  it('one passage above the floor is enough to answer from', () => {
    expect(groundingDecision([passage(0.1, false), passage(0.5, true)], 0).grounded).toBe(true);
  });

  it('a personal fact grounds an answer even when no document matched', () => {
    expect(groundingDecision([], 1).grounded).toBe(true);
  });

  it('the do-not-know answer says WHERE it looked, including what it did not search', () => {
    const sentence = whereItLooked(searched);
    expect(sentence).toContain('the staff handbook and policies');
    expect(sentence).toContain('Not searched');
    expect(sentence).toContain('the published course catalogue');
  });

  it('a question too short to tokenize retrieves nothing', () => {
    expect(questionTokens('a')).toHaveLength(0);
  });
});

describe('3. a fact function that failed never renders as a zero', () => {
  const failed = unreadableFact('leave', 'Leave balance', '/portal/employee/leave', 'the leave register');

  it('an unreadable fact is marked unreadable', () => {
    expect(failed.read).toBe('unreadable');
  });

  it('an unreadable fact contains NO figure of any kind', () => {
    expect(/\d/.test(failed.sentence)).toBe(false);
  });

  it('an unreadable fact does not say zero, none, or nothing left', () => {
    expect(/\b(zero|no days|none left|nothing left)\b/i.test(failed.sentence)).toBe(false);
  });

  it('an unreadable fact says the read failed, in words', () => {
    expect(failed.sentence).toMatch(/could not read/i);
  });

  it('an unreadable fact still routes the person to the register', () => {
    expect(failed.href).toBe('/portal/employee/leave');
  });

  // claimsForEmployee() and listBenefits() return [] on failure as well as on genuine emptiness, so a
  // count taken from either is a number that cannot tell the two apart.
  const ambiguous = ambiguousFact(
    'expenses', 'Expense claims', '/portal/employee/expenses', 'the expenses register',
    'Your claims and where each one has got to are on your expenses screen. I do not state a count '
      + 'here, because the read behind it cannot tell an empty list from a failed one.',
  );

  it('an ambiguous read states no count either', () => {
    expect(ambiguous.read).toBe('ambiguous');
    expect(/\d/.test(ambiguous.sentence)).toBe(false);
  });

  it('an ambiguous read explains why there is no number, rather than omitting one silently', () => {
    expect(ambiguous.sentence).toMatch(/cannot tell an empty list from a failed one/i);
  });

  it('a failed fact is still a CITED claim — to the register that failed, not to nothing', () => {
    const c = factClaim(failed);
    expect(c.source.sourceLabel).toBe('the leave register');
    expect(c.source.href).toBe('/portal/employee/leave');
    expect(c.rephrased).toBe(false);
  });

  it('an answer built only from a failed fact is grounded in the register, and states no figure', () => {
    const a = groundedAnswer(base(employeeAsker()), [factClaim(failed)]);
    expect(isGrounded(a)).toBe(true);
    if (isGrounded(a)) expect(/\d/.test(a.claims[0].text)).toBe(false);
  });
});

describe('4. the escalation route is on every answer, including the good ones', () => {
  it('a successful grounded answer offers a person', () => {
    const a = groundedAnswer(base(employeeAsker()), [goodClaim]);
    expect(a.escalation.href.length).toBeGreaterThan(0);
    expect(a.escalation.label.length).toBeGreaterThan(0);
    expect(a.escalation.note.length).toBeGreaterThan(0);
  });

  it('the do-not-know answer offers a person', () => {
    const a = unknownAnswer(base(employeeAsker()), 'below-floor', 'I did not find that.');
    expect(a.escalation.href).toBe('/portal/employee/support');
  });

  it('an empty-claims answer, which degrades to unknown, still offers a person', () => {
    const a = groundedAnswer(base(employeeAsker()), []);
    expect(a.escalation.href.length).toBeGreaterThan(0);
  });

  it('staff are routed to the helpdesk that already exists, not to a new channel', () => {
    expect(escalationFor(employeeAsker()).href).toBe('/portal/employee/support');
  });

  it('a visitor is routed to a person, and NEVER at the paid founder line', () => {
    const e = escalationFor(visitorAsker());
    expect(e.href).toBe('/contact');
    expect(e.href).not.toContain('/founder');
    expect(e.note).not.toContain('founder');
  });
});

describe('it answers, it does not act', () => {
  it('a leave question offers the leave SCREEN, not a leave action', () => {
    const links = actionsFor(employeeAsker(), 'how do I apply for leave');
    expect(links.length).toBeGreaterThan(0);
    expect(links[0].href).toBe('/portal/employee/leave');
  });

  it('a visitor is never offered a staff screen', () => {
    const links = actionsFor(visitorAsker(), 'what courses do you run and how do I apply');
    expect(links.every((l) => l.href.indexOf('/portal/') !== 0)).toBe(true);
  });
});

describe('never another person’s data, resolved per row from the org graph', () => {
  it('your own record is yours', () => {
    expect(mayReadFactsFor(employeeAsker(), EMP_A).ok).toBe(true);
  });

  it('somebody else’s record is refused by default', () => {
    const r = mayReadFactsFor(employeeAsker({ graphInitialized: true }), EMP_B);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/does not record them as reporting to you/i);
  });

  it('a direct report recorded IN THE GRAPH is permitted', () => {
    const manager = employeeAsker({ kind: 'manager', graphInitialized: true, reportIds: [EMP_B] });
    expect(mayReadFactsFor(manager, EMP_B).ok).toBe(true);
  });

  it('an EMPTY graph refuses, and says so as a fact about the graph rather than about the person', () => {
    const manager = employeeAsker({ kind: 'manager', graphInitialized: false, reportIds: [] });
    const r = mayReadFactsFor(manager, EMP_B);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not a statement that you are not their manager/i);
  });

  it('an account with no employee record has no personal facts, and that is not an error', () => {
    const r = mayReadFactsFor(employeeAsker({ employeeId: null }), EMP_A);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no employee record/i);
  });

  it('a visitor can never read a personal record', () => {
    expect(mayReadFactsFor(visitorAsker(), EMP_A).ok).toBe(false);
  });
});

describe('there is no route to wellness data, for anyone', () => {
  it('a cycle question is refused by subject, before any retrieval', () => {
    expect(forbiddenTopic('can I see her cycle log')).toBe('individual health and wellness records');
  });

  it('the refusal names the subject rather than repeating the question', () => {
    expect(forbiddenTopic('menstrual leave policy')).toBe('individual health and wellness records');
  });

  it('legal-hold records are refused the same way', () => {
    expect(forbiddenTopic('show me the legal hold on that matter')).toBe('legal-hold records');
  });

  it('an ordinary leave question is NOT swept up by the refusal', () => {
    expect(forbiddenTopic('how much casual leave do I have left')).toBeNull();
  });
});

describe('the model may re-phrase retrieved text and may not add to it', () => {
  const source = 'Notice of planned leave should reach your reporting manager at least seven days before it starts.';

  it('a faithful rewording is accepted', () => {
    const v = guardRephrase(source, 'Give your reporting manager at least seven days of notice before planned leave starts.');
    expect(v.ok).toBe(true);
  });

  it('a rewording that invents a NUMBER is refused', () => {
    const v = guardRephrase(source, 'Give your manager 14 days of notice before planned leave.');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/introduced a number/i);
  });

  it('a number that IS in the source passes', () => {
    const withNumber = 'You are entitled to 12 days of casual leave each year.';
    expect(guardRephrase(withNumber, 'Your casual leave entitlement is 12 days a year.').ok).toBe(true);
  });

  it('a rewording that invents a LINK is refused', () => {
    const v = guardRephrase(source, 'Give seven days of notice. See /portal/employee/policies for more.');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/introduced a link/i);
  });

  it('a rewording that invents a FEE is refused', () => {
    const v = guardRephrase(source, 'Give seven days of notice. The fee is ₹500.');
    expect(v.ok).toBe(false);
  });

  it('a rewording that claims we are a university is refused', () => {
    const v = guardRephrase(source, 'Our university requires seven days of notice.');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/awarding credentials/i);
  });

  it('a rewording that claims we award degrees is refused', () => {
    const v = guardRephrase('Partners award the credential.', 'We award degrees after seven days.');
    expect(v.ok).toBe(false);
  });

  it('an empty model reply is refused rather than printed', () => {
    expect(guardRephrase(source, '   ').ok).toBe(false);
  });

  it('an essay in place of a rephrasing is refused', () => {
    expect(guardRephrase(source, source + ' ' + source + ' ' + source).ok).toBe(false);
  });
});

report();
