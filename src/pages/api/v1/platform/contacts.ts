// GET  /api/v1/platform/contacts — search and page through contacts.
// POST /api/v1/platform/contacts — create or update one contact, or import many.
//
// The import path reports PER-ROW failures instead of aborting on the first bad address. A 400 on
// row 4,000 of a 5,000-row file, with the first 3,999 already written and no record of which, is
// the worst possible outcome for whoever has to finish the import.

import type { APIRoute } from 'astro';
import { audit, error, ok, pageParams, pageResponse, preflight, readJson, requirePrincipal } from '@/lib/mailplatform/api';
import { importContacts, listContacts, upsertContact, validateAttributes, listCustomFields } from '@/lib/mailplatform/contacts';
import type { ContactStatus } from '@/lib/mailplatform/types';

export const OPTIONS: APIRoute = () => preflight();

export const GET: APIRoute = async (ctx) => {
  const auth = await requirePrincipal(ctx, 'contacts.read');
  if (auth instanceof Response) return auth;

  const url = new URL(ctx.request.url);
  const { limit, cursor } = pageParams(url, 50, 200);

  const page = await listContacts({
    orgId: auth.principal.orgId,
    search: url.searchParams.get('q') || undefined,
    status: (url.searchParams.get('status') as ContactStatus) || undefined,
    listId: url.searchParams.get('listId') || undefined,
    tag: url.searchParams.get('tag') || undefined,
    limit,
    cursor,
  });
  return pageResponse(page, 'contacts');
};

export const POST: APIRoute = async (ctx) => {
  const auth = await requirePrincipal(ctx, 'contacts.write');
  if (auth instanceof Response) return auth;
  const { principal } = auth;

  const body = await readJson(ctx.request);
  if (body instanceof Response) return body;

  const fields = await listCustomFields(principal.orgId);

  // --- bulk ---
  if (Array.isArray(body.contacts)) {
    if (body.contacts.length > 10_000) {
      return error('Import at most 10,000 contacts per request. Split the file and post it in batches.', 413, 'batch_too_large');
    }
    const cleaned: any[] = [];
    const rejected: { email: string; error: string }[] = [];

    for (const row of body.contacts as any[]) {
      if (row?.attributes) {
        const validation = validateAttributes(fields, row.attributes);
        if (!validation.ok) {
          rejected.push({ email: String(row.email || ''), error: validation.errors.join(' ') });
          continue;
        }
        cleaned.push({ ...row, attributes: validation.values });
      } else {
        cleaned.push(row);
      }
    }

    const result = await importContacts(principal.orgId, cleaned, {
      source: typeof body.source === 'string' ? body.source : 'api',
      actorId: principal.id,
    });

    await audit({
      principal,
      request: ctx.request,
      action: 'contacts.import',
      meta: { created: result.created, updated: result.updated, failed: result.failed.length + rejected.length },
    });

    // 200, not 207. Every row's outcome is in the body; a partial-success status code that few
    // clients handle would make the common case (a handful of bad rows) look like a failed request.
    return ok({
      created: result.created,
      updated: result.updated,
      failed: [...rejected, ...result.failed],
      // Stated explicitly so nobody reads "created: 4990" as "all 5000 are in".
      summary: `${result.created} created, ${result.updated} updated, ${result.failed.length + rejected.length} not imported.`,
    });
  }

  // --- single ---
  if (!body.email) return error('"email" is required.', 422, 'no_email');

  let attributes = (body.attributes as Record<string, unknown>) || {};
  if (Object.keys(attributes).length) {
    const validation = validateAttributes(fields, attributes);
    if (!validation.ok) return error(validation.errors.join(' '), 422, 'invalid_attributes');
    attributes = validation.values;
  }

  const result = await upsertContact(
    principal.orgId,
    {
      email: String(body.email),
      firstName: (body.firstName as string) || null,
      lastName: (body.lastName as string) || null,
      fullName: (body.fullName as string) || null,
      phone: (body.phone as string) || null,
      company: (body.company as string) || null,
      locale: (body.locale as string) || null,
      timezone: (body.timezone as string) || null,
      status: (body.status as ContactStatus) || undefined,
      source: (body.source as string) || 'api',
      attributes,
    },
    { actorId: principal.id, actorType: principal.kind === 'api_key' ? 'api_key' : 'user' },
  );

  if (!result.ok) return error(result.error || 'The contact was not saved.', 422, 'upsert_failed');

  await audit({
    principal,
    request: ctx.request,
    action: result.created ? 'contact.create' : 'contact.update',
    targetType: 'contact',
    targetId: result.contact?.id || null,
  });

  return ok({ contact: result.contact, created: result.created }, result.created ? 201 : 200);
};
