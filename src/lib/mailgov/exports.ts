// src/lib/mailgov/exports.ts — ASYNCHRONOUS, AUTHENTICATED, TIME-LIMITED, AUDITED EXPORT.
//
// The catalogue and the serialisation are in ./export-plan.ts (pure, tested). This runs the job.
//
// WHY ASYNCHRONOUS AT ALL. A tenant with two million delivery events and a synchronous export is a
// request that times out at the edge after doing most of the work, twice, because the operator
// pressed the button again. The job row is the unit of work and the unit of audit: requested by
// whom, containing what, downloaded when and how often.
//
// WHERE THE FILE GOES, AND THE TRAP THAT IS BEING AVOIDED. src/lib/storage.ts falls back to an
// in-memory store when neither S3 nor a blob token is configured, and that store's put() DISCARDS
// the bytes and returns a url. An export written to it would report `ready`, hand over a download
// link, and serve nothing — the exact shape of failure this repository keeps writing up: a green
// message that proves the code ran, not that it did the work. So:
//
//   - real object storage configured  -> the artifacts go there;
//   - no object storage, small export -> the artifacts are stored on the job row itself;
//   - no object storage, large export -> the job FAILS with a reason naming the missing configuration.
//
// THE DOWNLOAD TOKEN IS HASHED, like an API key. It is returned exactly once, at request time. A
// token we could read back is a token that anybody with database access could use, which would put
// every export behind the weakest credential in the building rather than behind the authorisation
// that produced it.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getStore, storageProvisioned, storageBackend } from '@/lib/storage';
import { logEvent } from '@/lib/logger';
import { ensureGovernanceSchema, rows, dbReason, tablesExisting } from './schema';
import {
  DATASETS, buildManifest, datasetByKey, expiresAt as computeExpiry, isExpired,
  serializeRows, validateExportRequest,
  type ExportFormat, type ExportManifest, type ExportStatus,
} from './export-plan';

/** Rows per dataset. A cap that is never mentioned is a truncation somebody will read as completeness. */
export const MAX_ROWS_PER_DATASET = 50000;
/** The inline fallback ceiling. Beyond this an export needs real object storage. */
export const MAX_INLINE_BYTES = 4 * 1024 * 1024;

