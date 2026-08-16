// GET  /api/v1/templates          — list templates in the key's environment.  Scope: templates.read
// POST /api/v1/templates          — create a template with its first version.  Scope: templates.write
//
// Templates are scoped to the organization AND the environment the key belongs to. A development key
// cannot see, edit or send a production template — the environment is in the WHERE clause, not in a
// convention. `POST /api/v1/templates/:id/copy` is the supported way to promote one.
import type { APIRoute } from 'astro';
import { apiRoute, OPTIONS as PREFLIGHT } from '@/lib/mailapi/route';
import { readJsonBody } from '@/lib/mailapi/errors';
import { requireScope } from '@/lib/mailapi/keys';
import { createTemplate, listTemplates } from '@/lib/mailapi/templates';
import { extractVariables } from '@/lib/mailapi/render';

export const OPTIONS = PREFLIGHT;

export const GET: APIRoute = apiRoute({ endpoint: 'templates.list', scope: 'templates.read' }, async (ctx) => {
  const includeArchived = ctx.url.searchParams.get('include_archived') === 'true';
  const templates = await listTemplates(ctx.auth.orgId, ctx.auth.environment, { includeArchived });
  return ctx.json({
    object: 'list',
    environment: ctx.auth.environment,
    count: templates.length,
    data: templates.map((t) => ({
      id: t.id,
      object: 'template',
      key: t.key,
      name: t.name,
      description: t.description,
      environment: t.environment,
      archived: t.isArchived,
      published_version: t.publishedVersion,
      latest_version: t.latestVersion,
      created_at: t.createdAt,
      updated_at: t.updatedAt,
    })),
  });
});

export const POST: APIRoute = apiRoute({ endpoint: 'templates.create', scope: 'templates.read' }, async (ctx) => {
  requireScope(ctx.auth, 'templates.write');
  const body = await readJsonBody(ctx.request, 1024 * 1024);
  const { template, version } = await createTemplate({
    orgId: ctx.auth.orgId,
    environment: ctx.auth.environment,
    key: String(body.key || body.template_key || ''),
    name: String(body.name || body.key || ''),
    description: body.description != null ? String(body.description) : null,
    content: {
      subject: String(body.subject || ''),
      html: String(body.html || ''),
      text: body.text != null ? String(body.text) : null,
      metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
    },
    publish: body.publish === true,
  });
  return ctx.json({
    id: template.id,
    object: 'template',
    key: template.key,
    name: template.name,
    environment: template.environment,
    published_version: template.publishedVersion,
    latest_version: template.latestVersion,
    version: {
      version: version.version,
      state: version.state,
      subject: version.subject,
      variables: version.variables,
      created_at: version.createdAt,
    },
    // Returned on create so the caller can see immediately what a send will have to supply — the
    // list is derived from the template body, not declared by hand, so it cannot drift from it.
    variables: extractVariables(version.subject, version.html, version.text || ''),
  }, 201);
});
