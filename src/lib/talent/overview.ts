// src/lib/talent/overview.ts — WHAT THE TALENT CONSOLE FRONT PAGE IS ALLOWED TO SAY.
//
// Spec: docs/talent-to-org/TALENT_TO_ORG_MASTER_SPEC.md sections 8, 14, 14A and 43.
//
// TWO HALVES, AND THE SPLIT IS DELIBERATE.
//
//   The PURE half — OVERVIEW_CARDS, offeredCards(), overviewScope(), eventBacklogNote() — decides
//   which desks a viewer is offered, whether they may be shown a number at all, and how a delivery
//   backlog reads in English. It opens no connection, so every one of those rules has a test.
//
//   The IMPURE half — talentOverview() — is ONE statement. Not one per tile.
//
// WHY ONE STATEMENT AND NOT ONE PER TILE. A round trip to this database measures ~135ms from bom1
// when the connection is warm and ~950ms when the instance has to open one (src/lib/db/index.ts,
// fourth measurement). Twelve tiles at one query each is between one and a half and eleven seconds
// of a page that shows nothing but headline numbers, and it is the exact shape this project has
// already paid for — page latency becoming a function of how many tiles a header happened to have.
// Twelve scalar subqueries in one SELECT is one round trip and one connection.
//
// WHY IT DOES NOT CALL selectionCounts() AND codeCounts(), WHICH OWN TWO OF THESE NUMBERS. They are
// the right functions and they are what /admin/talent/selected and /admin/talent/codes use; each is
// its own round trip, and reaching for both here would make the hub three connections instead of
// one on an instance whose handshake alone costs 810ms. The SQL for "selected and not withdrawn"
// and "codes still active" is one predicate each and is written below with a pointer back to the
// owning module, so a change there is greppable to here. It is a deliberate, narrow duplication for
// the sake of the round-trip budget, and it is worth knowing about rather than discovering.
//
// WHY THE OUTBOX BACKLOG IS COUNTED HERE AND NOT BY undeliveredEventCount(), WHICH OWNS IT.
// undeliveredEventCount() (src/lib/talent/events.ts:666) CATCHES ITS OWN FAILURE AND RETURNS
// { pending: 0, abandoned: 0 }. A hub calling it therefore cannot tell "the outbox is empty" from
// "the outbox could not be read", and it would print the reassuring one — the exact defect class
// this console exists to avoid, and the worst possible place for it, because the thing being
// under-reported is "a downstream system was never told that somebody was hired". The threshold is
// IMPORTED from events.ts rather than retyped, so the two cannot drift; only the predicate is
// repeated, in the same deliberate, greppable way as the two above. Counting it in this statement
// costs no round trip at all and it rethrows with everything else.
//
// NOTHING HERE DECIDES ANYTHING. The hub has no POST handler, writes nothing, and audits nothing,
// because there is no state change on it to audit.
import { ensureTalentSchema } from './schema';
import { rowsOf, reasonOf, CANDIDATE_TERMINAL } from './types';
// The delivery-attempt ceiling, from the module that owns the outbox. A value, not a connection:
// events.ts resolves its database handle lazily, so this import stays free of DATABASE_URL.
import { MAX_DELIVERY_ATTEMPTS } from './events';
import type { Permission } from '@/lib/auth/permissions';

// ---------------------------------------------------------------------------------------------
// Declared before anything that uses them. `const` is not hoisted, and a handler reaching a later
// declaration has taken pages down on this project.
// ---------------------------------------------------------------------------------------------

/** Lazy, exactly as selection.ts and codes.ts do it, so the pure half stays testable. */
async function ctx() {
  await ensureTalentSchema();
  const { db } = await import('@/lib/db');
  const { sql } = await import('drizzle-orm');
  return { db, sql };
}

