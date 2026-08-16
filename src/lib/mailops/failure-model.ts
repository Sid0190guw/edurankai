// src/lib/mailops/failure-model.ts — WHAT BREAKS, WHAT KEEPS WORKING, AND WHAT WE ARE NOT ALLOWED
// TO SAY WHILE IT IS BROKEN.
//
// A failure model is not a list of scary words. It is a function from "these components are down"
// to "these capabilities are therefore gone" — and, the part that matters most on this project, to
// "these sentences the product currently shows are now lies".
//
// That last column is why this file is code rather than a page of prose. This repository has
// shipped, more than once, a screen that rendered a calm zero over a failed read: /admin/mail/health
// drew "0 inbound, 0 outbound, last never" when its query threw, which looks identical to a quiet
// Tuesday. Mail makes that mistake expensive in a particular way — an MX endpoint that is down does
// not bounce mail, it makes the sending server retry silently for days, so a product that says
// "delivered to your inbox" while its MX is offline is making a promise nobody is keeping.
//
// So every mode below carries `mustNotClaim`, and suppressedClaims() is what a surface calls before
// it prints a reassuring sentence.
//
// PHASE 1 IS ONE LAPTOP. Nothing here pretends otherwise. `phase1` on each mode is the present-tense
// truth on an HP ZBook Fury G8 running the stack locally, and for most modes it reads "no redundancy
// exists; the mitigation is Phase 2". Writing an aspirational failover story into a Phase-1 runbook
// is how a person at 2am spends twenty minutes looking for a standby that was never built.

export type ComponentId =
  | 'zbook'         // the machine itself: unavailable, asleep, taken to a meeting
  | 'power'         // mains loss; the battery is the only UPS this stack has
  | 'disk'          // the NVMe holding the spool, maildirs, keys and container volumes
  | 'internet'      // the uplink
  | 'dns'           // authoritative DNS for the domain, or resolution from the host
  | 'mta_out'       // Postfix outbound / the engine's SMTP client path
  | 'mta_in'        // the inbound MX listener on port 25
  | 'dovecot'       // IMAP and the maildir store
  | 'rspamd'        // spam scoring milter
  | 'engine_worker' // the mail-engine delivery worker process
  | 'spool'         // the on-disk outbound spool (MAIL_SPOOL_DIR)
  | 'queue'         // the Postgres job queue (edu_jobs)
  | 'database'      // Postgres, whoever hosts it
  | 'storage'       // object storage for attachments and raw MIME
  | 'vercel'        // the application host
  | 'supabase'      // the managed Postgres provider specifically
  | 'redis';        // listed because the brief lists it. See REDIS_NOTE below.

export type Capability =
  | 'outbound_send'
  | 'inbound_receive'
  | 'mailbox_read'
  | 'webmail_ui'
  | 'campaigns'
  | 'delivery_events'
  | 'spam_filter'
  | 'attachments'
  | 'admin_console';

export type LossClass =
  | 'none'          // nothing is lost; work pauses and resumes
  | 'in_flight'     // only work held in RAM at the instant of failure
  | 'window'        // everything since the last durable checkpoint (see ./objectives.ts)
  | 'catastrophic'; // unrecoverable without a restore, or not recoverable at all

export interface FailureMode {
  id: string;
  component: ComponentId;
  label: string;
  /** What the system is designed to do. Present tense, and only where it actually does it today. */
  expected: string;
  /** The sentence the product must not display while this is true. */
  mustNotClaim: string;
  /** How anyone finds out. "Nothing is watching" is a legal value and is used where it is true. */
  detection: string;
  loss: LossClass;
  /** Runbook id in ./runbooks.ts, or null when the mode is handled inside another runbook. */
  runbook: string | null;
  /** The honest Phase-1 (single ZBook) situation. */
  phase1: string;
  /** What a later phase changes about it. */
  phaseFix: string;
}

/**
 * REDIS_NOTE. There is no Redis in this system. The job queue is Postgres (src/lib/job-queue.ts:
 * atomic claim with FOR UPDATE SKIP LOCKED), the outbound spool is the filesystem, and nothing
 * imports a Redis client — a grep over src/ and mail-engine/ returns comments only. "Redis
 * unavailable" is therefore a no-op today, and the entry below says so rather than inventing a
 * dependency in order to look thorough. It stays in the list because the moment somebody adds Redis
 * as a cache or a rate limiter, the rule in its `expected` field is the rule they have to honour.
 */
