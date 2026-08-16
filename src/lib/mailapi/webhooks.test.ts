// src/lib/mailapi/webhooks.test.ts — signatures, retries, idempotency, the status machine, tracking.
//
// The signature assertions are the most important ones in this repository's mail code. An unsigned or
// weakly verified webhook is a POST endpoint on somebody else's server that anybody can forge, and
// "your application was rejected" is a message worth faking. Both SDKs and the docs describe the same
// signing string that is asserted here, so a divergence shows up as a failing test rather than as a
// customer whose verification silently accepts everything.
import { describe, it, expect } from 'vitest';
import {
  signPayload, signingString, verifySignature, mintWebhookSecret, webhookBackoffMs, classifyResponse,
  subscribes, isEventType, buildEnvelope, isPrivateIp, EVENT_TYPES,
} from './webhooks';
import {
  stableStringify, requestHash, decideIdempotency, assertIdempotencyKey, type StoredIdempotency,
} from './idempotency';
import { nextStatus, isTerminal, sendBackoffMs, isTransientSmtpError, publicMessage, mapMessage } from './messages';
import {
  signParts, verifyParts, b64urlEncode, b64urlDecode, injectOpenPixel, rewriteLinks,
  openPixelUrl, clickUrl, unsubscribeUrl, listUnsubscribeHeaders,
} from './tracking';
import { PAYLOAD_VERSION } from './schema';

const SECRET = 'whsec_test_secret_value_0123456789';
const NOW = Date.parse('2026-08-16T12:00:00Z');
const TS = Math.floor(NOW / 1000);

describe('webhook signatures', () => {
  const id = 'd290f1ee-6c54-4b01-90e6-d701748f0851';
  const body = JSON.stringify({ type: 'email.sent', data: { message_id: 'x' } });

  it('signs the documented string, and nothing else', () => {
    expect(signingString(id, TS, body)).toBe(id + '.' + TS + '.' + body);
    expect(signPayload(SECRET, id, TS, body).startsWith('v1,')).toBe(true);
  });

  it('verifies a signature it produced', () => {
    const sig = signPayload(SECRET, id, TS, body);
    expect(verifySignature({ secret: SECRET, id, timestamp: TS, signature: sig, body, nowMs: NOW })).toEqual({ ok: true });
  });

  it('refuses a tampered body, id, timestamp or secret', () => {
    const sig = signPayload(SECRET, id, TS, body);
    expect(verifySignature({ secret: SECRET, id, timestamp: TS, signature: sig, body: body + ' ', nowMs: NOW }).ok).toBe(false);
    expect(verifySignature({ secret: SECRET, id: 'other', timestamp: TS, signature: sig, body, nowMs: NOW }).ok).toBe(false);
    expect(verifySignature({ secret: SECRET, id, timestamp: TS - 1, signature: sig, body, nowMs: NOW }).ok).toBe(false);
    expect(verifySignature({ secret: 'whsec_other', id, timestamp: TS, signature: sig, body, nowMs: NOW }).ok).toBe(false);
  });

  it('rejects a replay outside the tolerance, in both directions', () => {
    const sig = signPayload(SECRET, id, TS, body);
    // Captured and resent six minutes later.
    expect(verifySignature({ secret: SECRET, id, timestamp: TS, signature: sig, body, nowMs: NOW + 360_000 }))
      .toEqual({ ok: false, reason: 'stale' });
    // A forged future timestamp is refused too, or a clock-ahead attacker gets an unbounded window.
    expect(verifySignature({ secret: SECRET, id, timestamp: TS + 600, signature: signPayload(SECRET, id, TS + 600, body), body, nowMs: NOW }))
      .toEqual({ ok: false, reason: 'future' });
    // Inside the tolerance it still verifies.
    expect(verifySignature({ secret: SECRET, id, timestamp: TS, signature: sig, body, nowMs: NOW + 290_000 }).ok).toBe(true);
  });

  it('rejects a missing or nonsense timestamp rather than treating it as zero', () => {
    const sig = signPayload(SECRET, id, TS, body);
    expect(verifySignature({ secret: SECRET, id, timestamp: 'nope', signature: sig, body, nowMs: NOW }).reason).toBe('bad_timestamp');
    expect(verifySignature({ secret: SECRET, id, timestamp: 0, signature: sig, body, nowMs: NOW }).reason).toBe('bad_timestamp');
  });

  it('accepts EITHER secret during a rotation overlap', () => {
    const older = 'whsec_previous_value_9876543210';
    const header = [signPayload(SECRET, id, TS, body), signPayload(older, id, TS, body)].join(' ');
    expect(verifySignature({ secret: SECRET, id, timestamp: TS, signature: header, body, nowMs: NOW }).ok).toBe(true);
    expect(verifySignature({ secret: older, id, timestamp: TS, signature: header, body, nowMs: NOW }).ok).toBe(true);
    expect(verifySignature({ secret: 'whsec_never', id, timestamp: TS, signature: header, body, nowMs: NOW }).ok).toBe(false);
  });

  it('mints distinct high-entropy secrets', () => {
    const secrets = new Set(Array.from({ length: 100 }, () => mintWebhookSecret()));
    expect(secrets.size).toBe(100);
    expect(mintWebhookSecret().startsWith('whsec_')).toBe(true);
    expect(mintWebhookSecret().length).toBeGreaterThan(40);
  });
});

