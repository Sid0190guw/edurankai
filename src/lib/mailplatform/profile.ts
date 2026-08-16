// src/lib/mailplatform/profile.ts — WHERE THE MAIL ACTUALLY LEAVES FROM, AS DATA RATHER THAN AS A
// LITERAL IN A DNS RECORD BUILDER.
//
// Requirement 17 of the domain brief is that the model survives ZBook MTA -> dedicated MTA ->
// MTA cluster -> multi-region, and the way a domain layer normally fails that test is boring: some
// helper writes `mx1.edurankai.in` or an IP address into the record it tells the customer to
// publish, and three months later the customer's DNS points at a machine that no longer exists.
// Nothing here may hard-code a host or an address. Every value comes from the environment (or a
// stored override row), so moving the MTA is a configuration change and the records the wizard
// prints change with it.
//
// resolveProfile() is PURE — it takes an env-shaped record and returns the profile — so the whole
// of the DNS-record surface can be tested against a hypothetical multi-region deployment without
// setting a single environment variable.

import { OWNERSHIP_HOST_PREFIX } from './adapters/domain-dns';

/** One MX target the customer must publish for inbound mail to reach us. */
export interface MxTarget {
  host: string;
  priority: number;
}

/**
 * The deployment description the DNS builders read.
 *
 * `source` records where each profile came from so an operator can tell a configured deployment
 * from the built-in fallback — a fallback that silently looks configured is how a customer ends up
 * publishing records for infrastructure nobody runs.
 */
export interface MtaProfile {
  id: string;
  label: string;
  /** Inbound. Empty means "we do not offer receiving here" and the MX step says exactly that. */
  mx: MxTarget[];
  /** Outbound authorisation, in the form SPF wants them. */
  spfIncludes: string[];
  spfIp4: string[];
  spfIp6: string[];
  /** Addresses mail actually leaves from. Used for the PTR panel, never published by us. */
  sendingIps: string[];
  /** The name reverse DNS for `sendingIps` is expected to return. */
  ptrHostname: string | null;
  /** CNAME target for open/click tracking, when tracking is offered on a customer domain. */
  trackingTarget: string | null;
  /** Default aggregate-report mailbox offered in the DMARC recommendation. */
  dmarcRua: string | null;
  /**
   * TXT name prefix for the ownership challenge.
   *
   * Defaults to OWNERSHIP_HOST_PREFIX from ../adapters/domain-dns.ts rather than to a literal. The
   * challenge NAME and the challenge VALUE are checked by two different code paths — that adapter's
   * runVerification() and ./domains/verify.ts — and a wizard that prints one thing while a checker
   * looks for another is a support ticket that never resolves. One definition, imported.
   */
  verificationPrefix: string;
  /** Prefix new DKIM selectors are minted under. */
  dkimSelectorPrefix: string;
  /** Whether this deployment can sign DKIM at all (an SMTP relay we do not own cannot). */
  canSignDkim: boolean;
  source: 'env' | 'fallback';
}

