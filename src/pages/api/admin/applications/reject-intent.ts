// POST /api/admin/applications/reject-intent
// The counterpart to approve-intent. An applicant who completed the form but was never
// materialised into an `applications` row has, until now, had exactly one admin action
// available: approve. So the only way to clear someone who should not proceed was to
// create their application first and reject it afterwards — which manufactures a real
// application record for a person nobody intended to advance, and leaves the intents
// list growing forever with people no one will ever action.
//
// This closes the decision WITHOUT creating an application. It never materialises, never
// touches money, and never emails: it records the decision against the intent so the
// person leaves the queue and the reason survives for whoever asks later.
//
// DELIBERATELY REVERSIBLE. Rejecting only stamps status columns; the intent row and every
// field the applicant filled stay exactly where they are. Undo is a status flip, and
// approve-intent still works on a rejected row — a rejection is a decision, not a deletion.
import type { APIRoute } from 'astro';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { denyAdminApi } from '@/lib/auth/api-guard';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
}
// postgres-js resolves to a plain array, never a { rows } object.
function rows(r: any) { return Array.isArray(r) ? r : (r?.rows || []); }

// Self-bootstrapping, because this project has no migration runner: the columns are added
// on first use and the guard is process-local so it costs one statement per boot, not one
// per request. Declared ABOVE the handler — `const` is not hoisted, and a handler reaching
// a later declaration has taken pages down on this project before.
let ready: Promise<void> | null = null;
function ensureIntentDecisionColumns(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    try {
      await db.execute(sql`ALTER TABLE application_intents ADD COLUMN IF NOT EXISTS status TEXT`);
      await db.execute(sql`ALTER TABLE application_intents ADD COLUMN IF NOT EXISTS decided_by UUID`);
      await db.execute(sql`ALTER TABLE application_intents ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ`);
      await db.execute(sql`ALTER TABLE application_intents ADD COLUMN IF NOT EXISTS decision_note TEXT`);
    } catch (e: any) {
      // Retry on the next call rather than caching a failed bootstrap forever.
      ready = null;
      console.error('[reject-intent] column bootstrap', e?.cause?.message || e?.message);
    }
  })();
  return ready;
}

export const POST: APIRoute = async ({ request, locals }) => {
  // Same gate as approve-intent: deciding an intent either way is `applications` edit, and
  // that is the section guarding /admin/applications/intents, the only page that calls this.
  // Asked through the section resolver rather than a role name, so a custom role holding
  // applications keeps working and an unknown role is denied.
  const denied = await denyAdminApi(locals, { section: 'applications', action: 'edit', label: 'applications.reject-intent' });
  if (denied) return denied;
  const user = (locals as any)?.user;

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const intentId = String(body.intentId || '').trim();
  const note = String(body.note || '').trim().slice(0, 300);
  if (!intentId) return json({ ok: false, error: 'intentId required' }, 400);

  try {
    await ensureIntentDecisionColumns();

    const intent = rows(await db.execute(
      sql`SELECT id, email, status FROM application_intents WHERE id = ${intentId} LIMIT 1`
    ))[0] as any;
    if (!intent) return json({ ok: false, error: 'No such pending application (it may already be actioned).' }, 404);
    if (String(intent.status || '').toLowerCase() === 'rejected') {
      // Idempotent: a double-click is not an error.
      return json({ ok: true, alreadyRejected: true, email: intent.email || null });
    }

    await db.execute(sql`
      UPDATE application_intents
         SET status = 'rejected',
             decided_by = ${user?.id ? String(user.id) : null},
             decided_at = NOW(),
             decision_note = ${note || null}
       WHERE id = ${intentId}`);

    // Audit is best effort and must never block the decision, but the real Postgres reason
    // is logged rather than swallowed — a silently failing audit is how an unexplained
    // rejection becomes unanswerable six months later.
    try {
      const { logAudit } = await import('@/lib/audit');
      await logAudit({
        userId: String(user?.id || ''),
        action: 'applications.intent.rejected',
        entity: 'application_intents',
        entityId: intentId,
        diff: { email: intent.email || null, note: note || null },
      });
    } catch (e: any) {
      console.error('[reject-intent] audit', e?.cause?.message || e?.message);
    }

    return json({ ok: true, email: intent.email || null });
  } catch (e: any) {
    const why = e?.cause?.message || e?.message;
    console.error('[reject-intent]', why);
    return json({ ok: false, error: 'Could not record the decision: ' + (why || 'unknown error') }, 500);
  }
};
