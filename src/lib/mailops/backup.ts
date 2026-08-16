// src/lib/mailops/backup.ts — what is backed up, how long it is kept, and whether it has ever been
// proved to restore.
//
// ONE RULE ABOVE ALL OTHERS, AND IT IS ENCODED RATHER THAN WRITTEN DOWN:
//
//     A BACKUP THAT HAS NEVER BEEN RESTORED IS NOT A BACKUP.
//
// verificationState() returns 'never' for a backup set with no successful restore test, no matter
// how many dumps exist or how recent they are, and every surface that shows backup status shows
// that word. The alternative — a green tick next to "last backup: 2 hours ago" — is a lie that only
// becomes visible on the worst day of the year.
//
// The second rule follows from the first: verification EXPIRES. A restore test proves the backup
// taken that week restores into the schema of that week. Ninety days and forty schema changes
// later it proves very little, so the state goes back to 'stale' and asks to be re-run.
//
// WHAT THIS MODULE IS NOT. It does not connect to a database, does not read a dump and does not run
// pg_dump. It cannot: the working rule on this project is that no agent and no process in this
// repository opens the production database, after a subagent asked to survey source files connected
// to production and read staff PII instead. So the actual dumping and restoring is done by scripts
// the founder runs (scripts/mailops/), and those scripts REPORT their result to the platform. This
// module owns the definitions, the retention arithmetic and the honesty rules; the ledger of what
// actually ran lives in ./continuity-store.ts.

import type { AssetClass } from './objectives';

export type Cadence = 'continuous' | 'hourly' | 'daily' | 'weekly' | 'on-change' | 'manual';

export interface BackupSet {
  id: AssetClass;
  label: string;
  /** Exactly what is inside. Specific enough that somebody can tell what is missing. */
  contents: string;
  /** Where the live copy is now. */
  source: string;
  /** The tool that takes it. Named so the runbook and the script agree. */
  method: string;
  cadence: Cadence;
  /** Encryption at rest for the backup artefact itself. */
  encryption: 'required' | 'recommended' | 'not-applicable';
  /** True when the artefact contains material that is dangerous on its own if leaked. */
  sensitive: boolean;
  retention: RetentionPolicy;
  /** How a restore of this set is proved. Must be an observable outcome, not "the script exited 0". */
  verifyBy: string;
  /** How often verification must be repeated before it is considered stale. */
  verifyEveryDays: number;
  /** What is honestly true about this set today, including "nothing does this yet". */
  today: string;
}

/**
 * Grandfather-father-son retention.
 *
 * Expressed as counts rather than ages because that is what makes the storage bill predictable and
 * because "keep 7 daily" survives a week where the job did not run, whereas "delete older than 7
 * days" quietly leaves you with nothing.
 */
export interface RetentionPolicy {
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
  keepYearly: number;
  /** Copies held somewhere that is not the machine being backed up. Fewer than 1 is not a backup. */
  offsiteCopies: number;
}

const STANDARD: RetentionPolicy = { keepDaily: 7, keepWeekly: 4, keepMonthly: 6, keepYearly: 1, offsiteCopies: 1 };
const KEYS: RetentionPolicy = { keepDaily: 0, keepWeekly: 0, keepMonthly: 0, keepYearly: 3, offsiteCopies: 2 };

