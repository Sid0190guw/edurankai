// /api/mail/automation/runs — read a run and its step-by-step trace; pause, resume, cancel, retry.
//
// The trace is the answer to "why did this candidate get that message, and why did that one not?".
// It is the condition's own reasoning, the instant a delay was parked until, and what each action
// actually did — recorded at the time, not reconstructed afterwards.
import type { APIRoute } from 'astro';
import { denyMailApi } from '@/lib/auth/mail-access';
import { pgStore } from '@/lib/mailplatform/pg-store';
import { ORG_ID } from '@/lib/mailplatform/service';
import { controlRun, type ControlAction } from '@/lib/mailplatform/worker';
import { safeId } from '@/lib/mailplatform/security';
import { reasonOf } from '@/lib/mailplatform/errors';
import type { RunState } from '@/lib/mailplatform/store';

const json = (d: any, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' } });

export const GET: APIRoute = async ({ locals, url }) => {
  const denied = await denyMailApi(locals, { label: 'mail.automation.runs' });
  if (denied) return denied;
  try {
    const runId = safeId(url.searchParams.get('runId'));
    if (runId) {
      const run = await pgStore.getRun(ORG_ID, runId);
      if (!run) return json({ ok: false, error: 'There is no run with that id here.' }, 404);
      const steps = await pgStore.listSteps(run.runId);
      const contact = run.contactId ? await pgStore.getContact(run.contactId) : null;
      return json({ ok: true, run, steps, contact });
    }
    const state = safeId(url.searchParams.get('state'), 16) as RunState | '';
    return json({
      ok: true,
      runs: await pgStore.listRuns(ORG_ID, {
        automationId: safeId(url.searchParams.get('automationId')) || undefined,
        state: state || undefined,
        deadLetterOnly: url.searchParams.get('deadLetter') === '1',
        limit: Math.min(200, Number(url.searchParams.get('limit') || 100) || 100),
      }),
      counts: await pgStore.countRuns(ORG_ID),
    });
  } catch (e: any) {
    return json({ ok: false, error: reasonOf(e) }, 500);
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await denyMailApi(locals, { label: 'mail.automation.control' });
  if (denied) return denied;
  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }

  const action = String(body.action || '') as ControlAction;
  if (!['pause', 'resume', 'cancel', 'retry'].includes(action)) return json({ ok: false, error: 'unknown action' }, 400);
  try {
    // The org id is this server's, never the caller's — a run id from a browser is an untrusted
    // string, and without the scope one operator's run id would be a working URL for another's.
    const r = await controlRun(pgStore, ORG_ID, safeId(body.runId), action);
    // `changed:false` is reported with ok:false and a plain sentence rather than a cheerful 200:
    // telling somebody a run was cancelled when it had already been sent is the failure that
    // matters here.
    return json(r, r.ok ? 200 : 409);
  } catch (e: any) {
    return json({ ok: false, error: reasonOf(e) }, 500);
  }
};
