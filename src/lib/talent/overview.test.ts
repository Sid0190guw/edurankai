// src/lib/talent/overview.test.ts — the console front page's rules, exercised with no database.
//
// THE IMPORT ITSELF IS THE FIRST ASSERTION, exactly as stages.test.ts says of its own. overview.ts
// resolves its database handle lazily, so importing offeredCards() must not require DATABASE_URL.
// If that regresses — a query issued at module scope, or a connection opened on import — this file
// fails at COLLECTION rather than on an assertion, which is the signal wanted.
//
// AND THE REASON IT HOLDS IS NOT THE ONE THIS COMMENT USED TO GIVE. It said overview.ts's two
// static imports "both resolve their own handle lazily". events.ts does. schema.ts does NOT — it
// carries a module-scope `import { db } from '@/lib/db'` (src/lib/talent/schema.ts:27), so
// importing overview.ts does load the connection module. What makes that harmless is one level
// further down: src/lib/db CONNECTS ON FIRST USE, not on import, and throws "DATABASE_URL is not
// set" from connect() rather than at module scope. Writing the reason down wrongly is how the next
// person "fixes" the wrong file when this eventually breaks.
import { describe, it, expect, vi } from 'vitest';
import {
  OVERVIEW_CARDS, offeredCards, overviewScope, eventBacklogNote,
  type TalentOverview,
} from '@/lib/talent/overview';
import { PERMS_BY_ROLE, DEPARTMENT_SCOPED_ROLES, type Permission } from '@/lib/auth/permissions';

// A viewer, expressed the way the page expresses one: what they hold, and which sections the
// middleware would let them past. `null` sections is what getViewableSectionKeys() returns for an
// unrestricted role and means "no section filtering", never "no sections".
type RoleKey = keyof typeof PERMS_BY_ROLE;
const holderOf = (role: RoleKey) => (p: Permission) =>
  (PERMS_BY_ROLE[role] as Permission[]).includes(p);

const holdsNothing = () => false;

// The four section keys src/middleware.ts maps the /admin/talent subtrees to. Copied here as an
// EXPECTATION rather than imported: if a card ever names a fifth, this test is where it is caught,
// because a section key middleware does not know silently gates nothing at all.
const TALENT_SECTIONS = ['talent', 'talent_onboarding', 'talent_identity', 'talent_access'];

// src/middleware.ts PATH_SECTION for the talent subtree, plus its resolver, reproduced exactly —
// the array sorted longest-prefix-first and matched on "equal, or prefix followed by a slash".
//
// WHY REPRODUCED AND NOT IMPORTED. middleware.ts does not export either of them, and importing the
// middleware pulls the whole request pipeline into a unit test. Reproducing it is what makes this
// an ASSERTION rather than a restatement: the rule under test is "a card's `section` must be the
// section the middleware will actually apply to that card's href", and checking a card against a
// membership list cannot see the difference between `talent` and `talent_onboarding` on
// /admin/talent/codes — which is the one mistake that turns every onboarding card into a bounce.
const MIDDLEWARE_PATH_SECTION: [string, string][] = ([
  ['/admin/talent/access', 'talent_access'],
  ['/admin/talent/identity', 'talent_identity'],
  ['/admin/talent/onboarding', 'talent_onboarding'],
  ['/admin/talent/codes', 'talent_onboarding'],
  ['/admin/talent/selected', 'talent_onboarding'],
  ['/admin/talent', 'talent'],
] as [string, string][]).sort((a, b) => b[0].length - a[0].length);

const middlewareSectionFor = (path: string): string | null => {
  for (const [prefix, key] of MIDDLEWARE_PATH_SECTION) {
    if (path === prefix || path.startsWith(prefix + '/')) return key;
  }
  return null;
};

/** Every capability any built-in role can actually hold. A card gated on anything else is dead. */
const GRANTABLE = new Set<string>(
  Object.values(PERMS_BY_ROLE).flatMap((list) => list as string[]),
);

