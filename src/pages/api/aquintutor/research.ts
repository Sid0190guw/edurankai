// Research workspace API (postgraduate tier).
//   GET  /api/aquintutor/research           -> { refs, steps }
//   POST /api/aquintutor/research { action } -> add | update | status | delete | step
import type { APIRoute } from 'astro';
import { listRefs, addRef, updateRef, setRefStatus, deleteRef, getThesisSteps, setThesisStep, REF_STATUSES } from '@/lib/aquintutor-research';

function json(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const GET: APIRoute = async ({ locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'Sign in first' }, 401);
  try {
    const [refs, steps] = await Promise.all([listRefs(user.id), getThesisSteps(user.id)]);
    return json({ ok: true, refs, steps });
  } catch (e: any) { return json({ ok: false, error: e?.cause?.message || e?.message || 'failed' }, 500); }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ ok: false, error: 'Sign in first' }, 401);
  let b: any = {};
  try { b = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  try {
    if (b.action === 'add') {
      const id = await addRef(user.id, b.ref || {});
      if (!id) return json({ ok: false, error: 'title required' }, 400);
      return json({ ok: true, id });
    }
    if (b.action === 'update') {
      if (!b.id) return json({ ok: false, error: 'id required' }, 400);
      await updateRef(user.id, String(b.id), b.ref || {});
      return json({ ok: true });
    }
    if (b.action === 'status') {
      if (!b.id || !REF_STATUSES.includes(b.status)) return json({ ok: false, error: 'id + valid status required' }, 400);
      await setRefStatus(user.id, String(b.id), b.status);
      return json({ ok: true });
    }
    if (b.action === 'delete') {
      if (!b.id) return json({ ok: false, error: 'id required' }, 400);
      await deleteRef(user.id, String(b.id));
      return json({ ok: true });
    }
    if (b.action === 'step') {
      if (!b.key) return json({ ok: false, error: 'key required' }, 400);
      await setThesisStep(user.id, String(b.key), !!b.done);
      return json({ ok: true });
    }
    return json({ ok: false, error: 'unknown action' }, 400);
  } catch (e: any) { return json({ ok: false, error: e?.cause?.message || e?.message || 'failed' }, 500); }
};
