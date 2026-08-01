// GET/POST /api/cron/activity-digest — send the digest of everything too routine to interrupt for.
//
// The activity feed splits events two ways: anything critical pushes immediately, everything else
// is collected and summarised. The collecting half worked, but nothing ever sent the summary --
// flushDigest() was reachable only from a manual button on /admin/activity, so unless someone
// happened to open that page and press it, routine activity was recorded and never reported.
//
// That is the failure mode the digest exists to prevent: it is precisely the events nobody thought
// were worth an alert that you want to see collected at the end of the day.
//
// Protected by CRON_SECRET, same as every other job here.
import type { APIRoute } from 'astro';
import { flushDigest } from '@/lib/activity-feed';

export const prerender = false;

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' } });
}

function authed(request: Request, url: URL): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // cron-only path when no secret configured
  const auth = request.headers.get('authorization') || '';
  if (auth === 'Bearer ' + secret) return true;
  if (url.searchParams.get('secret') === secret) return true;
  return false;
}

export const GET: APIRoute = async ({ request, url }) => {
  if (!authed(request, url)) return json({ ok: false, error: 'unauthorized' }, 401);
  try {
    const r = await flushDigest();
    return json({ ok: true, ...r });
  } catch (e: any) {
    console.error('[cron/activity-digest]', e?.cause?.message || e?.message);
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
};

export const POST = GET;
