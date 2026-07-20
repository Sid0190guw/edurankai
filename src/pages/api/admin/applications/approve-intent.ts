// POST /api/admin/applications/approve-intent
// Push a stuck applicant through: materialise their application_intent into a real
// applications row with the fee WAIVED (no payment taken). This is the admin lever
// for anyone parked at "Form complete - awaiting fee" — e.g. fee-exempt interns whose
// auto-waive failed, or a hardship approval. Uses the SAME materialisation path a real
// payment uses, so the resulting application row is identical. Idempotent: if an
// application already exists for that role + applicant, the existing id is returned.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { materialiseFromIntent, lastMaterialiseError } from '@/lib/fee-waiver';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
function rows(r: any) { return Array.isArray(r) ? r : (r?.rows || []); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user || user.role === 'applicant') return json({ ok: false, error: 'forbidden' }, 403);

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const intentId = String(body.intentId || '').trim();
  const reason = String(body.reason || 'Approved by admin - application fee waived.').slice(0, 300);
  if (!intentId) return json({ ok: false, error: 'intentId required' }, 400);

  try {
    const intent = rows(await db.execute(sql`SELECT id, email FROM application_intents WHERE id = ${intentId} LIMIT 1`))[0] as any;
    if (!intent) return json({ ok: false, error: 'No such pending application (it may already be approved).' }, 404);

    const appId = await materialiseFromIntent(intentId, { paid: false, waiverGranted: true, waiverReason: reason });
    if (!appId) {
      // Admins are trusted — show the REAL database reason so this is diagnosable
      // in one click instead of vanishing (that is what kept applicants stuck).
      const why = lastMaterialiseError();
      return json({ ok: false, error: why ? ('Could not create the application: ' + why) : 'Could not create the application (no reason recorded). See /admin/hardening.' });
    }

    // Audit who approved it (best effort — never block the approval).
    try {
      await db.execute(sql`ALTER TABLE applications ADD COLUMN IF NOT EXISTS fee_waiver_approved_by UUID`);
      await db.execute(sql`UPDATE applications SET fee_waiver_approved_by = ${user.id} WHERE id = ${appId}`);
    } catch (_) {}

    return json({ ok: true, applicationId: appId, email: intent.email || null });
  } catch (e: any) {
    try { const { trackError } = await import('@/lib/logger'); await trackError('admin.approve_intent_failed', e, { intentId, by: String(user.id) }); } catch (_) {}
    return json({ ok: false, error: 'Something went wrong. It has been logged for review.' });
  }
};
