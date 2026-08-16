// src/lib/mailops/migration.ts — moving this system somewhere else without losing anything, and
// knowing the difference between "the copy finished" and "the copy is correct".
//
// SIX MIGRATIONS ARE IN SCOPE, and they are deliberately modelled as the same shape, because they
// have the same failure: somebody runs the copy, sees no errors, cuts over, and discovers three
// days later that a table, a folder or a flag did not come across. Every migration here therefore
// ends in a VERIFICATION gate that compares inventories, and a CUTOVER that is refused unless the
// gate passed.
//
// THE RULE THE BRIEF STATES AND THIS MODULE ENFORCES:
//
//     DO NOT DESTROY THE ORIGINAL UNTIL VERIFICATION SUCCEEDS.
//
// decommissionAllowed() is the only function here that returns permission to delete anything, and
// it requires a passed verification AND a soak period AND an explicit human confirmation. It is
// easier to keep an old database running for a month than to explain why a mailbox is empty.
//
// WHAT THIS MODULE DOES NOT DO. It does not connect to anything, run a copy, or read a row. It
// holds the plans, the gates and the comparison arithmetic. The copying is done by scripts the
// founder runs (scripts/mailops/), and those scripts produce the inventories this module compares.

export type MigrationId =
  | 'zbook-to-dedicated'
  | 'single-to-multi-node'
  | 'supabase-to-selfhosted-pg'
  | 'supabase-storage-to-s3'
  | 'local-mta-to-dedicated'
  | 'single-mta-to-cluster';

export type StepKind = 'prepare' | 'copy' | 'sync' | 'verify' | 'cutover' | 'observe' | 'rollback' | 'decommission';

export interface MigrationStep {
  kind: StepKind;
  title: string;
  detail: string;
  /** The command or tool, where one exists. Never one that opens the production database. */
  command?: string;
  /** True when this step cannot be undone once taken. */
  irreversible?: boolean;
  /** True when this step needs the founder, not an operator. */
  decision?: boolean;
}

export interface MigrationPlan {
  id: MigrationId;
  title: string;
  /** What is actually moving, in one sentence. */
  moving: string;
  /** Why it is worth doing. If this is thin, the migration is premature. */
  because: string;
  /** The single thing most likely to go wrong. */
  principalRisk: string;
  /** Can the source keep serving while the copy runs. */
  onlineCopy: boolean;
  /** Entity counts that must match before cutover is allowed. */
  gateEntities: EntityKind[];
  /** How long to keep the source alive and reachable after cutover. */
  soakDays: number;
  steps: MigrationStep[];
}

export type EntityKind =
  | 'messages'
  | 'mailboxes'
  | 'folders'
  | 'flags'
  | 'attachments'
  | 'contacts'
  | 'campaigns'
  | 'templates'
  | 'domains'
  | 'delivery_events'
  | 'automations'
  | 'objects'
  | 'bytes';

export const ENTITY_LABELS: Record<EntityKind, string> = {
  messages: 'Messages',
  mailboxes: 'Mailboxes',
  folders: 'Folders',
  flags: 'Read / starred / label flags',
  attachments: 'Attachments',
  contacts: 'Contacts',
  campaigns: 'Campaigns',
  templates: 'Templates',
  domains: 'Domains',
  delivery_events: 'Delivery events',
  automations: 'Automations',
  objects: 'Stored objects',
  bytes: 'Total bytes',
};

