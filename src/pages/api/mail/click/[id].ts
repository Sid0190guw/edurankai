// GET /api/mail/click/<messageId>?u=<encoded-url>
// Records a link click for campaign analytics, then 302-redirects to the target.
import type { APIRoute } from 'astro';
import { recordClick } from '@/lib/mail-advanced';

export const GET: APIRoute = async ({ params, url, request, clientAddress }) => {
  const id = (params.id as string) || '';
  let dest = url.searchParams.get('u') || '';
  try { dest = decodeURIComponent(dest); } catch (_) {}
  if (!/^https?:\/\//i.test(dest)) dest = 'https://edurankai.in';
  if (id) recordClick(id, dest, (clientAddress || '').toString(), request.headers.get('user-agent') || '').catch(() => {});
  return new Response(null, { status: 302, headers: { Location: dest, 'Cache-Control': 'no-store' } });
};
