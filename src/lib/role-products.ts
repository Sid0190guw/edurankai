// Product <-> Role linkage.
//
// A role can build MULTIPLE products, so the same opening can surface on several
// venture pages (e.g. a UI/UX Design Intern shown on both AquinTutor and
// Karate.support). Tags live in a `products` TEXT[] column. The legacy single
// `product` column is kept in sync (= products[0]) for backward compatibility.
// A role may also declare an optional `openings` count (how many seats).
//
// Columns are added at runtime (ALTER ... IF NOT EXISTS), memoised via
// ensureOnce so it costs one DDL round-trip per server process — important for
// keeping database compute idle.
//
// TAGS ARE NO LONGER THE ONLY LINKAGE, BECAUSE FOR ALMOST EVERY VENTURE THEY WERE EMPTY.
//
// Two of ~630 catalogue entries carry a product tag and both say 'karate'; the extreme-scale
// importer sets none at all. Every venture page therefore said "no roles are open right now" over
// a catalogue that was visibly hiring for it. The reads below now also match a role by its
// DEPARTMENT, through the reviewable mapping in src/lib/product-domains.ts — an explicit tag still
// wins and is still the only way to pull a role in from outside those departments.
//
// AND EVERY READ RETRIES WITHOUT THE TAG COLUMNS.
//
// `product`, `products` and `openings` are added by the ensure above, which is a no-op in
// production (SCHEMA_BOOTSTRAP is off) and is created by no file in db/. On any database where
// that ALTER has never run, the old query threw and the catch turned it into an empty list — the
// same confident "we are not hiring for this" for a completely different reason. The narrowed
// retry asks the department question alone, which needs no runtime column.
import { db } from '@/lib/db';
import { textArray, textIn } from '@/lib/pg-array';
import { sql } from 'drizzle-orm';
import { ensureBatch } from '@/lib/ensure-once';
import {
  departmentsForProduct, domainForProduct, openPostingClause, productMatchClause, productTagClause,
  PRODUCT_DOMAINS,
} from '@/lib/product-domains';

// Re-exported so a page importing the linkage does not have to know which of the two modules the
// predicate happens to live in.
export { openPostingClause, productMatchClause, productTagClause };

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const clean = (slugs: string[]): string[] =>
  Array.from(new Set((slugs || []).map((s) => (s || '').trim()).filter(Boolean)));

// One round trip, not five — same reasoning as ROLES_AICTE_DDL in role-aicte.ts. All five are
// idempotent and none is individually tolerated, so batching changes nothing but the cost.
const ROLES_PRODUCT_DDL = `
  ALTER TABLE roles ADD COLUMN IF NOT EXISTS product VARCHAR(80);
  ALTER TABLE roles ADD COLUMN IF NOT EXISTS products TEXT[];
  ALTER TABLE roles ADD COLUMN IF NOT EXISTS openings INT;
  CREATE INDEX IF NOT EXISTS roles_product_idx ON roles (product);
  CREATE INDEX IF NOT EXISTS roles_products_gin ON roles USING GIN (products);
`;

export function ensureRoleProductColumn(): Promise<void> {
  return ensureBatch('roles_product_cols_v2', ROLES_PRODUCT_DDL);
}

// =================================================================================================
//   THE THREE VENTURE READS
// =================================================================================================
//
// EVERY ONE OF THEM REPORTS WHETHER IT COULD ANSWER, AND WHETHER THE ANSWER IS COMPLETE.
//
// They used to return [] / {} on any error. That is the defect class this whole change was written
// to remove, reintroduced one layer down: an empty list rendered as "No roles are open right now",
// so a pool stall, an open circuit breaker or a statement timeout produced exactly the same
// confident sentence as a genuinely empty catalogue. listOpportunities() next door already carries
// `readable` and `degraded` for this reason; these now do too.
//
//   readable:false  the query failed and the page must NOT claim anything about hiring.
//   degraded:true   the narrowed retry answered. It ran WITHOUT the tag columns (so hand-tagged
//                   roles outside the mapped departments are missing) and WITHOUT the job_status /
//                   deadline gate (so a withdrawn posting may be counted). Say so; do not present
//                   it as the filtered result. That is verbatim the mistake roles-ext.ts documents.

