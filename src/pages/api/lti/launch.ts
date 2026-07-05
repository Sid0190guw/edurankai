// POST /api/lti/launch — LTI 1.1 external-tool launch from an LMS. Verifies the
// OAuth 1.0 signature, records the launch (incl. the grade-return service), and
// redirects into the chosen lab in embed mode. Configure on the LMS side with a
// consumer key/secret (see /admin/lti) and a custom parameter  lab=<slug>.
import type { APIRoute } from 'astro';
import { verifyLaunch, storeLaunch } from '@/lib/lti';
import { LABS } from '@/data/labs-catalog';

export const POST: APIRoute = async ({ request }) => {
  let form: FormData;
  try { form = await request.formData(); } catch { return new Response('Expected form-encoded LTI launch', { status: 400 }); }
  const params: Record<string, string> = {};
  form.forEach((v, k) => { params[k] = String(v); });

  const proto = request.headers.get('x-forwarded-proto') || 'https';
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || 'edurankai.in';
  const url = proto + '://' + host + '/api/lti/launch';

  const res = await verifyLaunch('POST', url, params);
  if (!res.ok) return new Response('LTI launch rejected: ' + res.error, { status: 401 });

  const lab = (params['custom_lab'] || '').trim();
  const known = LABS.find((l) => l.slug === lab);
  if (!known) return new Response('Add a custom parameter  lab=<slug>  to the tool configuration. Unknown or missing lab: "' + lab + '".', { status: 400 });

  const token = await storeLaunch({
    consumerKey: params.oauth_consumer_key,
    lab,
    outcomeUrl: params.lis_outcome_service_url || '',
    sourcedid: params.lis_result_sourcedid || '',
    userName: params.lis_person_name_full || params.lis_person_name_given || '',
    context: params.context_title || '',
  });
  return new Response(null, { status: 302, headers: { Location: '/aquintutor/labs/' + lab + '?embed=1&lti=' + token } });
};
