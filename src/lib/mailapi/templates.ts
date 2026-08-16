// src/lib/mailapi/templates.ts — versioned transactional templates.
//
// A TEMPLATE IS A NAME; ITS CONTENT IS ALWAYS A VERSION. Editing never mutates what production is
// sending — an edit produces a draft, and publishing moves the pointer. That is the whole reason for
// the split: without it, fixing a typo in the interview-invitation template silently changes the
// wording of every message already in flight, and there is no way to answer "what exactly did we
// send this candidate in March?" six months later. mailapi_messages records the version number it
// rendered from, so that question has an answer.
//
// EXACTLY ONE VERSION IS PUBLISHED AT A TIME. Publishing version 4 archives version 3. "Published"
// therefore means "the one production uses", not "one of several that were once approved", and
// resolution for a send is a single unambiguous lookup rather than a max() over states.
//
// PRODUCTION REFUSES DRAFTS. A production key sending against an unpublished version gets a 422
// naming the state, unless the request explicitly sets allow_draft — an override that is recorded on
// the message row and in the queued event, so a draft that reached a real recipient is visible
// afterwards rather than being a story nobody can reconstruct.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureMailApiSchema, rows } from './schema';
import { ApiError } from './errors';
import { extractVariables, validateTemplateSyntax, render, htmlToText } from './render';
import { isUuid, type Environment } from './keys';

export type VersionState = 'draft' | 'published' | 'archived';

export interface TemplateVersion {
  id: string;
  templateId: string;
  version: number;
  state: VersionState;
  subject: string;
  html: string;
  text: string | null;
  variables: string[];
  metadata: Record<string, any>;
  publishedAt: string | null;
  createdAt: string;
}

export interface Template {
  id: string;
  orgId: string;
  environment: Environment;
  key: string;
  name: string;
  description: string | null;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
  publishedVersion?: number | null;
  latestVersion?: number | null;
  versions?: TemplateVersion[];
}

function mapVersion(r: any): TemplateVersion {
  return {
    id: r.id,
    templateId: r.template_id,
    version: Number(r.version),
    state: r.state,
    subject: r.subject || '',
    html: r.html || '',
    text: r.text ?? null,
    variables: Array.isArray(r.variables) ? r.variables : [],
    metadata: r.metadata && typeof r.metadata === 'object' ? r.metadata : {},
    publishedAt: r.published_at || null,
    createdAt: r.created_at,
  };
}

function mapTemplate(r: any): Template {
  return {
    id: r.id,
    orgId: r.org_id,
    environment: r.environment,
    key: r.template_key,
    name: r.name,
    description: r.description || null,
    isArchived: r.is_archived === true,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    publishedVersion: r.published_version == null ? null : Number(r.published_version),
    latestVersion: r.latest_version == null ? null : Number(r.latest_version),
  };
}

