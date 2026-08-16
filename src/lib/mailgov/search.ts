// src/lib/mailgov/search.ts — THE ADMIN SEARCH BOX.
//
// The classification is in ./search-parse.ts (pure, tested). This runs the lookups it chose.
//
// TWO PROPERTIES THAT ARE NOT NEGOTIABLE HERE:
//
//   1. EVERY QUERY CARRIES THE TENANT SCOPE. `scopeOrgId` is threaded into every statement below, and
//      a tenant-scoped actor cannot reach a row belonging to anybody else even by searching for its
//      exact id. The scope comes from the resolved GovActor, never from the request — a search box
//      that takes an organization id as a parameter is a search box that leaks one.
//
//   2. NO MESSAGE SUBJECTS, NO MESSAGE BODIES. Search matches ids, addresses and envelopes. This is
//      the difference between an administration tool and a way to read the customers' mail: a subject
//      line search would let anybody with the console reconstruct what people are writing about by
//      guessing words, with no grant, no approval and nothing on the security screen.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureGovernanceSchema, rows, dbReason, tableExists } from './schema';
import { likeLiteral, parseSearch, searchable, type ParsedQuery, type SearchTarget } from './search-parse';
import { maskEmail } from './support-policy';

export interface SearchHit {
  kind: SearchTarget;
  id: string;
  title: string;
  subtitle: string;
  orgId: string | null;
  /** Where the console should send somebody who clicks it. */
  href: string | null;
  occurredAt?: string | null;
}

export interface SearchOutcome {
  ok: boolean;
  error?: string;
  query: ParsedQuery;
  hits: SearchHit[];
  /** Stores that were asked and failed, named individually. A partial result must not look complete. */
  failed: { target: SearchTarget; reason: string }[];
  /** Stores that were skipped because the table does not exist on this deployment. */
  skipped: { target: SearchTarget; reason: string }[];
}

/**
 * Run a search.
 *
 * A FAILED STORE IS NAMED, NOT SWALLOWED. If the message lookup times out and the organization lookup
 * succeeds, the caller gets the organization hit AND a line saying the message store could not be
 * searched. Returning three hits and hiding the fourth store's failure produces a confident "not
 * found" for something that is right there.
 */
export async function runSearch(input: {
  q: string;
  scopeOrgId: string | null;
  limitPerTarget?: number;
}): Promise<SearchOutcome> {
  const query = parseSearch(input.q);
  const base: SearchOutcome = { ok: true, query, hits: [], failed: [], skipped: [] };

  const usable = searchable(query);
  if (!usable.ok) return { ...base, ok: false, error: usable.error };

  const limit = Math.min(Math.max(Number(input.limitPerTarget) || 10, 1), 50);
  const org = input.scopeOrgId;

  try {
    await ensureGovernanceSchema();
  } catch (e: any) {
    return { ...base, ok: false, error: dbReason(e) };
  }

  for (const target of query.targets) {
    try {
      const hits = await searchTarget(target, query, org, limit);
      if (hits === null) {
        base.skipped.push({ target, reason: 'No table for this record type on this deployment yet.' });
        continue;
      }
      base.hits.push(...hits);
    } catch (e: any) {
      base.failed.push({ target, reason: dbReason(e) });
    }
  }

  return base;
}