export const MIGRATION_PLANS: readonly MigrationPlan[] = [
  {
    id: 'zbook-to-dedicated',
    title: 'ZBook to a dedicated mail server',
    moving: 'The whole mail stack — MTA, IMAP, spam scoring, the delivery worker, the spool and the maildirs — off the laptop and onto an always-on host.',
    because:
      'The laptop being closed is a total inbound outage, and it is the largest single availability risk in the system. Nothing else on this list changes that; this is the migration that matters.',
    principalRisk:
      'Mail arriving during the cutover window. The MX points at one host at a time, and the gap between "old host stops accepting" and "new host starts accepting" is mail held on senders\' queues — safe if it is minutes, a growing risk if it is hours.',
    onlineCopy: true,
    gateEntities: ['messages', 'mailboxes', 'folders', 'flags', 'attachments'],
    soakDays: 14,
    steps: [
      { kind: 'prepare', title: 'Stand the new host up in parallel', detail: 'Same stack, same versions, its own DKIM keys generated but NOT yet published. It receives nothing until the MX moves.' },
      { kind: 'prepare', title: 'Forward and reverse DNS for the new host', detail: 'The A record and the PTR must agree with the name the MTA announces in HELO. Large receivers refuse mail where they do not.' },
      { kind: 'prepare', title: 'Reduce the MX TTL', detail: 'To 300 seconds, at least one old-TTL period before cutover. See ./dns-cutover.ts — the reduction has to be published and propagated before it is useful.', command: 'npx tsx scripts/mailops/dns-cutover.ts plan --domain edurankai.in --current-ttl 3600' },
      { kind: 'copy', title: 'Copy the maildir tree', detail: 'A first bulk copy while the old host is still serving. It will be stale by the time it finishes, and that is expected.', command: 'bash scripts/mailops/mailbox-migrate.sh --mode bulk' },
      { kind: 'sync', title: 'Incremental re-sync', detail: 'Repeat the copy until the delta is small enough that the final pass takes under a minute. This is what keeps the cutover window short.', command: 'bash scripts/mailops/mailbox-migrate.sh --mode delta' },
      { kind: 'verify', title: 'Compare inventories', detail: 'Message, folder and flag counts per mailbox. A folder that did not come across is invisible until somebody looks for a message in it.', command: 'npx tsx scripts/mailops/migration-report.ts --source inv-old.json --target inv-new.json' },
      { kind: 'cutover', title: 'Stop the old MTA, final delta, publish the new MX', detail: 'In that order. Stopping first means the final delta is complete; publishing first means mail arrives on a host that is still missing the last few messages.', irreversible: false, decision: true },
      { kind: 'observe', title: 'Watch inbound for one full business day', detail: 'Confirm mail is arriving, spam scoring is running, and the spool is draining. A quiet new host is ambiguous — send yourself mail from three external providers.' },
      { kind: 'rollback', title: 'Republish the old MX', detail: 'Possible for as long as the old host is still running and still has its maildirs. Cost is one TTL. This is why soakDays is not zero.' },
      { kind: 'decommission', title: 'Retire the old host', detail: 'Only after the soak, only after verification passed, and only with an explicit decision.', irreversible: true, decision: true },
    ],
  },
  {
    id: 'single-to-multi-node',
    title: 'One mail node to several',
    moving: 'From a single host doing everything to N nodes behind a load balancer, sharing a queue.',
    because: 'Capacity and the ability to lose a node without an outage. Not worth doing before the dedicated-host migration, and not worth doing at all until volume justifies it.',
    principalRisk:
      'Two workers delivering the same message. The spool already prevents this — a claim is an atomic rename, so exactly one worker wins — but any node that keeps state on its own local disk breaks that guarantee, and the failure shows up as duplicate mail to real people.',
    onlineCopy: true,
    gateEntities: ['messages', 'delivery_events'],
    soakDays: 7,
    steps: [
      { kind: 'prepare', title: 'Move the spool onto shared storage', detail: 'Every node must see the same spool directory with working atomic rename semantics. NFS with the wrong options does not give you that, and the symptom is duplicate delivery.' },
      { kind: 'prepare', title: 'Give each node a distinct worker id', detail: 'Lease records name their owner. Two nodes claiming the same id makes reclaim() unable to tell an abandoned lease from a live one.' },
      { kind: 'copy', title: 'Add the second node with delivery disabled', detail: 'It runs the whole pipeline and stops before opening a socket. This exercises claiming and leasing under real load with no risk of sending anything twice.' },
      { kind: 'verify', title: 'Confirm no double-claims', detail: 'Every entry should show exactly one lease owner over the observation window. Any entry claimed twice concurrently means the shared filesystem does not have atomic rename.' },
      { kind: 'cutover', title: 'Enable delivery on the second node', detail: 'Then add the load balancer in front of inbound.', decision: true },
      { kind: 'observe', title: 'Watch for duplicates for a week', detail: 'Duplicate delivery is the failure mode here and it is only visible from the recipient side.' },
      { kind: 'rollback', title: 'Disable delivery on the new node', detail: 'Instant and safe. The spool is shared, so nothing is stranded.' },
      { kind: 'decommission', title: 'Nothing to decommission', detail: 'This migration adds capacity rather than replacing anything.' },
    ],
  },
  {
    id: 'supabase-to-selfhosted-pg',
    title: 'Supabase to self-hosted PostgreSQL',
    moving: 'The entire database — 258 tables — from managed Postgres to an instance we run.',
    because:
      'Sovereignty, and removing a provider from the critical path. Also cost at volume. Against it: managed Postgres includes backups, patching and failover that we would then owe ourselves.',
    principalRisk:
      'The schema is not in this repository. There is no migration history and DDL self-bootstraps across application modules, so only a dump reconstructs the live schema. A hand-built target schema WILL be subtly wrong.',
    onlineCopy: true,
    gateEntities: ['messages', 'mailboxes', 'contacts', 'campaigns', 'templates', 'domains', 'delivery_events', 'automations'],
    soakDays: 30,
    steps: [
      { kind: 'prepare', title: 'Match the server major version', detail: 'The dump client must be at least the server version, and the target should be the same major. Check the source version first rather than assuming.' },
      { kind: 'prepare', title: 'Confirm which connection string', detail: 'Dumps go over the DIRECT session connection on 5432, never the transaction pooler on 6543. The pooler does not hold a session, and the failure mode is a dump that completes and is subtly inconsistent.' },
      { kind: 'copy', title: 'Schema first, then data', detail: 'Two passes make a schema problem visible before you have waited out a full data copy.', command: 'bash scripts/mailops/db-migrate.sh --stage schema' },
      { kind: 'sync', title: 'Logical replication for the delta, where feasible', detail: 'Feasible only if the source allows a replication slot; a managed free tier usually does not. If it does not, the honest plan is a maintenance window sized by the dump-and-restore time — measure it on a scratch restore first rather than guessing.' },
      { kind: 'verify', title: 'Row counts per table, plus spot-check content', detail: 'Counts alone miss a column that arrived empty. Compare a sample of rows on the widest tables too.', command: 'npx tsx scripts/mailops/migration-report.ts --source inv-src.json --target inv-dst.json' },
      { kind: 'verify', title: 'Confirm encrypted columns still decrypt', detail: 'Using the escrowed key. A restore that carries the ciphertext but not the key is a database of unreadable columns, and it looks fine until somebody opens one.' },
      { kind: 'cutover', title: 'Freeze writes, final sync, repoint DATABASE_URL, redeploy', detail: 'The freeze is what makes the final sync complete. Without it the last few seconds of writes are lost silently.', decision: true },
      { kind: 'observe', title: 'Keep the source running and READABLE for the soak', detail: 'Not writable. A readable source is how a missing row gets recovered; a deleted one is how it does not.' },
      { kind: 'rollback', title: 'Repoint DATABASE_URL back', detail: 'Only valid while the source is still current — that is, before any writes have landed on the new database. After the first write, rollback means losing those writes, so this window is short and should be stated in minutes.', decision: true },
      { kind: 'decommission', title: 'Delete the Supabase project', detail: 'After the soak. Take a final dump first and keep it under the normal retention policy.', irreversible: true, decision: true },
    ],
  },
  {
    id: 'supabase-storage-to-s3',
    title: 'Object storage to S3-compatible storage',
    moving: 'Attachments and archived raw MIME to an S3-compatible bucket we control.',
    because:
      'The sovereignty rule prefers S3-compatible over a proprietary blob store, and it is a small migration: the storage layer already speaks S3 with SigV4 and no vendor SDK, so this is configuration plus a copy rather than code.',
    principalRisk:
      'Keys. Objects are referenced by key from database rows; if the copy changes the key shape, every existing reference breaks and the breakage is invisible until somebody opens an old message.',
    onlineCopy: true,
    gateEntities: ['objects', 'bytes'],
    soakDays: 30,
    steps: [
      { kind: 'prepare', title: 'Create the bucket with versioning ON', detail: 'Versioning is the single cheapest protection available here, and it is far easier to enable at creation than to add later.' },
      { kind: 'copy', title: 'Copy every object, preserving the key exactly', detail: 'Same key, same content type. Do not "tidy" the prefix structure during a migration.', command: 'bash scripts/mailops/storage-migrate.sh --dry-run' },
      { kind: 'verify', title: 'Compare object count and total bytes, then checksum a sample', detail: 'Count alone will not catch a truncated object.' },
      { kind: 'cutover', title: 'Set the S3_* variables and redeploy', detail: 'The storage layer selects S3 when all four are present. Confirm the active backend afterwards rather than assuming the deploy took.', decision: true },
      { kind: 'observe', title: 'Open several old messages with attachments', detail: 'Old ones specifically. New uploads working proves the write path, not the migration.' },
      { kind: 'rollback', title: 'Unset the S3 variables', detail: 'Safe while the old store still holds every object. Anything uploaded since cutover exists only in the new bucket, so copy back first.' },
      { kind: 'decommission', title: 'Delete the old store', detail: 'After the soak, and only after a sample of old attachments has been opened successfully from the new one.', irreversible: true, decision: true },
    ],
  },
  {
    id: 'local-mta-to-dedicated',
    title: 'Local MTA to a dedicated MTA',
    moving: 'Outbound sending from the laptop MTA to a dedicated sending host or a managed relay.',
    because: 'Domestic uplinks block port 25 outbound and their IP ranges carry poor sending reputation. A dedicated sending IP is the difference between mail arriving and mail arriving in spam.',
    principalRisk:
      'Reputation. A brand-new sending IP has no history, and sending full volume from it on day one gets you throttled or blocked. The migration is a warm-up curve, not a switch.',
    onlineCopy: true,
    gateEntities: ['delivery_events'],
    soakDays: 30,
    steps: [
      { kind: 'prepare', title: 'Add the new host to SPF before sending anything from it', detail: 'Mail from an IP outside SPF fails authentication on arrival, and the first impression is the one that sticks.' },
      { kind: 'prepare', title: 'Publish DKIM for the new host, or share the key', detail: 'Sharing the key is simpler and is acceptable when both hosts are ours. A separate selector per host is cleaner and makes revocation surgical.' },
      { kind: 'copy', title: 'Nothing to copy', detail: 'The spool stays where the worker is. If the worker moves too, the spool moves with it and this becomes part of the ZBook migration instead.' },
      { kind: 'cutover', title: 'Route a fraction of outbound through the new host', detail: 'Start small. Transactional mail first — it is low volume, high engagement, and it builds reputation faster than bulk.', decision: true },
      { kind: 'observe', title: 'Watch bounce class and spam rejection per host', detail: 'Compare the two hosts on the same recipient domains. That comparison is the only real measure of whether the new IP is warming up.' },
      { kind: 'cutover', title: 'Increase the fraction over two to four weeks', detail: 'Back off on any rise in rate_limited or spam_rejection rather than pushing through it.' },
      { kind: 'rollback', title: 'Route everything back to the old host', detail: 'Immediate and free. Nothing is stranded because the spool is shared.' },
      { kind: 'decommission', title: 'Remove the old host from SPF', detail: 'Last. An SPF record that still lists a host you no longer control is a way for somebody else to pass authentication as this domain.', irreversible: true, decision: true },
    ],
  },
  {
    id: 'single-mta-to-cluster',
    title: 'One MTA to an MTA cluster',
    moving: 'Several sending hosts behind one queue, with inbound behind a load balancer.',
    because: 'Throughput, and losing a node without losing mail.',
    principalRisk: 'Per-domain rate limiting becomes per-node instead of global, so three nodes each respecting a 60/min limit send 180/min to a recipient who allowed 60. That gets the whole domain throttled.',
    onlineCopy: true,
    gateEntities: ['delivery_events'],
    soakDays: 14,
    steps: [
      { kind: 'prepare', title: 'Move rate limiting to shared state', detail: 'Per-domain throttles must be counted across nodes, not per process. This is the one piece of the design that genuinely changes when the second node arrives, and it is worth building the interface for it before the node exists.' },
      { kind: 'prepare', title: 'Every node in SPF, every node with reverse DNS', detail: 'A node missing from either produces intermittent authentication failures that look random because they depend on which node picked up the message.' },
      { kind: 'copy', title: 'Shared spool, as in the multi-node migration', detail: 'Same requirement, same atomic-rename caveat.' },
      { kind: 'verify', title: 'Confirm the global rate limit holds', detail: 'Measure messages per minute to one destination domain across all nodes, not per node.' },
      { kind: 'cutover', title: 'Bring nodes in one at a time', detail: 'Each new node is a new IP and needs its own warm-up.', decision: true },
      { kind: 'observe', title: 'Per-node bounce and deferral rates', detail: 'A single bad node shows up as a worse rate on one IP, and averaging across the cluster hides it.' },
      { kind: 'rollback', title: 'Remove a node from the pool', detail: 'Drain it first — see ./drain.ts. Killing it strands its leases for one lease interval.' },
      { kind: 'decommission', title: 'Not applicable', detail: 'Nodes are added and removed, not migrated away from.' },
    ],
  },
] as const;

