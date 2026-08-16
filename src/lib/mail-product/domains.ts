// src/lib/mail-product/domains.ts — sending domains and their four DNS records.
//
// THE CHECKER IS NOT HERE. /api/mail/dns-check.ts already resolves SPF, DKIM, DMARC and MX over
// DNS-over-HTTPS, and it is careful about something that matters enormously on this screen: it
// distinguishes "the record is absent" from "the lookup did not run". A resolver timeout rendered as
// "no SPF record found" would talk an operator into ADDING a second SPF record, and two SPF records
// make providers treat the whole domain as failing SPF — the checker's own header says so.
//
// So this module stores VERDICTS THAT CAME BACK, and has a fourth state, 'unchecked', that the UI
// must render as "could not be checked" and never as a verdict. recordCheck() below refuses to
// downgrade a previously-verified record on the strength of a lookup that did not complete.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ensureMailProductSchema } from './schema';
import { rowsOf, reasonOf, isUuid, str } from './common';

export type RecordStatus = 'verified' | 'pending' | 'failed' | 'unchecked';

export interface MailDomain {
  id: string;
  domain: string;
  status: 'verified' | 'pending' | 'failed';
  spf_status: RecordStatus;
  dkim_status: RecordStatus;
  dmarc_status: RecordStatus;
  mx_status: RecordStatus;
  dkim_selector: string | null;
  detail: Record<string, any>;
  last_checked_at: string | null;
  verified_at: string | null;
  created_at: string;
}

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
export function isDomain(v: unknown): boolean {
  return DOMAIN_RE.test(String(v ?? '').trim());
}

export async function listDomains(): Promise<MailDomain[]> {
  await ensureMailProductSchema();
  const r = await db.execute(sql`SELECT * FROM mail_domains ORDER BY created_at ASC LIMIT 100`);
  return rowsOf<MailDomain>(r);
}

export async function getDomain(id: string): Promise<MailDomain | null> {
  if (!isUuid(id)) return null;
  const r = await db.execute(sql`SELECT * FROM mail_domains WHERE id = ${id} LIMIT 1`);
  return rowsOf<MailDomain>(r)[0] || null;
}

export async function addDomain(domain: string, by: string | null): Promise<{ id: string | null; error?: string }> {
  await ensureMailProductSchema();
  const d = String(domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!isDomain(d)) return { id: null, error: `"${domain}" is not a domain name. Enter it without a scheme or path, for example example.com` };
  try {
    const r = await db.execute(sql`
      INSERT INTO mail_domains (domain, created_by) VALUES (${d}, ${isUuid(by || '') ? by : null})
      ON CONFLICT (lower(domain)) DO NOTHING RETURNING id`);
    const id = rowsOf(r)[0]?.id;
    if (!id) return { id: null, error: `${d} is already on this list.` };
    return { id };
  } catch (e: any) {
    return { id: null, error: reasonOf(e) };
  }
}

export async function removeDomain(id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const r = await db.execute(sql`DELETE FROM mail_domains WHERE id = ${id} RETURNING id`);
  return rowsOf(r).length > 0;
}

/** The shape /api/mail/dns-check returns. Only the fields this module reads are named. */
export interface DnsCheckPayload {
  ok?: boolean;
  domain?: string;
  spf?: { checked?: boolean; present?: boolean; multiple?: boolean; record?: string | null; note?: string | null };
  dkim?: { checked?: boolean; present?: boolean; selectors?: { selector: string; record: string }[] };
  dmarc?: { checked?: boolean; present?: boolean; record?: string | null; policy?: string | null };
  mx?: { priority: number; host: string }[];
  mxChecked?: boolean;
  unchecked?: string[];
}

/**
 * Turn one record's lookup into a status.
 *
 * `checked === false` becomes 'unchecked', ALWAYS. That is the whole point of this function existing
 * instead of a ternary at the call site.
 */
function verdict(checked: boolean | undefined, present: boolean | undefined, broken = false): RecordStatus {
  if (!checked) return 'unchecked';
  if (broken) return 'failed';
  return present ? 'verified' : 'pending';
}

/**
 * Store the result of a check.
 *
 * A RECORD THAT WAS NOT LOOKED AT KEEPS ITS LAST KNOWN VERDICT. Overwriting 'verified' with
 * 'unchecked' because one resolver was slow would show an operator a domain that "stopped working"
 * and send them to change DNS that was fine. The timestamp still moves, and `unchecked` is recorded
 * in `detail` so the screen can say which answers are stale.
 */
