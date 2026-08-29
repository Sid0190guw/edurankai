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
// THE RULE OF EVIDENCE, LEARNED THE HARD WAY.
//
// A department may be mapped to a venture only when THE POSTINGS THEMSELVES carry the link — the
// role's own `about` text names the venture or its subject matter. A department DESCRIPTION that
// claims the link is not enough, and neither is a plausible-sounding architectural argument.
//
// The first draft of this file mapped four departments to Viśvambhara and one to Foundational
// Models on exactly that kind of reasoning, and a review of the actual role text found 31 of the 39
// resulting roles had nothing to do with the venture they were being advertised under. What passes
// the rule reads like these, all verbatim from src/data:
//
//   Smart City Intern     "...informing how the Holistic Education Index thinks about institutional
//                          and regional infrastructure."
//   GIS Analyst Intern    "Our Holistic Education Index and AquinTutor partner network span
//                          institutions across geographies..."
//   sports-tech (dept)    "...built on the real Karate.support community platform."
//
// What fails it reads like these, also verbatim:
//
//   Quantum Finance Intern  "Quantitative finance problems recast for quantum methods..."
//   VLSI Design Intern      "VLSI chip-design fundamentals - RTL design, verification basics..."
//   ROS Development Intern  "Hands-on Robot Operating System development - nodes, topics..."
//
// Before adding a department here, read its postings. Not its description, and not its name.
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
    departments: ['aerospace-space'],
    note:
      'The autonomous aerospace programme. ONE department, and the shortlist was cut down to it after '
      + 'a review read the actual postings. robotics-autonomous, semiconductor-embedded and quantum-tech '
      + 'were all mapped here on plausible-sounding reasoning ("the autonomy", "the only flight-hardware '
      + 'team", "the Akasha-Q backbone") and every one of them was wrong: those departments hold ROS '
      + 'Development, Industrial Automation, VLSI Design, PCB Design, Quantum Finance and Quantum '
      + 'Chemistry, and not one posting in any of them mentions aerospace, VESPER, a UAV or Akasha-Q. '
      + 'They would have put 31 unrelated roles on this page against 8 real ones. A candidate applying '
      + 'to Quantum Chemistry Intern believing it was work on an interplanetary command vessel is the '
      + 'exact harm this whole mapping is supposed to prevent. See RULE OF EVIDENCE in the header.',
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
      'The only three that pass the rule of evidence on their POSTINGS, not just their department '
      + 'description. Smart City Intern: "informing how the Holistic Education Index thinks about '
      + 'institutional and regional infrastructure". GIS Analyst Intern: "Our Holistic Education Index '
      + 'and AquinTutor partner network span institutions across geographies". Policy Analytics Intern: '
      + '"applying data analysis to education-policy questions". Checked one by one during the review '
      + 'that removed quantum-tech from Visvambhara, and these survived it.',
  },
  {
    slug: 'foundational-models',
    aliases: ['foundation-models', 'frontier-models'],
    departments: [],
    note:
      'UNSTAFFED, after ai-research was removed. Mapping it here contradicted the header of this file '
      + 'and its aquintutor note, both of which name ai-research as cross-company — and the postings '
      + 'prove the header right: the department holds Data Analytics, Business Intelligence, Data '
      + 'Engineering and MLOps alongside the model work, and Multimodal AI Intern says in its own text '
      + 'that it is about how AquinTutor teaches. Advertising all 32 as frontier-model research would '
      + 'mislead, and quietly moving them off the AquinTutor side of the house would be a second error. '
      + 'No department is exclusively this venture, so it has none.',
  },

  // Ventures with no hiring domain of their own. Listed, not omitted — see the header.
  {
    slug: 'akasha-q',
    aliases: ['akashaq', 'akasha'],
    departments: [],
    note:
      'Quantum-secure communications. UNSTAFFED, and quantum-tech is exactly the department the rule '
      + 'of evidence keeps off this page: it holds Quantum Finance and Quantum Chemistry postings, '
      + 'and not one of them mentions key distribution, free-space optics, pointing systems or '
      + 'Akasha-Q. It was already removed from Visvambhara for that reason during the review recorded '
      + 'above, and separating this programme onto its own page is not new evidence. The roles this '
      + 'programme would actually hire — optomechanical and pointing-systems engineering — have no '
      + 'department of their own yet, so the honest answer is none.',
  },
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

/**
 * "This posting is actually on offer", as SQL — the house definition, not a local one.
 *
 * WHY THIS IS NOT JUST `is_open = true`.
 *
 * Every careers surface gates a public listing on THREE conditions, not one:
 *
 *   is_open = TRUE
 *   AND COALESCE(job_status, 'PUBLISHED') = 'PUBLISHED'
 *   AND (application_deadline IS NULL OR application_deadline > NOW())
 *
 * — src/lib/xscale/roles-ext.ts listOpportunities(), src/lib/xscale/divisions.ts, the department
 * directory, and the sitemap. The venture readers checked only the first, which was invisible while
 * the product tag matched two roles company-wide and became very visible the moment a whole
 * department started feeding a public count: /ecosystem/visvambhara would print a total, and a team
 * chip would print a number, and both would land the visitor on /careers/department/<id> — a page
 * rendered under the stricter gate, showing fewer.
 *
 * A page whose count disagrees with the page it links to is the failure this repository keeps
 * having, and it is the same one the header of this file is about: two surfaces answering the same
 * question two different ways.
 *
 * THE REACHABLE WAY THEY DIVERGE is not an expired deadline (nothing in the admin writes one). It
 * is this: /admin/roles/[id] has a status control that writes job_status AND is_open together, and
 * a separate plain Save form that writes is_open ALONE while deliberately preserving job_status.
 * Close a posting with the status button, re-open it later by ticking the checkbox on the Save
 * form, and you have job_status='CLOSED' with is_open=true. Two ordinary clicks.
 *
 * @param extended false drops job_status and the deadline — for the narrowed retry on a database
 *                 where db/xscale-schema.sql has never been applied and `job_status` does not
 *                 exist. That is the same fallback listOpportunities() takes, so in that state the
 *                 two surfaces still agree with each other.
 */
export function openPostingClause(extended = true, table = 'roles') {
  const col = (name: string) => sql.raw(table + '.' + name);
  if (!extended) return sql`${col('is_open')} = true`;
  return sql`(${col('is_open')} = true
              AND COALESCE(${col('job_status')}, 'PUBLISHED') = 'PUBLISHED'
              AND (${col('application_deadline')} IS NULL OR ${col('application_deadline')} > NOW()))`;
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
