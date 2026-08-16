// GET/POST /api/mail/campaign-cron — promote due campaigns and send a batch for each in flight.
//
// Protected by CRON_SECRET through src/lib/auth/cron-auth.ts, which FAILS CLOSED. With no secret
// configured this endpoint refuses and campaigns stop going out visibly (they stay `scheduled` on
// /admin/mail/campaigns) rather than the URL standing open to anyone who can guess it — an open
// version of this endpoint would let an anonymous caller drive the company's bulk mailer.
//
// BOUNDED WORK PER INVOCATION. A serverless function has a wall clock, so this drains a fixed number
// of campaigns and a fixed batch each, and leaves the rest for the next run. Both claims live in the
// database and stale ones are released, so a run killed halfway leaves nothing stranded.
//
// ON THIS DEPLOYMENT'S SCHEDULE. The Vercel Hobby plan runs crons once a day, so a campaign
// scheduled for 14:00 goes out at the next daily run unless somebody presses "Send now" on the
// campaign screen — which calls the same code path. That is a plan limit, not a design choice;
// docs/mail-campaigns.md says so, and moving to a paid plan is a one-line change in vercel.json.
import type { APIRoute } from 'astro';
import { cronAuth } from '@/lib/auth/cron-auth';
import { drainDueCampaigns } from '@/lib/mail-campaigns';
import { dbReason } from '@/lib/mail-contacts';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' } });
}

async function run(request: Request, url: URL): Promise<Response> {
  const auth = cronAuth(request, url);
  if (!auth.allowed) {
    return json({ ok: false, error: auth.reason === 'not-configured' ? 'CRON_SECRET is not set on this deployment.' : 'unauthorized' }, 401);
  }
  try {
    const batchSize = Math.min(200, Number(url.searchParams.get('batch')) || 50);
    const maxCampaigns = Math.min(20, Number(url.searchParams.get('campaigns')) || 5);
    const result = await drainDueCampaigns({ batchSize, maxCampaigns });
    // The errors array is part of a SUCCESSFUL response on purpose: a run that promoted nothing
    // because three campaigns failed preflight is not the same event as a quiet run, and a cron log
    // that cannot tell them apart is a cron log nobody reads.
    return json({ ok: true, ...result });
  } catch (e: any) {
    console.error('[api/mail/campaign-cron]', dbReason(e));
    return json({ ok: false, error: dbReason(e) }, 500);
  }
}

export const GET: APIRoute = ({ request, url }) => run(request, url);
export const POST: APIRoute = ({ request, url }) => run(request, url);
