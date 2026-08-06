// GET /api/portal/projects/allocation — is this person already committed elsewhere?
//
// WHAT IT IS FOR. On the project page, whoever runs a project types a percentage into "add somebody
// to this project". The one thing they need at that moment, and the one thing no form can know, is
// whether that person is already at 90% on two other projects. Without it the over-allocation is
// only discovered after the membership is written, by which point somebody's month has been promised
// twice. This endpoint answers it before the POST.
//
// IT IS AN ENHANCEMENT, NEVER THE MECHANISM. The project page recomputes the same figure server-side
// on every render and after every write, from the same allocationFor() this route calls. With
// JavaScript off, the warning appears one step later and says exactly the same thing. Nothing here
// decides anything, and nothing here is the only place a person can learn this.
//
// WHAT IT DISCLOSES, AND THE FENCE AROUND IT. For ONE named employee it returns the project codes,
// capacities and percentages they are committed to — including projects the caller cannot open,
// because a total that excluded them would be wrong in the one direction that matters. It returns no
// task, no description, no cost and no personal detail of any kind.
//
// THE GATE IS THE PROJECT, RESOLVED PER ROW. The caller must be able to EDIT the project named in
// the query — which means the Organization Graph records them as running it, or they hold
// projects.manage. Not "signed in", not "is on some project", and not a role name anywhere: the
// answer comes from projectAuthority(), which re-derives it from the graph and the capability matrix
// on every request. An empty graph therefore refuses, which is the correct direction to fail.
import type { APIRoute } from 'astro';
import { projectAuthority, allocationFor, GRAPH_NOT_READY } from '@/lib/projects';

export const prerender = false;

// Declared above the handler that reads them: `const` is not hoisted, and a const under the handler
// throws on that handler's first line while the request still looks like it ran.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** One sentence for every refusal, so probing ids cannot map the portfolio. */
const NOT_AVAILABLE = 'That project is not available.';

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    // A per-viewer answer about a named person. It must never land in a shared cache.
    headers: { 'Content-Type': 'application/json', 'cache-control': 'private, no-store' },
  });
}

export const GET: APIRoute = async ({ locals, url }) => {
  const user = (locals as any)?.user;
  if (!user?.id) return json({ ok: false, error: 'Please sign in.' }, 401);

  const projectId = String(url.searchParams.get('projectId') || '').trim();
  const employeeId = String(url.searchParams.get('employeeId') || '').trim();
  if (!UUID_RE.test(projectId) || !UUID_RE.test(employeeId)) {
    return json({ ok: false, error: NOT_AVAILABLE }, 400);
  }

  const auth = await projectAuthority(user, projectId);
  if (!auth.mayEdit) {
    // The same sentence whether the project does not exist or is not theirs to staff — an id prober
    // learns nothing either way. When the graph is empty the honest reason is said instead, because
    // "not yours" would be a lie: nobody runs anything until the backfill has been run.
    return json({ ok: false, error: auth.graphReady ? NOT_AVAILABLE : GRAPH_NOT_READY }, 403);
  }

  const rawFrom = String(url.searchParams.get('from') || '').trim();
  const rawTo = String(url.searchParams.get('to') || '').trim();
  const from = DATE_RE.test(rawFrom) ? rawFrom : null;
  const to = DATE_RE.test(rawTo) ? rawTo : null;

  const view = await allocationFor([employeeId], { from, to });
  const person = view.people.find((p) => p.employeeId === employeeId) || null;

  // ok:false when the read did not happen. A client must not draw "0%, plenty of room" over a query
  // that failed — that is the same class of lie as an empty task list rendered as fact.
  if (!view.ok) {
    return json({ ok: false, error: 'We could not read the allocation just now. The figure below is not shown.' }, 200);
  }

  return json({
    ok: true,
    from: view.from,
    to: view.to,
    employeeId,
    totalPct: person ? person.totalPct : 0,
    overAllocated: person ? person.overAllocated : false,
    entries: person ? person.entries : [],
  });
};
