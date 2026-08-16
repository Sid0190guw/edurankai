// src/lib/mailplatform/templates.ts — templates, immutable versions, and rendering.
//
// This is what makes the integration contract in the brief work:
//
//   POST /api/v1/messages/send { to, template: "internship-stage-update", variables: { ... } }
//
// A calling product names a template and supplies variables; it never composes HTML. That means the
// wording of every message EduRankAI sends can be changed without a deploy of the product that
// sends it, and it means a message sent last March can still be shown with the exact wording that
// went out — because a published version is never edited, only superseded.

import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { escapeHtml, htmlToText } from './rfc';
import type { Template, TemplateCategory, TemplateVersion, UUID } from './types';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const iso = (v: any): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

// ---------------------------------------------------------------------------
// Rendering (pure)
// ---------------------------------------------------------------------------

/** `{{ name }}` / `{{name}}`. Deliberately the only syntax — see renderTemplate(). */
export const VARIABLE_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g;

/** Every variable a body references, in first-appearance order, deduplicated. */
export function extractVariables(...sources: (string | null | undefined)[]): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    if (!source) continue;
    for (const match of String(source).matchAll(VARIABLE_RE)) {
      const name = match[1];
      if (!seen.has(name)) {
        seen.add(name);
        found.push(name);
      }
    }
  }
  return found;
}

