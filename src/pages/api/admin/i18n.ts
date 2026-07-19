// POST /api/admin/i18n — translation-string management (Prompt AP3b). A content manager adds/edits a
// locale string; it merges over the static base at runtime (loadStrings), raising coverage without a
// code change. Admin-gated + audited via can().
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { setStringOverride, supported } from '@/lib/i18n';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  const gate = await can(user, 'write', { type: 'content' });
  if (!gate.allow) return j({ ok: false, error: 'not allowed' }, 403);
  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  const locale = String(b.locale || ''), key = String(b.key || '').trim(), value = String(b.value || '');
  if (!supported(locale)) return j({ ok: false, error: 'unsupported locale' }, 400);
  if (!key || !value) return j({ ok: false, error: 'key + value required' }, 400);
  try { await setStringOverride(locale, key, value, String(user.id)); return j({ ok: true }); }
  catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'error' }, 200); }
};
