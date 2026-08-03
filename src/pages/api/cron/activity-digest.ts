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

// EXAMINED AND NOT CHANGED — NO CAPABILITY APPLIES (a shared secret is not a role), BUT THE FIRST
// LINE OF THIS FUNCTION FAILS OPEN AND THAT IS THE FINDING.
//
// With CRON_SECRET set, only a caller presenting it gets in. With it absent or empty, EVERYONE does:
// `if (!secret) return true`. /api/ has no structural gate, so nothing else stands in front of the
// URL. The comment beside it calls this "cron-only", which is true of intent and not of effect.
//
// The same arm exists in three more spellings — src/pages/api/cron/security-scan.ts:12 (an `if`
// condition), src/pages/api/cron/hei-refresh.ts:52 (an `if (secret) { ... }` wrapper) and
// src/pages/api/payments/reconcile.ts — while src/pages/api/aquintutor/league-settle.ts:19 and
// streak-nudge.ts get it right with `if (!secret) return false`. Four files disagreeing about the
// same rule should be decided ONCE, by a human, against the environment actually deployed.
//
// NOT flipped here for a specific reason: whether this is a hole or merely ugly depends entirely on
// whether CRON_SECRET is set in production, and this working copy may not read .env* files (see
// CLAUDE.md). Flipping it blind would either close a real hole or silently break the daily job. The
// change is one word once someone confirms the variable is set.
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
