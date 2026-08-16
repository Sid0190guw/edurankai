// src/lib/mailops/runbooks.ts — the nine disaster-recovery runbooks, as data.
//
// WHY DATA AND NOT A MARKDOWN FILE. Two reasons, both learned here.
//
// First, a runbook nobody can find at 2am is not a runbook. These render on /admin/mail/continuity,
// which is a page an operator already has open when things are wrong, rather than a file in a
// repository they would have to clone. The markdown version in docs/mail/ is generated from this
// module for the printable copy — one source, so the two cannot drift.
//
// Second, structure is the point. Every runbook has the same six sections in the same order, and
// the type system enforces that. The section that gets dropped when a runbook is written as prose
// is always the same one: ROLLBACK. Recovery steps are satisfying to write; "what to do when your
// fix made it worse" is not, and it is the section you need most at the moment you need any of it.
//
// HOUSE RULES THESE FOLLOW.
//   - No step tells the reader to connect to the production database. Where a database action is
//     genuinely required the step hands over the command for a human to run, which is the
//     established pattern on this project and exists because a subagent once read staff PII while
//     "surveying source files".
//   - "Reported success and observable result are not the same thing." Every VERIFICATION section
//     checks a surface, not an exit code.
//   - Steps say what is NOT true today where that is the case. A runbook that assumes monitoring
//     nobody configured wastes the first ten minutes of an incident.

export type RunbookSection =
  | 'detection'
  | 'containment'
  | 'recovery'
  | 'verification'
  | 'rollback'
  | 'post_incident';

export interface RunbookStep {
  /** What to do. Imperative, one action. */
  do: string;
  /** A command where one exists. Never a command that opens the production database. */
  command?: string;
  /** Why this step, when the reason is not obvious or when skipping it is tempting. */
  why?: string;
  /** True when this step needs a decision from the founder rather than an operator. */
  decision?: boolean;
}

export interface Runbook {
  id: string;
  title: string;
  /** The symptom that sends someone here. Written as the thing they observed, not the diagnosis. */
  trigger: string;
  /** Rough minutes, so the reader knows whether to start it or escalate first. */
  expectedMinutes: number;
  /** The one sentence that most often saves time on this incident. */
  keyFact: string;
  sections: Record<RunbookSection, RunbookStep[]>;
}

const SECTION_ORDER: RunbookSection[] = ['detection', 'containment', 'recovery', 'verification', 'rollback', 'post_incident'];

export const SECTION_LABELS: Record<RunbookSection, string> = {
  detection: 'Detection',
  containment: 'Containment',
  recovery: 'Recovery',
  verification: 'Verification',
  rollback: 'Rollback',
  post_incident: 'Post-incident',
};