export interface VentureRoles { readable: boolean; degraded: boolean; roles: any[] }
export interface VentureTeams {
  readable: boolean;
  degraded: boolean;
  total: number;
  teams: Array<{ id: string; name: string; openCount: number }>;
}

/**
 * Open roles that build a given product: explicitly tagged, or in one of the departments that
 * build it. Tagged roles sort first, so a deliberate hand-tag always leads the list.
 */
export async function getRolesForProduct(productSlug: string, limit = 6): Promise<VentureRoles> {
  if (!productSlug) return { readable: true, degraded: false, roles: [] };
  const depts = departmentsForProduct(productSlug);
  try {
    await ensureRoleProductColumn();
    const r = await db.execute(sql`
      SELECT roles.slug, roles.title, roles.level, roles.department_id,
             COALESCE(d.name, roles.department_id) AS department_name,
             COALESCE(roles.openings, 0) AS openings,
             ${productTagClause(productSlug)} AS tagged
      FROM roles
      LEFT JOIN departments d ON d.id = roles.department_id
      WHERE ${openPostingClause(true)}
        AND ${productMatchClause(productSlug, true)}
      ORDER BY tagged DESC, roles.is_featured DESC, roles.sort_order ASC, roles.title ASC
      LIMIT ${limit}
    `);
    return { readable: true, degraded: false, roles: rows(r) };
  } catch (e: any) {
    console.error('[role-products] getRolesForProduct', e?.cause?.message || e?.message);
    // Two families of column can be absent here: the tag columns (product/products/openings, added
    // by an ensure that is a no-op in production) and job_status (added by the hand-run
    // db/xscale-schema.sql). The retry drops BOTH rather than guessing which, and says degraded.
    //
    // THE RETRY RUNS EVEN FOR A VENTURE WITH NO DEPARTMENTS, and that is not a wasted round trip.
    // It used to return readable:false here, on the reasoning that there was no department half to
    // fall back to — which put "We could not load our openings just now" on /ecosystem/
    // foundational-models, sancharan, sampark and sambandh on the live site, because the tag
    // columns do not exist yet and the tag-only first attempt therefore always throws. Nothing had
    // failed. Those four ventures simply have no team hiring against them, which is a FACT the page
    // has a correct sentence for. Trading one false claim for a different false claim is not a fix.
    //
    // With an empty list the narrowed query is a valid statement that matches nothing, so it comes
    // back readable and empty — and `degraded` still says the tag half went unchecked.
    try {
      const r2 = await db.execute(sql`
        SELECT roles.slug, roles.title, roles.level, roles.department_id,
               COALESCE(d.name, roles.department_id) AS department_name,
               0 AS openings, false AS tagged
        FROM roles
        LEFT JOIN departments d ON d.id = roles.department_id
        WHERE ${openPostingClause(false)}
          AND roles.department_id IN ${textIn(depts)}
        ORDER BY roles.is_featured DESC, roles.sort_order ASC, roles.title ASC
        LIMIT ${limit}
      `);
      console.error('[role-products] retried getRolesForProduct narrowed and succeeded');
      return { readable: true, degraded: true, roles: rows(r2) };
    } catch (e2: any) {
      console.error('[role-products] narrowed getRolesForProduct also failed', e2?.cause?.message || e2?.message);
      return { readable: false, degraded: false, roles: [] };
    }
  }
}

/**
 * The teams hiring for a venture, with a count each, and the honest total across them.
 *
 * ONE round trip for both numbers: the venture page needs the total ("8 open roles") and the
 * per-team split in the same render, and grouping gives both.
 *
 * `total` is a sum over GROUP BY roles.department_id, so it counts each role exactly once — a role
 * has exactly one department, and the grouping key is the department id, not the joined name.
 *
 * WHY THE PAGE LINKS PER TEAM. `/careers?product=<slug>` was the "see all of them" link, and the
 * careers rewrite of 2026-08-24 dropped that parameter — the page and /api/careers/search read `q`,
 * `dept`, `division`, `level`, `type`, `classification`, `band`, `skill` and `domain`, and nothing
 * else. A link carrying a parameter nobody reads shows the whole catalogue while claiming to show
 * one venture, so the chips point at /careers/department/<id>, which filters — and, because the
 * gate above is now that page's gate, agrees with the number it prints.
 */