export const FAILURE_MODES: readonly FailureMode[] = [
  {
    id: 'zbook-unavailable',
    component: 'zbook',
    label: 'Laptop unavailable (closed, asleep, off-site)',
    expected:
      'Outbound mail already spooled stays on disk and is not lost. New sends from the app fail at the transport and are recorded as failed rather than silently dropped. Inbound mail is not accepted at all: the MX is on this machine, so sending servers get a connection failure and hold the message in their own queue.',
    mustNotClaim:
      'Any wording implying mail is being received. The inbox is not empty, it is unreachable, and those are different facts.',
    detection:
      'Nothing is watching. /api/health does not test the mail host. The first signal today is a human noticing no new mail.',
    loss: 'none',
    runbook: 'rb-zbook',
    phase1: 'Total mail outage for as long as the lid is shut. There is no second node and no secondary MX.',
    phaseFix: 'Phase 2 moves the MTA to an always-on dedicated host, which removes this mode for inbound entirely.',
  },
  {
    id: 'zbook-reboot',
    component: 'zbook',
    label: 'Laptop reboot',
    expected:
      'Services restart under their supervisor. The spool is a directory, so queued outbound survives. The delivery worker reclaims its own expired leases on start (spool.reclaim()) rather than leaving entries stuck in `sending` forever.',
    mustNotClaim: 'That no mail was delayed. A reboot defers delivery by the boot time plus one lease interval.',
    detection: 'Spool depth spikes and then drains. Visible on /admin/mail/continuity once the host reports.',
    loss: 'in_flight',
    runbook: 'rb-zbook',
    phase1: 'Expected to be clean, and it is the one failure in this list with an actual scripted test.',
    phaseFix: 'Phase 3 rolling deploys make a restart invisible rather than merely survivable.',
  },
  {
    id: 'internet-down',
    component: 'internet',
    label: 'Internet disconnected',
    expected:
      'Outbound: every attempt fails at connection, is classed `connection_failure`, and is retried with backoff up to the attempt ceiling. Nothing is dead-lettered early because of it. Inbound: sending servers cannot reach the MX and retry on their own schedule. The app on Vercel is unaffected — it is not hosted here.',
    mustNotClaim: 'A bounce. A connection failure is a deferral, and telling a user "undeliverable" for one is wrong.',
    detection: 'Consecutive connection_failure events across unrelated destination domains. That pattern is the uplink, not the recipients.',
    loss: 'none',
    runbook: 'rb-mail-server',
    phase1: 'One uplink, no secondary. The retry horizon is the real outage budget.',
    phaseFix: 'Phase 2 puts the MTA in a datacentre with its own transit.',
  },
  {
    id: 'smtp-unavailable',
    component: 'mta_out',
    label: 'Outbound SMTP unavailable (MTA down, relay refusing)',
    expected:
      'Messages stay in the spool as `queued`. The API keeps accepting them, because acceptance is a spool write and not a delivery. Every attempt writes a `deferred` event carrying the SMTP code.',
    mustNotClaim: '"Sent". The correct word while the spool is holding is "queued", and the UI must use it.',
    detection: 'Spool depth rising with no delivered events.',
    loss: 'none',
    runbook: 'rb-mail-server',
    phase1: 'A single MTA. No relay fallback unless MAIL_RELAY_HOST is set.',
    phaseFix: 'Phase 3 MTA cluster: one node down becomes capacity loss rather than an outage.',
  },
  {
    id: 'mx-unavailable',
    component: 'mta_in',
    label: 'Inbound MX unavailable',
    expected:
      'Nothing is accepted. Well-behaved sending MTAs queue and retry — RFC 5321 recommends at least 4-5 days, but the sender chooses and some give up far sooner. Mail is not lost during that window; it is held by the sender.',
    mustNotClaim:
      'Guaranteed receipt. While the MX is down the system has no basis for any receipt claim at all. And do not add a "secondary MX" that only queues into the same dead machine: a backup MX which cannot deliver onward converts a sender-side retry (safe, someone else\'s disk) into a local queue on hardware that is already failing (not safe).',
    detection: 'No inbound events for longer than the quietest normal gap. Nothing is watching automatically.',
    loss: 'none',
    runbook: 'rb-mail-server',
    phase1: 'The MX is one laptop. This is the single largest availability risk in the system.',
    phaseFix:
      'Phase 2 is the real fix: an always-online dedicated inbound host. A holding MX is worth adding only when it sits on separate infrastructure AND can spool independently.',
  },
  {
    id: 'database-unavailable',
    component: 'database',
    label: 'Database unavailable',
    expected:
      'The app returns 503 from /api/health. The mail host keeps running — it holds no database client. Delivery events cannot be published, so the publisher holds them in its local outbox and flush() drains them when the app returns. Inbound mail cannot be filed into mailboxes and must therefore be answered 4xx so the sender retries, never 2xx.',
    mustNotClaim: 'Anything counted. Every counter on every mail screen is a database read; when it fails the screen says so instead of rendering zero.',
    detection: '/api/health returns 503. Every admin page errors at once.',
    loss: 'none',
    runbook: 'rb-database',
    phase1: 'Supabase-hosted. Free-tier compute exhaustion presents identically to an outage.',
    phaseFix: 'Phase 3 self-hosted Postgres with a replica; Phase 5 multi-region.',
  },
  {
    id: 'supabase-unavailable',
    component: 'supabase',
    label: 'Supabase (the provider) unavailable',
    expected:
      'Identical to a database outage from the application\'s point of view. The distinction matters only for the runbook: there is nothing to restart, the fix is provider status plus waiting, and the recovery lever is the restore path rather than anything local.',
    mustNotClaim: 'An ETA. A provider status page is a source, not a commitment.',
    detection: 'Provider status page; connections refused rather than queries erroring.',
    loss: 'none',
    runbook: 'rb-database',
    phase1: 'One provider, one project, one region.',
    phaseFix: 'Phase 3 removes the provider from the critical path.',
  },
  {
    id: 'redis-unavailable',
    component: 'redis',
    label: 'Redis unavailable',
    expected:
      'No effect: there is no Redis in this system. If one is ever introduced it must be a cache or a rate limiter only, never the sole record of an accepted message — an in-memory store with no append-only file is exactly the "rely solely on RAM" failure this work exists to prevent.',
    mustNotClaim: 'That a Redis outage is covered by failover. There is nothing to fail over.',
    detection: 'Not applicable.',
    loss: 'none',
    runbook: null,
    phase1: 'Absent by design.',
    phaseFix: 'If added in Phase 3+, it inherits the rule above.',
  },
  {
    id: 'worker-unavailable',
    component: 'engine_worker',
    label: 'Delivery worker unavailable or crashed',
    expected:
      'The spool is untouched, because the worker owns no state of its own. Entries it had claimed sit in `sending` holding a lease; reclaim() returns them to `queued` once the lease expires. A crash therefore costs a lease interval, not a message. Duplicate delivery is bounded by that same lease plus the per-entry attempt record.',
    mustNotClaim: 'That queued mail is moving.',
    detection: 'Spool depth flat and non-zero with no attempts being made.',
    loss: 'in_flight',
    runbook: 'rb-queue',
    phase1: 'One worker. Restarting it is the whole recovery.',
    phaseFix: 'Phase 3: several workers over the same spool. The lease semantics are already correct for that.',
  },
  {
    id: 'storage-unavailable',
    component: 'storage',
    label: 'Object storage unavailable',
    expected:
      'Message bodies and metadata are unaffected; they live in Postgres. Attachments and raw MIME cannot be written or read. An outbound send carrying an attachment must FAIL rather than go out with a missing part, and an inbound message whose attachment cannot be stored is filed with that part marked rejected and the reason recorded — never silently stripped.',
    mustNotClaim: 'That an attachment was delivered when only its filename was stored.',
    detection: 'The storage backend reporting `memory`, or put() errors in the send path.',
    loss: 'window',
    runbook: 'rb-storage',
    phase1:
      'S3-compatible when the S3_* variables are set, Vercel Blob otherwise, in-memory in dev — and the in-memory case loses everything on restart, which is fine in dev and a data-loss bug anywhere else.',
    phaseFix: 'Phase 2 pins S3-compatible storage with versioning enabled, which also satisfies the sovereignty rule.',
  },
  {
    id: 'vercel-unavailable',
    component: 'vercel',
    label: 'Vercel unavailable',
    expected:
      'The web app, the admin console and the API are gone. The mail host continues to accept, spool and deliver outbound mail, and continues to accept connections at the MX — but it cannot file inbound into mailboxes, because filing is an application call. Inbound is therefore answered 4xx (try again later), not 2xx.',
    mustNotClaim: 'Receipt of anything that could not be filed.',
    detection: 'Provider status; the event publisher\'s pending() count rising.',
    loss: 'none',
    runbook: 'rb-mail-server',
    phase1: 'One hosting provider.',
    phaseFix: 'Phase 4 makes the app portable off Vercel. The mail host is already independent of it.',
  },
  {
    id: 'dns-issue',
    component: 'dns',
    label: 'DNS issue (records wrong, resolution failing)',
    expected:
      'Two very different failures share this name. (a) Outbound resolution failing: MX lookups fail, everything defers, nothing bounces. (b) Authoritative records wrong or expired: other people cannot find our MX, SPF/DKIM/DMARC stop validating, and mail we send starts being rejected or filed as spam — which looks like a reputation problem and is not one.',
    mustNotClaim: 'That delivery is healthy because the queue is empty. An empty queue plus rising spam rejections is the (b) signature.',
    detection: 'The DNS check on /admin/mail/health; a rise in policy_rejection and spam_rejection bounce classes.',
    loss: 'none',
    runbook: 'rb-dns',
    phase1: 'Records are maintained by hand at the registrar. There is no automation and no drift monitoring.',
    phaseFix: 'Phase 2 adds scheduled record verification. Automated writes stay off — see ./dns-cutover.ts.',
  },
  {
    id: 'mta-failure',
    component: 'mta_out',
    label: 'MTA failure (bad config, expired certificate, corrupt queue)',
    expected:
      'Distinct from "SMTP unavailable" because the process is up and wrong rather than absent. An MTA refusing to start after a config edit, or a TLS certificate expiring, produces deliveries that fail with one consistent code. The engine keeps the message and defers.',
    mustNotClaim: 'Success from a 2xx at the relay when the relay then dead-letters it. Only a 2xx from the recipient MX is delivery.',
    detection: 'One SMTP or enhanced code dominating deferrals across every destination domain at once.',
    loss: 'none',
    runbook: 'rb-mail-server',
    phase1: 'Certificate renewal is manual. That is a scheduled outage waiting to happen, and it is listed in the gaps.',
    phaseFix: 'Phase 2 automates renewal on the dedicated host.',
  },
  {
    id: 'disk-failure',
    component: 'disk',
    label: 'Disk failure',
    expected:
      'The spool, the maildirs, the DKIM private keys and every container volume are on one NVMe. Losing it loses all four. Only what has been copied off the machine survives. The database is elsewhere and is unaffected.',
    mustNotClaim: 'That the backup covers it, unless a restore test has actually passed. See ./backup.ts — an unverified backup is not a backup.',
    detection: 'SMART, or the machine failing to boot. Nothing is watching SMART today.',
    loss: 'catastrophic',
    runbook: 'rb-storage',
    phase1: 'No RAID and no mirror. The DKIM private key is the most damaging item here to lose and the second most damaging to leak.',
    phaseFix: 'Phase 2: mirrored volumes on the dedicated host, keys in a secret store with an offline encrypted escrow copy.',
  },
  {
    id: 'power-failure',
    component: 'power',
    label: 'Power failure',
    expected:
      'The laptop battery is the UPS: the machine keeps running and then hibernates cleanly, which makes this a slower reboot rather than a hard cut. Everything already fsynced to the spool survives. Anything accepted but not yet fsynced does not — which is exactly why acceptance is defined as "fsynced", not "in RAM".',
    mustNotClaim: 'Durability for a message the API acknowledged before its spool write was flushed.',
    detection: 'Uptime reset.',
    loss: 'in_flight',
    runbook: 'rb-zbook',
    phase1: 'Battery health is the real dependency here and nobody is tracking it.',
    phaseFix: 'Phase 2 datacentre power with a real UPS behind it.',
  },
  {
    id: 'queue-failure',
    component: 'queue',
    label: 'Job queue failure (edu_jobs unavailable or poisoned)',
    expected:
      'The Postgres job queue backs campaigns, digests and scheduled sends, and it fails with the database. A poisoned job — one that fails deterministically — retries to max_attempts and then sits in `failed`, which is correct: it stops consuming workers and waits for a human. retryFailed() is the deliberate re-arm.',
    mustNotClaim: 'That a campaign completed because it was enqueued.',
    detection: 'Failed count rising; jobs pending with run_after long past.',
    loss: 'none',
    runbook: 'rb-queue',
    phase1: 'The worker is not on a timer today — it runs when something invokes it. A queue with no runner looks exactly like a queue with no work.',
    phaseFix: 'Phase 2 runs the worker as a service on the mail host, which is where it belongs anyway.',
  },
  {
    id: 'spool-failure',
    component: 'spool',
    label: 'Spool directory unwritable or full',
    expected:
      'Acceptance MUST fail. The API returns an error and the caller keeps ownership of the message. The one thing that must never happen is a 2xx acknowledgement for a message that could not be written down.',
    mustNotClaim: 'Acceptance. This is the entire point of the fsync-before-ack rule.',
    detection: 'Spool writes erroring; free space on the spool volume.',
    loss: 'none',
    runbook: 'rb-queue',
    phase1: 'No disk-space alarm exists.',
    phaseFix: 'Phase 2 adds a free-space check to the health endpoint and puts the spool on its own volume.',
  },
  {
    id: 'credential-compromise',
    component: 'zbook',
    label: 'Credential or key compromise',
    expected:
      'Not an availability failure but an integrity one, and it is in this list because the response inverts every other entry. Everything else says "keep serving". This one says "stop signing and stop sending" until the key is rotated, because a leaked DKIM private key lets a stranger send mail that authenticates as this domain.',
    mustNotClaim: 'That publishing a new DNS record is sufficient without also revoking the old selector.',
    detection: 'Out of band. Nothing inside the system detects this.',
    loss: 'none',
    runbook: 'rb-dkim',
    phase1: 'Keys live in the engine key directory, gitignored, on one machine, unencrypted at rest.',
    phaseFix: 'Phase 2 moves them into a secret store; the escrow copy stays offline and encrypted.',
  },
] as const;

