// POST /api/v1/templates/:id/publish — publish a version (or unpublish one). Scope: templates.write
//
// Publishing version N archives whatever was published before it, so "published" means "the one
// production uses" and never "one of several that were once approved". Resolution for a send is then
// a single unambiguous lookup instead of a max() over states.
import type { APIRoute } from 'astro';
import { apiRoute, OPTIONS as PREFLIGHT } from '@/lib/mailapi/route';
import { readJsonBody, ApiError } from '@/lib/mailapi/errors';
import { requireScope } from '@/lib/mailapi/keys';
import { getTemplate, getVersions, publishVersion, unpublishVersion } from '@/lib/mailapi/templates';

export const OPTIONS = PREFLIGHT;

export const POST: APIRoute = apiRoute({ endpoint: 'templates.publish', scope: 'templates.read' }, async (ctx) => {
  requireScope(ctx.auth, 'templates.write');
  const ref = String(ctx.params.id || '');
  const t = await getTemplate(ctx.auth.orgId, ctx.auth.environment, ref);
  if (!t) throw new ApiError('template_not_found', 'No template `' + ref + '` in the ' + ctx.auth.environment + ' environment.');

  const body = await readJsonBody(ctx.request, 16 * 1024);
  const versions = await getVersions(t.id, 100);
  if (versions.length === 0) throw new ApiError('template_not_found', 'Template `' + t.key + '` has no versions to publish.');

  const target = body.version != null ? Number(body.version) : versions[0].version;
  if (!Number.isInteger(target) || !versions.some((v) => v.version === target)) {
    throw new ApiError('invalid_request', 'Template `' + t.key + '` has no version ' + body.version + '.', { param: 'version' });
  }

  if (body.unpublish === true) {
    const done = await unpublishVersion(t.id, target);
    return ctx.json({
      id: t.id, object: 'template', key: t.key, version: target, state: done ? 'draft' : 'unchanged',
      note: done
        ? 'Version ' + target + ' is a draft again. Production sends against this template will now be refused unless options.allow_draft is set.'
        : 'Version ' + target + ' was not the published version, so nothing changed.',
    });
  }

  const published = await publishVersion(t.id, target);
  if (!published) throw new ApiError('template_not_found', 'Version ' + target + ' could not be published.');
  return ctx.json({
    id: t.id,
    object: 'template',
    key: t.key,
    published_version: published.version,
    state: published.state,
    published_at: published.publishedAt,
    variables: published.variables,
  });
});
