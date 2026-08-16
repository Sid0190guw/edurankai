# Mail disaster-recovery runbooks

<!-- GENERATED FILE. Do not edit by hand.
     Source: src/lib/mailops/runbooks.ts
     Regenerate: npx tsx scripts/mailops/generate-runbooks-doc.ts
     The same content renders on /admin/mail/continuity, which is where you should read it during an
     incident — this copy exists for the case where the admin console is the thing that is down. -->

Nine runbooks, six sections each, in the same order every time: **Detection, Containment, Recovery,
Verification, Rollback, Post-incident.** The section that gets dropped when runbooks are written as
prose is always Rollback, and it is the one you need most at the moment you need any of them.

Steps marked **[FOUNDER DECISION]** are hard or impossible to undo. There are 17 of them
across these runbooks, and they are the steps most likely to be taken quickly by somebody trying to
be helpful.

Two house rules these follow:

- **No step opens the production database.** Where a database action is genuinely required, the step
  hands over a command for a human to run.
- **Every Verification section checks a surface, not an exit code.** Reported success and observable
  result have diverged on this project often enough that it is a rule rather than a preference.

| Runbook | Trigger | Time |
| --- | --- | --- |
| [Mail host failure (the ZBook)](#mail-host-failure-the-zbook) | No mail has arrived for longer than usual, or the machine is off, asleep or elsewhere. | ~20 min |
| [Database failure](#database-failure) | /api/health returns 503, or every admin page errors at once. | ~45 min |
| [Mail server failure (MTA up but wrong, or not sending)](#mail-server-failure-mta-up-but-wrong-or-not-sending) | The host is reachable, the spool is not draining, or everything defers with the same SMTP code. | ~40 min |
| [DNS failure](#dns-failure) | Mail we send is being rejected or spam-filed, or nothing is arriving and the host is fine. | ~60 min |
| [Credential compromise](#credential-compromise) | A secret has been exposed: committed, pasted, logged, or on a lost machine. | ~90 min |
| [DKIM key compromise](#dkim-key-compromise) | A DKIM private key has been exposed, or is suspected to be. | ~120 min |
| [API compromise](#api-compromise) | An API key is being used by somebody who should not have it, or the mail API is being abused to send. | ~60 min |
| [Storage failure (object store, or the host disk)](#storage-failure-object-store-or-the-host-disk) | Attachments will not upload or download, or the mail host disk is failing. | ~60 min |
| [Queue failure (spool or job queue)](#queue-failure-spool-or-job-queue) | Mail is accepted but never leaves, or jobs pile up, or entries sit in sending/ forever. | ~30 min |

---

## Mail host failure (the ZBook)

**Trigger.** No mail has arrived for longer than usual, or the machine is off, asleep or elsewhere.

**Expect this to take about 20 minutes.**

> Inbound mail is not lost while the host is down — sending servers hold it and retry, typically for one to three days. Outbound already in the spool is on disk and survives. The clock you are racing is the SENDER's retry window, not ours.

### Detection

1. Confirm the host is actually unreachable rather than the app being down.

   ```
   curl -sS -o /dev/null -w "%{http_code}\n" https://www.edurankai.in/api/health
   ```

2. Try the mail host health endpoint from the same network.

   ```
   curl -sS http://<mail-host>:1082/healthz
   ```

3. Check whether anything was ever going to tell you.
   *Why:* Nothing polls the mail host today. If you are reading this because a person noticed, that is the current detection mechanism and it belongs in the post-incident actions.

### Containment

1. Stop anything that would enqueue large volumes — pause scheduled campaigns from /admin/mail.
   *Why:* A campaign that enqueues 5,000 messages into a spool nobody is draining turns a short outage into an hours-long drain afterwards, and into a deliverability problem when they all leave at once.

2. **[FOUNDER DECISION]** Do NOT repoint MX to anything else.
   *Why:* A secondary MX that cannot deliver onward only moves the queue from the sender's disk to ours. See the failure model: this is the specific pseudo-failover the design forbids.

### Recovery

1. Power on / wake the host and confirm the stack came back.

   ```
   docker compose ps
   ```

2. Reclaim any leases abandoned by the previous run.

   ```
   npx tsx scripts/mailops/spool-recover.ts --spool "$MAIL_SPOOL_DIR"
   ```
   *Why:* A worker killed mid-delivery leaves entries in sending/ holding a lease. They are not delivered and not queued until reclaim() moves them back.

3. Watch the spool drain rather than assuming it will.

   ```
   npx tsx scripts/mailops/spool-recover.ts --spool "$MAIL_SPOOL_DIR" --stats-only
   ```

### Verification

1. Send one message to an external address you control and confirm it ARRIVES. Not that the API returned 202.

2. Reply to it from outside and confirm it appears in the mailbox on /admin/mail.

3. Confirm the spool is draining: due count falling, dead-lettered count not climbing.

### Rollback

1. There is nothing to roll back — this is a restart, not a change.

2. If the host comes back but mail does not flow, do not start changing configuration. Go to rb-mail-server, which is written for exactly that state.

### Post-incident

1. Record the outage window and the spool depth at recovery on /admin/mail/continuity.
   *Why:* That pair is the only real measurement of what a host outage costs, and it is the input to the Phase-2 argument.

2. Count how many senders gave up. Any inbound you expected and never received is mail that was permanently lost by a sender with a short retry window.

3. **[FOUNDER DECISION]** If this is the second occurrence, the action is Phase 2, not another runbook rehearsal.

---

## Database failure

**Trigger.** /api/health returns 503, or every admin page errors at once.

**Expect this to take about 45 minutes.**

> The mail host does not hold a database client. Outbound sending keeps working through a database outage; what stops is filing inbound, delivery reporting and every screen. Inbound MUST be answered 4xx while this is true — a 2xx for a message that could not be filed is a permanently lost message.

### Detection

1. Check the health endpoint and read the reason it gives.

   ```
   curl -sS https://www.edurankai.in/api/health
   ```

2. Distinguish an outage from exhausted compute quota.
   *Why:* On a free tier these look identical from the application: every route 500s. The provider dashboard is the only place that tells them apart, and the fixes are completely different.

3. Check the provider status page before touching anything.

### Containment

1. Confirm the inbound endpoint is refusing with 4xx and not accepting.
   *Why:* Accepting mail we cannot file is the one action in this incident that causes permanent loss. Everything else is delay.

2. Pause scheduled sends. Campaign state lives in the database, so a partially recorded campaign is how a send repeats itself later.

3. Do not restart the app hoping it reconnects. It will reconnect on its own; a redeploy costs deploy budget and changes nothing.
   *Why:* The deploy ceiling is 100/day and burning it during an incident removes your rollback option later.

### Recovery

1. If the provider is down: wait, and keep the 4xx behaviour. There is no local fix.

2. **[FOUNDER DECISION]** If compute quota is exhausted: raise the plan on the dashboard. This is a founder decision, not an operator one.

3. If the database is lost rather than unavailable, this becomes a restore. Hand the restore command over — no process in this repository may run it.

   ```
   bash scripts/mailops/db-restore.sh --artefact <file> --target <scratch-url>   # refuses anything that looks like production
   ```

### Verification

1. Load /admin/mail/health and confirm the counters render real numbers rather than an error banner.

2. Confirm buffered delivery events have drained: the host outbox pending count should return to zero.

3. Send and receive one message end to end.

### Rollback

1. **[FOUNDER DECISION]** A restore is not reversible once traffic is pointed at the restored database. Take a dump of the DAMAGED database first, before restoring over anything.
   *Why:* A damaged database still contains rows the backup does not. Destroying it removes the only chance of recovering them.

2. Restoring code does not restore schema. Schema here self-bootstraps with ADD COLUMN IF NOT EXISTS and is forward-only.

### Post-incident

1. Record measured RPO and RTO from this event on /admin/mail/continuity. An incident is a free measurement and it is the only kind that is not a drill.

2. Count messages that were 4xx-refused during the window and confirm the senders retried successfully.

3. If a restore was needed and the newest verified backup was older than the RPO target, that is the finding — not the outage.

---

## Mail server failure (MTA up but wrong, or not sending)

**Trigger.** The host is reachable, the spool is not draining, or everything defers with the same SMTP code.

**Expect this to take about 40 minutes.**

> One code across every destination domain is a local fault. Different codes per domain is a reputation or content problem, and no amount of restarting fixes it.

### Detection

1. Read the spool stats and the last error on the oldest queued entry.

   ```
   npx tsx scripts/mailops/spool-recover.ts --spool "$MAIL_SPOOL_DIR" --stats-only
   ```

2. Group recent deferrals by SMTP code and by destination domain.
   *Why:* This one grouping answers "is it us or them" faster than any log read.

3. Check certificate expiry on the MTA. An expired cert produces a consistent, confusing failure that reads like a network problem.

### Containment

1. Leave the queue alone. Do not flush, do not requeue, do not delete.
   *Why:* Deferred mail is safe where it is. Requeueing during an incident is how one outage becomes a duplicate-delivery incident.

2. If the fault is outbound only, inbound is still working — do not restart the whole stack and take receiving down too.

### Recovery

1. Fix the specific fault the codes point at: certificate, relay credentials, blocked port 25, DNS resolution on the host.

2. If port 25 is blocked by the ISP (the usual answer on a domestic line), set a relay host rather than fighting it.

   ```
   MAIL_RELAY_HOST / MAIL_RELAY_PORT / MAIL_RELAY_USER in the engine environment
   ```

3. Restart only the service that was wrong.

### Verification

1. Confirm a real delivery to an external address, and that the delivered event carries a 2xx from the RECIPIENT's MX — not from the relay.
   *Why:* A relay accepting a message is not delivery. It can still dead-letter it minutes later.

2. Watch the deferred count fall over the next backoff interval. If it does not, the fix did not work regardless of what the logs said.

### Rollback

1. Keep the previous MTA config file. If the new one delivers worse, put the old one back and restart.

2. If you changed the relay, changing it back is safe — messages already accepted by the relay are gone either way.

### Post-incident

1. If it was certificate expiry, automate renewal. It will otherwise recur on a known date.

2. Record the drain time. It is the RTO measurement for outbound.

---

## DNS failure

**Trigger.** Mail we send is being rejected or spam-filed, or nothing is arriving and the host is fine.

**Expect this to take about 60 minutes.**

> DNS failures are slow both ways. A wrong record takes as long to fix as its TTL, and reputation damage from a broken SPF or DKIM record outlasts the fix by days.

### Detection

1. Verify what is actually published, from outside your own resolver.

   ```
   npx tsx scripts/mailops/dns-verify.ts --domain edurankai.in
   ```

2. Compare against what the platform expects — /admin/mail/health has the required-records list.

3. Check the registrar for an expired domain or a recently changed nameserver.

### Containment

1. **[FOUNDER DECISION]** Stop all bulk and campaign sending immediately.
   *Why:* Sending unauthenticated mail while SPF or DKIM is broken converts a configuration error into a reputation problem that takes days to recover from. This is the single most expensive mistake available during a DNS incident.

2. **[FOUNDER DECISION]** Transactional mail: decide explicitly whether it is worth the reputation risk. Usually yes for password resets, no for anything else.

### Recovery

1. Fix the record at the registrar by hand. Nothing in this system writes DNS automatically, and that is deliberate.

2. If a TTL was long, accept the wait. Republishing does not shorten propagation of the record people already cached.

### Verification

1. Re-run the verification from several resolvers, not just one.

   ```
   npx tsx scripts/mailops/dns-verify.ts --domain edurankai.in --resolvers 1.1.1.1,8.8.8.8,9.9.9.9
   ```

2. Send a test message to an external mailbox and read the Authentication-Results header on arrival. SPF, DKIM and DMARC must all say pass.
   *Why:* The record being present is not the same as it validating.

### Rollback

1. **[FOUNDER DECISION]** Keep the previous record value written down BEFORE editing. Registrar UIs do not have undo.

2. If the new record made delivery worse, restore the old value and wait out the TTL again. There is no faster path.

### Post-incident

1. Lower TTLs to 300 on mail records if a change is expected soon, and raise them back afterwards.

2. Add the record set to the scheduled verification so drift is caught before a customer notices.

---

## Credential compromise

**Trigger.** A secret has been exposed: committed, pasted, logged, or on a lost machine.

**Expect this to take about 90 minutes.**

> Rotation order matters. Rotate the credential first, then work out the blast radius. Investigating first leaves the door open while you read logs.

### Detection

1. Establish exactly which secret, and where it went. A secret in a private repository history is still compromised.

2. **[FOUNDER DECISION]** Check whether it is one of the encryption keys. Those cannot simply be rotated — data is encrypted under them.

### Containment

1. Rotate the credential now, in the provider that issues it.

2. For the mail inbound secret or the service-auth shared secret: rotate on both sides in the same change, app and mail host, or inbound breaks.

3. For an API key: revoke it rather than rotating, then issue a new one.

   ```
   Revoke from /admin (API keys are hashed at rest; the plaintext is not recoverable and does not need to be).
   ```

4. If a DKIM private key is involved, this is rb-dkim instead. Come back here afterwards.

### Recovery

1. Update every consumer. A rotated CRON_SECRET with whitespace in it fails every deploy in about two seconds — trim it.
   *Why:* That exact failure has happened on this project and cost a day.

2. Redeploy so the new value is live. Confirm the deploy actually promoted; pushed is not live.

### Verification

1. Confirm the old credential now FAILS. Try it. A rotation you have not tested against the old value is a rotation you have not done.

2. Confirm the new one works on the real surface: an inbound message files, a cron endpoint answers 200.

### Rollback

1. There is no rollback for a rotation, and there should not be. If the new secret broke something, fix forward with another new secret.

### Post-incident

1. Find how it leaked and close that path — a log line, a screenshot, a committed file, a shell history.

2. Audit for use of the old credential during the exposure window.

3. If it was in git history, the history still has it. Treat the secret as permanently burned regardless of any rewrite.

---

## DKIM key compromise

**Trigger.** A DKIM private key has been exposed, or is suspected to be.

**Expect this to take about 120 minutes.**

> Anyone holding this key can send mail that authenticates as this domain, and receivers will believe it. Publishing a new selector does not stop that — the OLD selector must be removed from DNS, and until it is, both keys are valid.

### Detection

1. Establish which selector and which domain.

2. List the selectors currently published.

   ```
   npx tsx scripts/mailops/dns-verify.ts --domain edurankai.in --dkim-selectors era1,era2
   ```

### Containment

1. Generate a new key under a NEW selector and publish it. Do not overwrite the old selector's record yet.
   *Why:* Overwriting first means mail signed with the old key and still in flight fails validation on arrival. Publish new, switch signing, then remove old.

2. Switch signing to the new selector and restart the signer.

### Recovery

1. Wait for mail signed under the old selector to clear — one full retry horizon, conservatively 24 hours.

2. **[FOUNDER DECISION]** REMOVE the old selector's DNS record. This is the step that actually revokes the compromised key, and it is the step most often skipped.

3. Destroy every copy of the old private key, including any in an escrow archive.

### Verification

1. Send to an external mailbox and confirm the Authentication-Results header shows dkim=pass with the NEW selector.

2. Query the old selector and confirm it no longer resolves.

3. Confirm nothing is still signing with the old key: no dkim-signature with the old selector in the last hour of delivery events.

### Rollback

1. **[FOUNDER DECISION]** Do not roll back to the compromised key under any circumstances. If the new key is broken, generate a third one.

2. If deliverability drops after the switch, the cause is almost always a malformed public-key record — check the TXT value length and any quoting the registrar added.

### Post-incident

1. Check whether anything was sent by the holder of the leaked key during the exposure window. DMARC aggregate reports are the only source, and if they are not configured, that is the finding.

2. Move the key material into a secret store. One unencrypted copy on one disk is how this happens.

---

## API compromise

**Trigger.** An API key is being used by somebody who should not have it, or the mail API is being abused to send.

**Expect this to take about 60 minutes.**

> The damage from a compromised mail API is not the data — it is the domain reputation burned by whatever was sent, and that outlives the incident by weeks.

### Detection

1. Look for the signature of abuse: a spike in accepted messages, unfamiliar recipient domains, unusual send times.

2. Identify which key. Keys are hashed at rest, so identify by prefix and label, not by value.

### Containment

1. Revoke the key immediately from the admin surface. Revocation takes effect on the next request.

2. **[FOUNDER DECISION]** Stop the queue draining if abusive mail is still spooled.
   *Why:* Messages already accepted are still on disk. Revoking the key does not unsend them; only stopping the worker does.

3. Delete abusive entries from the spool queued/ directory before restarting the worker. Keep a copy in failed/ as evidence.

### Recovery

1. Issue a replacement key to the legitimate integration.

2. Restart the worker and let genuine mail drain.

### Verification

1. Confirm requests with the old key are refused.

2. Confirm the spool contains no remaining entries from the abusive sender.

3. Check the bounce and complaint rate over the next 24 hours — that is where reputation damage shows up.

### Rollback

1. None. A revoked key stays revoked.

### Post-incident

1. Rate-limit per key if the abuse was volumetric. An unlimited key is an outage waiting for a leak.

2. If reputation was damaged, reduce sending volume deliberately for a period rather than pushing through it.

---

## Storage failure (object store, or the host disk)

**Trigger.** Attachments will not upload or download, or the mail host disk is failing.

**Expect this to take about 60 minutes.**

> Message text is in Postgres and is not affected. What is at risk is attachments, raw MIME, the maildir tree and the DKIM keys — and of those, only the first two have any second copy at all.

### Detection

1. Establish which storage: the object store (attachments) or the host disk (maildirs, keys, spool).

2. For the object store, check which backend is actually active. A backend that has quietly fallen back to in-memory loses everything on restart.

3. For the host disk, check SMART and free space. Nothing is watching either today.

### Containment

1. **[FOUNDER DECISION]** If the object store is down, make sends with attachments FAIL rather than send without them.
   *Why:* A message delivered with its attachment silently missing cannot be un-sent, and the recipient has no way to know something was removed.

2. **[FOUNDER DECISION]** If the host disk is failing, stop accepting new mail before it fills or dies mid-write. A refused connection is recoverable; a corrupt spool is not.

3. Copy the DKIM keys off the machine first, before anything else.
   *Why:* They are the only asset on that disk with no other copy and no way to regenerate without a DNS change and days of deliverability cost.

### Recovery

1. Object store: restore from a version or the second bucket. If neither exists, the objects are gone and the honest answer is to say so.

2. Host disk: replace it, restore the maildir tree from backup, restore the keys from escrow, recreate the spool empty.

3. **[FOUNDER DECISION]** Do NOT restore an old spool onto a new disk.
   *Why:* Those messages may already have been delivered. Restoring the spool re-sends them.

### Verification

1. Upload an attachment through the application and download it back.

2. Open a restored mailbox over IMAP and count messages against the pre-failure inventory.

3. Sign a message and confirm dkim=pass on arrival at an external mailbox.

### Rollback

1. **[FOUNDER DECISION]** Keep the failed disk. Do not wipe or return it until the restore has been verified.

### Post-incident

1. Enable bucket versioning. It is the cheapest single improvement available to this system.

2. Put the maildir tree into a scheduled backup. It is currently not backed up at all.

---

## Queue failure (spool or job queue)

**Trigger.** Mail is accepted but never leaves, or jobs pile up, or entries sit in sending/ forever.

**Expect this to take about 30 minutes.**

> Entries stuck in sending/ are not lost — they are holding an expired lease. reclaim() returns them. Entries in failed/ are dead-lettered and need a decision, not a retry loop.

### Detection

1. Read the spool stats. Separate DUE from DEFERRED — they mean opposite things.

   ```
   npx tsx scripts/mailops/spool-recover.ts --spool "$MAIL_SPOOL_DIR" --stats-only
   ```

2. Check whether anything is running the job queue at all.
   *Why:* On the current hosting the queue is drained by a once-daily cron unless the worker process on the mail host is running. A queue with no runner looks exactly like a queue with no work.

3. Check for incomplete writes in tmp/. Non-zero means a crash happened mid-enqueue.

### Containment

1. **[FOUNDER DECISION]** Do not delete queue entries to "clear" it. Every one of them is a message somebody was told we had.

2. If a poison job is consuming every worker slot, let it exhaust its attempts and land in failed. That is the design working.

### Recovery

1. Reclaim expired leases.

   ```
   npx tsx scripts/mailops/spool-recover.ts --spool "$MAIL_SPOOL_DIR"
   ```

2. Sweep incomplete writes older than an hour. Nothing in tmp/ was ever acknowledged, so this cannot lose an accepted message.

   ```
   npx tsx scripts/mailops/spool-recover.ts --spool "$MAIL_SPOOL_DIR" --sweep-tmp
   ```

3. Start the worker if it is not running.

4. **[FOUNDER DECISION]** Requeue dead-lettered entries only after establishing WHY they failed.

### Verification

1. Confirm the due count falls and the sent count rises. Both, not one.

2. Confirm no entry re-enters sending/ repeatedly — that is a delivery loop, and it means the worker is not reporting outcomes.

### Rollback

1. If a requeue caused duplicate deliveries, stop the worker before requeuing anything else, and count what went out. Duplicates cannot be recalled.

### Post-incident

1. If the cause was "nothing was draining the queue", the fix is running the worker as a service, not a bigger batch size.

2. Record the oldest-queued age at the moment of detection. It is the honest measure of how long this went unnoticed.