// ---------------------------------------------------------------------------
// Capability dependency graph
// ---------------------------------------------------------------------------

interface CapabilitySpec {
  label: string;
  /** Down => the capability is DOWN. */
  hard: ComponentId[];
  /** Down => the capability still works, but worse, and the UI has to say how. */
  soft: { component: ComponentId; effect: string }[];
}

const CAPABILITIES: Record<Capability, CapabilitySpec> = {
  outbound_send: {
    label: 'Send mail to the outside world',
    // Note what is NOT hard here: the database. Accepting and spooling a message does not need it,
    // and modelling that correctly is what lets the mail host keep working through a DB outage.
    hard: ['spool', 'internet', 'mta_out'],
    soft: [
      { component: 'engine_worker', effect: 'accepted and spooled, but nothing is draining the spool' },
      { component: 'database', effect: 'delivering, but no delivery events are being recorded' },
      { component: 'storage', effect: 'messages without attachments only' },
      { component: 'dns', effect: 'MX lookups may fail; deliveries defer rather than bounce' },
    ],
  },
  inbound_receive: {
    label: 'Receive mail from the outside world',
    hard: ['mta_in', 'internet', 'zbook'],
    soft: [
      { component: 'database', effect: 'accepted at the MX but answered 4xx, so senders retry — nothing is filed' },
      { component: 'rspamd', effect: 'no spam scoring; everything arrives unscored' },
      { component: 'vercel', effect: 'accepted at the MX but answered 4xx — filing a message is an application call, and there is no application to call' },
      { component: 'dovecot', effect: 'no IMAP copy; the application copy is the only one' },
      { component: 'storage', effect: 'attachments recorded as rejected rather than stored' },
    ],
  },
  mailbox_read: {
    label: 'Read a mailbox',
    hard: ['database'],
    soft: [{ component: 'storage', effect: 'message text renders; attachments will not download' }],
  },
  webmail_ui: { label: 'The web mail interface', hard: ['vercel', 'database'], soft: [] },
  campaigns: {
    label: 'Bulk and campaign sending',
    hard: ['database', 'queue', 'spool'],
    soft: [{ component: 'engine_worker', effect: 'enqueued but not progressing' }],
  },
  delivery_events: {
    label: 'Delivery reporting (delivered / bounced / deferred)',
    hard: ['database'],
    soft: [{ component: 'vercel', effect: 'events buffer in the host outbox and replay on recovery' }],
  },
  spam_filter: { label: 'Spam scoring on inbound', hard: ['rspamd'], soft: [] },
  attachments: { label: 'Attachment upload and download', hard: ['storage'], soft: [] },
  admin_console: { label: 'Mail administration screens', hard: ['vercel', 'database'], soft: [] },
};

