// The engine API, end to end: a real HTTP server, real signatures, a real spool underneath.
//
// This is the seam Patch 1 calls and the seam Postfix pipes into, so the tests are written from the
// caller's side — what status code comes back, and what is true afterwards.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { createEngine, type Engine } from '../src/engine.js';
import { createEngineServer } from '../src/server.js';
import { signBody, SIGNATURE_HEADER, TIMESTAMP_HEADER } from '../src/publish/http.js';
import { tempDir, removeDir } from './helpers/harness.js';

const SECRET = 'engine-api-secret';

describe('the engine API', () => {
  let dir: string;
  let engine: Engine;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    dir = await tempDir('server');
    engine = createEngine({
      MAIL_HOSTNAME: 'mail.test.invalid',
      MAIL_DOMAINS: 'edurankai.in',
      MAIL_SPOOL_DIR: dir,
      MAIL_DKIM_KEY_DIR: dir + '/keys',
      MAIL_APP_SHARED_SECRET: SECRET,
      MAIL_INBOUND_SECRET: 'inbound-secret',
      MAIL_DELIVERY_ENABLED: 'false',
      MAIL_LOG_LEVEL: 'error',
    } as NodeJS.ProcessEnv);
    server = createEngineServer(engine);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await engine.transport.close();
    await removeDir(dir);
  });

  const signedPost = (path: string, body: string, headers: Record<string, string> = {}) => {
    const timestamp = String(Date.now());
    return fetch(base + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [TIMESTAMP_HEADER]: timestamp,
        [SIGNATURE_HEADER]: signBody(SECRET, timestamp, body),
        ...headers,
      },
      body,
    });
  };

  it('GET /healthz answers without a signature and reports what is not working', async () => {
    // A probe must not need a secret, and an engine that cannot deliver should say so out loud
    // rather than looking healthy while queueing everything forever.
    const res = await fetch(base + '/healthz');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.hostname).toBe('mail.test.invalid');
    expect(body.deliveryEnabled).toBe(false);
    expect(body.warnings.join(' ')).toContain('MAIL_DELIVERY_ENABLED is off');
    expect(body.dkim).toEqual([{ domain: 'edurankai.in', signed: false, selector: 'era1', dnsName: 'era1._domainkey.edurankai.in' }]);
  });

  it('POST /submit queues a message and answers 202, not 200', async () => {
    // 202: accepted for delivery. A 200 would claim something nobody can honour yet.
    const res = await signedPost('/submit', JSON.stringify({
      from: 'noreply@edurankai.in', to: ['learner@example.com'], subject: 'Hello', text: 'Hi',
    }));
    const body = await res.json();
    expect(res.status).toBe(202);
    expect(body.queued).toEqual(['learner@example.com']);
    expect((await engine.spool.stats()).ready).toBe(1);
  });

  it('POST /submit answers 422 for a message it will not send', async () => {
    const res = await signedPost('/submit', JSON.stringify({
      from: 'attacker@gmail.com', to: ['victim@example.com'], subject: 'Hello', text: 'Hi',
    }));
    expect(res.status).toBe(422);
    expect((await res.json()).issues[0].problem).toContain('only sends as');
    expect((await engine.spool.stats()).total).toBe(0);
  });

  it('refuses an unsigned, mis-signed or stale request', async () => {
    const body = JSON.stringify({ from: 'noreply@edurankai.in', to: ['a@example.com'], subject: 'x', text: 'y' });

    const unsigned = await fetch(base + '/submit', { method: 'POST', body, headers: { 'content-type': 'application/json' } });
    expect(unsigned.status).toBe(401);

    const timestamp = String(Date.now());
    const wrong = await fetch(base + '/submit', {
      method: 'POST', body,
      headers: { [TIMESTAMP_HEADER]: timestamp, [SIGNATURE_HEADER]: signBody('not-the-secret', timestamp, body) },
    });
    expect(wrong.status).toBe(401);

    // Replay protection: a captured request stops working once it is old.
    const old = String(Date.now() - 10 * 60 * 1000);
    const stale = await fetch(base + '/submit', {
      method: 'POST', body,
      headers: { [TIMESTAMP_HEADER]: old, [SIGNATURE_HEADER]: signBody(SECRET, old, body) },
    });
    expect(stale.status).toBe(401);
    expect((await engine.spool.stats()).total).toBe(0);
  });

  it('POST /inbound accepts a message for a hosted domain', async () => {
    const raw = 'From: a@example.com\r\nTo: admissions@edurankai.in\r\nSubject: hi\r\n\r\nhello';
    const res = await signedPost('/inbound', raw, {
      'content-type': 'message/rfc822',
      'x-mail-to': 'admissions@edurankai.in',
      'x-mail-from': 'a@example.com',
    });
    expect(res.status).toBe(200);
    expect((await res.json()).delivered).toEqual(['admissions@edurankai.in']);
    // The application is not running in this test, so the message is held on disk — accepted, not lost.
    expect(await engine.inbound.pending()).toBe(1);
  });

  it('POST /inbound answers 550 for relay and 400 with no recipient', async () => {
    const raw = 'From: a@example.com\r\nTo: b@elsewhere.com\r\nSubject: hi\r\n\r\nhello';
    const relay = await signedPost('/inbound', raw, { 'x-mail-to': 'b@elsewhere.com', 'x-mail-from': 'a@example.com' });
    // 550 so the piping MTA gives up rather than retrying an address we will never host.
    expect(relay.status).toBe(550);

    const noRecipient = await signedPost('/inbound', raw, { 'x-mail-from': 'a@example.com' });
    expect(noRecipient.status).toBe(400);
  });

  it('GET /metrics renders Prometheus text with the queue depth sampled from disk', async () => {
    await signedPost('/submit', JSON.stringify({
      from: 'noreply@edurankai.in', to: ['a@example.com'], subject: 'Hello', text: 'Hi',
    }));
    const res = await fetch(base + '/metrics');
    const text = await res.text();
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(text).toContain('# TYPE mail_queue_depth gauge');
    expect(text).toMatch(/mail_queue_depth 1/);
    expect(text).toContain('mail_outbound_submitted_total');
  });

  it('GET /suppressions and DELETE /suppressions/:address work end to end', async () => {
    await engine.publisher.suppress({
      recipient: 'gone@example.com', reason: 'invalid_mailbox', permanent: true, expiresAt: null,
      createdAt: new Date().toISOString(), lastEventId: 'e1', detail: '550 user unknown',
    });

    const list = await (await fetch(base + '/suppressions', { headers: signedHeaders('') })).json();
    expect(list.entries[0].recipient).toBe('gone@example.com');

    const removed = await fetch(base + '/suppressions/gone%40example.com', { method: 'DELETE', headers: signedHeaders('') });
    expect(removed.status).toBe(200);
    expect(await engine.publisher.isSuppressed('gone@example.com')).toBe(false);
  });

  it('answers 404 for a route that does not exist', async () => {
    const res = await fetch(base + '/nope', { headers: signedHeaders('') });
    expect(res.status).toBe(404);
  });

  function signedHeaders(body: string): Record<string, string> {
    const timestamp = String(Date.now());
    return { [TIMESTAMP_HEADER]: timestamp, [SIGNATURE_HEADER]: signBody(SECRET, timestamp, body) };
  }
});
