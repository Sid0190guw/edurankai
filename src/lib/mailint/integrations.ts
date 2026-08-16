// src/lib/mailint/integrations.ts — INTEGRATIONS: records, mappings, health, and the inbound path.
//
// This is where the pure pieces meet the database. The connector SDK never sees a connection; it
// receives a ConnectorContext built here, holding exactly three capabilities — read one of MY
// credentials, publish onto the bus for MY organisation, and see MY mappings. A connector that is
// later written against a third-party API therefore cannot read another integration's secrets even
// if it tries, because it has no way to ask.
//
// THE INBOUND PATH IS RECORDED WHETHER OR NOT IT WORKED. Every call lands a row in mailint_inbound
// with the pipeline trace: which step failed, why, and how many events came out. The state this
// prevents is the one that is genuinely hard to diagnose — a partner insisting they are sending
// events, and nothing on our side to prove or disprove it. A rejected payload is evidence; a
// dropped one is an argument.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureMailIntSchema, rows, dbReason } from './schema';
import { getConnector, defaultMappingsFor, isConnectable } from './connectors';
import {
  credentialStatesOf,
  computeHealth,
  runConnectorPipeline,
  type ConnectorContext,
  type CredentialKind,
  type HealthReport,
  type InboundRequest,
  type PipelineResult,
} from './connector';
import { listCredentials, readSecret } from './credentials';
import { validateMapping, type EventMapping } from './mapping';
import { emitEvent, type Environment } from './router';
import { sameTenant } from './policy';

// ---------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------

export interface IntegrationRow {
  id: string;
  orgId: string;
  environment: string;
  connector: string;
  name: string;
  slug: string;
  direction: string;
  config: Record<string, unknown>;
  isEnabled: boolean;
  status: string;
  statusDetail: string | null;
  consecutiveFailures: number;
  lastEventAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  expectedIntervalSeconds: number | null;
  createdAt: string;
}

function toIntegration(r: any): IntegrationRow {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    environment: String(r.environment),
    connector: String(r.connector),
    name: String(r.name),
    slug: String(r.slug),
    direction: String(r.direction || 'inbound'),
    config: typeof r.config === 'object' && r.config ? r.config : {},
    isEnabled: !!r.is_enabled,
    status: String(r.status || 'connected'),
    statusDetail: r.status_detail ?? null,
    consecutiveFailures: Number(r.consecutive_failures || 0),
    lastEventAt: r.last_event_at ? new Date(r.last_event_at).toISOString() : null,
    lastSuccessAt: r.last_success_at ? new Date(r.last_success_at).toISOString() : null,
    lastFailureAt: r.last_failure_at ? new Date(r.last_failure_at).toISOString() : null,
    expectedIntervalSeconds: r.expected_interval_seconds ? Number(r.expected_interval_seconds) : null,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
  };
}

export async function listIntegrations(orgId: string, environment?: string): Promise<IntegrationRow[]> {
  await ensureMailIntSchema();
  try {
    const r = await db.execute(sql`
      SELECT * FROM mailint_integrations
      WHERE org_id = ${orgId}::uuid
      ${environment ? sql`AND environment = ${environment}` : sql``}
      ORDER BY created_at DESC LIMIT 200
    `);
    return rows(r).map(toIntegration);
  } catch (e: any) {
    console.error('[mailint/integrations] list failed:', dbReason(e));
    return [];
  }
}

export async function getIntegration(orgId: string, id: string): Promise<IntegrationRow | null> {
  await ensureMailIntSchema();
  try {
    const r = await db.execute(sql`SELECT * FROM mailint_integrations WHERE id = ${id}::uuid LIMIT 1`);
    const row = rows(r)[0];
    if (!row || !sameTenant(String(row.org_id), orgId)) return null;
    return toIntegration(row);
  } catch (e: any) {
    console.error('[mailint/integrations] get failed:', dbReason(e));
    return null;
  }
}

