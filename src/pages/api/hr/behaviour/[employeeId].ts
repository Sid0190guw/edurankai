// GET /api/hr/behaviour/:employeeId?purpose=<purpose>[&window=<w>,<w>][&metric=<k>,<k>]
//
// PATCH 04's only HTTP surface. It renders nothing — it returns the explainability envelope as JSON,
// which is what "expose APIs and contracts, not UI" means here.
//
// AUTHORISATION IS NOT DONE IN THIS FILE, on purpose. computeBehaviouralProfile() authorises,
// enforces purpose against the ground of access, consults the consent seam and writes the access log
// BEFORE it reads a single record about anybody — and it refuses if the log write did not land. A
// route that made its own decision would be a second answer to "who may read this", and two answers
// to that question is how a gate ends up open on one path and closed on another.
//
// `purpose` IS REQUIRED AND HAS NO DEFAULT. A default purpose is not purpose limitation: it is a
// field that always says the same thing, which tells a later auditor nothing about why anyone
// looked. A caller that does not know why it is asking must not be asking.
//
// THE REFUSAL IS 403 WITH THE SAME SENTENCE FOR EVERY GROUND, and it never distinguishes "no such
// employee" from "not yours" — a refusal that varies with the target is a way to enumerate the
// organisation, which is the reasoning already established by NOT_AVAILABLE in employee-tasks.ts.
import type { APIRoute } from 'astro';
import {
  computeBehaviouralProfile,
  BEHAVIOUR_METRICS,
  BEHAVIOUR_PURPOSES,
  BEHAVIOUR_WINDOWS,
  type BehaviourMetricKey,
  type BehaviourPurpose,
  type BehaviourWindow,
} from '@/lib/horizon/behaviour';

export const prerender = false;

function json(d: unknown, s = 200) {
  return new Response(JSON.stringify(d), {
    status: s,
    headers: {
      'Content-Type': 'application/json',
      // A profile about a person is never cached by a shared cache and never stored by a browser.
      'Cache-Control': 'no-store, private',
    },
  });
}

/** Split a repeatable comma list, keep only values in the vocabulary, drop the rest silently. */
function pick<T extends string>(raw: string | null, allowed: readonly T[]): T[] {
  if (!raw) return [];
  const set = new Set<string>(allowed as readonly string[]);
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => set.has(s)) as T[];
}

export const GET: APIRoute = async ({ params, request, locals, clientAddress }) => {
  const user = (locals as any)?.user || null;
  if (!user?.id) {
    return json({ ok: false, error: 'Sign in to open a working-pattern summary.' }, 401);
  }

  const employeeId = String(params.employeeId || '').trim();
  const url = new URL(request.url);

  const purposeRaw = String(url.searchParams.get('purpose') || '').trim();
  if (!BEHAVIOUR_PURPOSES.includes(purposeRaw as BehaviourPurpose)) {
    return json(
      {
        ok: false,
        error:
          'A stated purpose is required, and it must be one this system recognises. It is recorded against the reading.',
        accepted: BEHAVIOUR_PURPOSES,
      },
      400,
    );
  }

  const windows = pick<BehaviourWindow>(url.searchParams.get('window'), BEHAVIOUR_WINDOWS);
  const metrics = pick<BehaviourMetricKey>(url.searchParams.get('metric'), BEHAVIOUR_METRICS);

  try {
    const result = await computeBehaviouralProfile({
      employeeId,
      purpose: purposeRaw as BehaviourPurpose,
      viewer: { user, locals, ipAddress: clientAddress },
      windows: windows.length ? windows : undefined,
      metrics: metrics.length ? metrics : undefined,
    });

    if (!result.ok) {
      return json({ ok: false, error: result.access.reason, access: result.access }, 403);
    }

    return json({ ok: true, profile: result.profile });
  } catch (e: any) {
    // The real Postgres reason goes to the log and never to the caller: it names the schema to
    // whoever asks and tells the reader nothing they can act on.
    console.error('[api/hr/behaviour] ' + (e?.cause?.message || e?.message));
    return json(
      {
        ok: false,
        error:
          'That working-pattern summary could not be assembled. Nothing was changed and nothing partial is being shown.',
      },
      500,
    );
  }
};