export type CapabilityState = 'up' | 'degraded' | 'down';

export interface CapabilityReport {
  capability: Capability;
  label: string;
  state: CapabilityState;
  /** One line per reason, already human-readable. Empty when up. */
  because: string[];
}

/**
 * Expand a set of failed components into everything that fails WITH them.
 *
 * Kept as one function so every caller agrees. A dead machine takes its own services with it, and
 * making each caller remember that turns a status screen into a trick question.
 */
export function expandDown(down: readonly ComponentId[]): Set<ComponentId> {
  const isDown = new Set<ComponentId>(down);
  if (isDown.has('zbook') || isDown.has('power') || isDown.has('disk')) {
    for (const c of ['mta_out', 'mta_in', 'dovecot', 'rspamd', 'engine_worker', 'spool'] as ComponentId[]) isDown.add(c);
  }
  if (isDown.has('supabase')) isDown.add('database');
  if (isDown.has('database')) isDown.add('queue');
  if (isDown.has('internet')) { isDown.add('mta_out'); isDown.add('mta_in'); }
  return isDown;
}

/**
 * Given the components currently believed down, what can the system still do.
 *
 * Total on purpose: it answers for every capability, including the ones that are fine, because a
 * status screen that lists only problems cannot be told apart from a status screen that failed to
 * load.
 */
