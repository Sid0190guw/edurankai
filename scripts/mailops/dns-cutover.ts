/**
 * scripts/mailops/dns-cutover.ts — plan an MX cutover, and refuse to say "go" too early.
 *
 *   npx tsx scripts/mailops/dns-cutover.ts plan  --domain edurankai.in --current-ttl 3600
 *   npx tsx scripts/mailops/dns-cutover.ts plan  --domain edurankai.in --current-ttl 3600 --reduced-at 2026-08-16T09:00:00Z
 *   npx tsx scripts/mailops/dns-cutover.ts ready --domain edurankai.in --current-ttl 3600 --reduced-at ... \
 *        --observed-ttl 300 --target-accepts-mail --fr-match --spf-includes --dkim-published \
 *        --rollback-available --delta-verified
 *
 * IT DOES NOT CHANGE DNS AND IT NEVER WILL. This prints a schedule and evaluates a gate; a human
 * makes the edit at the registrar. A wrong MX record is a total mail outage whose rollback is
 * bounded by TTL rather than by us, and an automated change made at the wrong moment is
 * indistinguishable from outside from a domain hijack.
 *
 * THE ARITHMETIC IT EXISTS FOR. Lowering the TTL does nothing until the OLD TTL has expired
 * everywhere: a resolver that cached the record at 3600 one minute before the change keeps it for
 * another 59 minutes and never sees the new TTL either. So the cutover time is computed from the
 * old TTL after the reduction, not from the reduction.
 */
import { cutoverExpectations, cutoverReady, planCutover } from '../../src/lib/mailops/dns-cutover.js';

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

function main(): number {
  const command = process.argv[2];
  const domain = arg('domain') || process.env.MAIL_DOMAIN || '';
  const currentTtl = Number(arg('current-ttl') || 3600);
  const targetTtl = Number(arg('target-ttl') || 300);
  const reducedAtRaw = arg('reduced-at');
  const margin = Number(arg('margin-seconds') || 900);

  if (!domain || (command !== 'plan' && command !== 'ready')) {
    console.error('Usage: dns-cutover.ts <plan|ready> --domain <name> --current-ttl <seconds> [--target-ttl 300] [--reduced-at <iso>]');
    return 2;
  }
  if (!Number.isFinite(currentTtl) || currentTtl <= 0) {
    console.error('--current-ttl must be the TTL currently published on the MX record, in seconds. Query it; do not guess.');
    return 2;
  }

  const ttlReducedAt = reducedAtRaw ? new Date(reducedAtRaw) : new Date();
  if (Number.isNaN(ttlReducedAt.getTime())) {
    console.error(`--reduced-at is not a valid timestamp: ${reducedAtRaw}`);
    return 2;
  }

  const plan = planCutover({ domain, currentTtlSeconds: currentTtl, targetTtlSeconds: targetTtl, ttlReducedAt, safetyMarginSeconds: margin });

  if (command === 'plan') {
    console.log(`MX cutover plan for ${domain}`);
    console.log(`TTL ${currentTtl}s -> ${targetTtl}s, reduction published ${ttlReducedAt.toISOString()}`);
    console.log(`The reduced TTL is in force everywhere at ${plan.lowTtlEffectiveAt.toISOString()}.`);
    console.log(`Rollback after cutover costs ${Math.round(plan.rollbackWindowSeconds / 60)} minutes.`);
    console.log('');
    for (const w of plan.warnings) console.log(`WARNING: ${w}`);
    if (plan.warnings.length) console.log('');

    for (const [i, stage] of plan.stages.entries()) {
      console.log(`${i + 1}. ${stage.label}`);
      if (stage.notBefore) console.log(`   not before: ${stage.notBefore.toISOString()}`);
      console.log(`   ${stage.detail}`);
      for (const c of stage.exitCriteria) console.log(`     - ${c}`);
      console.log('');
    }

    const selector = arg('dkim-selector') || process.env.MAIL_DKIM_SELECTOR || 'era1';
    const newMx = arg('new-mx') || 'mail.<new-host>';
    const spfInclude = arg('spf-include') || 'a:mail.<new-host>';
    console.log('Records to verify before and after (npx tsx scripts/mailops/dns-verify.ts checks these):');
    for (const e of cutoverExpectations({ domain, newMxHost: newMx, dkimSelector: selector, spfInclude })) {
      console.log(`  ${e.recordType.padEnd(5)} ${e.host}`);
      console.log(`        must contain: ${e.mustContain}`);
      console.log(`        ${e.why}`);
    }
    return 0;
  }

  // command === 'ready'
  const observedRaw = arg('observed-ttl');
  const readiness = cutoverReady({
    lowTtlEffectiveAt: plan.lowTtlEffectiveAt,
    now: new Date(),
    observedTtlSeconds: observedRaw == null ? null : Number(observedRaw),
    targetTtlSeconds: targetTtl,
    targetAcceptsMail: flag('target-accepts-mail'),
    forwardReverseMatch: flag('fr-match'),
    spfIncludesTarget: flag('spf-includes'),
    dkimPublished: flag('dkim-published'),
    rollbackHostAvailable: flag('rollback-available'),
    mailboxDeltaVerified: flag('delta-verified'),
  });

  console.log(readiness.allowed ? `CUTOVER ALLOWED for ${domain}.` : `CUTOVER BLOCKED for ${domain}.`);
  for (const b of readiness.blockers) console.log(`  - ${b}`);
  for (const n of readiness.notes) console.log(`  note: ${n}`);
  if (readiness.allowed) {
    console.log('');
    console.log('Order at the moment of cutover, and it is not interchangeable:');
    console.log('  1. Stop the OLD MTA accepting.');
    console.log('  2. Take the final mailbox delta and verify it.');
    console.log('  3. Publish the new MX.');
    console.log('Publishing first lands mail on a host that is still missing the last few messages.');
  }
  return readiness.allowed ? 0 : 1;
}

process.exit(main());
