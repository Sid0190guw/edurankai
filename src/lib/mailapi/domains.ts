// src/lib/mailapi/domains.ts — sending identities and their DNS posture.
//
// A LOOKUP THAT DID NOT HAPPEN IS NOT AN ABSENT RECORD. src/pages/api/mail/dns-check.ts carries the
// full account of why: both of its helpers used to end in `catch { return [] }`, and an empty array
// is exactly what a domain with no SPF record produces — so a resolver timeout rendered "no SPF
// record found" as a statement of fact, on a screen whose documented next step is to ADD one, when a
// second SPF record makes providers treat the whole domain as failing SPF. A four-second timeout
// could talk an operator into breaking mail for the company.
//
// So every check here reports whether it RAN. `checked: false` is rendered as "could not be checked"
// and never as a verdict, and the reason travels with it.
import dns from 'node:dns/promises';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureMailApiSchema, rows } from './schema';
import { ApiError } from './errors';
import type { Environment } from './keys';

export interface RecordCheck {
  checked: boolean;
  ok: boolean | null;
  value: string | null;
  error: string | null;
}

const UNCHECKED: RecordCheck = { checked: false, ok: null, value: null, error: 'not checked' };

export function normalizeDomain(raw: string): string {
  const d = String(raw || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^@/, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d) || d.length > 253) {
    throw new ApiError('invalid_request', 'That is not a valid domain name.', { param: 'domain' });
  }
  return d;
}

async function txt(name: string): Promise<{ checked: boolean; values: string[]; error: string | null }> {
  try {
    const records = await dns.resolveTxt(name);
    return { checked: true, values: records.map((chunks) => chunks.join('')), error: null };
  } catch (e: any) {
    // ENOTFOUND / ENODATA genuinely mean "no such record" — that IS an answer, and treating it as
    // an unknown would be as unhelpful as the opposite mistake.
    if (e?.code === 'ENOTFOUND' || e?.code === 'ENODATA') return { checked: true, values: [], error: null };
    return { checked: false, values: [], error: String(e?.code || e?.message || 'lookup failed') };
  }
}

export async function checkDomain(domain: string, dkimSelectors: string[] = ['default', 'mail', 'selector1', 'era']): Promise<{
  spf: RecordCheck; dmarc: RecordCheck; dkim: RecordCheck; mx: RecordCheck;
}> {
  const d = normalizeDomain(domain);

  const spfRaw = await txt(d);
  const spfValue = spfRaw.values.find((v) => /^v=spf1\b/i.test(v)) || null;
  const spf: RecordCheck = spfRaw.checked
    ? { checked: true, ok: !!spfValue, value: spfValue, error: spfRaw.values.filter((v) => /^v=spf1\b/i.test(v)).length > 1 ? 'more than one SPF record: providers treat this as a permanent SPF failure' : null }
    : { ...UNCHECKED, error: spfRaw.error };

  const dmarcRaw = await txt('_dmarc.' + d);
  const dmarcValue = dmarcRaw.values.find((v) => /^v=DMARC1\b/i.test(v)) || null;
  const dmarc: RecordCheck = dmarcRaw.checked
    ? { checked: true, ok: !!dmarcValue, value: dmarcValue, error: null }
    : { ...UNCHECKED, error: dmarcRaw.error };

  let dkim: RecordCheck = { checked: true, ok: false, value: null, error: null };
  const dkimErrors: string[] = [];
  for (const selector of dkimSelectors) {
    const r = await txt(selector + '._domainkey.' + d);
    if (!r.checked) { dkimErrors.push(selector + ': ' + r.error); continue; }
    const hit = r.values.find((v) => /(^|;)\s*(v=DKIM1|k=rsa|p=)/i.test(v));
    if (hit) { dkim = { checked: true, ok: true, value: selector + ': ' + hit.slice(0, 80) + (hit.length > 80 ? '...' : ''), error: null }; break; }
  }
  if (!dkim.ok && dkimErrors.length === dkimSelectors.length) {
    dkim = { ...UNCHECKED, error: dkimErrors.join('; ') };
  } else if (!dkim.ok) {
    dkim = { checked: true, ok: false, value: null, error: 'no DKIM key found on the selectors we know: ' + dkimSelectors.join(', ') };
  }

  let mx: RecordCheck;
  try {
    const records = await dns.resolveMx(d);
    mx = { checked: true, ok: records.length > 0, value: records.map((r) => r.exchange).slice(0, 3).join(', ') || null, error: null };
  } catch (e: any) {
    mx = (e?.code === 'ENOTFOUND' || e?.code === 'ENODATA')
      ? { checked: true, ok: false, value: null, error: null }
      : { ...UNCHECKED, error: String(e?.code || e?.message || 'lookup failed') };
  }

  return { spf, dmarc, dkim, mx };
}