// ---------------------------------------------------------------------------------------------
// SCOPE — spec 43 rule 4: "A dashboard that shows a global number to a scoped administrator has
// leaked an aggregate."
//
// THIS IS THE RULE THAT DECIDES WHETHER A NUMBER MAY BE COMPUTED AT ALL, and it runs before the
// query, not after it — spec 43 rule 5, "no tile queries above the authorization boundary".
//
// Five built-in roles reach this console. `super_admin` and `hr` run the platform end to end and a
// platform-wide count IS their number. The other three are scoped, and permissions.ts says exactly
// how in the comment beside each grant:
//
//   recruiter        the hiring desk, department-scoped
//   department_head  "department-scoped in the query", from the Organization Graph
//   reviewer         "WHICH candidates an evaluator sees is decided per row by their assignment
//                     (tal_opportunity_evaluator), never by this key"
//
// SO THE THREE ARE SHOWN NO NUMBERS, AND ARE TOLD WHY. Not a zero, not a global total quietly
// relabelled. Every desk behind these cards applies its own scope in SQL, so the links are correct
// for them; only the aggregate on the front page is not, and the front page says so in one sentence
// rather than inventing a total that is nobody's.
//
// WHY NOT SCOPE THE COUNTS INSTEAD, which would be the better answer. It needs a department per
// viewer, and the canonical source for department_head is userHeadedDepartmentIds() in
// src/lib/org-graph.ts — two more round trips, returning [] both when a person heads nothing and
// when the graph is not populated, which are opposite facts. users.assigned_department_id is free
// and is what DEPARTMENT_SCOPED_ROLES exists to carry, but it is an approximation of the graph for
// two roles and simply wrong for the third, whose scope is an assignment table and not a
// department at all. Scoped counts are the right follow-up; a wrong scope silently applied is not
// an improvement over an honest refusal.
// ---------------------------------------------------------------------------------------------

export type OverviewScopeKind = 'platform' | 'scoped' | 'none';

export interface OverviewScope {
  kind: OverviewScopeKind;
  /** True only when a platform-wide aggregate is this viewer's own number. */
  mayReadTotals: boolean;
  /** One sentence, always rendered, so the scope of every number on the page is explicit. */
  note: string;
}

/** The two roles for whom the whole platform IS the scope. Everything else is narrower. */
const PLATFORM_ROLES: readonly string[] = ['super_admin', 'hr'];

const SCOPED_NOTE: Record<string, string> = {
  recruiter:
    'Counts are not shown here. Your view of every desk below is scoped to your own hiring in SQL, '
    + 'so a platform-wide total would not be your number.',
  department_head:
    'Counts are not shown here. Your view of every desk below is scoped to the department you head, '
    + 'so a platform-wide total would not be your number.',
  reviewer:
    'Counts are not shown here. What you see on each desk below is decided per candidate by your '
    + 'evaluator assignments, so no single total on this page would describe it.',
};

export function overviewScope(role: string | null | undefined): OverviewScope {
  const r = String(role || '').trim();
  if (PLATFORM_ROLES.includes(r)) {
    return {
      kind: 'platform',
      mayReadTotals: true,
      note: 'Every number on this page is a platform-wide total, read live when the page loaded.',
    };
  }
  const scopedNote = SCOPED_NOTE[r];
  if (scopedNote) return { kind: 'scoped', mayReadTotals: false, note: scopedNote };
  // Deny by default. A role nobody wrote a line for gets the links its capabilities allow and no
  // aggregate at all, which is the fail-closed direction.
  return {
    kind: 'none',
    mayReadTotals: false,
    note: 'Counts are not shown here, because there is no recorded scope for your role that a total '
      + 'on this page would be correct for.',
  };
}

// ---------------------------------------------------------------------------------------------
// THE CARD SET — spec section 8's admin information architecture, as it is actually routed in this
// repository, and spec 14: "A section the administrator cannot access is ABSENT from navigation".
//
// TWO DOORS STAND IN FRONT OF EVERY ONE OF THESE, and a card is offered only when the viewer passes
// BOTH — that is the whole reason `section` is on this record:
//
//   1. the capability, checked with can() on the page;
//   2. the middleware section key for the path (src/middleware.ts PATH_SECTION), which redirects to
//      /admin?denied=<section> before the page's own frontmatter ever runs.
//
// THEY DO NOT AGREE, AND THAT IS NOT A BUG IN EITHER OF THEM. `talent.view` is held by recruiter,
// reviewer and department_head; the `talent_onboarding` section is not. So a recruiter who was
// offered "Onboarding codes" on the strength of talent.view alone would click a card and be bounced
// by middleware to /admin?denied=talent_onboarding — a hub whose links do not work for the people
// it was built for. Checking the section here is what stops that, and it costs nothing: the page
// gets the section set from getViewableSectionKeys(), which is memoised on the request's own user
// object and was already computed by the middleware for this very request.
// ---------------------------------------------------------------------------------------------

