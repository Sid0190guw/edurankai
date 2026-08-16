// src/lib/mail-product/templates.ts — templates and their versions.
//
// email_templates ALREADY EXISTS and holds live rows authored on /admin/mail/templates. This module
// extends that table rather than starting a second one, so a template written on the old screen
// opens in the new builder and vice versa. The columns it adds (blocks, kind, version, preheader,
// is_system) are created by ensureMailProductSchema().
//
// A VERSION IS AN IMMUTABLE SNAPSHOT. saveTemplate() writes the new content AND appends a row to
// mail_template_versions before it returns. That is what lets a campaign report still show what was
// actually sent after somebody edits the template it was built from.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureMailProductSchema } from './schema';
import { renderDocument, coerceDocument, emptyDocument, type EmailDocument } from './blocks';
import { rowsOf, reasonOf, isUuid, str, slugify, clampInt } from './common';

export type TemplateKind = 'campaign' | 'transactional' | 'system';

export interface Template {
  id: string;
  template_key: string;
  subject: string;
  preheader: string | null;
  body_html: string;
  body_text: string | null;
  description: string | null;
  blocks: unknown;
  kind: TemplateKind;
  version: number;
  is_active: boolean;
  is_system: boolean;
  created_at: string;
  updated_at: string;
}

export async function listTemplates(opts: { kind?: string; q?: string } = {}): Promise<Template[]> {
  await ensureMailProductSchema();
  let where = sql`TRUE`;
  if (opts.kind && ['campaign', 'transactional', 'system'].includes(opts.kind)) where = sql`${where} AND kind = ${opts.kind}`;
  if (opts.q) {
    const like = '%' + opts.q.toLowerCase().slice(0, 120) + '%';
    where = sql`${where} AND (lower(template_key) LIKE ${like} OR lower(subject) LIKE ${like} OR lower(coalesce(description,'')) LIKE ${like})`;
  }
  const r = await db.execute(sql`
    SELECT id, template_key, subject, preheader, body_html, body_text, description, blocks,
           kind, version, is_active, is_system, created_at, updated_at
    FROM email_templates WHERE ${where} ORDER BY updated_at DESC LIMIT 200`);
  return rowsOf<Template>(r);
}

export async function getTemplate(id: string): Promise<Template | null> {
  if (!isUuid(id)) return null;
  await ensureMailProductSchema();
  const r = await db.execute(sql`SELECT * FROM email_templates WHERE id = ${id} LIMIT 1`);
  return rowsOf<Template>(r)[0] || null;
}

export async function listVersions(templateId: string, limit = 30): Promise<any[]> {
  if (!isUuid(templateId)) return [];
  const r = await db.execute(sql`
    SELECT v.id, v.version, v.subject, v.note, v.created_at, u.name AS author
    FROM mail_template_versions v LEFT JOIN users u ON u.id = v.created_by
    WHERE v.template_id = ${templateId} ORDER BY v.version DESC LIMIT ${clampInt(limit, 1, 100, 30)}`);
  return rowsOf(r);
}

export async function getVersion(templateId: string, version: number): Promise<any | null> {
  if (!isUuid(templateId)) return null;
  const r = await db.execute(sql`
    SELECT * FROM mail_template_versions WHERE template_id = ${templateId} AND version = ${version} LIMIT 1`);
  return rowsOf(r)[0] || null;
}

export async function createTemplate(input: { name: string; kind?: TemplateKind; createdBy?: string | null }): Promise<{ id: string | null; error?: string }> {
  await ensureMailProductSchema();
  const key = slugify(input.name) || 'untitled';
  const doc = emptyDocument();
  const rendered = renderDocument(doc);
  try {
    const r = await db.execute(sql`
      INSERT INTO email_templates (template_key, subject, preheader, body_html, body_text, description, blocks, kind, version, created_by)
      VALUES (${key}, ${str(input.name, 200)}, NULL, ${rendered.html}, ${rendered.text}, NULL,
              ${JSON.stringify(doc)}::jsonb, ${input.kind === 'transactional' ? 'transactional' : 'campaign'}, 1,
              ${isUuid(input.createdBy || '') ? input.createdBy : null})
      RETURNING id`);
    const id = rowsOf(r)[0]?.id ?? null;
    if (id) await snapshot(id, 1, { subject: str(input.name, 200), preheader: null, html: rendered.html, text: rendered.text, blocks: doc, note: 'Created', by: input.createdBy || null });
    return { id };
  } catch (e: any) {
    console.error('[mail-product] template create failed:', reasonOf(e));
    return { id: null, error: reasonOf(e) };
  }
}