export async function getIntegrationBySlug(orgId: string, environment: string, slug: string): Promise<IntegrationRow | null> {
  await ensureMailIntSchema();
  try {
    const r = await db.execute(sql`
      SELECT * FROM mailint_integrations
      WHERE org_id = ${orgId}::uuid AND environment = ${environment} AND slug = ${String(slug).toLowerCase()}
      LIMIT 1
    `);
    const row = rows(r)[0];
    return row ? toIntegration(row) : null;
  } catch (e: any) {
    console.error('[mailint/integrations] slug lookup failed:', dbReason(e));
    return null;
  }
}

export async function createIntegration(input: {
  orgId: string;
  environment: string;
  connector: string;
  name: string;
  slug?: string;
  config?: Record<string, unknown>;
  expectedIntervalSeconds?: number | null;
  createdBy?: string | null;
  /** Seed the connector's shipped mappings. On by default; a caller can start from nothing. */
  seedMappings?: boolean;
}): Promise<{ ok: boolean; integration?: IntegrationRow; error?: string }> {
  const connector = getConnector(input.connector);
  if (!connector) return { ok: false, error: '"' + input.connector + '" is not a connector this platform knows.' };
  if (!isConnectable(input.connector)) {
    // A planned connector cannot be created. The console never offers the button; this is the guard
    // for anybody calling the API directly, and the message says what is actually missing.
    return { ok: false, error: connector.meta.name + ' is planned, not implemented. ' + (connector.meta.blockedOn || '') };
  }
  await ensureMailIntSchema();
  const slug = String(input.slug || input.name).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  if (!slug) return { ok: false, error: 'A name is required.' };

  try {
    const r = await db.execute(sql`
      INSERT INTO mailint_integrations (org_id, environment, connector, name, slug, direction, config, expected_interval_seconds, created_by)
      VALUES (
        ${input.orgId}::uuid, ${input.environment}, ${connector.meta.key}, ${input.name}, ${slug},
        ${connector.meta.direction}, ${JSON.stringify(input.config || {})}::jsonb,
        ${input.expectedIntervalSeconds || null}, ${input.createdBy || null}::uuid
      )
      RETURNING *
    `);
    const row = rows(r)[0];
    if (!row) return { ok: false, error: 'The integration was not written.' };
    const integration = toIntegration(row);

    if (input.seedMappings !== false) {
      for (const m of defaultMappingsFor(connector.meta.key)) {
        await saveMapping({ orgId: input.orgId, integrationId: integration.id, mapping: m, createdBy: input.createdBy || null });
      }
    }
    return { ok: true, integration };
  } catch (e: any) {
    const reason = dbReason(e);
    if (/duplicate key|unique/i.test(reason)) return { ok: false, error: 'An integration with that name already exists in this environment.' };
    console.error('[mailint/integrations] create failed:', reason);
    return { ok: false, error: reason };
  }
}

export async function updateIntegration(
  orgId: string,
  id: string,
  patch: { name?: string; isEnabled?: boolean; config?: Record<string, unknown>; expectedIntervalSeconds?: number | null },
): Promise<{ ok: boolean; integration?: IntegrationRow; error?: string }> {
  await ensureMailIntSchema();
  try {
    const r = await db.execute(sql`
      UPDATE mailint_integrations SET
        name = COALESCE(${patch.name || null}, name),
        is_enabled = COALESCE(${patch.isEnabled === undefined ? null : patch.isEnabled}, is_enabled),
        config = COALESCE(${patch.config ? JSON.stringify(patch.config) : null}::jsonb, config),
        expected_interval_seconds = ${patch.expectedIntervalSeconds === undefined ? sql`expected_interval_seconds` : sql`${patch.expectedIntervalSeconds}`},
        updated_at = now()
      WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid
      RETURNING *
    `);
    const row = rows(r)[0];
    if (!row) return { ok: false, error: 'No such integration.' };
    return { ok: true, integration: toIntegration(row) };
  } catch (e: any) {
    console.error('[mailint/integrations] update failed:', dbReason(e));
    return { ok: false, error: dbReason(e) };
  }
}

