// /api/mail/automation/catalogue — what a visual builder needs from the ENGINE, and nothing it
// already gets elsewhere.
//
// CREATING, SAVING AND PUBLISHING AN AUTOMATION IS NOT HERE. /api/mail/product/automations already
// does all three through src/lib/mail-product/automations.ts, and a second writer would be a second
// set of rules about when a graph may go live. This endpoint answers the questions only the runtime
// can:
//
//   GET   the trigger, operator and action catalogues, the channel availability, the shipped
//         examples, and — with ?id= — one automation's graph resolved for a canvas plus BOTH
//         validations (structural and "can this installation actually run it").
//   POST  install an example, turn the inbound webhook on or off, and record a version snapshot
//         after the builder has saved a graph.
//
// NOTHING HERE IS HARD-CODED IN A PAGE. An action added to src/lib/mailplatform/actions.ts or a
// trigger added to mail-product's TRIGGER_EVENTS appears in the palette without a page changing.
import type { APIRoute } from 'astro';
import { denyMailApi } from '@/lib/auth/mail-access';
import { pgStore } from '@/lib/mailplatform/pg-store';
import { ORG_ID, checkReadyToActivate, disableWebhook, enableWebhook, installExample, listExamples, snapshotGraph } from '@/lib/mailplatform/service';
import { describeForBuilder } from '@/lib/mailplatform/graph';
import { CONDITION_OPERATORS } from '@/lib/mailplatform/conditions';
import { TRIGGER_TYPES } from '@/lib/mailplatform/triggers';
import { actionCatalogue } from '@/lib/mailplatform/actions';
import { channelStatus } from '@/lib/mailplatform/adapters';
import { safeId } from '@/lib/mailplatform/security';
import { reasonOf } from '@/lib/mailplatform/errors';
import { NODE_CATALOGUE, TRIGGER_EVENTS, CONDITION_FIELDS } from '@/lib/mail-product/automations';

const json = (d: any, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' } });

export const GET: APIRoute = async ({ locals, url }) => {
  const denied = await denyMailApi(locals, { label: 'mail.automation.read' });
  if (denied) return denied;
  try {
    const id = safeId(url.searchParams.get('id'));
    if (id) {
      const a = await pgStore.getAutomation(ORG_ID, id);
      if (!a) return json({ ok: false, error: 'There is no automation with that id here.' }, 404);
      const runs = await pgStore.listRuns(ORG_ID, { automationId: a.id, limit: 50 });
      const ready = await checkReadyToActivate(pgStore, ORG_ID, a.id);
      // webhook_secret is never in an AutomationRecord and is never returned here. It is shown once,
      // by enable_webhook below, and regenerated if it is lost.
      return json({ ok: true, automation: a, graph: describeForBuilder(a.graph), runs, ready });
    }
    return json({
      ok: true,
      automations: await pgStore.listAutomations(ORG_ID, {}),
      counts: await pgStore.countRuns(ORG_ID),
      catalogue: {
        // The canvas's own vocabulary…
        nodes: NODE_CATALOGUE,
        triggerEvents: TRIGGER_EVENTS,
        conditionFields: CONDITION_FIELDS,
        // …and the engine's, which is a superset: every event type it can route, every operator it
        // can evaluate, every step it can perform, and which channels actually work here.
        engineEvents: TRIGGER_TYPES,
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
  const action = String(body.action || '');

  try {
    if (action === 'install_example') {
      const r = await installExample(pgStore, ORG_ID, String(body.key || ''), user?.id || null);
      return json(r, r.ok ? 200 : 400);
    }
    if (action === 'snapshot') {
      // Called after the builder has saved a graph. Separate from the save so mail-product's own
      // write path is unchanged; the cost is that a writer which forgets to call this leaves a
      // version with no snapshot, which the engine reports at run time rather than guessing.
      const r = await snapshotGraph(pgStore, ORG_ID, safeId(body.id));
      return json(r, r.ok ? 200 : 404);
    }
    if (action === 'ready') {
      return json(await checkReadyToActivate(pgStore, ORG_ID, safeId(body.id)));
    }
    if (action === 'enable_webhook') return json(await enableWebhook(pgStore, ORG_ID, safeId(body.id)));
    if (action === 'disable_webhook') return json(await disableWebhook(pgStore, ORG_ID, safeId(body.id)));

    return json({ ok: false, error: 'unknown action "' + action + '". Creating, saving and publishing an automation is /api/mail/product/automations.' }, 400);
  } catch (e: any) {
    console.error('[api/mail/automation/catalogue]', reasonOf(e));
    return json({ ok: false, error: reasonOf(e) }, 500);
  }
};
