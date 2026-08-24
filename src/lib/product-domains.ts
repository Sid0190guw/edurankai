// src/lib/product-domains.ts — WHICH TEAMS BUILD WHICH VENTURE.
//
// THE BUG THIS FILE EXISTS TO FIX.
//
// /ecosystem/<venture> asked one question: "which open roles carry this product's slug in
// roles.products?" The answer, for every venture except one, is none — and the page said so:
// "No Viśvambhara-specific roles are open right now", printed under a catalogue of open postings
// that includes Space Systems, Satellite Technology, UAV Systems, Flight Software, Mission
// Planning, Space AI and Aerospace Simulation.
//
// The tag was never populated. src/data/*.ts carries `productMatch` on exactly TWO of ~630
// catalogue entries and both say 'karate'; the extreme-scale importer
// (src/pages/admin/roles/divisions.astro) inserts its postings without touching the product column
// at all. So the linkage the page depended on had two rows in it, and nothing on any surface said
// so — an empty list read as "we are not hiring for this", which was false.
//
// THE FIX IS NOT "GO TAG 630 ROLES BY HAND".
//
// A posting already declares what it works on: its DEPARTMENT. `aerospace-space` is Viśvambhara's
// domain the same way `martial-arts` is Karate.support's, and that mapping is stable, small, and
// reviewable in one screen — which 630 per-role tags are not. So a venture page shows:
//
//     roles explicitly tagged to it   ∪   open roles in the departments that build it
//
// An explicit tag still wins (it sorts first, and it is the only thing that can pull a role in
// from OUTSIDE these departments), so hand-tagging keeps working and keeps overriding.
//
// WHY THIS DOES NOT REOPEN THE THING THE TAG WAS PROTECTING.
//
// The original comment on /ecosystem/[slug].astro was right: "a role with no product tag is
// cross-company and intentionally does not appear here — so AquinTutor and Karate.support never
// show each other's openings." Departments preserve that exactly. `engineering`, `ai-research`,
// `design`, `growth`, `people` and the rest are cross-company and are deliberately mapped to
// NOTHING, so a platform engineer is never advertised as an aerospace hire. Only departments that
// exist BECAUSE of a venture are listed here, and several say so in their own description in
// src/data/role-catalog.ts (smart-cities and geospatial both name the Holistic Education Index).
//
// A VENTURE WITH NO DEPARTMENT KEEPS AN EMPTY LIST, AND THAT IS THE HONEST ANSWER.
//
// Sancharan, Sampark and Sambandh are listed below with no departments on purpose. Nobody is hired
// against them today; inventing a mapping so their pages look busy would be the same lie in the
// other direction. They are written down rather than omitted so the gap is visible here instead of
// being rediscovered from an empty page.

import { sql } from 'drizzle-orm';
import { textIn } from '@/lib/pg-array';

/** One venture, and the teams whose open postings build it. */
export interface ProductDomain {
  /** Canonical product slug, as seeded into `products`. */
  slug: string;
  /** Other slugs the same venture has shipped under (products.slug has drifted before). */
  aliases: string[];
  /** Department ids from CATALOG_DEPARTMENTS whose postings build this venture. */
  departments: string[];
  /** Why these departments and not others. Read by humans reviewing this mapping. */
  note: string;
}

export const PRODUCT_DOMAINS: ProductDomain[] = [
  {
    slug: 'visvambhara',
    aliases: ['vesper'],
    departments: ['aerospace-space', 'robotics-autonomous', 'semiconductor-embedded', 'quantum-tech'],
    note:
      'The autonomous aerospace programme. aerospace-space and robotics-autonomous are the airframe '
      + 'and the autonomy; semiconductor-embedded is the only flight-hardware team there is; '
      + 'quantum-tech is the Akasha-Q command and control backbone named in the programme description.',
  },
  {
    slug: 'karate-support',
    aliases: ['karate', 'karatesupport'],
    departments: ['martial-arts', 'sports-tech'],
    note:
      'sports-tech exists for this platform and says so in its own description ("built on the real '
      + 'Karate.support community platform").',
  },
  {
    slug: 'aquintutor',
    aliases: ['aquintutor-ai', 'aquin-tutor'],
    departments: ['education-learning'],
    note:
      'Curriculum and learning-experience design. Deliberately NOT ai-research or engineering: those '
      + 'teams build for every venture, and listing them here would put the same engineer on four '
      + 'venture pages as though each were hiring separately.',
  },
  {
    slug: 'hei',
    aliases: ['holistic-education-index'],
    departments: ['smart-cities', 'geospatial', 'public-sector-impact'],
    note:
      'All three name the index or its network in their own department description — urban and '
      + 'infrastructure data "supporting the Holistic Education Index", spatial analysis of "our '
      + 'institutional and partner network", and the public-sector education policy work behind the '
      + 'access mission.',
  },
  {
    slug: 'foundational-models',
    aliases: ['foundation-models', 'frontier-models'],
    departments: ['ai-research'],
    note:
      'The research line itself. ai-research is mapped here and nowhere else precisely because it is '
      + 'this venture rather than a shared function.',
  },

  // Ventures with no hiring domain of their own. Listed, not omitted — see the header.
  { slug: 'sancharan', aliases: [], departments: [], note: 'Travel. No department is staffed against it; the page correctly shows nothing.' },
  { slug: 'sampark', aliases: [], departments: [], note: 'CRM. No department is staffed against it; the page correctly shows nothing.' },
  { slug: 'sambandh', aliases: [], departments: [], note: 'Identity-verified matchmaking. No department is staffed against it; the page correctly shows nothing.' },
];

