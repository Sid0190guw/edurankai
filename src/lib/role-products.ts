// Product <-> Role linkage.
//
// Every venture page under /ecosystem/[slug] should surface ONLY the open roles
// that build that product, not a generic "any 6 roles" list. Roles carry a
// `product` column holding a product slug (e.g. 'aquintutor-ai', 'karate-support').
// A NULL/empty product means the role is cross-company / general and does not
// show on a specific product page.
//
// The column is added at runtime (ALTER ... IF NOT EXISTS), memoised via
// ensureOnce so it costs one DDL round-trip per server process rather than one
// per render — important for keeping Neon compute idle.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureOnce } from '@/lib/ensure-once';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

export function ensureRoleProductColumn(): Promise<void> {
  return ensureOnce('roles_product_col', async () => {
    await db.execute(sql`ALTER TABLE roles ADD COLUMN IF NOT EXISTS product VARCHAR(80)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS roles_product_idx ON roles (product)`);
  });
}

/** Open roles that build a given product, newest-first within sort order. */
export async function getRolesForProduct(productSlug: string, limit = 6): Promise<any[]> {
  if (!productSlug) return [];
  try {
    await ensureRoleProductColumn();
    const r = await db.execute(sql`
      SELECT slug, title, level, department_id
      FROM roles
      WHERE is_open = true AND product = ${productSlug}
      ORDER BY is_featured DESC, sort_order ASC, title ASC
      LIMIT ${limit}
    `);
    return rows(r);
  } catch (e: any) {
    console.error('[role-products] getRolesForProduct', e?.cause?.message || e?.message);
    return [];
  }
}

/** How many open roles are tagged to each product slug — for badges/counts. */
export async function getOpenRoleCountsByProduct(): Promise<Record<string, number>> {
  try {
    await ensureRoleProductColumn();
    const r = await db.execute(sql`
      SELECT product, COUNT(*)::int AS n
      FROM roles
      WHERE is_open = true AND product IS NOT NULL AND product <> ''
      GROUP BY product
    `);
    const out: Record<string, number> = {};
    for (const row of rows(r)) out[row.product] = Number(row.n) || 0;
    return out;
  } catch {
    return {};
  }
}

/** Persist a role's product tag (called from the admin role editor). */
export async function setRoleProduct(roleId: string, productSlug: string | null): Promise<void> {
  await ensureRoleProductColumn();
  const val = productSlug && productSlug.trim() ? productSlug.trim() : null;
  await db.execute(sql`UPDATE roles SET product = ${val} WHERE id = ${roleId}`);
}

/** Read a single role's current product tag (for prefilling the editor). */
export async function getRoleProduct(roleId: string): Promise<string> {
  try {
    await ensureRoleProductColumn();
    const r = await db.execute(sql`SELECT product FROM roles WHERE id = ${roleId} LIMIT 1`);
    return rows(r)[0]?.product || '';
  } catch {
    return '';
  }
}

/** Visible products (for the admin product dropdown). */
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