export const RUNBOOKS: readonly Runbook[] = [
  {
    id: 'rb-zbook',
    title: 'Mail host failure (the ZBook)',
    trigger: 'No mail has arrived for longer than usual, or the machine is off, asleep or elsewhere.',
    expectedMinutes: 20,
    keyFact:
      'Inbound mail is not lost while the host is down — sending servers hold it and retry, typically for one to three days. Outbound already in the spool is on disk and survives. The clock you are racing is the SENDER\'s retry window, not ours.',
    sections: {
      detection: [
        { do: 'Confirm the host is actually unreachable rather than the app being down.', command: 'curl -sS -o /dev/null -w "%{http_code}\\n" https://www.edurankai.in/api/health' },
        { do: 'Try the mail host health endpoint from the same network.', command: 'curl -sS http://<mail-host>:1082/healthz' },
        { do: 'Check whether anything was ever going to tell you.', why: 'Nothing polls the mail host today. If you are reading this because a person noticed, that is the current detection mechanism and it belongs in the post-incident actions.' },
      ],
      containment: [
        { do: 'Stop anything that would enqueue large volumes — pause scheduled campaigns from /admin/mail.', why: 'A campaign that enqueues 5,000 messages into a spool nobody is draining turns a short outage into an hours-long drain afterwards, and into a deliverability problem when they all leave at once.' },
        { do: 'Do NOT repoint MX to anything else.', why: 'A secondary MX that cannot deliver onward only moves the queue from the sender\'s disk to ours. See the failure model: this is the specific pseudo-failover the design forbids.', decision: true },
      ],
      recovery: [
        { do: 'Power on / wake the host and confirm the stack came back.', command: 'docker compose ps' },
        { do: 'Reclaim any leases abandoned by the previous run.', command: 'npx tsx scripts/mailops/spool-recover.ts --spool "$MAIL_SPOOL_DIR"', why: 'A worker killed mid-delivery leaves entries in sending/ holding a lease. They are not delivered and not queued until reclaim() moves them back.' },
        { do: 'Watch the spool drain rather than assuming it will.', command: 'npx tsx scripts/mailops/spool-recover.ts --spool "$MAIL_SPOOL_DIR" --stats-only' },
      ],
      verification: [
        { do: 'Send one message to an external address you control and confirm it ARRIVES. Not that the API returned 202.' },
        { do: 'Reply to it from outside and confirm it appears in the mailbox on /admin/mail.' },
        { do: 'Confirm the spool is draining: due count falling, dead-lettered count not climbing.' },
      ],
      rollback: [
        { do: 'There is nothing to roll back — this is a restart, not a change.' },
        { do: 'If the host comes back but mail does not flow, do not start changing configuration. Go to rb-mail-server, which is written for exactly that state.' },
      ],
      post_incident: [
        { do: 'Record the outage window and the spool depth at recovery on /admin/mail/continuity.', why: 'That pair is the only real measurement of what a host outage costs, and it is the input to the Phase-2 argument.' },
        { do: 'Count how many senders gave up. Any inbound you expected and never received is mail that was permanently lost by a sender with a short retry window.' },
        { do: 'If this is the second occurrence, the action is Phase 2, not another runbook rehearsal.', decision: true },
      ],
    },
  },
  {
    id: 'rb-database',
    title: 'Database failure',
    trigger: '/api/health returns 503, or every admin page errors at once.',
    expectedMinutes: 45,
    keyFact:
      'The mail host does not hold a database client. Outbound sending keeps working through a database outage; what stops is filing inbound, delivery reporting and every screen. Inbound MUST be answered 4xx while this is true — a 2xx for a message that could not be filed is a permanently lost message.',
    sections: {
      detection: [
        { do: 'Check the health endpoint and read the reason it gives.', command: 'curl -sS https://www.edurankai.in/api/health' },
        { do: 'Distinguish an outage from exhausted compute quota.', why: 'On a free tier these look identical from the application: every route 500s. The provider dashboard is the only place that tells them apart, and the fixes are completely different.' },
        { do: 'Check the provider status page before touching anything.' },
      ],
      containment: [
        { do: 'Confirm the inbound endpoint is refusing with 4xx and not accepting.', why: 'Accepting mail we cannot file is the one action in this incident that causes permanent loss. Everything else is delay.' },
        { do: 'Pause scheduled sends. Campaign state lives in the database, so a partially recorded campaign is how a send repeats itself later.' },
        { do: 'Do not restart the app hoping it reconnects. It will reconnect on its own; a redeploy costs deploy budget and changes nothing.', why: 'The deploy ceiling is 100/day and burning it during an incident removes your rollback option later.' },
      ],
      recovery: [
        { do: 'If the provider is down: wait, and keep the 4xx behaviour. There is no local fix.' },
        { do: 'If compute quota is exhausted: raise the plan on the dashboard. This is a founder decision, not an operator one.', decision: true },
        { do: 'If the database is lost rather than unavailable, this becomes a restore. Hand the restore command over — no process in this repository may run it.', command: 'bash scripts/mailops/db-restore.sh --artefact <file> --target <scratch-url>   # refuses anything that looks like production' },
      ],
      verification: [
        { do: 'Load /admin/mail/health and confirm the counters render real numbers rather than an error banner.' },
        { do: 'Confirm buffered delivery events have drained: the host outbox pending count should return to zero.' },
        { do: 'Send and receive one message end to end.' },
      ],
      rollback: [
        { do: 'A restore is not reversible once traffic is pointed at the restored database. Take a dump of the DAMAGED database first, before restoring over anything.', why: 'A damaged database still contains rows the backup does not. Destroying it removes the only chance of recovering them.', decision: true },
        { do: 'Restoring code does not restore schema. Schema here self-bootstraps with ADD COLUMN IF NOT EXISTS and is forward-only.' },
      ],
      post_incident: [
        { do: 'Record measured RPO and RTO from this event on /admin/mail/continuity. An incident is a free measurement and it is the only kind that is not a drill.' },
        { do: 'Count messages that were 4xx-refused during the window and confirm the senders retried successfully.' },
        { do: 'If a restore was needed and the newest verified backup was older than the RPO target, that is the finding — not the outage.' },
      ],
    },
  },
  {
    id: 'rb-mail-server',
    title: 'Mail server failure (MTA up but wrong, or not sending)',
    trigger: 'The host is reachable, the spool is not draining, or everything defers with the same SMTP code.',
    expectedMinutes: 40,
    keyFact:
      'One code across every destination domain is a local fault. Different codes per domain is a reputation or content problem, and no amount of restarting fixes it.',
    sections: {
      detection: [
        { do: 'Read the spool stats and the last error on the oldest queued entry.', command: 'npx tsx scripts/mailops/spool-recover.ts --spool "$MAIL_SPOOL_DIR" --stats-only' },
        { do: 'Group recent deferrals by SMTP code and by destination domain.', why: 'This one grouping answers "is it us or them" faster than any log read.' },
        { do: 'Check certificate expiry on the MTA. An expired cert produces a consistent, confusing failure that reads like a network problem.' },
      ],
      containment: [
        { do: 'Leave the queue alone. Do not flush, do not requeue, do not delete.', why: 'Deferred mail is safe where it is. Requeueing during an incident is how one outage becomes a duplicate-delivery incident.' },
        { do: 'If the fault is outbound only, inbound is still working — do not restart the whole stack and take receiving down too.' },
      ],
      recovery: [
        { do: 'Fix the specific fault the codes point at: certificate, relay credentials, blocked port 25, DNS resolution on the host.' },
        { do: 'If port 25 is blocked by the ISP (the usual answer on a domestic line), set a relay host rather than fighting it.', command: 'MAIL_RELAY_HOST / MAIL_RELAY_PORT / MAIL_RELAY_USER in the engine environment' },
        { do: 'Restart only the service that was wrong.' },
      ],
      verification: [
        { do: 'Confirm a real delivery to an external address, and that the delivered event carries a 2xx from the RECIPIENT\'s MX — not from the relay.', why: 'A relay accepting a message is not delivery. It can still dead-letter it minutes later.' },
        { do: 'Watch the deferred count fall over the next backoff interval. If it does not, the fix did not work regardless of what the logs said.' },
      ],
      rollback: [
        { do: 'Keep the previous MTA config file. If the new one delivers worse, put the old one back and restart.' },
        { do: 'If you changed the relay, changing it back is safe — messages already accepted by the relay are gone either way.' },
      ],
      post_incident: [
        { do: 'If it was certificate expiry, automate renewal. It will otherwise recur on a known date.' },
        { do: 'Record the drain time. It is the RTO measurement for outbound.' },
      ],
    },
  },
  {
    id: 'rb-dns',
    title: 'DNS failure',
    trigger: 'Mail we send is being rejected or spam-filed, or nothing is arriving and the host is fine.',
    expectedMinutes: 60,
    keyFact:
      'DNS failures are slow both ways. A wrong record takes as long to fix as its TTL, and reputation damage from a broken SPF or DKIM record outlasts the fix by days.',
    sections: {
      detection: [
        { do: 'Verify what is actually published, from outside your own resolver.', command: 'npx tsx scripts/mailops/dns-verify.ts --domain edurankai.in' },
        { do: 'Compare against what the platform expects — /admin/mail/health has the required-records list.' },
        { do: 'Check the registrar for an expired domain or a recently changed nameserver.' },
      ],
      containment: [
        { do: 'Stop all bulk and campaign sending immediately.', why: 'Sending unauthenticated mail while SPF or DKIM is broken converts a configuration error into a reputation problem that takes days to recover from. This is the single most expensive mistake available during a DNS incident.', decision: true },
        { do: 'Transactional mail: decide explicitly whether it is worth the reputation risk. Usually yes for password resets, no for anything else.', decision: true },
      ],
      recovery: [
        { do: 'Fix the record at the registrar by hand. Nothing in this system writes DNS automatically, and that is deliberate.' },
        { do: 'If a TTL was long, accept the wait. Republishing does not shorten propagation of the record people already cached.' },
      ],
      verification: [
        { do: 'Re-run the verification from several resolvers, not just one.', command: 'npx tsx scripts/mailops/dns-verify.ts --domain edurankai.in --resolvers 1.1.1.1,8.8.8.8,9.9.9.9' },
        { do: 'Send a test message to an external mailbox and read the Authentication-Results header on arrival. SPF, DKIM and DMARC must all say pass.', why: 'The record being present is not the same as it validating.' },
      ],
      rollback: [
        { do: 'Keep the previous record value written down BEFORE editing. Registrar UIs do not have undo.', decision: true },
        { do: 'If the new record made delivery worse, restore the old value and wait out the TTL again. There is no faster path.' },
      ],
      post_incident: [
        { do: 'Lower TTLs to 300 on mail records if a change is expected soon, and raise them back afterwards.' },
        { do: 'Add the record set to the scheduled verification so drift is caught before a customer notices.' },
      ],
    },
  },
  {
    id: 'rb-credentials',
    title: 'Credential compromise',
    trigger: 'A secret has been exposed: committed, pasted, logged, or on a lost machine.',
    expectedMinutes: 90,
    keyFact:
      'Rotation order matters. Rotate the credential first, then work out the blast radius. Investigating first leaves the door open while you read logs.',
    sections: {
      detection: [
        { do: 'Establish exactly which secret, and where it went. A secret in a private repository history is still compromised.' },
        { do: 'Check whether it is one of the encryption keys. Those cannot simply be rotated — data is encrypted under them.', decision: true },
      ],
      containment: [
        { do: 'Rotate the credential now, in the provider that issues it.' },
        { do: 'For the mail inbound secret or the service-auth shared secret: rotate on both sides in the same change, app and mail host, or inbound breaks.' },
        { do: 'For an API key: revoke it rather than rotating, then issue a new one.', command: 'Revoke from /admin (API keys are hashed at rest; the plaintext is not recoverable and does not need to be).' },
        { do: 'If a DKIM private key is involved, this is rb-dkim instead. Come back here afterwards.' },
      ],
      recovery: [
        { do: 'Update every consumer. A rotated CRON_SECRET with whitespace in it fails every deploy in about two seconds — trim it.', why: 'That exact failure has happened on this project and cost a day.' },
        { do: 'Redeploy so the new value is live. Confirm the deploy actually promoted; pushed is not live.' },
      ],
      verification: [
        { do: 'Confirm the old credential now FAILS. Try it. A rotation you have not tested against the old value is a rotation you have not done.' },
        { do: 'Confirm the new one works on the real surface: an inbound message files, a cron endpoint answers 200.' },
      ],
      rollback: [
        { do: 'There is no rollback for a rotation, and there should not be. If the new secret broke something, fix forward with another new secret.' },
      ],
      post_incident: [
        { do: 'Find how it leaked and close that path — a log line, a screenshot, a committed file, a shell history.' },
        { do: 'Audit for use of the old credential during the exposure window.' },
        { do: 'If it was in git history, the history still has it. Treat the secret as permanently burned regardless of any rewrite.' },
      ],
    },
  },
  {
    id: 'rb-dkim',
    title: 'DKIM key compromise',
    trigger: 'A DKIM private key has been exposed, or is suspected to be.',
    expectedMinutes: 120,
    keyFact:
      'Anyone holding this key can send mail that authenticates as this domain, and receivers will believe it. Publishing a new selector does not stop that — the OLD selector must be removed from DNS, and until it is, both keys are valid.',
    sections: {
      detection: [
        { do: 'Establish which selector and which domain.' },
        { do: 'List the selectors currently published.', command: 'npx tsx scripts/mailops/dns-verify.ts --domain edurankai.in --dkim-selectors era1,era2' },
      ],
      containment: [
        { do: 'Generate a new key under a NEW selector and publish it. Do not overwrite the old selector\'s record yet.', why: 'Overwriting first means mail signed with the old key and still in flight fails validation on arrival. Publish new, switch signing, then remove old.' },
        { do: 'Switch signing to the new selector and restart the signer.' },
      ],
      recovery: [
        { do: 'Wait for mail signed under the old selector to clear — one full retry horizon, conservatively 24 hours.' },
        { do: 'REMOVE the old selector\'s DNS record. This is the step that actually revokes the compromised key, and it is the step most often skipped.', decision: true },
        { do: 'Destroy every copy of the old private key, including any in an escrow archive.' },
      ],
      verification: [
        { do: 'Send to an external mailbox and confirm the Authentication-Results header shows dkim=pass with the NEW selector.' },
        { do: 'Query the old selector and confirm it no longer resolves.' },
        { do: 'Confirm nothing is still signing with the old key: no dkim-signature with the old selector in the last hour of delivery events.' },
      ],
      rollback: [
        { do: 'Do not roll back to the compromised key under any circumstances. If the new key is broken, generate a third one.', decision: true },
        { do: 'If deliverability drops after the switch, the cause is almost always a malformed public-key record — check the TXT value length and any quoting the registrar added.' },
      ],
      post_incident: [
        { do: 'Check whether anything was sent by the holder of the leaked key during the exposure window. DMARC aggregate reports are the only source, and if they are not configured, that is the finding.' },
        { do: 'Move the key material into a secret store. One unencrypted copy on one disk is how this happens.' },
      ],
    },
  },
  {
    id: 'rb-api',
    title: 'API compromise',
    trigger: 'An API key is being used by somebody who should not have it, or the mail API is being abused to send.',
    expectedMinutes: 60,
    keyFact:
      'The damage from a compromised mail API is not the data — it is the domain reputation burned by whatever was sent, and that outlives the incident by weeks.',
    sections: {
      detection: [
        { do: 'Look for the signature of abuse: a spike in accepted messages, unfamiliar recipient domains, unusual send times.' },
        { do: 'Identify which key. Keys are hashed at rest, so identify by prefix and label, not by value.' },
      ],
      containment: [
        { do: 'Revoke the key immediately from the admin surface. Revocation takes effect on the next request.' },
        { do: 'Stop the queue draining if abusive mail is still spooled.', why: 'Messages already accepted are still on disk. Revoking the key does not unsend them; only stopping the worker does.', decision: true },
        { do: 'Delete abusive entries from the spool queued/ directory before restarting the worker. Keep a copy in failed/ as evidence.' },
      ],
      recovery: [
        { do: 'Issue a replacement key to the legitimate integration.' },
        { do: 'Restart the worker and let genuine mail drain.' },
      ],
      verification: [
        { do: 'Confirm requests with the old key are refused.' },
        { do: 'Confirm the spool contains no remaining entries from the abusive sender.' },
        { do: 'Check the bounce and complaint rate over the next 24 hours — that is where reputation damage shows up.' },
      ],
      rollback: [
        { do: 'None. A revoked key stays revoked.' },
      ],
      post_incident: [
        { do: 'Rate-limit per key if the abuse was volumetric. An unlimited key is an outage waiting for a leak.' },
        { do: 'If reputation was damaged, reduce sending volume deliberately for a period rather than pushing through it.' },
      ],
    },
  },
  {
    id: 'rb-storage',
    title: 'Storage failure (object store, or the host disk)',
    trigger: 'Attachments will not upload or download, or the mail host disk is failing.',
    expectedMinutes: 60,
    keyFact:
      'Message text is in Postgres and is not affected. What is at risk is attachments, raw MIME, the maildir tree and the DKIM keys — and of those, only the first two have any second copy at all.',
    sections: {
      detection: [
        { do: 'Establish which storage: the object store (attachments) or the host disk (maildirs, keys, spool).' },
        { do: 'For the object store, check which backend is actually active. A backend that has quietly fallen back to in-memory loses everything on restart.' },
        { do: 'For the host disk, check SMART and free space. Nothing is watching either today.' },
      ],
      containment: [
        { do: 'If the object store is down, make sends with attachments FAIL rather than send without them.', why: 'A message delivered with its attachment silently missing cannot be un-sent, and the recipient has no way to know something was removed.', decision: true },
        { do: 'If the host disk is failing, stop accepting new mail before it fills or dies mid-write. A refused connection is recoverable; a corrupt spool is not.', decision: true },
        { do: 'Copy the DKIM keys off the machine first, before anything else.', why: 'They are the only asset on that disk with no other copy and no way to regenerate without a DNS change and days of deliverability cost.' },
      ],
      recovery: [
        { do: 'Object store: restore from a version or the second bucket. If neither exists, the objects are gone and the honest answer is to say so.' },
        { do: 'Host disk: replace it, restore the maildir tree from backup, restore the keys from escrow, recreate the spool empty.' },
        { do: 'Do NOT restore an old spool onto a new disk.', why: 'Those messages may already have been delivered. Restoring the spool re-sends them.', decision: true },
      ],
      verification: [
        { do: 'Upload an attachment through the application and download it back.' },
        { do: 'Open a restored mailbox over IMAP and count messages against the pre-failure inventory.' },
        { do: 'Sign a message and confirm dkim=pass on arrival at an external mailbox.' },
      ],
      rollback: [
        { do: 'Keep the failed disk. Do not wipe or return it until the restore has been verified.', decision: true },
      ],
      post_incident: [
        { do: 'Enable bucket versioning. It is the cheapest single improvement available to this system.' },
        { do: 'Put the maildir tree into a scheduled backup. It is currently not backed up at all.' },
      ],
    },
  },
  {
    id: 'rb-queue',
    title: 'Queue failure (spool or job queue)',
    trigger: 'Mail is accepted but never leaves, or jobs pile up, or entries sit in sending/ forever.',
    expectedMinutes: 30,
    keyFact:
      'Entries stuck in sending/ are not lost — they are holding an expired lease. reclaim() returns them. Entries in failed/ are dead-lettered and need a decision, not a retry loop.',
    sections: {
      detection: [
        { do: 'Read the spool stats. Separate DUE from DEFERRED — they mean opposite things.', command: 'npx tsx scripts/mailops/spool-recover.ts --spool "$MAIL_SPOOL_DIR" --stats-only' },
        { do: 'Check whether anything is running the job queue at all.', why: 'On the current hosting the queue is drained by a once-daily cron unless the worker process on the mail host is running. A queue with no runner looks exactly like a queue with no work.' },
        { do: 'Check for incomplete writes in tmp/. Non-zero means a crash happened mid-enqueue.' },
      ],
      containment: [
        { do: 'Do not delete queue entries to "clear" it. Every one of them is a message somebody was told we had.', decision: true },
        { do: 'If a poison job is consuming every worker slot, let it exhaust its attempts and land in failed. That is the design working.' },
      ],
      recovery: [
        { do: 'Reclaim expired leases.', command: 'npx tsx scripts/mailops/spool-recover.ts --spool "$MAIL_SPOOL_DIR"' },
        { do: 'Sweep incomplete writes older than an hour. Nothing in tmp/ was ever acknowledged, so this cannot lose an accepted message.', command: 'npx tsx scripts/mailops/spool-recover.ts --spool "$MAIL_SPOOL_DIR" --sweep-tmp' },
        { do: 'Start the worker if it is not running.' },
        { do: 'Requeue dead-lettered entries only after establishing WHY they failed.', decision: true },
      ],
      verification: [
        { do: 'Confirm the due count falls and the sent count rises. Both, not one.' },
        { do: 'Confirm no entry re-enters sending/ repeatedly — that is a delivery loop, and it means the worker is not reporting outcomes.' },
      ],
      rollback: [
        { do: 'If a requeue caused duplicate deliveries, stop the worker before requeuing anything else, and count what went out. Duplicates cannot be recalled.' },
      ],
      post_incident: [
        { do: 'If the cause was "nothing was draining the queue", the fix is running the worker as a service, not a bigger batch size.' },
        { do: 'Record the oldest-queued age at the moment of detection. It is the honest measure of how long this went unnoticed.' },
      ],
    },
  },
] as const;

