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
import { isCronAuthorized } from '@/lib/auth/cron-auth';

export const prerender = false;

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' } });
}

// THE GUARD USED TO FAIL OPEN, IN ITS FIRST LINE: `if (!secret) return true`. With CRON_SECRET set,
// only a caller presenting it got in; with it absent or empty, EVERYONE did. /api/ has no structural
// gate (src/middleware.ts isExempt() returns true for it), so nothing else stood in front of the URL
// and the comment calling it "cron-only" was true of intent, not of effect.
//
// The same rule now lives in ONE place — src/lib/auth/cron-auth.ts — and fails CLOSED: no secret
// configured means no caller is authorised, including the cron. A digest that stops arriving is
// visible and costs a redeploy; an endpoint anybody can call is not.
export const GET: APIRoute = async ({ request, url }) => {
  if (!isCronAuthorized(request, url)) return json({ ok: false, error: 'unauthorized' }, 401);
  try {
    const r = await flushDigest();
    return json({ ok: true, ...r });
  } catch (e: any) {
    console.error('[cron/activity-digest]', e?.cause?.message || e?.message);
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
};

export const POST = GET;
