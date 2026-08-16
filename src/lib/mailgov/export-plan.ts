// src/lib/mailgov/export-plan.ts — WHAT AN EXPORT CONTAINS, AND WHAT IT MUST NEVER CARRY OUT.
//
// PURE. No database, no storage, no clock read inside a function. ./exports.ts runs these plans;
// this file decides what a dataset IS, which columns leave the building, and how rows are
// serialised — so "does the export leak the API key hashes?" is a unit test rather than a discovery.
//
// COLUMNS ARE LISTED, NEVER `SELECT *`. This is the whole reason the catalogue exists. A star select
// exports whatever the schema grew last week: today that is `mailapi_keys.key_hash` and
// `mailapi_webhooks.secret`, tomorrow it is a column nobody remembered was sensitive. Every dataset
// below names its columns explicitly, and the secret-bearing ones are named in FORBIDDEN so that a
// future editor adding a column to a projection trips a test rather than shipping it.
//
// DATASETS THAT DO NOT EXIST YET ARE DECLARED HONESTLY. The brief lists contacts and campaigns.
// Neither has a table on this platform today — the contact CSV pipeline (src/lib/mail-csv.ts) is
// written and has no store behind it yet, and campaigns are the same. They are declared here with
// their table names and marked unavailable at run time by a `to_regclass` check, so the export screen
// says "campaigns: no table on this deployment" instead of silently producing an empty file that
// reads exactly like "this organization ran no campaigns". Those two states must never look alike.

