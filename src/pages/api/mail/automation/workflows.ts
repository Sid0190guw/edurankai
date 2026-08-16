// /api/mail/automation/workflows — the workflow CRUD a visual builder talks to.
//
// GET  returns every workflow plus the catalogues a builder needs to draw one: the trigger types,
//      the condition operators, the action palette and the channel availability. THE FRONT END
//      HARD-CODES NONE OF IT — an action added to src/lib/mailplatform/actions.ts appears in the
//      palette without a single line changing in a page.
// POST performs one named action. Everything goes through src/lib/mailplatform/service.ts, so this
//      route decides nothing the admin page could decide differently.
//
// The gate is denyMailApi() — the same one /api/mail/send and /api/mail/draft use. Sign-in alone is
// not an answer here: a workflow is a machine for sending mail from the company mailbox to external
// addresses, on a schedule, without anybody watching.
import type { APIRoute } from 'astro';
import { denyMailApi } from '@/lib/auth/mail-access';
import { pgStore } from '@/lib/mailplatform/pg-store';
import {
  ORG_ID, disableWebhook, enableWebhook, installExample, listExamples, saveWorkflow, setWorkflowStatus,
} from '@/lib/mailplatform/service';
import { describeForBuilder } from '@/lib/mailplatform/graph';
import { CONDITION_OPERATORS } from '@/lib/mailplatform/conditions';
import { TRIGGER_TYPES } from '@/lib/mailplatform/triggers';
import { actionCatalogue } from '@/lib/mailplatform/actions';
import { channelStatus } from '@/lib/mailplatform/adapters';
import { safeId } from '@/lib/mailplatform/security';
import { reasonOf } from '@/lib/mailplatform/errors';

const json = (d: any, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' } });

export const GET: APIRoute = async ({ locals, url }) => {
  const denied = await denyMailApi(locals, { label: 'mail.automation.read' });
  if (denied) return denied;
  try {
    const id = safeId(url.searchParams.get('id'));
    if (id) {
      const wf = await pgStore.getWorkflow(ORG_ID, id);
      if (!wf) return json({ ok: false, error: 'There is no workflow with that id here.' }, 404);
      const runs = await pgStore.listRuns(ORG_ID, { workflowId: wf.id, limit: 50 });
      // webhook_secret is never in a WorkflowRecord and is never returned by this route. It is shown
      // once, by the enable_webhook action below, and regenerated if it is lost.
      return json({ ok: true, workflow: wf, graph: describeForBuilder(wf.definition), runs });
    }
    const workflows = await pgStore.listWorkflows(ORG_ID, {});
    return json({
      ok: true,
      workflows,
      counts: await pgStore.countRuns(ORG_ID),
      catalogue: {
        triggers: TRIGGER_TYPES,
        operators: CONDITION_OPERATORS,
        actions: actionCatalogue(),
        channels: await channelStatus(),
        examples: listExamples(),
      },
    });
  } catch (e: any) {
    return json({ ok: false, error: reasonOf(e) }, 500);
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await denyMailApi(locals, { label: 'mail.automation.write' });
  if (denied) return denied;
  const user = (locals as any).user;

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const action = String(body.action || 'save');

  try {
    if (action === 'save') {
      const r = await saveWorkflow(pgStore, ORG_ID, {
        id: safeId(body.id) || null,
        key: String(body.key || ''),
        name: String(body.name || ''),
        description: String(body.description || ''),
        status: body.status,
        definition: body.definition,
      }, user?.id || null);
      return json(r, r.ok ? 200 : 400);
    }

    if (action === 'set_status') {
      const status = String(body.status || '');
      if (!['draft', 'active', 'paused', 'archived'].includes(status)) return json({ ok: false, error: 'unknown status' }, 400);
      const r = await setWorkflowStatus(pgStore, ORG_ID, safeId(body.id), status as any);
      return json(r, r.ok ? 200 : 400);
    }

    if (action === 'install_example') {
      const r = await installExample(pgStore, ORG_ID, String(body.key || ''), user?.id || null);
      return json(r, r.ok ? 200 : 400);
    }

    if (action === 'enable_webhook') return json(await enableWebhook(pgStore, ORG_ID, safeId(body.id)));
    if (action === 'disable_webhook') return json(await disableWebhook(pgStore, ORG_ID, safeId(body.id)));

    if (action === 'delete') {
      // Scoped to the organisation, so an id belonging to somebody else matches zero rows and the
      // request is a no-op rather than a deletion. The runs are left: they are the record of what
      // was actually sent to real people, and deleting a workflow must not erase that.
      const gone = await pgStore.deleteWorkflow(ORG_ID, safeId(body.id));
      return gone
        ? json({ ok: true, message: 'Deleted. Its run history is kept — it is the record of what was sent.' })
        : json({ ok: false, error: 'Nothing was deleted: that workflow is already gone, or it is not yours.' }, 404);
    }

    return json({ ok: false, error: 'unknown action "' + action + '"' }, 400);
  } catch (e: any) {
    console.error('[api/mail/automation/workflows]', reasonOf(e));
    return json({ ok: false, error: reasonOf(e) }, 500);
  }
};
