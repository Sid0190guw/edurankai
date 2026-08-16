// src/lib/mailops/dns-cutover.ts — moving MX from one host to another without losing mail.
//
// NOTHING IN THIS FILE CHANGES DNS. It plans, it gates and it verifies; the edit is made by a human
// at the registrar. That is a deliberate design decision and not a missing feature:
//
//   - A wrong MX record is a total mail outage that persists for the length of its TTL, and there
//     is no rollback faster than that TTL. It is the highest-blast-radius single edit in the whole
//     system.
//   - Registrar APIs differ enough that the automation would be per-registrar, and the thing being
//     automated is a once-a-year action.
//   - An automated change made at the wrong moment is indistinguishable, from outside, from a
//     domain hijack.
//
// So: `applyRecord` exists nowhere here. What DOES exist is the arithmetic people get wrong.
//
// THE MISTAKE THIS MODULE PREVENTS. Everyone knows to lower the TTL before a cutover. What is
// routinely missed is that lowering it does nothing until the OLD TTL has expired everywhere —
// a resolver that cached the record at TTL 3600 one minute before you published TTL 300 will keep
// the old value for the next 59 minutes and will not notice the new TTL either. So the cutover
// cannot be planned from when the low TTL was published; it has to be planned from the OLD TTL
// after that, plus a margin for resolvers that round TTLs up or refresh lazily.

export interface TtlPlanInput {
  domain: string;
  /** The TTL currently published on the MX record, in seconds. */
  currentTtlSeconds: number;
  /** What to lower it to before the cutover. 300 is the usual answer. */
  targetTtlSeconds?: number;
  /** When the low TTL was (or will be) published. */
  ttlReducedAt: Date;
  /** Extra margin over the theoretical minimum. Resolvers are not all well behaved. */
  safetyMarginSeconds?: number;
}

export type CutoverStage =
  | 'reduce_ttl'
  | 'wait_old_ttl'
  | 'prepare_target'
  | 'verify_target'
  | 'cutover'
  | 'observe'
  | 'restore_ttl';

export interface CutoverStageplan {
  stage: CutoverStage;
  label: string;
  /** Earliest this stage may begin. Null when it is not time-gated. */
  notBefore: Date | null;
  detail: string;
  /** What must be true to leave this stage. Observable, not "looks fine". */
  exitCriteria: string[];
}

export interface CutoverPlan {
  domain: string;
  currentTtlSeconds: number;
  targetTtlSeconds: number;
  /** The moment the low TTL can be relied on everywhere. */
  lowTtlEffectiveAt: Date;
  /** How long a rollback takes once the cutover is made, at the reduced TTL. */
  rollbackWindowSeconds: number;
  stages: CutoverStageplan[];
  warnings: string[];
}