describe('webhook retries and the dead-letter state', () => {
  it('backs off, and stops growing at twelve hours', () => {
    expect(webhookBackoffMs(0)).toBe(0);
    expect(webhookBackoffMs(1)).toBe(5_000);
    expect(webhookBackoffMs(2)).toBe(30_000);
    expect(webhookBackoffMs(4)).toBe(600_000);
    expect(webhookBackoffMs(8)).toBe(43_200_000);
    expect(webhookBackoffMs(99)).toBe(43_200_000);
    expect(webhookBackoffMs(-5)).toBe(0);
  });

  it('the eight attempts span more than half a day, so a maintenance window survives', () => {
    const total = Array.from({ length: 9 }, (_, i) => webhookBackoffMs(i)).reduce((a, b) => a + b, 0);
    expect(total / 3_600_000).toBeGreaterThan(12);
  });

  it('classifies responses the way a receiver would expect', () => {
    expect(classifyResponse(200)).toBe('delivered');
    expect(classifyResponse(204)).toBe('delivered');
    expect(classifyResponse(299)).toBe('delivered');
    expect(classifyResponse(410)).toBe('dead');   // Gone means stop, permanently
    expect(classifyResponse(500)).toBe('retry');
    expect(classifyResponse(404)).toBe('retry');  // a deploy in progress looks exactly like this
    expect(classifyResponse(301)).toBe('retry');  // a redirect is a misconfiguration, never followed
  });
});

describe('event subscription', () => {
  it('an empty list means everything, so a new event type is not silently dropped', () => {
    expect(subscribes([], 'email.bounced')).toBe(true);
    expect(subscribes(null, 'email.opened')).toBe(true);
  });

  it('matches exactly, by namespace, or by full wildcard', () => {
    expect(subscribes(['email.sent'], 'email.sent')).toBe(true);
    expect(subscribes(['email.sent'], 'email.bounced')).toBe(false);
    expect(subscribes(['email.*'], 'email.bounced')).toBe(true);
    expect(subscribes(['*'], 'email.complained')).toBe(true);
  });

  it('every documented event type is recognised, and invented ones are not', () => {
    for (const t of EVENT_TYPES) expect(isEventType(t), t).toBe(true);
    expect(isEventType('email.exploded')).toBe(false);
    expect(EVENT_TYPES).toContain('email.queued');
    expect(EVENT_TYPES).toContain('email.unsubscribed');
    expect(EVENT_TYPES).toContain('email.complained');
    expect(EVENT_TYPES.length).toBe(10);
  });

  it('the envelope is versioned, so a payload change is visible to a receiver', () => {
    const e = buildEnvelope({
      eventId: 'd290f1ee-6c54-4b01-90e6-d701748f0851',
      type: 'email.sent',
      createdAt: '2026-08-16T12:00:00.000Z',
      environment: 'production',
      orgSlug: 'careers',
      data: { message_id: 'abc' },
    });
    expect(e.api_version).toBe(PAYLOAD_VERSION);
    expect(e.id.startsWith('evt_')).toBe(true);
    expect(e.type).toBe('email.sent');
    expect(e.environment).toBe('production');
    expect(e.data.message_id).toBe('abc');
  });
});

describe('webhook URL safety', () => {
  it('recognises every private range an endpoint must not point at', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '172.31.255.255',
                      '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1']) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it('lets ordinary public addresses through', () => {
    for (const ip of ['8.8.8.8', '203.0.113.9', '172.32.0.1', '11.0.0.1', '2606:4700::1111']) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });
});

