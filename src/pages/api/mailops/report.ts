// POST /api/mailops/report — the mail host and the backup scripts telling the platform what
// actually happened.
//
// WHY THIS ENDPOINT EXISTS. No agent and no process in this repository may open the production
// database; that rule is in CLAUDE.md and it exists because a subagent once read staff PII while
// "surveying source files". The consequence is that every backup, every restore test and every
// migration step happens on the founder's machine, and the platform would otherwise have no idea
// whether any of it ever ran. A continuity page that says "backups: configured" while nothing has
// run since March is worse than having no page at all.
//
// So the scripts report here, and /admin/mail/continuity shows what was reported — including the
// gaps. A backup set with no rows is displayed as "never", not as "fine".
//
// AUTH FAILS CLOSED. CRON_SECRET, the same machine secret the cron endpoints use. If it is unset
// this route refuses everything rather than accepting anonymous writes into the continuity ledger —
// an attacker who can forge a "restore test passed" row is an attacker who can make the founder
// believe the backups work.
//
// IT IS A LEDGER, NOT A COMMAND CHANNEL. Nothing here starts a backup, runs a restore or touches
// mail. The worst a valid caller can do is record a false fact, which is why the secret matters and
// why every row carries `reported_by`.
import type { APIRoute } from 'astro';
import {
  listComponentStatus,
  listBackupArtefacts,
  listRestoreTests,
  recordBackupRun,
  recordComponentStatus,
  recordRestoreTest,
  upsertMigrationRun,
} from '@/lib/mailops/continuity-store';
import { BACKUP_SETS, backupPosture, verificationState } from '@/lib/mailops/backup';
import { ALL_COMPONENTS, capabilityStatus, overallState, type ComponentId } from '@/lib/mailops/failure-model';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// Declared above every handler that uses it — `const` is not hoisted, and that has taken this
// project's admin pages down before.
const VALID_ASSETS = new Set(['database', 'spool', 'mailboxes', 'dkim_keys', 'mail_config', 'object_storage', 'secrets']);
const VALID_COMPONENT_STATES = new Set(['up', 'down', 'degraded', 'unknown']);
const VALID_MIGRATION_STATUS = new Set(['planned', 'copying', 'verifying', 'verified', 'cutover', 'soaking', 'complete', 'rolled_back']);

/**
 * The machine arm. A shared secret is not a role and no capability replaces it.
 *
 * Fails closed when CRON_SECRET is unset — unlike the fail-OPEN spelling that has appeared
 * elsewhere in this codebase, where `if (!secret) return true` left an endpoint unauthenticated on
 * any environment that had not set the variable.
 */
function machineAuthorized(request: Request): boolean {
  const secret = (process.env.CRON_SECRET || '').trim();
  if (!secret) return false;
  const auth = request.headers.get('authorization') || '';
  if (auth === `Bearer ${secret}`) return true;
  return (request.headers.get('x-cron-secret') || '') === secret;
}

function str(v: unknown, max = 500): string {
  return String(v ?? '').slice(0, max);
}

