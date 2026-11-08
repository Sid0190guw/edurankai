// SAMARTH analytics and cross-record search for /admin/samarth.
//
// Search runs in SQL over EVERY record of each kind the administrator may see (spec Part 14.6),
// never over the page that happens to be loaded. Each kind is a separate, bounded query, and a kind
// the caller may not see is not queried at all.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { rows, readSafely, num, str, iso, type Read } from '@/lib/samarth/store-core';
import { likePattern } from '@/lib/samarth/applications';
import { PURPOSE_FEE, PURPOSE_ENGAGEMENT } from '@/lib/samarth/payments';

export interface Overview {
  applicationsByStatus: Record<string, number>;
  applicationsByCategory: { key: string; n: number }[];
  applicationsByCountry: { key: string; n: number }[];
  applicationsByPathway: { key: string; n: number }[];
  officialByLevel: { key: string; n: number }[];
  engagementsByStatus: Record<string, number>;
  partnersByStatus: Record<string, number>;
  xByStatus: Record<string, number>;
  xByChannel: { key: string; n: number }[];
  /** Captured gateway payments, INR paise, split by purpose. Refunded payments are excluded. */
  gatewayPaise: { fee: number; engagement: number; refundedCount: number };
  /** Staff-recorded payments, in the currency they were priced in. */
  offline: { currency: string; feeMinor: number; count: number }[];
  last30: number;
}

const toMap = (r: any[]) => Object.fromEntries(r.map((x) => [str(x.k), num(x.n) || 0]));
const toList = (r: any[]) => r.map((x) => ({ key: str(x.k), n: num(x.n) || 0 }));

export async function overview(opts: { samarth: boolean; x: boolean }): Promise<Read<Overview>> {
  return readSafely('SAMARTH analytics', async () => {
    const empty = { rows: [] as any[] };
    const q = async (allowed: boolean, s: any) => (allowed ? rows(await db.execute(s)) : empty.rows);
    const appsByStatus = await q(opts.samarth, sql`SELECT status AS k, COUNT(*)::int AS n FROM samarth_applications WHERE archived = false GROUP BY status`);
    const appsByCat = await q(opts.samarth, sql`SELECT category AS k, COUNT(*)::int AS n FROM samarth_applications WHERE archived = false GROUP BY category ORDER BY n DESC`);
    const appsByCountry = await q(opts.samarth, sql`SELECT country AS k, COUNT(*)::int AS n FROM samarth_applications WHERE archived = false GROUP BY country ORDER BY n DESC LIMIT 15`);
    const appsByPath = await q(opts.samarth, sql`SELECT COALESCE(pathway, 'not yet chosen') AS k, COUNT(*)::int AS n FROM samarth_applications WHERE archived = false GROUP BY 1 ORDER BY n DESC`);
    const official = await q(opts.samarth, sql`SELECT official->>'level' AS k, COUNT(*)::int AS n FROM samarth_applications WHERE archived = false AND official IS NOT NULL GROUP BY 1 ORDER BY n DESC`);
    const engByStatus = await q(opts.samarth, sql`SELECT status AS k, COUNT(*)::int AS n FROM samarth_engagements GROUP BY status`);
    const partnersByStatus = await q(opts.samarth, sql`SELECT status AS k, COUNT(*)::int AS n FROM samarth_partners GROUP BY status`);
    const xByStatus = await q(opts.x, sql`SELECT status AS k, COUNT(*)::int AS n FROM samarth_x_candidates GROUP BY status`);
    const xByChannel = await q(opts.x, sql`SELECT channel AS k, COUNT(*)::int AS n FROM samarth_x_candidates GROUP BY channel`);
    const gateway = opts.samarth ? rows(await db.execute(sql`
      SELECT COALESCE(SUM(amount_paise) FILTER (WHERE purpose = ${PURPOSE_FEE} AND status = 'paid'), 0)::bigint AS fee,
             COALESCE(SUM(amount_paise) FILTER (WHERE purpose = ${PURPOSE_ENGAGEMENT} AND status = 'paid'), 0)::bigint AS eng,
             COUNT(*) FILTER (WHERE status IN ('refunded', 'partially_refunded'))::int AS refunded
        FROM payments WHERE purpose IN (${PURPOSE_FEE}, ${PURPOSE_ENGAGEMENT})`))[0] : null;
    const offline = await q(opts.samarth, sql`
      SELECT fee_currency AS currency, COALESCE(SUM(fee_total_minor), 0)::bigint AS minor, COUNT(*)::int AS n
        FROM samarth_applications WHERE payment_method = 'offline' AND paid_at IS NOT NULL GROUP BY fee_currency`);
    const last30 = opts.samarth ? num(rows(await db.execute(sql`SELECT COUNT(*)::int AS n FROM samarth_applications WHERE created_at > NOW() - INTERVAL '30 days'`))[0]?.n) || 0 : 0;
    return {
      applicationsByStatus: toMap(appsByStatus), applicationsByCategory: toList(appsByCat), applicationsByCountry: toList(appsByCountry),
      applicationsByPathway: toList(appsByPath), officialByLevel: toList(official), engagementsByStatus: toMap(engByStatus),
      partnersByStatus: toMap(partnersByStatus), xByStatus: toMap(xByStatus), xByChannel: toList(xByChannel),
      gatewayPaise: { fee: num(gateway?.fee) || 0, engagement: num(gateway?.eng) || 0, refundedCount: num(gateway?.refunded) || 0 },
      offline: offline.map((r) => ({ currency: str(r.currency), feeMinor: num(r.minor) || 0, count: num(r.n) || 0 })),
      last30,
    };
  });
}

