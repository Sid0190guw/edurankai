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
import { departmentsForProduct, productMatchClause, productTagClause, PRODUCT_DOMAINS } from '@/lib/product-domains';

// Re-exported so a page importing the linkage does not have to know which of the two modules the
// predicate happens to live in.
export { productMatchClause, productTagClause };

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

/**
 * Open roles that build a given product: explicitly tagged, or in one of the departments that
 * build it. Tagged roles sort first, so a deliberate hand-tag always leads the list.
 */
export async function getRolesForProduct(productSlug: string, limit = 6): Promise<any[]> {
  if (!productSlug) return [];
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
      WHERE roles.is_open = true
        AND ${productMatchClause(productSlug, true)}
      ORDER BY tagged DESC, roles.is_featured DESC, roles.sort_order ASC, roles.title ASC
      LIMIT ${limit}
    `);
    return rows(r);
  } catch (e: any) {
    console.error('[role-products] getRolesForProduct', e?.cause?.message || e?.message);
    // The tag columns are the only part of that statement a database can be missing. Ask the
    // department question on its own rather than reporting "nothing is open", which is the exact
    // false claim this whole change exists to remove.
    if (!depts.length) return [];
    try {
      const r2 = await db.execute(sql`
        SELECT roles.slug, roles.title, roles.level, roles.department_id,
               COALESCE(d.name, roles.department_id) AS department_name,
               0 AS openings, false AS tagged
        FROM roles
        LEFT JOIN departments d ON d.id = roles.department_id
        WHERE roles.is_open = true
          AND roles.department_id IN ${textIn(depts)}
        ORDER BY roles.is_featured DESC, roles.sort_order ASC, roles.title ASC
        LIMIT ${limit}
      `);
      console.error('[role-products] retried getRolesForProduct without the tag columns and succeeded');
      return rows(r2);
    } catch (e2: any) {
      console.error('[role-products] narrowed getRolesForProduct also failed', e2?.cause?.message || e2?.message);
      return [];
    }
  }
}

/**
 * The teams hiring for a venture, with a count each, and the honest total across them.
 *
 * ONE round trip for both numbers: the venture page needs the total ("39 open roles") and the
 * per-team split in the same render, and grouping gives both.
 *
 * WHY THE PAGE NEEDS THIS AT ALL. `/careers?product=<slug>` was the "see all of them" link, and
 * the careers rewrite of 2026-08-24 dropped that parameter — the page and /api/careers/search now
 * read `q`, `dept`, `division`, `level`, `type`, `classification`, `band`, `skill` and `domain`,
 * and nothing else. A link carrying a parameter nobody reads shows the whole catalogue while
 * claiming to show one venture's roles, so the venture page links per TEAM instead, at
 * /careers/department/<id>, which is a route that filters.
 */
export async function getProductTeamBreakdown(
  productSlug: string
): Promise<{ total: number; teams: Array<{ id: string; name: string; openCount: number }> }> {
  const empty = { total: 0, teams: [] as Array<{ id: string; name: string; openCount: number }> };
  if (!productSlug) return empty;
  const depts = departmentsForProduct(productSlug);

  const run = async (includeTags: boolean) => {
    const r = await db.execute(sql`
      SELECT roles.department_id AS id,
             COALESCE(d.name, roles.department_id) AS name,
             COUNT(*)::int AS n
      FROM roles
      LEFT JOIN departments d ON d.id = roles.department_id
      WHERE roles.is_open = true
        AND ${productMatchClause(productSlug, includeTags)}
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
    return await run(true);
  } catch (e: any) {
    console.error('[role-products] getProductTeamBreakdown', e?.cause?.message || e?.message);
    if (!depts.length) return empty;
    try {
      const out = await run(false);
      console.error('[role-products] retried getProductTeamBreakdown without the tag columns and succeeded');
      return out;
    } catch (e2: any) {
      console.error('[role-products] narrowed getProductTeamBreakdown also failed', e2?.cause?.message || e2?.message);
      return empty;
    }
  }
}

/**
 * Open-role count per product slug — tagged ∪ domain, deduplicated.
 *
 * Two grouped reads rather than one join against a VALUES list of the mapping: the tag pairs are
 * counted in SQL and the department totals are counted in SQL, and the OVERLAP (a role both tagged
 * to a venture and sitting in one of its departments) is subtracted in JS from the pair rows. Naive
 * addition would double-count exactly those roles and quietly inflate every card on /ecosystem.
 */
export async function getOpenRoleCountsByProduct(productSlugs?: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  // KEYED BY THE CALLER'S OWN SLUGS, not by the canonical ones in PRODUCT_DOMAINS.
  //
  // `products.slug` and the canonical key are not always the same string — AquinTutor has shipped
  // as both `aquintutor` and `aquintutor-ai`, and .dev-scripts/fix-aquintutor-link.cjs exists
  // because of it. Returning canonical keys would hand /ecosystem a map whose keys miss its own
  // rows, and every card would silently read zero: the same empty answer in a new place.
  const wanted = productSlugs && productSlugs.length
    ? Array.from(new Set(productSlugs.filter(Boolean)))
    : PRODUCT_DOMAINS.map((p) => p.slug);

  // Department totals first: this read touches no runtime column, so it is the one that survives a
  // database where the ALTER never ran.
  const perDept: Record<string, number> = {};
  try {
    const d = await db.execute(sql`
      SELECT department_id, COUNT(*)::int AS n
      FROM roles
      WHERE is_open = true AND department_id IS NOT NULL
      GROUP BY department_id
    `);
    for (const row of rows(d)) perDept[String(row.department_id)] = Number(row.n) || 0;
  } catch (e: any) {
    console.error('[role-products] department counts failed', e?.cause?.message || e?.message);
  }
  for (const slug of wanted) {
    // departmentsForProduct() resolves the alias, so a DB slug of `aquintutor-ai` still finds the
    // `aquintutor` mapping and its departments.
    const n = departmentsForProduct(slug).reduce((acc, id) => acc + (perDept[id] || 0), 0);
    if (n) out[slug] = n;
  }

  // Then the tags. One row per (open tagged role, product) — two rows today, bounded by the
  // catalogue even if every role were tagged.
  try {
    await ensureRoleProductColumn();
    const r = await db.execute(sql`
      SELECT prod AS product, department_id
      FROM roles
      CROSS JOIN LATERAL unnest(
        COALESCE(NULLIF(products, '{}'),
                 CASE WHEN product IS NOT NULL AND product <> '' THEN ARRAY[product] ELSE ARRAY[]::text[] END)
      ) AS prod
      WHERE is_open = true
    `);
    for (const row of rows(r)) {
      const slug = String(row.product || '');
      if (!slug) continue;
      // Already counted through its department? Then the tag adds nothing to the total.
      if (departmentsForProduct(slug).includes(String(row.department_id))) continue;
      out[slug] = (out[slug] || 0) + 1;
    }
  } catch (e: any) {
    console.error('[role-products] tag counts unavailable, showing domain counts only', e?.cause?.message || e?.message);
  }
  return out;
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
