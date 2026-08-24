// src/lib/talent/onboarding-review.test.ts — the review RULES, exercised with no database.
//
// THE IMPORT ITSELF IS THE FIRST ASSERTION. onboarding-review.ts resolves its database handle lazily
// inside ctx(), so importing decideReview() must not require DATABASE_URL. If that regresses —
// somebody adds a module-scope `import { db }` — this file fails at COLLECTION rather than on an
// assertion, which is exactly the signal wanted.
//
// WHAT IS TESTED HERE, AND WHAT IS NOT. Only the rules: which decision is legal from which status,
// what makes a rejection reason usable, how the gaps in a submission are composed, how answers are
// grouped and which of them the organisation supplied. The queries are not tested and could not
// honestly be — a test that mocks db.execute() asserts that the mock was called, not that the SQL is
// right, and this project has been bitten by exactly that shape of false confidence.
import { describe, it, expect } from 'vitest';
import {
  decideReview, rejectionProblem, submissionGaps, reviewSections, declarationViews,
  documentSummary, documentStatusLabel, onboardingStatusLabel, isReviewFilter, isApplicationRef,
  approveOnboarding, rejectOnboarding, reviewDetail, reviewDocuments,
  identityRegistryAvailable, identityRegistryStatus,
  REVIEW_FILTERS, MIN_REJECTION_REASON,
  type ReviewAction,
} from '@/lib/talent/onboarding-review';
import { DECLARATIONS, formProblems, missingDeclarations } from '@/lib/talent/onboarding';
import { ONBOARDING_STATUSES, ONBOARDING_SECTIONS } from '@/lib/talent/types';

const ACTIONS: ReviewAction[] = ['approve', 'reject', 'request_changes'];

/** A complete employee submission, so a test about ONE missing thing is about one missing thing. */
const completeEmployeeForm = () => ({
  fullName: 'A Candidate',
  personalEmail: 'a.candidate@example.com',
  phone: '+911234567890',
  dateOfBirth: '2000-01-01',
  addressLine: '1 Some Road',
  city: 'Bengaluru',
  country: 'India',
  emergencyContactName: 'Someone Else',
  emergencyContactPhone: '+911234567891',
  emergencyContactRelation: 'Parent',
  highestQualification: 'BE',
  institution: 'Some Institution',
  panNumber: 'ABCDE1234F',
  bankHolder: 'A Candidate',
  bankAccountNumber: '000111222333',
  bankIfsc: 'ABCD0123456',
});

const allDeclarations = () => {
  const d: Record<string, boolean> = {};
  for (const decl of DECLARATIONS) d[decl.key] = true;
  return d;
};

describe('decideReview owns which decision is legal from which status', () => {
  it('allows all three acts on a submitted onboarding, and says nothing more', () => {
    for (const action of ACTIONS) {
      const d = decideReview('submitted', action);
      expect(d.allowed).toBe(true);
      expect(d.reason).toBe('');
    }
  });

  it('refuses every act from every other status the contract knows', () => {
    const others = ONBOARDING_STATUSES.filter((s) => s !== 'submitted');
    expect(others.length).toBe(6);
    for (const status of others) {
      for (const action of ACTIONS) {
        expect(decideReview(status, action).allowed).toBe(false);
      }
    }
  });

  // A refusal an operator cannot read is a refusal they will work around. Every one of them has to
  // be a sentence, not a status name echoed back.
  it('gives a written reason for every refusal', () => {
    for (const status of ONBOARDING_STATUSES.filter((s) => s !== 'submitted')) {
      for (const action of ACTIONS) {
        const reason = decideReview(status, action).reason;
        expect(reason.length).toBeGreaterThan(30);
        expect(reason.trim().endsWith('.')).toBe(true);
      }
    }
  });

  // THE ONE AN OPERATOR ACTUALLY HITS. A candidate who was sent back is mid-edit; deciding on them
  // now lands a decision on a form that is about to change under it.
  it('refuses a decision while the ball is with the candidate, and says so', () => {
    const d = decideReview('changes_requested', 'approve');
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('sent back');
  });

  it('will not re-decide something already decided', () => {
    expect(decideReview('approved', 'approve').allowed).toBe(false);
    expect(decideReview('approved', 'reject').allowed).toBe(false);
    expect(decideReview('rejected', 'approve').allowed).toBe(false);
  });

  it('will not approve a draft nobody has submitted', () => {
    const d = decideReview('in_progress', 'approve');
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('not been submitted');
  });

  // Fails CLOSED on anything it has never heard of — a status that arrived from a future migration,
  // a cast, or a hand-made POST. The alternative is a decision recorded against a state whose rules
  // nobody has written.
  it('refuses an unknown status rather than assuming it is decidable', () => {
    for (const junk of ['', 'APPROVED', 'in-progress', 'wonderful', 'null']) {
      expect(decideReview(junk, 'approve').allowed).toBe(false);
    }
  });

  // The verb in the sentence follows the act, so "cannot be refused" never appears on the button
  // that sends somebody back for changes.
  it('names the act it is refusing', () => {
    expect(decideReview('approved', 'reject').reason).toContain('refused');
    expect(decideReview('approved', 'request_changes').reason).toContain('sent back for changes');
  });
});

