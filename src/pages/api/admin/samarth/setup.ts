// POST /api/admin/samarth/setup   (form: next)
// Creates the SAMARTH tables on an operator's explicit request, then reports which exist. Same
// permission as "Create module tables" on /admin/setup (settings.edit), plus the SAMARTH desk itself.
import type { APIRoute } from 'astro';
import { can, canAccessSection } from '@/lib/auth/permissions';
import { createSamarthTables, SAMARTH_TABLES } from '@/lib/samarth/schema';
import { logAudit } from '@/lib/audit';

export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const user = (locals as any).user;
  if (!user) return redirect('/admin/login');
  let next = '/admin/samarth';
  try {
    const fd = await request.formData();
    const n = String(fd.get('next') || '');
    if (/^\/admin\/samarth(\/[a-z0-9/_-]*)?$/i.test(n)) next = n;
  } catch { /* default destination */ }
  const back = (key: 'msg' | 'err', text: string) => redirect(next + (next.includes('?') ? '&' : '?') + key + '=' + encodeURIComponent(text.slice(0, 500)));

  const allowed = (user.role === 'super_admin' || can(user, 'settings.edit')) && await canAccessSection(user, 'samarth', 'edit');
  if (!allowed) return back('err', 'Setting up SAMARTH needs the platform settings permission and the SAMARTH desk.');

  const status = await createSamarthTables();
  await logAudit({ userId: user.id, action: 'samarth.setup', entity: 'samarth_schema', diff: { ready: status.ready, missing: status.missing, error: status.error || null } });
  if (status.ready) return back('msg', 'SAMARTH is set up: all ' + SAMARTH_TABLES.length + ' tables exist. Next, set the booking fees.');
  return back('err', 'SAMARTH could not be fully set up. Still missing: ' + status.missing.join(', ') + (status.error ? '. Reason: ' + status.error : '') + '. You can also run db/samarth-schema.sql in the database SQL editor.');
};