function isoOrNull(v: unknown): string | null {
  if (!v) return null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export const POST: APIRoute = async ({ request }) => {
  if (!machineAuthorized(request)) return json({ ok: false, error: 'unauthorised' }, 401);

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid JSON' }, 400);
  }

  const kind = str(body?.kind, 40);
  const reportedBy = str(body?.reportedBy || request.headers.get('x-reported-by') || 'unknown', 100);

  switch (kind) {
    case 'backup': {
      const assetClass = str(body.assetClass, 40);
      if (!VALID_ASSETS.has(assetClass)) return json({ ok: false, error: `unknown assetClass: ${assetClass}` }, 400);
      const takenAt = isoOrNull(body.takenAt);
      if (!takenAt) return json({ ok: false, error: 'takenAt must be a timestamp' }, 400);
      if (!body.id) return json({ ok: false, error: 'id is required — it is the artefact identity used by retention and by restore tests' }, 400);

      const result = await recordBackupRun({
        id: str(body.id, 120),
        assetClass: assetClass as any,
        takenAt,
        finishedAt: isoOrNull(body.finishedAt),
        ok: body.ok !== false,
        sizeBytes: Number.isFinite(Number(body.sizeBytes)) ? Number(body.sizeBytes) : null,
        location: str(body.location, 400),
        encrypted: !!body.encrypted,
        offsite: !!body.offsite,
        checksum: body.checksum ? str(body.checksum, 128) : null,
        error: body.error ? str(body.error, 1000) : null,
        reportedBy,
      });
      return result.ok ? json({ ok: true }) : json({ ok: false, error: result.error }, 500);
    }

    case 'restore-test': {
      const assetClass = str(body.assetClass, 40);
      if (!VALID_ASSETS.has(assetClass)) return json({ ok: false, error: `unknown assetClass: ${assetClass}` }, 400);
      const startedAt = isoOrNull(body.startedAt);
      if (!startedAt) return json({ ok: false, error: 'startedAt must be a timestamp' }, 400);
      if (!body.id) return json({ ok: false, error: 'id is required' }, 400);

      const checks = Array.isArray(body.checks)
        ? body.checks.slice(0, 100).map((c: any) => ({ name: str(c?.name, 120), ok: !!c?.ok, detail: str(c?.detail, 500) }))
        : [];

      // A "passed" restore test with no checks is not evidence of anything. Recording it as ok would
      // turn an empty script run into a green tick on the continuity page, which is the exact
      // failure this whole module is built to prevent.
      const claimedOk = body.ok === true;
      const ok = claimedOk && checks.length > 0 && checks.every((c: any) => c.ok);
      const notes = !claimedOk || checks.length
        ? (body.notes ? str(body.notes, 1000) : null)
        : 'Reported as passed with no checks attached. Recorded as FAILED: a restore that verified nothing proves nothing.';

      const result = await recordRestoreTest({
        id: str(body.id, 120),
        assetClass: assetClass as any,
        artefactId: body.artefactId ? str(body.artefactId, 120) : null,
        startedAt,
        finishedAt: isoOrNull(body.finishedAt),
        ok,
        checks,
        durationSeconds: Number.isFinite(Number(body.durationSeconds)) ? Math.round(Number(body.durationSeconds)) : null,
        artefactAgeSeconds: Number.isFinite(Number(body.artefactAgeSeconds)) ? Math.round(Number(body.artefactAgeSeconds)) : null,
        target: str(body.target, 200),
        notes,
        reportedBy,
      });
      return result.ok ? json({ ok: true, recordedAs: ok ? 'passed' : 'failed' }) : json({ ok: false, error: result.error }, 500);
    }

    case 'component': {
      const component = str(body.component, 40) as ComponentId;
      if (!ALL_COMPONENTS.includes(component)) return json({ ok: false, error: `unknown component: ${component}` }, 400);
      const state = str(body.state, 20);
      if (!VALID_COMPONENT_STATES.has(state)) return json({ ok: false, error: `unknown state: ${state}` }, 400);

      const result = await recordComponentStatus(component, state as any, str(body.detail, 500), reportedBy);
      return result.ok ? json({ ok: true }) : json({ ok: false, error: result.error }, 500);
    }

    case 'migration': {
      const status = str(body.status, 40);
      if (!VALID_MIGRATION_STATUS.has(status)) return json({ ok: false, error: `unknown status: ${status}` }, 400);
      if (!body.id || !body.migrationId) return json({ ok: false, error: 'id and migrationId are required' }, 400);

      const result = await upsertMigrationRun({
        id: str(body.id, 120),
        migrationId: str(body.migrationId, 60) as any,
        status: status as any,
        stage: body.stage ? str(body.stage, 120) : null,
        report: body.report ?? null,
        verified: body.report ? !!body.report.passed : !!body.verified,
        cutoverAt: isoOrNull(body.cutoverAt),
        decommissionedAt: isoOrNull(body.decommissionedAt),
        notes: body.notes ? str(body.notes, 2000) : null,
      });
      return result.ok ? json({ ok: true }) : json({ ok: false, error: result.error }, 500);
    }

    default:
      return json({ ok: false, error: 'kind must be one of: backup, restore-test, component, migration' }, 400);
  }
};

/**
 * GET — the machine-readable continuity summary, for the health check on the mail host.
 *
 * Same secret. It returns the honest posture rather than a bare "ok": a caller polling this wants
 * to know that three backup sets have never been restored, not that the endpoint is reachable.
 */
export const GET: APIRoute = async ({ request }) => {
  if (!machineAuthorized(request)) return json({ ok: false, error: 'unauthorised' }, 401);

  const [artefacts, tests, components] = await Promise.all([
    listBackupArtefacts(500),
    listRestoreTests(500),
    listComponentStatus(),
  ]);

  const readErrors: string[] = [];
  if (!artefacts.ok) readErrors.push(`backup artefacts: ${artefacts.error}`);
  if (!tests.ok) readErrors.push(`restore tests: ${tests.error}`);
  if (!components.ok) readErrors.push(`component status: ${components.error}`);

  const verification = BACKUP_SETS.map((s) => verificationState(s, tests.data));
  const down = components.data.statuses.filter((c) => c.state === 'down').map((c) => c.component);
  const capabilities = capabilityStatus(down);

  return json({
    // `ok` describes the READ, not the system. A degraded system read successfully is ok: true with
    // a 'down' state, and conflating the two is how a status endpoint reports green during an outage.
    ok: readErrors.length === 0,
    readErrors,
    state: overallState(capabilities),
    backups: backupPosture(verification),
    verification: verification.map((v) => ({ assetClass: v.assetClass, state: v.state, ageDays: v.ageDays == null ? null : Math.round(v.ageDays) })),
    artefactCount: artefacts.data.length,
    componentsDown: down,
    componentsStale: components.data.stale,
    capabilities: capabilities.map((c) => ({ capability: c.capability, state: c.state, because: c.because })),
  });
};