describe('a rejection needs a reason somebody can be told', () => {
  it('refuses an empty one', () => {
    expect(rejectionProblem('')).not.toBeNull();
    expect(rejectionProblem('   ')).not.toBeNull();
  });

  it('refuses the two words this field collects when nothing stops it', () => {
    expect(rejectionProblem('no')).not.toBeNull();
    expect(rejectionProblem('not suitable')).not.toBeNull();
  });

  it('accepts a reason with something in it', () => {
    expect(rejectionProblem('The bank details belong to a different named person.')).toBeNull();
  });

  // Whitespace is not content. Padding a two-word refusal out to the floor with spaces would defeat
  // the only thing the floor is for.
  it('counts characters, not spaces', () => {
    const padded = 'no' + ' '.repeat(MIN_REJECTION_REASON * 2);
    expect(rejectionProblem(padded)).not.toBeNull();
    expect(rejectionProblem('n o t   s u i t a b l e')).not.toBeNull();
  });

  // A real short reason must pass on the first try. A floor that makes an honest operator pad their
  // sentence teaches them to pad every sentence.
  it('lets a genuine short reason through', () => {
    expect(rejectionProblem('Bank details name a different person')).toBeNull();
  });
});

describe('submissionGaps composes the existing rules rather than restating them', () => {
  it('reports nothing missing for a complete employee submission with a document', () => {
    const gaps = submissionGaps('employee', completeEmployeeForm(), allDeclarations(), 1);
    expect(gaps.clean).toBe(true);
    expect(gaps.total).toBe(0);
  });

  // THE POINT OF THE COMPOSITION. If these two ever disagree, the reviewer and the candidate are
  // being told different things about the same form.
  it('reports exactly what formProblems() and missingDeclarations() report', () => {
    const form = completeEmployeeForm();
    delete (form as any).panNumber;
    const decls = allDeclarations();
    delete (decls as any).conduct;

    const gaps = submissionGaps('employee', form, decls, 1);
    expect(gaps.fields).toEqual(formProblems('employee', form));
    expect(gaps.declarations).toEqual(missingDeclarations(decls));
    expect(gaps.total).toBe(gaps.fields.length + gaps.declarations.length);
    expect(gaps.clean).toBe(false);

    // AND IT SAYS WHAT IS MISSING, not merely the same thing as its two sources. Comparing a
    // function to the functions it calls can pass while both go wrong together, so the two gaps
    // planted above are also named here, in the words a reviewer reads.
    expect(gaps.fields).toHaveLength(1);
    expect(gaps.fields[0]).toContain('PAN');
    expect(gaps.declarations).toHaveLength(1);
    expect(gaps.declarations[0]).toContain('code of conduct');
  });

  it('counts no linked document as a gap, because it is a reason not to approve', () => {
    const gaps = submissionGaps('employee', completeEmployeeForm(), allDeclarations(), 0);
    expect(gaps.documents).toHaveLength(1);
    expect(gaps.clean).toBe(false);
  });

  // An intern is not asked for a PAN or bank details, so a complete intern form must not be reported
  // as incomplete against an employee's field list.
  it('asks an intern for an intern\'s fields', () => {
    const internForm = {
      ...completeEmployeeForm(),
      currentInstitution: 'Some University',
      courseAndYear: 'BSc, third year',
    };
    delete (internForm as any).panNumber;
    delete (internForm as any).bankHolder;
    delete (internForm as any).bankAccountNumber;
    delete (internForm as any).bankIfsc;
    expect(submissionGaps('intern', internForm, allDeclarations(), 2).clean).toBe(true);
    expect(submissionGaps('employee', internForm, allDeclarations(), 2).clean).toBe(false);
  });

  it('survives a form and declarations that are missing entirely', () => {
    const gaps = submissionGaps('employee', {} as any, {} as any, 0);
    expect(gaps.total).toBeGreaterThan(0);
    expect(gaps.declarations.length).toBe(DECLARATIONS.filter((d) => d.required).length);
  });
});