// Section sets as ROLE_SECTIONS grants them for the three roles that matter to these rules.
const HR_SECTIONS = new Set(['dashboard', 'talent', 'talent_onboarding', 'talent_identity']);
const RECRUITER_SECTIONS = new Set(['dashboard', 'talent']);

const ZERO_COUNTS: TalentOverview = {
  opportunitiesPublished: 0, opportunitiesDraft: 0, opportunitiesClosed: 0,
  applicationsOpen: 0, people: 0,
  selectedActive: 0, selectedAwaitingApproval: 0,
  codesActive: 0, onboardingSubmitted: 0, identitiesActive: 0,
  accessRequestsPending: 0, provisioningProposed: 0,
  eventsPending: 0, eventsAbandoned: 0,
};

const idsOf = (cards: { id: string }[]) => cards.map((c) => c.id);

describe('the card set is internally consistent', () => {
  it('has one card per talent desk, uniquely identified and uniquely addressed', () => {
    expect(OVERVIEW_CARDS).toHaveLength(9);
    expect(new Set(OVERVIEW_CARDS.map((c) => c.id)).size).toBe(9);
    expect(new Set(OVERVIEW_CARDS.map((c) => c.href)).size).toBe(9);
  });

  it('points every card inside the talent console and nowhere else', () => {
    for (const c of OVERVIEW_CARDS) expect(c.href.startsWith('/admin/talent')).toBe(true);
  });

  it('names only section keys the middleware actually gates on', () => {
    for (const c of OVERVIEW_CARDS) expect(TALENT_SECTIONS).toContain(c.section);
  });

  it('gives every card THE section middleware will apply to its own href', () => {
    // The rule, not the list. A card carrying `talent` for /admin/talent/codes passes the
    // membership check above and still hands recruiter a link that middleware bounces, because
    // the section the request is actually judged against is `talent_onboarding`.
    for (const c of OVERVIEW_CARDS) {
      expect([c.href, c.section]).toEqual([c.href, middlewareSectionFor(c.href)]);
    }
  });

  it('gives every card at least one capability that admits, so none is offered to everyone', () => {
    for (const c of OVERVIEW_CARDS) expect(c.capabilities.length).toBeGreaterThan(0);
  });

  it('gates no card on a capability no role can hold', () => {
    // A mistyped permission is not a loud failure anywhere: can() simply returns false for every
    // viewer, the card is filtered out for everyone, and the console renders one desk short with
    // no error. That is the silent-empty class again, one layer above a query.
    for (const c of OVERVIEW_CARDS) {
      for (const p of c.capabilities) expect([c.id, p, GRANTABLE.has(p)]).toEqual([c.id, p, true]);
    }
  });

  it('is reachable in full by super_admin, so no desk is defined and then orphaned', () => {
    // Every card must be openable by at least one role. A card whose capability and whose section
    // are each real but are held by DIFFERENT roles is offered to nobody at all.
    for (const c of OVERVIEW_CARDS) {
      const superHolds = c.capabilities.some((p) => holderOf('super_admin')(p));
      expect([c.id, superHolds]).toEqual([c.id, true]);
    }
  });

  it('asks only for numbers talentOverview() actually returns', () => {
    // A mistyped countKey renders as an empty tile rather than an error, which is exactly the class
    // of defect that reads as "none" on screen. Checked against a real, zeroed result shape.
    for (const c of OVERVIEW_CARDS) {
      if (c.countKey) expect(Object.keys(ZERO_COUNTS)).toContain(c.countKey);
      if (c.subCountKey) expect(Object.keys(ZERO_COUNTS)).toContain(c.subCountKey);
    }
  });

  it('labels every number it shows, and shows no label without a number', () => {
    for (const c of OVERVIEW_CARDS) {
      expect(Boolean(c.countKey)).toBe(c.countLabel.length > 0);
      expect(Boolean(c.subCountKey)).toBe(c.subCountLabel.length > 0);
      // A card cannot carry a second number without a first.
      if (c.subCountKey) expect(c.countKey).toBeTruthy();
    }
  });

  it('builds no tile on a source that does not exist — spec 43 rule 1', () => {
    // Recruitment sources and the pipeline are configuration registers, not queues. Neither has a
    // volume worth a headline number, so neither carries one; a placeholder zero on either would
    // read as a fault rather than as "nothing to count here".
    const numberless = OVERVIEW_CARDS.filter((c) => !c.countKey).map((c) => c.id);
    expect(numberless).toEqual(['sources', 'pipeline']);
  });
});

