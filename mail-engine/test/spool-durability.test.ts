// mail-engine/test/spool-durability.test.ts — the queue-recovery test from Patch 16 section 18.
//
// These are the guarantees the outbound spool is supposed to give, exercised against a REAL
// filesystem rather than a mock. A mocked filesystem cannot fail the way the real one does, and
// every property here is about what survives a process that stops without warning:
//
//   1. An accepted message is on disk before enqueue() resolves.
//   2. A second process cannot claim an entry the first one already holds.
//   3. A worker that dies mid-delivery loses its lease, not its message.
//   4. Retries are scheduled, not immediate, and stop at the ceiling.
//   5. Debris in tmp/ from a crash mid-write is swept and never mistaken for mail.
//   6. The same message submitted twice is spooled once.
//
// "A process that dies" is simulated by constructing a second Spool over the same directory and
// never telling the first one anything — which is exactly what a crash looks like to the survivor.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Spool,
  newQueueEntry,
  isDue,
  leaseExpired,
  describeStats,
  DEFAULT_RETRY_POLICY,
  type QueueEntry,
} from '../src/queue/spool.js';
import type { OutboundMessage } from '../src/contracts/index.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'era-spool-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function message(id: string, to = 'someone@example.test'): OutboundMessage {
  return {
    messageId: id,
    from: 'noreply@edurankai.in',
    to: [to],
    subject: 'test',
    text: 'body',
  };
}

function spool(over: { now?: () => number; workerId?: string; leaseMs?: number; random?: () => number } = {}) {
  return new Spool({
    root,
    policy: { ...DEFAULT_RETRY_POLICY, maxAttempts: 3, baseDelayMs: 1000, factor: 2, maxDelayMs: 60_000, jitter: 0 },
    leaseMs: over.leaseMs ?? 60_000,
    workerId: over.workerId,
    now: over.now,
    random: over.random ?? (() => 0),
  });
}