describe('reviewSections says which answers came from the person and which from us', () => {
  const sections = () => reviewSections('employee', completeEmployeeForm());

  it('marks exactly the org-controlled section as org-controlled', () => {
    const owned = sections().filter((s) => s.orgControlled).map((s) => s.key);
    const expected = ONBOARDING_SECTIONS.filter((s) => s.orgControlled).map((s) => s.key);
    expect(owned).toEqual(expected);
    expect(owned).toContain('organizational');
  });

  // The reviewer must never be shown a candidate-typed department. The org section carries no
  // candidate fields at all; it renders from the selection snapshot.
  it('puts no candidate answer inside the org-controlled section', () => {
    for (const s of sections()) {
      if (s.orgControlled) expect(s.answers).toHaveLength(0);
    }
  });

  it('groups every candidate answer under the section its field belongs to', () => {
    const personal = sections().find((s) => s.key === 'personal');
    expect(personal).toBeTruthy();
    expect(personal!.answers.map((a) => a.key)).toContain('fullName');
    expect(personal!.answers.map((a) => a.key)).not.toContain('panNumber');
  });

  it('flags a required answer that is blank, and does not flag an optional one', () => {
    const form = completeEmployeeForm();
    delete (form as any).city;
    const personal = reviewSections('employee', form).find((s) => s.key === 'personal')!;
    const city = personal.answers.find((a) => a.key === 'city')!;
    const preferred = personal.answers.find((a) => a.key === 'preferredName')!;
    expect(city.missing).toBe(true);
    expect(preferred.value).toBe('');
    expect(preferred.missing).toBe(false);
  });

  it('renders a value as text without inventing one', () => {
    const personal = sections().find((s) => s.key === 'personal')!;
    expect(personal.answers.find((a) => a.key === 'fullName')!.value).toBe('A Candidate');
    expect(reviewSections('employee', {}).find((s) => s.key === 'personal')!
      .answers.find((a) => a.key === 'fullName')!.value).toBe('');
  });
});

describe('declarationViews shows every declaration that was asked for', () => {
  it('lists all of them, in the order the form asked', () => {
    const views = declarationViews(allDeclarations());
    expect(views.map((v) => v.key)).toEqual(DECLARATIONS.map((d) => d.key));
    expect(views.every((v) => v.accepted)).toBe(true);
  });

  // A declaration added after somebody submitted must read as NOT ACCEPTED. Driving the list from
  // the stored object instead would make it disappear from the review entirely, which is the same
  // as pretending it was accepted.
  it('reads an absent declaration as not accepted rather than omitting it', () => {
    const views = declarationViews({});
    expect(views).toHaveLength(DECLARATIONS.length);
    expect(views.every((v) => !v.accepted)).toBe(true);
  });

  it('accepts only a literal true, never a truthy string', () => {
    const views = declarationViews({ accuracy: 'yes', verification: 1, conduct: true } as any);
    expect(views.find((v) => v.key === 'accuracy')!.accepted).toBe(false);
    expect(views.find((v) => v.key === 'verification')!.accepted).toBe(false);
    expect(views.find((v) => v.key === 'conduct')!.accepted).toBe(true);
  });
});

describe('documentSummary is what a reviewer without the sensitive key is told', () => {
  it('says plainly that there are none', () => {
    expect(documentSummary(0, 0)).toContain('No document link');
  });

  it('counts them without naming them', () => {
    const line = documentSummary(3, 1);
    expect(line).toContain('3 document links');
    expect(line).toContain('one of which is flagged identity-class');
    // The whole point of the gate: the count may be shown, the KIND may not.
    expect(line.toLowerCase()).not.toContain('passport');
    expect(line.toLowerCase()).not.toContain('http');
  });

  it('reads as English for one, and for none flagged', () => {
    expect(documentSummary(1, 0)).toContain('One document link');
    expect(documentSummary(2, 0)).toContain('None of them is flagged');
    expect(documentSummary(4, 2)).toContain('2 of which are flagged');
  });

  it('treats nonsense counts as zero rather than printing them', () => {
    expect(documentSummary(-3, -1)).toContain('No document link');
    expect(documentSummary(Number.NaN, Number.NaN)).toContain('No document link');
  });
});