describe('a card is offered only when BOTH doors open', () => {
  it('offers a super admin every desk (unrestricted sections)', () => {
    expect(idsOf(offeredCards(holderOf('super_admin'), null))).toEqual(idsOf([...OVERVIEW_CARDS]));
  });

  it('offers hr everything except access management, which is a separate desk', () => {
    const got = idsOf(offeredCards(holderOf('hr'), HR_SECTIONS));
    expect(got).not.toContain('access');
    expect(got).toContain('identity');
    expect(got).toContain('onboarding');
    expect(got).toHaveLength(8);
  });

  it('does NOT offer a recruiter the onboarding desks, though talent.view would admit them', () => {
    // THE DEFECT THIS RULE EXISTS FOR. `talent.view` is on the Selected-candidates and
    // Onboarding-codes cards, and recruiter holds it — but ROLE_SECTIONS does not give recruiter
    // the `talent_onboarding` section, so middleware redirects to /admin?denied=talent_onboarding
    // before either page's own gate runs. A card offered on the capability alone is a link that
    // bounces the person who clicks it.
    expect(holderOf('recruiter')('talent.view')).toBe(true);
    const got = idsOf(offeredCards(holderOf('recruiter'), RECRUITER_SECTIONS));
    expect(got).toEqual(['opportunities', 'candidates', 'sources', 'pipeline']);
  });

  it('offers a reviewer the same four, and nothing that writes', () => {
    const got = idsOf(offeredCards(holderOf('reviewer'), new Set(['dashboard', 'talent'])));
    expect(got).toEqual(['opportunities', 'candidates', 'sources', 'pipeline']);
  });

  it('offers a department head the four desks its own section grant reaches', () => {
    // ROLE_SECTIONS gives department_head `talent` and nothing narrower, and PERMS_BY_ROLE gives it
    // `talent.view` and no onboarding, identity or access key. Both doors agree here, and the test
    // exists so a later widening of either one has to be stated on purpose.
    const got = idsOf(offeredCards(holderOf('department_head'), new Set(['dashboard', 'talent'])));
    expect(got).toEqual(['opportunities', 'candidates', 'sources', 'pipeline']);
  });

  it('offers nothing to a viewer holding no talent capability, even with every section', () => {
    const everySection = new Set(TALENT_SECTIONS);
    expect(offeredCards(holdsNothing, everySection)).toEqual([]);
  });

  it('offers nothing when the sections are empty, even to a super admin capability set', () => {
    // An administrator whose custom roles grant no page key must get an empty set, not the defaults.
    expect(offeredCards(holderOf('super_admin'), new Set<string>())).toEqual([]);
  });

  it('treats null sections as no filtering rather than as no sections', () => {
    // The two are one keystroke apart and opposite: null means "unrestricted role, do not filter",
    // an empty set means "this administrator was granted no page key at all". Reading null as empty
    // would hide every card from the founder's own account.
    expect(offeredCards(holderOf('super_admin'), null)).toHaveLength(9);
    expect(offeredCards(holderOf('super_admin'), new Set<string>())).toHaveLength(0);
  });
});