export function planCutover(input: TtlPlanInput): CutoverPlan {
  const targetTtl = input.targetTtlSeconds ?? 300;
  const margin = input.safetyMarginSeconds ?? 900; // 15 minutes
  const reducedAt = input.ttlReducedAt;

  // The low TTL is only universally in force once the PREVIOUS TTL has expired for every resolver
  // that cached the record just before the change, plus a margin.
  const lowTtlEffectiveAt = new Date(reducedAt.getTime() + (input.currentTtlSeconds + margin) * 1000);
  const observeUntil = new Date(lowTtlEffectiveAt.getTime() + (targetTtl + margin) * 1000);

  const warnings: string[] = [];
  if (input.currentTtlSeconds > 3600) {
    warnings.push(
      `The current MX TTL is ${input.currentTtlSeconds}s (${(input.currentTtlSeconds / 3600).toFixed(1)} hours). Every hour of it is an hour you cannot roll back in, and the wait before cutover is that long too.`,
    );
  }
  if (targetTtl < 60) {
    warnings.push('A TTL below 60s is refused or silently raised by some resolvers, and it makes your authoritative servers carry the query load. 300 is the practical floor.');
  }
  if (targetTtl >= input.currentTtlSeconds) {
    warnings.push('The target TTL is not lower than the current one, so this plan buys no faster rollback. Check the numbers.');
  }

  const stages: CutoverStageplan[] = [
    {
      stage: 'reduce_ttl',
      label: `Reduce the MX TTL to ${targetTtl}s`,
      notBefore: null,
      detail: `Edit the MX record's TTL only — leave the value alone. Do the same for any SPF (TXT) record you intend to change, since it will need the same rollback speed.`,
      exitCriteria: [
        `An authoritative query returns TTL ${targetTtl}`,
        'The record VALUE is unchanged — confirm it, because a TTL edit is exactly when a value gets fat-fingered',
      ],
    },
    {
      stage: 'wait_old_ttl',
      label: `Wait out the old TTL (${input.currentTtlSeconds}s + ${margin}s margin)`,
      notBefore: reducedAt,
      detail:
        'This is the step that is skipped. Until the previous TTL has expired everywhere, some resolvers are still holding the old record with the old TTL and your fast rollback does not exist yet.',
      exitCriteria: [
        `The wall clock is past ${lowTtlEffectiveAt.toISOString()}`,
        'Several independent resolvers all report the reduced TTL',
      ],
    },
    {
      stage: 'prepare_target',
      label: 'Prepare the new mail host',
      notBefore: null,
      detail:
        'The new host must be able to accept mail BEFORE the MX points at it. Forward and reverse DNS agreeing with its HELO name, a valid certificate, SPF already listing it, and DKIM published.',
      exitCriteria: [
        'The host accepts a test SMTP connection on port 25 from outside your own network',
        'Its A record and PTR agree with the name it announces in HELO',
        'SPF already includes it — added before the cutover, not after',
        'DKIM public key published for the selector it will sign with',
      ],
    },
    {
      stage: 'verify_target',
      label: 'Deliver test mail to the new host by IP, before any DNS change',
      notBefore: null,
      detail:
        'Send to the new host directly rather than through the MX, so the receiving path is proved while the old host is still the one in DNS. If this cannot be made to work, the cutover would have been an outage.',
      exitCriteria: [
        'A message sent directly to the new host arrives in the right mailbox',
        'The Authentication-Results header on a message SENT from the new host shows spf=pass and dkim=pass',
        'Spam scoring is running — an unscored inbound path is a working one, but it is not the one you intended',
      ],
    },
    {
      stage: 'cutover',
      label: 'Publish the new MX',
      notBefore: lowTtlEffectiveAt,
      detail:
        'Stop the old MTA accepting first, take the final mailbox delta, then publish. In that order. Publishing first means mail lands on a host that is still missing the last few messages; stopping first means senders queue for a few minutes, which is what their queues are for.',
      exitCriteria: [
        'Authoritative MX returns the new host',
        'Mail sent from three different external providers arrives',
        'The old host is still running and still holds its mailboxes — it is the rollback',
      ],
    },
    {
      stage: 'observe',
      label: 'Observe',
      notBefore: null,
      detail:
        'A quiet new host is ambiguous: it looks the same whether mail is flowing or nobody happened to write to you. Generate traffic rather than waiting for it.',
      exitCriteria: [
        'Inbound volume matches the same weekday last week, within reason',
        'No rise in deferrals or spam rejections on outbound',
        'A full business day has passed',
      ],
    },
    {
      stage: 'restore_ttl',
      label: 'Raise the TTL back',
      notBefore: observeUntil,
      detail:
        'Back to 3600 or whatever it was. A permanently low TTL means every resolver in the world queries your authoritative servers twelve times an hour for no benefit.',
      exitCriteria: ['TTL restored', 'The record value is still the new host — check both, not one'],
    },
  ];

  return {
    domain: input.domain,
    currentTtlSeconds: input.currentTtlSeconds,
    targetTtlSeconds: targetTtl,
    lowTtlEffectiveAt,
    rollbackWindowSeconds: targetTtl + margin,
    stages,
    warnings,
  };
}

/**
 * Is it safe to cut over yet.
 *
 * Every condition here has caused a real outage somewhere, and none of them is checkable by looking
 * at the registrar page — which is why they are a list rather than a habit.
 */
export interface CutoverReadiness {
  lowTtlEffectiveAt: Date;
  now?: Date;
  /** Observed TTL from an authoritative query. Null when nobody looked. */
  observedTtlSeconds: number | null;
  targetTtlSeconds: number;
  /** The new host accepted a test message delivered directly to it. */
  targetAcceptsMail: boolean;
  /** Forward and reverse DNS for the new host agree with its HELO name. */
  forwardReverseMatch: boolean;
  /** SPF already lists the new host. */
  spfIncludesTarget: boolean;
  /** DKIM public key is published for the selector the new host will sign with. */
  dkimPublished: boolean;
  /** The old host is still up and still holds the mailboxes, so a rollback is possible. */
  rollbackHostAvailable: boolean;
  /** The final mailbox delta has been taken and verified. */
  mailboxDeltaVerified: boolean;
}