describe('labels tell the truth about what this platform actually did', () => {
  // Spec 33.1: this system holds a REFERENCE, not the file. Nothing here may say EduRankAI verified
  // a document it has only received a link to.
  it('never claims the platform verified a document', () => {
    for (const key of Object.keys({ submitted: 1, verified: 1, rejected: 1, replaced: 1, expired: 1 })) {
      const label = documentStatusLabel(key).toLowerCase();
      expect(label).not.toContain('verified by');
      expect(label).not.toContain('authenticated');
    }
    expect(documentStatusLabel('verified')).toBe('Checked by a reviewer');
    expect(documentStatusLabel('submitted')).toBe('Received, not yet checked');
  });

  it('falls back to the raw value rather than to a blank cell', () => {
    expect(documentStatusLabel('something_new')).toBe('something_new');
    expect(onboardingStatusLabel('something_new')).toBe('something_new');
  });

  it('uses the owned onboarding labels', () => {
    expect(onboardingStatusLabel('submitted')).toBe('Submitted for review');
    expect(onboardingStatusLabel('rejected')).toBe('Not approved');
  });
});

describe('the queue filters', () => {
  it('accept only their own keys', () => {
    for (const f of REVIEW_FILTERS) expect(isReviewFilter(f.key)).toBe(true);
    for (const junk of ['', 'SUBMITTED', 'drop table', null, 7]) expect(isReviewFilter(junk)).toBe(false);
  });

  // needs_identity lists the records where the decision and the identity registry disagree, in
  // BOTH directions: the half-done approval this module can leave behind, and the older
  // approved-with-no-identity state it cannot mend. A state nobody can list is a state nobody
  // repairs, so the tab has to exist.
  it('include the queue where the decision and the identity disagree', () => {
    expect(REVIEW_FILTERS.map((f) => f.key)).toContain('needs_identity');
  });

  it('offer a tab for every status a reviewer acts on', () => {
    const keys = REVIEW_FILTERS.map((f) => String(f.key));
    for (const s of ['submitted', 'changes_requested', 'in_progress', 'approved', 'rejected']) {
      expect(keys).toContain(s);
    }
  });
});

describe('an onboarding reference is a reference', () => {
  it('accepts a UUID and nothing else', () => {
    expect(isApplicationRef('7f1c8b02-3a4d-4e5f-9012-3456789abcde')).toBe(true);
    expect(isApplicationRef('7F1C8B02-3A4D-4E5F-9012-3456789ABCDE')).toBe(true);
    for (const junk of ['', '   ', 'abc', '7f1c8b02-3a4d-4e5f-9012', null, undefined, 7,
                        "7f1c8b02-3a4d-4e5f-9012-3456789abcde'; DROP TABLE"]) {
      expect(isApplicationRef(junk)).toBe(false);
    }
  });

  // A malformed reference is a MISSING record, not a database that failed. Without the guard it
  // reaches Postgres as `'abc'::uuid`, comes back as error 22P02, and this desk prints it under the
  // wording reserved for a read that did not answer — teaching an operator to distrust both.
  it('is trimmed before it is judged', () => {
    expect(isApplicationRef('  7f1c8b02-3a4d-4e5f-9012-3456789abcde  ')).toBe(true);
  });
});

describe('the two decisions refuse before they reach a database', () => {
  // These calls are deliberately made with NO database available. Each one must come back as a
  // refusal, which proves the validation happens before ctx() — if any of them reached the
  // connection this test would hang or throw instead of returning ok:false.
  const GOOD_REF = '7f1c8b02-3a4d-4e5f-9012-3456789abcde';
  const GOOD_REASON = 'Bank details name a different person';

  it('will not approve without an onboarding and an actor', async () => {
    expect((await approveOnboarding('', GOOD_REF)).ok).toBe(false);
    expect((await approveOnboarding(GOOD_REF, '')).ok).toBe(false);
    expect((await approveOnboarding('not-a-reference', GOOD_REF)).ok).toBe(false);
    expect((await approveOnboarding(GOOD_REF, 'not-a-user')).ok).toBe(false);
  });

  // An approval carries somebody's name because it admits a person. A refusal here has to SAY that
  // nothing was changed, or an operator retries an act that may already have half happened.
  it('says nothing was changed when it refuses an approval', async () => {
    const r = await approveOnboarding('not-a-reference', GOOD_REF);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/nothing has been approved/i);
    expect(r.identityId).toBeUndefined();
    expect(r.needsRepair).toBeUndefined();
  });

  it('will not record a rejection with an unusable reason, whatever the ids are', async () => {
    expect((await rejectOnboarding(GOOD_REF, GOOD_REF, '')).ok).toBe(false);
    expect((await rejectOnboarding(GOOD_REF, GOOD_REF, 'not suitable')).ok).toBe(false);
    const r = await rejectOnboarding('not-a-reference', GOOD_REF, GOOD_REASON);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/nothing has been changed/i);
  });
});

