// POST /api/admin/schedule — faculty/registrar set deadlines that populate student calendars, and
// run deadline reminders (Prompt 19). Gated by can(write, schedule). Audited via can().
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac';
import { setDeadline, runDeadlineReminders } from '@/lib/calendar';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  const g = await can(user, 'write', { type: 'schedule' });
  if (!g.allow) return j({ ok: false, error: 'not permitted (need write)', reason: g.reason }, 403);
  let b: any = {}; try { b = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  try {
    if (b.action === 'setDeadline') {
      if (!b.courseObjId || !b.title || !b.dueAt) return j({ ok: false, error: 'courseObjId + title + dueAt required' }, 400);
      const kind = ['assessment', 'exam', 'lesson'].includes(b.kind) ? b.kind : 'assessment';
      await setDeadline(String(b.courseObjId), String(b.title), kind, new Date(b.dueAt).toISOString(), user.id);
      return j({ ok: true });
    }
    if (b.action === 'runReminders') { const n = await runDeadlineReminders(Number(b.withinHours) || 48); return j({ ok: true, sent: n }); }
    return j({ ok: false, error: 'unknown action' }, 400);
  } catch (e: any) { return j({ ok: false, error: e?.cause?.message || e?.message || 'error' }, 200); }
};
