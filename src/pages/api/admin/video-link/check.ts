// POST /api/admin/video-link/check — "is this link one we can play, and what is it?"
//
// The live check behind the video field on the lesson forms. It answers with the SAME function the
// save handler uses (src/lib/video-embed.ts), so what the author is told before saving and what the
// server does on save can never drift apart — a check that used its own looser rules would be worse
// than no check, because it would promise a playable lesson and then refuse it.
//
// It reads nothing and writes nothing: the whole response is a pure function of the string the
// caller sent. That is why it carries canOpenAdmin() and no section key — the two forms that use it
// sit in different sections ('training' at /admin/hr/training, 'lms' at /admin/courses), so pinning
// one section here would lock the other form's authors out of a check on their own typing. The
// SAVE handlers keep their own section gates; this endpoint never saves anything.
import type { APIRoute } from 'astro';
import { denyAdminApi } from '@/lib/auth/api-guard';
import { resolveVideoLink, describeVideoLink } from '@/lib/video-embed';

// Declared before the handler — `const` is not hoisted.
const json = (d: any, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' } });

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await denyAdminApi(locals, { label: 'video-link.check' });
  if (denied) return denied;

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const url = typeof body?.url === 'string' ? body.url : '';
  const allowLinkOut = body?.allowLinkOut === true;

  const r = resolveVideoLink(url, { allowLinkOut });

  if (!r.ok) {
    return json({
      ok: true,
      recognised: false,
      // A sentence, not a code. The form prints this verbatim.
      message: r.reason,
      canLinkOut: r.canLinkOut,
    });
  }

  // `provider` is deliberately NOT in this response. It is an internal enum and the browser has no
  // use for it that would not end up on a screen.
  return json({
    ok: true,
    recognised: true,
    kind: r.kind,
    message: describeVideoLink(r),
    // Returned so the form can show a real preview of what a learner will get. It is a URL this
    // module built itself, never the caller's string.
    embedUrl: r.embedUrl,
  });
};