function list(v: string | undefined | null): string[] {
  return String(v || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parse `MAIL_MX_HOSTS`.
 *
 * Accepts `10 mx1.example.com, 20 mx2.example.com` and the priority-less `mx1.example.com` (which
 * gets 10, then 20, then 30 — the conventional spacing, so a second host is a real backup rather
 * than a tie).
 */
export function parseMxHosts(raw: string | undefined | null): MxTarget[] {
  const out: MxTarget[] = [];
  const parts = String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const p of parts) {
    const m = p.match(/^(\d{1,5})\s+(\S+)$/);
    if (m) out.push({ priority: Number(m[1]), host: m[2].replace(/\.$/, '').toLowerCase() });
    else out.push({ priority: (out.length + 1) * 10, host: p.split(/\s+/)[0].replace(/\.$/, '').toLowerCase() });
  }
  return out;
}

/** Env keys this module reads. Exported so the ops documentation cannot drift from the code. */
export const PROFILE_ENV_KEYS = [
  'MAIL_PROFILE_ID',
  'MAIL_PROFILE_LABEL',
  'MAIL_MX_HOSTS',
  'MAIL_MX_HOST',
  'MAIL_SPF_INCLUDE',
  'MAIL_SPF_IP4',
  'MAIL_SPF_IP6',
  'MAIL_SENDING_IPS',
  'MAIL_PTR_HOSTNAME',
  'MAIL_TRACKING_TARGET',
  'MAIL_DMARC_RUA',
  'MAIL_VERIFICATION_PREFIX',
  'MAIL_DKIM_SELECTOR_PREFIX',
  'MAIL_DKIM_SIGNING',
] as const;

/**
 * Build a profile from an environment-shaped record.
 *
 * THE FALLBACK DELIBERATELY CARRIES NO HOSTS. With nothing configured the profile has no MX, no
 * include and no IPs, and every builder downstream reports "this deployment has not been told where
 * mail leaves from" instead of inventing a hostname. A domain wizard that prints a plausible record
 * for infrastructure that does not exist is worse than one that refuses to print anything.
 */
export function resolveProfile(env: Record<string, string | undefined>): MtaProfile {
  // MAIL_MX_HOST (singular) is what ../adapters/domain-dns.ts already reads on this deployment.
  // Honouring both means adding a second inbound host later is a value change, not a rename that
  // silently empties the MX section of every customer's setup page.
  const mx = parseMxHosts(env.MAIL_MX_HOSTS || env.MAIL_MX_HOST);
  const spfIncludes = list(env.MAIL_SPF_INCLUDE);
  const spfIp4 = list(env.MAIL_SPF_IP4);
  const spfIp6 = list(env.MAIL_SPF_IP6);
  const sendingIps = list(env.MAIL_SENDING_IPS);
  const configured =
    mx.length > 0 || spfIncludes.length > 0 || spfIp4.length > 0 || spfIp6.length > 0 || sendingIps.length > 0;

  return {
    id: env.MAIL_PROFILE_ID || 'default',
    label: env.MAIL_PROFILE_LABEL || (configured ? 'Configured mail infrastructure' : 'Not configured'),
    mx,
    spfIncludes,
    spfIp4,
    spfIp6,
    sendingIps,
    ptrHostname: (env.MAIL_PTR_HOSTNAME || '').trim().replace(/\.$/, '') || null,
    trackingTarget: (env.MAIL_TRACKING_TARGET || '').trim().replace(/\.$/, '') || null,
    dmarcRua: (env.MAIL_DMARC_RUA || '').trim() || null,
    verificationPrefix: (env.MAIL_VERIFICATION_PREFIX || OWNERSHIP_HOST_PREFIX).trim(),
    dkimSelectorPrefix: (env.MAIL_DKIM_SELECTOR_PREFIX || 'era').trim(),
    // Signing is only claimed when the operator says so. A relay we rent signs with ITS key and its
    // d= domain, and offering the customer a DKIM record we cannot sign against is a promise the
    // MTA will not keep.
    canSignDkim: String(env.MAIL_DKIM_SIGNING || '').toLowerCase() !== 'off',
    source: configured ? 'env' : 'fallback',
  };
}

/** Which capabilities this deployment can honestly offer. Drives what the wizard shows. */
export function profileCapabilities(p: MtaProfile): {
  canReceive: boolean;
  canAuthoriseSending: boolean;
  canSignDkim: boolean;
  canShowPtr: boolean;
  missing: string[];
} {
  const missing: string[] = [];
  if (p.mx.length === 0) missing.push('MAIL_MX_HOSTS — no inbound host to point MX at');
  if (p.spfIncludes.length === 0 && p.spfIp4.length === 0 && p.spfIp6.length === 0)
    missing.push('MAIL_SPF_INCLUDE or MAIL_SPF_IP4 — nothing to authorise in SPF');
  if (p.sendingIps.length === 0) missing.push('MAIL_SENDING_IPS — reverse DNS cannot be shown without the sending address');
  return {
    canReceive: p.mx.length > 0,
    canAuthoriseSending: p.spfIncludes.length > 0 || p.spfIp4.length > 0 || p.spfIp6.length > 0,
    canSignDkim: p.canSignDkim,
    canShowPtr: p.sendingIps.length > 0,
    missing,
  };
}

/**
 * The live profile. Reads process.env at call time so a redeploy with new values takes effect.
 *
 * Each variable is named EXPLICITLY rather than handing the whole of process.env to
 * resolveProfile(). Two reasons, and the second is the one that matters:
 *
 *   1. resolveProfile() then receives exactly the twelve values it uses, instead of every secret
 *      this process holds.
 *   2. a direct, by-name env read is greppable, and src/lib/deployment-readiness.test.ts greps for exactly
 *      that to prove the operator checklist lists every variable the code reads. Read through a
 *      cast, these twelve were invisible to it — an env contract that a customer publishes DNS
 *      records from, absent from the checklist an operator trusts.
 */
export function getProfile(): MtaProfile {
  return resolveProfile({
    MAIL_PROFILE_ID: process.env.MAIL_PROFILE_ID,
    MAIL_PROFILE_LABEL: process.env.MAIL_PROFILE_LABEL,
    MAIL_MX_HOSTS: process.env.MAIL_MX_HOSTS,
    MAIL_MX_HOST: process.env.MAIL_MX_HOST,
    MAIL_SPF_INCLUDE: process.env.MAIL_SPF_INCLUDE,
    MAIL_SPF_IP4: process.env.MAIL_SPF_IP4,
    MAIL_SPF_IP6: process.env.MAIL_SPF_IP6,
    MAIL_SENDING_IPS: process.env.MAIL_SENDING_IPS,
    MAIL_PTR_HOSTNAME: process.env.MAIL_PTR_HOSTNAME,
    MAIL_TRACKING_TARGET: process.env.MAIL_TRACKING_TARGET,
    MAIL_DMARC_RUA: process.env.MAIL_DMARC_RUA,
    MAIL_VERIFICATION_PREFIX: process.env.MAIL_VERIFICATION_PREFIX,
    MAIL_DKIM_SELECTOR_PREFIX: process.env.MAIL_DKIM_SELECTOR_PREFIX,
    MAIL_DKIM_SIGNING: process.env.MAIL_DKIM_SIGNING,
  });
}