export const BACKUP_SETS: readonly BackupSet[] = [
  {
    id: 'database',
    label: 'Postgres logical dump',
    contents:
      'Every table: users, mail_messages, mail_recipients, delivery events, contacts, campaigns, templates, automations, the org graph, HR records, audit rows. 258 tables at last count.',
    source: 'Supabase Postgres. Dumped over the DIRECT (session) connection on 5432, never the transaction pooler on 6543 — pg_dump needs a session and the pooler does not hold one.',
    method: 'pg_dump --format=custom, then encrypted with age or gpg before it touches any disk that is not the operator machine.',
    cadence: 'daily',
    encryption: 'required',
    sensitive: true,
    retention: STANDARD,
    verifyBy:
      'Restore into a scratch database and compare row counts for a fixed set of tables against the inventory taken at dump time. A restore that completes with zero rows in mail_messages is a successful command and a failed backup.',
    verifyEveryDays: 30,
    today:
      'Not scheduled. Dumps are taken by hand when somebody remembers, which means the real RPO is unbounded. This is the single largest gap in the whole continuity story.',
  },
  {
    id: 'mail_config',
    label: 'Mail configuration, templates, campaigns, automations',
    contents:
      'mail_config and mail_settings rows (SMTP/IMAP host, ports, from-address), signature and rule definitions, template bodies, campaign definitions and their schedules, automation definitions, domain records and their verification state, group membership.',
    source: 'Postgres. Contained within the full dump, extracted separately so it can be restored WITHOUT restoring everything else.',
    method: 'pg_dump --table for the mail_* and campaign tables, same encryption.',
    cadence: 'daily',
    encryption: 'required',
    sensitive: true,
    retention: STANDARD,
    verifyBy:
      'Restore the subset into a scratch schema and confirm template and campaign counts match, and that no campaign comes back in a running state — a half-sent campaign restored as "running" will re-send to people who already received it.',
    verifyEveryDays: 30,
    today: 'Covered incidentally by a full dump when one is taken. No separate extract exists yet.',
  },
  {
    id: 'mailboxes',
    label: 'Delivered mail',
    contents:
      'Message bodies, headers, per-mailbox flags and folder placement from Postgres; and the Dovecot maildir tree on the mail host, which is a SECOND COPY of some of the same mail and is not in Postgres at all.',
    source: 'Postgres (mail_messages, mail_box, mail_reads) plus the maildir volume on the mail host.',
    method: 'Included in the Postgres dump; the maildir tree needs its own file-level backup (tar over the volume, or doveadm backup to a second location).',
    cadence: 'daily',
    encryption: 'required',
    sensitive: true,
    retention: STANDARD,
    verifyBy: 'Restore the maildir onto a scratch host, point a Dovecot instance at it, and open one mailbox over IMAP. Count messages in INBOX and compare.',
    verifyEveryDays: 60,
    today: 'The Postgres half is covered by the database dump. The maildir tree is NOT backed up. If the disk dies, the IMAP copy is gone.',
  },
  {
    id: 'dkim_keys',
    label: 'DKIM private keys',
    contents: 'One PEM private key per signing domain, plus the selector name each is published under.',
    source: 'The engine key directory on the mail host. Gitignored, unencrypted at rest, one copy.',
    method:
      'Copied at rotation time into an encrypted escrow archive. NOT into the same backup bundle as the database dump — an operator restoring a database should not be handed the ability to sign mail as this domain.',
    cadence: 'on-change',
    encryption: 'required',
    sensitive: true,
    retention: KEYS,
    verifyBy:
      'Sign a test message with the escrowed key on a scratch host and verify the signature validates against the selector published in DNS. Reading the file back is not verification.',
    verifyEveryDays: 180,
    today:
      'One copy, on one disk, unencrypted. Losing it means generating a new key and republishing DNS, which costs hours of propagation and days of deliverability. Leaking it lets a stranger send mail that authenticates as this domain — which is why it is the one asset where the backup is itself a risk.',
  },
  {
    id: 'secrets',
    label: 'Environment secrets and encryption keys',
    contents:
      'DATA_ENCRYPTION_KEY_<keyId> values first — losing one makes every column encrypted under it permanently unreadable, and a perfect database backup does not help. Then CRON_SECRET, the mail inbound secret, the service-auth shared secret, S3 credentials, payment keys.',
    source: 'Vercel environment variables, and the mail host environment file.',
    method:
      'Exported by hand into an encrypted store held off both machines. Never into this repository, never into a shell history, never into a backup bundle that a restore operator opens routinely.',
    cadence: 'on-change',
    encryption: 'required',
    sensitive: true,
    retention: KEYS,
    verifyBy: 'Decrypt one encrypted column in a scratch restore using only the escrow copy of the key.',
    verifyEveryDays: 180,
    today: 'No escrow copy is known to exist. This is the highest-consequence item in the list and the least protected.',
  },
  {
    id: 'object_storage',
    label: 'Attachments and raw MIME',
    contents: 'Every stored attachment and every archived raw message body.',
    source: 'S3-compatible storage when the S3_* variables are set; Vercel Blob otherwise.',
    method:
      'Bucket versioning plus a scheduled sync to a second bucket, ideally with a different provider or at least a different region. A single bucket with no versioning is one accidental delete away from gone.',
    cadence: 'continuous',
    encryption: 'recommended',
    sensitive: true,
    retention: { keepDaily: 30, keepWeekly: 0, keepMonthly: 0, keepYearly: 0, offsiteCopies: 1 },
    verifyBy: 'Delete a test object and restore it from a version; then fetch an attachment through the application and confirm it renders.',
    verifyEveryDays: 90,
    today: 'No versioning and no second copy are configured. There is exactly one copy of every attachment.',
  },
  {
    id: 'spool',
    label: 'Outbound spool',
    contents: 'Queued, in-flight and dead-lettered outbound messages on the mail host.',
    source: 'The spool directory on the mail host.',
    method:
      'Not backed up on a schedule, deliberately — the spool is transient by design and a stale spool restored later would re-send mail that has already gone out, which is worse than losing it. What IS captured is the failed/ directory, because a dead-lettered message is evidence and a human has to decide about it.',
    cadence: 'manual',
    encryption: 'recommended',
    sensitive: true,
    retention: { keepDaily: 14, keepWeekly: 0, keepMonthly: 0, keepYearly: 0, offsiteCopies: 0 },
    verifyBy: 'Copy failed/ to a scratch spool and confirm entries parse and list correctly.',
    verifyEveryDays: 180,
    today:
      'Nothing copies failed/ off the machine. The durability that matters for the spool is the fsync-on-enqueue guarantee, not a backup — see the spool module.',
  },
] as const;

