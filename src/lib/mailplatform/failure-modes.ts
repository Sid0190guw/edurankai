// src/lib/mailplatform/failure-modes.ts — what each dependency failure is SUPPOSED to do (Patch 8 §10).
//
// §10 says "Expected behavior must be documented." Documented in prose rots, because nothing checks
// it. So the catalogue is DATA: each entry names the dependency, the expected behaviour, whether
// that behaviour is currently implemented or only intended, and how to reproduce the failure. The
// `status` field is the honest part — several of these are `intended`, meaning the desired behaviour
// is written down and the code does something else today. Marking them `implemented` would turn this
// file into the thing it exists to prevent.
//
// THE ONE RULE BEHIND EVERY ENTRY: a dependency failure may DELAY mail or REFUSE mail, but it must
// never silently lose mail and it must never report success it did not have. This repository has
// been bitten by the second: a send that failed at the SMTP layer left no trace because the log
// INSERT threw into an empty catch, and the reading pane claimed delivery (see the note in
// src/lib/mail.ts around email_logs.rfc_message_id). Every `expected` below is written against that
// standard.

export type Dependency =
  | 'database' | 'redis' | 'queue' | 'smtp' | 'worker' | 'mta' | 'network' | 'supabase_api' | 'vercel_api' | 'storage';

export type ImplementationStatus =
  /** The behaviour described is what the code does today, and there is a test or a call site to point at. */
  | 'implemented'
  /** Partly there: the mechanism exists but a gap is named in `gap`. */
  | 'partial'
  /** Written down, not built. */
  | 'intended';

export interface FailureMode {
  id: string;
  dependency: Dependency;
  scenario: string;
  /** What the system must do. Written so it can be checked, not admired. */
  expected: string;
  /** What must NEVER happen. The half of a spec that is usually missing. */
  mustNot: string;
  status: ImplementationStatus;
  /** Present when status is `partial` or `intended`: exactly what is missing. */
  gap?: string;
  /** How to cause it in a test environment. Never against production. */
  reproduce: string;
  /** Where the behaviour lives, or would live. */
  evidence: string[];
}