export const EXPORT_FORMATS = ['jsonl', 'csv'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export type ExportStatus = 'pending' | 'running' | 'ready' | 'failed' | 'expired' | 'revoked';

export interface DatasetSpec {
  key: string;
  label: string;
  table: string;
  /** The column that scopes rows to one tenant. Null means the table is not tenant-scoped. */
  orgColumn: string | null;
  /** Column used for a date range filter, when the dataset supports one. */
  timeColumn: string | null;
  columns: string[];
  /** What a reader of the file is looking at, printed into the manifest. */
  describes: string;
  /**
   * True when the dataset contains message CONTENT rather than metadata. Content datasets need
   * `export.request` AND an explicit acknowledgement on the request — see contentDatasets().
   */
  content: boolean;
  /** The capability an actor must hold beyond export.request. Null for the ordinary ones. */
  extraCapability?: 'audit.export' | null;
}

/**
 * Columns that must never appear in any projection, whatever the dataset.
 *
 * Asserted by a test over the whole catalogue rather than trusted to review. `key_hash` is the only
 * copy of an API key we hold; `secret` signs webhook payloads and forging one is indistinguishable
 * from us sending it; `smtp_pass` is a live credential.
 */
export const FORBIDDEN_COLUMNS = [
  'key_hash', 'secret', 'previous_secret', 'smtp_pass', 'password_hash', 'password',
  'private_key', 'session_token', 'download_token_hash', 'content_hash_secret',
];

export const DATASETS: DatasetSpec[] = [
  {
    key: 'messages_metadata',
    label: 'Messages (metadata)',
    table: 'mailapi_messages',
    orgColumn: 'org_id', timeColumn: 'created_at',
    columns: [
      'id', 'environment', 'status', 'from_email', 'from_name', 'reply_to', 'to_emails', 'cc_emails',
      'subject', 'template_key', 'template_version', 'tags', 'metadata', 'attempts', 'last_error',
      'rfc_message_id', 'scheduled_at', 'queued_at', 'sent_at', 'delivered_at', 'failed_at', 'created_at',
    ],
    describes: 'One row per message: who it was addressed to, which template, what happened to it. Subject line included; bodies are not.',
    content: false,
  },
  {
    key: 'messages_content',
    label: 'Messages (with bodies)',
    table: 'mailapi_messages',
    orgColumn: 'org_id', timeColumn: 'created_at',
    columns: ['id', 'environment', 'status', 'from_email', 'to_emails', 'cc_emails', 'subject', 'body_html', 'body_text', 'created_at'],
    describes: 'The messages themselves, bodies included. This is correspondence: treat the file as you would the mailbox it came from.',
    content: true,
  },
  {
    key: 'delivery_events',
    label: 'Delivery events',
    table: 'mailapi_message_events',
    orgColumn: 'org_id', timeColumn: 'occurred_at',
    columns: ['id', 'message_id', 'environment', 'type', 'recipient', 'data', 'occurred_at'],
    describes: 'Every delivery, bounce, complaint, open and click event, one row each.',
    content: false,
  },
  {
    key: 'templates',
    label: 'Templates',
    table: 'mailapi_templates',
    orgColumn: 'org_id', timeColumn: 'created_at',
    columns: ['id', 'environment', 'template_key', 'name', 'description', 'is_archived', 'created_at', 'updated_at'],
    describes: 'Template names and keys. Versions are a separate dataset.',
    content: false,
  },
  {
    key: 'template_versions',
    label: 'Template versions',
    table: 'mailapi_template_versions',
    orgColumn: null, timeColumn: 'created_at',
    columns: ['id', 'template_id', 'version', 'state', 'subject', 'html', 'text', 'variables', 'published_at', 'created_at'],
    describes: 'The body of every template version. This is your own copy, not correspondence.',
    content: false,
  },
  {
    key: 'consent',
    label: 'Consent records',
    table: 'mailapi_consent',
    orgColumn: 'org_id', timeColumn: 'updated_at',
    columns: ['id', 'environment', 'email', 'category', 'status', 'consent_at', 'source', 'purpose', 'unsubscribed_at', 'unsubscribe_source', 'evidence', 'updated_at'],
    describes: 'Who agreed to what, when, from where, and who withdrew. The dataset to produce when a consent is questioned.',
    content: false,
  },
  {
    key: 'suppressions',
    label: 'Suppression list',
    table: 'mailapi_suppressions',
    orgColumn: 'org_id', timeColumn: 'created_at',
    columns: ['id', 'environment', 'email', 'reason', 'source', 'detail', 'created_at'],
    describes: 'Addresses this organization must not mail, and why.',
    content: false,
  },
  {
    key: 'domains',
    label: 'Sending domains',
    table: 'mailapi_domains',
    orgColumn: 'org_id', timeColumn: 'created_at',
    columns: ['id', 'environment', 'domain', 'status', 'spf_ok', 'dkim_ok', 'dmarc_ok', 'last_checked_at', 'check_detail', 'created_at'],
    describes: 'Domains and their SPF, DKIM and DMARC verification state.',
    content: false,
  },
  {
    key: 'api_keys',
    label: 'API key metadata',
    table: 'mailapi_keys',
    orgColumn: 'org_id', timeColumn: 'created_at',
    columns: ['id', 'environment', 'name', 'key_prefix', 'scopes', 'last_used_at', 'request_count', 'expires_at', 'revoked_at', 'revoked_reason', 'created_at'],
    describes: 'Which keys exist, their scopes and their usage. The keys themselves are not stored in a recoverable form and are not in this file.',
    content: false,
  },
  {
    key: 'webhooks',
    label: 'Webhook endpoints',
    table: 'mailapi_webhooks',
    orgColumn: 'org_id', timeColumn: 'created_at',
    columns: ['id', 'environment', 'url', 'description', 'events', 'status', 'verified_at', 'consecutive_failures', 'disabled_reason', 'created_at'],
    describes: 'Endpoint configuration. Signing secrets are excluded: exporting one would let the holder forge our signature.',
    content: false,
  },
  {
    key: 'members',
    label: 'Organization members',
    table: 'mailapi_org_members',
    orgColumn: 'org_id', timeColumn: 'created_at',
    columns: ['id', 'user_id', 'role', 'status', 'invited_by', 'created_at', 'updated_at', 'removed_at'],
    describes: 'Who belongs to this organization and in what role.',
    content: false,
  },
  {
    key: 'audit',
    label: 'Audit log',
    table: 'mailapi_audit_events',
    orgColumn: 'org_id', timeColumn: 'occurred_at',
    columns: ['id', 'seq', 'occurred_at', 'actor_user_id', 'actor_email', 'actor_role', 'action', 'target_type', 'target_id', 'result', 'reason', 'ip', 'request_id', 'meta', 'content_hash', 'prev_hash', 'hash'],
    describes: 'Administrative actions taken on this organization, with the hash chain included so the file can be verified independently.',
    content: false,
    extraCapability: 'audit.export',
  },
  {
    key: 'security_events',
    label: 'Security events',
    table: 'mailapi_security_events',
    orgColumn: 'org_id', timeColumn: 'occurred_at',
    columns: ['id', 'environment', 'type', 'severity', 'subject', 'actor_user_id', 'ip', 'detail', 'status', 'occurred_at'],
    describes: 'Failed logins, abuse signals and configuration changes recorded against this organization.',
    content: false,
  },
  // ---- declared, not yet backed by a table on this deployment --------------------------------
  {
    key: 'contacts',
    label: 'Contacts',
    table: 'mailapi_contacts',
    orgColumn: 'org_id', timeColumn: 'created_at',
    columns: ['id', 'email', 'first_name', 'last_name', 'organization', 'phone', 'role_title', 'status', 'tags', 'attributes', 'created_at', 'updated_at'],
    describes: 'The contact records themselves. Consent lives in its own dataset and is exported separately.',
    content: false,
  },
  {
    key: 'campaigns',
    label: 'Campaigns',
    table: 'mailapi_campaigns',
    orgColumn: 'org_id', timeColumn: 'created_at',
    columns: ['id', 'name', 'status', 'subject', 'template_id', 'scheduled_at', 'started_at', 'finished_at', 'stats', 'created_at'],
    describes: 'Campaign definitions and their outcome counters.',
    content: false,
  },
];

export const DATASET_KEYS = DATASETS.map((d) => d.key);

export function datasetByKey(key: string): DatasetSpec | null {
  return DATASETS.find((d) => d.key === key) || null;
}

/** Datasets carrying correspondence rather than metadata. The request screen names these explicitly. */
export function contentDatasets(keys: string[]): string[] {
  return keys.filter((k) => datasetByKey(k)?.content);
}

export interface ExportRequestValidation {
  ok: boolean;
  error?: string;
  datasets?: string[];
  /** True when the request includes at least one content dataset. */
  includesContent?: boolean;
}

/**
 * Is this a request the platform will accept?
 *
 * `acknowledgedContent` is a deliberate speed bump, not a checkbox for its own sake: a support
 * engineer building a routine metadata export and an administrator taking a copy of every message
 * anyone has ever sent are different acts, and the second should require saying so.
 */
export function validateExportRequest(input: {
  datasets: unknown;
  format: unknown;
  acknowledgedContent?: boolean;
}): ExportRequestValidation {
  const list = Array.isArray(input.datasets) ? input.datasets.map(String) : [];
  if (!list.length) return { ok: false, error: 'Choose at least one dataset.' };

  const unknown = list.filter((k) => !datasetByKey(k));
  if (unknown.length) return { ok: false, error: 'Unknown dataset: ' + unknown.join(', ') + '.' };

  if (!(EXPORT_FORMATS as readonly string[]).includes(String(input.format))) {
    return { ok: false, error: 'Format must be one of: ' + EXPORT_FORMATS.join(', ') + '.' };
  }

  const content = contentDatasets(list);
  if (content.length && !input.acknowledgedContent) {
    return {
      ok: false,
      error: 'This export includes message bodies (' + content.join(', ') + '). Confirm that you intend to take a copy of correspondence out of the platform.',
    };
  }
  return { ok: true, datasets: list, includesContent: content.length > 0 };
}

/**
 * How long a finished export can be downloaded for.
 *
 * Short on purpose. An export is a copy of a tenant's data sitting in object storage behind a URL; the
 * window is the time somebody has to fetch it, not a filing cabinet. Content exports get half as long
 * as metadata ones for the same reason they need an acknowledgement.
 */
export function downloadWindowHours(includesContent: boolean): number {
  return includesContent ? 12 : 48;
}

export function expiresAt(requestedAt: Date, includesContent: boolean): string {
  return new Date(requestedAt.getTime() + downloadWindowHours(includesContent) * 3600 * 1000).toISOString();
}

/** Has the window closed? Pure, so the download route and the list screen cannot disagree. */
export function isExpired(expiresAtIso: string | null, now: Date): boolean {
  if (!expiresAtIso) return true;
  const t = new Date(expiresAtIso).getTime();
  return !Number.isFinite(t) || t <= now.getTime();
}

// ---------------------------------------------------------------------------------------------
// Serialisation. Both formats are written here so an export and its manifest cannot disagree about
// what a null was, and so the CSV quoting has one implementation with tests on it.
// ---------------------------------------------------------------------------------------------

/**
 * RFC 4180 quoting, with the two additions a spreadsheet actually needs:
 *
 *   - a null becomes an EMPTY field, and the manifest says so. Writing the four letters `null` into a
 *     CSV produces a column where a real string "null" and an absent value are the same cell.
 *   - a value beginning with =, +, - or @ is prefixed with a single quote. Those characters make a
 *     spreadsheet treat the cell as a FORMULA, which is how an exported contact name becomes code
 *     that runs on the machine of whoever opens the file.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s: string;
  if (typeof value === 'object') s = JSON.stringify(value);
  else s = String(value);

  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.split('"').join('""') + '"';
  return s;
}

export function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(',');
}

export function serializeRows(format: ExportFormat, columns: string[], rows: Record<string, unknown>[]): string {
  if (format === 'csv') {
    const head = csvRow(columns);
    const body = rows.map((r) => csvRow(columns.map((c) => r[c])));
    return [head, ...body].join('\n') + (rows.length ? '\n' : '');
  }
  // JSONL: one object per line, keys restricted to the projection. A row is a line, so a truncated
  // file is a file with fewer rows rather than an unparseable one.
  return rows
    .map((r) => JSON.stringify(Object.fromEntries(columns.map((c) => [c, r[c] ?? null]))))
    .join('\n') + (rows.length ? '\n' : '');
}

export interface ExportManifest {
  exportId: string;
  orgId: string;
  organization: string;
  requestedBy: string;
  requestedAt: string;
  finishedAt: string;
  format: ExportFormat;
  expiresAt: string;
  files: { dataset: string; label: string; filename: string; rows: number; columns: string[]; describes: string; note?: string }[];
  notes: string[];
}

/**
 * The manifest that ships INSIDE every export.
 *
 * A file of rows with no statement of what was and was not included is a document somebody will
 * later misread as complete. The manifest names every dataset, its row count, its columns, and — the
 * part that matters — the datasets that were REQUESTED and produced nothing, with the reason.
 */
export function buildManifest(input: {
  exportId: string;
  orgId: string;
  organization: string;
  requestedBy: string;
  requestedAt: string;
  finishedAt: string;
  format: ExportFormat;
  expiresAt: string;
  results: { dataset: string; rows: number; note?: string }[];
}): ExportManifest {
  const files = input.results.map((r) => {
    const spec = datasetByKey(r.dataset);
    return {
      dataset: r.dataset,
      label: spec?.label || r.dataset,
      filename: r.dataset + '.' + input.format,
      rows: r.rows,
      columns: spec?.columns || [],
      describes: spec?.describes || '',
      note: r.note,
    };
  });
  const notes = [
    'Null values are written as empty fields in CSV and as null in JSONL.',
    'API key hashes, webhook signing secrets and SMTP credentials are never included in an export.',
    'A dataset with a note produced no rows for the reason given. An empty file and an unavailable dataset are not the same thing.',
  ];
  return { ...input, files, notes };
}