const norm = (s: string | null | undefined): string => String(s || '').trim().toLowerCase();

/**
 * Does `slug` contain `key` as a whole hyphen-separated run of tokens?
 *
 * Substring matching is what the importer used (`p.slug.includes('karate')`) and it is wrong for
 * short keys: 'hei' is a substring of any slug containing "their". Token matching means 'hei'
 * matches only `hei`, while 'aquintutor' still matches `aquintutor-ai`.
 */
function tokensContain(slug: string, key: string): boolean {
  if (!slug || !key) return false;
  if (slug === key) return true;
  const a = slug.split('-').filter(Boolean);
  const b = key.split('-').filter(Boolean);
  if (!b.length || b.length > a.length) return false;
  for (let i = 0; i + b.length <= a.length; i++) {
    let hit = true;
    for (let j = 0; j < b.length; j++) if (a[i + j] !== b[j]) { hit = false; break; }
    if (hit) return true;
  }
  return false;
}

/** The mapping entry for a product slug, or null when the venture has none. */
export function domainForProduct(productSlug: string | null | undefined): ProductDomain | null {
  const s = norm(productSlug);
  if (!s) return null;
  for (const d of PRODUCT_DOMAINS) {
    for (const key of [d.slug, ...d.aliases]) {
      if (tokensContain(s, norm(key))) return d;
    }
  }
  return null;
}

/**
 * Department ids whose open postings build this venture. Empty for an unmapped or
 * deliberately-unstaffed venture — callers must treat that as "tagged roles only", NEVER as
 * "match every department".
 */
export function departmentsForProduct(productSlug: string | null | undefined): string[] {
  return domainForProduct(productSlug)?.departments ?? [];
}

/** Inverse lookup: which venture a department builds, if any. One department, one venture. */
export function productForDepartment(departmentId: string | null | undefined): string | null {
  const d = norm(departmentId);
  if (!d) return null;
  for (const p of PRODUCT_DOMAINS) if (p.departments.includes(d)) return p.slug;
  return null;
}

/**
 * "This role builds that product", as SQL.
 *
 * ONE definition, shared by the venture page's role list and its per-team counts — two surfaces
 * answering the same question two different ways is how a page comes to disagree with itself.
 * (/careers had a `?product=` filter with its own copy of this predicate. The careers rewrite of
 * 2026-08-24 dropped the parameter; if it comes back, it comes back through this function.)
 *
 * It lives in this module rather than in role-products.ts so it can be rendered and asserted on
 * without importing the database client. Both bugs pg-array.ts documents were invisible in review
 * and obvious in the rendered SQL.
 *
 * @param includeTags false drops every reference to the runtime tag columns (`products`,
 *                    `product`) — what the narrowed retry needs on a database where the ALTER that
 *                    adds them has never run, which is every database with SCHEMA_BOOTSTRAP off.
 * @param table       relation name to qualify columns with; drizzle names the table `roles`.
 *
 * Returns `false` when nothing is left to match on — never an empty fragment, which would widen
 * the surrounding AND into "every open role".
 */
export function productMatchClause(productSlug: string, includeTags = true, table = 'roles') {
  const parts: any[] = [];
  if (includeTags) parts.push(productTagClause(productSlug, table));
  const depts = departmentsForProduct(productSlug);
  if (depts.length) parts.push(sql`${sql.raw(table + '.department_id')} IN ${textIn(depts)}`);
  if (!parts.length) return sql`false`;
  return sql`(${sql.join(parts, sql` OR `)})`;
}

/**
 * The tag half on its own — "somebody deliberately assigned this role to this venture".
 *
 * Callers use it as a SELECTED column so a hand-tagged role can be sorted above a domain match.
 *
 * `products @> ARRAY[$1]::text[]` RATHER THAN `$1 = ANY(products)`, for two reasons. It is the
 * containment operator, so it can use the `roles_products_gin` index that the ensure above
 * creates and `= ANY` cannot. And the repo-wide scan in pg-array.test.ts rejects the literal text
 * `= ANY(${` anywhere in src — correctly, because forty-nine live instances of it were binding a
 * JS array and failing; a column reference in that position is safe but indistinguishable to a
 * regex, and weakening the scan to admit this one call site is a bad trade for a form that is
 * slower anyway.
 *
 * COALESCE on both halves, because `products @> ...` and `product = ...` are both NULL (not false)
 * on a row with no tags, and NULL sorts FIRST under `ORDER BY tagged DESC` — which would put every
 * untagged role above the hand-tagged ones this exists to promote.
 */
export function productTagClause(productSlug: string, table = 'roles') {
  const col = (name: string) => sql.raw(table + '.' + name);
  return sql`(COALESCE(${col('products')} @> ARRAY[${productSlug}]::text[], false)
              OR COALESCE(${col('product')} = ${productSlug}, false))`;
}