describe('durability', () => {
  it('an accepted message is on disk when enqueue resolves', async () => {
    const s = spool();
    const result = await s.enqueue(newQueueEntry(message('m1'), ['someone@example.test'], 1000));
    expect(result.deduped).toBe(false);

    // Read it back through a DIFFERENT Spool instance: nothing in memory helped.
    const survivor = spool();
    const entries = await survivor.list('queued');
    expect(entries).toHaveLength(1);
    expect(entries[0].messageId).toBe('m1');
    expect(entries[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports which durability guarantee it is actually giving', async () => {
    const s = spool();
    await s.enqueue(newQueueEntry(message('m1'), ['a@example.test'], 1000));
    const stats = await s.stats();
    // 'full' on Linux, 'file-only' on a Windows host. Both are honest answers; 'unknown' after a
    // write would mean the durability probe never ran, which is the one unacceptable result.
    expect(['full', 'file-only']).toContain(stats.durability);
  });

  it('spools the same message once, however many times it is submitted', async () => {
    const s = spool();
    await s.enqueue(newQueueEntry(message('same'), ['a@example.test'], 1000));
    const second = await s.enqueue(newQueueEntry(message('same'), ['a@example.test'], 2000));
    expect(second.deduped).toBe(true);
    expect(await s.list('queued')).toHaveLength(1);
  });

  it('still deduplicates against a message that has already been delivered', async () => {
    const s = spool();
    await s.enqueue(newQueueEntry(message('sent-already'), ['a@example.test'], 1000));
    const [claimed] = await s.claim();
    await s.complete(claimed.id);
    expect(await s.list('sent')).toHaveLength(1);

    const again = await s.enqueue(newQueueEntry(message('sent-already'), ['a@example.test'], 5000));
    expect(again.deduped).toBe(true);
    expect(await s.list('queued')).toHaveLength(0);
  });
});

describe('claiming', () => {
  it('only one worker gets an entry', async () => {
    const a = spool({ workerId: 'w-a' });
    const b = spool({ workerId: 'w-b' });
    await a.enqueue(newQueueEntry(message('m1'), ['a@example.test'], 1000));

    const [first, second] = await Promise.all([a.claim(), b.claim()]);
    const total = first.length + second.length;
    expect(total).toBe(1);
  });

  it('does not claim an entry that is not due yet', async () => {
    const now = 10_000;
    const s = spool({ now: () => now });
    const entry = newQueueEntry(message('later'), ['a@example.test'], now);
    entry.nextAttemptAt = now + 60_000;
    await s.enqueue(entry);

    expect(await s.claim()).toHaveLength(0);
    const stats = await s.stats();
    expect(stats.queued).toBe(1);
    expect(stats.due).toBe(0);
    expect(describeStats(stats)).toContain('0 due');
    expect(describeStats(stats)).toContain('1 deferred');
  });

  it('refuses to send an entry whose bytes changed under it', async () => {
    const s = spool();
    await s.enqueue(newQueueEntry(message('tampered'), ['a@example.test'], 1000));
    const [id] = (await readdir(join(root, 'queued'))).map((n) => n.replace(/\.json$/, ''));

    const raw: QueueEntry = (await s.read('queued', id))!;
    raw.message.subject = 'changed after acceptance';
    await writeFile(join(root, 'queued', `${id}.json`), JSON.stringify(raw), 'utf8');

    expect(await s.claim()).toHaveLength(0);
    const failed = await s.list('failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].lastError).toMatch(/checksum mismatch/i);
  });
});

describe('crash recovery', () => {
  it('a worker that dies mid-delivery loses its lease, not its message', async () => {
    let now = 1_000_000;
    const dying = spool({ workerId: 'w-dies', leaseMs: 30_000, now: () => now });
    await dying.enqueue(newQueueEntry(message('m1'), ['a@example.test'], now));

    const claimed = await dying.claim();
    expect(claimed).toHaveLength(1);
    // ...and now the process is gone. Nothing calls complete(), defer() or fail().

    const survivor = spool({ workerId: 'w-survives', leaseMs: 30_000, now: () => now });

    // While the lease is live, the entry is left alone: the other worker may still be delivering.
    now += 10_000;
    let recovered = await survivor.reclaim();
    expect(recovered.reclaimed).toHaveLength(0);
    expect(recovered.stillLeased).toBe(1);

    // Once it expires, the entry comes back and is delivered by somebody else.
    now += 30_000;
    recovered = await survivor.reclaim();
    expect(recovered.reclaimed).toHaveLength(1);

    const requeued = await survivor.list('queued');
    expect(requeued).toHaveLength(1);
    expect(requeued[0].messageId).toBe('m1');
    expect(requeued[0].lastError).toMatch(/lease expired/i);
    expect(await survivor.claim()).toHaveLength(1);
  });

  it('an unreadable entry in sending/ is preserved for a human, not deleted', async () => {
    const s = spool();
    await s.enqueue(newQueueEntry(message('m1'), ['a@example.test'], 1000));
    const [claimed] = await s.claim();
    await writeFile(join(root, 'sending', `${claimed.id}.json`), 'not json at all', 'utf8');

    await s.reclaim();
    expect(await readdir(join(root, 'failed'))).toHaveLength(1);
  });

  it('sweeps debris from a crash mid-write, and only debris', async () => {
    const now = 1_000_000;
    const s = spool({ now: () => now });
    await s.enqueue(newQueueEntry(message('good'), ['a@example.test'], now));
    await writeFile(join(root, 'tmp', 'half-written.json'), '{"partial":', 'utf8');

    expect((await s.stats()).orphanedTmp).toBe(1);

    // Not swept while it could still be a write in progress. The age floor is measured against the
    // file's mtime on the real clock, so this case is asserted with a real threshold rather than by
    // advancing the injected one.
    expect(await s.sweepTmp(60 * 60 * 1000)).toBe(0);

    // Old enough: swept. And the queued entry, which lives in queued/ rather than tmp/, is untouched.
    expect(await s.sweepTmp(0)).toBe(1);
    expect((await s.stats()).orphanedTmp).toBe(0);
    expect((await s.stats()).queued).toBe(1);
  });
});

describe('retry and dead-lettering', () => {
  it('a deferral schedules the next attempt rather than retrying immediately', async () => {
    const now = 1_000_000;
    const s = spool({ now: () => now });
    await s.enqueue(newQueueEntry(message('m1'), ['a@example.test'], now));
    const [claimed] = await s.claim();

    expect(await s.defer(claimed.id, '451 greylisted, try later', 451)).toBe('retry');

    const [requeued] = await s.list('queued');
    expect(requeued.attempts).toBe(1);
    expect(requeued.lastSmtpCode).toBe(451);
    expect(isDue(requeued, now)).toBe(false);
    expect(requeued.nextAttemptAt).toBe(now + 1000); // base delay, jitter pinned to 0
    expect(await s.claim()).toHaveLength(0);
  });

  it('dead-letters at the attempt ceiling instead of retrying forever', async () => {
    let now = 1_000_000;
    const s = spool({ now: () => now });
    await s.enqueue(newQueueEntry(message('m1'), ['a@example.test'], now));

    let outcome: string = 'retry';
    for (let i = 0; i < 5 && outcome === 'retry'; i++) {
      now += 10 * 60 * 1000;
      const [claimed] = await s.claim();
      expect(claimed, `no entry claimable on attempt ${i + 1}`).toBeTruthy();
      outcome = await s.defer(claimed.id, '421 service unavailable', 421);
    }

    expect(outcome).toBe('dead_lettered');
    const failed = await s.list('failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].attempts).toBe(3); // maxAttempts in this fixture
    expect(await s.list('queued')).toHaveLength(0);
  });

  it('a hard failure goes straight to failed/ with no retry', async () => {
    const s = spool();
    await s.enqueue(newQueueEntry(message('m1'), ['nobody@example.test'], 1000));
    const [claimed] = await s.claim();
    await s.fail(claimed.id, '550 5.1.1 no such user', 550);

    expect(await s.list('queued')).toHaveLength(0);
    const [failed] = await s.list('failed');
    expect(failed.lastSmtpCode).toBe(550);
  });

  it('a partial delivery does not re-send to recipients who already got it', async () => {
    const now = 1_000_000;
    const s = spool({ now: () => now });
    await s.enqueue(newQueueEntry(message('bulk'), ['a@example.test', 'b@example.test', 'c@example.test'], now));
    const [claimed] = await s.claim();

    const outcome = await s.deferRemaining(claimed.id, ['a@example.test', 'b@example.test'], '451 greylisted', 451);
    expect(outcome).toBe('retry');

    const [requeued] = await s.list('queued');
    expect(requeued.recipients).toEqual(['c@example.test']);
  });

  it('reports complete when a partial deferral turns out to have covered everyone', async () => {
    const s = spool();
    await s.enqueue(newQueueEntry(message('all-done'), ['a@example.test'], 1000));
    const [claimed] = await s.claim();
    expect(await s.deferRemaining(claimed.id, ['A@Example.Test'], 'ok', 250)).toBe('complete');
    expect(await s.list('sent')).toHaveLength(1);
  });

  it('a dead-lettered entry is requeued only by an explicit act', async () => {
    const s = spool();
    await s.enqueue(newQueueEntry(message('m1'), ['a@example.test'], 1000));
    const [claimed] = await s.claim();
    await s.fail(claimed.id, '550 rejected', 550);

    const [failed] = await s.list('failed');
    expect(await s.requeueFailed(failed.id)).toBe(true);

    const [back] = await s.list('queued');
    expect(back.attempts).toBe(0);
    expect(await s.requeueFailed('no-such-id')).toBe(false);
  });
});

describe('retention', () => {
  it('prunes delivered entries and never touches dead-lettered ones', async () => {
    let now = 1_000_000;
    const s = spool({ now: () => now });

    await s.enqueue(newQueueEntry(message('delivered'), ['a@example.test'], now));
    const [ok] = await s.claim();
    await s.complete(ok.id);

    await s.enqueue(newQueueEntry(message('dead'), ['b@example.test'], now));
    const [bad] = await s.claim();
    await s.fail(bad.id, '550 rejected', 550);

    now += 8 * 24 * 60 * 60 * 1000;
    expect(await s.pruneSent(7 * 24 * 60 * 60 * 1000)).toBe(1);
    expect(await s.list('sent')).toHaveLength(0);
    expect(await s.list('failed')).toHaveLength(1);
  });
});

describe('pure predicates', () => {
  it('an entry with no lease is treated as reclaimable', () => {
    expect(leaseExpired({ leaseUntil: null }, 0)).toBe(true);
    expect(leaseExpired({ leaseUntil: 100 }, 99)).toBe(false);
    expect(leaseExpired({ leaseUntil: 100 }, 100)).toBe(true);
  });

  it('due is inclusive of the scheduled moment', () => {
    expect(isDue({ nextAttemptAt: 100 }, 100)).toBe(true);
    expect(isDue({ nextAttemptAt: 101 }, 100)).toBe(false);
  });
});