export async function deleteIntegration(orgId: string, id: string): Promise<{ ok: boolean; error?: string }> {
  await ensureMailIntSchema();
  try {
    // The credentials and mappings cascade. The EVENTS do not — they are facts that happened, and
    // deleting an integration must not rewrite the history of what the platform was told.
    const r = await db.execute(sql`DELETE FROM mailint_integrations WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid RETURNING id`);
    if (!rows(r).length) return { ok: false, error: 'No such integration.' };
    return { ok: true };
  } catch (e: any) {
    console.error('[mailint/integrations] delete failed:', dbReason(e));
    return { ok: false, error: dbReason(e) };
  }
}

// ---------------------------------------------------------------------------------------------
// Mappings
// ---------------------------------------------------------------------------------------------

export async function listMappings(orgId: string, integrationId: string): Promise<(EventMapping & { id: string })[]> {
  await ensureMailIntSchema();
  try {
    const r = await db.execute(sql`
      SELECT * FROM mailint_mappings
      WHERE org_id = ${orgId}::uuid AND integration_id = ${integrationId}::uuid
      ORDER BY priority ASC, name ASC LIMIT 100
    `);
    return rows(r).map((row) => {
      const def = (typeof row.definition === 'object' && row.definition ? row.definition : {}) as EventMapping;
      return { ...def, id: String(row.id), name: String(row.name), source: String(row.source), isActive: !!row.is_active, priority: Number(row.priority || 100) };
    });
  } catch (e: any) {
    console.error('[mailint/integrations] mapping list failed:', dbReason(e));
    return [];
  }
}

export async function saveMapping(opts: {
  orgId: string;
  integrationId: string;
  mapping: EventMapping;
  mappingId?: string | null;
  createdBy?: string | null;
}): Promise<{ ok: boolean; id?: string; errors?: string[] }> {
  const errors = validateMapping(opts.mapping);
  // Validated BEFORE storage, so a typo in a path is caught once at save time rather than once per
  // inbound webhook at three in the morning.
  if (errors.length) return { ok: false, errors };
  await ensureMailIntSchema();
  try {
    if (opts.mappingId) {
      const r = await db.execute(sql`
        UPDATE mailint_mappings SET
          name = ${opts.mapping.name}, source = ${String(opts.mapping.source)},
          definition = ${JSON.stringify(opts.mapping)}::jsonb,
          is_active = ${opts.mapping.isActive !== false}, priority = ${opts.mapping.priority ?? 100}, updated_at = now()
        WHERE id = ${opts.mappingId}::uuid AND org_id = ${opts.orgId}::uuid
        RETURNING id
      `);
      const id = rows(r)[0]?.id;
      return id ? { ok: true, id: String(id) } : { ok: false, errors: ['No such mapping.'] };
    }
    const r = await db.execute(sql`
      INSERT INTO mailint_mappings (org_id, integration_id, name, source, definition, is_active, priority, created_by)
      VALUES (
        ${opts.orgId}::uuid, ${opts.integrationId}::uuid, ${opts.mapping.name}, ${String(opts.mapping.source)},
        ${JSON.stringify(opts.mapping)}::jsonb, ${opts.mapping.isActive !== false}, ${opts.mapping.priority ?? 100},
        ${opts.createdBy || null}::uuid
      )
      RETURNING id
    `);
    const id = rows(r)[0]?.id;
    return id ? { ok: true, id: String(id) } : { ok: false, errors: ['The mapping was not written.'] };
  } catch (e: any) {
    console.error('[mailint/integrations] mapping save failed:', dbReason(e));
    return { ok: false, errors: [dbReason(e)] };
  }
}

