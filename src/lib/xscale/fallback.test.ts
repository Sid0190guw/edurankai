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
// THIS IS NOT HYPOTHETICAL. On 2026-08-24 the retry carried `r.career_level`, one of the sixteen.
// Production has never run that migration, so:
//
//   - the main query failed on the missing `divisions` table, as designed;
//   - the retry failed on the missing `career_level` column, which was not designed;
//   - listOpportunities returned readable:false to every caller;
//   - /careers showed no featured postings, /api/careers/search answered
//     {readable:false, total:0} for every query, and the personalised endpoint returned nothing.
//
// The catalogue had 1,017 open postings throughout. One column reference in a fallback made every
// one of them unreachable through the code that exists to reach them when things go wrong.
//
// The list below is the `roles` table as declared in src/lib/db/schema.ts. Anything outside it is
// created by a hand-run .sql file and may legitimately be absent.

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
 * The retry, isolated from the file.
 *
 * Bounded by the two markers that surround it rather than by line numbers, so ordinary edits
 * elsewhere in the module do not silently move this test onto the wrong statement.
 */
function narrowedRetrySource(): string {
  const start = SRC.indexOf('const narrowWhere = () => sql`');
  const end = SRC.indexOf('narrowed listing also failed');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
}

/** Strip line comments — the incident above is documented inside this very block. */
function code(s: string): string {
  return s.split('\n').filter((l) => !/^\s*(\/\/|--|\*)/.test(l)).join('\n');
}

describe('the narrowed retry survives a database without the additive columns', () => {
  const retry = code(narrowedRetrySource());

  it('names not one column that a hand-run migration created', () => {
    const found = ADDITIVE_ROLE_COLUMNS.filter((c) => new RegExp('\\br\\.' + c + '\\b').test(retry));
    // Named in the failure message, so the next person sees WHICH column rather than just a count.
    expect(found.join(', ')).toBe('');
  });

  it('does not join a table that a hand-run migration created', () => {
    expect(/JOIN\s+divisions/i.test(retry)).toBe(false);
  });

  it('still reads the columns it needs from the base schema', () => {
    for (const c of ['id', 'slug', 'title', 'is_open']) {
      expect(new RegExp('\\br\\.' + c + '\\b').test(retry), c).toBe(true);
    }
  });

  it('counts in SQL rather than measuring the total off the page it fetched', () => {
    // total = list.length is at most one page, so a degraded database would report "24 openings
    // match" while a thousand did — the exact defect the /careers rebuild exists to remove.
    expect(/COUNT\(\*\)::int AS n/.test(retry)).toBe(true);
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
