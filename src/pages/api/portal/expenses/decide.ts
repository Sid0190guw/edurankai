// POST /api/portal/expenses/decide — the approver a claim was ROUTED to records their decision.
//
// THERE IS NO AUTHORISATION CHECK IN THIS FILE, AND THAT IS DELIBERATE RATHER THAN AN OVERSIGHT.
// decideClaim() calls workflow.decideInstance(), which resolves the step from the POSTED instance id
// and then asks mayAct() — "are you the approver this was routed to, are you standing in for them, or
// do you hold this domain's standing capability" (the expense and travel domains declare none, so
// only the first two can fire here). A check written again in this route would be a SECOND
// authorization engine, and the two would disagree within a month.
//
// So a hand-typed instance id is refused by the engine, in the same sentence, whether or not the page
// ever drew a button for it. A rendered list is not an authorisation, and neither is a missing one.
import type { APIRoute } from 'astro';
import { decideClaim } from '@/lib/expenses';

export const prerender = false;

const PAGE = '/portal/employee/expenses';

function back(kind: 'msg' | 'err', text: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: PAGE + '?' + kind + '=' + encodeURIComponent(text.slice(0, 400)) },
  });
}

export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const user = (locals as any)?.user;
  if (!user?.id) return redirect('/portal/login?next=' + encodeURIComponent(PAGE));

  let fd: FormData;
  try {
    fd = await request.formData();
  } catch {
    return back('err', 'That form could not be read. Nothing was changed. Try again.');
  }

  const decision = String(fd.get('decision') || '');
  if (decision !== 'approved' && decision !== 'rejected') {
    return back('err', 'That decision could not be read. Nothing was changed.');
  }

  const res = await decideClaim(
    String(fd.get('instance_id') || ''),
    user,
    decision,
    String(fd.get('note') || ''),
  );

  if (!res.ok) return back('err', res.error || 'That decision could not be recorded.');
  return back('msg', decision === 'approved' ? 'Approved.' : 'Rejected.');
};
