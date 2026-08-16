// The durable queue. Section 15 of the brief asks for "server restart, queue persistence" — that is
// the last test in this file, and it is the one that matters: a queue that forgets on restart loses
// customer mail, and no amount of retry logic above it helps.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MessageSpool, newQueueEntry } from '../src/queue/message-spool.js';
import { tempDir, removeDir } from './helpers/harness.js';
import type { OutboundMessage } from '../src/contracts/index.js';

function message(id: string, to: string[] = ['a@example.com']): OutboundMessage {
  return { messageId: id, from: 'sender@edurankai.in', to, subject: 'Subject ' + id, text: 'body' };
}

describe('MessageSpool', () => {
  let dir: string;
  let spool: MessageSpool;

  beforeEach(async () => {
    dir = await tempDir('spool');
    spool = new MessageSpool(dir);
    await spool.init();
  });

  afterEach(async () => {
    await removeDir(dir);
  });

  it('enqueues and claims a message that is due', async () => {
    await spool.enqueue(newQueueEntry(message('m1'), ['a@example.com'], 1000));
    const claimed = await spool.claimBatch(10, 2000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].entry.messageId).toBe('m1');
    expect(claimed[0].entry.pending).toEqual(['a@example.com']);
  });

  it('does not claim a message whose next attempt is in the future', async () => {
    const entry = newQueueEntry(message('m1'), ['a@example.com'], 1000);
    entry.nextAttemptAt = 900_000;
    await spool.enqueue(entry);
    expect(await spool.claimBatch(10, 1000)).toHaveLength(0);
    expect(await spool.claimBatch(10, 900_001)).toHaveLength(1);
  });

  it('claims in due order, not insertion order', async () => {
    const later = newQueueEntry(message('later'), ['a@example.com'], 5000);
    const sooner = newQueueEntry(message('sooner'), ['a@example.com'], 1000);
    await spool.enqueue(later);
    await spool.enqueue(sooner);
    const claimed = await spool.claimBatch(10, 10_000);
    expect(claimed.map((c) => c.entry.messageId)).toEqual(['sooner', 'later']);
  });

  it('honours the batch limit', async () => {
    for (let i = 0; i < 5; i++) await spool.enqueue(newQueueEntry(message(`m${i}`), ['a@example.com'], 1000 + i));
    expect(await spool.claimBatch(2, 10_000)).toHaveLength(2);
    expect((await spool.stats(10_000)).ready).toBe(3);
  });

  it('gives a claimed message to exactly one caller, under a three-way race', async () => {
    // The property the whole design rests on: several workers, one message, one delivery. This test
    // is why the claim is link() and not rename() — the rename version passed on POSIX reasoning and
    // failed here, because two concurrent renames of the same source BOTH resolve on Windows.
    for (let i = 0; i < 40; i++) await spool.enqueue(newQueueEntry(message(`m${i}`), ['a@example.com'], 1000 + i));
    const batches = await Promise.all([
      spool.claimBatch(40, 5000), spool.claimBatch(40, 5000), spool.claimBatch(40, 5000),
    ]);
    const ids = batches.flat().map((c) => c.entry.messageId);
    expect(new Set(ids).size).toBe(ids.length);   // nobody got a message twice
    expect(ids).toHaveLength(40);                 // and nobody lost one
    expect((await spool.stats(5000)).dead).toBe(0); // a lost race is not corruption
  });

  it('does not duplicate a message when a worker dies between claiming and dequeuing', async () => {
    // The one hole link()-based claiming opens: the entry is briefly in queue/ AND processing/.
    // recoverStale() has to remove the orphan, or the crash costs a second delivery.
    const entry = newQueueEntry(message('m1'), ['a@example.com'], 1000);
    const name = await spool.enqueue(entry);
    await fs.link(path.join(spool.dir('queue'), name), path.join(spool.dir('processing'), name));
    // ...and the process dies here, before the unlink.

    expect(await spool.recoverStale(0, Date.now() + 1)).toBe(1);
    const claimed = await spool.claimBatch(10, Date.now() + 1000);
    expect(claimed).toHaveLength(1);
    expect((await spool.stats(Date.now() + 1000)).total).toBe(1);
  });

  it('release() puts a message back with its new due time', async () => {
    await spool.enqueue(newQueueEntry(message('m1'), ['a@example.com'], 1000));
    const [claimed] = await spool.claimBatch(1, 2000);
    claimed.entry.attempt = 1;
    claimed.entry.nextAttemptAt = 60_000;
    claimed.entry.lastError = '451 temporary';
    await spool.release(claimed.claim, claimed.entry);

    expect(await spool.claimBatch(1, 30_000)).toHaveLength(0);
    const [again] = await spool.claimBatch(1, 61_000);
    expect(again.entry.attempt).toBe(1);
    expect(again.entry.lastError).toBe('451 temporary');
  });

  it('complete() removes the message for good', async () => {
    await spool.enqueue(newQueueEntry(message('m1'), ['a@example.com'], 1000));
    const [claimed] = await spool.claimBatch(1, 2000);
    await spool.complete(claimed.claim);
    const stats = await spool.stats(10_000);
    expect(stats.total).toBe(0);
    expect(stats.dead).toBe(0);
  });

  it('dead-letters a message with its reason, and keeps it', async () => {
    await spool.enqueue(newQueueEntry(message('m1'), ['a@example.com'], 1000));
    const [claimed] = await spool.claimBatch(1, 2000);
    await spool.deadLetter(claimed.claim, claimed.entry, 'retries exhausted: 421 too many messages');

    const stats = await spool.stats(10_000);
    expect(stats.dead).toBe(1);
    expect(stats.total).toBe(0);
    const dead = await spool.listDead();
    expect(dead[0].deadReason).toContain('retries exhausted');
    expect(dead[0].messageId).toBe('m1');
  });

  it('requeues a dead letter on demand', async () => {
    await spool.enqueue(newQueueEntry(message('m1'), ['a@example.com'], 1000));
    const [claimed] = await spool.claimBatch(1, 2000);
    await spool.deadLetter(claimed.claim, claimed.entry, 'gave up');

    expect(await spool.requeueDead('m1', 5000)).toBe(true);
    expect(await spool.requeueDead('nope', 5000)).toBe(false);
    const [again] = await spool.claimBatch(1, 6000);
    expect(again.entry.messageId).toBe('m1');
    expect(again.entry.attempt).toBe(0);
    expect(again.entry.deadReason).toBeUndefined();
  });

  it('recovers a message from a worker that died mid-delivery', async () => {
    await spool.enqueue(newQueueEntry(message('m1'), ['a@example.com'], 1000));
    const [claimed] = await spool.claimBatch(1, 2000);
    expect((await spool.stats(3000)).processing).toBe(1);

    // Nothing releases it — the worker is gone. Before the lease expires it stays put; after, it
    // comes back and is due immediately.
    expect(await spool.recoverStale(600_000, Date.now())).toBe(0);
    expect(await spool.recoverStale(0, Date.now() + 1)).toBe(1);

    const [recovered] = await spool.claimBatch(1, Date.now() + 1000);
    expect(recovered.entry.messageId).toBe('m1');
    expect(recovered.entry.lastError).toContain('interrupted');
    void claimed;
  });

  it('quarantines an unparseable entry instead of tripping over it forever', async () => {
    await fs.writeFile(path.join(spool.dir('queue'), '000000000001000-broken.json'), '{ this is not json', 'utf8');
    await spool.enqueue(newQueueEntry(message('good'), ['a@example.com'], 1001));

    const claimed = await spool.claimBatch(10, 5000);
    expect(claimed.map((c) => c.entry.messageId)).toEqual(['good']);
    expect((await spool.stats(5000)).dead).toBe(1);
  });

  it('SURVIVES A RESTART: a new Spool over the same directory sees the same queue', async () => {
    await spool.enqueue(newQueueEntry(message('m1', ['a@example.com', 'b@example.com']), ['a@example.com', 'b@example.com'], 1000));
    await spool.enqueue(newQueueEntry(message('m2'), ['c@example.com'], 1001));
    const [claimed] = await spool.claimBatch(1, 2000);
    claimed.entry.attempt = 2;
    claimed.entry.pending = ['b@example.com'];      // a partial delivery, mid-flight
    await spool.release(claimed.claim, claimed.entry);

    // The process ends here. Everything below is what a fresh boot sees.
    const rebooted = new MessageSpool(dir);
    const stats = await rebooted.stats(10_000);
    expect(stats.ready).toBe(2);

    const after = await rebooted.claimBatch(10, 10_000);
    const m1 = after.find((c) => c.entry.messageId === 'm1')!;
    expect(m1.entry.attempt).toBe(2);
    expect(m1.entry.pending).toEqual(['b@example.com']);   // the delivered recipient is not re-sent
    expect(m1.entry.message.subject).toBe('Subject m1');
  });
});
