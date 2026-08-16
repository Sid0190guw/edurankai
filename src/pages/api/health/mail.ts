// GET /api/health/mail — the mail subsystem, component by component.
//
// The brief asks for the health of: application, database, Redis, queue, SMTP, IMAP, inbound
// processing, outbound processing, storage. That list is answered here, with one rule applied to
// every line: A COMPONENT THAT IS NOT DEPLOYED REPORTS `not-configured`, NEVER `ok`.
//
// That rule is the whole value of this endpoint. Redis is not part of the shipped system — the
// queue is Postgres — so a green "Redis: ok" would be a lie told by a check that never ran. The
// status vocabulary is deliberately three-valued:
//   ok             — checked, and it answered
//   degraded       — checked, and the answer was bad
//   not-configured — nothing to check; this component is not deployed here
// Only `degraded` on a component marked `critical` moves the overall status. A not-configured
// component is information, not an outage.
//
// GATED, because it discloses the mail host, port, queue depths and which secrets exist. Same
// capability as /api/health/deep — `administer` on platform — so a URL can never answer more than
// the page it belongs to. Fails closed: an authorization error denies.
//
// NOT FOR POLLING. It opens a TCP connection to the SMTP host. Poll /api/health; open this when
// that goes red, or when /admin/mail/health does not explain enough.
import type { APIRoute } from 'astro';
import { can } from '@/lib/rbac/guard';
import { dbPing, mailReachability } from '@/lib/observability-health';
import { queueHealth } from '@/lib/job-queue';
import { checkEnv } from '@/lib/mailops/env';

export const prerender = false;

const json = (body: any, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'cache-control': 'no-store, max-age=0' },
  });

type State = 'ok' | 'degraded' | 'not-configured';
interface Component { name: string; state: State; critical?: boolean; detail: string }

/** Never let one component's failure hide the other eight. */
async function attempt<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: string }> {
  try { return { value: await fn() }; } catch (e: any) { return { error: String(e?.cause?.message || e?.message || 'failed').slice(0, 200) }; }
}

