// POST /api/admin/governance/publish — put the HORIZON permission keys into the catalogue an
// administrator grants roles from.
//
// THIS ENDPOINT DID NOT EXIST, so the one button on /admin/governance posted to a 404. The screen
// said "N of M permissions are in the catalogue. Until they are published nobody but a super admin
// holds them, and no custom role can be given them" — an accurate description of a state the button
// beneath it could not change.
//
// PUBLISHING GRANTS NOTHING. It makes the keys available to be granted and records who added them,
// which is why the page gates the button on `horizon.governance.view` rather than on a write
// permission. This route checks the same rule, so the button and the route cannot disagree about who
// may press it. That the check is a VIEW key guarding a WRITE is the page's existing policy, not a
// decision taken here: changing it would change who can do this, which is not a change to make while
// wiring up a control that was already drawn.
import type { APIRoute } from 'astro';
import {
  governancePermissions, holdsGovernancePermission, publishGovernancePermissions,
} from '@/lib/horizon/governance';

export const prerender = false;

const PAGE = '/admin/governance';

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
  if (held.degraded) {
    return back('error', 'Your permissions could not be resolved just now, so nothing was published. Try again.');
  }
  // The same rule the page uses to decide whether to draw the button.
  const mayPublish = held.permissions.has('*') || holdsGovernancePermission(held.permissions, 'horizon.governance.view');
  if (!mayPublish) return back('error', 'You do not hold horizon.governance.view, so nothing was published.');

  const res = await publishGovernancePermissions({
    id: String(user.id),
    email: user.email ?? null,
    name: user.name ?? null,
    ip: request.headers.get('x-forwarded-for') || null,
    userAgent: request.headers.get('user-agent') || null,
  });
  if (!res.ok) return back('error', res.error);

  // A PARTIAL PUBLISH IS NOT A SUCCESS. publishGovernancePermissions registers each key separately
  // and returns `ok: true` with the ones that failed listed in the report, so reporting the verb
  // alone would show a green banner over a catalogue that is still missing keys — the exact
  // dishonest tick the page below it exists to detect. Say the counts, and name the failure.
  const published = res.data?.published?.length ?? 0;
  const failed = res.data?.failed ?? [];
  if (failed.length) {
    return back(
      'error',
      published + ' key' + (published === 1 ? '' : 's') + ' published, ' + failed.length + ' could not be: '
        + failed.map((f) => f.key + ' (' + f.error + ')').join('; '),
    );
  }
  return back('done', published + ' permission key' + (published === 1 ? '' : 's') + ' published into the catalogue.');
};