export function migrationPlan(id: MigrationId): MigrationPlan | undefined {
  return MIGRATION_PLANS.find((p) => p.id === id);
}

// ---------------------------------------------------------------------------
// Inventories and the consistency report
// ---------------------------------------------------------------------------

export interface Inventory {
  /** Where this was taken: 'source' / 'target', plus a human label. */
  label: string;
  takenAt: string;
  counts: Partial<Record<EntityKind, number>>;
  /** Optional per-mailbox breakdown. A global total can match while individual mailboxes do not. */
  perMailbox?: Record<string, Partial<Record<EntityKind, number>>>;
  /** Optional content checksums for a sample, so a truncated copy is detectable. */
  sampleChecksums?: Record<string, string>;
}

export type EntityVerdict = 'match' | 'within-tolerance' | 'short' | 'excess' | 'missing-data';

export interface EntityComparison {
  entity: EntityKind;
  label: string;
  source: number | null;
  target: number | null;
  delta: number | null;
  verdict: EntityVerdict;
  note: string;
}

export interface MigrationReport {
  migrationId: MigrationId | null;
  generatedAt: string;
  source: { label: string; takenAt: string };
  target: { label: string; takenAt: string };
  entities: EntityComparison[];
  /** Per-mailbox differences, when both inventories carry the breakdown. */
  mailboxDiffs: { mailbox: string; entity: EntityKind; source: number; target: number }[];
  checksumMismatches: string[];
  /** True only when every gated entity matched (or was inside tolerance) and no checksum differed. */
  passed: boolean;
  /** Everything that stopped it passing, in the order a human should read it. */
  problems: string[];
}