/** Null means "this store does not exist here", which is different from "no results". */
async function searchTarget(
  target: SearchTarget,
  q: ParsedQuery,
  org: string | null,
  limit: number,
): Promise<SearchHit[] | null> {
  const like = '%' + likeLiteral(q.value) + '%';
  const isUuid = q.kind === 'uuid';

  switch (target) {
    case 'organizations': {
      const r = rows(await db.execute(sql`
        SELECT id, slug, name, status FROM mailapi_orgs
         WHERE ${org ? sql`id = ${org}::uuid` : sql`TRUE`}
           AND (${isUuid ? sql`id = ${q.value}::uuid` : sql`(LOWER(slug) LIKE ${like} OR LOWER(name) LIKE ${like})`})
         LIMIT ${limit}`));
      return r.map((x: any) => ({
        kind: 'organizations' as const, id: String(x.id), title: String(x.name),
        subtitle: String(x.slug) + ' — ' + String(x.status || 'active'), orgId: String(x.id),
        href: '/admin/mail/enterprise/organizations?org=' + String(x.id),
      }));
    }

    case 'members': {
      const r = rows(await db.execute(sql`
        SELECT m.id, m.org_id, m.user_id, m.role, m.status, u.email, u.name
          FROM mailapi_org_members m LEFT JOIN users u ON u.id = m.user_id
         WHERE m.removed_at IS NULL
           AND ${org ? sql`m.org_id = ${org}::uuid` : sql`TRUE`}
           AND (${isUuid ? sql`m.user_id = ${q.value}::uuid` : sql`LOWER(u.email) LIKE ${like}`})
         LIMIT ${limit}`));
      return r.map((x: any) => ({
        kind: 'members' as const, id: String(x.user_id),
        title: String(x.name || x.email || x.user_id),
        subtitle: String(x.role) + ' — ' + String(x.status),
        orgId: String(x.org_id),
        href: '/admin/mail/enterprise/users?org=' + String(x.org_id) + '&user=' + String(x.user_id),
      }));
    }

    case 'messages': {
      // Envelope columns only. No subject, no body — see the note at the top of this file.
      const r = rows(await db.execute(sql`
        SELECT id, org_id, status, to_emails, created_at, rfc_message_id
          FROM mailapi_messages
         WHERE ${org ? sql`org_id = ${org}::uuid` : sql`TRUE`}
           AND (${
             q.kind === 'uuid' ? sql`id = ${q.value}::uuid`
             : q.kind === 'rfc_message_id' ? sql`LOWER(rfc_message_id) = ${q.value} OR LOWER(rfc_message_id) = ${'<' + q.value + '>'}`
             : q.kind === 'email' ? sql`to_emails @> ${JSON.stringify([q.value])}::jsonb`
             : q.kind === 'domain' ? sql`from_email LIKE ${'%@' + q.value}`
             : sql`FALSE`})
         ORDER BY created_at DESC LIMIT ${limit}`));
      return r.map((x: any) => ({
        kind: 'messages' as const, id: String(x.id),
        title: 'Message ' + String(x.id).slice(0, 8),
        subtitle: String(x.status) + ' — ' + (Array.isArray(x.to_emails) ? x.to_emails.map((e: any) => maskEmail(String(e))).join(', ') : ''),
        orgId: x.org_id ? String(x.org_id) : null,
        href: '/admin/mail/enterprise/support?message=' + String(x.id),
        occurredAt: x.created_at ? new Date(x.created_at).toISOString() : null,
      }));
    }

    case 'message_events': {
      const r = rows(await db.execute(sql`
        SELECT id, message_id, org_id, type, recipient, occurred_at FROM mailapi_message_events
         WHERE ${org ? sql`org_id = ${org}::uuid` : sql`TRUE`}
           AND (${q.kind === 'email' ? sql`recipient = ${q.value}` : q.kind === 'uuid' ? sql`message_id = ${q.value}::uuid` : sql`FALSE`})
         ORDER BY occurred_at DESC LIMIT ${limit}`));
      return r.map((x: any) => ({
        kind: 'message_events' as const, id: String(x.id),
        title: String(x.type), subtitle: maskEmail(String(x.recipient || '')),
        orgId: x.org_id ? String(x.org_id) : null,
        href: '/admin/mail/enterprise/support?message=' + String(x.message_id),
        occurredAt: x.occurred_at ? new Date(x.occurred_at).toISOString() : null,
      }));
    }

    case 'domains': {
      const r = rows(await db.execute(sql`
        SELECT id, org_id, domain, status FROM mailapi_domains
         WHERE ${org ? sql`org_id = ${org}::uuid` : sql`TRUE`}
           AND (${isUuid ? sql`id = ${q.value}::uuid` : sql`LOWER(domain) LIKE ${like}`})
         LIMIT ${limit}`));
      return r.map((x: any) => ({
        kind: 'domains' as const, id: String(x.id), title: String(x.domain),
        subtitle: String(x.status), orgId: String(x.org_id),
        href: '/admin/mail/enterprise/organizations?org=' + String(x.org_id),
      }));
    }

    case 'api_keys': {
      // key_prefix only. The hash is never searched and never displayed: a search that matched on it
      // would confirm a guessed key.
      const r = rows(await db.execute(sql`
        SELECT id, org_id, name, key_prefix, environment, revoked_at FROM mailapi_keys
         WHERE ${org ? sql`org_id = ${org}::uuid` : sql`TRUE`}
           AND (${isUuid ? sql`id = ${q.value}::uuid` : sql`LOWER(key_prefix) LIKE ${like}`})
         LIMIT ${limit}`));
      return r.map((x: any) => ({
        kind: 'api_keys' as const, id: String(x.id),
        title: String(x.name || x.key_prefix),
        subtitle: String(x.key_prefix) + ' — ' + String(x.environment) + (x.revoked_at ? ' (revoked)' : ''),
        orgId: String(x.org_id),
        href: '/admin/mail/enterprise/organizations?org=' + String(x.org_id),
      }));
    }

    case 'security_events': {
      const r = rows(await db.execute(sql`
        SELECT id, org_id, type, severity, subject, ip, occurred_at FROM mailapi_security_events
         WHERE ${org ? sql`org_id = ${org}::uuid` : sql`TRUE`}
           AND (${q.kind === 'ip' ? sql`ip = ${q.value}` : q.kind === 'uuid' ? sql`actor_user_id = ${q.value}::uuid` : sql`LOWER(subject) LIKE ${like}`})
         ORDER BY occurred_at DESC LIMIT ${limit}`));
      return r.map((x: any) => ({
        kind: 'security_events' as const, id: String(x.id),
        title: String(x.type), subtitle: String(x.severity) + ' — ' + String(x.subject || x.ip || ''),
        orgId: x.org_id ? String(x.org_id) : null,
        href: '/admin/mail/enterprise/security',
        occurredAt: x.occurred_at ? new Date(x.occurred_at).toISOString() : null,
      }));
    }

    case 'audit': {
      const r = rows(await db.execute(sql`
        SELECT id, seq, org_id, action, target_type, target_id, actor_email, occurred_at
          FROM mailapi_audit_events
         WHERE ${org ? sql`org_id = ${org}::uuid` : sql`TRUE`}
           AND (${isUuid ? sql`target_id = ${q.value} OR actor_user_id = ${q.value}::uuid` : sql`LOWER(target_id) LIKE ${like}`})
         ORDER BY seq DESC LIMIT ${limit}`));
      return r.map((x: any) => ({
        kind: 'audit' as const, id: String(x.id),
        title: String(x.action),
        subtitle: (x.actor_email ? String(x.actor_email) : 'system') + ' — ' + String(x.target_type || '') + ' ' + String(x.target_id || ''),
        orgId: x.org_id ? String(x.org_id) : null,
        href: '/admin/mail/enterprise/audit?seq=' + String(x.seq),
        occurredAt: x.occurred_at ? new Date(x.occurred_at).toISOString() : null,
      }));
    }

    case 'consent': {
      const r = rows(await db.execute(sql`
        SELECT id, org_id, email, category, status, updated_at FROM mailapi_consent
         WHERE ${org ? sql`org_id = ${org}::uuid` : sql`TRUE`}
           AND email = ${q.value}
         LIMIT ${limit}`));
      return r.map((x: any) => ({
        kind: 'consent' as const, id: String(x.id),
        title: String(x.category) + ': ' + String(x.status),
        subtitle: maskEmail(String(x.email)), orgId: String(x.org_id),
        href: '/admin/mail/enterprise/consent?org=' + String(x.org_id) + '&email=' + encodeURIComponent(String(x.email)),
        occurredAt: x.updated_at ? new Date(x.updated_at).toISOString() : null,
      }));
    }

    case 'suppressions': {
      const r = rows(await db.execute(sql`
        SELECT id, org_id, email, reason, created_at FROM mailapi_suppressions
         WHERE ${org ? sql`org_id = ${org}::uuid` : sql`TRUE`}
           AND (${q.kind === 'email' ? sql`email = ${q.value}` : sql`email LIKE ${'%@' + q.value}`})
         LIMIT ${limit}`));
      return r.map((x: any) => ({
        kind: 'suppressions' as const, id: String(x.id),
        title: 'Suppressed: ' + maskEmail(String(x.email)), subtitle: String(x.reason),
        orgId: String(x.org_id),
        href: '/admin/mail/enterprise/consent?org=' + String(x.org_id),
        occurredAt: x.created_at ? new Date(x.created_at).toISOString() : null,
      }));
    }

    case 'campaigns': {
      if (!(await tableExists('mailapi_campaigns'))) return null;
      const r = rows(await db.execute(sql`
        SELECT id, org_id, name, status FROM mailapi_campaigns
         WHERE ${org ? sql`org_id = ${org}::uuid` : sql`TRUE`}
           AND (${isUuid ? sql`id = ${q.value}::uuid` : sql`LOWER(name) LIKE ${like}`})
         LIMIT ${limit}`));
      return r.map((x: any) => ({
        kind: 'campaigns' as const, id: String(x.id), title: String(x.name),
        subtitle: String(x.status), orgId: String(x.org_id), href: null,
      }));
    }

    case 'mailboxes': {
      if (!(await tableExists('mail_box'))) return null;
      // The internal mail store belongs to no tenant, so a tenant-scoped actor is not shown it at all
      // rather than being shown an empty result they might read as "this person has no mailbox".
      if (org) return null;
      const r = rows(await db.execute(sql`
        SELECT b.user_id, COUNT(*)::int AS messages, u.email, u.name
          FROM mail_box b LEFT JOIN users u ON u.id = b.user_id
         WHERE ${q.kind === 'uuid' ? sql`b.user_id = ${q.value}::uuid` : sql`LOWER(u.email) LIKE ${like}`}
         GROUP BY b.user_id, u.email, u.name LIMIT ${limit}`));
      return r.map((x: any) => ({
        kind: 'mailboxes' as const, id: String(x.user_id),
        title: String(x.name || x.email || x.user_id),
        subtitle: String(x.messages) + ' messages held',
        orgId: null,
        href: '/admin/mail/enterprise/support?mailbox=' + String(x.user_id),
      }));
    }

    default:
      return [];
  }
}
