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
// keeping Neon compute idle.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const clean = (slugs: string[]): string[] =>
  Array.from(new Set((slugs || []).map((s) => (s || '').trim()).filter(Boolean)));

export function ensureRoleProductColumn(): Promise<void> {
  return ensureOnce('roles_product_cols_v2', async () => {
    await db.execute(sql`ALTER TABLE roles ADD COLUMN IF NOT EXISTS product VARCHAR(80)`);
    await db.execute(sql`ALTER TABLE roles ADD COLUMN IF NOT EXISTS products TEXT[]`);
    await db.execute(sql`ALTER TABLE roles ADD COLUMN IF NOT EXISTS openings INT`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS roles_product_idx ON roles (product)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS roles_products_gin ON roles USING GIN (products)`);
  });
}

/** Open roles that build a given product (matches the array OR legacy single). */
export async function getRolesForProduct(productSlug: string, limit = 6): Promise<any[]> {
  if (!productSlug) return [];
  try {
    await ensureRoleProductColumn();
    const r = await db.execute(sql`
      SELECT slug, title, level, department_id, COALESCE(openings, 0) AS openings
      FROM roles
      WHERE is_open = true
        AND (${productSlug} = ANY(products) OR product = ${productSlug})
      ORDER BY is_featured DESC, sort_order ASC, title ASC
      LIMIT ${limit}
    `);
    return rows(r);
  } catch (e: any) {
    console.error('[role-products] getRolesForProduct', e?.cause?.message || e?.message);
    return [];
  }
}

/** Open-role count per product slug (counts each product a role is tagged to). */
export async function getOpenRoleCountsByProduct(): Promise<Record<string, number>> {
  try {
    await ensureRoleProductColumn();
    const r = await db.execute(sql`
      SELECT prod AS product, COUNT(*)::int AS n
      FROM roles
      CROSS JOIN LATERAL unnest(
        COALESCE(NULLIF(products, '{}'),
                 CASE WHEN product IS NOT NULL AND product <> '' THEN ARRAY[product] ELSE ARRAY[]::text[] END)
      ) AS prod
      WHERE is_open = true
      GROUP BY prod
    `);
    const out: Record<string, number> = {};
    for (const row of rows(r)) out[row.product] = Number(row.n) || 0;
    return out;
  } catch {
    return {};
  }
}

/** Persist a role's product tags (array) — keeps legacy `product` = first slug. */
export async function setRoleProducts(roleId: string, slugs: string[]): Promise<void> {
  await ensureRoleProductColumn();
  const list = clean(slugs);
  await db.execute(sql`
    UPDATE roles SET products = ${list}::text[], product = ${list[0] || null}
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
