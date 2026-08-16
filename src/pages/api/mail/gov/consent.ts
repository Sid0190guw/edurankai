// GET  /api/mail/gov/consent   records and per-category counts; ?email= for one address
// POST /api/mail/gov/consent   { action: 'record' | 'withdraw' | 'check', ... }
//
// `check` is the one an integration calls before sending: it answers "may this address be sent this
// CATEGORY of message", combining the per-category consent record with the suppression list, and it
// refuses when the lookup itself failed rather than defaulting to yes. The answer carries a code, so
// a caller can tell "they unsubscribed" from "the address bounced" from "we never had consent" —
// three facts that need three different responses from the product.
import type { APIRoute } from 'astro';
import { govJson, methodNotAllowed, orgParam, readJson } from '@/lib/mailgov/http';
import { auditedWrite, requireGov } from '@/lib/mailgov/guard';
import { AUDIT_ACTIONS } from '@/lib/mailgov/audit';
import { consentFor, consentSummary, listConsent, mayPlatformSend, recordConsent, withdrawConsent } from '@/lib/mailgov/consent';
import { CATEGORY_SPECS, CONSENT_CATEGORIES, type ConsentCategory } from '@/lib/mailgov/consent-policy';

export const GET: APIRoute = async ({ locals, request, url }) => {
  const wanted = url.searchParams.get('org');
  const g = await requireGov(locals, 'consent.view', { orgId: wanted || undefined }, request);
  if (g.denied) return g.denied;

  const orgId = orgParam(url, g.actor.orgId);
  if (!orgId) return govJson({ ok: false, error: 'Name the organization.' }, 400);
  const environment = url.searchParams.get('environment') || 'production';

  const email = url.searchParams.get('email');
  if (email) {
    const one = await consentFor(orgId, environment, email);
    return govJson({
      ok: one.ok, error: one.ok ? null : one.reason,
      email, records: one.records,
      categories: CONSENT_CATEGORIES.map((c) => CATEGORY_SPECS[c]),
    });
  }

  const list = await listConsent({
    orgId, environment,
    category: (url.searchParams.get('category') as ConsentCategory) || null,
    status: url.searchParams.get('status'),
    limit: Number(url.searchParams.get('limit')) || 100,
  });
  const summary = await consentSummary(orgId, environment);

  return govJson({
    ok: list.ok, error: list.ok ? null : list.reason,
    records: list.ok ? list.rows : [],
    summary,
    categories: CONSENT_CATEGORIES.map((c) => CATEGORY_SPECS[c]),
  });
};

export const POST: APIRoute = async ({ locals, request, url }) => {
  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;
  const action = String(body.action || '');
  const orgId = String(body.orgId || url.searchParams.get('org') || '');
  const environment = String(body.environment || 'production');

  if (action === 'check') {
    const g = await requireGov(locals, 'consent.view', { orgId }, request);
    if (g.denied) return g.denied;
    const decision = await mayPlatformSend({
      orgId, environment,
      email: String(body.email || ''),
      category: String(body.category || ''),
    });
    return govJson({ ok: true, decision });
  }

  if (action === 'record') {
    const g = await requireGov(locals, 'consent.edit', { orgId }, request);
    if (g.denied) return g.denied;

    const out = await auditedWrite(
      {
        actor: g.actor, action: AUDIT_ACTIONS.CONSENT_RECORDED, orgId,
        targetType: 'consent', targetId: String(body.email || ''),
        reason: String(body.reason || ''),
        meta: { category: body.category, source: body.source, purpose: body.purpose || null },
        facts: g.facts,
      },
      async () => {
        const r = await recordConsent({
          orgId, environment,
          email: String(body.email || ''),
          category: String(body.category || '') as ConsentCategory,
          source: String(body.source || ''),
          purpose: body.purpose ? String(body.purpose) : null,
          ip: g.facts.ip,
          evidence: (body.evidence && typeof body.evidence === 'object') ? body.evidence : {},
        });
        if (!r.ok) throw new Error(r.error);
        return r;
      },
    );
    return govJson({ ok: out.ok, error: out.error }, out.ok ? 200 : 400);
  }

  if (action === 'withdraw') {
    const g = await requireGov(locals, 'consent.edit', { orgId }, request);
    if (g.denied) return g.denied;

    const out = await auditedWrite(
      {
        actor: g.actor, action: AUDIT_ACTIONS.CONSENT_WITHDRAWN, orgId,
        targetType: 'consent', targetId: String(body.email || ''),
        reason: String(body.reason || ''), meta: { category: body.category, source: body.source || 'admin' },
        facts: g.facts,
      },
      async () => {
        const r = await withdrawConsent({
          orgId, environment,
          email: String(body.email || ''),
          category: String(body.category || '') as ConsentCategory,
          source: String(body.source || 'admin'),
        });
        if (!r.ok) throw new Error(r.error);
        return r;
      },
    );
    return govJson({ ok: out.ok, error: out.error }, out.ok ? 200 : 400);
  }

  return govJson({ ok: false, error: 'Unknown action: ' + action + '.', actions: ['check', 'record', 'withdraw'] }, 400);
};

export const ALL: APIRoute = async () => methodNotAllowed(['GET', 'POST']);
