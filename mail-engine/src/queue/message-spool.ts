// mail-engine/src/queue/message-spool.ts — the durable outbound queue for THIS engine.
//
// NAMING NOTE, READ THIS FIRST. There is a second spool in this directory, queue/spool.ts, written
// by a different patch working in parallel on the same tree. The two are not merged, and the file
// names are different so that neither overwrites the other. They differ in what an entry IS:
//   queue/spool.ts          one entry per destination domain, payload stored as a raw .eml, states
//                           expressed as directories (queued/sending/sent/failed), fsync-aware.
//   queue/message-spool.ts  one entry per MESSAGE, payload stored as the structured OutboundMessage,
//                           recipients tracked individually so a partial delivery retries only the
//                           recipients that were actually deferred.
// This engine's worker, pipeline and tests use this one. Consolidating on a single spool is a real
// piece of work and it needs one owner — flagged rather than done silently in a parallel patch.
//
// WHY A FILESYSTEM SPOOL AND NOT A TABLE. Patch 1 owns the database, and a mail queue that lives in
// the application's database inherits the application's availability: when Supabase is unreachable
// the engine can neither accept mail nor remember what it was holding. Every real MTA keeps its
// queue on local disk for exactly this reason, and section 13 of the brief asks for the same
// property in as many words — the laptop goes offline, the queue survives, nothing is deleted.
//
// HOW A CLAIM IS MADE SAFE, AND WHY IT IS NOT A rename(). Two workers must never deliver the same
// message twice. The obvious implementation — rename() from queue/ into a per-worker name under
// processing/, on the theory that only one rename of a given source can succeed — IS WRONG ON
// WINDOWS, and it was written that way here first. Measured on this machine: two concurrent
// fs.rename() calls with the same source and different destinations BOTH resolve successfully, and
// only one file exists afterwards. A worker that trusts a resolved rename therefore believes it owns
// a message it does not have, which is either a lost message or a duplicate delivery depending on
// which side of the race it was on.
//
// link() has the property rename() only has on POSIX: it fails with EEXIST when the destination
// already exists, on every platform. So the claim is link(queue/<name> -> processing/<name>), where
// the destination name is the SAME for every racing worker: exactly one link succeeds, everyone else
// gets EEXIST and moves on. The winner then unlinks the queue entry. Verified against 200 three-way
// races on NTFS with exactly one winner each time — see test/spool.test.ts.
//
// A worker that dies between the link and the unlink leaves the entry in BOTH directories.
// recoverStale() is what repairs that: it re-queues from processing/ and removes the orphaned queue
// entry of the same name, so the crash costs a delayed delivery and never a doubled one.

// A worker that dies mid-delivery leaves its file in processing/; recoverStale() puts anything older
// than the lease back on the queue, which is the "queue recovery" line in section 5.
//
// WHY THE FILENAME CARRIES THE DUE TIME. `000001730000000000-3f2a....json`. Deciding what is ready
// to send is then a readdir and a string compare rather than opening and parsing every queued
// message, so a queue holding thousands of deferred messages costs one directory listing per poll.
//
// DURABILITY LIMIT, STATED NOT HIDDEN. enqueue() writes then renames, which makes a torn file
// impossible, but it does not fsync — Node has no portable durable-directory-rename and fsync on a
// directory handle fails on Win32. A power cut in the millisecond between write and rename can lose
// the newest message. Run the spool on the Linux container's filesystem, not on the NTFS host, and
// see docs/operations.md under "Durability limits".

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { OutboundMessage } from '../contracts/index.js';

export interface AttemptRecord {
  at: number;
  recipient: string;
  outcome: 'delivered' | 'deferred' | 'bounced';
  smtpCode: number | null;
  smtpResponse: string | null;
  mxHost: string | null;
}

export interface QueueEntry {
  messageId: string;
  message: OutboundMessage;
  /** Recipients still to be delivered. Shrinks as recipients succeed or bounce. */
  pending: string[];
  /** Delivery attempts made so far. 0 for a message that has never been tried. */
  attempt: number;
  /** Epoch ms. The entry is invisible to claimBatch() until this time. */
  nextAttemptAt: number;
  createdAt: number;
  updatedAt: number;
  lastError: string | null;
  history: AttemptRecord[];
  /** Set on dead-lettered entries. */
  deadReason?: string;
  deadAt?: number;
}

export interface MessageSpoolStats {
  ready: number;
  deferred: number;
  processing: number;
  dead: number;
  total: number;
}

