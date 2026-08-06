// POST /api/2fa/passkey/delete  { id }  — remove one of the signed-in user's passkeys.
import type { APIRoute } from 'astro';
import { deletePasskey } from '@/lib/auth/webauthn';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'Sign in first' }, 401);
  let id = '';
  try { id = ((await request.json())?.id || '').toString(); } catch { return json({ ok: false, error: 'Bad request' }, 400); }
  if (!id) return json({ ok: false, error: 'Missing id' }, 400);
  try { await deletePasskey(user.id, id); return json({ ok: true }); }
  catch (e: any) {
    // e.message is only the SQL that failed and e.cause is the database's own words; neither is for
    // the caller. Logged here so a failed removal is findable rather than silent.
    console.error('[api/2fa/passkey/delete]', e?.cause?.message || e?.message, e?.stack);
    return json({ ok: false, error: 'Could not remove that passkey. Please try again.' }, 500);
  }
};
