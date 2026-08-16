// POST /api/mail/segments — build, preview, save and delete dynamic segments.
//
// EVALUATED SERVER-SIDE, ALWAYS. The browser posts a condition TREE. It never posts SQL, never
// posts a contact id list, and never decides who matches. The tree is validated against the field
// catalog (src/lib/mail-segments.ts) before it reaches the compiler, and the compiler emits only
// hard-coded column expressions with every value as a bound parameter.
import type { APIRoute } from 'astro';
import { denyAdminApi } from '@/lib/auth/api-guard';
import {
  validateSegment, describeSegment, matchesEveryone, compileSegment,
  FIELDS, ACTIVITY_KINDS, OP_LABELS, type SegmentNode,
} from '@/lib/mail-segments';
import {
  countSegment, sampleSegment, saveSegment, deleteSegment, listSegments, getSegment,
  listsWithCounts, allTags, isUuid, dbReason, type Actor,
} from '@/lib/mail-contacts';

function json(d: any, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store' } });
}

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = await denyAdminApi(locals, { permission: 'mail.manage', label: 'mail.segments' });
  if (denied) return denied;
  const user = (locals as any).user;
  const actor: Actor = { userId: user?.id || null, name: user?.name || user?.email || 'admin' };

  let body: any = {};
  try { body = await request.json(); } catch { return json({ ok: false, error: 'invalid JSON' }, 400); }
  const action = String(body.action || 'preview');

  try {
    if (action === 'catalog') {
      return json({
        ok: true,
        fields: FIELDS,
        activityKinds: ACTIVITY_KINDS,
        opLabels: OP_LABELS,
        lists: (await listsWithCounts()).map((l) => ({ id: l.id, name: l.name, count: l.member_count })),
        tags: await allTags(),
      });
    }

    if (action === 'preview') {
      const node = body.definition as SegmentNode;
      const issues = validateSegment(node);
      const errors = issues.filter((i) => i.level === 'error').map((i) => i.message);
      if (errors.length) return json({ ok: false, errors, issues });

      const count = await countSegment(node);
      const sample = await sampleSegment(node, Math.min(20, Number(body.sampleSize) || 8));
      return json({
        ok: true,
        count,
        issues,
        warnings: issues.filter((i) => i.level === 'warning').map((i) => i.message),
        matchesEveryone: matchesEveryone(node),
        description: describeSegment(node),
        // The compiled predicate WITHOUT its parameters, for the diagnostics panel. Values are
        // deliberately withheld: they are already on the operator's screen and echoing them back
        // through an endpoint is a needless second copy.
        predicate: compileSegment(node).text,
        sample: sample.map((c) => ({
          id: c.id, email: c.email, name: [c.first_name, c.last_name].filter(Boolean).join(' '),
          organization: c.organization, status: c.status,
        })),
      });
    }

    if (action === 'save') {
      const r = await saveSegment({
        id: body.id || null,
        name: String(body.name || ''),
        description: String(body.description || ''),
        definition: body.definition as SegmentNode,
      }, actor);
      return json(r, r.ok ? 200 : 400);
    }

    if (action === 'delete') {
      const r = await deleteSegment(String(body.id || ''));
      return json(r, r.ok ? 200 : 400);
    }

    if (action === 'list') {
      return json({ ok: true, segments: await listSegments() });
    }

    if (action === 'get') {
      if (!isUuid(body.id)) return json({ ok: false, error: 'That segment id is not valid.' }, 400);
      const seg = await getSegment(String(body.id));
      return seg ? json({ ok: true, segment: seg }) : json({ ok: false, error: 'That segment no longer exists.' }, 404);
    }

    return json({ ok: false, error: 'Unknown action "' + action + '".' }, 400);
  } catch (e: any) {
    console.error('[api/mail/segments] ' + action + ':', dbReason(e));
    return json({ ok: false, error: 'The segment could not be evaluated: ' + dbReason(e) }, 500);
  }
};