export interface OverviewCard {
  id: string;
  title: string;
  href: string;
  /** The middleware section key guarding this path. */
  section: string;
  /** ANY ONE of these admits. */
  capabilities: readonly Permission[];
  blurb: string;
  /** Which number this card shows, or null when it has no honest source — spec 43 rule 1. */
  countKey: keyof TalentOverview | null;
  countLabel: string;
  /** A quieter second number, when one genuinely helps. */
  subCountKey: keyof TalentOverview | null;
  subCountLabel: string;
}

export const OVERVIEW_CARDS: readonly OverviewCard[] = [
  {
    id: 'opportunities',
    title: 'Opportunities',
    href: '/admin/talent/opportunities',
    section: 'talent',
    capabilities: ['talent.view'],
    blurb: 'Every role, internship and fellowship the platform is recruiting for, and the pipeline '
      + 'each one runs.',
    countKey: 'opportunitiesPublished',
    countLabel: 'published now',
    subCountKey: 'opportunitiesDraft',
    subCountLabel: 'still in draft',
  },
  {
    id: 'candidates',
    title: 'Candidates',
    href: '/admin/talent/candidates',
    section: 'talent',
    capabilities: ['talent.view'],
    blurb: 'One record per person, however many times they have applied. Merged duplicates are not '
      + 'counted twice.',
    countKey: 'people',
    countLabel: 'people on record',
    subCountKey: 'applicationsOpen',
    subCountLabel: 'applications still open',
  },
  {
    id: 'sources',
    title: 'Recruitment sources',
    href: '/admin/talent/sources',
    section: 'talent',
    capabilities: ['talent.view'],
    // NO NUMBER, ON PURPOSE — spec 43 rule 1. This is the registry of the systems applications
    // arrive THROUGH (provenance), and a count of registered sources answers no question anybody
    // opens this page with. A tile with nothing real behind it is not built.
    blurb: 'The registry of systems applications arrive through, and the keys that let them in. '
      + 'Provenance, not "how did you hear about us".',
    countKey: null,
    countLabel: '',
    subCountKey: null,
    subCountLabel: '',
  },
  {
    id: 'pipeline',
    title: 'Evaluation pipeline',
    href: '/admin/talent/pipeline',
    section: 'talent',
    capabilities: ['talent.view'],
    // Configuration, not a queue. There is no volume here to count.
    blurb: 'The stages every application is worked through, which carry a pass mark, and what a '
      + 'candidate is shown while they sit on each one.',
    countKey: null,
    countLabel: '',
    subCountKey: null,
    subCountLabel: '',
  },
  {
    id: 'selected',
    title: 'Selected candidates',
    href: '/admin/talent/selected',
    section: 'talent_onboarding',
    capabilities: ['selection.approve_onboarding', 'onboarding.code.issue', 'talent.view'],
    blurb: 'The queue between "we said yes" and "they are in the system". Approving somebody for '
      + 'onboarding and issuing their code are two separate acts.',
    countKey: 'selectedActive',
    countLabel: 'selected, not withdrawn',
    subCountKey: 'selectedAwaitingApproval',
    subCountLabel: 'waiting on approval for onboarding',
  },
  {
    id: 'codes',
    title: 'Onboarding codes',
    href: '/admin/talent/codes',
    section: 'talent_onboarding',
    capabilities: ['onboarding.code.issue', 'talent.view'],
    blurb: 'Every authorization code issued and what state it is in. The code itself cannot be read '
      + 'back here or anywhere; only a hash of it is stored.',
    countKey: 'codesActive',
    countLabel: 'codes still live',
    subCountKey: null,
    subCountLabel: '',
  },
  {
    id: 'onboarding',
    title: 'Onboarding review',
    href: '/admin/talent/onboarding',
    section: 'talent_onboarding',
    capabilities: ['onboarding.approve'],
    blurb: 'Submitted onboarding forms waiting on a human to read them, ask for changes, or approve '
      + 'and issue an identity.',
    countKey: 'onboardingSubmitted',
    countLabel: 'submitted for review',
    subCountKey: null,
    subCountLabel: '',
  },
  {
    id: 'identity',
    title: 'Identity registry',
    href: '/admin/talent/identity',
    section: 'talent_identity',
    capabilities: ['identity.manage'],
    blurb: 'Everyone who holds an identity issued by this platform, of every type, and what state '
      + 'that identity is in.',
    countKey: 'identitiesActive',
    countLabel: 'active identities',
    subCountKey: null,
    subCountLabel: '',
  },
  {
    id: 'access',
    title: 'Access management',
    href: '/admin/talent/access',
    section: 'talent_access',
    capabilities: ['access.manage'],
    blurb: 'Access groups, the policies that derive them, and the requests and provisioning runs '
      + 'waiting on a decision.',
    countKey: 'accessRequestsPending',
    countLabel: 'requests awaiting a first decision',
    subCountKey: 'provisioningProposed',
    subCountLabel: 'provisioning runs proposed',
  },
];