const QUEUE = 'queue';
const PROCESSING = 'processing';
const DEAD = 'dead';
const TMP = 'tmp';

/** `<dueMs padded>-<messageId>.json`, so lexical order is due order. */
function fileNameFor(entry: QueueEntry): string {
  return `${String(entry.nextAttemptAt).padStart(15, '0')}-${entry.messageId}.json`;
}

function dueOf(fileName: string): number {
  const n = Number(fileName.slice(0, 15));
  return Number.isFinite(n) ? n : 0;
}

export class MessageSpool {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  dir(kind: 'queue' | 'processing' | 'dead' | 'tmp'): string {
    return path.join(this.root, kind);
  }

  async init(): Promise<void> {
    for (const d of [QUEUE, PROCESSING, DEAD, TMP]) {
      await fs.mkdir(path.join(this.root, d), { recursive: true });
    }
  }

  /** Write-to-tmp-then-rename. A reader never sees a half-written message. */
  private async writeAtomic(target: string, data: string): Promise<void> {
    const tmp = path.join(this.root, TMP, `${randomUUID()}.tmp`);
    await fs.writeFile(tmp, data, 'utf8');
    await fs.rename(tmp, target);
  }

  async enqueue(entry: QueueEntry): Promise<string> {
    await this.init();
    const name = fileNameFor(entry);
    await this.writeAtomic(path.join(this.root, QUEUE, name), JSON.stringify(entry, null, 2));
    return name;
  }

  /**
   * Take up to `limit` entries whose due time has passed. Returns entries already moved into
   * processing/ — the caller owns them until it calls complete(), release() or deadLetter().
   */
  async claimBatch(limit: number, now: number = Date.now()): Promise<{ entry: QueueEntry; claim: string }[]> {
    await this.init();
    let names: string[];
    try {
      names = (await fs.readdir(path.join(this.root, QUEUE))).filter((n) => n.endsWith('.json')).sort();
    } catch {
      return [];
    }

    const out: { entry: QueueEntry; claim: string }[] = [];
    for (const name of names) {
      if (out.length >= limit) break;
      // The names are due-sorted, so the first future entry means every later one is future too.
      if (dueOf(name) > now) break;

      const from = path.join(this.root, QUEUE, name);
      const claim = name;                                   // the SAME destination for every racer
      const to = path.join(this.root, PROCESSING, claim);
      try {
        await fs.link(from, to);
      } catch {
        // EEXIST: another worker owns it. ENOENT: it was claimed and unlinked a moment ago. Both
        // mean "not mine", and neither is an error worth recording.
        continue;
      }
      // Won the race. Remove the queue entry; if this fails the entry is repaired by recoverStale(),
      // which is why that function removes a queue file of the same name when it re-queues.
      await fs.unlink(from).catch(() => { /* recoverStale() cleans up the leftover */ });
      try {
        const entry = JSON.parse(await fs.readFile(to, 'utf8')) as QueueEntry;
        out.push({ entry, claim });
      } catch (e) {
        // A message that cannot be parsed is not a message that can be silently dropped: it goes to
        // dead/ with the reason attached, where an operator can see it and requeue it by hand.
        const dead = path.join(this.root, DEAD, claim);
        try { await fs.rename(to, dead); } catch { /* nothing further to try */ }
        try {
          await this.writeAtomic(dead + '.reason', `unparseable queue entry: ${String((e as Error)?.message || e)}\n`);
        } catch { /* the file itself is the record */ }
      }
    }
    return out;
  }

  /** Put a claimed entry back on the queue with a new due time (a deferral, or a graceful stop). */
  async release(claim: string, entry: QueueEntry): Promise<void> {
    entry.updatedAt = Date.now();
    const target = path.join(this.root, QUEUE, fileNameFor(entry));
    await this.writeAtomic(target, JSON.stringify(entry, null, 2));
    try { await fs.unlink(path.join(this.root, PROCESSING, claim)); } catch { /* already gone */ }
  }

  /** The message is finished: every recipient either delivered or permanently failed. */
  async complete(claim: string): Promise<void> {
    try { await fs.unlink(path.join(this.root, PROCESSING, claim)); } catch { /* already gone */ }
  }

