// POST /api/admin/governance/retention — the two writes on /admin/governance/retention.
//
// THIS ENDPOINT DID NOT EXIST. The page was complete — the policy table, the per-class edit row, the
// dry run, the confirm on the sweep — and every one of its forms posted here, to a 404. So the
// retention screen rendered a working control surface in which nothing a person did had any effect,
// and the only feedback was a browser error page. `applyRetention` and `setRetentionPolicy` were
// already written, exported and tested in src/lib/horizon/governance; only the seam between the form
// and them was missing.
//
// PERMISSION IS CHECKED HERE, not only on the page that drew the button. A rendered form is not an
// authorisation: this route can be posted to directly, by anybody with a session, whatever the page
// chose to draw. The check is the same key the page reads (`horizon.retention.manage`) so the two
// cannot disagree about who may do this.
//
// THE SWEEP IS THE DESTRUCTIVE ONE. The page's dry run is a GET-time read and stays there; this
// route runs `applyRetention` for real, and it is reachable only through the form that carries a
// confirm. It reports what it touched rather than saying "done", because a sweep that reports
// nothing is indistinguishable from a sweep that did nothing.
import type { APIRoute } from 'astro';
import {
  applyRetention, governancePermissions, holdsGovernancePermission, setRetentionPolicy,
} from '@/lib/horizon/governance';

export const prerender = false;

const PAGE = '/admin/governance/retention';

/** Back to the page that posted, carrying one sentence it already knows how to render. */
function back(kind: 'done' | 'error', text: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: PAGE + '?' + kind + '=' + encodeURIComponent(text.slice(0, 400)) },
  });
}

export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const user = (locals as any)?.user;
  if (!user?.id) return redirect('/admin/login?next=' + encodeURIComponent(PAGE));

  const held = await governancePermissions(user.id, locals);
  if (!holdsGovernancePermission(held.permissions, 'horizon.retention.manage')) {
    return back('error', 'You do not hold horizon.retention.manage, so nothing was changed.');
  }
  // `degraded` means the permission resolver fell back rather than answering. Reading a page under a
  // degraded answer shows less than it should; WRITING under one would act on a guess about who the
  // person is. The write is refused and says so.
  if (held.degraded) {
    return back('error', 'Your permissions could not be resolved just now, so nothing was changed. Try again.');
  }

  let fd: FormData;
  try {
    fd = await request.formData();
  } catch {
    return back('error', 'That form could not be read. Nothing was changed.');
  }

  const actor = {
    id: String(user.id),
    email: user.email ?? null,
    name: user.name ?? null,
    ip: request.headers.get('x-forwarded-for') || null,
    userAgent: request.headers.get('user-agent') || null,
  };
  const action = String(fd.get('action') || '');

  if (action === 'policy') {
    const then = String(fd.get('then') || '');
    if (then !== 'delete' && then !== 'anonymise' && then !== 'review') {
      return back('error', 'That end-of-period action could not be read. Nothing was changed.');
    }
    const res = await setRetentionPolicy({
      recordClass: String(fd.get('recordClass') || ''),
      retainDays: Number(fd.get('retainDays')),
      action: then,
      basis: String(fd.get('basis') || ''),
      actor,
    });
    if (!res.ok) return back('error', res.error);
    return back('done', 'Retention policy updated for ' + String(fd.get('recordClass') || '') + '.');
  }

  if (action === 'sweep') {
    let reports;
    try {
      reports = await applyRetention(actor, { dryRun: false });
    } catch (e: any) {
      // The real Postgres reason is on e.cause; e.message is only the failed SQL.
      return back('error', 'The sweep could not run: ' + String(e?.cause?.message || e?.message || e).slice(0, 200));
    }
    if (!reports.length) return back('done', 'The sweep ran and no class is governed by a policy yet.');

    // A FAILED CLASS IS NOT A CLASS THAT SWEPT NOTHING, and applyRetention does not throw to say so:
    // it catches per class and records `{ affected: 0, note: 'FAILED: <reason>' }`, so the reason is
    // in the note and the count is a zero that looks exactly like "there was nothing due". Summing
    // only recordClass/action/affected turned a sweep in which EVERY class failed — which is what a
    // database missing hgov_* produces — into a green "Sweep complete. access_log (review) 0". That
    // is the dishonest green tick this whole screen exists to detect, printed by the screen itself.
    const failed = reports.filter((r) => r.note.startsWith('FAILED'));
    if (failed.length) {
      return back(
        'error',
        failed.length + ' of ' + reports.length + ' record classes could not be swept: '
          + failed.map((r) => r.recordClass + ' — ' + r.note.replace(/^FAILED(?: in the owning patch)?: /, '')).join('; '),
      );
    }

    // Name the class AND the action taken on it. A `review` class reports a count without touching
    // anything, so a bare number beside it would read as a deletion that never happened.
    const touched = reports.map((r) => r.recordClass + ' (' + r.action + ') ' + r.affected).join(', ');
    return back('done', 'Sweep complete. ' + touched);
  }

  return back('error', 'That action is not one this screen offers. Nothing was changed.');
};
