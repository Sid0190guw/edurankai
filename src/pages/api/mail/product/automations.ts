// /api/mail/product/automations — the visual workflow builder's backing API.
//
//   GET  ?id= | (list)
//   POST { action: 'create' | 'save' | 'validate' | 'activate' | 'pause' | 'delete' }
//
// 'validate' IS THE ONE THE CANVAS CALLS AS YOU DRAW. It returns the same problems 'activate' would
// refuse on, keyed by node id, so a fault is highlighted on the box that causes it while it is being
// built — rather than at the moment somebody presses Publish on a graph they thought was finished.
import type { APIRoute } from 'astro';
import { denyMailApi } from '@/lib/auth/mail-access';
import {
  listAutomations, getAutomation, createAutomation, saveAutomation, deleteAutomation,
  coerceGraph, validateGraph, runCounts, recentRuns,
  NODE_CATALOGUE, TRIGGER_EVENTS, CONDITION_FIELDS,
} from '@/lib/mail-product/automations';
import { listTemplates } from '@/lib/mail-product/templates';
import { json, fail, reasonOf, str } from '@/lib/mail-product/common';

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await denyMailApi(locals, { label: 'mail.product.automations.read' });
  if (denied) return denied;
  const url = new URL(request.url);
  const id = url.searchParams.get('id');

  try {
    if (id) {
      const automation = await getAutomation(id);
      if (!automation) return fail('No automation with that id.', 404);
      const [counts, runs, templates] = await Promise.all([
        runCounts(id).catch(() => ({})),
        recentRuns(id, 25).catch(() => []),
        listTemplates({}).catch(() => []),
      ]);
      return json({
        ok: true, automation, counts, runs,
        // The pickers the inspector needs, sent with the graph so the canvas needs one round trip.
        templates: templates.map((t) => ({ id: t.id, name: t.template_key, subject: t.subject, active: t.is_active })),
        catalogue: NODE_CATALOGUE, triggers: TRIGGER_EVENTS, conditionFields: CONDITION_FIELDS,
        validation: validateGraph(automation.graph),
      });
    }

    const rows = await listAutomations();
    // Run counts for the list, one query each, capped by the list's own 100-row limit.
    const withCounts = await Promise.all(rows.map(async (a: any) => ({ ...a, counts: await runCounts(a.id).catch(() => ({})) })));
    return json({ ok: true, rows: withCounts, catalogue: NODE_CATALOGUE });
  } catch (e: any) {
    console.error('[api/mail/product/automations] read failed:', reasonOf(e));
    return fail('Automations could not be read just now.', 500);
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await denyMailApi(locals, { label: 'mail.product.automations.write' });
  if (denied) return denied;
  const user = (locals as any).user;

  let body: any = {};
  try { body = await request.json(); } catch { return fail('The request body was not valid JSON.'); }
  const action = str(body.action, 40);
  const id = str(body.id, 40);

  try {
    switch (action) {
      // Pure. No database at all — this is called on every canvas edit.
      case 'validate': {
        const g = coerceGraph(body.graph);
        return json({ ok: true, validation: validateGraph(g) });
      }

      case 'create': {
        const res = await createAutomation(str(body.name, 160), user?.id ?? null);
        return res.id ? json({ ok: true, id: res.id }) : fail(res.error || 'The automation was not created.', 500);
      }

      case 'save': {
        const res = await saveAutomation(id, { name: body.name, description: body.description, graph: body.graph });
        return res.ok ? json({ ok: true }) : fail(res.error || 'The automation was not saved.');
      }

      case 'activate': {
        const res = await saveAutomation(id, { graph: body.graph, status: 'active' });
        // The problems travel back so the canvas can highlight every offending node at once, rather
        // than making somebody fix one, press Publish, and discover the next.
        return res.ok
          ? json({ ok: true, note: 'This automation is live. Contacts entering from now on will run through it.' })
          : json({ ok: false, error: res.error, problems: res.problems || [] }, 400);
      }

      case 'pause': {
        const res = await saveAutomation(id, { status: 'paused' });
        return res.ok
          ? json({ ok: true, note: 'Nobody new will enter. Runs already part-way through stay where they are and resume when you switch it back on.' })
          : fail(res.error || 'The automation was not paused.');
      }

      case 'delete': {
        const done = await deleteAutomation(id);
        return done ? json({ ok: true }) : fail('No automation with that id.', 404);
      }

      default:
        return fail('Unknown action: ' + (action || '(none)'));
    }
  } catch (e: any) {
    console.error('[api/mail/product/automations] ' + action + ' failed:', reasonOf(e));
    return fail('That did not go through, and the automation is unchanged.', 500);
  }
};