async function snapshot(
  templateId: string, version: number,
  v: { subject: string; preheader: string | null; html: string; text: string; blocks: EmailDocument | null; note: string; by: string | null },
): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO mail_template_versions (template_id, version, subject, preheader, body_html, body_text, blocks, note, created_by)
      VALUES (${templateId}, ${version}, ${v.subject}, ${v.preheader}, ${v.html}, ${v.text},
              ${v.blocks ? JSON.stringify(v.blocks) : null}::jsonb, ${str(v.note, 200)},
              ${isUuid(v.by || '') ? v.by : null})
      ON CONFLICT (template_id, version) DO NOTHING`);
  } catch (e: any) {
    // A failed snapshot must not lose the edit itself — but it is never silent, because a version
    // history with a hole in it is worse than one that is known to be incomplete.
    console.error('[mail-product] template version snapshot failed:', reasonOf(e));
  }
}

export interface SaveTemplateInput {
  subject?: string;
  preheader?: string;
  description?: string;
  templateKey?: string;
  kind?: TemplateKind;
  blocks?: unknown;
  /** Raw HTML, for a template authored outside the builder. Ignored when `blocks` is present. */
  html?: string;
  note?: string;
  by?: string | null;
}

export async function saveTemplate(id: string, input: SaveTemplateInput): Promise<{ ok: boolean; version?: number; error?: string }> {
  if (!isUuid(id)) return { ok: false, error: 'Unknown template.' };
  const current = await getTemplate(id);
  if (!current) return { ok: false, error: 'Unknown template.' };
  if (current.is_system) return { ok: false, error: 'This is a system template. Duplicate it and edit the copy — the original is used by transactional sends.' };

  let html = current.body_html;
  let text = current.body_text || '';
  let doc: EmailDocument | null = null;
  if (input.blocks !== undefined) {
    doc = coerceDocument(input.blocks);
    if (input.preheader !== undefined) doc.settings = { ...(doc.settings || {}), preheader: str(input.preheader, 200) };
    const out = renderDocument(doc);
    html = out.html; text = out.text;
  } else if (input.html !== undefined) {
    html = String(input.html).slice(0, 400000);
    text = '';
  }

  const version = (Number(current.version) || 1) + 1;
  const subject = input.subject !== undefined ? str(input.subject, 300) : current.subject;
  const preheader = input.preheader !== undefined ? str(input.preheader, 200) : current.preheader;

  try {
    await db.execute(sql`
      UPDATE email_templates SET
        subject = ${subject},
        preheader = ${preheader},
        description = COALESCE(${input.description !== undefined ? str(input.description, 500) : null}, description),
        template_key = COALESCE(${input.templateKey !== undefined ? slugify(input.templateKey) : null}, template_key),
        kind = COALESCE(${input.kind && ['campaign', 'transactional'].includes(input.kind) ? input.kind : null}, kind),
        body_html = ${html}, body_text = ${text},
        blocks = ${doc ? sql`${JSON.stringify(doc)}::jsonb` : sql`blocks`},
        version = ${version}, updated_at = now()
      WHERE id = ${id}`);
    await snapshot(id, version, { subject, preheader, html, text, blocks: doc, note: input.note || 'Edited', by: input.by || null });
    return { ok: true, version };
  } catch (e: any) {
    console.error('[mail-product] template save failed:', reasonOf(e));
    return { ok: false, error: 'This template was NOT saved: ' + reasonOf(e) };
  }
}

/** Restore an old version by SAVING IT FORWARD as a new one. History is never rewritten. */
export async function restoreVersion(id: string, version: number, by: string | null): Promise<{ ok: boolean; error?: string }> {
  const v = await getVersion(id, version);
  if (!v) return { ok: false, error: 'That version does not exist.' };
  return saveTemplate(id, {
    subject: v.subject, preheader: v.preheader || undefined,
    blocks: v.blocks ?? undefined, html: v.blocks ? undefined : v.body_html,
    note: `Restored version ${version}`, by,
  });
}

export async function duplicateTemplate(id: string, by: string | null): Promise<{ id: string | null; error?: string }> {
  const t = await getTemplate(id);
  if (!t) return { id: null, error: 'Unknown template.' };
  try {
    const r = await db.execute(sql`
      INSERT INTO email_templates (template_key, subject, preheader, body_html, body_text, description, blocks, kind, version, created_by)
      VALUES (${t.template_key + '-copy'}, ${t.subject}, ${t.preheader}, ${t.body_html}, ${t.body_text},
              ${t.description}, ${t.blocks ? sql`${JSON.stringify(t.blocks)}::jsonb` : null}, ${t.kind}, 1,
              ${isUuid(by || '') ? by : null})
      RETURNING id`);
    return { id: rowsOf(r)[0]?.id ?? null };
  } catch (e: any) {
    return { id: null, error: reasonOf(e) };
  }
}

export async function setTemplateActive(id: string, active: boolean): Promise<boolean> {
  if (!isUuid(id)) return false;
  const r = await db.execute(sql`UPDATE email_templates SET is_active = ${active}, updated_at = now() WHERE id = ${id} RETURNING id`);
  return rowsOf(r).length > 0;
}

export async function deleteTemplate(id: string): Promise<{ ok: boolean; error?: string }> {
  if (!isUuid(id)) return { ok: false, error: 'Unknown template.' };
  const t = await getTemplate(id);
  if (t?.is_system) return { ok: false, error: 'A system template cannot be deleted — transactional sends read it by key.' };
  // A template a campaign was built from is not deletable: the campaign's template_id would go null
  // and the report would lose the name of what it sent.
  const used = rowsOf(await db.execute(sql`SELECT count(*)::int AS n FROM mail_campaigns WHERE template_id = ${id}`))[0];
  if (Number(used?.n) > 0) {
    return { ok: false, error: `${used.n} campaign(s) were built from this template. Switch it off instead — deleting it would leave those reports unable to say what they sent.` };
  }
  const r = await db.execute(sql`DELETE FROM email_templates WHERE id = ${id} RETURNING id`);
  return { ok: rowsOf(r).length > 0 };
}
