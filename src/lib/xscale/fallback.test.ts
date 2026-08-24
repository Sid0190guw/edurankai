// src/lib/xscale/fallback.test.ts — THE NARROWED RETRY MAY ONLY TOUCH THE BASE SCHEMA.
//
// =================================================================================================
// WHY THIS IS A SOURCE SCAN AND NOT A BEHAVIOUR TEST
// =================================================================================================
//
// listOpportunities() has two statements: the real one, which reads the sixteen additive columns
// from db/xscale-schema.sql, and a narrowed retry for databases where that migration has not been
// applied. The retry is the entire reason a careers page still lists jobs on such a database.
//
// It cannot be exercised without a database, and it cannot be exercised at all without a database
// that is MISSING those columns — which is the one shape no test environment here has. So the
// property is checked the only way it can be: by reading the statement and asserting it names
// nothing that might not exist.
//
// THIS IS NOT HYPOTHETICAL. Both defects below were found by calling the live endpoint, not by
// reading the code, and neither showed up as an error anywhere.
//
//   1. The retry carried `r.career_level`, one of the sixteen. Production has never run that
//      migration, so the main query failed on the missing `divisions` table exactly as designed,
//      and then the retry failed too. listOpportunities returned readable:false to every caller:
//      /careers showed no featured postings and /api/careers/search answered
//      {readable:false, total:0} for every query. The catalogue held 1,017 open postings throughout.
//
//   2. With that fixed, the retry searched `title` and `function` and nothing else, so
//      /api/careers/search?q=python answered total:0 — Python is in the skills array of a great
//      many of those postings and in the title of almost none. NARROW MEANS "only columns certain
//      to exist", NOT "as few columns as possible"; `about`, `skills` and `departments.name` are
//      all in src/lib/db/schema.ts and leaving them out bought no safety and cost most of the search.
//
// The list below is the `roles` table as declared in src/lib/db/schema.ts. Anything outside it is
// created by a hand-run .sql file and may legitimately be absent from any database.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'src', 'lib', 'xscale', 'roles-ext.ts'), 'utf8');

/** Columns guaranteed by the Drizzle declaration of `roles`. Every database has these. */
const BASE_ROLE_COLUMNS = [
  'id', 'slug', 'department_id', 'title', 'level', 'function', 'engagement_type', 'location',
  'duration', 'salary', 'about', 'responsibilities', 'skills', 'eligibility', 'is_open',
  'is_featured', 'application_deadline', 'sort_order', 'view_count', 'created_at', 'updated_at',
];

/** Created only by db/xscale-schema.sql, which is run by hand. May be absent anywhere. */
const ADDITIVE_ROLE_COLUMNS = [
  'division_id', 'research_classification', 'scale_min_exp', 'scale_max_exp', 'skill_categories',
  'career_level', 'job_status', 'valid_through', 'preferred_skills', 'tools', 'deliverables',
  'evaluation_criteria', 'reporting_to', 'collaborates_with', 'application_instructions',
  'integrity_note', 'openings',
];

/**
 * A named region of the module, bounded by the markers around it rather than by line numbers, so
 * ordinary edits elsewhere cannot silently move a scan onto the wrong statement.
 */
function region(startMarker: string, endMarker: string): string {
  const a = SRC.indexOf(startMarker);
  expect(a, 'start marker: ' + startMarker).toBeGreaterThan(-1);
  const b = SRC.indexOf(endMarker, a + startMarker.length);
  expect(b, 'end marker: ' + endMarker).toBeGreaterThan(a);
  return code(SRC.slice(a, b));
}

/** Strip comment lines — both incidents are documented inside the very blocks being scanned. */
function code(s: string): string {
  return s.split('\n').filter((l) => !/^\s*(\/\/|--|\*)/.test(l)).join('\n');
}

/** The one-term matcher the retry path uses for both free text and its any-of terms. */
const MATCHER = region('const narrowMatch = (t: string) => {', 'const narrowTerms = ()');

/** The retry's own WHERE, its SELECT, and its COUNT. */
const RETRY = region('const narrowWhere = () => sql`', 'narrowed listing also failed');

describe('the narrowed retry survives a database without the additive columns', () => {
  it('names not one column that a hand-run migration created', () => {
    const found = ADDITIVE_ROLE_COLUMNS.filter((c) => new RegExp('\\br\\.' + c + '\\b').test(RETRY));
    // Named in the failure message, so the next person sees WHICH column rather than just a count.
    expect(found.join(', ')).toBe('');
  });

  it('does not let one in through the matcher either', () => {
    const found = ADDITIVE_ROLE_COLUMNS.filter((c) => new RegExp('\\br\\.' + c + '\\b').test(MATCHER));
    expect(found.join(', ')).toBe('');
  });

  it('does not join a table that a hand-run migration created', () => {
    expect(/JOIN\s+divisions/i.test(RETRY)).toBe(false);
    expect(/JOIN\s+divisions/i.test(MATCHER)).toBe(false);
  });

  it('still reads the columns it needs from the base schema', () => {
    for (const c of ['title', 'is_open', 'department_id']) {
      expect(new RegExp('\\br\\.' + c + '\\b').test(RETRY), c).toBe(true);
    }
  });
});

