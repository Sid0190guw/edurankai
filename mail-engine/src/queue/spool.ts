// mail-engine/src/queue/spool.ts — THE DURABLE OUTBOUND SPOOL.
//
// The rule this file exists to enforce, and the only rule here that really matters:
//
//     A MESSAGE IS ACCEPTED WHEN IT IS ON DISK AND FLUSHED. NOT WHEN IT IS IN AN ARRAY.
//
// Everything else — leases, retries, dead-lettering — is bookkeeping. The failure that actually
// loses somebody's mail is an API that answers 202 out of an in-memory queue and then meets a
// reboot. So enqueue() does not resolve until the entry has been written, fsynced and atomically
// renamed into the queue directory, and if any of that fails it THROWS, so the caller keeps
// ownership of the message and can tell the truth to whoever handed it over.
//
// LAYOUT. Maildir's idea, because it is thirty years old and correct: state is the directory a file
// is in, and a state change is rename(2), which is atomic on every filesystem worth using.
//
//     <spool>/tmp/       incomplete writes. Anything here is debris from a crash mid-write.
//     <spool>/queued/    durable, waiting. nextAttemptAt gates when it is due.
//     <spool>/sending/   claimed by a worker, holding a lease that expires.
//     <spool>/sent/      delivered. Kept for a retention window so "what happened" stays answerable.
//     <spool>/failed/    dead-lettered. Never auto-deleted — a human decides.
//
// CLAIMING IS A link(), NOT A FLAG AND NOT A rename(). Two workers racing for the same entry both
// call link() into sending/; exactly one succeeds and the other gets EEXIST. No lock file, no
// advisory lock, and no window in which both believe they own it. That is what makes the Phase-3
// "several workers over one spool" line in the HA document true rather than aspirational — the
// semantics are already right, so nothing has to be redesigned when a second worker starts.
//
// It was rename() first, which is the conventional answer and is correct on POSIX. It is NOT correct
// on Windows: two concurrent renames of one source both resolve successfully there, so both workers
// claim the entry and the message goes out twice. See the long note above claim().
//
// A CRASH LOSES A LEASE, NOT A MESSAGE. A worker that dies mid-delivery leaves its entry in sending/
// with a lease timestamp; reclaim() returns anything past its lease to queued/. The cost of a crash
// is therefore bounded by the lease duration, and the visible consequence is a possible DUPLICATE
// delivery, never a lost one. That trade is deliberate and it is the standard one for mail: SMTP has
// no exactly-once, and every real MTA re-sends rather than risk dropping.
//
// DURABILITY ON WINDOWS IS WEAKER, AND THIS FILE SAYS SO. fsync on a directory handle is a POSIX
// thing; on Win32 it fails. Without it the rename that publishes an entry is durable only when the
// filesystem gets round to it. durabilityMode() therefore reports 'full' or 'file-only' and the
// health surface prints it, so nobody has to guess whether the stack running natively on the ZBook
// has the same guarantee as the same stack running in its Linux container. Run the spool inside the
// container (or on WSL2), not on the NTFS host, and it is 'full'.
//
// RETRY POLICY LIVES IN ./retry.ts, NOT HERE. This file asks that module when the next attempt is
// due and whether the entry is exhausted. Two implementations of a backoff curve is how a queue ends
// up hammering a server it has already been throttled by.

