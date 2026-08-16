// /api/mail/product/templates — templates, their versions, and the ONE renderer.
//
//   GET  ?id= | ?kind=&q=
//   GET  ?id=&versions=1
//   POST { action: 'create' | 'save' | 'duplicate' | 'active' | 'delete' | 'restore' | 'render' }
//
// 'render' IS WHY THE PREVIEW IS TRUSTWORTHY. The builder posts its document here and gets back the
// exact HTML renderDocument() produces — the same function, on the same input, that campaigns.ts
// calls when it sends. The browser owns no second copy of the block renderer, so the desktop preview,
// the mobile preview, the HTML tab and the message that arrives cannot disagree.
import type { APIRoute } from 'astro';
import { denyMailApi } from '@/lib/auth/mail-access';
import {
  listTemplates, getTemplate, createTemplate, saveTemplate, duplicateTemplate,
  setTemplateActive, deleteTemplate, listVersions, getVersion, restoreVersion,
} from '@/lib/mail-product/templates';
import { renderDocument, coerceDocument, documentVariables } from '@/lib/mail-product/blocks';
import { personalizeMessage, MERGE_VARIABLES, VARIABLE_KEYS } from '@/lib/mail-product/personalize';
import { json, fail, reasonOf, str } from '@/lib/mail-product/common';

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = await denyMailApi(locals, { label: 'mail.product.templates.read' });
  if (denied) return denied;
  const url = new URL(request.url);
  const id = url.searchParams.get('id');

  try {
    if (id && url.searchParams.get('versions')) {
      const v = url.searchParams.get('version');
      if (v) return json({ ok: true, version: await getVersion(id, Number(v)) });
      return json({ ok: true, versions: await listVersions(id) });
    }
    if (id) {
      const template = await getTemplate(id);
      if (!template) return fail('No template with that id.', 404);
      return json({ ok: true, template, versions: await listVersions(id, 10) });
    }
    return json({
      ok: true,
      rows: await listTemplates({ kind: str(url.searchParams.get('kind'), 20), q: str(url.searchParams.get('q'), 120) }),
      variables: MERGE_VARIABLES,
    });
  } catch (e: any) {
    console.error('[api/mail/product/templates] read failed:', reasonOf(e));
    return fail('Templates could not be read just now.', 500);
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await denyMailApi(locals, { label: 'mail.product.templates.write' });
  if (denied) return denied;
  const user = (locals as any).user;

  let body: any = {};
  try { body = await request.json(); } catch { return fail('The request body was not valid JSON.'); }
  const action = str(body.action, 40);
  const id = str(body.id, 40);

  try {
    switch (action) {
      // ---- Render: no database, no writes. Pure, and the fastest thing in the product. ----------
      case 'render': {
        const doc = coerceDocument(body.blocks);
        const out = renderDocument(doc, { inline: !!body.inline });
        const used = documentVariables(doc);
        const unknown = used.filter((v) => !VARIABLE_KEYS.includes(v));

        // Preview fills tokens with the catalogue's samples so the author sees a realistic message —
        // and `unknown` still travels back, so the screen can warn that {{typo_name}} will send blank
        // rather than showing a plausible-looking preview of a message that will not look like that.
        const filled = body.personalize === false ? { subject: str(body.subject, 300), html: out.html, text: out.text, missing: [] }
          : personalizeMessage(
              { subject: str(body.subject, 300), html: out.html, text: out.text },
              { missing: 'sample', campaignName: str(body.campaignName, 160) || 'Preview' },
            );

        return json({ ok: true, html: filled.html, text: filled.text, subject: filled.subject, variables: used, unknown });
      }

      case 'create': {
        const res = await createTemplate({ name: str(body.name, 200), kind: body.kind, createdBy: user?.id });
        return res.id ? json({ ok: true, id: res.id }) : fail(res.error || 'The template was not created.', 500);
      }

      case 'save': {
        const res = await saveTemplate(id, {
          subject: body.subject, preheader: body.preheader, description: body.description,
          templateKey: body.templateKey, kind: body.kind,
          blocks: body.blocks, html: body.html, note: str(body.note, 200), by: user?.id,
        });
        return res.ok ? json({ ok: true, version: res.version }) : fail(res.error || 'The template was not saved.');
      }

      case 'duplicate': {
        const res = await duplicateTemplate(id, user?.id ?? null);
        return res.id ? json({ ok: true, id: res.id }) : fail(res.error || 'The template was not duplicated.');
      }

      case 'active': {
        const done = await setTemplateActive(id, !!body.active);
        return done ? json({ ok: true }) : fail('No template with that id.', 404);
      }

      case 'restore': {
        const res = await restoreVersion(id, Number(body.version), user?.id ?? null);
        return res.ok
          ? json({ ok: true, note: 'Restored as a new version. Nothing in the history was overwritten.' })
          : fail(res.error || 'That version was not restored.');
      }

      case 'delete': {
        const res = await deleteTemplate(id);
        return res.ok ? json({ ok: true }) : fail(res.error || 'No template with that id.', 400);
      }

      default:
        return fail('Unknown action: ' + (action || '(none)'));
    }
  } catch (e: any) {
    console.error('[api/mail/product/templates] ' + action + ' failed:', reasonOf(e));
    return fail('That did not go through, and the template is unchanged.', 500);
  }
};
