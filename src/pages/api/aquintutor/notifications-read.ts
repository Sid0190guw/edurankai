// POST /api/aquintutor/notifications-read — mark the signed-in user's notifications read (Prompt 18).
import type { APIRoute } from 'astro';
import { markAllRead } from '@/lib/edu-notify';
export const POST: APIRoute = async ({ locals }) => {
  const user = (locals as any)?.user;
  if (!user?.id) return new Response(JSON.stringify({ ok: false }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  try { await markAllRead(user.id); } catch {}
  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
};
