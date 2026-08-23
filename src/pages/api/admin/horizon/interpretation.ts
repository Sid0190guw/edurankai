// GET/POST /api/admin/horizon/interpretation — PATCH 03's only HTTP surface.
//
// GET  ?kind=&id=&purpose=[&history=1]   read the latest interpretation, or the run history
// POST { action: 'compute' | 'object' }  produce a new interpretation, or record a disagreement
//
// THREE CAPABILITIES, THREE ACTS. `horizon.interpretation.view` reads the neutral dimensions,
// `horizon.interpretation.compute` causes one to be produced, `horizon.interpretation.trace` adds
// the internal computation. The trace is resolved into the VIEWER PROJECTION rather than into a
// template flag, so an account without it receives an object with no trace in it — a field hidden by
// a template is a field one JSON endpoint away from being visible, and this IS that JSON endpoint.
//
// EVERY READ NEEDS A STATED PURPOSE, and the read fails closed: the store writes the audit row
// before it returns anything, and hands back a refusal if that write did not land. "Why were you
// looking at that" must have an answer that is not "I was curious".
//
// THE FAILURE PATH DOES NOT ANSWER 200. This project has shipped a write endpoint that reported
// every failure as a success; the status here tells the truth and the reason goes to the log.
import type { APIRoute } from 'astro';
import { can } from '@/lib/auth/permissions';
import {
  connectFoundationalEngine,
  interpretSubject,
  interpretationHistory,
  latestInterpretation,
  recordObjection,
  isSubject,
  isDimensionId,
  type HorizonSubject,
  type ViewerCapabilities,
} from '@/lib/horizon/interpretation';

// Declared ABOVE the handlers that use them: `const` is not hoisted, and a handler reaching a later
// declaration has taken pages down on this project.
const j = (d: any, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
const reasonOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');

function subjectFrom(kind: unknown, id: unknown): HorizonSubject | null {
  const s = { kind: String(kind || ''), id: String(id || '') } as HorizonSubject;
  return isSubject(s) ? s : null;
}

// DEPLOYMENT WIRING, IN ONE PLACE. The library holds a provider slot; something has to fill it, and
// a module that registers itself on import is a side effect nobody can see. This is idempotent and
// refuses to displace a provider something else already registered.
connectFoundationalEngine();

function capsFor(user: any): ViewerCapabilities {
  return {
    view: can(user, 'horizon.interpretation.view'),
    trace: can(user, 'horizon.interpretation.trace'),
  };
}

export const GET: APIRoute = async ({ url, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);
  const caps = capsFor(user);
  if (!caps.view) return j({ ok: false, error: 'not permitted: horizon.interpretation.view' }, 403);

  const subject = subjectFrom(url.searchParams.get('kind'), url.searchParams.get('id'));
  if (!subject) return j({ ok: false, error: 'kind (employee|candidate|learner) and id are required' }, 400);
  const purpose = String(url.searchParams.get('purpose') || '').trim();
  if (!purpose) return j({ ok: false, error: 'a stated purpose is required to open an interpretation' }, 400);

  try {
    if (url.searchParams.get('history')) {
      const h = await interpretationHistory(subject, { actorUserId: user.id, caps, purpose });
      if (!h.ok) return j({ ok: false, error: h.error || 'could not read the history' }, 503);
      return j({ ok: true, entries: h.entries, movements: h.movements });
    }
    const r = await latestInterpretation(subject, { actorUserId: user.id, caps, purpose });
    if (!r.ok) return j({ ok: false, error: r.error || 'could not read the interpretation' }, 503);
    if (!r.found) {
      return j({
        ok: true,
        found: false,
        // Not an error, and deliberately not an empty interpretation: nothing on record is a
        // complete, correct answer, and rendering it as a set of blank dimensions would not be.
        message: 'Nothing has been interpreted for this person. There is no record to show.',
      });
    }
    return j({ ok: true, found: true, id: r.interpretation!.id, interpretation: r.interpretation!.result });
  } catch (e: any) {
    console.error('[horizon-interpretation] GET', reasonOf(e));
    return j({ ok: false, error: 'the interpretation could not be read' }, 500);
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const user = (locals as any)?.user;
  if (!user) return j({ ok: false, error: 'sign in required' }, 401);

  let b: any = {};
  try {
    b = await request.json();
  } catch {
    return j({ ok: false, error: 'bad json' }, 400);
  }
  const action = String(b.action || '');

  try {
    if (action === 'compute') {
      if (!can(user, 'horizon.interpretation.compute')) {
        return j({ ok: false, error: 'not permitted: horizon.interpretation.compute' }, 403);
      }
      const subject = subjectFrom(b.kind, b.id);
      if (!subject) return j({ ok: false, error: 'kind and id are required' }, 400);

      const outcome = await interpretSubject(subject, {
        actorUserId: user.id,
        // A dry run computes and discards. Anything else is recorded — including a refusal, which is
        // the row that proves the system declined to say something about this person that day.
        persist: b.dryRun !== true,
      });
      // The COMPUTE response is projected too. Producing an interpretation does not confer sight of
      // the computation behind it, and this is the one path where the two are easy to conflate.
      const { projectForViewer } = await import('@/lib/horizon/interpretation');
      return j({
        ok: true,
        id: outcome.interpretationId,
        provider: outcome.providerName,
        interpretation: projectForViewer(outcome.result, capsFor(user)),
      });
    }

    if (action === 'object') {
      // NOT gated on a capability. Recording a disagreement is the counterweight to the whole layer,
      // and a person able to see something they believe is wrong must be able to say so beside it.
      // The objection is an append-only audit row; it changes no dimension and overwrites nothing.
      const statement = String(b.statement || '').trim();
      if (!b.interpretationId || !statement) {
        return j({ ok: false, error: 'interpretationId and a written statement are required' }, 400);
      }
      const dimension = isDimensionId(b.dimension) ? b.dimension : null;
      const r = await recordObjection({
        interpretationId: String(b.interpretationId),
        byUserId: user.id,
        dimension,
        statement,
      });
      return r.ok ? j({ ok: true }) : j({ ok: false, error: r.error }, 503);
    }

    return j({ ok: false, error: 'unknown action' }, 400);
  } catch (e: any) {
    console.error('[horizon-interpretation] POST ' + action, reasonOf(e));
    return j({ ok: false, error: 'the request could not be completed' }, 500);
  }
};