export async function deleteMapping(orgId: string, mappingId: string): Promise<{ ok: boolean; error?: string }> {
  await ensureMailIntSchema();
  try {
    const r = await db.execute(sql`DELETE FROM mailint_mappings WHERE id = ${mappingId}::uuid AND org_id = ${orgId}::uuid RETURNING id`);
    return rows(r).length ? { ok: true } : { ok: false, error: 'No such mapping.' };
  } catch (e: any) {
    return { ok: false, error: dbReason(e) };
  }
}

// ---------------------------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------------------------

/**
 * Build the sandbox a connector runs in.
 *
 * Three capabilities, all scoped to this integration and this organisation. `credential()` cannot
 * name another integration; `publish()` cannot name another organisation, because it overwrites
 * orgId on every event it is handed.
 */
export async function buildContext(
  integration: IntegrationRow,
  opts: { now?: number } = {},
): Promise<ConnectorContext> {
  const creds = await listCredentials(integration.orgId, integration.id);
  const states = credentialStatesOf(
    creds.map((c) => ({ kind: c.kind, expiresAt: c.expiresAt, revokedAt: c.revokedAt })),
    opts.now,
  );
  const mappings = await listMappings(integration.orgId, integration.id);

  return {
    orgId: integration.orgId,
    integrationId: integration.id,
    environment: integration.environment,
    credentialStates: states,
    mappings,
    disabled: !integration.isEnabled,
    now: opts.now,
    stats: {
      consecutiveFailures: integration.consecutiveFailures,
      lastSuccessAt: integration.lastSuccessAt,
      lastFailureAt: integration.lastFailureAt,
      lastEventAt: integration.lastEventAt,
    },
    credential: (kind: CredentialKind) => readSecret(integration.id, kind, { orgId: integration.orgId }),
    publish: async (event) => {
      const r = await emitEvent(
        { ...event, orgId: integration.orgId },
        { environment: integration.environment as Environment, integrationId: integration.id },
      );
      return {
        ok: r.ok,
        eventId: r.eventId,
        duplicate: r.duplicate,
        error: r.errors?.join('; '),
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------------------------

/** Run a connector's health check, store the answer, and return it. */
export async function checkHealth(integration: IntegrationRow): Promise<HealthReport> {
  const connector = getConnector(integration.connector);
  const started = Date.now();
  let report: HealthReport;

  if (!connector) {
    report = {
      status: 'failed',
      detail: 'This integration names connector "' + integration.connector + '", which is no longer registered. Its credentials and history are intact; nothing will run until the connector exists again.',
      checkedAt: new Date().toISOString(),
    };
  } else {
    try {
      const ctx = await buildContext(integration);
      report = await connector.health(ctx);
      if (integration.expectedIntervalSeconds) {
        report = computeHealth({
          disabled: !integration.isEnabled,
          credentialStates: ctx.credentialStates,
          required: connector.meta.requires,
          consecutiveFailures: integration.consecutiveFailures,
          lastSuccessAt: integration.lastSuccessAt,
          lastFailureAt: integration.lastFailureAt,
          lastEventAt: integration.lastEventAt,
          expectedIntervalMs: integration.expectedIntervalSeconds * 1000,
        });
      }
    } catch (e: any) {
      // A health check that throws must not read as healthy. This is the whole reason health()
      // is documented as never throwing and is wrapped here anyway.
      report = {
        status: 'failed',
        detail: 'The health check itself failed: ' + String(e?.cause?.message || e?.message || e).slice(0, 200),
        checkedAt: new Date().toISOString(),
      };
    }
  }
  report.latencyMs = Date.now() - started;

  try {
    await db.execute(sql`
      UPDATE mailint_integrations SET status = ${report.status}, status_detail = ${report.detail.slice(0, 500)}, last_checked_at = now()
      WHERE id = ${integration.id}::uuid
    `);
    await db.execute(sql`
      INSERT INTO mailint_health_checks (org_id, integration_id, status, detail, latency_ms)
      VALUES (${integration.orgId}::uuid, ${integration.id}::uuid, ${report.status}, ${report.detail.slice(0, 500)}, ${report.latencyMs})
    `);
  } catch (e: any) {
    console.error('[mailint/integrations] health not stored:', dbReason(e));
  }
  return report;
}

export async function checkAllHealth(orgId: string, environment?: string): Promise<{ id: string; name: string; report: HealthReport }[]> {
  const list = await listIntegrations(orgId, environment);
  const out: { id: string; name: string; report: HealthReport }[] = [];
  for (const i of list) out.push({ id: i.id, name: i.name, report: await checkHealth(i) });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------------------------

export interface InboundOutcome {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
  pipeline?: PipelineResult;
}

/**
 * Handle one inbound call for one integration.
 *
 * STATUS CODES ARE PART OF THE CONTRACT WITH THE SENDER, and each one is a deliberate instruction:
 *   401  your signature or key is wrong — do not retry until you fix it
 *   422  we understood the request and cannot use this payload — do not retry
 *   202  accepted; some or all events were unmapped, which is fine and NOT a reason to retry
 *   200  accepted and published
 *   503  our fault — retry
 *
 * The one that matters most is 202 over 400 for unmapped events: a system that sends us its whole
 * event stream must not be taught that most of it is an error.
 */
export async function handleInbound(opts: {
  integration: IntegrationRow;
  request: InboundRequest;
  requestId?: string;
}): Promise<InboundOutcome> {
  const started = Date.now();
  const { integration, request } = opts;
  const connector = getConnector(integration.connector);

  if (!connector) {
    await recordInbound({ integration, request, status: 'rejected', detail: 'connector not registered', duration: Date.now() - started, requestId: opts.requestId });
    return { ok: false, status: 503, body: { error: { type: 'internal_error', message: 'This integration’s connector is not registered on this deployment.' } } };
  }
  if (!integration.isEnabled) {
    await recordInbound({ integration, request, status: 'rejected', detail: 'integration disabled', duration: Date.now() - started, requestId: opts.requestId });
    return { ok: false, status: 403, body: { error: { type: 'invalid_request', message: 'This integration is switched off. Enable it in the integration console.' } } };
  }

  const ctx = await buildContext(integration);
  const result = await runConnectorPipeline(connector, request, ctx);

  const status = result.ok
    ? (result.normalized < result.received ? 'partial' : 'routed')
    : 'failed';
  await recordInbound({
    integration,
    request,
    status,
    detail: result.error || '',
    pipeline: result,
    duration: Date.now() - started,
    requestId: opts.requestId,
  });
  await stampIntegration(integration.id, result.ok, result.published > 0);

  if (!result.ok) {
    const httpStatus =
      result.code === 'unauthorized' || result.code === 'invalid_signature' ? 401
      : result.code === 'invalid_payload' || result.code === 'mapping_failed' ? 422
      : result.code === 'not_implemented' || result.code === 'unsupported' ? 501
      : 503;
    return {
      ok: false,
      status: httpStatus,
      body: {
        error: {
          type: result.code || 'internal_error',
          message: result.error || 'The event could not be accepted.',
          // The trace goes back to the caller on a failure, because the caller is the only one who
          // can fix a signature or a payload and they should not have to ask us which step failed.
          steps: result.trace.map((t) => ({ step: t.step, ok: t.ok, detail: t.detail })),
        },
      },
      pipeline: result,
    };
  }

  const unmapped = Math.max(0, result.received - result.normalized);
  return {
    ok: true,
    status: unmapped > 0 && result.published === 0 ? 202 : 200,
    body: {
      received: result.received,
      published: result.published,
      duplicates: result.duplicates,
      unmapped,
      event_ids: result.eventIds,
    },
    pipeline: result,
  };
}

async function stampIntegration(id: string, ok: boolean, publishedSomething: boolean): Promise<void> {
  try {
    if (ok) {
      await db.execute(sql`
        UPDATE mailint_integrations
        SET consecutive_failures = 0, last_success_at = now(),
            last_event_at = CASE WHEN ${publishedSomething} THEN now() ELSE last_event_at END,
            status = CASE WHEN status IN ('failed','degraded') THEN 'connected' ELSE status END,
            updated_at = now()
        WHERE id = ${id}::uuid
      `);
    } else {
      await db.execute(sql`
        UPDATE mailint_integrations
        SET consecutive_failures = consecutive_failures + 1, last_failure_at = now(), updated_at = now()
        WHERE id = ${id}::uuid
      `);
    }
  } catch (e: any) {
    console.error('[mailint/integrations] counters not stamped:', dbReason(e));
  }
}

/** Headers worth keeping. An Authorization header is NEVER stored — the log would become a vault. */
const KEEP_HEADERS = ['content-type', 'user-agent', 'x-edurankai-signature', 'x-signature', 'x-request-id', 'x-forwarded-for'];

async function recordInbound(opts: {
  integration: IntegrationRow;
  request: InboundRequest;
  status: string;
  detail: string;
  pipeline?: PipelineResult;
  duration: number;
  requestId?: string;
}): Promise<void> {
  const headers: Record<string, string> = {};
  for (const k of KEEP_HEADERS) if (opts.request.headers[k]) headers[k] = opts.request.headers[k];

  let payload: unknown = {};
  try {
    payload = opts.request.json !== undefined ? opts.request.json : JSON.parse(opts.request.rawBody || '{}');
  } catch {
    // Keep the raw text when it is not JSON: an unparseable body is exactly the case somebody needs
    // to look at, and storing `{}` for it would delete the evidence.
    payload = { unparsed: String(opts.request.rawBody || '').slice(0, 4000) };
  }

  try {
    await db.execute(sql`
      INSERT INTO mailint_inbound
        (org_id, environment, integration_id, connector, external_event_id, external_type, status, detail,
         request_headers, payload, trace, received_count, published_count, duplicate_count, failed_count, event_ids,
         request_id, ip, duration_ms)
      VALUES (
        ${opts.integration.orgId}::uuid, ${opts.integration.environment}, ${opts.integration.id}::uuid,
        ${opts.integration.connector}, ${null}, ${null}, ${opts.status}, ${String(opts.detail || '').slice(0, 500)},
        ${JSON.stringify(headers)}::jsonb, ${JSON.stringify(payload)}::jsonb,
        ${JSON.stringify(opts.pipeline?.trace || [])}::jsonb,
        ${opts.pipeline?.received || 0}, ${opts.pipeline?.published || 0}, ${opts.pipeline?.duplicates || 0},
        ${opts.pipeline?.failed || 0}, ${JSON.stringify(opts.pipeline?.eventIds || [])}::jsonb,
        ${opts.requestId || null}, ${opts.request.ip || null}, ${opts.duration}
      )
    `);
  } catch (e: any) {
    console.error('[mailint/integrations] inbound not recorded:', dbReason(e));
  }
}

export async function listInbound(orgId: string, opts: { integrationId?: string | null; limit?: number } = {}): Promise<any[]> {
  await ensureMailIntSchema();
  try {
    const r = await db.execute(sql`
      SELECT id, integration_id, connector, status, detail, received_count, published_count, duplicate_count,
             failed_count, trace, duration_ms, created_at, request_id
      FROM mailint_inbound
      WHERE org_id = ${orgId}::uuid
      ${opts.integrationId ? sql`AND integration_id = ${opts.integrationId}::uuid` : sql``}
      ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(200, opts.limit || 50))}
    `);
    return rows(r);
  } catch (e: any) {
    console.error('[mailint/integrations] inbound list failed:', dbReason(e));
    return [];
  }
}