export interface SendingDomain {
  id: string;
  domain: string;
  environment: string;
  status: string;
  spfOk: boolean | null;
  dkimOk: boolean | null;
  dmarcOk: boolean | null;
  lastCheckedAt: string | null;
  detail: Record<string, any>;
  createdAt: string;
}

function mapDomain(r: any): SendingDomain {
  return {
    id: r.id, domain: r.domain, environment: r.environment, status: r.status,
    spfOk: r.spf_ok, dkimOk: r.dkim_ok, dmarcOk: r.dmarc_ok,
    lastCheckedAt: r.last_checked_at || null,
    detail: r.check_detail && typeof r.check_detail === 'object' ? r.check_detail : {},
    createdAt: r.created_at,
  };
}

export async function addDomain(orgId: string, environment: Environment, domain: string): Promise<SendingDomain> {
  await ensureMailApiSchema();
  const d = normalizeDomain(domain);
  const r = rows(await db.execute(sql`
    INSERT INTO mailapi_domains (org_id, environment, domain) VALUES (${orgId}, ${environment}, ${d})
    ON CONFLICT (org_id, environment, domain) DO UPDATE SET updated_at = now()
    RETURNING id, domain, environment, status, spf_ok, dkim_ok, dmarc_ok, last_checked_at, check_detail, created_at`));
  return mapDomain(r[0]);
}

export async function listDomains(orgId: string, environment: Environment): Promise<SendingDomain[]> {
  await ensureMailApiSchema();
  return rows(await db.execute(sql`
    SELECT id, domain, environment, status, spf_ok, dkim_ok, dmarc_ok, last_checked_at, check_detail, created_at
    FROM mailapi_domains WHERE org_id = ${orgId} AND environment = ${environment}
    ORDER BY domain ASC LIMIT 100`)).map(mapDomain);
}

/**
 * Re-run the checks and store the result.
 *
 * `status` becomes 'verified' only when SPF and DKIM both genuinely passed a check that RAN. A
 * lookup that failed leaves the previous status alone rather than downgrading a working domain
 * because a resolver had a bad minute.
 */
export async function verifyDomain(orgId: string, environment: Environment, domain: string): Promise<SendingDomain | null> {
  await ensureMailApiSchema();
  const d = normalizeDomain(domain);
  const checks = await checkDomain(d);
  const decided = checks.spf.checked && checks.dkim.checked;
  const verified = decided && checks.spf.ok === true && checks.dkim.ok === true;
  const r = rows(await db.execute(sql`
    UPDATE mailapi_domains SET
      spf_ok = ${checks.spf.checked ? checks.spf.ok : null},
      dkim_ok = ${checks.dkim.checked ? checks.dkim.ok : null},
      dmarc_ok = ${checks.dmarc.checked ? checks.dmarc.ok : null},
      status = COALESCE(${decided ? (verified ? 'verified' : 'unverified') : null}, status),
      last_checked_at = now(), check_detail = ${JSON.stringify(checks)}::jsonb, updated_at = now()
    WHERE org_id = ${orgId} AND environment = ${environment} AND domain = ${d}
    RETURNING id, domain, environment, status, spf_ok, dkim_ok, dmarc_ok, last_checked_at, check_detail, created_at`));
  return r[0] ? mapDomain(r[0]) : null;
}

export async function removeDomain(orgId: string, environment: Environment, domain: string): Promise<boolean> {
  await ensureMailApiSchema();
  const r = rows(await db.execute(sql`
    DELETE FROM mailapi_domains WHERE org_id = ${orgId} AND environment = ${environment} AND domain = ${normalizeDomain(domain)} RETURNING id`));
  return r.length > 0;
}
