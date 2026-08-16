// src/lib/mailplatform/domains/service.ts — ONE PLACE THAT ASSEMBLES A DOMAIN'S WHOLE PICTURE.
//
// The API routes and the admin pages both need the same thing: the domain, the records it must
// publish, what DNS actually says, what to change, and which step of setup it is on. Building that
// twice guarantees the wizard and the API eventually disagree about whether a domain is ready —
// so it is built once, here, and both surfaces render the same object.
//
// This is also the only module that decides a domain's SETUP STEP, and the step is derived from
// observations rather than stored. A stored step is a lie waiting to happen: somebody deletes an
// SPF record months later and the wizard still says "step 6, activate".

import { getProfile, profileCapabilities, type MtaProfile } from '../profile';
import { dohResolver, type DnsResolver } from './dns';
import { verifyDomain, healthSummary, nextDmarcStep, type DomainHealth } from './verify';
import { recommendSpf, type SpfRecommendation } from './spf';
import { recommendDmarc, parseDmarc, selectDmarcRecords, type DmarcPolicy, type DmarcRecommendation } from './dmarc';
import { requiredRecords, ptrExpectations, groupRecords, type ManagedDnsRecord } from './records';
import {
  getDomain, listDkimKeys, listIdentities, getDomainSettings, recordHealth, applyHealthToStatus,
  type Ctx, type DomainRow, type DkimKeyRow, type IdentityRow, type DomainSettingsRow,
} from './store';

export type WizardStep = 1 | 2 | 3 | 4 | 5 | 6;

export const WIZARD_STEPS: { step: WizardStep; title: string; blurb: string }[] = [
  { step: 1, title: 'Add your domain', blurb: 'Tell us the domain you send mail from.' },
  { step: 2, title: 'Prove you own it', blurb: 'Add one TXT record. Nothing about your existing mail changes.' },
  { step: 3, title: 'Set up sending', blurb: 'Two records that let receivers confirm mail from you is really from you.' },
  { step: 4, title: 'Set up receiving', blurb: 'Optional. Only do this when you are ready for mail to arrive here instead of where it goes now.' },
  { step: 5, title: 'Check everything', blurb: 'We look up what your DNS actually returns and tell you what is missing.' },
  { step: 6, title: 'Turn it on', blurb: 'Start sending from this domain.' },
];

export interface DomainView {
  domain: DomainRow;
  profile: MtaProfile;
  capabilities: ReturnType<typeof profileCapabilities>;
  settings: DomainSettingsRow | null;
  dkimKeys: DkimKeyRow[];
  identities: IdentityRow[];
  records: ManagedDnsRecord[];
  grouped: ReturnType<typeof groupRecords>;
  ptr: ReturnType<typeof ptrExpectations>;
  health: DomainHealth | null;
  summary: ReturnType<typeof healthSummary> | null;
  spf: SpfRecommendation | null;
  dmarc: DmarcRecommendation | null;
  /** The published policy, when one is published. Drives the change guard on the UI. */
  publishedDmarcPolicy: DmarcPolicy | null;
  dmarcNext: ReturnType<typeof nextDmarcStep>;
  step: WizardStep;
  /** Sentence for the current step. */
  stepReason: string;
}

/**
 * Which step is this domain on?
 *
 * Derived from what the last check saw, never stored. Note that step 4 (receiving) is SKIPPED for a
 * send-only domain rather than left permanently incomplete — a wizard that can never finish is one
 * people learn to ignore.
 */
export function wizardStep(domain: DomainRow, health: DomainHealth | null): { step: WizardStep; reason: string } {
  if (!health) return { step: 2, reason: 'Publish the ownership record, then run the first check.' };
  if (!health.ownershipVerified) {
    const own = health.checks.find((c) => c.type === 'ownership');
    if (own && !own.checked) return { step: 2, reason: 'The ownership record could not be checked. This is about the lookup, not about your DNS — try again in a moment.' };
    return { step: 2, reason: 'The ownership record is not visible yet. DNS changes can take up to an hour.' };
  }
  const wantsSending = domain.purpose !== 'receiving';
  const wantsReceiving = domain.purpose !== 'sending';

  if (wantsSending && !health.sendingReady) {
    return { step: 3, reason: 'Ownership is confirmed. SPF and DKIM still need to be published before this domain can send.' };
  }
  if (wantsReceiving && !health.receivingReady) {
    return { step: 4, reason: 'Sending is ready. Add the MX record when you want mail for this domain to arrive here.' };
  }
  if (health.checks.some((c) => c.status === 'fail')) {
    return { step: 5, reason: 'Everything essential is in place, and some checks are still failing. Fix those before turning sending on.' };
  }
  if (!domain.sendingEnabled && wantsSending) {
    return { step: 6, reason: 'All checks pass. Turn sending on when you are ready.' };
  }
  return { step: 6, reason: 'This domain is set up and active.' };
}