export const FAILURE_MODES: readonly FailureMode[] = [
  {
    id: 'db-unavailable',
    dependency: 'database',
    scenario: 'Postgres unreachable (pooler saturated, instance suspended, credentials rotated).',
    expected: '/api/health returns 503 so a monitor sees the outage in the status code. Admin pages render with a named read failure per panel rather than zeros. Sends fail loudly and are not acknowledged as accepted.',
    mustNot: 'Report a healthy status, render "0 pending" for an unreadable queue, or accept a message it cannot persist.',
    status: 'implemented',
    gap: undefined,
    reproduce: 'Point DATABASE_URL at a closed port in a staging environment and load /api/health.',
    evidence: ['src/pages/api/health.ts', 'src/lib/observability-health.ts quickHealth()', 'src/lib/mailplatform/queue-observability.ts unreadableSnapshot()'],
  },
  {
    id: 'db-slow',
    dependency: 'database',
    scenario: 'Postgres reachable but slow — pool exhaustion, a long-running analytics query, autovacuum on a large table.',
    expected: 'Queue wait time rises and is visible as queue_wait_duration_ms; the pool panel shows connections climbing; the site stays up.',
    mustNot: 'Let an analytics read block the send path. §6: analytics consumers must not block transactional workloads.',
    status: 'partial',
    gap: 'There is one connection pool for everything. A heavy analytics query and a send compete for the same pooler connections. Separation needs a second pool or a read replica — neither exists yet.',
    reproduce: 'Run a deliberately expensive aggregate against mp_events while a load test sends, and watch pool saturation on /admin/mail/performance.',
    evidence: ['src/lib/observability-health.ts poolSignals()', 'docs/mail-scaling.md'],
  },
  {
    id: 'redis-unavailable',
    dependency: 'redis',
    scenario: 'Redis is unavailable.',
    expected: 'No effect. There is no Redis in this deployment.',
    mustNot: 'Have a Redis dependency introduced without it being named here and in docs/mail-scaling.md.',
    status: 'implemented',
    gap: undefined,
    reproduce: 'Not applicable. This entry exists because §10 lists Redis, and the honest answer is that it is not part of the architecture: the queue is Postgres (edu_jobs) and there is no cache tier.',
    evidence: ['src/lib/job-queue.ts'],
  },
  {
    id: 'queue-unavailable',
    dependency: 'queue',
    scenario: 'The queue table cannot be written (disk full, permissions, table locked).',
    expected: 'Enqueue throws and the caller surfaces the failure to the user or to its own retry. The request that could not be queued is not reported as sent.',
    mustNot: 'Swallow the enqueue failure. A dropped enqueue is a message that will never be sent and that nothing will ever look for.',
    status: 'partial',
    gap: 'enqueue() propagates its error correctly, but not every call site treats a null return distinctly: null means "deduplicated, already queued" and a THROW means "not queued". Call sites that conflate them would report a dedup as a failure or vice versa.',
    reproduce: 'REVOKE INSERT ON edu_jobs FROM the application role in staging, then trigger a send.',
    evidence: ['src/lib/job-queue.ts enqueue()'],
  },
  {
    id: 'worker-crash',
    dependency: 'worker',
    scenario: 'A worker is killed between claiming a job and acknowledging it — serverless timeout, OOM, deploy mid-batch.',
    expected: 'The job returns to pending and is retried, with its attempt count already incremented so a job that repeatedly kills its worker eventually dead-letters instead of cycling forever.',
    mustNot: 'Leave the row in `processing` permanently, where no worker will claim it, no retry sweep will find it, and a health panel counts it as work in flight.',
    status: 'partial',
    gap: 'This is the real gap Patch 8 found. claimBatch() sets status=processing and NOTHING sets it back. reclaimStalled() in queue-observability.ts fixes it and the `stalled_messages` alert detects it, but reclamation is an OPERATOR ACTION on /admin/mail/performance, not automatic — the safe timeout depends on the longest legitimate job, which this code cannot know. Set it too low and a slow-but-working job is claimed twice.',
    reproduce: 'Claim a batch, kill the process before complete(), then read oldestProcessingAgeMs on /admin/mail/performance.',
    evidence: ['src/lib/job-queue.ts claimBatch()', 'src/lib/mailplatform/queue-observability.ts reclaimStalled()'],
  },
  {
    id: 'smtp-unavailable',
    dependency: 'smtp',
    scenario: 'The SMTP relay refuses connections or times out.',
    expected: 'The attempt is recorded as failed with the real reason, the job retries with exponential backoff (1s→5m cap), and the message stays queued. After max_attempts it dead-letters where an operator can see it.',
    mustNot: 'Mark the message sent. This has happened here: a failed external send left no email_logs row because the INSERT threw into an empty catch, and the UI showed delivery.',
    status: 'implemented',
    gap: undefined,
    reproduce: 'Point the SMTP host at a closed port on a staging deployment and send a test message from /admin/mail/health.',
    evidence: ['src/lib/mail-transport.ts sendExternal()', 'src/lib/job-queue.ts fail() + backoffMs()', 'src/lib/mail.ts logOutbound()'],
  },
  {
    id: 'smtp-deferral',
    dependency: 'smtp',
    scenario: 'A remote provider returns 4xx for every message — greylisting or rate limiting a campaign.',
    expected: 'Treated as a deferral: retried later, counted separately from failures, and never charged against the sending node\'s circuit breaker.',
    mustNot: 'Trip the breaker on the sending node. That would remove a healthy node from the pool because a THIRD PARTY was throttling, stopping delivery to every other domain at the same time.',
    status: 'implemented',
    gap: undefined,
    reproduce: 'Unit test: recordAttempt(health, "deferred", …) fifty times and assert the circuit stays closed.',
    evidence: ['src/lib/mailplatform/mta-pool.ts recordAttempt()', 'src/lib/mailplatform/mta-pool.test.ts'],
  },
  {
    id: 'mta-crash',
    dependency: 'mta',
    scenario: 'One MTA node dies mid-campaign.',
    expected: 'Its circuit opens after the failure threshold, the pool routes to the remaining nodes, and the dead node is probed once per cool-down until a success STREAK closes it again.',
    mustNot: 'Keep selecting the dead node because it is the least loaded — a dead node accepts and fails instantly, which makes it look idle.',
    status: 'implemented',
    gap: 'Implemented at the pool level and tested. There is only one node in this deployment today, so failover has nowhere to fail over TO: with one node the correct behaviour is to queue and retry, not to route around.',
    reproduce: 'Unit test "survives a node dying mid-campaign" in mta-pool.test.ts.',
    evidence: ['src/lib/mailplatform/mta-pool.ts selectNode()', 'src/lib/mailplatform/mta-pool.test.ts'],
  },
  {
    id: 'network-interruption',
    dependency: 'network',
    scenario: 'Network drops mid-delivery, after DATA and before the final 250.',
    expected: 'The attempt is recorded as failed and retried. Because the remote may or may not have accepted the message, the retry can duplicate.',
    mustNot: 'Assume non-delivery silently. Duplicate delivery is a real and accepted outcome of SMTP retry; what is unacceptable is not knowing it can happen.',
    status: 'partial',
    gap: 'SMTP cannot make delivery exactly-once — the protocol has no idempotency key. The queue is idempotent at ENQUEUE (dedup_key), which prevents the same send being queued twice; it cannot prevent a retry after an ambiguous failure. Message-ID plus recipient dedup at the receiving end is the only mitigation, and it is not implemented.',
    reproduce: 'Kill the connection during DATA against a local sink (Mailpit) and observe the retry.',
    evidence: ['src/lib/job-queue.ts dedupKey()', 'docs/mail-failure-modes.md'],
  },
  {
    id: 'supabase-api-interruption',
    dependency: 'supabase_api',
    scenario: 'The Supabase control-plane API is unavailable while the database itself is up.',
    expected: 'No effect on mail. Nothing in the send path calls the management API; the application connects to Postgres directly through the transaction pooler.',
    mustNot: 'Introduce a management-API call into a request path. It would add an availability dependency for something that never needs to be live.',
    status: 'implemented',
    gap: undefined,
    reproduce: 'Not directly reproducible; verified by the absence of any management-API client in the dependency list.',
    evidence: ['package.json (no @supabase/* client)', 'src/lib/db.ts'],
  },
  {
    id: 'vercel-api-failure',
    dependency: 'vercel_api',
    scenario: 'Vercel platform failure: functions not invoked, cron not fired, or a deploy fails.',
    expected: 'Queued work stays queued and drains when service returns — the queue is in Postgres, not in the platform. The `worker_failure` alert fires because work is waiting and nothing is completing.',
    mustNot: 'Lose queued messages, or report a healthy queue while nothing is draining it.',
    status: 'implemented',
    gap: 'Detection is implemented; there is no automatic failover, because there is one region and one platform. On the Hobby plan the cron is DAILY, so "nothing is draining the queue" is also the NORMAL state for most of the day — the alert threshold has to account for that or it will cry wolf. See bottleneckNotes() t1.',
    reproduce: 'Disable the cron in staging, enqueue jobs, and watch the alert fire on /admin/mail/performance.',
    evidence: ['src/lib/mailplatform/queue-observability.ts evaluateQueueAlerts()', 'src/lib/mailplatform/capacity.ts bottleneckNotes()'],
  },
  {
    id: 'storage-failure',
    dependency: 'storage',
    scenario: 'Object storage (attachments, exports) is unavailable.',
    expected: 'A send WITHOUT attachments is unaffected. A send WITH an attachment fails and retries; the message is not sent with the attachment silently missing.',
    mustNot: 'Deliver a message whose attachment could not be fetched, without saying so.',
    status: 'intended',
    gap: 'Not verified. Attachment handling in the current mail path stores a URL (src/lib/mail.ts mail_attachments.url) rather than fetching bytes at send time, so the failure surfaces at the RECIPIENT when they click a dead link — which is a worse failure mode than refusing to send, and it is not detected anywhere.',
    reproduce: 'Point the storage base URL at an unreachable host in staging and send a message with an attachment.',
    evidence: ['src/lib/mail.ts mail_attachments', 'docs/mail-failure-modes.md'],
  },
  {
    id: 'event-store-failure',
    dependency: 'database',
    scenario: 'The event store cannot be written while the send path is healthy.',
    expected: 'Mail keeps flowing. Events buffer in memory, are retried on the next flush, and are dropped oldest-first at a hard cap with the loss COUNTED.',
    mustNot: 'Block or fail a send because analytics could not be recorded, or grow a buffer until the process is OOM-killed.',
    status: 'implemented',
    gap: 'On serverless the process can freeze the moment a response is returned, so a buffered event may never flush at all. Flushing before responding trades latency for durability; a long-lived worker process removes the trade-off entirely.',
    reproduce: 'Unit test: EventBuffer against a sink that throws, then one that succeeds; assert nothing is lost and the buffer stays bounded.',
    evidence: ['src/lib/mailplatform/events.ts EventBuffer', 'src/lib/mailplatform/events.test.ts'],
  },
];

export function byDependency(dep: Dependency): FailureMode[] {
  return FAILURE_MODES.filter((f) => f.dependency === dep);
}

export function findFailureMode(id: string): FailureMode | null {
  return FAILURE_MODES.find((f) => f.id === id) ?? null;
}

/** The honest rollup: how much of §10 is actually built. Rendered on the performance screen. */
export function coverage(): { total: number; implemented: number; partial: number; intended: number; percentImplemented: number } {
  const total = FAILURE_MODES.length;
  const implemented = FAILURE_MODES.filter((f) => f.status === 'implemented').length;
  const partial = FAILURE_MODES.filter((f) => f.status === 'partial').length;
  const intended = FAILURE_MODES.filter((f) => f.status === 'intended').length;
  return { total, implemented, partial, intended, percentImplemented: total ? Math.round((implemented / total) * 100) : 0 };
}

/** Everything not fully implemented, worst first. This is the work list, not a status badge. */
export function openGaps(): FailureMode[] {
  const rank = { intended: 0, partial: 1, implemented: 2 } as const;
  return FAILURE_MODES.filter((f) => f.status !== 'implemented').sort((a, b) => rank[a.status] - rank[b.status]);
}
