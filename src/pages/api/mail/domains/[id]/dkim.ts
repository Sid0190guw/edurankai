// GET   /api/mail/domains/:id/dkim — the keys, PUBLIC halves only.
// POST  /api/mail/domains/:id/dkim — generate a key (optionally as a rotation).
// PATCH /api/mail/domains/:id/dkim — activate or retire one.
//
// THERE IS NO ROUTE HERE THAT RETURNS A PRIVATE KEY, AND THERE MUST NEVER BE ONE.
// The type this file serialises (DkimKeyRow) has no field a private key could travel in; the
// private half is encrypted at rest and resolved only inside the process that signs. If a future
// feature seems to need the private key on the client — an export, a "copy to your other provider"
// button — the answer is a new key at a new selector, not an export of this one.
import type { APIRoute } from 'astro';
import { guard, json, body, respond } from '@/lib/mailplatform/domains/api';
import { getDomain, listDkimKeys, generateDkimKey, activateDkimKey, retireDkimKey } from '@/lib/mailplatform/domains/store';
import { dkimDnsValue, dkimHost, quotedTxt, planRotation, type DkimAlgorithm } from '@/lib/mailplatform/domains/dkim';

const ALGORITHMS: DkimAlgorithm[] = ['rsa-sha256', 'ed25519-sha256'];

export const GET: APIRoute = async ({ request, locals, params }) => {
  const g = await guard(request, locals, 'domains.read');
  if (!g.ok) return g.response;
  const id = String(params.id || '');
  const domain = await getDomain(g.ctx.principal.orgId, id);
  if (!domain) return json({ ok: false, error: 'Domain not found.', code: 'not_found' }, 404);

  const keys = await listDkimKeys(g.ctx.principal.orgId, id);
  return json({
    ok: true,
    data: {
      keys: keys.map((k) => ({
        id: k.id,
        selector: k.selector,
        algorithm: k.algorithm,
        keySize: k.keySize,
        status: k.status,
        activatedAt: k.activatedAt,
        retiredAt: k.retiredAt,
        createdAt: k.createdAt,
        // What the customer has to publish, in both the plain and the chunked-and-quoted forms.
        dnsHost: dkimHost(k.selector, domain.domain),
        dnsValue: dkimDnsValue({ publicKey: k.publicKey, algorithm: k.algorithm }),
        dnsValueQuoted: quotedTxt(dkimDnsValue({ publicKey: k.publicKey, algorithm: k.algorithm })),
        // Present so a key can be compared by eye; it is public by definition.
        publicKey: k.publicKey,
      })),
      rotation: planRotation(keys.filter((k) => k.status !== 'retired').map((k) => ({ selector: k.selector, status: k.status }))),
    },
  });
};

export const POST: APIRoute = async ({ request, locals, params }) => {
  const g = await guard(request, locals, 'domains.manage');
  if (!g.ok) return g.response;
  const id = String(params.id || '');
  const input = await body<{ algorithm?: string; keySize?: number; selector?: string }>(request);
  if (!input) return json({ ok: false, error: 'The request body was not valid JSON.', code: 'bad_body' }, 400);

  const algorithm = (input.algorithm || 'rsa-sha256') as DkimAlgorithm;
  if (!ALGORITHMS.includes(algorithm)) {
    return json({ ok: false, error: 'algorithm must be one of: ' + ALGORITHMS.join(', ') + '.', code: 'bad_algorithm' }, 400);
  }
  return respond(await generateDkimKey(g.ctx, id, { algorithm, keySize: input.keySize, selector: input.selector }), 201);
};

export const PATCH: APIRoute = async ({ request, locals, params }) => {
  const g = await guard(request, locals, 'domains.manage');
  if (!g.ok) return g.response;
  const id = String(params.id || '');
  const input = await body<{ keyId?: string; action?: string }>(request);
  if (!input?.keyId) return json({ ok: false, error: 'keyId is required.', code: 'missing_key' }, 400);

  if (input.action === 'activate') return respond(await activateDkimKey(g.ctx, id, input.keyId));
  if (input.action === 'retire') return respond(await retireDkimKey(g.ctx, id, input.keyId));
  return json({ ok: false, error: 'action must be activate or retire.', code: 'bad_action' }, 400);
};
