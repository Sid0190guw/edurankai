// POST /api/admin/mail/bench-report — receives a capacity report from scripts/mail-bench.mjs.
//
// WHY THIS ROUTE EXISTS AT ALL. The benchmark runs on a laptop or a CI box; /admin/mail/performance
// renders on Vercel. There is no shared filesystem between them, so a JSON file on disk is invisible
// to the surface that needs it. This is the seam that makes a benchmark result reachable from a
// screen instead of being a file nobody opens.
//
// SAME GATE AS THE SCREEN IT FEEDS: `administer` on the platform, or the METRICS_TOKEN bearer used
// by unattended runners. The token door does not exist when the token is unset — never "allow
// anyone". src/middleware.ts hard-exempts /api/, so whatever a route checks for itself is the only
// thing in front of it.
//
// IT DOES NOT TRUST A SINGLE DERIVED NUMBER IN THE PAYLOAD. Everything the capacity screen displays
// is recomputed here from the raw measurement and stored as this server computed it; the posted
// `throughput`, `tiers`, `resources`, `validity` and `caveats` are discarded. See the long note at
// the recompute step for the hole that made this necessary — comparing only the tier verdicts left
// the msg/s figure printed in the headline completely unchecked.
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac/guard';
import { saveBenchReport } from '@/lib/mailplatform/bench-store';
import { assessAll, validate, buildCapacityReport, type CapacityReport } from '@/lib/mailplatform/capacity';

export const prerender = false;

const MIN_TOKEN_LENGTH = 32;
const MAX_BODY_BYTES = 512 * 1024;

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store, max-age=0' } });

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function tokenAccepted(request: Request): boolean {
  const configured = String(process.env.METRICS_TOKEN || '').trim();
  if (configured.length < MIN_TOKEN_LENGTH) return false;   // the door does not exist, it is not open
  const header = request.headers.get('authorization') || '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  return presented ? timingSafeEqual(presented, configured) : false;
}

export const POST: APIRoute = async ({ request, locals }) => {
  let allowed = tokenAccepted(request);
  if (!allowed) {
    const user = (locals as { user?: { id?: string } } | undefined)?.user;
    if (user) {
      try {
        allowed = (await can(user, 'administer', { type: 'platform' })).allow === true;
      } catch (e) {
        const { trackError } = await import('@/lib/logger');
        await trackError('bench_report.authz_failed', e, { userId: user?.id ?? null });
        allowed = false;
      }
    }
  }
  if (!allowed) return json({ error: 'forbidden' }, 403);

  let payload: { report?: CapacityReport; label?: string };
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return json({ error: 'report too large' }, 413);
    payload = JSON.parse(raw);
  } catch {
    return json({ error: 'body is not valid JSON' }, 400);
  }

  const report = payload?.report;
  if (!report || report.schema !== 'edurankai.mail.capacity/1') {
    return json({ error: 'expected { report } with schema "edurankai.mail.capacity/1"' }, 400);
  }
  if (!report.measurement || !Array.isArray(report.tiers)) {
    return json({ error: 'report is missing measurement or tiers' }, 400);
  }

  // RECOMPUTE, DO NOT COMPARE. This is the anti-fabrication check.
  //
  // It used to re-derive the tier VERDICTS and compare them field by field, and that was not enough
  // — an adversarial review found the hole and it is worth recording, because the shape of the
  // mistake recurs. Comparing a subset means everything outside the subset is trusted, and the
  // numbers outside the subset were the ones actually printed on screen:
  //
  //   * `throughput.messagesPerSec` is what `headline()` renders in bold on the capacity card and
  //     what bench-store writes into the `messages_per_sec` column behind the history table. Post an
  //     honest measurement of 100 msg/s with honest verdicts, set throughput to 5000, and the screen
  //     read "Demonstrated up to 1 million/day at 5000.00 msg/s sustained" — an earned tier claim
  //     beside a fabricated rate, and every verdict checked out.
  //   * Posting `NO_MEASUREMENT` made the verdict check trivially satisfiable (five `unmeasured`
  //     values are easy to copy) while leaving every displayed number unverified.
  //
  // So the server no longer trusts any derived field. It rebuilds the report from the RAW INPUTS —
  // configuration, measurement, latency samples — and stores what IT computed. `throughput`,
  // `tiers`, `resources`, `bottlenecks`, `validity` and `caveats` in the payload are discarded
  // entirely, so there is nothing left to fabricate. The measurement itself is still the poster's
  // word, and that is unavoidable and fine: it is the INPUT, and validate() governs what it earns.
  const authoritative = buildCapacityReport({
    configuration: report.configuration,
    measurement: report.measurement,
    latency: Array.isArray(report.latency) ? report.latency : [],
    queueLatency: report.queueLatencyMs ?? null,
    databaseLatency: report.databaseLatencyMs ?? null,
    // Preserved so the history table orders by when the run HAPPENED, not when it was uploaded.
    generatedAt: report.generatedAt,
  });

  // A disagreement is no longer fatal — the authoritative report is stored either way — but it is
  // reported back, because it means the poster's tooling is computing something this build does not.
  // A CI job silently posting numbers that never appear anywhere is its own kind of failure.
  const expected = assessAll(report.measurement);
  const mismatches = expected
    .map((e, i) => ({ tier: e.tier.id, expected: e.verdict, got: Array.isArray(report.tiers) ? report.tiers[i]?.verdict : undefined }))
    .filter((m) => m.expected !== m.got);
  const postedRate = report.throughput?.messagesPerSec ?? null;
  const rateMismatch = postedRate !== authoritative.throughput.messagesPerSec
    ? { posted: postedRate, recomputed: authoritative.throughput.messagesPerSec }
    : null;

  const validity = validate(report.measurement);
  const saved = await saveBenchReport(authoritative, typeof payload.label === 'string' ? payload.label.slice(0, 120) : undefined);
  if (!saved.ok) return json({ error: 'could not store report', detail: saved.error }, 500);

  return json({
    ok: true,
    id: saved.id,
    // Echoed back so a CI run sees, in its own log, whether the result it just posted actually
    // supports a claim — rather than assuming that a 201 means "target achieved".
    usableMeasurement: validity.usable,
    validityReasons: validity.reasons,
    sustainedTiers: expected.filter((t) => t.verdict === 'sustained').map((t) => t.tier.label),
    // What was STORED, which is what the screen will show. Named `recomputed` rather than echoed
    // silently: a poster whose numbers were replaced should be able to see that from the response.
    recomputed: {
      messagesPerSec: authoritative.throughput.messagesPerSec,
      note: 'Derived fields are recomputed server-side from the measurement and stored; the posted throughput, tiers, resources and caveats are discarded.',
    },
    ...(mismatches.length ? { tierVerdictMismatches: mismatches } : {}),
    ...(rateMismatch ? { throughputMismatch: rateMismatch } : {}),
    view: '/admin/mail/performance',
  }, 201);
};