describe('idempotency', () => {
  it('hashes the MEANING, so a reordered serialisation is the same request', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(requestHash({ to: ['a@x.test'], subject: 'Hi' })).toBe(requestHash({ subject: 'Hi', to: ['a@x.test'] }));
    // Array order IS meaning — two recipients in a different order is a different message.
    expect(requestHash({ to: ['a@x.test', 'b@x.test'] })).not.toBe(requestHash({ to: ['b@x.test', 'a@x.test'] }));
    expect(requestHash({ a: 1 })).not.toBe(requestHash({ a: 2 }));
  });

  it('survives a circular structure instead of throwing', () => {
    const o: any = { a: 1 };
    o.self = o;
    expect(() => requestHash(o)).not.toThrow();
  });

  const stored = (over: Partial<StoredIdempotency> = {}): StoredIdempotency => ({
    id: 'x', requestHash: 'HASH', status: 'completed', messageId: 'm1',
    responseStatus: 202, responseJson: { id: 'm1' }, createdAt: new Date(NOW).toISOString(), ...over,
  });

  it('an unseen key proceeds', () => {
    expect(decideIdempotency(null, 'HASH')).toBe('proceed');
  });

  it('the SAME request replays the original response', () => {
    expect(decideIdempotency(stored(), 'HASH')).toBe('replay');
  });

  it('a DIFFERENT request under the same key is a conflict, not a guess', () => {
    expect(decideIdempotency(stored(), 'OTHER')).toBe('conflict');
    expect(decideIdempotency(stored({ status: 'in_progress' }), 'OTHER')).toBe('conflict');
  });

  it('a concurrent first call is in_progress, and a dead one is taken over', () => {
    expect(decideIdempotency(stored({ status: 'in_progress' }), 'HASH', { nowMs: NOW + 1000 })).toBe('in_progress');
    expect(decideIdempotency(stored({ status: 'in_progress' }), 'HASH', { nowMs: NOW + 300_000 })).toBe('proceed');
  });

  it('bounds the key a caller may supply', () => {
    expect(assertIdempotencyKey('  d290f1ee-6c54-4b01-90e6  ')).toBe('d290f1ee-6c54-4b01-90e6');
    expect(() => assertIdempotencyKey('short')).toThrow();
    expect(() => assertIdempotencyKey('x'.repeat(256))).toThrow();
    expect(() => assertIdempotencyKey('key-with-é-accent')).toThrow(/printable ASCII/);
  });
});

describe('message status machine', () => {
  it('moves forward through the documented statuses', () => {
    expect(nextStatus('queued', 'email.sent')).toBe('sent');
    expect(nextStatus('sent', 'email.delivered')).toBe('delivered');
    expect(nextStatus('queued', 'email.deferred')).toBe('deferred');
    expect(nextStatus('deferred', 'email.sent')).toBe('sent');
  });

  it('NEVER moves backwards — a late `sent` cannot undo a bounce', () => {
    expect(nextStatus('bounced', 'email.sent')).toBe('bounced');
    expect(nextStatus('delivered', 'email.sent')).toBe('delivered');
    expect(nextStatus('failed', 'email.queued')).toBe('failed');
    expect(nextStatus('sent', 'email.queued')).toBe('sent');
  });

  it('recipient events record without touching the status', () => {
    for (const t of ['email.opened', 'email.clicked', 'email.unsubscribed', 'email.complained']) {
      expect(nextStatus('sent', t), t).toBe('sent');
    }
  });

  it('knows which statuses are terminal', () => {
    expect(isTerminal('delivered')).toBe(true);
    expect(isTerminal('bounced')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('queued')).toBe(false);
    expect(isTerminal('deferred')).toBe(false);
  });
});

describe('SMTP retry classification', () => {
  it('retries what the receiving server asked us to come back for', () => {
    expect(isTransientSmtpError('Connection timeout')).toBe(true);
    expect(isTransientSmtpError('ECONNRESET')).toBe(true);
    expect(isTransientSmtpError('451 4.7.1 Greylisted, try again later')).toBe(true);
    expect(isTransientSmtpError('452 Too many recipients')).toBe(true);
  });

  it('does NOT retry a refusal — that is how a domain earns a reputation problem', () => {
    expect(isTransientSmtpError('550 5.1.1 User unknown')).toBe(false);
    expect(isTransientSmtpError('553 Relaying denied')).toBe(false);
    expect(isTransientSmtpError('')).toBe(false);
  });

  it('backs off between send attempts and stops growing', () => {
    expect(sendBackoffMs(0)).toBe(60_000);
    expect(sendBackoffMs(3)).toBe(3_600_000);
    expect(sendBackoffMs(50)).toBe(14_400_000);
  });
});

