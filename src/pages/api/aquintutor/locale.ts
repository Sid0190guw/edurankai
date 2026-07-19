// POST /api/aquintutor/locale — switch the interface locale (Prompt AP3a). Sets a cookie for the
// immediate runtime switch and best-effort persists the choice to the signed-in user's settings
// (edu_student_settings.language, reused). Only supported locales are accepted.
import type { APIRoute } from 'astro';
import { supported } from '@/lib/i18n';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, cookies, locals }) => {
  let b: any = {}; try { b = await request.json(); } catch {}
  const locale = String(b.locale || 'en');
  if (!supported(locale)) return j({ ok: false, error: 'unsupported locale' }, 400);
  cookies.set('locale', locale, { path: '/', maxAge: 60 * 60 * 24 * 365, httpOnly: false, sameSite: 'lax' });
  const user = (locals as any)?.user;
  if (user) {
    try {
      const { getProfile, saveProfile } = await import('@/lib/student-settings');
      const p = await getProfile(user.id);
      await saveProfile(user.id, { ...p, language: locale });
    } catch { /* cookie is enough for the runtime switch */ }
  }
  return j({ ok: true, locale });
};
