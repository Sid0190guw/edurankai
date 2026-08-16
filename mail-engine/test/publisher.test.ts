// The event contract with the application: signing, and the durability that makes an offline
// application a delay rather than a data loss.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HttpDeliveryEventPublisher, signBody, verifySignature, SIGNATURE_HEADER, TIMESTAMP_HEADER } from '../src/publish/http.js';
import { Outbox } from '../src/queue/outbox.js';
import { makeEvent } from '../src/events.js';
import { testConfig, testLogger, tempDir, removeDir } from './helpers/harness.js';
import type { DeliveryEvent } from '../src/contracts/index.js';

function event(over: Partial<Parameters<typeof makeEvent>[0]> = {}): DeliveryEvent {
  return makeEvent({
    kind: 'delivered', stage: 'smtp', messageId: 'm1', from: 'noreply@edurankai.in',
    recipient: 'learner@example.com', attempt: 1, ...over,
  });
}

describe('the HMAC contract', () => {
  it('signs the timestamp and the body together', () => {
    const sig = signBody('secret', '1700000000000', '{"events":[]}');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(verifySignature('secret', '1700000000000', '{"events":[]}', sig)).toBe(true);
  });

  it('rejects a modified body, a modified timestamp and the wrong secret', () => {
    const sig = signBody('secret', '1700000000000', '{"events":[]}');
    // Replay protection depends on the timestamp being covered; tamper protection on the body being
    // covered. Both are asserted because either omission looks fine until it is exploited.
    expect(verifySignature('secret', '1700000000000', '{"events":[1]}', sig)).toBe(false);
    expect(verifySignature('secret', '1700000000001', '{"events":[]}', sig)).toBe(false);
    expect(verifySignature('other', '1700000000000', '{"events":[]}', sig)).toBe(false);
    expect(verifySignature('secret', '1700000000000', '{"events":[]}', '')).toBe(false);
  });
});