describe('the public message shape', () => {
  const row = {
    id: 'm1', org_id: 'o1', environment: 'production', status: 'sent', from_email: 'talent@edurankai.in',
    from_name: 'EduRankAI Talent', reply_to: null, to_emails: ['a@x.test'], cc_emails: [], bcc_emails: ['audit@x.test'],
    suppressed: [], subject: 'Stage 3', body_html: '<p>secret</p>', body_text: 'secret', template_key: 'internship-stage-update',
    template_version: 4, template_state: 'published', tags: ['careers'], metadata: { application_id: 'app_1' },
    attachments: [], scheduled_at: null, attempts: 1, last_error: null, queued_at: 'T', sent_at: 'T', created_at: 'T',
  };

  it('never leaks bcc or the rendered body by default', () => {
    const shape = publicMessage(mapMessage(row));
    expect(shape.bcc).toBeUndefined();
    expect(JSON.stringify(shape)).not.toContain('secret');
    expect(shape.to).toEqual(['a@x.test']);
    expect(shape.metadata).toEqual({ application_id: 'app_1' });
    expect(shape.template).toEqual({ key: 'internship-stage-update', version: 4, state: 'published' });
  });

  it('returns bcc only when explicitly asked', () => {
    expect(publicMessage(mapMessage(row), { includeBcc: true }).bcc).toEqual(['audit@x.test']);
  });
});

describe('tracking links', () => {
  const S = 'tracking-secret-value-1234567890';

  it('signs and verifies, and refuses a swapped destination', () => {
    const sig = signParts(S, 'click', 'm1', 'https://good.test/a');
    expect(verifyParts(S, sig, 'click', 'm1', 'https://good.test/a')).toBe(true);
    // The whole reason the destination is in the signature: otherwise this is an open redirect.
    expect(verifyParts(S, sig, 'click', 'm1', 'https://evil.test/a')).toBe(false);
    expect(verifyParts(S, sig, 'click', 'm2', 'https://good.test/a')).toBe(false);
    expect(verifyParts('other-secret', sig, 'click', 'm1', 'https://good.test/a')).toBe(false);
    expect(verifyParts(S, '', 'click', 'm1', 'https://good.test/a')).toBe(false);
    expect(verifyParts('', sig, 'click', 'm1', 'https://good.test/a')).toBe(false);
  });

  it('round-trips a base64url destination', () => {
    const url = 'https://x.test/a?b=c&d=e#f';
    expect(b64urlDecode(b64urlEncode(url))).toBe(url);
    expect(b64urlEncode(url)).not.toContain('+');
    expect(b64urlEncode(url)).not.toContain('/');
  });

  it('builds nothing at all when no signing key is configured', () => {
    expect(openPixelUrl('https://e.test', 'm1', '')).toBe(null);
    expect(clickUrl('https://e.test', 'm1', 'https://x.test', '')).toBe(null);
    expect(unsubscribeUrl('https://e.test', 'm1', 'a@x.test', '')).toBe(null);
  });

  it('builds signed URLs when it is', () => {
    expect(openPixelUrl('https://e.test/', 'm1', S)).toContain('/api/v1/email/track/open/m1.gif?s=');
    expect(clickUrl('https://e.test', 'm1', 'https://x.test/a', S)).toContain('/api/v1/email/track/click/m1?u=');
    expect(unsubscribeUrl('https://e.test', 'm1', 'A@X.test', S)).toContain('/api/v1/email/unsubscribe/m1?r=');
  });

  it('puts the pixel inside the body when there is one', () => {
    expect(injectOpenPixel('<html><body><p>hi</p></body></html>', 'PX')).toBe('<html><body><p>hi</p><img src="PX" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;" /></body></html>');
    expect(injectOpenPixel('<p>hi</p>', 'PX')).toContain('<p>hi</p><img src="PX"');
  });

  it('rewrites http links and leaves everything else alone', () => {
    const html = '<a href="https://x.test/a">A</a> <a href="mailto:b@x.test">B</a> <a href="#top">C</a> <a href="/rel">D</a>';
    const r = rewriteLinks(html, (t) => 'TRACK:' + t);
    expect(r.rewritten).toBe(1);
    expect(r.html).toContain('href="TRACK:https://x.test/a"');
    expect(r.html).toContain('href="mailto:b@x.test"');
    expect(r.html).toContain('href="#top"');
    expect(r.html).toContain('href="/rel"');
  });

  it('honours data-no-track, which is how the unsubscribe link stays uncounted', () => {
    const r = rewriteLinks('<a href="https://x.test/u" data-no-track>Unsubscribe</a>', (t) => 'TRACK:' + t);
    expect(r.rewritten).toBe(0);
    expect(r.html).toContain('href="https://x.test/u"');
  });

  it('emits the RFC 8058 one-click headers', () => {
    const h = listUnsubscribeHeaders('https://e.test/u');
    expect(h['List-Unsubscribe']).toBe('<https://e.test/u>');
    expect(h['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });
});
