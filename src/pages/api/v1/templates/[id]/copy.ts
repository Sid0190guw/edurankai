// POST /api/v1/templates/:id/copy — promote a template into another environment. Scope: templates.write
//
// THIS IS WHAT MAKES ENVIRONMENT SEPARATION LIVEABLE. Templates are environment-scoped so that a
// development key cannot touch a production template; without a promotion path that rule would mean
// retyping every template three times, and somebody would eventually solve the annoyance by handing
// production a development key. The copy runs with the CALLER'S key, which must itself hold
// templates.write — a development key can promote its work into staging or production because
// promoting content is the one crossing this platform intends to allow, and the copy is recorded in
// the new version's metadata as `copied_from`.
import type { APIRoute } from 'astro';
import { apiRoute, OPTIONS as PREFLIGHT } from '@/lib/mailapi/route';
import { readJsonBody, ApiError } from '@/lib/mailapi/errors';
import { requireScope, isEnvironment, ENVIRONMENTS } from '@/lib/mailapi/keys';
import { getTemplate, copyTemplateToEnvironment } from '@/lib/mailapi/templates';

export const OPTIONS = PREFLIGHT;

export const POST: APIRoute = apiRoute({ endpoint: 'templates.copy', scope: 'templates.read' }, async (ctx) => {
  requireScope(ctx.auth, 'templates.write');
  const ref = String(ctx.params.id || '');
  const source = await getTemplate(ctx.auth.orgId, ctx.auth.environment, ref);
  if (!source) throw new ApiError('template_not_found', 'No template `' + ref + '` in the ' + ctx.auth.environment + ' environment.');

  const body = await readJsonBody(ctx.request, 16 * 1024);
  const to = String(body.to_environment || body.environment || '');
  if (!isEnvironment(to)) {
    throw new ApiError('invalid_request', '`to_environment` must be one of: ' + ENVIRONMENTS.join(', ') + '.', { param: 'to_environment' });
  }
  if (to === ctx.auth.environment) {
    throw new ApiError('invalid_request', 'The target environment is the same as the source.', { param: 'to_environment' });
  }

  const { template, version } = await copyTemplateToEnvironment({
    orgId: ctx.auth.orgId,
    fromEnvironment: ctx.auth.environment,
    toEnvironment: to,
    key: source.key,
    publish: body.publish === true,
  });

  return ctx.json({
    object: 'template',
    id: template.id,
    key: template.key,
    environment: template.environment,
    version: version.version,
    state: version.state,
    published_version: template.publishedVersion,
    note: body.publish === true
      ? 'Copied and published as version ' + version.version + ' in ' + to + '.'
      : 'Copied as draft version ' + version.version + ' in ' + to + '. Publish it before production sends can use it.',
  }, 201);
});