export async function recordCheck(id: string, payload: DnsCheckPayload): Promise<{ ok: boolean; error?: string }> {
  if (!isUuid(id)) return { ok: false, error: 'Unknown domain.' };
  const current = await getDomain(id);
  if (!current) return { ok: false, error: 'Unknown domain.' };

  const spf = verdict(payload.spf?.checked, payload.spf?.present, !!payload.spf?.multiple);
  const dkim = verdict(payload.dkim?.checked, payload.dkim?.present);
  const dmarc = verdict(payload.dmarc?.checked, payload.dmarc?.present);
  const mx = verdict(payload.mxChecked, (payload.mx || []).length > 0);

  const keep = (fresh: RecordStatus, was: RecordStatus): RecordStatus => (fresh === 'unchecked' ? (was || 'pending') : fresh);
  const spfF = keep(spf, current.spf_status);
  const dkimF = keep(dkim, current.dkim_status);
  const dmarcF = keep(dmarc, current.dmarc_status);
  const mxF = keep(mx, current.mx_status);

  // A domain is only 'verified' when the three AUTHENTICATION records pass. MX is about receiving,
  // not about sending, so a send-only domain with no MX is not a failure.
  const allAuth = [spfF, dkimF, dmarcF].every((s) => s === 'verified');
  const anyFail = [spfF, dkimF, dmarcF].some((s) => s === 'failed');
  const status = allAuth ? 'verified' : anyFail ? 'failed' : 'pending';

  const detail = {
    spf: payload.spf ?? null,
    dkim: payload.dkim ?? null,
    dmarc: payload.dmarc ?? null,
    mx: payload.mx ?? [],
    unchecked: payload.unchecked ?? [],
    checkedAt: new Date().toISOString(),
  };

  try {
    await db.execute(sql`
      UPDATE mail_domains SET
        spf_status = ${spfF}, dkim_status = ${dkimF}, dmarc_status = ${dmarcF}, mx_status = ${mxF},
        status = ${status},
        dkim_selector = ${payload.dkim?.selectors?.[0]?.selector || current.dkim_selector},
        detail = ${JSON.stringify(detail)}::jsonb,
        last_checked_at = now(),
        verified_at = CASE WHEN ${status} = 'verified' AND verified_at IS NULL THEN now() ELSE verified_at END
      WHERE id = ${id}`);
    return { ok: true };
  } catch (e: any) {
    console.error('[mail-product] recordCheck failed:', reasonOf(e));
    return { ok: false, error: reasonOf(e) };
  }
}

/**
 * The records an operator has to create, as text they can paste.
 *
 * DKIM IS NOT INVENTED HERE. This product does not generate or hold a signing key — outbound mail
 * relays through the configured SMTP account, and that provider signs it with its own selector (see
 * MAIL-SETUP.md). So the DKIM row says where the value comes from rather than printing a fake one.
 * A setup screen that shows a made-up DKIM record is a screen that guarantees a failed check.
 */
export function setupRecords(domain: string): { type: string; host: string; value: string; note: string; }[] {
  const d = String(domain || 'example.com').toLowerCase();
  return [
    {
      type: 'TXT', host: '@',
      value: 'v=spf1 include:YOUR-MAIL-PROVIDER ~all',
      note: 'One SPF record only. If the domain already has one, MERGE this into it — two SPF records make providers treat the domain as failing SPF. Replace YOUR-MAIL-PROVIDER with the include your mail host publishes.',
    },
    {
      type: 'CNAME or TXT', host: 'selector._domainkey.' + d,
      value: 'Provided by your mail host',
      note: 'This platform relays through your configured SMTP account, so your mail host signs the message with its own selector and publishes the matching record. Take the exact host and value from that provider — do not hand-type a key.',
    },
    {
      type: 'TXT', host: '_dmarc.' + d,
      value: 'v=DMARC1; p=none; rua=mailto:dmarc@' + d,
      note: 'Start at p=none so you can read the reports without mail being quarantined. Move to p=quarantine, then p=reject, only after SPF and DKIM both pass.',
    },
    {
      type: 'MX', host: '@',
      value: 'Provided by your mail host (priority 10)',
      note: 'Only needed if this domain RECEIVES mail. A send-only domain does not need an MX record and is not failing without one.',
    },
  ];
}

/** Wording for a status. One table so the badge, the row and the summary line agree. */
export const RECORD_WORDING: Record<RecordStatus, { label: string; tone: 'ok' | 'warn' | 'bad' | 'muted'; detail: string }> = {
  verified: { label: 'Verified', tone: 'ok', detail: 'The record was found and is valid.' },
  pending: { label: 'Pending', tone: 'warn', detail: 'The lookup ran and found no such record yet. DNS can take up to a few hours to propagate.' },
  failed: { label: 'Failed', tone: 'bad', detail: 'The record was found but is wrong — the detail below says how.' },
  unchecked: { label: 'Not checked', tone: 'muted', detail: 'The lookup did not complete, so this is the last answer we had — not a verdict on your DNS.' },
};
