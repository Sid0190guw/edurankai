// src/lib/mailops/env.ts — the environment contract, as data.
//
// WHY THIS IS CODE AND NOT A README. `.env.example` is a document, and a document cannot tell you
// that the environment you are actually running in is wrong. This file is the same contract in a
// form a health check, a CI job and a startup probe can all evaluate — so "the S3 credentials are
// three-quarters set" is a RESULT, not something a person has to notice.
//
// THE FAILURE THIS EXISTS TO CATCH is the partial group. The storage layer selects S3 only when
// every S3_* variable is present; set four of the five and it falls back to Vercel Blob without a
// word, and you discover it when an attachment is missing months later. Same shape for SMTP (host
// without credentials authenticates as nobody) and DKIM (selector published in DNS, key absent, so
// every signature fails and the DNS record makes it look configured).
//
// NOTHING HERE READS A VALUE'S CONTENTS INTO A RESULT. Presence, shape and grouping only. A
// validator that echoes a secret to prove it is set has published the secret to every log that
// captures the health response.

export type Tier = 'live' | 'stack' | 'future';
export type Sensitivity = 'public' | 'secret';

export interface VarSpec {
  name: string;
  tier: Tier;
  sensitivity: Sensitivity;
  /** Missing this one breaks a shipped surface. Reported as an error, not a note. */
  required?: boolean;
  /** All-or-nothing set. A partially-filled group is worse than an empty one. */
  group?: string;
  /** Human sentence, used verbatim in the health payload and CI output. */
  note: string;
}

/**
 * The variables this system actually reads, and the ones the mail platform has reserved.
 *
 * Deliberately NOT every variable in `.env.example` — only the ones with a rule worth enforcing.
 * A list that repeats the example file would drift from it within a week and then lie.
 */
export const VAR_SPECS: VarSpec[] = [
  { name: 'DATABASE_URL', tier: 'live', sensitivity: 'secret', required: true, note: 'Postgres connection. Serverless must use the transaction pooler (:6543).' },
  { name: 'SESSION_SECRET', tier: 'live', sensitivity: 'secret', required: true, note: 'Signs session material. Rotating it signs everyone out.' },
  { name: 'MAIL_DOMAIN', tier: 'live', sensitivity: 'public', note: 'Domain internal mailboxes are addressed under. Defaults to edurankai.in in code.' },
  { name: 'EMAIL_FROM', tier: 'live', sensitivity: 'public', note: 'Last-resort From address when the mail_config row is absent.' },

  { name: 'SMTP_HOST', tier: 'live', sensitivity: 'public', group: 'smtp', note: 'Outbound relay host. The DB row at /admin/mail/settings overrides this.' },
  { name: 'SMTP_PORT', tier: 'live', sensitivity: 'public', group: 'smtp', note: '587 STARTTLS or 465 implicit TLS. Mismatched with SMTP_SECURE is the commonest failure.' },
  { name: 'SMTP_USER', tier: 'live', sensitivity: 'public', group: 'smtp', note: 'Usually the full email address. Named SMTP_USER, not SMTP_USERNAME.' },
  { name: 'SMTP_PASS', tier: 'live', sensitivity: 'secret', group: 'smtp', note: 'Mailbox or app password. Named SMTP_PASS, not SMTP_PASSWORD.' },

  { name: 'MAIL_INBOUND_SECRET', tier: 'live', sensitivity: 'secret', note: 'Shared secret for POST /api/mail/inbound. Unset here means the DB row must supply it.' },
  { name: 'MAIL_WEBHOOK_SECRET', tier: 'future', sensitivity: 'secret', note: 'HMAC key for signed inbound webhooks. Preferred over the bare shared secret.' },

  { name: 'MAIL_SERVICE_URL', tier: 'future', sensitivity: 'public', group: 'mail-service', note: 'Where the Vercel API reaches the mail service. Must be publicly routable from Vercel.' },
  { name: 'MAIL_SERVICE_KEY', tier: 'future', sensitivity: 'secret', group: 'mail-service', note: 'HMAC key for app-to-mail-service calls.' },

  { name: 'S3_ENDPOINT', tier: 'live', sensitivity: 'public', group: 's3', note: 'S3-compatible endpoint. All five S3_* must be set or storage silently stays on Blob.' },
  { name: 'S3_REGION', tier: 'live', sensitivity: 'public', group: 's3', note: 'Bucket region.' },
  { name: 'S3_BUCKET', tier: 'live', sensitivity: 'public', group: 's3', note: 'Bucket name.' },
  { name: 'S3_ACCESS_KEY_ID', tier: 'live', sensitivity: 'secret', group: 's3', note: 'Access key.' },
  { name: 'S3_SECRET_ACCESS_KEY', tier: 'live', sensitivity: 'secret', group: 's3', note: 'Secret key.' },

  { name: 'DKIM_SELECTOR', tier: 'stack', sensitivity: 'public', group: 'dkim', note: 'Published as <selector>._domainkey.<domain>. Publishing it without a working key fails every signature.' },
  { name: 'DKIM_DOMAIN', tier: 'stack', sensitivity: 'public', group: 'dkim', note: 'Domain the key signs for.' },
  { name: 'DKIM_PRIVATE_KEY_PATH', tier: 'stack', sensitivity: 'secret', group: 'dkim', note: 'Path to the private key inside the container, mode 0600. Never in the repository.' },

  { name: 'REDIS_URL', tier: 'stack', sensitivity: 'secret', note: 'Local stack and future scale only. The shipped queue is Postgres and needs no Redis.' },
  { name: 'METRICS_TOKEN', tier: 'future', sensitivity: 'secret', note: 'Bearer token for GET /api/metrics. Unset means that endpoint answers 404.' },
  { name: 'CRON_SECRET', tier: 'live', sensitivity: 'secret', note: 'Guards cron routes. Whitespace in the value rejects every Vercel deploy in ~2s.' },
];

