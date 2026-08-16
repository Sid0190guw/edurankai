# Mail failure modes

> **Generated file — do not edit.** The source of truth is
> `src/lib/mailplatform/failure-modes.ts`, which is typed and asserted by tests
> (`analysis.test.ts` enforces that every entry which is not fully implemented names its
> gap). Regenerate with `npx tsx scripts/gen-failure-modes-doc.ts`.

The rule behind every entry below:

> **A dependency failure may DELAY mail or REFUSE mail. It must never silently lose mail,
> and it must never report a success it did not have.**

That second half is not hypothetical here. A send that failed at the SMTP layer once left
no trace at all, because the log INSERT threw into an empty catch — and the reading pane
claimed delivery. See the note in `src/lib/mail.ts` around `email_logs.rfc_message_id`.

## Coverage

| Status | Count |
| --- | --- |
| Implemented | 8 |
| Partial | 4 |
| Intended only | 1 |
| **Total** | **13** |

**62% fully implemented.** The remainder are listed with their gaps, and
are rendered as an open work list on `/admin/mail/performance`. A catalogue that flatters
itself is worse than no catalogue.

---

## Database

### `db-unavailable` — Postgres unreachable (pooler saturated, instance suspended, credentials rotated).

| | |
| --- | --- |
| Dependency | Database |
| Status | **Implemented** |

**Expected.** /api/health returns 503 so a monitor sees the outage in the status code. Admin pages render with a named read failure per panel rather than zeros. Sends fail loudly and are not acknowledged as accepted.

**Must not happen.** Report a healthy status, render "0 pending" for an unreadable queue, or accept a message it cannot persist.

**Reproduce.** Point DATABASE_URL at a closed port in a staging environment and load /api/health.

**Where it lives.** `src/pages/api/health.ts`, `src/lib/observability-health.ts quickHealth()`, `src/lib/mailplatform/queue-observability.ts unreadableSnapshot()`

### `db-slow` — Postgres reachable but slow — pool exhaustion, a long-running analytics query, autovacuum on a large table.

| | |
| --- | --- |
| Dependency | Database |
| Status | **Partial** |

**Expected.** Queue wait time rises and is visible as queue_wait_duration_ms; the pool panel shows connections climbing; the site stays up.

**Must not happen.** Let an analytics read block the send path. §6: analytics consumers must not block transactional workloads.

**Gap.** There is one connection pool for everything. A heavy analytics query and a send compete for the same pooler connections. Separation needs a second pool or a read replica — neither exists yet.

**Reproduce.** Run a deliberately expensive aggregate against mp_events while a load test sends, and watch pool saturation on /admin/mail/performance.

**Where it lives.** `src/lib/observability-health.ts poolSignals()`, `docs/mail-scaling.md`

### `event-store-failure` — The event store cannot be written while the send path is healthy.

| | |
| --- | --- |
| Dependency | Database |
| Status | **Implemented** |

**Expected.** Mail keeps flowing. Events buffer in memory, are retried on the next flush, and are dropped oldest-first at a hard cap with the loss COUNTED.

**Must not happen.** Block or fail a send because analytics could not be recorded, or grow a buffer until the process is OOM-killed.

**Gap.** On serverless the process can freeze the moment a response is returned, so a buffered event may never flush at all. Flushing before responding trades latency for durability; a long-lived worker process removes the trade-off entirely.

**Reproduce.** Unit test: EventBuffer against a sink that throws, then one that succeeds; assert nothing is lost and the buffer stays bounded.

**Where it lives.** `src/lib/mailplatform/events.ts EventBuffer`, `src/lib/mailplatform/events.test.ts`

---

## Redis

### `redis-unavailable` — Redis is unavailable.

| | |
| --- | --- |
| Dependency | Redis |
| Status | **Implemented** |

**Expected.** No effect. There is no Redis in this deployment.

**Must not happen.** Have a Redis dependency introduced without it being named here and in docs/mail-scaling.md.

**Reproduce.** Not applicable. This entry exists because §10 lists Redis, and the honest answer is that it is not part of the architecture: the queue is Postgres (edu_jobs) and there is no cache tier.

**Where it lives.** `src/lib/job-queue.ts`

---

## Queue

### `queue-unavailable` — The queue table cannot be written (disk full, permissions, table locked).