describe('scope decides whether a number may be computed at all — spec 43 rule 4', () => {
  it('treats the platform as the scope for exactly the two unscoped desks', () => {
    expect(overviewScope('super_admin').mayReadTotals).toBe(true);
    expect(overviewScope('hr').mayReadTotals).toBe(true);
    expect(overviewScope('super_admin').kind).toBe('platform');
  });

  it('never hands a platform-wide total to a department-scoped role', () => {
    // The list comes from permissions.ts, so a role added to it later fails here until this page
    // has an answer for it — which is the point.
    for (const role of DEPARTMENT_SCOPED_ROLES) {
      const s = overviewScope(role);
      expect(s.mayReadTotals).toBe(false);
      expect(s.kind).toBe('scoped');
    }
  });

  it('fails closed on a role nobody wrote a line for', () => {
    const s = overviewScope('some_future_role');
    expect(s.mayReadTotals).toBe(false);
    expect(s.kind).toBe('none');
  });

  it('fails closed on a missing role rather than defaulting to the widest answer', () => {
    for (const r of [null, undefined, '', '   ']) {
      expect(overviewScope(r as any).mayReadTotals).toBe(false);
    }
  });

  it('always says what the scope is, whatever it decided', () => {
    for (const role of ['super_admin', 'hr', 'recruiter', 'reviewer', 'department_head', 'nobody']) {
      expect(overviewScope(role).note.trim().length).toBeGreaterThan(20);
    }
  });

  it('tells a viewer refused a total that the numbers are absent, not that they are zero', () => {
    // THE RULE, and it is the whole reason this refusal is safe to ship. A page that simply omits
    // the numbers for a scoped role is indistinguishable, to the person reading it, from a page
    // reporting that there is nothing waiting anywhere. The refusal only works if it SAYS it is a
    // refusal, so every note on the deny side has to carry the words.
    for (const role of [...DEPARTMENT_SCOPED_ROLES, 'some_future_role', '']) {
      const s = overviewScope(role as string);
      expect([role, s.mayReadTotals]).toEqual([role, false]);
      expect([role, s.note.includes('not shown here')]).toEqual([role, true]);
    }
  });

  it('never marks a scope readable without also saying the numbers were read', () => {
    // The other half: a viewer who IS shown totals must be told what they are totals OF, so a
    // department head who is later promoted does not carry over "these are my numbers".
    for (const role of ['super_admin', 'hr']) {
      const s = overviewScope(role);
      expect(s.mayReadTotals).toBe(true);
      expect(s.note).toContain('platform-wide');
      expect(s.note).not.toContain('not shown here');
    }
  });
});

