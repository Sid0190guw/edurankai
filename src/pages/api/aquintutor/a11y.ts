// POST /api/aquintutor/a11y — save accessibility preferences (Prompt AP4b). Persists to the existing
// edu_student_settings.accessibility model AND sets the `a11y` cookie (body classes) so the layout
// applies high-contrast / larger-text / no-motion immediately. Reduced-motion also flows to the
// animation engine (AP4a). Signed-in users only.
import type { APIRoute } from 'astro';
import { bodyA11yClasses, clampTextScale } from '@/lib/a11y';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, cookies, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  const prefs = { reduceMotion: !!b.reduceMotion, highContrast: !!b.highContrast, screenReader: !!b.screenReader, textScale: clampTextScale(b.textScale) };
  cookies.set('a11y', bodyA11yClasses(prefs), { path: '/', maxAge: 60 * 60 * 24 * 365, httpOnly: false, sameSite: 'lax' });
  try {
    const { getProfile, saveProfile } = await import('@/lib/student-settings');
    const p = await getProfile(user.id);
    await saveProfile(user.id, { ...p, accessibility: { ...(p.accessibility || {}), ...prefs } });
  } catch { /* cookie already applies it this session */ }
  return j({ ok: true, classes: bodyA11yClasses(prefs) });
};