export function capabilityStatus(down: readonly ComponentId[]): CapabilityReport[] {
  const isDown = expandDown(down);
  return (Object.keys(CAPABILITIES) as Capability[]).map((capability) => {
    const spec = CAPABILITIES[capability];
    const hardHits = spec.hard.filter((c) => isDown.has(c));
    const softHits = spec.soft.filter((s) => isDown.has(s.component));
    if (hardHits.length) {
      return { capability, label: spec.label, state: 'down' as const, because: hardHits.map((c) => `${componentLabel(c)} is down`) };
    }
    if (softHits.length) {
      return {
        capability,
        label: spec.label,
        state: 'degraded' as const,
        because: softHits.map((s) => `${componentLabel(s.component)} is down: ${s.effect}`),
      };
    }
    return { capability, label: spec.label, state: 'up' as const, because: [] };
  });
}

const COMPONENT_LABELS: Record<ComponentId, string> = {
  zbook: 'The mail host',
  power: 'Mains power',
  disk: 'The mail host disk',
  internet: 'The uplink',
  dns: 'DNS',
  mta_out: 'Outbound SMTP',
  mta_in: 'The inbound MX',
  dovecot: 'IMAP (Dovecot)',
  rspamd: 'Spam scoring (Rspamd)',
  engine_worker: 'The delivery worker',
  spool: 'The outbound spool',
  queue: 'The job queue',
  database: 'The database',
  storage: 'Object storage',
  vercel: 'The application host',
  supabase: 'The database provider',
  redis: 'Redis (not in use)',
};