// -----------------------------------------------------------------------------------------------
// THE RULE THIS WHOLE MODULE WAS WRITTEN FOR, ASSERTED RATHER THAN ONLY DOCUMENTED.
//
// An empty array from a read on a review desk says "this person supplied nothing" — which is a
// reason to refuse somebody. It must never be what a read that FAILED, or a reference that was
// never a reference, comes back as. These calls are made with no database available and still
// reach a verdict, so they prove the refusal happens before the connection rather than instead of
// one.
// -----------------------------------------------------------------------------------------------
describe('a read never answers a failure with an empty list', () => {
  it('refuses a bad reference in reviewDocuments by THROWING, never by returning []', async () => {
    // [] out of this function has one meaning and it is a fact about a candidate. If a malformed
    // reference could produce it, a reviewer could be shown "no documents" for somebody who linked
    // five, and refuse them on it.
    await expect(reviewDocuments('not-a-reference')).rejects.toThrow(/not an onboarding reference/i);
    await expect(reviewDocuments('')).rejects.toThrow();
    await expect(reviewDocuments(null as any)).rejects.toThrow();
  });

  // The other half of the same rule, in the other direction: a reference that is not a reference is
  // a record that does NOT EXIST, and must not arrive at the page wearing the wording reserved for a
  // database that did not answer. null here, a throw there, and the page prints two different
  // sentences for the two different facts.
  it('answers a bad reference in reviewDetail with null, without reaching a database', async () => {
    await expect(reviewDetail('not-a-reference')).resolves.toBeNull();
    await expect(reviewDetail('')).resolves.toBeNull();
    await expect(reviewDetail('7f1c8b02-3a4d-4e5f-9012')).resolves.toBeNull();
  });
});

describe('the identity registry is asked about before the button is drawn', () => {
  // The answer depends on whether src/lib/talent/identity.ts is part of the deployment, so this does
  // not assert WHICH answer — it asserts that asking is safe: no database, no throw, and a real
  // boolean. A screen that crashed here would take the whole review desk down over a question it
  // only asked to decide whether to render one button.
  it('resolves a boolean and never throws, whether or not the registry is present', async () => {
    const available = await identityRegistryAvailable();
    expect(typeof available).toBe('boolean');
  });

  // THE RULE, WHICHEVER WAY THE ANSWER FALLS. A refusal that cannot say why is the shape that sent
  // an operator to write a module that already existed: "not part of this deployment" was printed
  // over a registry that was present and throwing. So unavailable MUST carry a sentence, and
  // available must not invent one.
  it('carries a written reason exactly when it cannot create an identity', async () => {
    const status = await identityRegistryStatus();
    expect(typeof status.available).toBe('boolean');
    expect(status.available).toBe(await identityRegistryAvailable());
    if (status.available) {
      expect(status.problem).toBe('');
    } else {
      expect(status.problem.length).toBeGreaterThan(30);
      expect(status.problem).toContain('identity.ts');
      expect(status.problem.trim().endsWith('.')).toBe(true);
    }
  });
});

describe('the half-done approval, and which half of it this desk can mend', () => {
  // THE ORDERING RULE THIS MODULE IS BUILT ON. approveOnboarding() creates the identity FIRST and
  // only then moves the status, so the state a failure can leave behind is: an identity exists, and
  // the application is STILL 'submitted'. The screen tells operators to press Approve again on those
  // — so decideReview() must actually allow it, or the instruction is a lie.
  it('allows the repair the screen tells an operator to make', () => {
    expect(decideReview('submitted', 'approve').allowed).toBe(true);
  });

  // The opposite state — marked approved with no identity — is NOT reachable from this module and is
  // NOT repairable here. If this ever starts returning true, the banner that says so must change
  // with it; the two must never drift apart.
  it('refuses to re-approve a record that is already marked approved', () => {
    const d = decideReview('approved', 'approve');
    expect(d.allowed).toBe(false);
    expect(d.reason.length).toBeGreaterThan(30);
  });
});