export interface ExportJob {
  id: string;
  orgId: string;
  environment: string;
  datasets: string[];
  format: ExportFormat;
  filters: Record<string, unknown>;
  includesContent: boolean;
  status: ExportStatus;
  requestedBy: string;
  requestedReason: string | null;
  rowCounts: Record<string, number>;
  manifest: ExportManifest | null;
  objectKey: string | null;
  storageBackend: string | null;
  byteSize: number | null;
  expiresAt: string | null;
  downloadCount: number;
  lastDownloadedAt: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export type ReadResult<T> = { ok: true; rows: T[] } | { ok: false; reason: string };

function map(r: any): ExportJob {
  return {
    id: String(r.id),
    orgId: String(r.org_id),
    environment: String(r.environment),
    datasets: Array.isArray(r.datasets) ? r.datasets.map(String) : [],
    format: (r.format === 'csv' ? 'csv' : 'jsonl'),
    filters: (r.filters && typeof r.filters === 'object') ? r.filters : {},
    includesContent: !!r.includes_content,
    status: String(r.status) as ExportStatus,
    requestedBy: String(r.requested_by),
    requestedReason: r.requested_reason ?? null,
    rowCounts: (r.row_counts && typeof r.row_counts === 'object') ? r.row_counts : {},
    manifest: r.manifest || null,
    objectKey: r.object_key ?? null,
    storageBackend: r.storage_backend ?? null,
    byteSize: r.byte_size === null || r.byte_size === undefined ? null : Number(r.byte_size),
    expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    downloadCount: Number(r.download_count) || 0,
    lastDownloadedAt: r.last_downloaded_at ? new Date(r.last_downloaded_at).toISOString() : null,
    error: r.error ?? null,
    createdAt: new Date(r.created_at).toISOString(),
    startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
    finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
  };
}

export interface CreateExportResult {
  ok: boolean;
  error?: string;
  jobId?: string;
  /** Returned ONCE. There is no way to read it back, by design. */
  downloadToken?: string;
  includesContent?: boolean;
}

/**
 * Request an export. Validation is pure and happens before a row is written, so a rejected request
 * leaves nothing behind to clean up.
 */
export async function requestExport(input: {
  orgId: string;
  environment?: string;
  datasets: string[];
  format: string;
  since?: string | null;
  until?: string | null;
  acknowledgedContent?: boolean;
  reason?: string | null;
  requestedBy: string;
}): Promise<CreateExportResult> {
  const v = validateExportRequest({
    datasets: input.datasets, format: input.format, acknowledgedContent: input.acknowledgedContent,
  });
  if (!v.ok) return { ok: false, error: v.error };

  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
  const expires = computeExpiry(new Date(), !!v.includesContent);

  try {
    await ensureGovernanceSchema();
    const r = rows(await db.execute(sql`
      INSERT INTO mailapi_export_jobs (
        org_id, environment, datasets, format, filters, includes_content, status,
        requested_by, requested_reason, download_token_hash, expires_at)
      VALUES (
        ${input.orgId}::uuid, ${input.environment || 'production'},
        ${JSON.stringify(v.datasets)}::jsonb, ${input.format},
        ${JSON.stringify({ since: input.since || null, until: input.until || null })}::jsonb,
        ${!!v.includesContent}, 'pending', ${input.requestedBy}::uuid,
        ${input.reason || null}, ${tokenHash}, ${expires}::timestamptz)
      RETURNING id`))[0];
    return { ok: true, jobId: String(r?.id), downloadToken: token, includesContent: !!v.includesContent };
  } catch (e: any) {
    return { ok: false, error: dbReason(e) };
  }
}

export async function getExportJob(id: string): Promise<{ ok: boolean; job?: ExportJob; reason?: string }> {
  try {
    await ensureGovernanceSchema();
    const r = rows(await db.execute(sql`SELECT * FROM mailapi_export_jobs WHERE id = ${id}::uuid LIMIT 1`))[0];
    if (!r) return { ok: false, reason: 'No such export.' };
    return { ok: true, job: map(r) };
  } catch (e: any) {
    return { ok: false, reason: dbReason(e) };
  }
}

export async function listExports(orgId: string | null, limit = 50): Promise<ReadResult<ExportJob>> {
  try {
    await ensureGovernanceSchema();
    const r = await db.execute(sql`
      SELECT * FROM mailapi_export_jobs
       WHERE ${orgId ? sql`org_id = ${orgId}::uuid` : sql`TRUE`}
       ORDER BY created_at DESC LIMIT ${Math.min(Math.max(limit, 1), 200)}`);
    return { ok: true, rows: rows(r).map(map) };
  } catch (e: any) {
    return { ok: false, reason: dbReason(e) };
  }
}

/** Jobs waiting to run. Claimed one at a time by the worker. */
export async function pendingExports(limit = 5): Promise<string[]> {
  try {
    await ensureGovernanceSchema();
    const r = rows(await db.execute(sql`
      SELECT id FROM mailapi_export_jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT ${limit}`));
    return r.map((x: any) => String(x.id));
  } catch {
    return [];
  }
}

interface DatasetOutput { dataset: string; filename: string; body: string; rows: number; note?: string }

/**
 * RUN ONE JOB.
 *
 * Claims the row with a conditional UPDATE so two workers cannot both run it — the same
 * claim-by-update discipline src/lib/job-queue.ts uses, for the same reason.
 */
export async function runExportJob(jobId: string): Promise<{ ok: boolean; error?: string; rows?: number }> {
  try {
    await ensureGovernanceSchema();
    const claimed = rows(await db.execute(sql`
      UPDATE mailapi_export_jobs SET status = 'running', started_at = now()
       WHERE id = ${jobId}::uuid AND status = 'pending'
      RETURNING *`))[0];
    if (!claimed) return { ok: false, error: 'That export is not pending; another worker may have taken it.' };

    const job = map(claimed);
    const org = rows(await db.execute(sql`SELECT name FROM mailapi_orgs WHERE id = ${job.orgId}::uuid LIMIT 1`))[0];

    const wanted = job.datasets.map((k) => datasetByKey(k)).filter(Boolean) as typeof DATASETS;
    const present = await tablesExisting(Array.from(new Set(wanted.map((d) => d.table))));

    const outputs: DatasetOutput[] = [];
    const counts: Record<string, number> = {};
    const results: { dataset: string; rows: number; note?: string }[] = [];

    for (const spec of wanted) {
      if (!present.has(spec.table)) {
        // Declared but not built on this deployment. An empty file would read as "no data".
        results.push({ dataset: spec.key, rows: 0, note: 'No ' + spec.table + ' table exists on this deployment, so no file was produced. This is not the same as having no rows.' });
        counts[spec.key] = 0;
        continue;
      }
      try {
        const data = await readDataset(spec, job);
        counts[spec.key] = data.rows.length;
        const body = serializeRows(job.format, spec.columns, data.rows);
        outputs.push({
          dataset: spec.key,
          filename: spec.key + '.' + job.format,
          body,
          rows: data.rows.length,
          note: data.truncated
            ? 'Truncated at ' + MAX_ROWS_PER_DATASET + ' rows. Narrow the date range and export again to get the rest.'
            : undefined,
        });
        results.push({ dataset: spec.key, rows: data.rows.length, note: data.truncated ? 'Truncated at ' + MAX_ROWS_PER_DATASET + ' rows.' : undefined });
        if (data.truncated) {
          logEvent('warn', 'mailgov.export.truncated', { jobId, dataset: spec.key, cap: MAX_ROWS_PER_DATASET });
        }
      } catch (e: any) {
        const reason = dbReason(e);
        results.push({ dataset: spec.key, rows: 0, note: 'This dataset could not be read: ' + reason });
        counts[spec.key] = 0;
      }
    }

    const finishedAt = new Date().toISOString();
    const manifest = buildManifest({
      exportId: job.id,
      orgId: job.orgId,
      organization: String(org?.name || job.orgId),
      requestedBy: job.requestedBy,
      requestedAt: job.createdAt,
      finishedAt,
      format: job.format,
      expiresAt: job.expiresAt || '',
      results,
    });

    const bundle: Record<string, string> = { 'manifest.json': JSON.stringify(manifest, null, 2) };
    for (const o of outputs) bundle[o.filename] = o.body;
    const totalBytes = Object.values(bundle).reduce((n, s) => n + Buffer.byteLength(s, 'utf8'), 0);

    // ---- where it goes -------------------------------------------------------------------------
    let objectKey: string | null = null;
    let inline: string | null = null;
    const backend = storageBackend();

    if (storageProvisioned()) {
      const store = getStore();
      const base = 'mailgov-export/' + job.id + '/';
      for (const [name, body] of Object.entries(bundle)) {
        const put = await store.put(base + name, body, name.endsWith('.json') ? 'application/json' : (job.format === 'csv' ? 'text/csv' : 'application/x-ndjson'));
        if (!put) {
          await failJob(job.id, 'Object storage accepted no bytes for ' + name + '. Nothing was written and the export is not downloadable.');
          return { ok: false, error: 'Object storage write failed.' };
        }
      }
      objectKey = base;
    } else if (totalBytes <= MAX_INLINE_BYTES) {
      inline = JSON.stringify(bundle);
    } else {
      await failJob(
        job.id,
        'This export is ' + Math.round(totalBytes / 1024) + ' KB and no object storage is configured on this deployment, '
        + 'so there is nowhere to put it. Set the S3_* variables (or a blob token) and run it again, or narrow the date range '
        + 'to under ' + Math.round(MAX_INLINE_BYTES / 1024) + ' KB.',
      );
      return { ok: false, error: 'No object storage configured for an export this size.' };
    }

    await db.execute(sql`
      UPDATE mailapi_export_jobs
         SET status = 'ready', row_counts = ${JSON.stringify(counts)}::jsonb,
             manifest = ${JSON.stringify(manifest)}::jsonb,
             object_key = ${objectKey}, inline_payload = ${inline},
             storage_backend = ${backend}, byte_size = ${totalBytes},
             finished_at = now()
       WHERE id = ${job.id}::uuid`);

    return { ok: true, rows: Object.values(counts).reduce((a, b) => a + b, 0) };
  } catch (e: any) {
    const reason = dbReason(e);
    await failJob(jobId, reason);
    return { ok: false, error: reason };
  }
}

async function failJob(jobId: string, error: string): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE mailapi_export_jobs SET status = 'failed', error = ${error.slice(0, 4000)}, finished_at = now()
       WHERE id = ${jobId}::uuid`);
  } catch (e: any) {
    logEvent('error', 'mailgov.export.fail-record-failed', { jobId, message: dbReason(e) });
  }
}

/**
 * Read one dataset, scoped to the tenant.
 *
 * THE ORG SCOPE IS NOT OPTIONAL AND NOT CALLER-SUPPLIED. Where a table has no org column
 * (template_versions hangs off templates), the scope is applied through its parent — never dropped.
 * A dataset that cannot be tenant-scoped does not belong in the catalogue.
 */
async function readDataset(spec: (typeof DATASETS)[number], job: ExportJob): Promise<{ rows: Record<string, unknown>[]; truncated: boolean }> {
  const cols = sql.raw(spec.columns.map((c) => '"' + c.replace(/"/g, '') + '"').join(', '));
  const filters = job.filters || {};
  const since = (filters as any).since ? String((filters as any).since) : null;
  const until = (filters as any).until ? String((filters as any).until) : null;
  const timeCol = spec.timeColumn;

  const timeClause = timeCol
    ? sql`${since ? sql`AND ${sql.raw(timeCol)} >= ${since}::timestamptz` : sql``}
          ${until ? sql`AND ${sql.raw(timeCol)} <= ${until}::timestamptz` : sql``}`
    : sql``;

  let r: any[];
  if (spec.orgColumn) {
    r = rows(await db.execute(sql`
      SELECT ${cols} FROM ${sql.raw(spec.table)}
       WHERE ${sql.raw(spec.orgColumn)} = ${job.orgId}::uuid
         ${timeClause}
       ORDER BY ${sql.raw(timeCol || 'id')} DESC
       LIMIT ${MAX_ROWS_PER_DATASET + 1}`));
  } else if (spec.table === 'mailapi_template_versions') {
    // Scoped through its parent. Written out rather than generalised: one bespoke join is clearer
    // than a parent-relationship abstraction used exactly once.
    r = rows(await db.execute(sql`
      SELECT ${cols} FROM mailapi_template_versions v
       WHERE v.template_id IN (SELECT id FROM mailapi_templates WHERE org_id = ${job.orgId}::uuid)
         ${timeClause}
       ORDER BY v.created_at DESC
       LIMIT ${MAX_ROWS_PER_DATASET + 1}`));
  } else {
    throw new Error('Dataset ' + spec.key + ' has no tenant scope and was refused rather than exported unscoped.');
  }

  const truncated = r.length > MAX_ROWS_PER_DATASET;
  return { rows: (truncated ? r.slice(0, MAX_ROWS_PER_DATASET) : r) as Record<string, unknown>[], truncated };
}

export interface DownloadCheck {
  ok: boolean;
  error?: string;
  job?: ExportJob;
  /** The file body, when a specific file was asked for and the token checked out. */
  body?: string;
  contentType?: string;
  filename?: string;
  /** Files available in this export, so the caller can list them. */
  files?: string[];
}

/**
 * Verify a download token and hand back a file.
 *
 * Constant-time comparison on the hash, an expiry check, and a status check — and every successful
 * download increments a counter and stamps a time, because "was this export ever downloaded, and how
 * often" is a question that gets asked after the fact and cannot be answered retrospectively.
 *
 * THE AUDIT EVENT IS WRITTEN BY THE ROUTE, not here, so the actor and the request facts come from the
 * request rather than being reconstructed.
 */
export async function fetchExportFile(input: {
  jobId: string;
  token: string;
  file?: string | null;
  now?: Date;
}): Promise<DownloadCheck> {
  const now = input.now || new Date();
  try {
    await ensureGovernanceSchema();
    const r = rows(await db.execute(sql`SELECT * FROM mailapi_export_jobs WHERE id = ${input.jobId}::uuid LIMIT 1`))[0];
    if (!r) return { ok: false, error: 'No such export.' };
    const job = map(r);

    const supplied = createHash('sha256').update(String(input.token || ''), 'utf8').digest('hex');
    const stored = String(r.download_token_hash || '');
    const a = Buffer.from(supplied, 'utf8');
    const b = Buffer.from(stored, 'utf8');
    if (!stored || a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false, error: 'That download link is not valid for this export.' };
    }
    if (job.status === 'revoked') return { ok: false, error: 'This export was revoked.', job };
    if (job.status !== 'ready') return { ok: false, error: 'This export is ' + job.status + '.', job };
    if (isExpired(job.expiresAt, now)) {
      await db.execute(sql`UPDATE mailapi_export_jobs SET status = 'expired' WHERE id = ${job.id}::uuid AND status = 'ready'`);
      return { ok: false, error: 'The download window for this export closed on ' + job.expiresAt + '. Request it again.', job };
    }

    // Inline payload: the whole bundle is on the row.
    if (r.inline_payload) {
      const bundle = JSON.parse(String(r.inline_payload)) as Record<string, string>;
      const files = Object.keys(bundle);
      const want = input.file || null;
      if (!want) return { ok: true, job, files };
      if (!(want in bundle)) return { ok: false, error: 'That file is not part of this export.', job, files };
      await stampDownload(job.id);
      return {
        ok: true, job, files, body: bundle[want], filename: want,
        contentType: want.endsWith('.json') ? 'application/json'
          : want.endsWith('.csv') ? 'text/csv' : 'application/x-ndjson',
      };
    }

    // Object storage: the caller is given the key prefix and the file list from the manifest. The
    // bytes are served by the store, which is what a store is for.
    const files = ['manifest.json', ...(job.manifest?.files || []).map((f) => f.filename)];
    if (!input.file) return { ok: true, job, files };
    const url = getStore().url((job.objectKey || '') + input.file);
    if (!url) return { ok: false, error: 'That file is not part of this export, or the object store could not resolve it.', job, files };
    await stampDownload(job.id);
    return { ok: true, job, files, filename: input.file, body: url, contentType: 'text/uri-list' };
  } catch (e: any) {
    return { ok: false, error: dbReason(e) };
  }
}

async function stampDownload(jobId: string): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE mailapi_export_jobs
         SET download_count = download_count + 1, last_downloaded_at = now()
       WHERE id = ${jobId}::uuid`);
  } catch (e: any) {
    logEvent('error', 'mailgov.export.download-stamp-failed', { jobId, message: dbReason(e) });
  }
}

/** Withdraw an export before its window closes. The artifacts stop being reachable immediately. */
export async function revokeExport(jobId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await ensureGovernanceSchema();
    const r = rows(await db.execute(sql`
      UPDATE mailapi_export_jobs SET status = 'revoked', download_token_hash = NULL, inline_payload = NULL
       WHERE id = ${jobId}::uuid AND status IN ('ready', 'pending', 'running')
      RETURNING id`));
    if (!r.length) return { ok: false, error: 'That export cannot be revoked; it may already be expired or revoked.' };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: dbReason(e) };
  }
}

/** Mark exports whose window has closed. Run by the worker; also enforced on every download. */
export async function expireExports(): Promise<number> {
  try {
    await ensureGovernanceSchema();
    const r = rows(await db.execute(sql`
      UPDATE mailapi_export_jobs
         SET status = 'expired', inline_payload = NULL, download_token_hash = NULL
       WHERE status = 'ready' AND expires_at IS NOT NULL AND expires_at <= now()
      RETURNING id`));
    return r.length;
  } catch {
    return 0;
  }
}