| | |
| --- | --- |
| Dependency | Queue |
| Status | **Partial** |

**Expected.** Enqueue throws and the caller surfaces the failure to the user or to its own retry. The request that could not be queued is not reported as sent.

**Must not happen.** Swallow the enqueue failure. A dropped enqueue is a message that will never be sent and that nothing will ever look for.

**Gap.** enqueue() propagates its error correctly, but not every call site treats a null return distinctly: null means "deduplicated, already queued" and a THROW means "not queued". Call sites that conflate them would report a dedup as a failure or vice versa.

**Reproduce.** REVOKE INSERT ON edu_jobs FROM the application role in staging, then trigger a send.

**Where it lives.** `src/lib/job-queue.ts enqueue()`

---

## Worker

### `worker-crash` — A worker is killed between claiming a job and acknowledging it — serverless timeout, OOM, deploy mid-batch.

| | |
| --- | --- |
| Dependency | Worker |
| Status | **Partial** |

**Expected.** The job returns to pending and is retried, with its attempt count already incremented so a job that repeatedly kills its worker eventually dead-letters instead of cycling forever.

**Must not happen.** Leave the row in `processing` permanently, where no worker will claim it, no retry sweep will find it, and a health panel counts it as work in flight.

**Gap.** This is the real gap Patch 8 found. claimBatch() sets status=processing and NOTHING sets it back. reclaimStalled() in queue-observability.ts fixes it and the `stalled_messages` alert detects it, but reclamation is an OPERATOR ACTION on /admin/mail/performance, not automatic — the safe timeout depends on the longest legitimate job, which this code cannot know. Set it too low and a slow-but-working job is claimed twice.

**Reproduce.** Claim a batch, kill the process before complete(), then read oldestProcessingAgeMs on /admin/mail/performance.

**Where it lives.** `src/lib/job-queue.ts claimBatch()`, `src/lib/mailplatform/queue-observability.ts reclaimStalled()`

---

## SMTP

### `smtp-unavailable` — The SMTP relay refuses connections or times out.

| | |
| --- | --- |
| Dependency | SMTP |
| Status | **Implemented** |

**Expected.** The attempt is recorded as failed with the real reason, the job retries with exponential backoff (1s→5m cap), and the message stays queued. After max_attempts it dead-letters where an operator can see it.

**Must not happen.** Mark the message sent. This has happened here: a failed external send left no email_logs row because the INSERT threw into an empty catch, and the UI showed delivery.

**Reproduce.** Point the SMTP host at a closed port on a staging deployment and send a test message from /admin/mail/health.

**Where it lives.** `src/lib/mail-transport.ts sendExternal()`, `src/lib/job-queue.ts fail() + backoffMs()`, `src/lib/mail.ts logOutbound()`

### `smtp-deferral` — A remote provider returns 4xx for every message — greylisting or rate limiting a campaign.

| | |
| --- | --- |
| Dependency | SMTP |
| Status | **Implemented** |

**Expected.** Treated as a deferral: retried later, counted separately from failures, and never charged against the sending node's circuit breaker.

**Must not happen.** Trip the breaker on the sending node. That would remove a healthy node from the pool because a THIRD PARTY was throttling, stopping delivery to every other domain at the same time.

**Reproduce.** Unit test: recordAttempt(health, "deferred", …) fifty times and assert the circuit stays closed.

**Where it lives.** `src/lib/mailplatform/mta-pool.ts recordAttempt()`, `src/lib/mailplatform/mta-pool.test.ts`

---

## MTA

### `mta-crash` — One MTA node dies mid-campaign.

| | |
| --- | --- |
| Dependency | MTA |
| Status | **Implemented** |

**Expected.** Its circuit opens after the failure threshold, the pool routes to the remaining nodes, and the dead node is probed once per cool-down until a success STREAK closes it again.

**Must not happen.** Keep selecting the dead node because it is the least loaded — a dead node accepts and fails instantly, which makes it look idle.

**Gap.** Implemented at the pool level and tested. There is only one node in this deployment today, so failover has nowhere to fail over TO: with one node the correct behaviour is to queue and retry, not to route around.

**Reproduce.** Unit test "survives a node dying mid-campaign" in mta-pool.test.ts.

