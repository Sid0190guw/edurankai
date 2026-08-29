// THE GUARD ON THE PRODUCT ↔ DEPARTMENT MAPPING.
//
// The failure this replaces was not a crash. /ecosystem/visvambhara rendered perfectly and said
// "No Viśvambhara-specific roles are open right now" while the aerospace-space team had open
// postings, because the only linkage was a tag nobody had filled in. Nothing failed, so nothing
// reported it.
//
// So the mapping is checked against the real catalogue rather than against itself:
//
//   - a department id here must EXIST (a typo silently resolves to zero roles, which looks exactly
//     like the bug this file exists to fix);
//   - a mapped venture must resolve to departments that actually HAVE postings (an accurate
//     mapping to an empty team is the same empty page);
//   - the shared departments must stay unmapped (the reason the tag existed in the first place).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { CATALOG_DEPARTMENTS, ROLE_CATALOG } from '@/data/role-catalog';
import {
  PRODUCT_DOMAINS,
  departmentsForProduct,
  domainForProduct,
  productForDepartment,
  productMatchClause,
  productTagClause,
  openPostingClause,
} from '@/lib/product-domains';

const DEPT_IDS = new Set(CATALOG_DEPARTMENTS.map((d) => String(d.id)));
const rolesPerDept = (() => {
  const m = new Map<string, number>();
  for (const r of ROLE_CATALOG as Array<{ departmentId: string }>) {
    m.set(r.departmentId, (m.get(r.departmentId) || 0) + 1);
  }
  return m;
})();

/**
 * Ventures that are deliberately unstaffed — they assert the OPPOSITE of the rules below.
 *
 * foundational-models is here because the review that read the actual postings found ai-research
 * to be cross-company (Data Analytics, Business Intelligence, MLOps, and a Multimodal AI role whose
 * own text is about AquinTutor). Removing it left this venture with no department of its own, and
 * an empty list is the honest answer — see RULE OF EVIDENCE in src/lib/product-domains.ts.
 *
 * akasha-q joins them for the same reason and with a specific temptation attached: quantum-tech
 * LOOKS like its department and is not. That department holds Quantum Finance and Quantum Chemistry
 * postings, none of which mention key distribution, free-space optics or pointing systems — it was
 * already removed from Visvambhara on exactly that evidence, and giving the quantum-communications
 * programme its own page is not new evidence for mapping it back.
 */
const UNSTAFFED = new Set(['sancharan', 'sampark', 'sambandh', 'foundational-models', 'akasha-q']);

describe('the mapping points at departments that exist', () => {
  it('every department id is a real catalogue department', () => {
    const unknown = PRODUCT_DOMAINS.flatMap((p) => p.departments.filter((d) => !DEPT_IDS.has(d)).map((d) => p.slug + ' -> ' + d));
    expect(unknown.join(', ')).toBe('');
  });

  it('no department builds two ventures', () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const p of PRODUCT_DOMAINS) {
      for (const d of p.departments) {
        const prev = seen.get(d);
        if (prev) clashes.push(d + ' claimed by ' + prev + ' and ' + p.slug);
        else seen.set(d, p.slug);
      }
    }
    expect(clashes.join(', ')).toBe('');
  });
});

describe('a mapped venture resolves to real postings', () => {
  it('every staffed venture has at least one department with catalogue roles', () => {
    const empty = PRODUCT_DOMAINS
      .filter((p) => !UNSTAFFED.has(p.slug))
      .filter((p) => p.departments.reduce((n, d) => n + (rolesPerDept.get(d) || 0), 0) === 0)
      .map((p) => p.slug);
    expect(empty.join(', ')).toBe('');
  });

  it('Viśvambhara reaches the aerospace postings that were invisible', () => {
    // The literal reported symptom, pinned. aerospace-space carries Space Systems, Satellite
    // Technology, UAV Systems, Flight Software, Mission Planning, Space AI and Aerospace Simulation.
    expect(departmentsForProduct('visvambhara')).toContain('aerospace-space');
    expect(rolesPerDept.get('aerospace-space') || 0).toBeGreaterThan(0);
  });

  it('the deliberately unstaffed ventures stay empty rather than being padded', () => {
    for (const slug of UNSTAFFED) expect(departmentsForProduct(slug)).toEqual([]);
  });
});

