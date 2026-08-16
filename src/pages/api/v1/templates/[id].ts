// GET    /api/v1/templates/:id  — one template with its versions.        Scope: templates.read
// PATCH  /api/v1/templates/:id  — rename, or add a new draft version.    Scope: templates.write
// DELETE /api/v1/templates/:id  — archive it.                            Scope: templates.write
//
// `:id` accepts the uuid or the template key, because an integration hard-codes the key and a console
// link carries the id, and making the caller know which one they hold is a needless failure.
//
// DELETE ARCHIVES. Messages record the template and version they rendered from, and an audit that
// cannot resolve the template a letter came from is not an audit. Archiving removes it from listings
// and refuses new sends, which is every effect a caller wants, without destroying the record.
import type { APIRoute } from 'astro';
import { apiRoute, OPTIONS as PREFLIGHT } from '@/lib/mailapi/route';
import { readJsonBody, ApiError } from '@/lib/mailapi/errors';
import { requireScope } from '@/lib/mailapi/keys';
import { getTemplate, getVersions, addVersion, updateTemplateMeta, archiveTemplate } from '@/lib/mailapi/templates';

export const OPTIONS = PREFLIGHT;

async function mustFind(ctx: any) {
  const ref = String(ctx.params.id || '');
  const t = await getTemplate(ctx.auth.orgId, ctx.auth.environment, ref);
  if (!t) throw new ApiError('template_not_found', 'No template `' + ref + '` in the ' + ctx.auth.environment + ' environment.');
  return t;
}

export const GET: APIRoute = apiRoute({ endpoint: 'templates.get', scope: 'templates.read' }, async (ctx) => {
  const t = await mustFind(ctx);
  const versions = await getVersions(t.id);
  const includeBodies = ctx.url.searchParams.get('include_bodies') !== 'false';
  return ctx.json({
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
    versions: versions.map((v) => ({
      version: v.version,
      state: v.state,
      subject: v.subject,
      variables: v.variables,
      published_at: v.publishedAt,
      created_at: v.createdAt,
      ...(includeBodies ? { html: v.html, text: v.text } : {}),
    })),
  });
});

export const PATCH: APIRoute = apiRoute({ endpoint: 'templates.update', scope: 'templates.read' }, async (ctx) => {
  requireScope(ctx.auth, 'templates.write');
  const t = await mustFind(ctx);
  const body = await readJsonBody(ctx.request, 1024 * 1024);

  const wantsMeta = body.name != null || body.description != null;
  const wantsContent = body.subject != null || body.html != null || body.text != null;
  if (!wantsMeta && !wantsContent) {
    throw new ApiError('invalid_request', 'Nothing to change. Send name/description, or subject/html/text to add a version.');
  }
  if (wantsMeta) {
    await updateTemplateMeta(t.id, {
      name: body.name != null ? String(body.name) : undefined,
      description: body.description != null ? String(body.description) : undefined,
    });
  }

  let version = null;
  if (wantsContent) {
    // A content change is always a NEW version. Rewriting an existing one would change what a
    // message row's `template_version` points at, and that pointer has to keep meaning what it did.
    const current = (await getVersions(t.id, 1))[0];
    version = await addVersion(t.id, {
      subject: body.subject != null ? String(body.subject) : (current?.subject || ''),
      html: body.html != null ? String(body.html) : (current?.html || ''),
      text: body.text != null ? String(body.text) : (current?.text ?? null),
      metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : (current?.metadata || {}),
    }, { publish: body.publish === true });
  }

  const fresh = await getTemplate(ctx.auth.orgId, ctx.auth.environment, t.id);
  return ctx.json({
    id: t.id,
    object: 'template',
    key: t.key,
    name: fresh?.name,
    description: fresh?.description,
    published_version: fresh?.publishedVersion,
    latest_version: fresh?.latestVersion,
    version: version ? { version: version.version, state: version.state, variables: version.variables } : undefined,
  });
});

export const DELETE: APIRoute = apiRoute({ endpoint: 'templates.delete', scope: 'templates.read' }, async (ctx) => {
  requireScope(ctx.auth, 'templates.write');
  const t = await mustFind(ctx);
  const changed = await archiveTemplate(t.id, true);
  return ctx.json({
    id: t.id,
    object: 'template',
    archived: true,
    changed,
    note: changed
      ? 'Archived. It no longer appears in listings and cannot be sent; its versions are kept so past messages remain explainable.'
      : 'This template was already archived.',
  });
});