export function runbook(id: string): Runbook | undefined {
  return RUNBOOKS.find((r) => r.id === id);
}

export function orderedSections(rb: Runbook): { section: RunbookSection; label: string; steps: RunbookStep[] }[] {
  return SECTION_ORDER.map((section) => ({ section, label: SECTION_LABELS[section], steps: rb.sections[section] }));
}

/**
 * Steps that need the founder rather than an operator.
 *
 * Surfaced separately because the expensive mistakes in this list are all decisions — repointing
 * MX, restoring over a damaged database, deleting spool entries, keeping a failed disk — and they
 * are the steps most likely to be taken quickly by somebody trying to be helpful.
 */
export function decisionPoints(rb: Runbook): { section: RunbookSection; step: RunbookStep }[] {
  return SECTION_ORDER.flatMap((section) =>
    rb.sections[section].filter((s) => s.decision).map((step) => ({ section, step })),
  );
}

/** Render one runbook as markdown, so docs/ and the admin screen cannot drift apart. */
export function toMarkdown(rb: Runbook): string {
  const lines: string[] = [];
  lines.push(`## ${rb.title}`, '');
  lines.push(`**Trigger.** ${rb.trigger}`, '');
  lines.push(`**Expect this to take about ${rb.expectedMinutes} minutes.**`, '');
  lines.push(`> ${rb.keyFact}`, '');
  for (const { label, steps } of orderedSections(rb)) {
    lines.push(`### ${label}`, '');
    steps.forEach((s, i) => {
      lines.push(`${i + 1}. ${s.decision ? '**[FOUNDER DECISION]** ' : ''}${s.do}`);
      if (s.command) lines.push('', '   ```', `   ${s.command}`, '   ```');
      if (s.why) lines.push(`   *Why:* ${s.why}`);
      lines.push('');
    });
  }
  return lines.join('\n');
}

export function allRunbooksMarkdown(): string {
  return RUNBOOKS.map(toMarkdown).join('\n---\n\n');
}