/**
 * How much drift is acceptable per entity.
 *
 * Not zero everywhere, and the exceptions are principled rather than convenient: an online copy of
 * a live system will always show a few more messages and delivery events on the source, because
 * mail kept arriving while the copy ran. A tolerance of zero on those would make every honest
 * migration look failed, which trains people to ignore the report.
 *
 * TARGET SHORTFALL IS NEVER ACCEPTABLE for anything else. Fewer mailboxes, folders, flags,
 * attachments, contacts or templates on the target means something did not come across.
 */
export interface Tolerances {
  /** Entities where the target may legitimately be BEHIND the source, and by how much. */
  allowedShortfall: Partial<Record<EntityKind, number>>;
  /** Entities where the target may legitimately be AHEAD (rare — usually a double-import bug). */
  allowedExcess: Partial<Record<EntityKind, number>>;
}

export const DEFAULT_TOLERANCES: Tolerances = {
  allowedShortfall: { messages: 50, delivery_events: 500, bytes: 1024 * 1024 },
  allowedExcess: {},
};

export function compareInventories(
  source: Inventory,
  target: Inventory,
  opts: { migrationId?: MigrationId | null; tolerances?: Tolerances; entities?: EntityKind[]; now?: Date } = {},
): MigrationReport {
  const tolerances = opts.tolerances ?? DEFAULT_TOLERANCES;
  const now = opts.now ?? new Date();
  const entityList =
    opts.entities ??
    (Array.from(new Set([...Object.keys(source.counts), ...Object.keys(target.counts)])) as EntityKind[]);

  const entities: EntityComparison[] = entityList.map((entity) => {
    const s = source.counts[entity] ?? null;
    const t = target.counts[entity] ?? null;
    const label = ENTITY_LABELS[entity] || entity;

    if (s == null || t == null) {
      return {
        entity, label, source: s, target: t, delta: null,
        verdict: 'missing-data',
        note: s == null && t == null
          ? 'Neither inventory counted this. It has not been verified — that is not the same as it being fine.'
          : `Only the ${s == null ? 'target' : 'source'} counted this, so there is nothing to compare against.`,
      };
    }

    const delta = t - s;
    if (delta === 0) return { entity, label, source: s, target: t, delta, verdict: 'match', note: 'Exact match.' };

    if (delta < 0) {
      const allowed = tolerances.allowedShortfall[entity] ?? 0;
      if (Math.abs(delta) <= allowed) {
        return {
          entity, label, source: s, target: t, delta,
          verdict: 'within-tolerance',
          note: `${Math.abs(delta)} behind, within the ${allowed} allowed for an online copy. Re-run the delta sync and this should close.`,
        };
      }
      return {
        entity, label, source: s, target: t, delta,
        verdict: 'short',
        note: `${Math.abs(delta)} MISSING on the target. Cutover must not proceed on this entity.`,
      };
    }

    const allowedUp = tolerances.allowedExcess[entity] ?? 0;
    if (delta <= allowedUp) {
      return { entity, label, source: s, target: t, delta, verdict: 'within-tolerance', note: `${delta} ahead, within tolerance.` };
    }
    return {
      entity, label, source: s, target: t, delta,
      verdict: 'excess',
      note: `${delta} MORE on the target than the source. Usually a copy that ran twice — and for messages that means recipients will see duplicates.`,
    };
  });

  const mailboxDiffs: MigrationReport['mailboxDiffs'] = [];
  if (source.perMailbox && target.perMailbox) {
    for (const [mailbox, sCounts] of Object.entries(source.perMailbox)) {
      const tCounts = target.perMailbox[mailbox] || {};
      for (const [k, sv] of Object.entries(sCounts)) {
        const entity = k as EntityKind;
        const tv = tCounts[entity] ?? 0;
        if (sv != null && tv !== sv) mailboxDiffs.push({ mailbox, entity, source: sv, target: tv });
      }
    }
    for (const mailbox of Object.keys(target.perMailbox)) {
      if (!source.perMailbox[mailbox]) {
        mailboxDiffs.push({ mailbox, entity: 'mailboxes', source: 0, target: 1 });
      }
    }
  }

  const checksumMismatches: string[] = [];
  if (source.sampleChecksums && target.sampleChecksums) {
    for (const [key, sum] of Object.entries(source.sampleChecksums)) {
      const other = target.sampleChecksums[key];
      if (other == null) checksumMismatches.push(`${key}: absent from the target`);
      else if (other !== sum) checksumMismatches.push(`${key}: content differs`);
    }
  }

  const problems: string[] = [];
  for (const e of entities) {
    if (e.verdict === 'short' || e.verdict === 'excess') problems.push(`${e.label}: ${e.note}`);
    if (e.verdict === 'missing-data') problems.push(`${e.label}: ${e.note}`);
  }
  if (mailboxDiffs.length) {
    problems.push(`${mailboxDiffs.length} per-mailbox differences. A matching global total can still hide a mailbox that lost a folder.`);
  }
  for (const c of checksumMismatches) problems.push(`Checksum: ${c}`);

  return {
    migrationId: opts.migrationId ?? null,
    generatedAt: now.toISOString(),
    source: { label: source.label, takenAt: source.takenAt },
    target: { label: target.label, takenAt: target.takenAt },
    entities,
    mailboxDiffs,
    checksumMismatches,
    passed: problems.length === 0,
    problems,
  };
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

export interface CutoverDecision {
  allowed: boolean;
  reasons: string[];
}

/**
 * May the cutover proceed.
 *
 * Checks the GATED entities specifically, not every entity in the report — a plan declares which
 * counts it depends on, and a mismatch in an ungated entity is worth reading but is not a blocker.
 * 'missing-data' on a gated entity IS a blocker: an unverified count is not a passed check.
 */
export function cutoverAllowed(plan: MigrationPlan, report: MigrationReport): CutoverDecision {
  const reasons: string[] = [];
  for (const entity of plan.gateEntities) {
    const cmp = report.entities.find((e) => e.entity === entity);
    if (!cmp) {
      reasons.push(`${ENTITY_LABELS[entity]} was not compared at all, and this migration gates on it.`);
      continue;
    }
    if (cmp.verdict === 'short' || cmp.verdict === 'excess' || cmp.verdict === 'missing-data') {
      reasons.push(`${cmp.label}: ${cmp.note}`);
    }
  }
  if (report.checksumMismatches.length) {
    reasons.push(`${report.checksumMismatches.length} sampled objects differ in content between source and target.`);
  }
  if (report.mailboxDiffs.length && plan.gateEntities.includes('mailboxes')) {
    reasons.push(`${report.mailboxDiffs.length} per-mailbox differences on a migration that gates on mailbox integrity.`);
  }
  return { allowed: reasons.length === 0, reasons };
}

export interface DecommissionRequest {
  plan: MigrationPlan;
  report: MigrationReport | null;
  cutoverAt: string | null;
  /** The founder typed the name of the thing being destroyed. Not a checkbox. */
  confirmationPhrase: string | null;
  expectedPhrase: string;
  now?: Date;
}

/**
 * May the ORIGINAL be destroyed yet.
 *
 * Three independent conditions, all required, because each one has failed on its own somewhere:
 * verification passed (the copy is correct), the soak elapsed (the copy is correct IN PRODUCTION),
 * and a human typed the name (nobody deleted it by reflex while clearing up).
 */
export function decommissionAllowed(req: DecommissionRequest): CutoverDecision {
  const now = req.now ?? new Date();
  const reasons: string[] = [];

  if (!req.report) {
    reasons.push('No verification report exists. The rule is that the original is not destroyed until verification succeeds, and an absent report is not a success.');
  } else if (!req.report.passed) {
    reasons.push(`The verification report did not pass: ${req.report.problems[0]}`);
  }

  if (!req.cutoverAt) {
    reasons.push('Cutover has not been recorded, so the soak period has not started.');
  } else {
    const days = (now.getTime() - Date.parse(req.cutoverAt)) / 86_400_000;
    if (!Number.isFinite(days)) reasons.push('The recorded cutover time is not a valid date.');
    else if (days < req.plan.soakDays) {
      reasons.push(`Soak period incomplete: ${Math.floor(days)} of ${req.plan.soakDays} days. The old system stays reachable until it ends.`);
    }
  }

  if (req.confirmationPhrase !== req.expectedPhrase) {
    reasons.push(`Confirmation phrase does not match. Type "${req.expectedPhrase}" exactly to proceed.`);
  }

  return { allowed: reasons.length === 0, reasons };
}

/** Render a report as markdown, for attaching to a migration record. */
export function reportToMarkdown(report: MigrationReport): string {
  const lines: string[] = [];
  lines.push(`# Migration verification report`, '');
  lines.push(`Generated ${report.generatedAt}`, '');
  lines.push(`- Source: **${report.source.label}** (inventory taken ${report.source.takenAt})`);
  lines.push(`- Target: **${report.target.label}** (inventory taken ${report.target.takenAt})`, '');
  lines.push(report.passed ? '**RESULT: PASSED**' : '**RESULT: NOT PASSED**', '');
  lines.push('| Entity | Source | Target | Delta | Verdict |');
  lines.push('| --- | ---: | ---: | ---: | --- |');
  for (const e of report.entities) {
    lines.push(`| ${e.label} | ${e.source ?? '—'} | ${e.target ?? '—'} | ${e.delta ?? '—'} | ${e.verdict} |`);
  }
  if (report.problems.length) {
    lines.push('', '## Problems', '');
    for (const p of report.problems) lines.push(`- ${p}`);
  }
  if (report.mailboxDiffs.length) {
    lines.push('', '## Per-mailbox differences', '');
    for (const d of report.mailboxDiffs.slice(0, 100)) {
      lines.push(`- ${d.mailbox} / ${ENTITY_LABELS[d.entity]}: source ${d.source}, target ${d.target}`);
    }
    if (report.mailboxDiffs.length > 100) lines.push(`- …and ${report.mailboxDiffs.length - 100} more`);
  }
  return lines.join('\n');
}
