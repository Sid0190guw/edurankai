# Migration verification, gates and cutover

The companion to [MIGRATION.md](MIGRATION.md). That document says **how to move** each part of the
system. This one says **how to know the move worked**, and what is not allowed to happen until it
has been shown to.

Plans, gates and comparison arithmetic: `src/lib/mailops/migration.ts`, rendered on
`/admin/mail/continuity`. Tooling: `scripts/mailops/`. The founder runs all of it — nothing in this
repository opens the production database.

---

## The rule everything here serves

> **Do not destroy the original until verification succeeds.**

`decommissionAllowed()` is the only function in the codebase that returns permission to delete
anything, and it requires three independent conditions:

1. **A passed verification report** — the copy is correct.
2. **The soak period elapsed** — the copy is correct *in production*, for days, under real load.
3. **A typed confirmation phrase** — the name of the thing being destroyed, not a checkbox.

Each of those has failed on its own somewhere. It is always cheaper to keep an old database running
for a month than to explain why a mailbox is empty.

| Migration | Gated on | Soak |
| --- | --- | --- |
| ZBook → dedicated | messages, mailboxes, folders, flags, attachments | 14 days |
| One node → several | messages, delivery events | 7 days |
| Supabase → self-hosted PG | messages, mailboxes, contacts, campaigns, templates, domains, delivery events, automations | 30 days |
| Storage → S3-compatible | objects, bytes | 30 days |
| Local MTA → dedicated | delivery events | 30 days |
| One MTA → cluster | delivery events | 14 days |

---

## The failure this exists to catch

Somebody runs the copy, sees no errors, cuts over, and finds three days later that a table, a folder
or a set of flags did not come across.

`rsync` exiting 0 is a statement about rsync. `pg_restore` exiting 0 is a statement about
pg_restore. Neither is a statement about what is in the target. So every migration ends in an
**independent count of both sides**, compared by a tool that does not know how the copy was made:

```bash
npx tsx scripts/mailops/migration-report.ts \
  --source inv-old.json --target inv-new.json \
  --migration zbook-to-dedicated
```

Exit 0 means the report passed **and** the cutover gate allows it, so this can gate a cutover script
rather than being read and forgotten. `--markdown out.md` writes the report for the record;
`--report-to <base-url>` files it against the continuity ledger.

### Inventory format

```json
{
  "label": "ZBook maildirs",
  "takenAt": "2026-08-16T09:00:00Z",
  "counts": { "messages": 12043, "mailboxes": 7, "folders": 41, "flags": 9021, "attachments": 318 },
  "perMailbox": { "sid@edurankai.in": { "messages": 8021, "folders": 12 } },
  "sampleChecksums": { "sid/INBOX/1234.eml": "sha256:…" }
}
```

Produced by `mailbox-migrate.sh --mode inventory`, `db-migrate.sh --stage inventory` and
`storage-migrate.sh --verify`.

### What the comparison catches that a single count does not

- **A per-mailbox loss hidden by a matching global total.** 100 messages on each side, but one
  mailbox gained 40 and another lost 40.
- **An uncounted entity.** If the target inventory never counted folders, that is `missing-data` and
  it **fails**. An unverified count is not a passed check, and treating an absent number as a match
  is how a migration passes having lost every folder.
- **A target with more than the source.** Usually a copy that ran twice — and for messages that
  means recipients see duplicates.
- **Content differing while counts agree.** Sampled checksums; a truncated object still counts as
  one object.

### Tolerances, and why they are not zero everywhere

An online copy of a live system legitimately shows a few more messages and delivery events on the
source, because mail kept arriving while the copy ran. Tolerances of 50 messages and 500 delivery
events exist for exactly that. Zero there would make every honest migration look failed, which
trains people to ignore the report.

**There is no tolerance for a shortfall in mailboxes, folders, flags, attachments, contacts or
templates.** Fewer of any of those on the target means something did not come across.

---

## Mailbox verification specifics

**Flags and folders are what get lost.** A copy that moves every message and drops the `\Seen` flags
looks complete and is not — the user opens their mail and everything is unread. Maildir stores flags
in the *filename*, so preserving names is what preserves flags; `rsync -a` does, a naive copy may
not. The gate refuses on a folder shortfall for the same reason: a missing folder is invisible until
somebody looks for a message that was in it.

Counting rules, which are not obvious:

- `cur/` and `new/` hold messages. `tmp/` does not — it is delivery in progress.
- A message in `cur/` whose filename flags contain `S` has been read.
- A folder is any directory containing a `cur/`. That makes `.Sent` and `.Archive` count, and stops
  a stray directory from doing so.
- **An inventory of zero compared against another inventory of zero passes and proves nothing.** The
  script warns when it counts zero messages; heed it.