describe('narrow means "certain to exist", not "as few as possible"', () => {
  it('searches every base-schema column a person would expect it to', () => {
    for (const c of ['r.title', 'r.function', 'r.about', 'r.skills']) {
      expect(MATCHER.includes(c), c).toBe(true);
    }
    expect(MATCHER.includes("COALESCE(d.name, '')")).toBe(true);
  });

  it('guards the skills unpacking, which has killed every search on this project once before', () => {
    // jsonb_array_elements_text throws a hard Postgres error on any row whose skills column is not
    // an array, per row, across the whole table — so one bad row returns "0 results" for every term.
    expect(/jsonb_typeof\(r\.skills\) = 'array'/.test(MATCHER)).toBe(true);
  });

  it('uses the same matcher for free text and for the any-of terms, so the two cannot drift', () => {
    expect(/anyTerms\.map\(narrowMatch\)/.test(SRC)).toBe(true);
    expect(/OR \$\{narrowMatch\(term\)\}/.test(SRC)).toBe(true);
  });
});

describe('the retry reports honestly', () => {
  it('counts in SQL rather than measuring the total off the page it fetched', () => {
    // total = list.length is at most one page, so a degraded database would report "24 openings
    // match" while a thousand did — the exact defect the /careers rebuild exists to remove.
    expect(/COUNT\(\*\)::int AS n/.test(RETRY)).toBe(true);
    expect(/total: list\.length/.test(SRC)).toBe(false);
  });

  it('builds its predicate through a factory, not one shared fragment', () => {
    // Two statements sharing one sql`` fragment under prepare:false is the parameter mis-bind this
    // module already carries a long note about.
    expect(/const narrowWhere = \(\) => sql`/.test(SRC)).toBe(true);
  });

  it('still reports the result as degraded, because the discipline filters did not run', () => {
    expect(/readable: true, degraded: true/.test(SRC)).toBe(true);
  });
});

describe('the database does the coarse relevance ordering', () => {
  const order = region('const relevanceOrder = (', 'const discoveryFragment');

  it('exists at all, because a page ranker cannot rank rows it was never given', () => {
    // Live, 2026-08-24: a profile matching 688 of 1,017 postings got the first 24 in catalogue
    // order, so an AI researcher was shown Category Manager Intern and Chief of Staff, three of
    // them with no explanation because nothing about them matched anything they had said.
    expect(/ORDER BY \$\{relevanceOrder\(wideMatch, true\)\}/.test(SRC)).toBe(true);
    expect(/ORDER BY \$\{relevanceOrder\(narrowMatch, false\)\}/.test(SRC)).toBe(true);
  });

  it('orders by the SAME matcher the WHERE selects with', () => {
    // Two definitions of "matches" would let a posting be selected by one and ordered by the other,
    // which is the quiet way a relevance-ordered page fills with rows nothing can explain.
    expect(/anyTerms\.map\(wideMatch\)/.test(SRC)).toBe(true);
    expect(/matcher\(t\)/.test(order)).toBe(true);
  });

  it('never scores on a discipline column in the retry path', () => {
    // relevanceOrder takes includeCats, and the retry passes false. Scoring on skill_categories
    // there would reintroduce the exact defect the retry exists to survive.
    expect(/includeCats && hasCatsAny/.test(order)).toBe(true);
    expect(/relevanceOrder\(narrowMatch, false\)/.test(SRC)).toBe(true);
  });

  it('emits nothing when there is nothing to order by', () => {
    // An unpersonalised browse keeps the catalogue's own order and pays for no expression.
    expect(/if \(!parts\.length\) return sql``/.test(order)).toBe(true);
  });

  it('weights an explicit tag above a title word above a word in the description', () => {
    expect(/THEN 3 ELSE 0 END/.test(order)).toBe(true);
    expect(/THEN 2 WHEN .* THEN 1 ELSE 0 END/.test(order)).toBe(true);
  });
});

describe('the two widenings are OR-ed with each other, not AND-ed', () => {
  it('guards the empty cases instead of folding them together', () => {
    // `cats OR TRUE` is TRUE, so an unconditional OR would silently discard a discipline filter
    // whenever no terms were supplied.
    const frag = region('const discoveryFragment = () => {', 'const narrowTerms = ()');
    expect(/hasCatsAny && hasTerms/.test(frag)).toBe(true);
    expect(/if \(hasCatsAny\) return catsFragment\(\)/.test(frag)).toBe(true);
    expect(/if \(hasTerms\) return termsFragment\(\)/.test(frag)).toBe(true);
  });
});

describe('the module keeps its own vocabulary honest', () => {
  it('lists every additive column in one place, so this test cannot drift from the writer', () => {
    // setRoleExtension writes them all; if a new one is added there it must be added above too.
    for (const c of ADDITIVE_ROLE_COLUMNS) {
      if (c === 'openings') continue; // written by the role forms, not by setRoleExtension
      expect(SRC.includes(c), c).toBe(true);
    }
  });

  it('does not accidentally treat a base column as additive', () => {
    for (const c of BASE_ROLE_COLUMNS) expect(ADDITIVE_ROLE_COLUMNS).not.toContain(c);
  });
});