/** Resolve `a.b.c` against a plain object. Returns undefined rather than throwing on a gap. */
function lookup(vars: Record<string, unknown>, path: string): unknown {
  if (!path.includes('.')) return vars[path];
  let cur: any = vars;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

export interface RenderResult {
  subject: string;
  html: string;
  text: string;
  /** Variables the template asked for that the caller did not supply. */
  missing: string[];
}

/**
 * Render a template version.
 *
 * DESIGN DECISIONS, because each one has a failure mode attached:
 *
 * 1. NO LOGIC IN TEMPLATES. No conditionals, no loops, no partials — just substitution. A template
 *    language in a mail system becomes a code path that marketing edits and nobody tests, and the
 *    first `{{#if}}` that throws takes out a password-reset email.
 *
 * 2. VALUES ARE HTML-ESCAPED IN THE HTML BODY. A contact's name is untrusted input: it arrives from
 *    an import file or a signup form. Interpolating it raw makes every template a stored-XSS sink
 *    in whatever renders the message, including the platform's own reading pane.
 *
 * 3. A MISSING VARIABLE IS REPORTED, NOT SILENTLY BLANK. `Dear ,` is worse than a refusal, because
 *    it goes out looking almost right. Callers decide what to do with `missing`; ../send.ts refuses
 *    the send when a REQUIRED variable is absent.
 */
export function renderTemplate(
  version: Pick<TemplateVersion, 'subject' | 'htmlBody' | 'textBody'>,
  variables: Record<string, unknown> = {},
): RenderResult {
  const missing = new Set<string>();

  const substitute = (source: string, escape: boolean): string =>
    String(source || '').replace(VARIABLE_RE, (_whole, name: string) => {
      const value = lookup(variables, name);
      if (value === undefined || value === null) {
        missing.add(name);
        return '';
      }
      const asString = typeof value === 'object' ? JSON.stringify(value) : String(value);
      return escape ? escapeHtml(asString) : asString;
    });

  const subject = substitute(version.subject, false).replace(/[\r\n]+/g, ' ').trim();
  const html = substitute(version.htmlBody, true);
  const text = version.textBody ? substitute(version.textBody, false) : htmlToText(html);

  return { subject, html, text, missing: [...missing] };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function toTemplate(row: any): Template {
  return {
    id: row.id,
    orgId: row.org_id,
    key: row.key,
    name: row.name,
    description: row.description ?? null,
    category: row.category,
    currentVersionId: row.current_version_id ?? null,
    isActive: !!row.is_active,
    createdAt: iso(row.created_at) || '',
    updatedAt: iso(row.updated_at) || '',
    deletedAt: iso(row.deleted_at),
  };
}

function toVersion(row: any): TemplateVersion {
  return {
    id: row.id,
    orgId: row.org_id,
    templateId: row.template_id,
    version: Number(row.version),
    subject: row.subject,
    htmlBody: row.html_body,
    textBody: row.text_body ?? null,
    variables: Array.isArray(row.variables) ? row.variables : [],
    createdBy: row.created_by ?? null,
    publishedAt: iso(row.published_at),
    createdAt: iso(row.created_at) || '',
  };
}

export async function listTemplates(
  orgId: UUID,
  opts: { category?: TemplateCategory; limit?: number } = {},
): Promise<Template[]> {
  try {
    const conditions = [sql`org_id = ${orgId}`, sql`deleted_at IS NULL`];
    if (opts.category) conditions.push(sql`category = ${opts.category}`);
    const r = rows(await db.execute(sql`
      SELECT * FROM mp_templates WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY key ASC LIMIT ${Math.min(Number(opts.limit) || 200, 500)}`));
    return r.map(toTemplate);
  } catch (e: any) {
    console.error('[mailplatform/templates] list failed -', causeOf(e));
    return [];
  }
}

export async function getTemplate(orgId: UUID, keyOrId: string): Promise<Template | null> {
  if (!keyOrId) return null;
  try {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(keyOrId.trim());
    const r = rows(await db.execute(
      isUuid
        ? sql`SELECT * FROM mp_templates WHERE org_id = ${orgId} AND id = ${keyOrId.trim()} AND deleted_at IS NULL LIMIT 1`
        : sql`SELECT * FROM mp_templates WHERE org_id = ${orgId} AND lower(key) = ${keyOrId.trim().toLowerCase()} AND deleted_at IS NULL LIMIT 1`,
    ));
    return r.length ? toTemplate(r[0]) : null;
  } catch (e: any) {
    console.error('[mailplatform/templates] get failed -', causeOf(e));
    return null;
  }
}

/** The version a send should use: the published current version. Null when nothing is published. */
export async function getCurrentVersion(orgId: UUID, templateKeyOrId: string): Promise<{ template: Template; version: TemplateVersion } | null> {
  const template = await getTemplate(orgId, templateKeyOrId);
  if (!template) return null;
  if (!template.isActive) return null;
  if (!template.currentVersionId) return null;
  try {
    const r = rows(await db.execute(sql`
      SELECT * FROM mp_template_versions WHERE id = ${template.currentVersionId} AND org_id = ${orgId} LIMIT 1`));
    return r.length ? { template, version: toVersion(r[0]) } : null;
  } catch (e: any) {
    console.error('[mailplatform/templates] getCurrentVersion failed -', causeOf(e));
    return null;
  }
}

export async function listVersions(orgId: UUID, templateId: UUID, limit = 50): Promise<TemplateVersion[]> {
  try {
    const r = rows(await db.execute(sql`
      SELECT * FROM mp_template_versions WHERE org_id = ${orgId} AND template_id = ${templateId}
      ORDER BY version DESC LIMIT ${Math.min(limit, 200)}`));
    return r.map(toVersion);
  } catch (e: any) {
    console.error('[mailplatform/templates] listVersions failed -', causeOf(e));
    return [];
  }
}

const KEY_RE = /^[a-z0-9][a-z0-9-]{1,118}[a-z0-9]$/;

export async function createTemplate(input: {
  orgId: UUID;
  key: string;
  name: string;
  description?: string;
  category?: TemplateCategory;
}): Promise<{ ok: boolean; template?: Template; error?: string }> {
  const key = String(input.key || '').trim().toLowerCase();
  if (!KEY_RE.test(key)) {
    return { ok: false, error: 'Key must be 3-120 characters of lowercase letters, digits and hyphens, not starting or ending with a hyphen.' };
  }
  if (!String(input.name || '').trim()) return { ok: false, error: 'Name is required.' };
  try {
    const r = rows(await db.execute(sql`
      INSERT INTO mp_templates (org_id, key, name, description, category)
      VALUES (${input.orgId}, ${key}, ${String(input.name).trim().slice(0, 200)},
              ${input.description || null}, ${input.category || 'transactional'})
      RETURNING *`));
    return { ok: true, template: toTemplate(r[0]) };
  } catch (e: any) {
    const reason = causeOf(e);
    if (/duplicate key|unique/i.test(reason)) return { ok: false, error: `A template with the key "${key}" already exists.` };
    return { ok: false, error: reason };
  }
}

/**
 * Add a version, optionally publishing it.
 *
 * The version number is allocated by the database (`MAX(version) + 1` inside the INSERT), not read
 * and then written. Reading a max and inserting it back is a lost-update race: two people saving at
 * once both read 3, both write 4, and one edit disappears — or the unique index rejects the second
 * save with an error nobody can explain.
 */
export async function addVersion(input: {
  orgId: UUID;
  templateId: UUID;
  subject: string;
  htmlBody: string;
  textBody?: string | null;
  createdBy?: UUID | null;
  publish?: boolean;
}): Promise<{ ok: boolean; version?: TemplateVersion; error?: string }> {
  if (!String(input.subject || '').trim()) return { ok: false, error: 'A subject is required.' };
  if (!String(input.htmlBody || '').trim()) return { ok: false, error: 'An HTML body is required.' };

  const variables = extractVariables(input.subject, input.htmlBody, input.textBody);

  try {
    const r = rows(await db.execute(sql`
      INSERT INTO mp_template_versions (org_id, template_id, version, subject, html_body, text_body, variables, created_by, published_at)
      SELECT ${input.orgId}, ${input.templateId},
             COALESCE(MAX(version), 0) + 1,
             ${input.subject}, ${input.htmlBody}, ${input.textBody || null},
             ${JSON.stringify(variables)}::jsonb, ${input.createdBy || null},
             ${input.publish ? sql`NOW()` : sql`NULL`}
      FROM mp_template_versions WHERE template_id = ${input.templateId}
      RETURNING *`));

    if (!r.length) return { ok: false, error: 'The version was not written.' };
    const version = toVersion(r[0]);

    if (input.publish) {
      await db.execute(sql`
        UPDATE mp_templates SET current_version_id = ${version.id}, updated_at = NOW()
        WHERE id = ${input.templateId} AND org_id = ${input.orgId}`);
    }
    return { ok: true, version };
  } catch (e: any) {
    return { ok: false, error: causeOf(e) };
  }
}

/** Point the template at an existing version. Used to publish a draft or roll back to an old one. */
export async function publishVersion(
  orgId: UUID,
  templateId: UUID,
  versionId: UUID,
): Promise<{ ok: boolean; error?: string }> {
  try {
    // The version must belong to this template AND this org. Without both, a version id from
    // another tenant would publish into this one.
    const owned = rows(await db.execute(sql`
      SELECT id FROM mp_template_versions
      WHERE id = ${versionId} AND template_id = ${templateId} AND org_id = ${orgId} LIMIT 1`));
    if (!owned.length) return { ok: false, error: 'That version does not belong to this template.' };

    await db.execute(sql`UPDATE mp_template_versions SET published_at = COALESCE(published_at, NOW()) WHERE id = ${versionId}`);
    const r = rows(await db.execute(sql`
      UPDATE mp_templates SET current_version_id = ${versionId}, updated_at = NOW()
      WHERE id = ${templateId} AND org_id = ${orgId}
      RETURNING id`));
    return r.length ? { ok: true } : { ok: false, error: 'Template not found.' };
  } catch (e: any) {
    return { ok: false, error: causeOf(e) };
  }
}

/** Soft delete. The versions survive, so a message already sent can still be explained. */
export async function deleteTemplate(orgId: UUID, templateId: UUID): Promise<{ ok: boolean; removed: boolean; error?: string }> {
  try {
    const r = rows(await db.execute(sql`
      UPDATE mp_templates SET deleted_at = NOW(), is_active = false
      WHERE id = ${templateId} AND org_id = ${orgId} AND deleted_at IS NULL
      RETURNING id`));
    return { ok: true, removed: r.length > 0 };
  } catch (e: any) {
    return { ok: false, removed: false, error: causeOf(e) };
  }
}