describe('the shared departments stay out', () => {
  // These build for every venture. Mapping any of them would put one platform engineer on four
  // venture pages as though each were a separate opening — the exact misrepresentation the
  // product tag was introduced to prevent.
  const SHARED = ['engineering', 'design', 'growth', 'people', 'operations', 'finance-legal',
    'product-programs', 'cybersecurity', 'sales-bd', 'administration', 'governance-affairs'];

  it('no cross-company department is claimed by a venture', () => {
    const leaked = SHARED.filter((d) => productForDepartment(d) !== null);
    expect(leaked.join(', ')).toBe('');
  });
});

describe('slug matching is by token, not substring', () => {
  it('matches the canonical slug and its aliases', () => {
    expect(domainForProduct('visvambhara')?.slug).toBe('visvambhara');
    expect(domainForProduct('aquintutor-ai')?.slug).toBe('aquintutor');
    expect(domainForProduct('karate-support')?.slug).toBe('karate-support');
    expect(domainForProduct('karate')?.slug).toBe('karate-support');
  });

  it('is case and whitespace tolerant, because product slugs are hand-entered in admin', () => {
    expect(domainForProduct('  Visvambhara ')?.slug).toBe('visvambhara');
  });

  it('does not match a short key inside an unrelated word', () => {
    // 'hei' as a substring test would match any of these. As a token it matches only `hei`.
    expect(domainForProduct('their-product')).toBe(null);
    expect(domainForProduct('atheism')).toBe(null);
    expect(domainForProduct('hei')?.slug).toBe('hei');
  });

  it('returns null rather than a default for an unknown or empty slug', () => {
    expect(domainForProduct('')).toBe(null);
    expect(domainForProduct(null)).toBe(null);
    expect(domainForProduct('some-new-venture')).toBe(null);
    expect(departmentsForProduct('some-new-venture')).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------------
// The rendered predicate. Same reasoning as src/lib/pg-array.test.ts: both array-binding bugs this
// repository has shipped read correctly and were obvious only in the SQL that actually executes.
// -------------------------------------------------------------------------------------------------
const dialect = new PgDialect();
const render = (q: any) => dialect.sqlToQuery(q);

describe('the match predicate renders SQL a database will accept', () => {
  it('matches on tags AND departments by default', () => {
    const q = render(sql`SELECT 1 FROM roles WHERE ${productMatchClause('visvambhara')}`);
    expect(q.sql).toContain('roles.products');
    expect(q.sql).toContain('roles.product =');
    expect(q.sql).toContain('roles.department_id IN (SELECT');
  });

  it('never binds a JS array into = ANY — the bug pg-array.ts exists for', () => {
    const q = render(sql`SELECT 1 FROM roles WHERE ${productMatchClause('visvambhara')}`);
    // The department list travels as ONE json parameter, not one placeholder per department.
    expect(q.sql).not.toContain('ANY(($');
    expect(q.params.filter((p) => String(p).startsWith('['))).toHaveLength(1);
  });

  it('tests array membership with @> so the GIN index is usable and the repo scan stays clean', () => {
    // `$1 = ANY(products)` is correct SQL here but cannot use roles_products_gin, and its literal
    // text is what pg-array.test.ts scans src for. Both reasons point at the containment operator.
    const q = render(sql`SELECT 1 FROM roles WHERE ${productMatchClause('visvambhara')}`);
    expect(q.sql).toContain('roles.products @> ARRAY[');
    expect(q.sql).not.toContain('= ANY(');
  });

  it('never lets an untagged row sort as tagged', () => {
    // `products @> ...` is NULL, not false, on a row with no tags — and NULL is FIRST under
    // ORDER BY ... DESC. Without both COALESCEs the hand-tagged roles sort last.
    const q = render(sql`SELECT ${productTagClause('visvambhara')} AS tagged FROM roles`);
    expect((q.sql.match(/COALESCE\(/g) || []).length).toBe(2);
  });

  it('does not double-wrap the membership fragment in parentheses', () => {
    // `IN (${textIn(xs)})` renders `IN ((SELECT ...))` — a scalar subquery that errors only once
    // the list has two entries, so it passes every single-item test and fails in production.
    const q = render(sql`SELECT 1 FROM roles WHERE ${productMatchClause('visvambhara')}`);
    expect(q.sql).not.toContain('IN ((SELECT');
  });

  it('drops the runtime columns entirely when tags are excluded', () => {
    const q = render(sql`SELECT 1 FROM roles WHERE ${productMatchClause('visvambhara', false)}`);
    expect(q.sql).not.toContain('roles.products');
    expect(q.sql).not.toContain('roles.product =');
    expect(q.sql).toContain('roles.department_id IN (SELECT');
  });

  it('renders false — never nothing — when there is no way left to match', () => {
    // An unmapped venture with the tag columns unavailable. An empty fragment here would leave a
    // dangling `AND` and, if it parsed at all, widen the query to every open role in the company.
    const q = render(sql`SELECT 1 FROM roles WHERE ${productMatchClause('some-new-venture', false)}`);
    expect(q.sql.trim().endsWith('WHERE false')).toBe(true);
  });

  it('still matches by tag alone for a venture with no department', () => {
    const q = render(sql`SELECT 1 FROM roles WHERE ${productMatchClause('sambandh')}`);
    expect(q.sql).toContain('roles.products');
    expect(q.sql).not.toContain('department_id');
  });

  it('an unstaffed venture still renders a RUNNABLE narrowed query, not a reason to give up', () => {
    // FOUND ON THE LIVE SITE, 2026-08-24. /ecosystem/foundational-models, sancharan, sampark and
    // sambandh all printed "We could not load our openings just now." Nothing had failed. The tag
    // columns do not exist on that database, so the tag-only first attempt threw, and the reader
    // then returned readable:false because those ventures have no department to fall back on.
    //
    // They have no department because NOBODY IS HIRING AGAINST THEM — a fact the page has its own
    // correct sentence for. The narrowed form must therefore stay a legal statement that matches
    // nothing, so the caller can retry it and get an honest empty answer instead of an error state.
    for (const slug of ['foundational-models', 'sancharan', 'sampark', 'sambandh']) {
      const q = render(sql`SELECT 1 FROM roles WHERE ${productMatchClause(slug, false)}`);
      expect({ slug, sql: q.sql.trim() }).toEqual({ slug, sql: 'SELECT 1 FROM roles WHERE false' });
    }
  });
});

// -------------------------------------------------------------------------------------------------
// The hand-run SQL file must not drift from the mapping.
//
// db/product-domains-schema.sql ends with a verification query that lists the mapped departments so
// an operator can see which of them actually have open postings. That list is a COPY of the mapping,
// and a copy that nobody checks is a copy that goes stale — the operator would then run a query that
// silently omits a venture and read the result as "that venture has no roles".
// -------------------------------------------------------------------------------------------------
describe('db/product-domains-schema.sql agrees with the mapping', () => {
  const sqlFile = readFileSync(
    fileURLToPath(new URL('../../db/product-domains-schema.sql', import.meta.url)),
    'utf8',
  );

  it('creates all three columns the code reads', () => {
    for (const col of ['product', 'products', 'openings']) {
      expect(sqlFile).toContain('ADD COLUMN IF NOT EXISTS ' + col);
    }
  });

  it('creates the GIN index the @> predicate needs', () => {
    expect(sqlFile).toContain('roles_products_gin');
    expect(sqlFile).toContain('USING GIN (products)');
  });

  it('lists exactly the departments the mapping resolves through', () => {
    // The verification query's IN (...) list, parsed back out of the file.
    const block = sqlFile.slice(sqlFile.indexOf('AND r.department_id IN ('));
    const listed = new Set(
      (block.slice(0, block.indexOf(')')).match(/'([a-z0-9-]+)'/g) || []).map((q) => q.slice(1, -1)),
    );
    const mapped = new Set(PRODUCT_DOMAINS.flatMap((p) => p.departments));
    const missingFromSql = [...mapped].filter((d) => !listed.has(d));
    const staleInSql = [...listed].filter((d) => !mapped.has(d));
    expect(missingFromSql.join(', ')).toBe('');
    expect(staleInSql.join(', ')).toBe('');
  });

  it('does not try to tag anything: resolving a venture is the app matcher job', () => {
    // A second, LIKE-based copy of domainForProduct() living in SQL is exactly the divergence this
    // whole change exists to remove. If an UPDATE on roles.products ever appears in this file, the
    // repository has two definitions of the same rule again.
    expect(/UPDATE\s+roles/i.test(sqlFile)).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------------
// The open-posting gate. A venture page whose count disagrees with the page its own chip links to
// is a defect this repository has shipped before, and the only defence is that both sides render
// the SAME predicate.
// -------------------------------------------------------------------------------------------------
describe('the open-posting gate matches the one every careers surface uses', () => {
  it('applies all three conditions, not just is_open', () => {
    const q = render(sql`SELECT 1 FROM roles WHERE ${openPostingClause(true)}`);
    expect(q.sql).toContain('roles.is_open = true');
    expect(q.sql).toContain("COALESCE(roles.job_status, 'PUBLISHED') = 'PUBLISHED'");
    expect(q.sql).toContain('roles.application_deadline IS NULL');
    expect(q.sql).toContain('roles.application_deadline > NOW()');
  });

  it('is the same predicate listOpportunities renders', () => {
    // Checked against the house definition in src/lib/xscale/roles-ext.ts rather than restated here.
    // If that file's gate is edited and this one is not, the venture pages start disagreeing with
    // /careers/department/<id> again, and this test is what says so.
    const house = readFileSync(
      fileURLToPath(new URL('./xscale/roles-ext.ts', import.meta.url)),
      'utf8',
    ).replace(/\s+/g, ' ');
    for (const part of [
      'r.is_open = TRUE',
      "COALESCE(r.job_status, 'PUBLISHED') = 'PUBLISHED'",
      'r.application_deadline IS NULL OR r.application_deadline > NOW()',
    ]) {
      expect({ part, inHouse: house.includes(part) }).toEqual({ part, inHouse: true });
    }
    // ...and the same three, on this side, with our own table alias.
    const mine = render(sql`SELECT 1 FROM roles WHERE ${openPostingClause(true)}`).sql.replace(/\s+/g, ' ');
    for (const part of [
      'roles.is_open = true',
      "COALESCE(roles.job_status, 'PUBLISHED') = 'PUBLISHED'",
      'roles.application_deadline IS NULL OR roles.application_deadline > NOW()',
    ]) {
      expect({ part, inMine: mine.includes(part) }).toEqual({ part, inMine: true });
    }
  });

  it('narrows to is_open alone, which is the same fallback listOpportunities takes', () => {
    // db/xscale-schema.sql is hand-run and this repo has confirmed it unapplied in production, so
    // job_status can be absent. When it is, BOTH surfaces drop to is_open and still agree.
    const q = render(sql`SELECT 1 FROM roles WHERE ${openPostingClause(false)}`);
    expect(q.sql).toContain('roles.is_open = true');
    expect(q.sql).not.toContain('job_status');
    expect(q.sql).not.toContain('application_deadline');
  });
});

// -------------------------------------------------------------------------------------------------
// The paste-safe split of db/xscale-schema.sql must not drift from the original.
//
// The Extreme-Scale / Nano department needs a hand-run migration, and the original file cannot be
// run from a web SQL console at all: it ends in CREATE INDEX CONCURRENTLY, a console wraps a paste
// in one transaction, and CONCURRENTLY is illegal there — so the paste fails on the first index and
// rolls back every ALTER above it. The console reports one error and the migration did nothing.
//
// The two paste-* files carry the same DDL for that route. Two copies of one migration is exactly
// the divergence this repository keeps getting bitten by, so they are checked against the original
// here: a column added to one and not the others fails the build, instead of failing silently on
// somebody's database months later.
// -------------------------------------------------------------------------------------------------
describe('the xscale paste files match db/xscale-schema.sql', () => {
  const read = (name: string) =>
    readFileSync(fileURLToPath(new URL('../../db/' + name, import.meta.url)), 'utf8');
  const original = read('xscale-schema.sql');
  const paste1 = read('xscale-schema.paste-1-tables.sql');
  const paste2 = read('xscale-schema.paste-2-indexes.sql');

  /** Every `roles` column the file adds. */
  const columnsOf = (s: string) =>
    new Set((s.match(/ADD COLUMN IF NOT EXISTS\s+(\w+)/g) || []).map((m) => m.split(/\s+/).pop() as string));
  /** Every index the file creates, however it creates it. Whitespace-tolerant: these files align
   *  their statements into columns, so `CREATE INDEX        IF NOT EXISTS` is normal here. */
  const indexesOf = (s: string) =>
    new Set((s.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?IF\s+NOT\s+EXISTS\s+(\w+)/g) || [])
      .map((m) => m.split(/\s+/).pop() as string));

  it('paste 1 adds exactly the columns the original does', () => {
    const want = [...columnsOf(original)].sort();
    const got = [...columnsOf(paste1)].sort();
    expect(got.join(', ')).toBe(want.join(', '));
    expect(want.length).toBe(16);
  });

  it('paste 1 and paste 2 together create exactly the indexes the original does', () => {
    const want = [...indexesOf(original)].sort();
    const got = [...new Set([...indexesOf(paste1), ...indexesOf(paste2)])].sort();
    expect(got.join(', ')).toBe(want.join(', '));
  });

  it('paste 1 creates the divisions table and runs the job_status backfill', () => {
    expect(paste1).toContain('CREATE TABLE IF NOT EXISTS divisions');
    expect(paste1).toContain('divisions_department_id_fkey');
    expect(/UPDATE roles\s+SET job_status/.test(paste1)).toBe(true);
  });

  it('neither paste file BUILDS an index concurrently, which is the whole reason they exist', () => {
    // One creeping back in would make the split file fail in the console it was written for, and
    // fail in the same invisible way as the original: one error, and nothing applied.
    //
    // An executable statement, not the word, and not a quotation of it — both files explain in
    // prose WHY they avoid CONCURRENTLY (paste 1 quotes the rule verbatim), so the SQL comments are
    // stripped first. A test that forbade the word would forbid its own explanation.
    const sqlOnly = (s: string) => s.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
    const builds = (s: string) => /CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(sqlOnly(s));
    expect(builds(paste1)).toBe(false);
    expect(builds(paste2)).toBe(false);
    // ...while the original, which is the psql route, still does.
    expect(builds(original)).toBe(true);
  });

  it('the original points readers at the split, and the split back at the admin steps', () => {
    // A migration that lands and is then never imported or published is indistinguishable, from the
    // careers site, from one that never ran at all. Both files have to say what comes next.
    expect(original).toContain('xscale-schema.paste-1-tables.sql');
    expect(paste1).toContain('/admin/roles/divisions');
    expect(paste2).toContain('/admin/roles/divisions');
  });
});

// -------------------------------------------------------------------------------------------------
// The one-paste file is now FOUR copies of the same DDL (this, the original, and the two split
// files). That is three chances for one of them to be edited and the others not, on a migration
// nobody re-reads once it has been run. So it is checked against BOTH sources it merges.
// -------------------------------------------------------------------------------------------------
describe('db/apply-nano-and-ventures.sql merges its two sources without losing anything', () => {
  const read = (name: string) =>
    readFileSync(fileURLToPath(new URL('../../db/' + name, import.meta.url)), 'utf8');
  const combined = read('apply-nano-and-ventures.sql');
  const ventures = read('product-domains-schema.sql');
  const xscale = read('xscale-schema.sql');

  const columnsOf = (s: string) =>
    new Set((s.match(/ADD COLUMN IF NOT EXISTS\s+(\w+)/g) || []).map((m) => m.split(/\s+/).pop() as string));
  const indexesOf = (s: string) =>
    new Set((s.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?IF\s+NOT\s+EXISTS\s+(\w+)/g) || [])
      .map((m) => m.split(/\s+/).pop() as string));

  it('carries every column from both source files', () => {
    const want = [...new Set([...columnsOf(ventures), ...columnsOf(xscale)])].sort();
    const missing = want.filter((c) => !columnsOf(combined).has(c));
    expect(missing.join(', ')).toBe('');
    expect(want.length).toBe(19); // 3 venture tag columns + 16 research columns
  });

  it('carries every index from both source files', () => {
    const want = [...new Set([...indexesOf(ventures), ...indexesOf(xscale)])].sort();
    const missing = want.filter((i) => !indexesOf(combined).has(i));
    expect(missing.join(', ')).toBe('');
    expect(want.length).toBe(10);
  });

  it('creates the divisions table and runs the job_status backfill', () => {
    expect(combined).toContain('CREATE TABLE IF NOT EXISTS divisions');
    expect(combined).toContain('divisions_department_id_fkey');
    expect(/UPDATE roles\s+SET job_status/.test(combined)).toBe(true);
  });

  it('builds no index concurrently — it is written to be pasted into one transaction', () => {
    const sqlOnly = combined.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
    expect(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY/i.test(sqlOnly)).toBe(false);
  });

  it('its department list still matches the mapping', () => {
    const block = combined.slice(combined.indexOf('AND r.department_id IN ('));
    const listed = new Set(
      (block.slice(0, block.indexOf(')')).match(/'([a-z0-9-]+)'/g) || []).map((q) => q.slice(1, -1)),
    );
    const mapped = new Set(PRODUCT_DOMAINS.flatMap((p) => p.departments));
    expect([...mapped].filter((d) => !listed.has(d)).join(', ')).toBe('');
    expect([...listed].filter((d) => !mapped.has(d)).join(', ')).toBe('');
  });

  it('tells the operator the two clicks that come after it', () => {
    // The schema publishes nothing. A migration that lands and is never imported or published is
    // indistinguishable, from the careers site, from one that never ran.
    expect(combined).toContain('/admin/roles/divisions');
    expect(combined).toContain('Publish division');
  });
});