/**
 * Assemble the whole view.
 *
 * `refresh: false` (the default) uses the last stored health run, which is what a page load wants —
 * a screen must not make six DNS lookups every time somebody clicks back to it. `refresh: true` is
 * the explicit "check now" action.
 */
export async function domainView(
  ctx: Ctx,
  domainId: string,
  opts: { refresh?: boolean; resolver?: DnsResolver } = {},
): Promise<DomainView | null> {
  const domain = await getDomain(ctx.principal.orgId, domainId);
  if (!domain) return null;

  const profile = getProfile();
  const capabilities = profileCapabilities(profile);
  const [dkimKeys, identities, settings] = await Promise.all([
    listDkimKeys(ctx.principal.orgId, domainId),
    listIdentities(ctx.principal.orgId),
    getDomainSettings(ctx.principal.orgId, domainId),
  ]);

  let health: DomainHealth | null;
  if (opts.refresh) {
    health = await runVerification(ctx, domain, dkimKeys, { resolver: opts.resolver, profile });
  } else {
    const { latestHealth } = await import('./store');
    health = await latestHealth(ctx.principal.orgId, domainId);
  }

  // What is published, taken from the run rather than looked up again.
  const spfPublished = health?.checks.find((c) => c.type === 'spf' && c.ref === null)?.raw ?? null;
  const dmarcPublished = health?.checks.find((c) => c.type === 'dmarc')?.raw ?? null;
  const publishedDmarc = dmarcPublished ? selectDmarcRecords(dmarcPublished) : [];
  const publishedDmarcPolicy = publishedDmarc.length === 1 ? parseDmarc(publishedDmarc[0]).policy : null;

  const spf = recommendSpf(spfPublished, { includes: profile.spfIncludes, ip4: profile.spfIp4, ip6: profile.spfIp6 });
  // The DESIRED policy is whatever the operator has recorded as their intention, and `none` when
  // they have recorded nothing. It is never silently raised to match what is already published.
  const desired: DmarcPolicy = (settings?.dmarcPolicy as DmarcPolicy) || publishedDmarcPolicy || 'none';
  const dmarc = recommendDmarc(dmarcPublished, { rua: profile.dmarcRua, desired });

  const records = requiredRecords({
    domain: domain.domain,
    profile,
    verificationToken: domain.verificationToken,
    purpose: domain.purpose,
    dkim: dkimKeys
      .filter((k) => k.status !== 'retired')
      .map((k) => ({ selector: k.selector, publicKey: k.publicKey, algorithm: k.algorithm, status: k.status })),
    spfValue: spf.action === 'manual' ? null : spf.record,
    dmarcValue: dmarc.record,
    trackingHost: settings?.trackingDomain || null,
  });

  const { step, reason } = wizardStep(domain, health);
  return {
    domain,
    profile,
    capabilities,
    settings,
    dkimKeys,
    identities: identities.filter((i) => i.domainId === domain.id),
    records,
    grouped: groupRecords(records),
    ptr: ptrExpectations(profile),
    health,
    summary: health ? healthSummary(health) : null,
    spf,
    dmarc,
    publishedDmarcPolicy,
    dmarcNext: nextDmarcStep(publishedDmarcPolicy, health?.sendingReady === true),
    step,
    stepReason: reason,
  };
}

/**
 * Run the checks and persist what they found.
 *
 * The order is deliberate: RECORD first, then APPLY to status. If the status update fails, the
 * evidence of what was seen is already stored and the next run reconciles; if it were the other way
 * round, a domain could be marked failed with no record of why.
 */
export async function runVerification(
  ctx: Ctx,
  domain: DomainRow,
  dkimKeys?: DkimKeyRow[],
  opts: { resolver?: DnsResolver; profile?: MtaProfile } = {},
): Promise<DomainHealth> {
  const profile = opts.profile || getProfile();
  const keys = dkimKeys || (await listDkimKeys(ctx.principal.orgId, domain.id));
  const health = await verifyDomain({
    domain: domain.domain,
    verificationToken: domain.verificationToken,
    profile,
    purpose: domain.purpose,
    resolver: opts.resolver || dohResolver(),
    dkim: keys.map((k) => ({ selector: k.selector, publicKey: k.publicKey, algorithm: k.algorithm, status: k.status })),
  });
  await recordHealth(ctx, domain.id, health);
  await applyHealthToStatus(ctx, domain.id, health);
  return health;
}

/** A compact per-domain row for the list screen, with one check run each. Reads stored health. */
export async function domainListView(ctx: Ctx, domains: DomainRow[]): Promise<
  { domain: DomainRow; summary: ReturnType<typeof healthSummary> | null; step: WizardStep }[]
> {
  const { latestHealth } = await import('./store');
  const out: { domain: DomainRow; summary: ReturnType<typeof healthSummary> | null; step: WizardStep }[] = [];
  for (const d of domains) {
    const health = await latestHealth(ctx.principal.orgId, d.id);
    out.push({ domain: d, summary: health ? healthSummary(health) : null, step: wizardStep(d, health).step });
  }
  return out;
}
