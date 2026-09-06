// POST /api/admin/governance/erasure — open, approve, refuse and carry out an erasure request.
//
// THIS ENDPOINT DID NOT EXIST. Four forms on /admin/governance/retention posted here — the request
// form and the Approve / Refuse / Carry-it-out controls on every row — and all four hit a 404. The
// workflow behind them (`requestErasure`, `approveErasure`, `rejectErasure`, `executeErasure`) was
// already written and exported; the seam was missing, so the screen showed a complete erasure
// workflow in which no request could be opened and no open request could be decided.
//
// THE TWO PERMISSIONS ARE NOT THE SAME PERMISSION, and this route keeps them apart the way the page
// does: `horizon.erasure.request` opens a request, `horizon.erasure.approve` decides one. Somebody
// who may ask for an erasure is not thereby somebody who may carry it out — that separation is the
// entire point of a two-person erasure workflow, and enforcing it only in the page that draws the
// buttons enforces it not at all, because this route can be posted to directly.
//
// SUBJECT KINDS. The form offered five (employee, user, candidate, intern, contractor). The
// governance layer defines two — `employee` and `applicant` — each valid only against particular
// anchor tables (src/lib/horizon/ids.ts, VALID_SCHEMES), because a subject anchored on the wrong
// table reads nothing and looks exactly like an innocent person with no history. Three of the five
// options named no anchor table at all. The form now offers what the layer can actually represent,
// and this map is the single place a form value becomes a SubjectRef.
import type { APIRoute } from 'astro';
import {
  approveErasure, executeErasure, governancePermissions, holdsGovernancePermission, rejectErasure,
  requestErasure,
} from '@/lib/horizon/governance';
import { DEFAULT_ORGANISATION_ID, type SubjectRef } from '@/lib/horizon/ids';

export const prerender = false;

const PAGE = '/admin/governance/retention';

/**
 * The subject kinds this screen may open a request for, and the anchor table each one means.
 *
 * `intern` and `contractor` are deliberately absent: they are employment arrangements, not a
 * separate place a person's records live, and both are anchored on hr_employees like any other
 * employee. Offering them as distinct kinds would have written a subject_kind no reader resolves.
 */
const SUBJECT_KINDS: Record<string, { kind: SubjectRef['kind']; idScheme: SubjectRef['idScheme']; label: string }> = {
  employee: { kind: 'employee', idScheme: 'hr_employee', label: 'an employee record' },
  candidate: { kind: 'applicant', idScheme: 'application', label: 'a job application' },
  person: { kind: 'applicant', idScheme: 'tal_person', label: 'a person in the talent stack' },
  user: { kind: 'applicant', idScheme: 'user', label: 'a signed-in account' },
};

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

  if (action === 'request') {
    if (!holdsGovernancePermission(held.permissions, 'horizon.erasure.request')) {
      return back('error', 'You do not hold horizon.erasure.request, so no request was opened.');
    }
    const chosen = SUBJECT_KINDS[String(fd.get('kind') || '')];
    if (!chosen) return back('error', 'That subject kind is not one this layer can anchor. No request was opened.');

    const subjectId = String(fd.get('subject') || '').trim();
    if (!subjectId) return back('error', 'A request needs the id of the subject it is about. No request was opened.');

    const mode = String(fd.get('mode') || '');
    if (mode !== 'delete' && mode !== 'anonymise') {
      return back('error', 'The action is either delete or anonymise. No request was opened.');
    }

    const res = await requestErasure({
      subject: { kind: chosen.kind, id: subjectId, idScheme: chosen.idScheme, organisationId: DEFAULT_ORGANISATION_ID },
      action: mode,
      reason: String(fd.get('reason') || ''),
      actor,
    });
    if (!res.ok) return back('error', res.error);
    // A blocked request is opened, not refused — the blockers are what the row is for. Saying
    // "opened" alone would let somebody walk away believing it is ready to approve.
    const blockers = res.data?.blockers ?? [];
    return back(
      'done',
      blockers.length
        ? 'Request opened against ' + chosen.label + ', and it is blocked: ' + blockers.join('; ')
        : 'Request opened against ' + chosen.label + '. It needs a second person to approve it.',
    );
  }

  // Everything below decides an existing request, and all of it needs the approve permission —
  // including `execute`, which is the act itself.
  if (!holdsGovernancePermission(held.permissions, 'horizon.erasure.approve')) {
    return back('error', 'You do not hold horizon.erasure.approve, so nothing was changed.');
  }
  const id = String(fd.get('id') || '').trim();
  if (!id) return back('error', 'That request could not be identified. Nothing was changed.');

  if (action === 'approve') {
    const res = await approveErasure(id, actor);
    if (!res.ok) return back('error', res.error);
    return back('done', 'Approved. It still has to be carried out, and that is a separate act.');
  }

  if (action === 'reject') {
    const res = await rejectErasure(id, String(fd.get('reason') || ''), actor);
    if (!res.ok) return back('error', res.error);
    return back('done', 'Refused, with your reason recorded against the request.');
  }

  if (action === 'execute') {
    const res = await executeErasure(id, actor);
    if (!res.ok) return back('error', res.error);
    // executeErasure returns ok:true even when a participant failed — it records that as status
    // 'blocked' with the detail in the report. Reporting "carried out" over a partial erasure would
    // tell somebody their records are gone when some of them are not.
    const done = res.data;
    const summary = Object.entries(done?.report ?? {})
      .map(([k, v]) => k + ': ' + (typeof v === 'object' ? JSON.stringify(v) : String(v)))
      .join(', ');
    if (done && done.status !== 'completed') {
      return back('error', 'Part of the erasure did not complete, and the request is ' + done.status + '. ' + summary);
    }
    return back('done', summary ? 'Carried out. ' + summary : 'Carried out.');
  }

  return back('error', 'That action is not one this screen offers. Nothing was changed.');
};