export function backupSet(id: AssetClass): BackupSet | undefined {
  return BACKUP_SETS.find((s) => s.id === id);
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

export interface BackupArtefact {
  id: string;
  assetClass: AssetClass;
  takenAt: string;
  sizeBytes: number | null;
  /** Where the artefact is. A path on the machine being backed up does not count as offsite. */
  location: string;
  encrypted: boolean;
  /** sha256 of the artefact, recorded at creation and re-checked before any restore. */
  checksum: string | null;
  offsite: boolean;
}

export interface RetentionDecision {
  artefact: BackupArtefact;
  keep: boolean;
  /** Which slot earned it a reprieve: 'daily' | 'weekly' | 'monthly' | 'yearly' | 'pruned'. */
  reason: string;
}

function dayKey(d: Date): string { return d.toISOString().slice(0, 10); }
function monthKey(d: Date): string { return d.toISOString().slice(0, 7); }
function yearKey(d: Date): string { return d.toISOString().slice(0, 4); }
function isoWeekKey(d: Date): string {
  // ISO week: Thursday of the same week determines the year. Cheap, correct at year boundaries,
  // and the boundary is exactly where a naive week calculation silently drops a backup.
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Decide which artefacts to keep.
 *
 * Newest first, one artefact per slot, slots filled in order daily -> weekly -> monthly -> yearly.
 * An artefact already kept by an earlier slot is not double-counted, which is the bug in most
 * hand-rolled GFS implementations: without that check, seven dailies in one week consume the weekly
 * slots too and the policy silently degrades to "keep 7 days".
 *
 * Pure, so the policy can be tested against a year of dates without deleting anything.
 */
export function applyRetention(
  artefacts: readonly BackupArtefact[],
  policy: RetentionPolicy,
): RetentionDecision[] {
  const sorted = [...artefacts].sort((a, b) => Date.parse(b.takenAt) - Date.parse(a.takenAt));
  const kept = new Set<string>();
  const reason = new Map<string, string>();

  const fill = (limit: number, keyOf: (d: Date) => string, name: string) => {
    if (limit <= 0) return;
    const seen = new Set<string>();
    for (const a of sorted) {
      if (seen.size >= limit) break;
      const d = new Date(a.takenAt);
      if (Number.isNaN(d.getTime())) continue;
      const k = keyOf(d);
      if (seen.has(k)) continue;
      seen.add(k);
      if (!kept.has(a.id)) { kept.add(a.id); reason.set(a.id, name); }
    }
  };

  fill(policy.keepDaily, dayKey, 'daily');
  fill(policy.keepWeekly, isoWeekKey, 'weekly');
  fill(policy.keepMonthly, monthKey, 'monthly');
  fill(policy.keepYearly, yearKey, 'yearly');

  return sorted.map((a) => ({ artefact: a, keep: kept.has(a.id), reason: reason.get(a.id) || 'pruned' }));
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface RestoreCheck {
  name: string;
  ok: boolean;
  /** What was compared and what was found. "ok" alone is not a check result. */
  detail: string;
}

export interface RestoreTest {
  id: string;
  assetClass: AssetClass;
  /** The artefact that was restored. A test with no artefact id proves nothing about any backup. */
  artefactId: string | null;
  startedAt: string;
  finishedAt: string | null;
  ok: boolean;
  checks: RestoreCheck[];
  /** Measured recovery time, seconds. This is where objectives.ts gets its measurements. */
  durationSeconds: number | null;
  /** Age of the artefact at restore time, seconds — the measured RPO. */
  artefactAgeSeconds: number | null;
  /** Where it was restored to. Must not be production, and the script refuses if it looks like it. */
  target: string;
  notes: string | null;
}

export type VerificationState = 'verified' | 'stale' | 'failed' | 'never';

export interface VerificationStatus {
  assetClass: AssetClass;
  state: VerificationState;
  lastTest: RestoreTest | null;
  ageDays: number | null;
  /** The sentence a surface prints. Never a bare tick. */
  summary: string;
}

/**
 * The state of a backup set's proof.
 *
 * Note what does NOT appear as an input: how many artefacts exist, or how recent the newest one is.
 * Those describe the copying, not the recovering, and conflating them is the entire failure this
 * module exists to prevent.
 */
export function verificationState(
  set: BackupSet,
  tests: readonly RestoreTest[],
  now: Date = new Date(),
): VerificationStatus {
  const mine = tests
    .filter((t) => t.assetClass === set.id && t.finishedAt)
    .sort((a, b) => Date.parse(b.finishedAt!) - Date.parse(a.finishedAt!));
  const last = mine[0] || null;

  if (!last) {
    return {
      assetClass: set.id,
      state: 'never',
      lastTest: null,
      ageDays: null,
      summary: `Never restored. There is no evidence this backup can be recovered from, so it does not count as one yet. Prove it: ${set.verifyBy}`,
    };
  }

  const ageDays = (now.getTime() - Date.parse(last.finishedAt!)) / 86_400_000;

  if (!last.ok) {
    const failed = last.checks.filter((c) => !c.ok).map((c) => c.name);
    return {
      assetClass: set.id,
      state: 'failed',
      lastTest: last,
      ageDays,
      summary: `The last restore test FAILED ${Math.round(ageDays)} days ago${failed.length ? ` on: ${failed.join(', ')}` : ''}. Treat this backup as unusable until a test passes.`,
    };
  }

  if (ageDays > set.verifyEveryDays) {
    return {
      assetClass: set.id,
      state: 'stale',
      lastTest: last,
      ageDays,
      summary: `Last proved ${Math.round(ageDays)} days ago, against a schema that has since changed. Re-test — the policy for this set is every ${set.verifyEveryDays} days.`,
    };
  }

  return {
    assetClass: set.id,
    state: 'verified',
    lastTest: last,
    ageDays,
    summary: `Restored and verified ${Math.round(ageDays)} days ago in ${last.durationSeconds != null ? `${Math.round(last.durationSeconds / 60)} min` : 'an unrecorded time'}, ${last.checks.filter((c) => c.ok).length}/${last.checks.length} checks passing.`,
  };
}

/** Roll every set into one honest headline. */
export function backupPosture(statuses: readonly VerificationStatus[]): {
  state: 'protected' | 'partial' | 'unprotected';
  headline: string;
  never: number;
  failed: number;
  stale: number;
} {
  const never = statuses.filter((s) => s.state === 'never').length;
  const failed = statuses.filter((s) => s.state === 'failed').length;
  const stale = statuses.filter((s) => s.state === 'stale').length;

  if (failed > 0) {
    return { state: 'unprotected', headline: `${failed} backup set${failed === 1 ? '' : 's'} failed the last restore test.`, never, failed, stale };
  }
  if (never === statuses.length) {
    return { state: 'unprotected', headline: 'No backup set has ever been restored. Nothing here is a proven backup.', never, failed, stale };
  }
  if (never + stale > 0) {
    return { state: 'partial', headline: `${statuses.length - never - stale} of ${statuses.length} sets have current proof; ${never} never tested, ${stale} stale.`, never, failed, stale };
  }
  return { state: 'protected', headline: 'Every backup set has a current, passing restore test.', never, failed, stale };
}

/**
 * Rules an artefact must satisfy before it is allowed to count.
 *
 * Returned as a list of problems rather than a boolean, because "this backup does not count" is
 * only actionable when it says why.
 */
export function artefactProblems(set: BackupSet, a: BackupArtefact): string[] {
  const out: string[] = [];
  if (set.encryption === 'required' && !a.encrypted) {
    out.push('Contains sensitive data and is not encrypted. It must not be stored or transferred in this state.');
  }
  if (!a.checksum) {
    out.push('No checksum recorded, so silent corruption between now and the restore cannot be detected.');
  }
  if (set.retention.offsiteCopies > 0 && !a.offsite) {
    out.push('Held only on the machine it was taken from. A disk failure loses the data and the backup together.');
  }
  if (a.sizeBytes != null && a.sizeBytes === 0) {
    out.push('Zero bytes. The command exited but produced nothing — the classic silent backup failure.');
  }
  return out;
}
