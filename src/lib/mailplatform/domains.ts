// src/lib/mailplatform/domains.ts — domain ownership, DKIM keys, and verification.
//
// A domain is not "added" here so much as CLAIMED and then PROVEN. Nothing may send as a domain
// until DNS published by whoever controls it says so — otherwise the platform is a way to send mail
// as any domain its operator can type.
//
// THE PRIVATE KEY IS NOT IN THE DATABASE. mp_dkim_keys stores the public key (which is published in
// DNS anyway) and a REFERENCE naming where the signing key lives — an environment variable, a KMS
// id, a mounted path. A DKIM private key in a queryable column is one SQL injection or one careless
// backup away from letting anyone sign mail as the domain, which is precisely the thing DKIM exists
// to prevent. See /docs/INTEGRATION-CONTRACTS.md for how the MTA resolves the reference.

import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { providers } from './providers';
import { EVENT_TYPES } from './adapters/event-bus-postgres';
import { DEFAULT_DKIM_SELECTOR, requiredRecordsFor } from './adapters/domain-dns';
import type { DkimKey, DnsRecord, Domain, DomainPurpose, DomainVerification, UUID } from './types';

const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
const causeOf = (e: any): string => String(e?.cause?.message || e?.message || 'unknown error');
const iso = (v: any): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

/** RFC 1035 label rules, plus a length cap. Rejects a URL, an email, and a trailing dot. */
export const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function normalizeDomain(input: unknown): string {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .replace(/\.$/, '');
}

export function isValidDomain(input: unknown): boolean {
  return DOMAIN_RE.test(normalizeDomain(input));
}

function toDomain(row: any): Domain {
  return {
    id: row.id,
    orgId: row.org_id,
    domain: row.domain,
    status: row.status,
    purpose: row.purpose,
    verificationToken: row.verification_token,
    verifiedAt: iso(row.verified_at),
    dkimSelector: row.dkim_selector ?? null,
    createdAt: iso(row.created_at) || '',
    updatedAt: iso(row.updated_at) || '',
    deletedAt: iso(row.deleted_at),
  };
}

