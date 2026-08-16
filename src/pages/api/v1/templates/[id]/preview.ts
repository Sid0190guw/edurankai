// POST /api/v1/templates/:id/preview — render a version against sample variables. Scope: templates.read
//
// NOTHING IS SENT AND NOTHING IS STORED. This is the test render: it returns the exact subject, HTML
// and text a send would produce, plus the variables the template needs and the ones that were
// missing. A caller can therefore find out that `deadline` is required without discovering it in a
// candidate's inbox.
import type { APIRoute } from 'astro';
import { apiRoute, OPTIONS as PREFLIGHT } from '@/lib/mailapi/route';
import { readJsonBody, ApiError } from '@/lib/mailapi/errors';
import { getTemplate, getVersion, getPublishedVersion, getLatestVersion, renderVersion } from '@/lib/mailapi/templates';

export const OPTIONS = PREFLIGHT;

export const POST: APIRoute = apiRoute({ endpoint: 'templates.preview', scope: 'templates.read' }, async (ctx) => {
  const ref = String(ctx.params.id || '');
  const t = await getTemplate(ctx.auth.orgId, ctx.auth.environment, ref);
  if (!t) throw new ApiError('template_not_found', 'No template `' + ref + '` in the ' + ctx.auth.environment + ' environment.');

  const body = await readJsonBody(ctx.request, 256 * 1024);
  const requested = body.version != null ? Number(body.version) : null;
  const version = requested != null
    ? await getVersion(t.id, requested)
    : ((await getPublishedVersion(t.id)) || (await getLatestVersion(t.id)));
  if (!version) {
    throw new ApiError('template_not_found', requested != null ? 'Template `' + t.key + '` has no version ' + requested + '.' : 'Template `' + t.key + '` has no versions yet.');
  }

  const variables = (body.variables && typeof body.variables === 'object' && !Array.isArray(body.variables))
    ? body.variables
    : (body.template_variables && typeof body.template_variables === 'object' ? body.template_variables : {});
  const rendered = renderVersion(version, variables);

  return ctx.json({
    object: 'template_preview',
    template: { id: t.id, key: t.key, version: version.version, state: version.state },
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    required_variables: version.variables,
    missing_variables: rendered.missing,
    // Stated rather than implied: a send with these variables would be refused, and the caller
    // should learn that here rather than from a 422 later.
    would_send: rendered.missing.length === 0,
    truncated: rendered.truncated || undefined,
  });
});