describe('HttpDeliveryEventPublisher', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await tempDir('publisher');
  });

  afterEach(async () => {
    await removeDir(dir);
  });

  const publisherWith = (fetchImpl: typeof fetch, env: Record<string, string> = {}) => new HttpDeliveryEventPublisher({
    config: testConfig({ MAIL_SPOOL_DIR: dir, ...env }),
    logger: testLogger().logger,
    fetchImpl,
    now: () => 1_700_000_000_000,
  });

  it('POSTs a signed batch and clears the outbox on success', async () => {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const publisher = publisherWith((async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), headers: init.headers as Record<string, string>, body: String(init.body) });
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch);

    await publisher.publish([event(), event({ kind: 'bounced' })]);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://127.0.0.1:4321/api/mail/engine/events');
    expect(verifySignature('test-secret', calls[0].headers[TIMESTAMP_HEADER], calls[0].body, calls[0].headers[SIGNATURE_HEADER])).toBe(true);
    expect(JSON.parse(calls[0].body).events).toHaveLength(2);
    expect(await publisher.pending()).toBe(0);
  });

  it('KEEPS EVERY EVENT when the application is unreachable', async () => {
    // Section 13 of the brief. The laptop goes offline; the facts do not stop being true.
    const publisher = publisherWith((async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch);
    await publisher.publish([event(), event({ kind: 'deferred' })]);
    expect(await publisher.pending()).toBe(2);
  });

  it('delivers the backlog once the application comes back', async () => {
    let up = false;
    const seen: DeliveryEvent[] = [];
    const publisher = publisherWith((async (_url: string, init: RequestInit) => {
      if (!up) throw new Error('ECONNREFUSED');
      seen.push(...JSON.parse(String(init.body)).events);
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch);

    await publisher.publish([event({ messageId: 'a' }), event({ messageId: 'b' })]);
    expect(await publisher.pending()).toBe(2);

    up = true;
    expect(await publisher.flush()).toBe(2);
    expect(seen.map((e) => e.messageId)).toEqual(['a', 'b']);   // and in the order they happened
    expect(await publisher.pending()).toBe(0);
  });

  it('holds events rather than discarding them when the receiver is not ready (503)', async () => {
    // This is exactly the answer the application gives while Patch 1's tables do not exist yet.
    const publisher = publisherWith((async () => new Response('contract_not_ready', { status: 503 })) as unknown as typeof fetch);
    await publisher.publish([event()]);
    expect(await publisher.pending()).toBe(1);
  });

  it('parks an event the receiver will never accept, instead of looping on it forever', async () => {
    const publisher = publisherWith((async () => new Response('unknown field', { status: 422 })) as unknown as typeof fetch);
    await publisher.publish([event()]);
    expect(await publisher.pending()).toBe(0);
    // Parked, not deleted: the evidence is still on disk.
    const outbox = new Outbox<DeliveryEvent>(dir, 'events');
    expect(await outbox.rejectedSize()).toBe(1);
  });

  it('does not POST unsigned events when no secret is configured', async () => {
    let called = false;
    const publisher = publisherWith((async () => { called = true; return new Response('', { status: 200 }); }) as unknown as typeof fetch,
      { MAIL_APP_SHARED_SECRET: '' });
    await publisher.publish([event()]);
    expect(called).toBe(false);
    expect(await publisher.pending()).toBe(1);   // held, not thrown away
  });

  it('survives a restart with its outbox intact', async () => {
    const offline = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    await publisherWith(offline).publish([event({ messageId: 'survivor' })]);

    // A brand new publisher over the same spool directory — this is what a container restart is.
    const seen: DeliveryEvent[] = [];
    const rebooted = publisherWith((async (_u: string, init: RequestInit) => {
      seen.push(...JSON.parse(String(init.body)).events);
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch);
    expect(await rebooted.pending()).toBe(1);
    await rebooted.flush();
    expect(seen[0].messageId).toBe('survivor');
  });
});

describe('the suppression mirror', () => {
  let dir: string;

  beforeEach(async () => { dir = await tempDir('suppression'); });
  afterEach(async () => { await removeDir(dir); });

  const publisherWith = (now: () => number, fetchImpl?: typeof fetch) => new HttpDeliveryEventPublisher({
    config: testConfig({ MAIL_SPOOL_DIR: dir, MAIL_APP_SHARED_SECRET: '' }),
    logger: testLogger().logger,
    fetchImpl: fetchImpl || ((async () => new Response('', { status: 200 })) as unknown as typeof fetch),
    now,
  });

  it('answers from local disk, so a suppression survives the application being down', async () => {
    const publisher = publisherWith(() => 1_000_000);
    await publisher.suppress({
      recipient: 'Gone@Example.com', reason: 'invalid_mailbox', permanent: true, expiresAt: null,
      createdAt: new Date(1_000_000).toISOString(), lastEventId: 'e1', detail: '550 user unknown',
    });

    expect(await publisher.isSuppressed('gone@example.com')).toBe(true);
    expect(await publisher.isSuppressed('GONE@EXAMPLE.COM')).toBe(true);
    expect(await publisher.isSuppressed('someone-else@example.com')).toBe(false);

    // A fresh instance reads the same file — this is what makes it survive a restart.
    expect(await publisherWith(() => 1_000_000).isSuppressed('gone@example.com')).toBe(true);
  });

  it('lets a temporary suppression expire on its own', async () => {
    let clock = 1_000_000;
    const publisher = publisherWith(() => clock);
    await publisher.suppress({
      recipient: 'full@example.com', reason: 'mailbox_full', permanent: false,
      expiresAt: new Date(clock + 60_000).toISOString(),
      createdAt: new Date(clock).toISOString(), lastEventId: 'e1', detail: null,
    });
    expect(await publisher.isSuppressed('full@example.com')).toBe(true);
    clock += 61_000;
    expect(await publisher.isSuppressed('full@example.com')).toBe(false);
    expect(await publisher.listSuppressions()).toHaveLength(0);   // and it cleans up after itself
  });

  it('never downgrades a permanent entry to a temporary one', async () => {
    const publisher = publisherWith(() => 1_000_000);
    const base = { recipient: 'gone@example.com', createdAt: new Date().toISOString(), lastEventId: 'e', detail: null };
    await publisher.suppress({ ...base, reason: 'invalid_mailbox', permanent: true, expiresAt: null });
    await publisher.suppress({ ...base, reason: 'rate_limited', permanent: false, expiresAt: new Date(1_000_001).toISOString() });
    expect((await publisher.listSuppressions())[0].permanent).toBe(true);
  });

  it('can be cleared by hand for an address that is fine again', async () => {
    const publisher = publisherWith(() => 1_000_000);
    await publisher.suppress({
      recipient: 'fixed@example.com', reason: 'invalid_mailbox', permanent: true, expiresAt: null,
      createdAt: new Date().toISOString(), lastEventId: 'e1', detail: null,
    });
    expect(await publisher.unsuppress('fixed@example.com')).toBe(true);
    expect(await publisher.isSuppressed('fixed@example.com')).toBe(false);
    expect(await publisher.unsuppress('never-listed@example.com')).toBe(false);
  });
});