export async function getProductTeamBreakdown(productSlug: string): Promise<VentureTeams> {
  const empty: VentureTeams = { readable: true, degraded: false, total: 0, teams: [] };
  if (!productSlug) return empty;

  const run = async (full: boolean) => {
    const r = await db.execute(sql`
      SELECT roles.department_id AS id,
             COALESCE(d.name, roles.department_id) AS name,
             COUNT(*)::int AS n
      FROM roles
      LEFT JOIN departments d ON d.id = roles.department_id
      WHERE ${openPostingClause(full)}
        AND ${productMatchClause(productSlug, full)}
      GROUP BY roles.department_id, d.name
      ORDER BY n DESC, name ASC
    `);
    const teams = rows(r)
      .filter((x: any) => x.id)
      .map((x: any) => ({ id: String(x.id), name: String(x.name || x.id), openCount: Number(x.n) || 0 }));
    return { total: teams.reduce((a, t) => a + t.openCount, 0), teams };
  };

  try {
    await ensureRoleProductColumn();
    const out = await run(true);
    return { readable: true, degraded: false, total: out.total, teams: out.teams };
  } catch (e: any) {
    console.error('[role-products] getProductTeamBreakdown', e?.cause?.message || e?.message);
    // Retried even with no departments — see the note in getRolesForProduct. `run(false)` drops the
    // tag half, and productMatchClause then renders a literal `false`, which is a valid predicate
    // matching nothing rather than a reason to claim the page could not be loaded.
    try {
      const out = await run(false);
      console.error('[role-products] retried getProductTeamBreakdown narrowed and succeeded');
      return { readable: true, degraded: true, total: out.total, teams: out.teams };
    } catch (e2: any) {
      console.error('[role-products] narrowed getProductTeamBreakdown also failed', e2?.cause?.message || e2?.message);
      return { readable: false, degraded: false, total: 0, teams: [] };
    }
  }
}

/**
 * Open-role count per product slug — tagged plus domain, deduplicated.
 *
 * Two grouped reads rather than one join against a VALUES list of the mapping: the tag pairs are
 * counted in SQL and the department totals are counted in SQL, and the OVERLAP (a role both tagged
 * to a venture and sitting in one of its departments) is subtracted in JS from the pair rows. Naive
 * addition would double-count exactly those roles and quietly inflate every card on /ecosystem.
 *
 * `readable:false` matters as much here as it does above: /ecosystem renders a badge only when the
 * count is above zero, so a failed read is indistinguishable from a company that is not hiring —
 * every card silently loses its number and nothing on the page says why.
 */
