// src/lib/career-intel/retrieve.ts — FETCHING A CANDIDATE POOL, IN SQL, WITHOUT READING THE WHOLE
// CATALOGUE.
//
// =================================================================================================
// THE PROBLEM THIS FILE IS THE ANSWER TO
// =================================================================================================
//
// /careers used to select up to five thousand roles and render every one of them into the initial
// HTML. The page worked; it was simply enormous, it grew with the catalogue, and the number it
// printed at the top was measured off the array it had managed to fetch rather than counted in SQL —
// so when the catalogue passed the cap, the page said the cap WAS the catalogue.
//
// The rule this module enforces instead:
//
//   THE DATABASE DECIDES WHICH ROWS. THE PAGE RENDERS A PAGE. THE COUNT IS COUNTED IN SQL.
//
// Nothing here fetches "everything and then filters". Every filter a person expresses — a discipline,
// a search term, a department, a career rung — becomes a predicate in the WHERE clause, and the
// total is a COUNT over that same predicate. If 1,017 postings match, the count says 1,017 and the
// pages walk all 1,017. If none match, the count says 0 and it means it.
//
// =================================================================================================
// ONE QUERY PER SCREEN, NOT ONE PER SIGNAL
// =================================================================================================
//
// A profile can name four disciplines and six terms. The obvious implementation runs a query per
// discipline and merges — ten round trips to build one page. This project has measured what round
// trips cost from the serverless region the site runs in, and the note in src/lib/db/index.ts is
// blunt about it: the round-trip COUNT is the lever, not the distance. So the profile is compiled
// into ONE set of filters (`skillCategoriesAny`, `terms`) and one call to listOpportunities, which
// itself costs a rows query and a count query and nothing else.
//
// RANKING HAPPENS ON THE PAGE THAT WAS FETCHED, NEVER ON THE CATALOGUE. The pool is deliberately a
// little wider than the page shown, so ordering has something to order, and it is bounded — a
// ranker that has to score a thousand rows to display twelve has moved the original problem into a
// serverless function where it is harder to see.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { listOpportunities, type OpportunityFilters, type OpportunityPage, type OpportunityRow } from '@/lib/xscale/roles-ext';
import { profileReadiness, type CareerProfile } from './dimensions';

// compileQuery LIVES IN ./query.ts, not here, and is re-exported so callers keep one import.
// It is pure, and this module is not: importing the database module runs dotenv.config() at module
// scope, which would make the one function that decides what a person is shown untestable without
// reading the environment file. See the header of ./query.ts.
export { compileQuery, type CompiledQuery } from './query';
import { compileQuery } from './query';
import type { CompiledQuery } from './query';

const rowsOf = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const reasonOf = (e: any): string => e?.cause?.message || e?.message || String(e);

/* --------------------------------------------------------------------------------- the fetch */

export interface PoolResult extends OpportunityPage {
  compiled: CompiledQuery;
  /**
   * How many postings are open in total, ignoring every filter. Reported BESIDE `total` so the
   * page can say "18 of 1,017" instead of letting one number stand in for the other — which is the
   * exact confusion that made the old page report its own fetch cap as the size of the catalogue.
   */
  catalogueTotal: number;
  /**
   * True when a personalised query matched nothing and the catalogue was read instead. The surface
   * MUST say so: a fallback presented as a result is a search that lies about what matched.
   */
  widened: boolean;
}

/** How many rows to fetch so ranking has something to order. Bounded on purpose. */
const POOL = 48;

/**
 * The candidate pool for a person, ranked by the caller.
 *
 * A PERSONALISED QUERY THAT MATCHES NOTHING IS WIDENED, LOUDLY. Returning an empty page to somebody
 * who has just told us about themselves is the worst outcome available: it reads as "there is
 * nothing here for you" when the truth is "our reading of you was too narrow". So it retries
 * without the profile's predicates and sets `widened`, which the surface renders as a sentence.
 */
export async function retrieveForProfile(
  profile: CareerProfile,
  opts: { limit?: number; offset?: number; explicit?: Partial<OpportunityFilters> } = {},
): Promise<PoolResult> {
  const limit = Math.max(1, Math.min(POOL, Math.floor(opts.limit ?? 24)));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const compiled = compileQuery(profile, opts.explicit || {});

  let page = await listOpportunities({ ...compiled.filters, limit, offset });
  let widened = false;

  if (page.readable && page.total === 0 && !compiled.unpersonalised) {
    const wide = await listOpportunities({ ...(opts.explicit || {}), limit, offset });
    if (wide.readable && wide.total > 0) { page = wide; widened = true; }
  }

  const catalogueTotal = await openPostingCount();

  return { ...page, compiled, catalogueTotal, widened };
}

/* --------------------------------------------------------------------------- the honest count */

/**
 * HOW MANY POSTINGS ARE OPEN. One number, counted in SQL, never measured off an array.
 *
 * Two statements, tried in order, because this database may or may not have had the extended
 * columns applied — db/xscale-schema.sql is run by hand and a repository .sql file is not an
 * applied one. The narrow form uses only columns that have existed since the first migration.
 *
 * Returns -1, NOT 0, when neither works. Zero is a real answer that means "there are no openings"
 * and a failed count must never be able to say that on a careers page.
 */