  /** Retries exhausted (or a fatal condition). Kept forever, never deleted. */
  async deadLetter(claim: string, entry: QueueEntry, reason: string): Promise<void> {
    entry.deadReason = reason;
    entry.deadAt = Date.now();
    entry.updatedAt = entry.deadAt;
    await this.writeAtomic(
      path.join(this.root, DEAD, `${entry.deadAt}-${entry.messageId}.json`),
      JSON.stringify(entry, null, 2),
    );
    try { await fs.unlink(path.join(this.root, PROCESSING, claim)); } catch { /* already gone */ }
  }

  /**
   * Anything sitting in processing/ for longer than the lease belonged to a worker that died. Put it
   * back. Called on startup and periodically — this is what makes a `docker restart` non-lossy.
   */
  async recoverStale(leaseMs: number, now: number = Date.now()): Promise<number> {
    await this.init();
    let names: string[];
    try {
      names = (await fs.readdir(path.join(this.root, PROCESSING))).filter((n) => n.endsWith('.json'));
    } catch {
      return 0;
    }
    let recovered = 0;
    for (const name of names) {
      const full = path.join(this.root, PROCESSING, name);
      let stat;
      try { stat = await fs.stat(full); } catch { continue; }
      if (now - stat.mtimeMs < leaseMs) continue;
      try {
        const entry = JSON.parse(await fs.readFile(full, 'utf8')) as QueueEntry;
        // Due immediately: this message has already waited out a whole lease.
        entry.nextAttemptAt = now;
        entry.updatedAt = now;
        entry.lastError = entry.lastError || 'recovered from an interrupted delivery attempt';
        await this.writeAtomic(path.join(this.root, QUEUE, fileNameFor(entry)), JSON.stringify(entry, null, 2));
        await fs.unlink(full);
        // The orphan case: a worker that died between link() and unlink() left the original queue
        // entry in place too. Removing it here is what stops that crash becoming a second delivery.
        if (name !== fileNameFor(entry)) await fs.unlink(path.join(this.root, QUEUE, name)).catch(() => { /* not there, good */ });
        recovered += 1;
      } catch {
        // Unreadable: move it to dead/ rather than leaving it to be re-swept every minute.
        try { await fs.rename(full, path.join(this.root, DEAD, name)); } catch { /* leave it */ }
      }
    }
    return recovered;
  }

  async stats(now: number = Date.now()): Promise<MessageSpoolStats> {
    await this.init();
    const read = async (d: string) => {
      try { return (await fs.readdir(path.join(this.root, d))).filter((n) => n.endsWith('.json')); } catch { return []; }
    };
    const queue = await read(QUEUE);
    const processing = await read(PROCESSING);
    const dead = await read(DEAD);
    let ready = 0;
    let deferred = 0;
    for (const n of queue) (dueOf(n) <= now ? ready++ : deferred++);
    return { ready, deferred, processing: processing.length, dead: dead.length, total: queue.length + processing.length };
  }

  /** Dead letters, newest first — for the CLI and the ops view. */
  async listDead(limit = 100): Promise<QueueEntry[]> {
    await this.init();
    let names: string[];
    try {
      names = (await fs.readdir(path.join(this.root, DEAD))).filter((n) => n.endsWith('.json')).sort().reverse();
    } catch {
      return [];
    }
    const out: QueueEntry[] = [];
    for (const n of names.slice(0, limit)) {
      try { out.push(JSON.parse(await fs.readFile(path.join(this.root, DEAD, n), 'utf8')) as QueueEntry); } catch { /* skip */ }
    }
    return out;
  }

  /** Move a dead letter back onto the queue, due now. False when it was not there. */
  async requeueDead(messageId: string, now: number = Date.now()): Promise<boolean> {
    await this.init();
    let names: string[];
    try { names = await fs.readdir(path.join(this.root, DEAD)); } catch { return false; }
    const match = names.find((n) => n.includes(messageId) && n.endsWith('.json'));
    if (!match) return false;
    const full = path.join(this.root, DEAD, match);
    const entry = JSON.parse(await fs.readFile(full, 'utf8')) as QueueEntry;
    entry.nextAttemptAt = now;
    entry.attempt = 0;
    entry.updatedAt = now;
    delete entry.deadReason;
    delete entry.deadAt;
    await this.writeAtomic(path.join(this.root, QUEUE, fileNameFor(entry)), JSON.stringify(entry, null, 2));
    await fs.unlink(full);
    return true;
  }
}

export function newQueueEntry(message: OutboundMessage, recipients: string[], now = Date.now()): QueueEntry {
  return {
    messageId: message.messageId,
    message,
    pending: [...recipients],
    attempt: 0,
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
    lastError: null,
    history: [],
  };
}
