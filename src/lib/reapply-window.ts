// src/lib/reapply-window.ts — the one consequence of declining an offer.
//
// Declining used to deactivate the candidate's account, which signed them out and took their
// application record, their offer letter and their own access history with it. That is a permanent
// penalty on the entire relationship for turning down a single role, and turning down a job is not
// misconduct.
//
// The consequence is now narrow and temporary: for ONE MONTH they cannot reapply to the SAME role.
// Everything else stays open — their account, their records, and every other role we advertise.
//
// Enforced at application time rather than by removing access, so the block is checked at the
// moment it actually matters and expires on its own without anyone having to remember to lift it.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));

/** How long a declined role stays closed to the same candidate. */
export const REAPPLY_BLOCK_DAYS = 30;

export interface ReapplyBlock {
  blocked: boolean;
  roleTitle?: string | null;
  until?: Date | null;
  message?: string;
}

/**
 * May this user apply for this role right now?
 *
 * Returns blocked:false on ANY error. A transient database problem must not stop someone applying
 * for a job — the cost of wrongly turning an applicant away is far higher than the cost of letting
 * one early reapplication through.
 */
export async function checkReapplyBlock(userId: string, roleId: string): Promise<ReapplyBlock> {
  if (!userId || !roleId) return { blocked: false };
  try {
    const r = await db.execute(sql`
      SELECT o.declined_at, a.role_title_snapshot
        FROM offer_letters o
        JOIN applications a ON a.id = o.application_id
       WHERE a.applicant_user_id = ${userId}
         AND a.role_id = ${roleId}
         AND o.status = 'declined'
         AND o.declined_at IS NOT NULL
         AND o.declined_at > NOW() - (${REAPPLY_BLOCK_DAYS} || ' days')::interval
       ORDER BY o.declined_at DESC
       LIMIT 1`);

    const hit = rows(r)[0];
    if (!hit) return { blocked: false };

    const until = new Date(new Date(hit.declined_at).getTime() + REAPPLY_BLOCK_DAYS * 86400000);
    const when = until.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

    return {
      blocked: true,
      roleTitle: hit.role_title_snapshot || null,
      until,
      // Says which role, when it reopens, and that everything else is still available — so the
      // person knows this is one closed door and not a closed account.
      message: `You declined an offer for this role recently, so it is closed to you until ${when}. Every other open role is still available to you in the meantime.`,
    };
  } catch (e: any) {
    console.error('[reapply-window]', e?.cause?.message || e?.message);
    return { blocked: false };
  }
}