export async function getOpenRoleCountsByProduct(
  productSlugs?: string[]
): Promise<{ readable: boolean; degraded: boolean; counts: Record<string, number> }> {
  const counts: Record<string, number> = {};
  // KEYED BY THE CALLER'S OWN SLUGS, not by the canonical ones in PRODUCT_DOMAINS.
  //
  // `products.slug` and the canonical key are not always the same string — AquinTutor has shipped
  // as both `aquintutor` and `aquintutor-ai`, and .dev-scripts/fix-aquintutor-link.cjs exists
  // because of it. Returning canonical keys would hand /ecosystem a map whose keys miss its own
  // rows, and every card would silently read zero: the same empty answer in a new place.
  const wanted = productSlugs && productSlugs.length
    ? Array.from(new Set(productSlugs.filter(Boolean)))
    : PRODUCT_DOMAINS.map((p) => p.slug);

  // Department totals first. This read touches no runtime column except job_status, and retries
  // without it, so it is the one that survives a database missing either migration.
  const perDept: Record<string, number> = {};
  let readable = false;
  let degraded = false;
  const deptCounts = (full: boolean) => db.execute(sql`
    SELECT department_id, COUNT(*)::int AS n
    FROM roles
    WHERE ${openPostingClause(full)} AND department_id IS NOT NULL
    GROUP BY department_id
  `);
  try {
    for (const row of rows(await deptCounts(true))) perDept[String(row.department_id)] = Number(row.n) || 0;
    readable = true;
  } catch (e: any) {
    console.error('[role-products] department counts failed', e?.cause?.message || e?.message);
    try {
      for (const row of rows(await deptCounts(false))) perDept[String(row.department_id)] = Number(row.n) || 0;
      readable = true;
      degraded = true;
      console.error('[role-products] retried department counts without job_status and succeeded');
    } catch (e2: any) {
      console.error('[role-products] narrowed department counts also failed', e2?.cause?.message || e2?.message);
      return { readable: false, degraded: false, counts: {} };
    }
  }
  for (const slug of wanted) {
    // departmentsForProduct() resolves the alias, so a DB slug of `aquintutor-ai` still finds the
    // `aquintutor` mapping and its departments.
    const n = departmentsForProduct(slug).reduce((acc, id) => acc + (perDept[id] || 0), 0);
    if (n) counts[slug] = n;
  }

  // Then the tags. One row per (open tagged role, product) — two rows today, and bounded by the
  // catalogue even if every role were tagged. Their absence degrades the answer; it does not void
  // it, because the department half above already produced a real number.
  try {
    await ensureRoleProductColumn();
    const r = await db.execute(sql`
      SELECT prod AS product, department_id
      FROM roles
      CROSS JOIN LATERAL unnest(
        COALESCE(NULLIF(products, '{}'),
                 CASE WHEN product IS NOT NULL AND product <> '' THEN ARRAY[product] ELSE ARRAY[]::text[] END)
      ) AS prod
      WHERE ${openPostingClause(!degraded)}
    `);
    for (const row of rows(r)) {
      const slug = String(row.product || '');
      if (!slug) continue;
      // Already counted through its department? Then the tag adds nothing to the total.
      if (departmentsForProduct(slug).includes(String(row.department_id))) continue;
      counts[slug] = (counts[slug] || 0) + 1;
    }
  } catch (e: any) {
    console.error('[role-products] tag counts unavailable, showing domain counts only', e?.cause?.message || e?.message);
    degraded = true;
  }
  return { readable, degraded, counts };
}

/** Persist a role's product tags (array) — keeps legacy `product` = first slug. */
export async function setRoleProducts(roleId: string, slugs: string[]): Promise<void> {
  await ensureRoleProductColumn();
  const list = clean(slugs);
  // `${list}::text[]` threw "cannot cast type record to text[]" on EVERY call — see
  // src/lib/pg-array.ts. Product tags therefore never saved, which also meant every save in
  // /admin/roles/new and /admin/roles/[id] 500'd after writing the role itself.
  await db.execute(sql`
    UPDATE roles SET products = ${textArray(list)}, product = ${list[0] || null}
    WHERE id = ${roleId}
  `);
}

/** Read a role's product tags (array), falling back to the legacy single col. */
export async function getRoleProducts(roleId: string): Promise<string[]> {
  try {
    await ensureRoleProductColumn();
    const row = rows(await db.execute(sql`SELECT products, product FROM roles WHERE id = ${roleId} LIMIT 1`))[0];
    if (!row) return [];
    const arr: string[] = Array.isArray(row.products) ? row.products.filter(Boolean) : [];
    if (arr.length) return arr;
    return row.product ? [row.product] : [];
  } catch {
    return [];
  }
}

/** Persist a role's optional openings count (null clears it). */
export async function setRoleOpenings(roleId: string, openings: number | null): Promise<void> {
  await ensureRoleProductColumn();
  const n = openings != null && Number.isFinite(openings) && openings > 0 ? Math.floor(openings) : null;
  await db.execute(sql`UPDATE roles SET openings = ${n} WHERE id = ${roleId}`);
}

/** Read a role's openings count (0 = unspecified). */
export async function getRoleOpenings(roleId: string): Promise<number> {
  try {
    await ensureRoleProductColumn();
    const row = rows(await db.execute(sql`SELECT openings FROM roles WHERE id = ${roleId} LIMIT 1`))[0];
    return row?.openings != null ? Number(row.openings) : 0;
  } catch {
    return 0;
  }
}

/** Visible products (for the admin product multi-select). */
export async function getProductOptions(): Promise<Array<{ slug: string; name: string }>> {
  try {
    const r = await db.execute(sql`
      SELECT slug, name FROM products
      WHERE is_visible = true
      ORDER BY sort_order ASC, name ASC
    `);
    return rows(r).map((x: any) => ({ slug: x.slug, name: x.name }));
  } catch {
    return [];
  }
}

