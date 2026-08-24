// What the admin search endpoint must not be able to do to the connection pool.
//
// This endpoint is fired from the AdminLayout search box on a 180ms debounce, so it runs several
// times while somebody types a name. It was fifteen sequential, unbounded, unindexed table scans
// per request, holding one of POOL_MAX=5 connections for over two seconds — which is how typing a
// name in the console ended with the middleware answering "We cannot reach the database right now"
// on the next navigation, from a process-global breaker that the search's own timeouts had opened.
//
// Two of the properties below are structural and are asserted by reading this module's source,
// because they are the kind that a later edit removes without any test noticing: a new `db.execute`
// added straight into a block, or `cosmetic` dropped from the bound. A behaviour test cannot see
// either.
// IT LIVES IN src/lib BECAUSE ANYTHING UNDER src/pages IS A ROUTE.
//
// This file used to sit beside its subject at src/pages/api/admin/search.test.ts, which reads like
// good co-location and is not. Astro routes by file path, so the test WAS an endpoint:
// /api/admin/search.test, built into the server bundle and deployed. Worse, it imports vitest, so
// vitest, @vitest/* and chai were traced into the production serverless function to satisfy an
// import that only a test run should ever make.
//
// The subject is imported through the '@' alias instead of './search' — vitest.config.ts defines it,
// and the readFileSync below already addressed the source by repo-relative path, so it is unchanged.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { likeTerm } from '@/pages/api/admin/search';

const SRC = readFileSync(join(process.cwd(), 'src', 'pages', 'api', 'admin', 'search.ts'), 'utf8');

describe('a typed character never becomes a wildcard', () => {
  it('wraps an ordinary term', () => {
    expect(likeTerm('bhandari')).toBe('%bhandari%');
  });

  it('escapes a per-cent sign, which would otherwise match every row in every table', () => {
    // Fifteen unindexed scans, each returning its maximum, from one keystroke.
    expect(likeTerm('a%b')).toBe('%a\\%b%');
    expect(likeTerm('%')).toBe('%\\%%');
  });

  it('escapes an underscore, which would otherwise match any single character', () => {
    expect(likeTerm('a_b')).toBe('%a\\_b%');
  });

  it('escapes the backslash FIRST, so it cannot maim the escapes added after it', () => {
    // Escaping the backslash last would turn the \% just written for a per-cent sign into a
    // literal backslash followed by a live wildcard - the bug, restored, by the fix.
    expect(likeTerm('a\\b')).toBe('%a\\\\b%');
    expect(likeTerm('\\%')).toBe('%\\\\\\%%');
  });

  it('leaves a term that needs no escaping byte-identical', () => {
    for (const q of ['ravi', 'a-b', "o'neill", 'x.y@z.in', '2026']) {
      expect(likeTerm(q)).toBe('%' + q + '%');
    }
  });
});

describe('no read in this endpoint can hold a connection without a bound', () => {
  it('sends every statement through searchQuery and never straight to db.execute', () => {
    // The one permitted db.execute is the one INSIDE searchQuery, which is the thing doing the
    // bounding. Any other is a block that can hold a pool slot until the server answers.
    const direct = SRC.match(/await db\.execute\(/g) || [];
    expect(direct.length, 'unbounded db.execute calls outside searchQuery').toBe(0);
    const viaHelper = SRC.match(/await searchQuery\(sql`/g) || [];
    expect(viaHelper.length).toBeGreaterThanOrEqual(15);
  });

  it('bounds that one statement, and marks it cosmetic', () => {
    // `cosmetic` is the load-bearing word. Without it a slow search feeds the process-global
    // breaker in src/lib/db-timeout.ts, and three of them in a row make the middleware session
    // gate refuse the next request outright - which is a full-page 503 for a search dropdown.
    expect(SRC).toMatch(/withDbTimeout\(\s*db\.execute\(statement\)\s*,\s*'adminSearch'\s*,\s*SEARCH_QUERY_MS\s*,\s*\{\s*cosmetic:\s*true\s*\}\s*\)/);
  });

  it('keeps a whole-request budget as well as a per-query one', () => {
    // Fifteen bounds of 700ms is still 10.5 seconds on one connection. The budget is what stops
    // short queries adding up to the same wedge.
    expect(SRC).toMatch(/const deadline = Date\.now\(\) \+ SEARCH_BUDGET_MS/);
    expect(SRC).toMatch(/if \(Date\.now\(\) >= deadline\)/);
  });

  it('does not mark the authorisation check cosmetic', () => {
    // The auth check must REFUSE on failure, never degrade. It is the one read here that decides
    // whether anything is returned at all.
    expect(SRC).toMatch(/withDbRetry\(\(\) => canOpenAdmin\(user\), 'adminSearch\.canOpenAdmin'\)/);
    expect(SRC).not.toMatch(/canOpenAdmin[\s\S]{0,120}cosmetic/);
  });
});

describe('a shortened answer says it is shortened', () => {
  it('reports partial rather than passing a truncated list off as the whole one', () => {
    // The defect class this project keeps finding: a swallowed read rendered as a confident claim.
    // Six sources out of fifteen looks exactly like fifteen from the dropdown.
    expect(SRC).toMatch(/partial: truncated/);
    expect(SRC).toMatch(/truncated = true/);
  });
});