/** Template keys are what integrations hard-code, so the rules are strict and stated. */
export function normalizeTemplateKey(raw: string): string {
  const k = String(raw || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return k.slice(0, 80);
}

export function assertTemplateKey(raw: string): string {
  const k = normalizeTemplateKey(raw);
  if (k.length < 3) {
    throw new ApiError('invalid_request', 'A template key needs at least 3 characters (letters, digits, dot, dash, underscore).', { param: 'key' });
  }
  return k;
}

const SELECT_TEMPLATE = sql`
  SELECT t.id, t.org_id, t.environment, t.template_key, t.name, t.description, t.is_archived, t.created_at, t.updated_at,
         (SELECT version FROM mailapi_template_versions v WHERE v.template_id = t.id AND v.state = 'published' ORDER BY version DESC LIMIT 1) AS published_version,
         (SELECT MAX(version) FROM mailapi_template_versions v WHERE v.template_id = t.id) AS latest_version
  FROM mailapi_templates t`;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listTemplates(orgId: string, environment: Environment, opts: { includeArchived?: boolean; limit?: number } = {}): Promise<Template[]> {
  await ensureMailApiSchema();
  const limit = Math.min(200, Math.max(1, opts.limit || 100));
  const r = rows(await db.execute(sql`
    ${SELECT_TEMPLATE}
    WHERE t.org_id = ${orgId} AND t.environment = ${environment}
      AND (${!!opts.includeArchived} OR t.is_archived = false)
    ORDER BY t.updated_at DESC LIMIT ${limit}`));
  return r.map(mapTemplate);
}

/** Look a template up by id or by key. Both are scoped to the caller's org AND environment. */
export async function getTemplate(orgId: string, environment: Environment, idOrKey: string): Promise<Template | null> {
  await ensureMailApiSchema();
  const byId = isUuid(idOrKey);
  const r = rows(await db.execute(sql`
    ${SELECT_TEMPLATE}
    WHERE t.org_id = ${orgId} AND t.environment = ${environment}
      AND (${byId} AND t.id = ${byId ? idOrKey.trim() : null}::uuid OR t.template_key = ${normalizeTemplateKey(idOrKey)})
    LIMIT 1`));
  return r[0] ? mapTemplate(r[0]) : null;
}

export async function getVersions(templateId: string, limit = 30): Promise<TemplateVersion[]> {
  await ensureMailApiSchema();
  return rows(await db.execute(sql`
    SELECT id, template_id, version, state, subject, html, text, variables, metadata, published_at, created_at
    FROM mailapi_template_versions WHERE template_id = ${templateId}
    ORDER BY version DESC LIMIT ${Math.min(100, limit)}`)).map(mapVersion);
}

export async function getVersion(templateId: string, version: number): Promise<TemplateVersion | null> {
  await ensureMailApiSchema();
  const r = rows(await db.execute(sql`
    SELECT id, template_id, version, state, subject, html, text, variables, metadata, published_at, created_at
    FROM mailapi_template_versions WHERE template_id = ${templateId} AND version = ${version} LIMIT 1`));
  return r[0] ? mapVersion(r[0]) : null;
}

export async function getPublishedVersion(templateId: string): Promise<TemplateVersion | null> {
  await ensureMailApiSchema();
  const r = rows(await db.execute(sql`
    SELECT id, template_id, version, state, subject, html, text, variables, metadata, published_at, created_at
    FROM mailapi_template_versions WHERE template_id = ${templateId} AND state = 'published'
    ORDER BY version DESC LIMIT 1`));
  return r[0] ? mapVersion(r[0]) : null;
}

export async function getLatestVersion(templateId: string): Promise<TemplateVersion | null> {
  await ensureMailApiSchema();
  const r = rows(await db.execute(sql`
    SELECT id, template_id, version, state, subject, html, text, variables, metadata, published_at, created_at
    FROM mailapi_template_versions WHERE template_id = ${templateId}
    ORDER BY version DESC LIMIT 1`));
  return r[0] ? mapVersion(r[0]) : null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface TemplateContent {
  subject: string;
  html: string;
  text?: string | null;
  metadata?: Record<string, any>;
}

function checkContent(c: TemplateContent): void {
  if (!c.subject || !String(c.subject).trim()) {
    throw new ApiError('invalid_request', 'A template needs a subject line.', { param: 'subject' });
  }
  if (!c.html || !String(c.html).trim()) {
    throw new ApiError('invalid_request', 'A template needs an HTML body.', { param: 'html' });
  }
  const errors = validateTemplateSyntax(c.subject, c.html, c.text || '');
  if (errors.length) {
    throw new ApiError('invalid_request', 'Template syntax: ' + errors.join(' '), { param: 'html', extra: { syntax_errors: errors } });
  }
}

export async function createTemplate(p: {
  orgId: string;
  environment: Environment;
  key: string;
  name: string;
  description?: string | null;
  content: TemplateContent;
  createdBy?: string | null;
  publish?: boolean;
}): Promise<{ template: Template; version: TemplateVersion }> {
  await ensureMailApiSchema();
  const key = assertTemplateKey(p.key);
  checkContent(p.content);
  const existing = await getTemplate(p.orgId, p.environment, key);
  if (existing) {
    throw new ApiError('invalid_request', 'A template with the key `' + key + '` already exists in ' + p.environment + '. PATCH it to add a version.', { param: 'key', extra: { template_id: existing.id } });
  }
  const t = rows(await db.execute(sql`
    INSERT INTO mailapi_templates (org_id, environment, template_key, name, description, created_by)
    VALUES (${p.orgId}, ${p.environment}, ${key}, ${p.name || key}, ${p.description || null}, ${p.createdBy || null})
    RETURNING id, org_id, environment, template_key, name, description, is_archived, created_at, updated_at`))[0];
  const version = await addVersion(t.id, p.content, { createdBy: p.createdBy, publish: p.publish });
  const template = (await getTemplate(p.orgId, p.environment, t.id))!;
  return { template, version };
}

/**
 * Add a version. Always a NEW version number — a version that already exists is never rewritten,
 * because a message row points at a version number and that pointer has to keep meaning what it did.
 */
export async function addVersion(templateId: string, content: TemplateContent, opts: { createdBy?: string | null; publish?: boolean } = {}): Promise<TemplateVersion> {
  await ensureMailApiSchema();
  checkContent(content);
  const variables = extractVariables(content.subject, content.html, content.text || '');
  const next = Number(rows(await db.execute(sql`
    SELECT COALESCE(MAX(version), 0) + 1 AS n FROM mailapi_template_versions WHERE template_id = ${templateId}`))[0]?.n || 1);
  const r = rows(await db.execute(sql`
    INSERT INTO mailapi_template_versions (template_id, version, state, subject, html, text, variables, metadata, created_by)
    VALUES (${templateId}, ${next}, 'draft', ${content.subject}, ${content.html}, ${content.text ?? null},
            ${JSON.stringify(variables)}::jsonb, ${JSON.stringify(content.metadata || {})}::jsonb, ${opts.createdBy || null})
    RETURNING id, template_id, version, state, subject, html, text, variables, metadata, published_at, created_at`));
  await db.execute(sql`UPDATE mailapi_templates SET updated_at = now() WHERE id = ${templateId}`);
  if (opts.publish) return (await publishVersion(templateId, next))!;
  return mapVersion(r[0]);
}

/** Publish a version and archive whatever was published before it. Returns null if it does not exist. */
export async function publishVersion(templateId: string, version: number): Promise<TemplateVersion | null> {
  await ensureMailApiSchema();
  const target = await getVersion(templateId, version);
  if (!target) return null;
  // Order matters: demote first, then promote. The reverse would leave two rows briefly published,
  // and a send landing in that window would have to pick one.
  await db.execute(sql`
    UPDATE mailapi_template_versions SET state = 'archived'
    WHERE template_id = ${templateId} AND state = 'published' AND version <> ${version}`);
  const r = rows(await db.execute(sql`
    UPDATE mailapi_template_versions SET state = 'published', published_at = now()
    WHERE template_id = ${templateId} AND version = ${version}
    RETURNING id, template_id, version, state, subject, html, text, variables, metadata, published_at, created_at`));
  await db.execute(sql`UPDATE mailapi_templates SET updated_at = now() WHERE id = ${templateId}`);
  return r[0] ? mapVersion(r[0]) : null;
}

/** Unpublish: production sends stop resolving. The version is kept, not deleted. */
export async function unpublishVersion(templateId: string, version: number): Promise<boolean> {
  await ensureMailApiSchema();
  const r = rows(await db.execute(sql`
    UPDATE mailapi_template_versions SET state = 'draft', published_at = NULL
    WHERE template_id = ${templateId} AND version = ${version} AND state = 'published' RETURNING id`));
  return r.length > 0;
}

export async function updateTemplateMeta(templateId: string, p: { name?: string; description?: string | null }): Promise<boolean> {
  await ensureMailApiSchema();
  const r = rows(await db.execute(sql`
    UPDATE mailapi_templates
    SET name = COALESCE(${p.name ?? null}, name),
        description = COALESCE(${p.description ?? null}, description),
        updated_at = now()
    WHERE id = ${templateId} RETURNING id`));
  return r.length > 0;
}

/**
 * DELETE archives. It does not drop rows.
 *
 * Messages reference their template and version, and an audit that cannot resolve the template a
 * letter came from is not an audit. Archiving removes it from listings and refuses new sends, which
 * is every effect a caller wants from a delete, without destroying the record of what was sent.
 */
export async function archiveTemplate(templateId: string, archived = true): Promise<boolean> {
  await ensureMailApiSchema();
  const r = rows(await db.execute(sql`
    UPDATE mailapi_templates SET is_archived = ${archived}, updated_at = now()
    WHERE id = ${templateId} AND is_archived IS DISTINCT FROM ${archived} RETURNING id`));
  return r.length > 0;
}

/**
 * Copy a template's published (or latest) version into another environment.
 *
 * This is the promotion path that makes environment separation liveable. Without it, "templates are
 * environment-scoped" would mean retyping every template three times, and somebody would eventually
 * hand production a development key instead.
 */
export async function copyTemplateToEnvironment(p: {
  orgId: string; fromEnvironment: Environment; toEnvironment: Environment; key: string; publish?: boolean; createdBy?: string | null;
}): Promise<{ template: Template; version: TemplateVersion }> {
  const source = await getTemplate(p.orgId, p.fromEnvironment, p.key);
  if (!source) throw new ApiError('template_not_found', 'No template `' + p.key + '` in ' + p.fromEnvironment + '.', { param: 'key' });
  const sv = (await getPublishedVersion(source.id)) || (await getLatestVersion(source.id));
  if (!sv) throw new ApiError('template_not_found', 'Template `' + p.key + '` has no versions to copy.');
  const content: TemplateContent = { subject: sv.subject, html: sv.html, text: sv.text, metadata: { ...sv.metadata, copied_from: p.fromEnvironment + '@v' + sv.version } };
  const target = await getTemplate(p.orgId, p.toEnvironment, source.key);
  if (target) {
    const version = await addVersion(target.id, content, { createdBy: p.createdBy, publish: p.publish });
    return { template: (await getTemplate(p.orgId, p.toEnvironment, target.id))!, version };
  }
  return createTemplate({
    orgId: p.orgId, environment: p.toEnvironment, key: source.key, name: source.name,
    description: source.description, content, createdBy: p.createdBy, publish: p.publish,
  });
}

// ---------------------------------------------------------------------------
// Resolution for a send
// ---------------------------------------------------------------------------

export interface ResolvedTemplate {
  template: Template;
  version: TemplateVersion;
  /** True when a non-published version was used under an explicit override. */
  overridden: boolean;
}

export async function resolveForSend(p: {
  orgId: string;
  environment: Environment;
  idOrKey: string;
  version?: number | null;
  allowDraft?: boolean;
}): Promise<ResolvedTemplate> {
  const template = await getTemplate(p.orgId, p.environment, p.idOrKey);
  if (!template) {
    throw new ApiError('template_not_found', 'No template `' + p.idOrKey + '` in the ' + p.environment + ' environment.', { param: 'template_id' });
  }
  if (template.isArchived) {
    throw new ApiError('template_not_found', 'Template `' + template.key + '` is archived and cannot be sent.', { param: 'template_id' });
  }

  if (p.version != null) {
    const v = await getVersion(template.id, p.version);
    if (!v) throw new ApiError('template_not_found', 'Template `' + template.key + '` has no version ' + p.version + '.', { param: 'template_version' });
    const needsOverride = v.state !== 'published' && p.environment === 'production';
    if (needsOverride && !p.allowDraft) {
      throw new ApiError('template_not_published', 'Version ' + p.version + ' of `' + template.key + '` is ' + v.state + '. Production sends need a published version, or set options.allow_draft to true.', { param: 'template_version' });
    }
    return { template, version: v, overridden: v.state !== 'published' };
  }

  const published = await getPublishedVersion(template.id);
  if (published) return { template, version: published, overridden: false };

  // Nothing published. Outside production a draft is the sensible default — that is what a
  // development environment is for. In production it is refused unless explicitly overridden.
  const latest = await getLatestVersion(template.id);
  if (!latest) throw new ApiError('template_not_found', 'Template `' + template.key + '` has no versions yet.', { param: 'template_id' });
  if (p.environment === 'production' && !p.allowDraft) {
    throw new ApiError('template_not_published', 'Template `' + template.key + '` has no published version. Publish version ' + latest.version + ', or set options.allow_draft to true.', { param: 'template_id' });
  }
  return { template, version: latest, overridden: true };
}

// ---------------------------------------------------------------------------
// Preview / test render
// ---------------------------------------------------------------------------

export interface RenderedTemplate {
  subject: string;
  html: string;
  text: string;
  missing: string[];
  truncated: boolean;
}

/**
 * Render a version against a variable set.
 *
 * The subject is rendered WITHOUT HTML escaping — a subject line is not markup, and escaping it
 * turns "Smith & Co" into "Smith &amp; Co" in the recipient's inbox list. The HTML body is escaped;
 * the text part is not, because it is already plain.
 */
export function renderVersion(version: { subject: string; html: string; text?: string | null }, variables: Record<string, any>): RenderedTemplate {
  const subject = render(version.subject, variables, { escape: false });
  const html = render(version.html, variables, { escape: true });
  const textSource = version.text && version.text.trim() ? version.text : null;
  const text = textSource ? render(textSource, variables, { escape: false }) : { output: htmlToText(html.output), missing: [], truncated: false };
  const missing = Array.from(new Set([...subject.missing, ...html.missing, ...text.missing])).sort();
  return {
    subject: subject.output,
    html: html.output,
    text: text.output,
    missing,
    truncated: subject.truncated || html.truncated || text.truncated,
  };
}