export const GET: APIRoute = async ({ locals }) => {
  const user = (locals as any)?.user;
  if (!user) return json({ error: 'authentication required' }, 401);
  let allowed = false;
  try {
    const gate = await can(user, 'administer', { type: 'platform' });
    allowed = gate.allow === true;
  } catch (e: any) {
    const { trackError } = await import('@/lib/logger');
    await trackError('health.mail_authz_failed', e, { userId: user?.id ?? null });
    allowed = false;
  }
  if (!allowed) return json({ error: 'forbidden' }, 403);

  const env = process.env as any;
  const components: Component[] = [];

  // --- application ------------------------------------------------------------------------------
  components.push({
    name: 'application',
    state: 'ok',
    detail: `serving; node ${process.version}${env.VERCEL_GIT_COMMIT_SHA ? `, commit ${String(env.VERCEL_GIT_COMMIT_SHA).slice(0, 7)}` : ''}`,
  });

  // --- database ---------------------------------------------------------------------------------
  const db = await attempt(() => dbPing());
  components.push({
    name: 'database',
    state: db.value?.ok ? 'ok' : 'degraded',
    critical: true,
    detail: db.value?.ok ? `SELECT 1 in ${db.value.latencyMs}ms` : (db.error || 'unreachable'),
  });

  // --- queue (Postgres, edu_jobs) ---------------------------------------------------------------
  const q = await attempt(() => queueHealth());
  if (q.value) {
    const backlog = q.value.pending + q.value.processing;
    components.push({
      name: 'queue',
      state: q.value.failed > 0 || backlog > 1000 ? 'degraded' : 'ok',
      critical: true,
      detail: `pending ${q.value.pending}, processing ${q.value.processing}, failed ${q.value.failed} (driver: postgres/edu_jobs)`,
    });
  } else {
    components.push({ name: 'queue', state: 'degraded', critical: true, detail: q.error || 'queue table unreadable' });
  }

  // --- Redis ------------------------------------------------------------------------------------
  // Not deployed. Saying so is the point; a green tick for an absent component is worse than no tick.
  components.push({
    name: 'redis',
    state: env.REDIS_URL ? 'ok' : 'not-configured',
    detail: env.REDIS_URL
      ? 'REDIS_URL is set — note this endpoint reports configuration, not a live PING; the app does not open a Redis client'
      : 'not deployed: the shipped queue is Postgres (edu_jobs). Redis is local-stack and future-scale only.',
  });

  // --- SMTP (outbound transport) ----------------------------------------------------------------
  const smtp = await attempt(() => mailReachability());
  if (smtp.value) {
    const s = smtp.value;
    components.push({
      name: 'smtp',
      state: !s.configured ? 'not-configured' : s.reachable === true ? 'ok' : 'degraded',
      critical: s.configured,
      detail: s.configured ? `${s.host}:${s.port} — ${s.detail} (config source: ${s.source})` : s.detail,
    });
  } else {
    components.push({ name: 'smtp', state: 'degraded', detail: smtp.error || 'transport unreadable' });
  }

  // --- IMAP (inbound retrieval) -----------------------------------------------------------------
  const imap = await attempt(async () => (await import('@/lib/mail-imap')).getImapConfig());
  if (imap.value) {
    const host = (imap.value as any)?.host || '';
    components.push({
      name: 'imap',
      state: host ? 'ok' : 'not-configured',
      // Configuration presence only — an IMAP LOGIN on a health check burns a connection and some
      // providers rate-limit repeated authentications. /admin/mail/settings has the live test button.
      detail: host ? `${host}:${(imap.value as any)?.port || 993} configured (not authenticated by this check — use the IMAP test on /admin/mail/settings)` : 'no IMAP mailbox configured — nothing is pulling external mail in',
    });
  } else {
    components.push({ name: 'imap', state: 'degraded', detail: imap.error || 'IMAP config unreadable' });
  }

  // --- inbound processing -----------------------------------------------------------------------
  const inboundSecretSet = !!(env.MAIL_INBOUND_SECRET || '').trim();
  const webhookSecretSet = !!(env.MAIL_WEBHOOK_SECRET || '').trim();
  components.push({
    name: 'inbound',
    // The DB row can supply the secret when env does not, so "no env secret" is not by itself a
    // fault — but no secret ANYWHERE means /api/mail/inbound refuses every MTA, and that is silent
    // mail loss from the sender's point of view.
    state: inboundSecretSet || webhookSecretSet ? 'ok' : 'not-configured',
    detail: webhookSecretSet
      ? 'signed webhooks available (HMAC + replay window)'
      : inboundSecretSet
        ? 'shared-secret only — a captured request can be replayed; set MAIL_WEBHOOK_SECRET to move to signatures'
        : 'no inbound secret in env; the mail_config row must supply one or every inbound delivery is refused',
  });

  // --- outbound processing ----------------------------------------------------------------------
  const outbound = await attempt(async () => {
    const { db: database } = await import('@/lib/db');
    const { sql } = await import('drizzle-orm');
    const r: any = await database.execute(sql`
      SELECT status, COUNT(*)::int AS count
      FROM email_logs
      WHERE created_at > NOW() - INTERVAL '24 hours'
      GROUP BY status`);
    // postgres-js returns a plain array; r.rows[0] is the shape that breaks here.
    return (Array.isArray(r) ? r : (r?.rows || [])) as { status: string; count: number }[];
  });
  if (outbound.value) {
    const total = outbound.value.reduce((n, r) => n + Number(r.count || 0), 0);
    const failed = outbound.value.filter((r) => /fail|error|bounce/i.test(r.status || '')).reduce((n, r) => n + Number(r.count || 0), 0);
    components.push({
      name: 'outbound',
      state: total > 0 && failed / total > 0.1 ? 'degraded' : 'ok',
      detail: total === 0 ? 'no delivery attempts in 24h' : `${total} attempts in 24h, ${failed} failed (${Math.round((failed / total) * 100)}%)`,
    });
  } else {
    components.push({ name: 'outbound', state: 'degraded', detail: outbound.error || 'email_logs unreadable' });
  }

  // --- storage ----------------------------------------------------------------------------------
  const s3Complete = ['S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'].every((k) => (env[k] || '').trim());
  const s3Partial = !s3Complete && ['S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'].some((k) => (env[k] || '').trim());
  components.push({
    name: 'storage',
    state: s3Partial ? 'degraded' : (s3Complete || env.BLOB_READ_WRITE_TOKEN) ? 'ok' : 'not-configured',
    detail: s3Partial
      ? 'S3 is PARTIALLY configured — storage has silently fallen back to Blob. Set all five S3_* or none.'
      : s3Complete ? 'S3-compatible storage configured' : env.BLOB_READ_WRITE_TOKEN ? 'Vercel Blob (migration target is S3-compatible)' : 'no object storage configured — attachments have nowhere to go',
  });

  const envReport = checkEnv(env);
  const failing = components.filter((c) => c.critical && c.state === 'degraded');
  const status: 'ok' | 'degraded' | 'down' = components.find((c) => c.name === 'database')!.state === 'degraded'
    ? 'down'
    : failing.length || components.some((c) => c.state === 'degraded') ? 'degraded' : 'ok';

  return json({
    status,
    at: new Date().toISOString(),
    components,
    environment: {
      errors: envReport.errors,
      warnings: envReport.warnings,
      partialGroups: envReport.groups.filter((g) => g.partial),
    },
  }, status === 'down' ? 503 : 200);
};
