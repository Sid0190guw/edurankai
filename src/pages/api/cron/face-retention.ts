// GET /api/cron/face-retention — delete facial data that no longer has a purpose.
//
// Biometric data that is no longer needed for what it was collected for should not still be here to
// be asked about. The applicant who prompted this had to write an email asking for hers; the next
// person will not have to.
//
// Runs daily. Vercel Hobby crons are daily-only, which is the right cadence anyway: a retention rule
// measured in weeks and months gains nothing from running hourly, and a slow sweep is easier to stop
// if it turns out to be wrong.
//
// `?dry=1` counts without deleting, so the rule can be read against real data before it fires.
import type { APIRoute } from 'astro';
import { withCronRun } from '@/lib/observability-health';
import { isCronAuthorized } from '@/lib/auth/cron-auth';
import { runFaceRetention, previewFaceRetention } from '@/lib/auth/face-erasure';

export const prerender = false;

const json = (d: any, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  // A route that deletes biometric data must never be openable by a stranger with the URL.
  if (!isCronAuthorized(request, url)) return json({ ok: false, error: 'unauthorized' }, 401);

  const dry = url.searchParams.get('dry') === '1';
  if (dry) {
    const { candidates, error } = await previewFaceRetention();
    if (error) return json({ ok: false, error }, 500);
    return json({
      ok: true, dryRun: true, wouldDelete: candidates.length,
      // Reasons only, never the identities: a JSON dump of who is about to lose their biometric
      // enrolment is a list worth not producing.
      byReason: candidates.reduce((m: Record<string, number>, c) => {
        m[c.reason] = (m[c.reason] || 0) + 1; return m;
      }, {}),
    });
  }

  // The dry-run branch above deliberately records nothing: a preview is not a run, and counting it
  // as one would make the retention job look like it had executed when no data was deleted.
  return withCronRun('/api/cron/face-retention', async () => {
    const r = await runFaceRetention();
    if (!r.ok) {
      return {
        outcome: { status: 'failed' as const, errorMessage: String(r.error || 'face retention failed') },
        value: json({ ok: false, error: r.error }, 500),
      };
    }
    console.log('[cron/face-retention] considered', r.considered, 'deleted', r.deleted, 'failed', r.failed);
    return {
      outcome: {
        processed: Number(r.considered || 0),
        succeeded: Number(r.deleted || 0),
        failed: Number(r.failed || 0),
        detail: `deleted ${r.deleted} of ${r.considered} considered`,
      },
      value: json({ ok: true, considered: r.considered, deleted: r.deleted, failed: r.failed }),
    };
  });
};
