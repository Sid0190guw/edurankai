// POST /api/portal/onboarding/documents — a new hire submits / withdraws their credential links,
// and HR reviews them. The hire may only touch their OWN documents; verify/reject requires HR
// (admin surface, non-applicant). All server-side: the cap and the Drive-link format are enforced
// here, not just in the browser.
import type { APIRoute } from 'astro';
import { addDoc, removeDoc, reviewDoc, listDocs } from '@/lib/hr-onboarding';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'Please sign in.' }, 401);
  let b: any = {}; try { b = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const uid = String(user.id);

  try {
    if (b.action === 'add') {
      const r = await addDoc(uid, { docType: String(b.docType || 'other'), title: String(b.title || ''), driveUrl: String(b.driveUrl || '') });
      if (!r.ok) return json({ ok: false, error: r.error });
      return json({ ok: true, id: r.id, docs: await listDocs(uid) });
    }
    if (b.action === 'remove') {
      const done = await removeDoc(uid, Number(b.id));
      if (!done) return json({ ok: false, error: 'That document is already verified and can no longer be removed.' });
      return json({ ok: true, docs: await listDocs(uid) });
    }
    if (b.action === 'review') {
      // HR ONLY. Must be the same 'employees' section permission that gates /admin/hr — a bare
      // `role !== 'applicant'` check was a privilege escalation: roles the middleware bans from
      // /admin entirely (partner, teacher, technical_moderator) could still verify or reject any
      // hire's credential by POSTing here, and ids are sequential so enumeration was trivial.
      const { userCanAccess } = await import('@/lib/auth/permissions');
      const allowed = await userCanAccess(String(user.id), 'employees', 'edit').catch(() => false);
      if (!allowed) return json({ ok: false, error: 'Not allowed.' }, 403);
      const status = b.status === 'verified' ? 'verified' : b.status === 'rejected' ? 'rejected' : 'submitted';
      await reviewDoc(Number(b.id), status as any, uid, b.note ? String(b.note).slice(0, 300) : undefined);
      return json({ ok: true });
    }
    return json({ ok: false, error: 'unknown action' }, 400);
  } catch (e: any) {
    try { const { trackError } = await import('@/lib/logger'); await trackError('onboarding.documents_failed', e, { uid, action: b?.action }); } catch (_) {}
    return json({ ok: false, error: 'Something went wrong. Please try again.' });
  }
};