**Where it lives.** `src/lib/mailplatform/mta-pool.ts selectNode()`, `src/lib/mailplatform/mta-pool.test.ts`

---

## Network

### `network-interruption` — Network drops mid-delivery, after DATA and before the final 250.

| | |
| --- | --- |
| Dependency | Network |
| Status | **Partial** |

**Expected.** The attempt is recorded as failed and retried. Because the remote may or may not have accepted the message, the retry can duplicate.

**Must not happen.** Assume non-delivery silently. Duplicate delivery is a real and accepted outcome of SMTP retry; what is unacceptable is not knowing it can happen.

**Gap.** SMTP cannot make delivery exactly-once — the protocol has no idempotency key. The queue is idempotent at ENQUEUE (dedup_key), which prevents the same send being queued twice; it cannot prevent a retry after an ambiguous failure. Message-ID plus recipient dedup at the receiving end is the only mitigation, and it is not implemented.

**Reproduce.** Kill the connection during DATA against a local sink (Mailpit) and observe the retry.

**Where it lives.** `src/lib/job-queue.ts dedupKey()`, `docs/mail-failure-modes.md`

---

## Supabase API

### `supabase-api-interruption` — The Supabase control-plane API is unavailable while the database itself is up.

| | |
| --- | --- |
| Dependency | Supabase API |
| Status | **Implemented** |

**Expected.** No effect on mail. Nothing in the send path calls the management API; the application connects to Postgres directly through the transaction pooler.

**Must not happen.** Introduce a management-API call into a request path. It would add an availability dependency for something that never needs to be live.

**Reproduce.** Not directly reproducible; verified by the absence of any management-API client in the dependency list.

**Where it lives.** `package.json (no @supabase/* client)`, `src/lib/db.ts`

---

## Vercel API

### `vercel-api-failure` — Vercel platform failure: functions not invoked, cron not fired, or a deploy fails.

| | |
| --- | --- |
| Dependency | Vercel API |
| Status | **Implemented** |

**Expected.** Queued work stays queued and drains when service returns — the queue is in Postgres, not in the platform. The `worker_failure` alert fires because work is waiting and nothing is completing.

**Must not happen.** Lose queued messages, or report a healthy queue while nothing is draining it.

**Gap.** Detection is implemented; there is no automatic failover, because there is one region and one platform. On the Hobby plan the cron is DAILY, so "nothing is draining the queue" is also the NORMAL state for most of the day — the alert threshold has to account for that or it will cry wolf. See bottleneckNotes() t1.

**Reproduce.** Disable the cron in staging, enqueue jobs, and watch the alert fire on /admin/mail/performance.

**Where it lives.** `src/lib/mailplatform/queue-observability.ts evaluateQueueAlerts()`, `src/lib/mailplatform/capacity.ts bottleneckNotes()`

---

## Storage

### `storage-failure` — Object storage (attachments, exports) is unavailable.

| | |
| --- | --- |
| Dependency | Storage |
| Status | **Intended only** |

**Expected.** A send WITHOUT attachments is unaffected. A send WITH an attachment fails and retries; the message is not sent with the attachment silently missing.

**Must not happen.** Deliver a message whose attachment could not be fetched, without saying so.

**Gap.** Not verified. Attachment handling in the current mail path stores a URL (src/lib/mail.ts mail_attachments.url) rather than fetching bytes at send time, so the failure surfaces at the RECIPIENT when they click a dead link — which is a worse failure mode than refusing to send, and it is not detected anywhere.

**Reproduce.** Point the storage base URL at an unreachable host in staging and send a message with an attachment.

**Where it lives.** `src/lib/mail.ts mail_attachments`, `docs/mail-failure-modes.md`

---

## Testing these

Failures that can be simulated in a unit test already are — deferrals not tripping the
circuit breaker, a node dying mid-campaign, the event buffer surviving a failing sink.
See `src/lib/mailplatform/mta-pool.test.ts` and `events.test.ts`.

Failures that need a real dependency (database down, SMTP refusing, storage unreachable)
are reproduced with the `Reproduce` line on each entry, **against staging with a throwaway
database**. Never against production, and never with a load generator pointed at anything
but a reserved test domain — `src/lib/mailplatform/loadgen.ts` throws rather than filtering
if you try.