import { createHash, randomUUID } from 'node:crypto';
import { constants as FS } from 'node:fs';
import { link, mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { OutboundMessage } from '../contracts/index.js';
import type { EngineConfig } from '../config.js';
import { isExhausted, nextAttemptAt, type RetryPolicy } from './retry.js';

export type SpoolState = 'queued' | 'sending' | 'sent' | 'failed';

const STATES: SpoolState[] = ['queued', 'sending', 'sent', 'failed'];

/**
 * One unit of outbound work: a message and the recipients still to be delivered to.
 *
 * ONE ENTRY PER MESSAGE, NOT PER RECIPIENT — but the recipient list is mutable across attempts, so
 * a partial delivery does not re-send to people who already received it. The delivery worker groups
 * `recipients` by domain itself, because a 4xx from one domain must not defer the others.
 */
export interface QueueEntry {
  /** Spool-entry id. Distinct from message.messageId, which is the engine's id for the message. */
  id: string;
  messageId: string;
  message: OutboundMessage;
  recipients: string[];
  attempts: number;
  /** Epoch ms. Not due before this. */
  nextAttemptAt: number;
  createdAt: number;
  updatedAt: number;
  leaseOwner: string | null;
  /** Epoch ms. Set while in sending/. */
  leaseUntil: number | null;
  lastError: string | null;
  lastSmtpCode: number | null;
  /** sha256 over the serialised message, written at enqueue and checked at claim. */
  sha256: string;
}

/** Build an entry from a validated message. Pure; does not touch the filesystem. */
export function newQueueEntry(message: OutboundMessage, recipients: string[], now: number = Date.now()): QueueEntry {
  return {
    id: randomUUID(),
    messageId: message.messageId,
    message,
    recipients: [...recipients],
    attempts: 0,
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
    leaseOwner: null,
    leaseUntil: null,
    lastError: null,
    lastSmtpCode: null,
    sha256: digestOf(message),
  };
}

function digestOf(message: OutboundMessage): string {
  return createHash('sha256').update(JSON.stringify(message)).digest('hex');
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 8,
  baseDelayMs: 60_000,
  factor: 3,
  maxDelayMs: 6 * 60 * 60 * 1000,
  jitter: 0.2,
};

/** The engine's configured retry curve, so the spool and the worker cannot disagree about it. */
export function policyFromConfig(cfg: EngineConfig): RetryPolicy {
  return {
    maxAttempts: cfg.maxAttempts,
    baseDelayMs: cfg.retryBaseDelayMs,
    factor: cfg.retryFactor,
    maxDelayMs: cfg.retryMaxDelayMs,
    jitter: cfg.retryJitter,
  };
}

export interface SpoolOptions {
  root: string;
  policy?: RetryPolicy;
  /** How long a claim is valid before reclaim() may take it back. */
  leaseMs?: number;
  /** Identifies this worker in lease records. */
  workerId?: string;
  now?: () => number;
  random?: () => number;
}

// ---------------------------------------------------------------------------
// Pure predicates. No filesystem, so the scheduling rules are testable on their own.
// ---------------------------------------------------------------------------

export function isDue(entry: Pick<QueueEntry, 'nextAttemptAt'>, nowMs: number): boolean {
  return entry.nextAttemptAt <= nowMs;
}

export function leaseExpired(entry: Pick<QueueEntry, 'leaseUntil'>, nowMs: number): boolean {
  return entry.leaseUntil == null || entry.leaseUntil <= nowMs;
}

// ---------------------------------------------------------------------------
// Durability
// ---------------------------------------------------------------------------

let _dirFsyncWorks: boolean | null = null;

/**
 * fsync a directory so a rename into it is durable.
 *
 * Returns false rather than throwing where the platform refuses, and remembers the answer so
 * durabilityMode() can report it. Swallowing the error is acceptable here ONLY because the failure
 * is reported upward as a weaker guarantee instead of being hidden — that is the difference between
 * this and the bare `catch {}` that once hid a sign-in outage on this project.
 */
async function fsyncDir(dir: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(dir, FS.O_RDONLY);
    await handle.sync();
    _dirFsyncWorks = true;
    return true;
  } catch {
    _dirFsyncWorks = false;
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * What durability this spool is actually giving you.
 *
 *   'full'      — contents AND the publishing rename are fsynced. A power cut cannot lose an entry
 *                 the API acknowledged.
 *   'file-only' — contents are fsynced, the directory entry is not (Windows). A power cut in the
 *                 window between the rename and the filesystem's own flush can lose an acknowledged
 *                 entry. Small window, real risk, stated rather than assumed.
 *   'unknown'   — nothing has been written yet, so nothing has been observed.
 */
export function durabilityMode(): 'full' | 'file-only' | 'unknown' {
  if (_dirFsyncWorks === null) return 'unknown';
  return _dirFsyncWorks ? 'full' : 'file-only';
}

async function writeFileSynced(path: string, data: string): Promise<void> {
  const handle = await open(path, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// Spool
// ---------------------------------------------------------------------------

export interface EnqueueResult {
  id: string;
  /** True when an entry for this messageId was already spooled and nothing new was written. */
  deduped: boolean;
  durability: ReturnType<typeof durabilityMode>;
}

export interface SpoolStats {
  queued: number;
  /** Of `queued`, how many are due now. The difference is deferred mail, and that gap matters. */
  due: number;
  sending: number;
  sent: number;
  failed: number;
  /** Incomplete writes left by a crash. Non-zero is a signal, not noise. */
  orphanedTmp: number;
  oldestQueuedAgeMs: number | null;
  durability: ReturnType<typeof durabilityMode>;
}

export class Spool {
  private readonly root: string;
  private readonly policy: RetryPolicy;
  private readonly leaseMs: number;
  private readonly workerId: string;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(opts: SpoolOptions) {
    this.root = opts.root;
    this.policy = opts.policy ?? DEFAULT_RETRY_POLICY;
    this.leaseMs = opts.leaseMs ?? 5 * 60 * 1000;
    this.workerId = opts.workerId ?? `w-${process.pid}`;
    this.now = opts.now ?? (() => Date.now());
    this.random = opts.random ?? (() => Math.random());
  }

  get directory(): string { return this.root; }

  private dir(state: SpoolState | 'tmp'): string { return join(this.root, state); }
  private path(state: SpoolState | 'tmp', id: string): string { return join(this.dir(state), `${id}.json`); }

  /** Create the directory skeleton. Safe to call on every boot and before every operation. */
  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    for (const d of ['tmp', ...STATES]) await mkdir(join(this.root, d), { recursive: true });
  }

  /**
   * Accept an entry. Resolves only once it is durable; throws if it could not be made durable.
   *
   * Write into tmp/, fsync, rename into queued/, fsync the directory. A crash before the rename
   * leaves debris in tmp/ that sweepTmp() removes and that nobody was ever told about; a crash
   * after it leaves a complete, deliverable entry. There is no third outcome, which is the whole
   * reason for the two-step.
   */
  async enqueue(entry: QueueEntry): Promise<EnqueueResult> {
    await this.init();

    const existing = await this.findByMessageId(entry.messageId);
    if (existing) return { id: existing, deduped: true, durability: durabilityMode() };

    const record: QueueEntry = { ...entry, sha256: entry.sha256 || digestOf(entry.message) };
    await writeFileSynced(this.path('tmp', record.id), JSON.stringify(record, null, 2));
    await rename(this.path('tmp', record.id), this.path('queued', record.id));
    await fsyncDir(this.dir('queued'));

    return { id: record.id, deduped: false, durability: durabilityMode() };
  }

  /**
   * Claim up to `limit` due entries.
   *
   * THE CLAIM IS A link(), NOT A rename(), AND THAT IS NOT A STYLE CHOICE.
   *
   * This was written as `rename(queued/id -> sending/id)` on the reasoning that a loser in the race
   * sees ENOENT and moves on. That reasoning is correct on POSIX and WRONG ON WINDOWS, where two
   * concurrent renames of the same source BOTH RESOLVE SUCCESSFULLY while only one file appears.
   * Measured on this machine, not theorised. The consequence is that two workers both believe they
   * own the entry, and the message is delivered twice.
   *
   * The `only one worker gets an entry` test in test/spool-durability.test.ts caught it — but only
   * sometimes, because it is a race, so it read as a flaky test rather than as the duplicate-delivery
   * bug it is. That is the dangerous shape: intermittent red that invites a re-run rather than a fix.
   *
   * link() has the property rename() only has on POSIX: it fails with EEXIST when the destination
   * already exists, on every platform. Exactly one worker's link succeeds; everyone else gets EEXIST
   * and moves on. Verified against 200 three-way races on NTFS with exactly one winner each time.
   *
   * A crash between the link and the unlink leaves the entry in BOTH directories. That heals itself
   * here: reclaim() moves sending/id back to queued/id under the same id, overwriting the orphan.
   */
  async claim(limit = 20): Promise<QueueEntry[]> {
    await this.init();
    const nowMs = this.now();
    const out: QueueEntry[] = [];

    for (const id of await this.idsIn('queued')) {
      if (out.length >= limit) break;
      const entry = await this.readEntry('queued', id);
      if (!entry || !isDue(entry, nowMs)) continue;

      try {
        await link(this.path('queued', id), this.path('sending', id));
      } catch {
        continue; // EEXIST: somebody else took it. ENOENT: it is already gone. Neither is a fault.
      }
      // Won the race. Drop the queued name; the entry now lives only in sending/. If this fails the
      // orphan is repaired by reclaim(), which writes back to the same id.
      await rm(this.path('queued', id), { force: true }).catch(() => {});

      const claimed: QueueEntry = {
        ...entry,
        leaseOwner: this.workerId,
        leaseUntil: nowMs + this.leaseMs,
        updatedAt: nowMs,
      };

      if (digestOf(claimed.message) !== claimed.sha256) {
        // The bytes changed under us. Do NOT send it — a message whose content no longer matches
        // what was accepted is not the message the caller handed over. Fail it loudly and keep it.
        await this.moveTo('sending', 'failed', id, {
          ...claimed,
          lastError: 'entry checksum mismatch: the spooled message does not match what was accepted',
        });
        continue;
      }

      await writeFileSynced(this.path('sending', id), JSON.stringify(claimed, null, 2));
      out.push(claimed);
    }
    return out;
  }

  /** Delivered to every remaining recipient. Moves to sent/ for the retention window. */
  async complete(id: string, detail?: { smtpCode?: number | null; response?: string | null }): Promise<void> {
    const entry = await this.readEntry('sending', id);
    if (!entry) return;
    await this.moveTo('sending', 'sent', id, {
      ...entry,
      attempts: entry.attempts + 1,
      leaseOwner: null,
      leaseUntil: null,
      lastSmtpCode: detail?.smtpCode ?? null,
      lastError: detail?.response ?? null,
      updatedAt: this.now(),
    });
  }

  /**
   * Partial delivery: some recipients are done, the rest still owe an attempt.
   *
   * Without this a message to forty people where thirty-nine succeeded and one was greylisted would
   * re-send to all forty on the retry. The delivered set is subtracted and the remainder deferred.
   */
  async deferRemaining(id: string, delivered: string[], error: string, smtpCode: number | null = null): Promise<'retry' | 'dead_lettered' | 'complete'> {
    const entry = await this.readEntry('sending', id);
    if (!entry) return 'retry';
    const done = new Set(delivered.map((r) => r.toLowerCase()));
    const remaining = entry.recipients.filter((r) => !done.has(r.toLowerCase()));
    if (!remaining.length) {
      await this.complete(id, { smtpCode, response: error });
      return 'complete';
    }
    await writeFileSynced(this.path('sending', id), JSON.stringify({ ...entry, recipients: remaining }, null, 2));
    return this.defer(id, error, smtpCode);
  }

  /**
   * A 4xx, a timeout, a connection failure. Back to queued/ with a later nextAttemptAt — unless the
   * attempt ceiling is reached, in which case it is dead-lettered.
   *
   * Returns which of the two happened, because the caller publishes a different event for each and
   * inferring it afterwards from the queue depth is not a thing.
   */
  async defer(id: string, error: string, smtpCode: number | null = null): Promise<'retry' | 'dead_lettered'> {
    const entry = await this.readEntry('sending', id);
    if (!entry) return 'retry';
    const nowMs = this.now();
    const attempts = entry.attempts + 1;
    const next: QueueEntry = {
      ...entry,
      attempts,
      leaseOwner: null,
      leaseUntil: null,
      lastError: String(error).slice(0, 500),
      lastSmtpCode: smtpCode,
      updatedAt: nowMs,
    };

    if (isExhausted(this.policy, attempts)) {
      await this.moveTo('sending', 'failed', id, next);
      return 'dead_lettered';
    }
    next.nextAttemptAt = nextAttemptAt(this.policy, attempts, nowMs, this.random);
    await this.moveTo('sending', 'queued', id, next);
    return 'retry';
  }

  /** A 5xx or a local refusal. Straight to failed/, no retry. */
  async fail(id: string, error: string, smtpCode: number | null = null): Promise<void> {
    const entry = await this.readEntry('sending', id);
    if (!entry) return;
    await this.moveTo('sending', 'failed', id, {
      ...entry,
      attempts: entry.attempts + 1,
      leaseOwner: null,
      leaseUntil: null,
      lastError: String(error).slice(0, 500),
      lastSmtpCode: smtpCode,
      updatedAt: this.now(),
    });
  }

  /**
   * Return abandoned claims to the queue. Call on worker start, and on a timer.
   *
   * This is the whole of crash recovery. There is no journal to replay and no state to rebuild: the
   * filesystem already holds the truth, and an expired lease is sufficient evidence that the worker
   * which held it is gone.
   */
  async reclaim(): Promise<{ reclaimed: string[]; stillLeased: number }> {
    await this.init();
    const nowMs = this.now();
    const reclaimed: string[] = [];
    let stillLeased = 0;

    for (const id of await this.idsIn('sending')) {
      const entry = await this.readEntry('sending', id);
      if (!entry) {
        // Unreadable entry sitting in sending/. It cannot be delivered and it must not be deleted.
        // failed/ is where a human can find it.
        await rename(this.path('sending', id), this.path('failed', id)).catch(() => {});
        continue;
      }
      if (!leaseExpired(entry, nowMs)) { stillLeased++; continue; }
      await this.moveTo('sending', 'queued', id, {
        ...entry,
        leaseOwner: null,
        leaseUntil: null,
        lastError: entry.lastError ?? 'lease expired; the worker holding this entry never reported an outcome',
        updatedAt: nowMs,
      });
      reclaimed.push(id);
    }
    return { reclaimed, stillLeased };
  }

  /**
   * Remove incomplete writes left in tmp/ by a crash.
   *
   * Safe by construction: nothing in tmp/ was ever acknowledged to a caller — acknowledgement
   * happens after the rename out of it — so deleting from tmp/ cannot lose a message anyone was
   * told we had. The age floor exists so a sweep running concurrently with an enqueue does not
   * delete a write that is still in progress.
   */
  async sweepTmp(olderThanMs = 60 * 60 * 1000): Promise<number> {
    await this.init();
    // WALL CLOCK, NOT this.now(). The age of a tmp file is measured against its mtime, which the
    // filesystem stamped from the real clock. Comparing that to an injected test clock produces a
    // nonsense age — and the direction of the nonsense is "nothing is ever old enough", so the
    // sweeper silently stops sweeping. Every other method here is free to use the injected clock
    // because it only ever compares against timestamps this module wrote itself.
    const nowMs = Date.now();
    let removed = 0;
    for (const name of await readdir(this.dir('tmp')).catch(() => [] as string[])) {
      const p = join(this.dir('tmp'), name);
      const s = await stat(p).catch(() => null);
      if (!s) continue;
      if (nowMs - s.mtimeMs >= olderThanMs) { await rm(p, { force: true }); removed++; }
    }
    return removed;
  }

  /** Prune delivered entries older than the retention window. sent/ only — never failed/. */
  async pruneSent(olderThanMs = 7 * 24 * 60 * 60 * 1000): Promise<number> {
    await this.init();
    const nowMs = this.now();
    let removed = 0;
    for (const id of await this.idsIn('sent')) {
      const entry = await this.readEntry('sent', id);
      if (entry && nowMs - entry.updatedAt < olderThanMs) continue;
      await rm(this.path('sent', id), { force: true });
      removed++;
    }
    return removed;
  }

  /** Move a dead-lettered entry back with a fresh attempt budget. Explicit and manual, by design. */
  async requeueFailed(id: string): Promise<boolean> {
    const entry = await this.readEntry('failed', id);
    if (!entry) return false;
    const nowMs = this.now();
    await this.moveTo('failed', 'queued', id, {
      ...entry,
      attempts: 0,
      nextAttemptAt: nowMs,
      leaseOwner: null,
      leaseUntil: null,
      updatedAt: nowMs,
    });
    return true;
  }

  async stats(): Promise<SpoolStats> {
    await this.init();
    const nowMs = this.now();
    const counts: Record<SpoolState, number> = { queued: 0, sending: 0, sent: 0, failed: 0 };
    let due = 0;
    let oldest: number | null = null;

    for (const state of STATES) {
      const ids = await this.idsIn(state);
      counts[state] = ids.length;
      if (state !== 'queued') continue;
      for (const id of ids) {
        const entry = await this.readEntry('queued', id);
        if (!entry) continue;
        if (isDue(entry, nowMs)) due++;
        oldest = oldest === null ? entry.createdAt : Math.min(oldest, entry.createdAt);
      }
    }

    const tmpNames = await readdir(this.dir('tmp')).catch(() => [] as string[]);
    return {
      ...counts,
      due,
      orphanedTmp: tmpNames.length,
      oldestQueuedAgeMs: oldest === null ? null : nowMs - oldest,
      durability: durabilityMode(),
    };
  }

  async read(state: SpoolState, id: string): Promise<QueueEntry | null> {
    return this.readEntry(state, id);
  }

  async list(state: SpoolState, limit = 100): Promise<QueueEntry[]> {
    const out: QueueEntry[] = [];
    for (const id of (await this.idsIn(state)).slice(0, limit)) {
      const entry = await this.readEntry(state, id);
      if (entry) out.push(entry);
    }
    return out;
  }

  // -- internals ------------------------------------------------------------

  private async idsIn(state: SpoolState): Promise<string[]> {
    const names = await readdir(this.dir(state)).catch(() => [] as string[]);
    return names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).sort();
  }

  private async readEntry(state: SpoolState | 'tmp', id: string): Promise<QueueEntry | null> {
    try {
      return JSON.parse(await readFile(this.path(state, id), 'utf8')) as QueueEntry;
    } catch {
      return null;
    }
  }

  /**
   * State transition: stage the new record in tmp/, then rename it into the destination and drop
   * the old one. A crash halfway leaves either the old state intact or the new state complete —
   * never a record describing a state it is not in.
   */
  private async moveTo(from: SpoolState, to: SpoolState, id: string, entry: QueueEntry): Promise<void> {
    const staged = join(this.dir('tmp'), `${id}.${to}.json`);
    await writeFileSynced(staged, JSON.stringify(entry, null, 2));
    await rename(staged, this.path(to, id));
    if (from !== to) await rm(this.path(from, id), { force: true });
    await fsyncDir(this.dir(to));
  }

  /**
   * Idempotency. Checked against EVERY state including sent/, because the dangerous duplicate is
   * the one where the first copy has already gone out to a real person.
   */
  private async findByMessageId(messageId: string): Promise<string | null> {
    for (const state of STATES) {
      for (const id of await this.idsIn(state)) {
        const entry = await this.readEntry(state, id);
        if (entry?.messageId === messageId) return id;
      }
    }
    return null;
  }
}

/**
 * One-line summary for a health endpoint.
 *
 * States the deferred backlog separately from the due one, deliberately. "412 queued" reads as a
 * disaster when 410 of them are simply waiting out a greylist, and reads as fine when all 412 are
 * due and nothing is draining. Those are opposite situations and a single number cannot tell them
 * apart.
 */
export function describeStats(s: SpoolStats): string {
  const parts = [
    `${s.due} due`,
    `${s.queued - s.due} deferred`,
    `${s.sending} in flight`,
    `${s.failed} dead-lettered`,
  ];
  if (s.orphanedTmp) parts.push(`${s.orphanedTmp} incomplete writes in tmp/`);
  if (s.durability !== 'full') parts.push(`durability: ${s.durability}`);
  return parts.join(', ');
}