export async function openPostingCount(): Promise<number> {
  try {
    const r = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM roles
       WHERE is_open = TRUE
         AND COALESCE(job_status, 'PUBLISHED') = 'PUBLISHED'
         AND (application_deadline IS NULL OR application_deadline > NOW())`);
    return Number(rowsOf(r)[0]?.n ?? -1);
  } catch (e: any) {
    console.error('[career-intel/retrieve] open count failed:', reasonOf(e));
    try {
      const r = await db.execute(sql`
        SELECT COUNT(*)::int AS n FROM roles
         WHERE is_open = TRUE
           AND (application_deadline IS NULL OR application_deadline > NOW())`);
      return Number(rowsOf(r)[0]?.n ?? -1);
    } catch (e2: any) {
      console.error('[career-intel/retrieve] narrowed open count failed:', reasonOf(e2));
      return -1;
    }
  }
}

/* -------------------------------------------------------------------------------- tagging coverage */

export interface TaggingCoverage {
  open: number;
  classified: number;
  disciplined: number;
  runged: number;
  /** False means the read failed — NOT that nothing is tagged. */
  readable: boolean;
}

/**
 * HOW MUCH OF THE CATALOGUE THE RANKER CAN ACTUALLY USE.
 *
 * The approach signal — matching how somebody said they like to think against what kind of work a
 * posting is — can only fire on a posting whose research_classification is recorded. That column is
 * populated by the import at /admin/roles/divisions and by nothing else, so on a catalogue where
 * the import has not run it is NULL everywhere and the strongest evidence the ranker has is
 * permanently unavailable.
 *
 * This used to be reported to CANDIDATES, once per card, as "this posting has no research
 * classification recorded". True, unactionable by them, and on most cards it read as a fault. It
 * belongs here instead, where the person reading it can run the import.
 *
 * ONE QUERY, THREE COUNTS. FILTER is an aggregate filter, not a second scan.
 */
export async function taggingCoverage(): Promise<TaggingCoverage> {
  const empty: TaggingCoverage = { open: 0, classified: 0, disciplined: 0, runged: 0, readable: false };
  try {
    const r = await db.execute(sql`
      SELECT COUNT(*)::int AS open,
             COUNT(*) FILTER (WHERE research_classification IS NOT NULL)::int AS classified,
             COUNT(*) FILTER (WHERE COALESCE(array_length(skill_categories, 1), 0) > 0)::int AS disciplined,
             COUNT(*) FILTER (WHERE career_level IS NOT NULL)::int AS runged
        FROM roles
       WHERE is_open = TRUE`);
    const row = rowsOf(r)[0];
    if (!row) return empty;
    return {
      open: Number(row.open) || 0,
      classified: Number(row.classified) || 0,
      disciplined: Number(row.disciplined) || 0,
      runged: Number(row.runged) || 0,
      readable: true,
    };
  } catch (e: any) {
    // The additive columns may not exist at all, which is itself the answer: nothing is tagged.
    // readable:false so the surface says "could not read" rather than "nothing is tagged".
    console.error('[career-intel/retrieve] taggingCoverage failed:', reasonOf(e));
    return empty;
  }
}

/* ------------------------------------------------------------------------------ the discovery */

export interface DiscoveryTeam {
  id: string;
  name: string;
  openCount: number;
}

export interface Discovery {
  total: number;
  teams: DiscoveryTeam[];
  /** False means the read failed — NOT that the catalogue is empty. */
  readable: boolean;
}

/**
 * The team cards on the landing page: a name and a count, and nothing else.
 *
 * ONE GROUPED QUERY FOR THE WHOLE STRIP. The alternative — a COUNT per department — is one round
 * trip per card, which is how a "lightweight" landing page ends up slower than the heavy list it
 * replaced. The total is the sum of the group, so the strip and the headline cannot disagree.
 */
export async function discoverTeams(): Promise<Discovery> {
  const attempt = async (published: boolean): Promise<DiscoveryTeam[]> => {
    const statusClause = published
      ? sql`AND COALESCE(r.job_status, 'PUBLISHED') = 'PUBLISHED'`
      : sql``;
    const r = await db.execute(sql`
      SELECT d.id, d.name, COUNT(r.id)::int AS n
        FROM departments d
        JOIN roles r ON r.department_id = d.id
       WHERE r.is_open = TRUE
         ${statusClause}
         AND (r.application_deadline IS NULL OR r.application_deadline > NOW())
       GROUP BY d.id, d.name, d.sort_order
       HAVING COUNT(r.id) > 0
       ORDER BY COUNT(r.id) DESC, d.sort_order ASC`);
    return rowsOf(r).map((x) => ({ id: String(x.id), name: String(x.name), openCount: Number(x.n) || 0 }));
  };

  try {
    const teams = await attempt(true);
    return { total: teams.reduce((n, t) => n + t.openCount, 0), teams, readable: true };
  } catch (e: any) {
    console.error('[career-intel/retrieve] discoverTeams failed:', reasonOf(e));
    try {
      const teams = await attempt(false);
      return { total: teams.reduce((n, t) => n + t.openCount, 0), teams, readable: true };
    } catch (e2: any) {
      console.error('[career-intel/retrieve] narrowed discoverTeams failed:', reasonOf(e2));
      // readable:false, NOT an empty list presented as the answer. An empty state must keep
      // meaning "there are none".
      return { total: 0, teams: [], readable: false };
    }
  }
}

/**
 * The handful of postings shown on the landing page before anybody has said anything.
 *
 * A HANDFUL, AND FEATURED ONES. Not "the first N of everything", which is the same list-dump in a
 * smaller box and teaches nobody anything about the catalogue.
 */
export async function featuredPostings(limit = 6): Promise<{ rows: OpportunityRow[]; readable: boolean }> {
  const page = await listOpportunities({ limit: Math.max(1, Math.min(12, limit)) });
  return { rows: page.rows, readable: page.readable };
}

/**
 * Whether it is worth offering to sharpen the results.
 *
 * Shown as an OFFER and never as a gate. The page below it works either way, which is the whole of
 * the resume rule in section 10: a CV is context, not a turnstile.
 */
export function personalisationHeadroom(profile: CareerProfile): number {
  return 1 - profileReadiness(profile);
}