export function componentLabel(c: ComponentId): string {
  return COMPONENT_LABELS[c] || c;
}

export const ALL_COMPONENTS = Object.keys(COMPONENT_LABELS) as ComponentId[];

/**
 * The sentences a surface must not print right now.
 *
 * Not decoration. The brief says the system must not claim guaranteed receipt while the MX is
 * unavailable, and the only way a rule like that survives contact with a busy afternoon is by being
 * queryable rather than remembered.
 */
export function suppressedClaims(down: readonly ComponentId[]): { mode: string; claim: string }[] {
  const isDown = expandDown(down);
  return FAILURE_MODES.filter((m) => isDown.has(m.component)).map((m) => ({ mode: m.label, claim: m.mustNotClaim }));
}

const LOSS_ORDER: LossClass[] = ['none', 'in_flight', 'window', 'catastrophic'];

/** Worst data-loss class implied by a set of down components. Drives the banner tone. */
export function worstLoss(down: readonly ComponentId[]): LossClass {
  const isDown = expandDown(down);
  let worst: LossClass = 'none';
  for (const m of FAILURE_MODES) {
    if (isDown.has(m.component) && LOSS_ORDER.indexOf(m.loss) > LOSS_ORDER.indexOf(worst)) worst = m.loss;
  }
  return worst;
}

export function modesFor(component: ComponentId): FailureMode[] {
  return FAILURE_MODES.filter((m) => m.component === component);
}

/** Overall one-word state for a set of capability reports, for a header badge. */
export function overallState(reports: readonly CapabilityReport[]): CapabilityState {
  if (reports.some((r) => r.state === 'down')) return 'down';
  if (reports.some((r) => r.state === 'degraded')) return 'degraded';
  return 'up';
}