function toDkim(row: any): DkimKey {
  return {
    id: row.id,
    orgId: row.org_id,
    domainId: row.domain_id,
    selector: row.selector,
    algorithm: row.algorithm,
    keySize: row.key_size ?? null,
    publicKey: row.public_key,
    privateKeyRef: row.private_key_ref ?? null,
    status: row.status,
    activatedAt: iso(row.activated_at),
    retiredAt: iso(row.retired_at),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listDomains(orgId: UUID): Promise<Domain[]> {
  try {
    const r = rows(await db.execute(sql`
      SELECT * FROM mp_domains WHERE org_id = ${orgId} AND deleted_at IS NULL ORDER BY domain ASC LIMIT 500`));
    return r.map(toDomain);
  } catch (e: any) {
    console.error('[mailplatform/domains] list failed -', causeOf(e));
    return [];
  }
}

export async function getDomain(orgId: UUID, idOrName: string): Promise<Domain | null> {
  if (!idOrName) return null;
  try {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrName.trim());
    const r = rows(await db.execute(
      isUuid
        ? sql`SELECT * FROM mp_domains WHERE org_id = ${orgId} AND id = ${idOrName.trim()} AND deleted_at IS NULL LIMIT 1`
        : sql`SELECT * FROM mp_domains WHERE org_id = ${orgId} AND lower(domain) = ${normalizeDomain(idOrName)} AND deleted_at IS NULL LIMIT 1`,
    ));
    return r.length ? toDomain(r[0]) : null;
  } catch (e: any) {
    console.error('[mailplatform/domains] get failed -', causeOf(e));
    return null;
  }
}

export async function getActiveDkim(domainId: UUID): Promise<DkimKey | null> {
  try {
    const r = rows(await db.execute(sql`
      SELECT * FROM mp_dkim_keys WHERE domain_id = ${domainId} AND status IN ('active','pending','rotating')
      ORDER BY (status = 'active') DESC, created_at DESC LIMIT 1`));
    return r.length ? toDkim(r[0]) : null;
  } catch (e: any) {
    console.error('[mailplatform/domains] getActiveDkim failed -', causeOf(e));
    return null;
  }
}

/** The DNS the operator must publish. Reads the domain's DKIM key so the record is the real one. */
export async function requiredRecords(orgId: UUID, domainId: UUID): Promise<DnsRecord[]> {
  const domain = await getDomain(orgId, domainId);
  if (!domain) return [];
  const dkim = await getActiveDkim(domainId);
  return requiredRecordsFor(domain, dkim);
}

export async function verificationHistory(orgId: UUID, domainId: UUID, limit = 20): Promise<DomainVerification[]> {
  try {
    const r = rows(await db.execute(sql`
      SELECT * FROM mp_domain_verifications WHERE org_id = ${orgId} AND domain_id = ${domainId}
      ORDER BY checked_at DESC LIMIT ${Math.min(limit, 100)}`));
    return r.map((row) => ({
      id: row.id,
      orgId: row.org_id,
      domainId: row.domain_id,
      checkType: row.check_type,
      status: row.status,
      expected: row.expected ?? null,
      observed: row.observed ?? null,
      detail: row.detail ?? null,
      checkedAt: iso(row.checked_at) || '',
    }));
  } catch (e: any) {
    console.error('[mailplatform/domains] verificationHistory failed -', causeOf(e));
    return [];
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Claim a domain and mint its DKIM key pair.
 *
 * The key pair is generated HERE and the private half is returned to the caller EXACTLY ONCE, with
 * instructions to place it in the MTA's secret store. It is not written to any table. That is
 * deliberately slightly inconvenient: the alternative is convenient and wrong.
 *
 * 2048-bit RSA, not 1024. Some DNS providers still struggle with the longer TXT value, which is why
 * 1024 persists in the wild — but a 1024-bit signing key is weak enough that several large
 * receivers now discount it, and "our DNS panel is awkward" is not a reason to sign with a key
 * people can factor.
 */
export async function addDomain(input: {
  orgId: UUID;
  domain: string;
  purpose?: DomainPurpose;
  actorId?: string | null;
}): Promise<{ ok: boolean; domain?: Domain; dkim?: DkimKey; privateKeyPem?: string; records?: DnsRecord[]; error?: string }> {
  const name = normalizeDomain(input.domain);
  if (!isValidDomain(name)) {
    return { ok: false, error: `"${input.domain}" is not a valid domain name. Enter it without a scheme or a path, for example: example.org` };
  }

  const token = randomBytes(16).toString('hex');
  const selector = DEFAULT_DKIM_SELECTOR;

  try {
    const existing = rows(await db.execute(sql`
      SELECT id FROM mp_domains WHERE org_id = ${input.orgId} AND lower(domain) = ${name} AND deleted_at IS NULL LIMIT 1`));
    if (existing.length) return { ok: false, error: `${name} has already been added to this organization.` };

    const r = rows(await db.execute(sql`
      INSERT INTO mp_domains (org_id, domain, purpose, verification_token, dkim_selector)
      VALUES (${input.orgId}, ${name}, ${input.purpose || 'both'}, ${token}, ${selector})
      RETURNING *`));
    const domain = toDomain(r[0]);

    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    // DNS carries the base64 body of the SPKI, without the PEM header, footer or line breaks.
    const publicKeyB64 = publicKey
      .replace(/-----BEGIN PUBLIC KEY-----/, '')
      .replace(/-----END PUBLIC KEY-----/, '')
      .replace(/\s+/g, '');

    // The reference names the environment variable the MTA reads. It is a NAME, not a value.
    const privateKeyRef = `env:DKIM_PRIVATE_KEY_${name.replace(/[^a-z0-9]/g, '_').toUpperCase()}_${selector.toUpperCase()}`;

    const k = rows(await db.execute(sql`
      INSERT INTO mp_dkim_keys (org_id, domain_id, selector, algorithm, key_size, public_key, private_key_ref, status)
      VALUES (${input.orgId}, ${domain.id}, ${selector}, 'rsa-sha256', 2048, ${publicKeyB64}, ${privateKeyRef}, 'pending')
      RETURNING *`));
    const dkim = toDkim(k[0]);

    await db.execute(sql`
      INSERT INTO mp_domain_settings (domain_id, org_id) VALUES (${domain.id}, ${input.orgId})
      ON CONFLICT (domain_id) DO NOTHING`);

    const records = requiredRecordsFor(domain, dkim);
    for (const rec of records) {
      await db.execute(sql`
        INSERT INTO mp_dns_records (org_id, domain_id, record_type, host, value, ttl, priority, purpose, is_required)
        VALUES (${input.orgId}, ${domain.id}, ${rec.recordType}, ${rec.host}, ${rec.value}, ${rec.ttl},
                ${rec.priority}, ${rec.purpose}, ${rec.isRequired})`);
    }

    await providers().events.publish({
      orgId: input.orgId,
      eventType: EVENT_TYPES.domainAdded,
      entityType: 'domain',
      entityId: domain.id,
      actorType: input.actorId ? 'user' : 'system',
      actorId: input.actorId || null,
      payload: { domain: name, purpose: domain.purpose },
      occurredAt: new Date().toISOString(),
    });

    return { ok: true, domain, dkim, privateKeyPem: privateKey, records };
  } catch (e: any) {
    return { ok: false, error: causeOf(e) };
  }
}

// ---------------------------------------------------------------------------
// Did the check RUN, or did it merely fail to answer?
// ---------------------------------------------------------------------------

/**
 * A LOOKUP THAT DID NOT RUN MUST NOT PRODUCE A VERDICT.
 *
 * verifyDomain() below used to turn every non-pass into `status = 'failed'` on mp_domains, and the
 * system DNS adapter reports a resolver that never answered — a SERVFAIL, a four-second timeout, a
 * socket error — with exactly the same `status: 'fail'` it uses for a record that is genuinely
 * absent. So a transient resolver outage told an operator their SPF or DKIM record was wrong. The
 * documented next step on that screen is to ADD a record, and a second SPF record makes receivers
 * treat the whole domain as failing SPF (RFC 7208 §3.2) — so a four-second timeout could talk an
 * operator into breaking mail delivery for the company. src/pages/api/mail/dns-check.ts carries the
 * same note and was repaired for it; this path was missed.
 *
 * The vocabulary is taken from ./domains/verify.ts — the newer engine, which already gets this
 * right — rather than invented a third time: a check that did not run is unchecked rather than
 * failed, its reasons travel back so a screen can say "could not be checked", and only a positive
 * observation produces `pass`.
 */
export type CheckOutcome = 'pass' | 'fail' | 'unchecked';

/**
 * dnsReason() in adapters/domain-dns.ts maps ENOTFOUND and ENODATA to this sentence, and that IS an
 * answer: the resolver replied and nothing is published at the name. It is tested FIRST so that
 * "you have not published the record yet" keeps saying so — the point of this change is to stop
 * inventing verdicts, not to stop reporting the real ones.
 */
const RESOLVER_ANSWERED_NOTHING_PUBLISHED = /no such record published/i;

/**
 * Every other way that adapter describes a lookup it could not complete: its "Could not read …"
 * prefix, the SERVFAIL and timeout sentences, and the bare resolver codes that reach `detail`
 * through causeOf() when the code is one dnsReason() does not name.
 *
 * The last alternative is a check we could not run for a reason on OUR side: with no
 * MAIL_SPF_INCLUDE configured the adapter has nothing to look for and says so, and that must not be
 * reported as a fault in the customer's DNS. ./domains/verify.ts calls the same situation `unknown`
 * for the same reason.
 *
 * Reading prose is not how this ought to be decided. `DomainProvider.verify()` types its status as
 * 'pass' | 'fail' with no room for a third answer, and both interfaces.ts and the adapter belong to
 * another module, so the sentence the adapter wrote is the only signal reachable from here.
 */
const RESOLVER_DID_NOT_ANSWER =
  /could not read|timed out|nameservers returned a failure|ETIMEDOUT|ETIMEOUT|ESERVFAIL|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENETUNREACH|EREFUSED|is not configured on this deployment/i;

/** How each check is named in a "could not be checked" line, matching ./domains/verify.ts. */
const CHECK_LABEL: Record<string, string> = {
  ownership: 'Ownership',
  spf: 'SPF',
  dkim: 'DKIM',
  dmarc: 'DMARC',
  mx: 'MX',
};

/**
 * Decide whether a provider result is a verdict at all.
 *
 * Anything that is not a readable pass or fail is `unchecked`, INCLUDING a missing status. That
 * direction is the safe one both ways: `unchecked` can never promote a domain to `verified`,
 * because that still requires every required check to positively pass, and it can never demote a
 * working domain because a resolver was down.
 *
 * `warn` counts as a pass, which is the mapping domains/store.ts already uses when it writes these
 * rows: the record IS published, there is simply something worth reading about it.
 */
export function classifyCheck(result: { status?: unknown; detail?: unknown; checked?: unknown }): CheckOutcome {
  // A provider that reports whether its lookup ran (./domains/verify.ts does, via `checked`) is
  // believed over anything else it says.
  if (result?.checked === false) return 'unchecked';
  const status = String(result?.status ?? '').toLowerCase();
  if (status === 'pass' || status === 'warn') return 'pass';
  if (status !== 'fail') return 'unchecked';
  const detail = String(result?.detail ?? '');
  if (RESOLVER_ANSWERED_NOTHING_PUBLISHED.test(detail)) return 'fail';
  return RESOLVER_DID_NOT_ANSWER.test(detail) ? 'unchecked' : 'fail';
}

/** The line a screen shows for a check that did not run. Never phrased as a fault in their DNS. */
export function uncheckedReason(result: { checkType?: unknown; detail?: unknown; error?: unknown }): string {
  const type = String(result?.checkType ?? '').toLowerCase();
  const label = CHECK_LABEL[type] || (type ? type.toUpperCase() : 'A check');
  const reason = String(result?.detail || result?.error || '').trim() || 'the DNS lookup did not complete';
  return `${label}: ${reason}`;
}

/**
 * Run the DNS checks and record what was seen.
 *
 * A domain becomes `verified` only when every REQUIRED check passes. DMARC is reported but never
 * required — a domain sends perfectly well without it, and blocking on DMARC is how an operator
 * ends up publishing `p=quarantine` before SPF and DKIM pass, which spam-folders their own mail.
 * That has happened on edurankai.in; it is written up in MAIL-SETUP.md.
 *
 * A domain becomes `failed` only when the run was COMPLETE and something in it actually failed. A
 * run that could not finish returns the status the domain already had, plus the reasons in
 * `unchecked`, so the caller can say "could not be checked" instead of "your DNS is wrong". See the
 * note above classifyCheck for what that distinction cost when it was missing.
 */
export async function verifyDomain(
  orgId: UUID,
  domainId: UUID,
): Promise<{ ok: boolean; status: Domain['status']; checks: DomainVerification[]; unchecked: string[]; error?: string }> {
  const domain = await getDomain(orgId, domainId);
  if (!domain) return { ok: false, status: 'failed', checks: [], unchecked: [], error: 'No such domain in this organization.' };

  try {
    const results = await providers().dns.verify(domain);
    const stored: DomainVerification[] = [];
    const unchecked: string[] = [];

    for (const result of results) {
      const outcome = classifyCheck(result);
      if (outcome === 'unchecked') unchecked.push(uncheckedReason(result));
      // mp_domain_verifications accepts pass / fail / pending, and `pending` is what that table
      // means by "we did not find out" — the same mapping domains/store.ts uses for `unknown`. A
      // lookup that never ran is therefore not written into the history as a failure of the
      // customer's DNS, which is where an operator goes looking when they want to know what changed.
      const rowStatus = outcome === 'unchecked' ? 'pending' : outcome;
      const r = rows(await db.execute(sql`
        INSERT INTO mp_domain_verifications (org_id, domain_id, check_type, status, expected, observed, detail)
        VALUES (${orgId}, ${domainId}, ${result.checkType}, ${rowStatus},
                ${result.expected}, ${result.observed}, ${result.detail})
        RETURNING *`));
      if (r.length) {
        stored.push({
          id: r[0].id,
          orgId,
          domainId,
          checkType: r[0].check_type,
          status: r[0].status,
          expected: r[0].expected ?? null,
          observed: r[0].observed ?? null,
          detail: r[0].detail ?? null,
          checkedAt: iso(r[0].checked_at) || '',
        });
      }
    }

    const requiredChecks = results.filter((r) => r.checkType !== 'dmarc' && (r.checkType !== 'mx' || domain.purpose !== 'sending'));
    const requiredOutcomes = requiredChecks.map(classifyCheck);
    // A run counts only if every required question was actually asked and answered. Zero required
    // checks is the same nothing: a provider that returned no checks told us nothing about DNS, and
    // the old code read that as `failed` too.
    const ranEverything = requiredChecks.length > 0 && !requiredOutcomes.includes('unchecked');
    const allPass = ranEverything && requiredOutcomes.every((o) => o === 'pass');
    if (requiredChecks.length === 0) {
      unchecked.push('No required check ran: the DNS provider returned nothing to judge.');
    }

    // WHAT THE STORED STATUS BECOMES.
    //
    // `verified` still requires every required check to have run AND passed — unchecked never
    // promotes. `failed` now requires the run to have been complete as well: previously one resolver
    // timeout wrote 'failed' over a domain whose DNS was perfect, and the screen then told the
    // operator to publish a record they already had.
    //
    // An incomplete run leaves the row exactly as it was and returns the reasons instead. That is
    // not an abuse hole: leaving a status alone is what happens between runs anyway, and nothing is
    // ever promoted without a positive observation.
    //
    // It follows that a definitely-failed ownership check sitting beside one timed-out lookup also
    // leaves the status alone. That could be argued the other way; the failure being fixed here is a
    // PARTIAL run producing a verdict, "we could not finish checking" is the honest description of a
    // partial run, and the next complete run demotes the domain.
    const status: Domain['status'] = allPass ? 'verified' : ranEverything ? 'failed' : domain.status;

    if (ranEverything) {
      await db.execute(sql`
        UPDATE mp_domains SET status = ${status}, verified_at = ${allPass ? sql`NOW()` : sql`verified_at`}, updated_at = NOW()
        WHERE id = ${domainId} AND org_id = ${orgId}`);
    }

    if (allPass) {
      // The DKIM key becomes active only now. Signing with a key whose public half is not published
      // produces a DKIM FAILURE on every message, which is worse than not signing at all.
      await db.execute(sql`
        UPDATE mp_dkim_keys SET status = 'active', activated_at = COALESCE(activated_at, NOW())
        WHERE domain_id = ${domainId} AND status = 'pending'`);
    }

    // NO EVENT ON AN INCOMPLETE RUN. `domain.verification_failed` is delivered to customer webhooks
    // and read by anything watching the event log, so publishing it because a resolver was down
    // repeats the same false statement somewhere it outlives the screen. EVENT_TYPES has no
    // "incomplete" name to use instead and it is not this module's to extend, so an incomplete run
    // is reported to the caller in `unchecked` and nowhere else.
    if (ranEverything) {
      await providers().events.publish({
        orgId,
        eventType: allPass ? EVENT_TYPES.domainVerified : EVENT_TYPES.domainVerificationFailed,
        entityType: 'domain',
        entityId: domainId,
        actorType: 'system',
        actorId: null,
        payload: {
          domain: domain.domain,
          // Only the checks that actually answered "no" are named. A check that did not run has no
          // business in a list a customer reads as "what is wrong with my DNS". The list still spans
          // every check, required or not, exactly as it did before.
          failing: results.filter((r) => classifyCheck(r) === 'fail').map((r) => r.checkType),
        },
        occurredAt: new Date().toISOString(),
      });
    }

    return { ok: true, status, checks: stored, unchecked };
  } catch (e: any) {
    // The run itself blew up, so there is no verdict to report. This returned 'failed', which is the
    // same conflation one level up: a database error or a provider that threw was rendered as a
    // statement about the customer's DNS. The domain keeps the status it already had.
    return {
      ok: false,
      status: domain.status,
      checks: [],
      unchecked: ['The verification run did not complete: ' + causeOf(e)],
      error: causeOf(e),
    };
  }
}

/**
 * Mint a new DKIM key alongside the current one.
 *
 * Rotation is a THREE-STEP process and this is only step one: publish the new selector, wait for
 * DNS to propagate, then activate. Retiring the old key immediately would break every message
 * already in flight that was signed with it, and every receiver that has the old record cached.
 */
export async function rotateDkim(
  orgId: UUID,
  domainId: UUID,
): Promise<{ ok: boolean; dkim?: DkimKey; privateKeyPem?: string; record?: DnsRecord; error?: string }> {
  const domain = await getDomain(orgId, domainId);
  if (!domain) return { ok: false, error: 'No such domain in this organization.' };
  try {
    // Selector carries the date, so an operator reading DNS can tell which key is which.
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const selector = `era${stamp}`;

    const clash = rows(await db.execute(sql`
      SELECT id FROM mp_dkim_keys WHERE domain_id = ${domainId} AND selector = ${selector} LIMIT 1`));
    if (clash.length) return { ok: false, error: `A key with the selector "${selector}" already exists for this domain. Rotation has already run today.` };

    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const publicKeyB64 = publicKey.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
    const privateKeyRef = `env:DKIM_PRIVATE_KEY_${domain.domain.replace(/[^a-z0-9]/g, '_').toUpperCase()}_${selector.toUpperCase()}`;

    const k = rows(await db.execute(sql`
      INSERT INTO mp_dkim_keys (org_id, domain_id, selector, algorithm, key_size, public_key, private_key_ref, status)
      VALUES (${orgId}, ${domainId}, ${selector}, 'rsa-sha256', 2048, ${publicKeyB64}, ${privateKeyRef}, 'pending')
      RETURNING *`));
    const dkim = toDkim(k[0]);

    const record: DnsRecord = {
      recordType: 'TXT',
      host: `${selector}._domainkey.${domain.domain}`,
      value: `v=DKIM1; k=rsa; p=${publicKeyB64}`,
      ttl: 3600,
      priority: null,
      purpose: 'dkim',
      isRequired: true,
    };
    await db.execute(sql`
      INSERT INTO mp_dns_records (org_id, domain_id, record_type, host, value, ttl, purpose, is_required)
      VALUES (${orgId}, ${domainId}, 'TXT', ${record.host}, ${record.value}, 3600, 'dkim', true)`);

    return { ok: true, dkim, privateKeyPem: privateKey, record };
  } catch (e: any) {
    return { ok: false, error: causeOf(e) };
  }
}

/**
 * Register an address the organization may send as.
 *
 * The domain must be VERIFIED first. Registering `noreply@somebodyelse.com` and sending from it is
 * exactly the abuse this whole subsystem exists to prevent, and a check at send time alone is too
 * late — by then the operator believes the address works.
 */
export async function addSendingIdentity(input: {
  orgId: UUID;
  fromAddress: string;
  fromName?: string | null;
  replyTo?: string | null;
  isDefault?: boolean;
}): Promise<{ ok: boolean; error?: string; identityId?: UUID }> {
  const address = String(input.fromAddress || '').trim().toLowerCase();
  const at = address.lastIndexOf('@');
  if (at < 1) return { ok: false, error: `"${input.fromAddress}" is not an email address.` };
  const domainName = address.slice(at + 1);

  try {
    const d = rows(await db.execute(sql`
      SELECT id, status FROM mp_domains WHERE org_id = ${input.orgId} AND lower(domain) = ${domainName} AND deleted_at IS NULL LIMIT 1`));
    if (!d.length) {
      return { ok: false, error: `${domainName} has not been added to this organization. Add and verify the domain before sending as an address at it.` };
    }
    if (d[0].status !== 'verified') {
      return { ok: false, error: `${domainName} is not verified yet (status: ${d[0].status}). Publish the DNS records and run verification first.` };
    }

    if (input.isDefault) {
      // Exactly one default per org — the partial unique index enforces it, so the old one is
      // cleared first rather than letting the insert fail with a constraint error.
      await db.execute(sql`
        UPDATE mp_sending_identities SET is_default = false WHERE org_id = ${input.orgId} AND is_default = true`);
    }

    const r = rows(await db.execute(sql`
      INSERT INTO mp_sending_identities (org_id, domain_id, from_address, from_name, reply_to, is_default, is_verified, verified_at)
      VALUES (${input.orgId}, ${d[0].id}, ${address}, ${input.fromName || null}, ${input.replyTo || null},
              ${!!input.isDefault}, true, NOW())
      ON CONFLICT (org_id, lower(from_address)) WHERE deleted_at IS NULL
      DO UPDATE SET from_name = EXCLUDED.from_name, reply_to = EXCLUDED.reply_to,
                    is_default = EXCLUDED.is_default, updated_at = NOW()
      RETURNING id`));
    return { ok: true, identityId: r[0]?.id };
  } catch (e: any) {
    return { ok: false, error: causeOf(e) };
  }
}

export async function listSendingIdentities(orgId: UUID) {
  try {
    const r = rows(await db.execute(sql`
      SELECT i.*, d.domain, d.status AS domain_status
      FROM mp_sending_identities i
      LEFT JOIN mp_domains d ON d.id = i.domain_id
      WHERE i.org_id = ${orgId} AND i.deleted_at IS NULL
      ORDER BY i.is_default DESC, i.from_address ASC LIMIT 200`));
    return r.map((row) => ({
      id: row.id,
      orgId: row.org_id,
      domainId: row.domain_id ?? null,
      domain: row.domain ?? null,
      domainStatus: row.domain_status ?? null,
      fromAddress: row.from_address,
      fromName: row.from_name ?? null,
      replyTo: row.reply_to ?? null,
      isDefault: !!row.is_default,
      isVerified: !!row.is_verified,
      verifiedAt: iso(row.verified_at),
    }));
  } catch (e: any) {
    console.error('[mailplatform/domains] listSendingIdentities failed -', causeOf(e));
    return [];
  }
}