export interface SearchHit { kind: 'application' | 'engagement' | 'partner' | 'x'; id: string; ref: string; title: string; detail: string; status: string; createdAt: string | null }

export async function searchAll(qRaw: string, opts: { samarth: boolean; x: boolean }): Promise<Read<SearchHit[]>> {
  const q = String(qRaw || '').trim().slice(0, 120);
  if (q.length < 2) return { ready: true, value: [] };
  const like = likePattern(q);
  return readSafely('search', async () => {
    const out: SearchHit[] = [];
    if (opts.samarth) {
      for (const r of rows(await db.execute(sql`
        SELECT id, ref, status, created_at, COALESCE(NULLIF(org_name, ''), contact_name) AS t, COALESCE(title, '') AS d FROM samarth_applications
         WHERE ref ILIKE ${like} OR contact_name ILIKE ${like} OR contact_email ILIKE ${like} OR org_name ILIKE ${like} OR title ILIKE ${like}
            OR summary ILIKE ${like} OR (official->>'department') ILIKE ${like} OR (official->>'jurisdiction') ILIKE ${like} OR payment_order_id ILIKE ${like}
         ORDER BY created_at DESC LIMIT 25`))) out.push({ kind: 'application', id: str(r.id), ref: str(r.ref), title: str(r.t), detail: str(r.d), status: str(r.status), createdAt: iso(r.created_at) });
      for (const r of rows(await db.execute(sql`
        SELECT id, ref, status, created_at, title AS t, kind AS d FROM samarth_engagements
         WHERE ref ILIKE ${like} OR title ILIKE ${like} OR scope ILIKE ${like} OR award_reference ILIKE ${like} OR payment_order_id ILIKE ${like}
         ORDER BY created_at DESC LIMIT 25`))) out.push({ kind: 'engagement', id: str(r.id), ref: str(r.ref), title: str(r.t), detail: str(r.d), status: str(r.status), createdAt: iso(r.created_at) });
      for (const r of rows(await db.execute(sql`
        SELECT id, ref, status, created_at, org_name AS t, contact_name AS d FROM samarth_partners
         WHERE ref ILIKE ${like} OR org_name ILIKE ${like} OR contact_name ILIKE ${like} OR contact_email ILIKE ${like} OR capabilities ILIKE ${like}
         ORDER BY created_at DESC LIMIT 25`))) out.push({ kind: 'partner', id: str(r.id), ref: str(r.ref), title: str(r.t), detail: str(r.d), status: str(r.status), createdAt: iso(r.created_at) });
    }
    if (opts.x) {
      for (const r of rows(await db.execute(sql`
        SELECT id, ref, status, created_at, name AS t, COALESCE(venture_name, '') AS d FROM samarth_x_candidates
         WHERE ref ILIKE ${like} OR name ILIKE ${like} OR email ILIKE ${like} OR venture_name ILIKE ${like} OR problem ILIKE ${like} OR source_event ILIKE ${like}
         ORDER BY created_at DESC LIMIT 25`))) out.push({ kind: 'x', id: str(r.id), ref: str(r.ref), title: str(r.t), detail: str(r.d), status: str(r.status), createdAt: iso(r.created_at) });
    }
    return out;
  });
}