export function cutoverReady(r: CutoverReadiness): { allowed: boolean; blockers: string[]; notes: string[] } {
  const now = r.now ?? new Date();
  const blockers: string[] = [];
  const notes: string[] = [];

  if (now < r.lowTtlEffectiveAt) {
    const mins = Math.ceil((r.lowTtlEffectiveAt.getTime() - now.getTime()) / 60_000);
    blockers.push(`The reduced TTL is not in force everywhere yet — ${mins} minutes to go. Cutting over now means a rollback would take the OLD TTL, not the new one.`);
  }
  if (r.observedTtlSeconds == null) {
    blockers.push('Nobody has queried the published TTL. Reducing it in the registrar UI and reducing it in DNS are different events.');
  } else if (r.observedTtlSeconds > r.targetTtlSeconds) {
    blockers.push(`Published TTL is ${r.observedTtlSeconds}s, expected ${r.targetTtlSeconds}s. The edit did not take, or it was made on a different record.`);
  }
  if (!r.targetAcceptsMail) blockers.push('The new host has not accepted a test message. Do not point MX at an unproved host.');
  if (!r.forwardReverseMatch) blockers.push('Forward and reverse DNS for the new host disagree. Large receivers refuse mail on this alone, and the symptom is "some mail bounces".');
  if (!r.spfIncludesTarget) blockers.push('SPF does not list the new host. Its first message will fail authentication, which is the worst possible first impression for a new IP.');
  if (!r.dkimPublished) blockers.push('No DKIM public key is published for the new host\'s selector.');
  if (!r.mailboxDeltaVerified) blockers.push('The final mailbox delta has not been verified. Messages that arrived during the copy would be stranded on the old host.');
  if (!r.rollbackHostAvailable) {
    blockers.push('The old host is not available as a rollback. Cutting over with no way back is not a migration, it is a bet.');
  } else {
    notes.push('Rollback is republishing the old MX. Cost is one reduced-TTL period plus whatever mail arrived on the new host in the meantime — copy it back before rolling back, or it is lost.');
  }

  return { allowed: blockers.length === 0, blockers, notes };
}

/**
 * What to check, and against which resolvers.
 *
 * Several resolvers deliberately: your own resolver is the one most likely to be holding a stale
 * or locally-overridden answer, and it is the one you will instinctively use.
 */
export const VERIFICATION_RESOLVERS = ['1.1.1.1', '8.8.8.8', '9.9.9.9'] as const;

export interface DnsExpectation {
  recordType: 'MX' | 'TXT' | 'A' | 'PTR' | 'CNAME';
  host: string;
  /** A substring that must appear in the answer. Exact matching is too brittle for TXT records. */
  mustContain: string;
  why: string;
}

export function cutoverExpectations(opts: {
  domain: string;
  newMxHost: string;
  dkimSelector: string;
  spfInclude: string;
}): DnsExpectation[] {
  return [
    { recordType: 'MX', host: opts.domain, mustContain: opts.newMxHost, why: 'Where other people\'s mail servers will deliver.' },
    { recordType: 'A', host: opts.newMxHost, mustContain: '.', why: 'The MX target must resolve to an address, and it must not be a CNAME — that is invalid for an MX target and some senders refuse it.' },
    { recordType: 'TXT', host: opts.domain, mustContain: opts.spfInclude, why: 'SPF must authorise the new sending host before it sends anything.' },
    { recordType: 'TXT', host: `${opts.dkimSelector}._domainkey.${opts.domain}`, mustContain: 'p=', why: 'The DKIM public key. A truncated or re-quoted value here is the most common registrar-induced failure.' },
    { recordType: 'TXT', host: `_dmarc.${opts.domain}`, mustContain: 'v=DMARC1', why: 'Without DMARC there are no aggregate reports, so a DKIM compromise leaves no evidence trail.' },
  ];
}

/**
 * The policy, stated where somebody adding a registrar API will read it.
 *
 * If automation is ever added it must be a separate, explicitly enabled path with a dry-run that
 * prints the diff and requires the same readiness gate above. It must never be the default, and it
 * must never run unattended.
 */
export const AUTOMATION_POLICY =
  'Production DNS is changed by a human at the registrar. This module plans, gates and verifies; it does not write records. A record change is the highest-blast-radius single edit in the system and its rollback is bounded by TTL, not by us.';