```bash
bash scripts/mailops/mailbox-migrate.sh --mode bulk  --source /var/mail --target /mnt/new/var/mail
bash scripts/mailops/mailbox-migrate.sh --mode delta --source /var/mail --target /mnt/new/var/mail
bash scripts/mailops/mailbox-migrate.sh --mode inventory --source /var/mail         --out inv-old.json --label ZBook
bash scripts/mailops/mailbox-migrate.sh --mode inventory --source /mnt/new/var/mail --out inv-new.json --label dedicated
```

Repeat the delta until the final pass takes under a minute. **That duration is your cutover window.**

---

## Database verification specifics

`db-migrate.sh` runs in stages so a schema problem surfaces before you have waited out a full data
copy: `--stage schema`, then `--stage data`, then `--stage inventory` on both sides, then
`--stage cutover` for the checklist.

Points that cost time if missed:

- **Dumps go over the direct session connection on 5432, never the pooler on 6543.** `pg_dump` sets
  session parameters and holds a snapshot; transaction pooling does not hold a session. The failure
  is not a clean error — it is prepared-statement complaints, or a dump that completes and is
  subtly inconsistent. The scripts refuse a `:6543` URL outright.
- **Verify that encrypted columns still decrypt** on the target using the escrowed key. A restore
  carrying ciphertext but not the key is a database of unreadable columns, and it looks fine.
- **Freeze writes before the final sync**, or the last few seconds of writes are lost silently.
- **The rollback window is short.** Repointing `DATABASE_URL` back is valid only until the first
  write lands on the new database. State that window in minutes and decide in advance who may call
  it.

---

## DNS cutover

Arithmetic in `src/lib/mailops/dns-cutover.ts`; planner at `scripts/mailops/dns-cutover.ts`.

**Nothing in this repository writes DNS, and nothing will.** A wrong MX record is a total mail
outage that persists for its TTL with no rollback faster than that TTL; registrar APIs differ enough
that the automation would be per-registrar for a once-a-year action; and an automated change made at
the wrong moment is indistinguishable from outside from a domain hijack.

**The mistake the planner exists to prevent.** Everyone knows to lower the TTL first. What is
routinely missed is that lowering it does nothing until the **old** TTL has expired everywhere — a
resolver that cached the record at 3600 one minute before you published 300 keeps the old value for
another 59 minutes, and never sees the new TTL either. So the earliest safe cutover is
`reduced_at + old_ttl + margin`, not `reduced_at + new_ttl`.

```bash
npx tsx scripts/mailops/dns-cutover.ts plan  --domain edurankai.in --current-ttl 3600
npx tsx scripts/mailops/dns-cutover.ts ready --domain edurankai.in --current-ttl 3600 \
  --reduced-at 2026-08-16T09:00:00Z --observed-ttl 300 \
  --target-accepts-mail --fr-match --spf-includes --dkim-published \
  --rollback-available --delta-verified
```

Stages: reduce TTL → wait out the old TTL → prepare the target → **deliver test mail to the target
by IP before any DNS change** → cut over → observe a full business day → raise the TTL back.

The gate refuses cutover unless: the reduced TTL is in force, somebody has actually *queried* the
published TTL, the target accepts mail, forward and reverse DNS agree, SPF lists the target, DKIM is
published, the final mailbox delta is verified, and the old host is still available as a rollback.

**Cutover order, which is not interchangeable:** stop the old MTA accepting → take and verify the
final delta → publish the new MX. Publishing first lands mail on a host still missing the last few
messages.

Verify from several resolvers, never one — your own is the most likely to hold a stale or locally
overridden answer, and it is the one you will instinctively use:

```bash
npx tsx scripts/mailops/dns-verify.ts --domain edurankai.in --resolvers 1.1.1.1,8.8.8.8,9.9.9.9
```

That tool distinguishes **"not published"** from **"could not be determined"**. A timed-out lookup
and an absent record both produce an empty answer, and reporting the first as the second sends
somebody to the registrar to add a record that is already there.

**Rollback:** republish the old MX and wait one reduced-TTL period. Write the previous value down
*before* editing — registrar UIs do not have undo. Copy back any mail that arrived on the new host
first, or it is lost.

---

## Reputation is a migration risk, not just a data one

For anything that changes a sending IP:

- Add the new host to SPF **before** it sends anything. A first message that fails authentication is
  the worst possible first impression for a new IP.
- Start with transactional mail — low volume, high engagement, builds reputation fastest.
- Compare bounce class and spam-rejection rate **per host on the same recipient domains**. That
  comparison is the only real measure of whether the IP is warming.
- Back off on any rise in `rate_limited` or `spam_rejection` rather than pushing through it.
- **Remove the old host from SPF last.** A record still listing a host you no longer control is a way
  for somebody else to pass authentication as this domain.

For a cluster: **per-domain rate limiting must move to shared state before the second node.** Three
nodes each respecting 60/min send 180/min to a recipient who allowed 60, and the whole domain gets
throttled.
