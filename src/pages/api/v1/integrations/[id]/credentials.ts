// GET  /api/v1/integrations/:id/credentials — what is stored, as metadata.
// POST /api/v1/integrations/:id/credentials — store one, rotate one, or revoke one.
//
// SECTION 6 OF THE BRIEF, ENFORCED BY SHAPE: "never expose secrets to frontend clients after
// creation". There is no read path in this file — or anywhere in the API — that returns stored
// secret material. What comes back is the kind, an optional label, the LAST FOUR characters, a
// truncated fingerprint, the expiry and the state. The fingerprint is what makes "is the value I
// gave the partner the one you hold?" answerable without either side quoting the secret.
//
// A stored credential is encrypted with AES-256-GCM under a key that lives in the environment, never
// in the database (src/lib/mailint/credentials.ts). If that key is not configured on this
// deployment, this endpoint REFUSES the write and says which variable to set — rather than storing
// something it cannot protect, or storing nothing and reporting success.
import type { APIRoute } from 'astro';
import { apiRoute, OPTIONS as PREFLIGHT } from '@/lib/mailapi/route';
import { ApiError, readJsonBody } from '@/lib/mailapi/errors';
import { getIntegration } from '@/lib/mailint/integrations';
import { listCredentials, revokeCredential, rotateCredential, storeCredential, vaultStatus } from '@/lib/mailint/credentials';
import { getConnector } from '@/lib/mailint/connectors';
import type { CredentialKind } from '@/lib/mailint/connector';

export const OPTIONS = PREFLIGHT;

const KINDS: CredentialKind[] = ['api_key', 'oauth_token', 'webhook_secret', 'smtp', 'basic'];

async function requireIntegration(ctx: any) {
  const integration = await getIntegration(ctx.auth.orgId, String(ctx.params.id || ''));
  if (!integration) throw new ApiError('not_found', 'No integration with that id.');
  if (integration.environment !== ctx.auth.environment) {
    throw new ApiError('environment_mismatch', 'That integration is in the ' + integration.environment + ' environment.');
  }
  return integration;
}

export const GET: APIRoute = apiRoute({ endpoint: 'integrations.credentials.list', scope: 'events.read' }, async (ctx) => {
  const integration = await requireIntegration(ctx);
  const creds = await listCredentials(ctx.auth.orgId, integration.id);
  const connector = getConnector(integration.connector);
  const present = new Set(creds.filter((c) => c.state === 'active' || c.state === 'expiring').map((c) => c.kind));

  return ctx.json({
    object: 'list',
    integration_id: integration.id,
    vault: vaultStatus(),
    /** What this connector cannot work without, and whether it has it. */
    required: (connector?.meta.requires || []).map((k) => ({ kind: k, present: present.has(k) })),
    count: creds.length,
    data: creds.map((c) => ({
      id: c.id,
      object: 'credential',
      kind: c.kind,
      label: c.label,
      hint: c.hint,
      fingerprint: c.fingerprint,
      state: c.state,
      expires_at: c.expiresAt,
      revoked_at: c.revokedAt,
      last_used_at: c.lastUsedAt,
      created_at: c.createdAt,
      rotated_from: c.rotatedFrom,
    })),
  });
});

export const POST: APIRoute = apiRoute({ endpoint: 'integrations.credentials.write', scope: 'integrations.write' }, async (ctx) => {
  const integration = await requireIntegration(ctx);
  const body = await readJsonBody(ctx.request, 32 * 1024);
  const action = String(body.action || 'store');

  if (action === 'revoke') {
    const id = String(body.credential_id || '');
    if (!id) throw new ApiError('invalid_request', '`credential_id` is required to revoke.', { param: 'credential_id' });
    const r = await revokeCredential(ctx.auth.orgId, id, String(body.reason || 'revoked through the API'));
    if (!r.ok) throw new ApiError('not_found', r.error || 'No such credential.');
    return ctx.json({ object: 'credential', id, revoked: true });
  }

  const secret = String(body.secret || '');
  if (!secret) throw new ApiError('invalid_request', '`secret` is required.', { param: 'secret' });

  if (action === 'rotate') {
    const id = String(body.credential_id || '');
    if (!id) throw new ApiError('invalid_request', '`credential_id` is required to rotate.', { param: 'credential_id' });
    // The old value keeps working for the overlap window, so the system on the other side deploys
    // its new secret when it suits them. Without that, "rotate" is a button that schedules an outage.
    const r = await rotateCredential({
      orgId: ctx.auth.orgId,
      credentialId: id,
      newSecret: secret,
      overlapHours: body.overlap_hours === undefined ? 24 : Number(body.overlap_hours),
    });
    if (!r.ok || !r.credential) throw new ApiError('invalid_request', r.error || 'The credential was not rotated.');
    return ctx.json({
      object: 'credential',
      id: r.credential.id,
      kind: r.credential.kind,
      hint: r.credential.hint,
      fingerprint: r.credential.fingerprint,
      rotated_from: id,
      note: 'The previous value keeps working for ' + (body.overlap_hours === undefined ? 24 : Number(body.overlap_hours)) + ' hours.',
    }, 201);
  }

  const kind = String(body.kind || '') as CredentialKind;
  if (!KINDS.includes(kind)) {
    throw new ApiError('invalid_request', '`kind` must be one of: ' + KINDS.join(', ') + '.', { param: 'kind' });
  }
  const r = await storeCredential({
    orgId: ctx.auth.orgId,
    integrationId: integration.id,
    kind,
    secret,
    label: body.label ? String(body.label) : null,
    expiresAt: body.expires_at ? String(body.expires_at) : null,
    scopes: Array.isArray(body.scopes) ? body.scopes.map(String) : [],
  });
  if (!r.ok || !r.credential) throw new ApiError('invalid_request', r.error || 'The credential was not stored.');

  return ctx.json({
    object: 'credential',
    id: r.credential.id,
    kind: r.credential.kind,
    label: r.credential.label,
    hint: r.credential.hint,
    fingerprint: r.credential.fingerprint,
    expires_at: r.credential.expiresAt,
    note: 'Stored encrypted. This is the last response that will mention it at all — no endpoint returns a stored secret.',
  }, 201);
});
