// GET /api/mail/contact-context?email=... — who the person you are reading actually is.
//
// Called by the reading pane when a conversation opens. Separate from the conversation payload on
// purpose: the messages should render immediately, and a contact card that needs four more lookups
// must not hold them up. If this request fails, the conversation is still on screen.
//
// WHAT IT WILL AND WILL NOT SAY is decided in src/lib/mail-context.ts, per field, and the response
// carries `withheld` — the list of things this viewer was not shown and why. A panel that silently
// omits half of itself teaches people the data does not exist.
import type { APIRoute } from 'astro';
import { denyMailApi } from '@/lib/auth/mail-access';
import { ensureMailSchema } from '@/lib/mail';
import { contactContext, contextLine } from '@/lib/mail-context';

// Declared above the handler that reads them — `const` is not hoisted.
const json = (d: any, s = 200) => new Response(JSON.stringify(d), {
  status: s,
  headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' },
});
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await denyMailApi(locals, { label: 'mail.contact-context' });
  if (denied) return denied;
  const user = (locals as any).user;

  const email = String(new URL(request.url).searchParams.get('email') || '');
  if (!email) return json({ ok: false, error: 'email required' }, 400);

  try {
    await ensureMailSchema();
    const ctx = await contactContext(user, email);
    return json({ ok: true, context: ctx, line: contextLine(ctx) });
  } catch (e: any) {
    console.error('[api/mail/contact-context] failed:', reasonOf(e));
    return json({ ok: false, error: 'That could not be looked up: ' + reasonOf(e) }, 500);
  }
};