describe('the event backlog reads as what it means, not as a number', () => {
  it('says nothing at all when nothing is waiting', () => {
    expect(eventBacklogNote(0, 0)).toBeNull();
  });

  it('is singular for one and plural for more', () => {
    expect(eventBacklogNote(1, 0)).toContain('One talent event is still waiting');
    expect(eventBacklogNote(4, 0)).toContain('4 talent events are still waiting');
    expect(eventBacklogNote(0, 1)).toContain('One talent event has used every delivery attempt');
    expect(eventBacklogNote(0, 3)).toContain('3 talent events have used every delivery attempt');
  });

  it('says a pending event is delayed, not lost', () => {
    const note = String(eventBacklogNote(2, 0));
    expect(note).toContain('Nothing has been lost');
    expect(note).not.toContain('out of step');
  });

  it('says an abandoned event means two systems disagree', () => {
    const note = String(eventBacklogNote(0, 2));
    expect(note).toContain('out of step');
    expect(note).toContain('never told');
    // AND NEVER THE REASSURANCE. "Nothing has been lost" is true of an event that still has
    // attempts left and false of one that has used them all: the delivery was given up on, and the
    // only thing that can repair it now is somebody replaying it by hand. The two sentences are one
    // conditional apart, and putting the wrong one on an abandoned event tells an operator to stop
    // looking at exactly the case that needs them.
    expect(note).not.toContain('Nothing has been lost');
  });

  it('keeps the reassurance off a mixed backlog that contains an abandoned event', () => {
    // The dangerous middle case: some waiting, one given up on. The abandoned one decides the
    // sentence, because it is the one nothing will retry.
    const note = String(eventBacklogNote(9, 1));
    expect(note).not.toContain('Nothing has been lost');
    expect(note).toContain('out of step');
  });

  it('leads with the abandoned ones and still mentions the waiting ones', () => {
    const note = String(eventBacklogNote(5, 1));
    expect(note.startsWith('One talent event has used every delivery attempt')).toBe(true);
    expect(note).toContain('5 more are still waiting');
  });

  it('treats a non-number as nothing rather than printing NaN', () => {
    expect(eventBacklogNote(NaN as any, NaN as any)).toBeNull();
    expect(eventBacklogNote(undefined as any, undefined as any)).toBeNull();
  });

  it('is fed by the read that RETHROWS, not by the helper that answers zero on failure', () => {
    // THE RULE: silence on this banner must mean "the outbox is empty", never "the outbox could not
    // be read". undeliveredEventCount() (src/lib/talent/events.ts) catches its own failure and
    // returns { pending: 0, abandoned: 0 }, so a page fed from it prints the reassuring sentence
    // for an unreadable outbox — and what is being under-reported is that a downstream system was
    // never told somebody was hired.
    //
    // What a database-free test CAN pin is where the numbers come from: they are fields of
    // TalentOverview, which is produced by talentOverview(), which rethrows. Moving the banner back
    // onto the swallowing helper means dropping these two, and this fails.
    expect(Object.keys(ZERO_COUNTS)).toContain('eventsPending');
    expect(Object.keys(ZERO_COUNTS)).toContain('eventsAbandoned');
    // And the note is genuinely a function of those two numbers, so a zeroed read is silent while
    // any positive one speaks.
    expect(eventBacklogNote(ZERO_COUNTS.eventsPending, ZERO_COUNTS.eventsAbandoned)).toBeNull();
    expect(eventBacklogNote(0, 1)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// THE IMPURE HALF. Everything above this line runs on pure functions; the four cases below are the
// only ones that need a database, and they get a fake one rather than a connection.
//
// WHY THEY ARE HERE AT ALL. The rule this whole surface exists to keep is that a failed read must
// never arrive at the page as a number. Until now that rule was pinned only by the SHAPE of
// TalentOverview — the two event fields exist, therefore the banner is fed from the rethrowing
// function — which is an argument, not an assertion: swapping `throw e` for `return ZERO` in the
// catch block leaves every one of those tests green and turns the console into a page that reports
// an empty onboarding queue on the day the database is unreachable.
//
// The mocks are set up per-test with doMock + resetModules rather than at module scope, so the
// top-of-file import above stays a real import of the real module and goes on being the
// collection-time assertion it is described as.
// ---------------------------------------------------------------------------------------------

/** One distinct number per alias, so a transposed pair cannot pass. Strings, as COUNT(*) arrives. */
const FAKE_ROW = {
  opp_published: '11', opp_draft: '12', opp_closed: '13',
  applications_open: '14', people: '15',
  selected_active: '16', selected_awaiting_approval: '17',
  codes_active: '18', onboarding_submitted: '19', identities_active: '20',
  access_pending: '21', provisioning_proposed: '22',
  events_pending: '23', events_abandoned: '24',
};

async function loadOverviewWith(execute: (q: unknown) => Promise<unknown>) {
  vi.resetModules();
  // ensureTalentSchema() is stubbed to nothing so a failure below can only have come from the
  // SELECT. Mocking it also keeps this suite from importing the module that owns the DDL.
  vi.doMock('./schema', () => ({ ensureTalentSchema: async () => {} }));
  vi.doMock('@/lib/db', () => ({ db: { execute } }));
  return import('./overview');
}

function unloadOverview() {
  vi.doUnmock('./schema');
  vi.doUnmock('@/lib/db');
  vi.resetModules();
}

describe('talentOverview() reports what it read, or fails — never a zero it did not measure', () => {
  it('RETHROWS a failed read instead of answering zeros', async () => {
    // THE ASSERTION THIS FILE WAS MISSING, and the one defect class this repository keeps paying
    // for: a caught error returning a zeroed TalentOverview renders as "0 submitted for review",
    // "0 requests awaiting a first decision", "0 events waiting" — a console that says the queues
    // are empty at the exact moment nobody can see them. The page can only distinguish the two if
    // this function refuses to.
    const boom: any = new Error('select count(*) from tal_opportunity ...');
    boom.cause = { message: 'relation "tal_opportunity" does not exist' };
    const mod = await loadOverviewWith(async () => { throw boom; });
    try {
      // Deliberately not `.rejects.toThrow()` alone: that passes for ANY rejection, including a
      // re-wrapped one. It must be the SAME error object, because /admin/talent reads the real
      // Postgres reason off e.cause — a fresh Error() here leaves the page printing "unknown
      // error" beside every tile, which tells the operator nothing they can act on.
      const outcome = await mod.talentOverview().then(
        () => ({ resolved: true, error: null as any }),
        (e: any) => ({ resolved: false, error: e }),
      );
      expect(outcome.resolved).toBe(false);
      expect(outcome.error).toBe(boom);
      expect(outcome.error?.cause?.message).toContain('does not exist');
    } finally {
      unloadOverview();
    }
  });

  it('answers every field from its own column, with nothing transposed', async () => {
    // A count read into the wrong field is invisible: every tile still shows a plausible number
    // under a confident label, and the first person to notice is whoever acts on it. Distinct
    // values per alias are what make a swap fail here rather than in front of an operator.
    const mod = await loadOverviewWith(async () => [FAKE_ROW]);
    try {
      expect(await mod.talentOverview()).toEqual({
        opportunitiesPublished: 11, opportunitiesDraft: 12, opportunitiesClosed: 13,
        applicationsOpen: 14, people: 15,
        selectedActive: 16, selectedAwaitingApproval: 17,
        codesActive: 18, onboardingSubmitted: 19, identitiesActive: 20,
        accessRequestsPending: 21, provisioningProposed: 22,
        eventsPending: 23, eventsAbandoned: 24,
      });
    } finally {
      unloadOverview();
    }
  });

  it('reads a plain array back from the driver and costs exactly one round trip', async () => {
    // TWO HOUSE RULES IN ONE CASE. postgres-js hands back a plain ARRAY, not { rows: [...] }, so
    // the fake returns an array and rowsOf() has to cope — `r.rows[0]` here would read undefined
    // and every number would come out zero, which is the silent-empty failure again by another
    // route. And the whole point of the twelve-subquery statement is that it is ONE statement: a
    // later edit that splits a tile back out into its own query is a connection this page's budget
    // does not have.
    let calls = 0;
    const mod = await loadOverviewWith(async () => { calls += 1; return [FAKE_ROW]; });
    try {
      const got = await mod.talentOverview();
      expect(calls).toBe(1);
      expect(got.people).toBe(15);
      // Numbers, not the strings the driver returned — the page formats with toLocaleString().
      expect(typeof got.people).toBe('number');
    } finally {
      unloadOverview();
    }
  });

  it('reads a genuine zero as zero rather than dropping it', async () => {
    // The mirror of the rethrow rule. A real, measured emptiness must survive: `Number(x || 0)`
    // over the string '0' has to stay 0, and an absent column has to stay 0 too, so an empty
    // console and an unreadable one differ by whether this resolved at all.
    const zeros: Record<string, string> = {};
    for (const k of Object.keys(FAKE_ROW)) zeros[k] = '0';
    const mod = await loadOverviewWith(async () => [zeros]);
    try {
      const got = await mod.talentOverview();
      expect(got.onboardingSubmitted).toBe(0);
      expect(got.eventsAbandoned).toBe(0);
      // And a zeroed read is silent on the banner, which is only correct BECAUSE it resolved.
      expect(eventBacklogNote(got.eventsPending, got.eventsAbandoned)).toBeNull();
    } finally {
      unloadOverview();
    }
  });
});