export interface VarState {
  name: string;
  tier: Tier;
  present: boolean;
  /** Only ever true/false — the value itself is never carried out of this module. */
  blank: boolean;
  note: string;
}

export interface GroupState {
  group: string;
  total: number;
  present: number;
  /** The state that silently breaks things: some set, some not. */
  partial: boolean;
  missing: string[];
}

export interface EnvReport {
  ok: boolean;
  /** Required-and-absent. These break a shipped surface right now. */
  errors: string[];
  /** Partially-configured groups, and stack/future variables worth knowing about. */
  warnings: string[];
  groups: GroupState[];
  vars: VarState[];
}

const isSet = (v: string | undefined): boolean => typeof v === 'string' && v.trim().length > 0;

/**
 * Evaluate an environment against VAR_SPECS.
 *
 * Takes the environment as an argument rather than reading process.env directly, so a test can
 * assert on a constructed environment and CI can check a `.env` file it parsed without exporting
 * any of it into its own process.
 */
export function checkEnv(env: Record<string, string | undefined>, specs: VarSpec[] = VAR_SPECS): EnvReport {
  const vars: VarState[] = specs.map((s) => ({
    name: s.name,
    tier: s.tier,
    present: isSet(env[s.name]),
    blank: s.name in env && !isSet(env[s.name]),
    note: s.note,
  }));

  const errors: string[] = [];
  const warnings: string[] = [];

  for (const s of specs) {
    if (s.required && !isSet(env[s.name])) errors.push(`${s.name} is required and not set — ${s.note}`);
  }

  const byGroup = new Map<string, VarSpec[]>();
  for (const s of specs) {
    if (!s.group) continue;
    const list = byGroup.get(s.group) || [];
    list.push(s);
    byGroup.set(s.group, list);
  }

  const groups: GroupState[] = [];
  for (const [group, members] of byGroup) {
    const missing = members.filter((m) => !isSet(env[m.name])).map((m) => m.name);
    const present = members.length - missing.length;
    const partial = present > 0 && missing.length > 0;
    groups.push({ group, total: members.length, present, partial, missing });
    if (partial) {
      warnings.push(
        `${group}: ${present}/${members.length} set — missing ${missing.join(', ')}. ` +
        `A partially-configured group does not half-work, it falls back silently.`,
      );
    }
  }
  groups.sort((a, b) => a.group.localeCompare(b.group));

  // Two shape checks that have each cost a real outage on this project.
  const cron = env.CRON_SECRET;
  if (typeof cron === 'string' && cron.length > 0 && cron !== cron.trim()) {
    errors.push('CRON_SECRET has leading or trailing whitespace — this rejects every Vercel deploy in about 2 seconds, with an error that does not name the variable.');
  }
  const dbUrl = env.DATABASE_URL || '';
  if (dbUrl.includes('supabase.com') && dbUrl.includes(':5432')) {
    warnings.push('DATABASE_URL points at Supabase port 5432 (direct/session). Serverless should use the transaction pooler on :6543; the direct port exhausts connections under Vercel concurrency.');
  }

  // SMTP port and TLS mode disagreeing is the single most common mail misconfiguration here.
  const port = Number(env.SMTP_PORT || 0);
  const secure = String(env.SMTP_SECURE || '').toLowerCase() === 'true';
  if (port === 587 && secure) warnings.push('SMTP_PORT=587 with SMTP_SECURE=true — 587 is STARTTLS. Implicit TLS on 587 fails with "wrong version number".');
  if (port === 465 && env.SMTP_SECURE !== undefined && !secure) warnings.push('SMTP_PORT=465 with SMTP_SECURE=false — 465 is implicit TLS and will time out without it.');
  if (String(env.SMTP_INSECURE || '').toLowerCase() === 'true') {
    warnings.push('SMTP_INSECURE=true accepts any TLS certificate. Acceptable against a local test MTA, never against a relay carrying real mail.');
  }

  return { ok: errors.length === 0, errors, warnings, groups, vars };
}

/**
 * The subset safe to put in an HTTP response.
 *
 * Names and booleans only. This is the shape /api/health/mail returns, and the reason it can be
 * returned at all: knowing that MAIL_WEBHOOK_SECRET is set discloses nothing; knowing its value
 * discloses everything.
 */
export function envSummary(env: Record<string, string | undefined>): { ok: boolean; errorCount: number; warningCount: number; partialGroups: string[] } {
  const r = checkEnv(env);
  return {
    ok: r.ok,
    errorCount: r.errors.length,
    warningCount: r.warnings.length,
    partialGroups: r.groups.filter((g) => g.partial).map((g) => g.group),
  };
}