/**
 * Write the venture tags into the database, from the same mapping the pages read.
 *
 * WHY THIS EXISTS AS A FUNCTION AND NOT AS A .sql FILE.
 *
 * db/product-domains-schema.sql creates the three columns, and stops there. Deciding WHICH product
 * row a mapping entry belongs to needs domainForProduct()'s token-boundary matcher — `aquintutor-ai`
 * must resolve to the `aquintutor` mapping, and `hei` must not match a slug that merely contains
 * the letters "hei". Writing that as LIKE patterns in SQL would be a second, subtly different
 * definition of a rule this repository already has one of, and divergent copies of the same
 * predicate is the defect class that produced the empty venture pages in the first place.
 *
 * So the mapping is resolved in JS against the REAL product slugs in the database, and the writes
 * are one bulk UPDATE per venture — eight statements, not one per role.
 *
 * IT NEVER OVERWRITES A HAND EDIT. Only rows with no tag at all are touched, which is the same
 * rule the AICTE repair on /admin/roles/diagnose follows.
 *
 * TAGS ARE NOT WHAT MAKES THE VENTURE PAGES WORK. Those resolve a role's venture from its
 * department at read time and never needed this. Running it makes the linkage a recorded fact —
 * visible in the admin role editor, usable by anything that filters on the column, and no longer
 * an inference recomputed on every render.
 */
export async function backfillProductTagsFromDomains(): Promise<{
  tagged: number;
  perProduct: Record<string, number>;
  unmatchedVentures: string[];
  untaggedProducts: string[];
}> {
  await ensureRoleProductColumn();

  // The REAL slugs, from the products table — not the canonical keys in PRODUCT_DOMAINS.
  const options = await getProductOptions();
  const jobs: Array<{ slug: string; canonical: string; depts: string[] }> = [];
  const matchedCanonical = new Set<string>();
  const untaggedProducts: string[] = [];
  for (const p of options) {
    const d = domainForProduct(p.slug);
    if (d && d.departments.length) {
      jobs.push({ slug: p.slug, canonical: d.slug, depts: d.departments });
      matchedCanonical.add(d.slug);
    } else {
      untaggedProducts.push(p.slug);
    }
  }

  // A venture that HAS departments but whose product row could not be found. Reported rather than
  // swallowed: it means either the products table has not been seeded or a slug has drifted, and
  // either way that venture's tags are silently not being written.
  const unmatchedVentures = PRODUCT_DOMAINS
    .filter((p) => p.departments.length && !matchedCanonical.has(p.slug))
    .map((p) => p.slug);

  const perProduct: Record<string, number> = {};
  let tagged = 0;
  for (const j of jobs) {
    // Per-venture isolation: one failing UPDATE must not abandon the other seven.
    try {
      const r = await db.execute(sql`
        UPDATE roles
           SET products = ${textArray([j.slug])}, product = ${j.slug}, updated_at = now()
         WHERE department_id IN ${textIn(j.depts)}
           AND COALESCE(array_length(products, 1), 0) = 0
           AND (product IS NULL OR product = '')
        RETURNING id`);
      const n = rows(r).length;
      if (n) { perProduct[j.slug] = n; tagged += n; }
    } catch (e: any) {
      console.error('[role-products] backfill failed for ' + j.slug, e?.cause?.message || e?.message);
      throw e;
    }
  }
  return { tagged, perProduct, unmatchedVentures, untaggedProducts };
}

/**
 * Do the three runtime columns actually exist on this database?
 *
 * Read as its own question because "the venture page is empty" has two completely different causes
 * that look identical from outside — no tags, or no COLUMN to hold them — and the second one is
 * invisible: every reader of those columns sits behind a catch. This is what /admin/roles/diagnose
 * shows so an operator can tell which it is without a database client.
 */
export async function productColumnStatus(): Promise<{ present: string[]; missing: string[] }> {
  const want = ['product', 'products', 'openings'];
  try {
    const r = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
       WHERE table_name = 'roles'
         AND column_name IN ${textIn(want)}`);
    const present = rows(r).map((x: any) => String(x.column_name));
    return { present, missing: want.filter((c) => !present.includes(c)) };
  } catch (e: any) {
    console.error('[role-products] productColumnStatus', e?.cause?.message || e?.message);
    return { present: [], missing: want };
  }
}
