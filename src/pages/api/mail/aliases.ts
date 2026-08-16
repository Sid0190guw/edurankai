// GET    /api/mail/aliases         — aliases, with what each one currently expands to.
// POST   /api/mail/aliases         — create one. Refused if it would close a delivery loop.
// PATCH  /api/mail/aliases         — change destinations, or enable/disable.
// DELETE /api/mail/aliases?id=...  — remove one.
//
// The loop check runs on the SERVER, on every write, against the whole graph — aliases and mailbox
// forwarding together. The form cannot see the other half of a cycle, and neither can the person
// filling it in.
import type { APIRoute } from 'astro';
import { guard, json, body, respond } from '@/lib/mailplatform/domains/api';
import { listAliases, createAlias, updateAliasTargets, setAliasActive, deleteAlias, deliveryGraph } from '@/lib/mailplatform/domains/store';
import { expand } from '@/lib/mailplatform/domains/aliases';

const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

export const GET: APIRoute = async ({ request, locals }) => {
  const g = await guard(request, locals, 'mail.read');
  if (!g.ok) return g.response;
  try {
    const [aliases, graph] = await Promise.all([listAliases(g.ctx.principal.orgId), deliveryGraph(g.ctx.principal.orgId)]);
    return json({
      ok: true,
      data: {
        aliases: aliases.map((a) => {
          // What it ACTUALLY delivers to today, not what the row says. A destination whose mailbox
          // was disabled last week still reads fine in the row and delivers nowhere.
          const result = expand(a.sourceAddress, graph);
          return { ...a, delivers: result.mailboxes, external: result.external, undeliverable: result.undeliverable };
        }),
      },
    });
  } catch (e: any) {
    return json({ ok: false, error: causeOf(e), code: 'db_error' }, 500);
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const g = await guard(request, locals, 'mailbox.manage');
  if (!g.ok) return g.response;
  const input = await body<any>(request);
  if (!input) return json({ ok: false, error: 'The request body was not valid JSON.', code: 'bad_body' }, 400);
  const targets = Array.isArray(input.targets) ? input.targets.map(String) : input.target ? [String(input.target)] : [];
  if (!input.source || targets.length === 0) {
    return json({ ok: false, error: 'An alias needs a source address and at least one destination.', code: 'missing_fields' }, 400);
  }
  return respond(await createAlias(g.ctx, { source: String(input.source), targets, allowExternal: input.allowExternal === true }), 201);
};

export const PATCH: APIRoute = async ({ request, locals }) => {
  const g = await guard(request, locals, 'mailbox.manage');
  if (!g.ok) return g.response;
  const input = await body<any>(request);
  if (!input?.id) return json({ ok: false, error: 'id is required.', code: 'missing_id' }, 400);
  if (input.isActive !== undefined) return respond(await setAliasActive(g.ctx, String(input.id), input.isActive === true));
  if (!Array.isArray(input.targets) || input.targets.length === 0) {
    return json({ ok: false, error: 'targets must be a non-empty array.', code: 'missing_targets' }, 400);
  }
  return respond(await updateAliasTargets(g.ctx, String(input.id), input.targets.map(String), input.allowExternal === true));
};

export const DELETE: APIRoute = async ({ request, locals }) => {
  const g = await guard(request, locals, 'mailbox.manage');
  if (!g.ok) return g.response;
  const id = new URL(request.url).searchParams.get('id') || '';
  if (!id) return json({ ok: false, error: 'id is required.', code: 'missing_id' }, 400);
  return respond(await deleteAlias(g.ctx, id));
};