/**
 * The cards this viewer may actually open. BOTH doors, in the order they are met in a real request:
 * the section gate (middleware, first) and the capability (the page, second).
 *
 * `sections === null` is what getViewableSectionKeys() returns for an unrestricted role. It means
 * "no section filtering", not "no sections" — reading it as an empty set would hide every card from
 * a super admin.
 */
export function offeredCards(
  holds: (p: Permission) => boolean,
  sections: ReadonlySet<string> | null,
): OverviewCard[] {
  return OVERVIEW_CARDS.filter((c) => {
    if (sections !== null && !sections.has(c.section)) return false;
    return c.capabilities.some((p) => holds(p));
  });
}

// ---------------------------------------------------------------------------------------------
// THE EVENT BACKLOG, IN ENGLISH.
//
// An ABANDONED talent event is not a queue statistic. tal_event is the outbox written in the same
// transaction as the domain row precisely so nothing is lost, and an event that has used every
// delivery attempt means a downstream system was never told that something happened here — a
// selection, a code, an identity. The two systems now disagree about the world and neither of them
// knows it. That sentence is what belongs on a hub, not a red number.
// ---------------------------------------------------------------------------------------------

export function eventBacklogNote(pending: number, abandoned: number): string | null {
  const p = Number(pending) || 0;
  const a = Number(abandoned) || 0;
  if (p <= 0 && a <= 0) return null;

  if (a > 0) {
    const head = a === 1
      ? 'One talent event has used every delivery attempt and been abandoned.'
      : a + ' talent events have used every delivery attempt and been abandoned.';
    const tail = p > 0
      ? ' ' + (p === 1 ? 'One more is still waiting.' : p + ' more are still waiting.')
      : '';
    return head + ' That means a downstream system was never told about something that happened '
      + 'here — a selection, a code, an identity — and the two are out of step until somebody '
      + 'replays them.' + tail;
  }

  return (p === 1
    ? 'One talent event is still waiting to be delivered.'
    : p + ' talent events are still waiting to be delivered.')
    + ' Nothing has been lost; until they drain, a downstream system has not yet been told.';
}

// ---------------------------------------------------------------------------------------------
// THE NUMBERS.
// ---------------------------------------------------------------------------------------------

export interface TalentOverview {
  opportunitiesPublished: number;
  opportunitiesDraft: number;
  opportunitiesClosed: number;
  applicationsOpen: number;
  people: number;
  selectedActive: number;
  selectedAwaitingApproval: number;
  codesActive: number;
  onboardingSubmitted: number;
  identitiesActive: number;
  accessRequestsPending: number;
  provisioningProposed: number;
  /** Outbox rows still undelivered with attempts left. See the header for why they are counted here. */
  eventsPending: number;
  /** Outbox rows that have used every attempt. Two systems now disagree about what happened. */
  eventsAbandoned: number;
}

/**
 * Every headline number the console front page shows, in ONE round trip.
 *
 * IT RETHROWS. A caught error returning zeros would render as "there is nothing waiting anywhere",
 * which is the most dangerous wrong answer a hub can give: an empty onboarding queue and an
 * unreadable one look identical and mean opposite things. The page catches this and prints the
 * reason beside cards that still work as links.
 */
export async function talentOverview(): Promise<TalentOverview> {
  try {
    const { db, sql } = await ctx();

    // The three statuses nothing moves out of, from the owned contract rather than retyped here.
    // Bound one parameter per value with sql.join — NEVER `= ANY(${jsArray})`, which this driver
    // renders as a record literal and Postgres rejects (src/lib/pg-array.ts).
    const terminal = sql.join(CANDIDATE_TERMINAL.map((s) => sql`${String(s)}`), sql`, `);

    const rows = rowsOf(await db.execute(sql`
      SELECT
        (SELECT COUNT(*) FROM tal_opportunity WHERE status = 'published')  AS opp_published,
        (SELECT COUNT(*) FROM tal_opportunity WHERE status = 'draft')      AS opp_draft,
        (SELECT COUNT(*) FROM tal_opportunity WHERE status = 'closed')     AS opp_closed,

        -- OPEN means neither closed nor in one of the three terminal candidate statuses. A count of
        -- every application ever filed is a different, much less useful number.
        (SELECT COUNT(*) FROM tal_application
          WHERE closed_at IS NULL AND status NOT IN (${terminal}))         AS applications_open,

        -- One human, counted once. A merged duplicate is the same person and must not inflate this.
        (SELECT COUNT(*) FROM tal_person WHERE merged_into_id IS NULL)     AS people,

        -- The same predicate selectionCounts() owns in src/lib/talent/selection.ts; see the header.
        (SELECT COUNT(*) FROM tal_selection_decision
          WHERE decision = 'selected' AND withdrawn_at IS NULL)            AS selected_active,
        (SELECT COUNT(*) FROM tal_selection_decision
          WHERE decision = 'selected' AND withdrawn_at IS NULL
            AND approved_for_onboarding_at IS NULL)                        AS selected_awaiting_approval,

        -- LIVE, NOT "MARKED ACTIVE", AND THE DIFFERENCE IS NOT COSMETIC. The status column is
        -- stored, and a code past valid_until keeps reading 'active' until expireStaleCodes()
        -- sweeps it — which runs when somebody OPENS /admin/talent/codes and never from this page.
        -- So a bare status = 'active' here counts codes that redeemCode() already refuses
        -- (src/lib/talent/codes.ts:608 requires valid_until > NOW()), under a card that says
        -- "codes still live", and reports a bigger number than the register the card links to.
        -- This is the same predicate codeCounts() calls "active" MINUS the ones it calls "overdue".
        (SELECT COUNT(*) FROM tal_onboarding_code
          WHERE status = 'active' AND valid_until > NOW())                  AS codes_active,

        (SELECT COUNT(*) FROM tal_onboarding_application
          WHERE status = 'submitted')                                      AS onboarding_submitted,

        (SELECT COUNT(*) FROM tal_identity WHERE status = 'active')        AS identities_active,

        -- 'pending' only: a request that has reached manager, department or security review is in
        -- flight and is somebody else's queue. The card says "awaiting a first decision" for that
        -- reason rather than calling this the number of open requests.
        (SELECT COUNT(*) FROM tal_access_request WHERE status = 'pending') AS access_pending,

        (SELECT COUNT(*) FROM tal_provisioning_run WHERE status = 'proposed') AS provisioning_proposed,

        -- THE OUTBOX, counted here rather than through undeliveredEventCount(), which swallows its
        -- own failure and answers zero. Same predicate as src/lib/talent/events.ts:671, same
        -- imported ceiling, and it rides along in this statement for nothing.
        (SELECT COUNT(*) FROM tal_event
          WHERE delivered_at IS NULL AND attempts <  ${MAX_DELIVERY_ATTEMPTS}) AS events_pending,
        (SELECT COUNT(*) FROM tal_event
          WHERE delivered_at IS NULL AND attempts >= ${MAX_DELIVERY_ATTEMPTS}) AS events_abandoned`));

    const r = (rows[0] || {}) as any;
    return {
      opportunitiesPublished: Number(r.opp_published || 0),
      opportunitiesDraft: Number(r.opp_draft || 0),
      opportunitiesClosed: Number(r.opp_closed || 0),
      applicationsOpen: Number(r.applications_open || 0),
      people: Number(r.people || 0),
      selectedActive: Number(r.selected_active || 0),
      selectedAwaitingApproval: Number(r.selected_awaiting_approval || 0),
      codesActive: Number(r.codes_active || 0),
      onboardingSubmitted: Number(r.onboarding_submitted || 0),
      identitiesActive: Number(r.identities_active || 0),
      accessRequestsPending: Number(r.access_pending || 0),
      provisioningProposed: Number(r.provisioning_proposed || 0),
      eventsPending: Number(r.events_pending || 0),
      eventsAbandoned: Number(r.events_abandoned || 0),
    };
  } catch (e: any) {
    // The real Postgres reason is on e.cause; e.message is only the failed statement.
    console.error('[talent-overview] talentOverview: ' + reasonOf(e));
    throw e;
  }
}
