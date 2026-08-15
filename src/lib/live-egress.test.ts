// src/lib/live-egress.test.ts — the pure half, tested without a network or credentials.
//
// The point of these is the CLASSIFICATION. A dead consent, a channel that is not allowed to
// stream, an exhausted allowance and "you pressed go-live before the encoder connected" have four
// different fixes, and collapsing them into "something went wrong" turns every one into a support
// ticket at the moment a class was supposed to start.
import { describe, it, expect } from 'vitest';
import {
  refusalOf, isAlreadyThere, encoderAddress, isLive, isTransitioning,
  classBroadcastBody, liveEgressStatus, platformCredentials,
} from './live-egress';

describe('refusalOf', () => {
  it('names an expired consent, because that is the one nobody guesses', () => {
    const r = refusalOf(400, { error: 'invalid_grant' });
    expect(r.kind).toBe('auth_expired');
    expect(r.reason).toMatch(/authorised again/i);
  });

  it('treats a 401 as an expired connection, not a mystery', () => {
    expect(refusalOf(401, {}).kind).toBe('auth_expired');
  });

  it('separates a channel that may not stream from a generic refusal', () => {
    const r = refusalOf(403, { error: { errors: [{ reason: 'livePermissionBlocked' }] } });
    expect(r.kind).toBe('not_permitted');
    expect(r.reason).toMatch(/live streaming is enabled/i);
  });

  it('recognises an exhausted daily allowance and says it resets', () => {
    const r = refusalOf(403, { error: { errors: [{ reason: 'quotaExceeded' }] } });
    expect(r.kind).toBe('quota');
    expect(r.reason).toMatch(/resets/i);
  });

  it('recognises going live before the encoder started', () => {
    const r = refusalOf(403, { error: { errors: [{ reason: 'errorStreamInactive' }] } });
    expect(r.kind).toBe('stream_inactive');
    expect(r.reason).toMatch(/start the encoder/i);
  });

  it('treats "already in that state" as its own thing, so a caller can call it success', () => {
    const r = refusalOf(400, { error: { errors: [{ reason: 'redundantTransition' }] } });
    expect(isAlreadyThere(r)).toBe(true);
  });

  it('does not mistake an ordinary failure for "already done"', () => {
    expect(isAlreadyThere(refusalOf(500, {}))).toBe(false);
  });

  it('survives a body that is not json at all', () => {
    const r = refusalOf(502, '<html>gateway</html>');
    expect(r.kind).toBe('upstream');
    expect(r.reason.length).toBeGreaterThan(10);
  });

  it('never names the platform in a sentence a person reads', () => {
    const brands = /youtube|google|twitch|vimeo/i;
    for (const [s, b] of [[400, { error: 'invalid_grant' }], [403, { error: { errors: [{ reason: 'quotaExceeded' }] } }], [500, {}]] as Array<[number, any]>) {
      expect(brands.test(refusalOf(s, b).reason)).toBe(false);
    }
  });
});

describe('encoderAddress', () => {
  it('prefers the encrypted form, because a stream key in clear text is a key anybody can take', () => {
    const a = encoderAddress({ ingestionAddress: 'rtmp://a.example/live2', rtmpsIngestionAddress: 'rtmps://a.example/live2', streamName: 'abcd-efgh' });
    expect(a.serverUrl).toBe('rtmps://a.example/live2');
    expect(a.ingestUrl).toBe('rtmps://a.example/live2/abcd-efgh');
  });

  it('falls back to the plain form when that is all there is', () => {
    expect(encoderAddress({ ingestionAddress: 'rtmp://a.example/live2', streamName: 'k' }).serverUrl).toBe('rtmp://a.example/live2');
  });

  it('returns an empty address rather than a broken one when the key is missing', () => {
    expect(encoderAddress({ ingestionAddress: 'rtmp://a.example/live2' }).ingestUrl).toBe('');
  });

  it('does not double the separator when the server address ends in one', () => {
    expect(encoderAddress({ ingestionAddress: 'rtmp://a.example/live2/', streamName: 'k' }).ingestUrl).toBe('rtmp://a.example/live2/k');
  });
});

describe('lifecycle', () => {
  it('knows the one state that means people can watch', () => {
    expect(isLive('live')).toBe(true);
    expect(isLive('ready')).toBe(false);
    expect(isLive('complete')).toBe(false);
  });

  it('recognises the mid-transition states a poller must wait through rather than fail on', () => {
    expect(isTransitioning('liveStarting')).toBe(true);
    expect(isTransitioning('testStarting')).toBe(true);
    expect(isTransitioning('live')).toBe(false);
  });
});

describe('classBroadcastBody', () => {
  const body = classBroadcastBody('Fluid mechanics', '2026-09-01T10:00:00.000Z');

  it('is unlisted, never private — a private event cannot be embedded for students', () => {
    expect(body.status.privacyStatus).toBe('unlisted');
  });

  it('starts and stops itself from encoder activity, so no transition call is needed', () => {
    expect(body.contentDetails.enableAutoStart).toBe(true);
    expect(body.contentDetails.enableAutoStop).toBe(true);
  });

  it('records from the start and allows embedding, which is the whole delivery model here', () => {
    expect(body.contentDetails.recordFromStart).toBe(true);
    expect(body.contentDetails.enableEmbed).toBe(true);
  });

  it('declares not-made-for-kids explicitly, because that flag disables live chat entirely', () => {
    expect(body.status.selfDeclaredMadeForKids).toBe(false);
  });

  it('clamps a title that would be refused for length', () => {
    expect(classBroadcastBody('x'.repeat(400), '2026-09-01T10:00:00.000Z').snippet.title.length).toBe(100);
  });
});

describe('configuration reporting', () => {
  it('reads as unconfigured when the environment is empty, rather than half-working', () => {
    // The suite runs without these set; a half-configured connector must never report available.
    if (!process.env.LIVE_EGRESS_CLIENT_ID) {
      expect(platformCredentials()).toBeNull();
      expect(liveEgressStatus().available).toBe(false);
    }
  });

  it('explains the seven-day trap in the unconfigured message, where somebody will read it', () => {
    if (!process.env.LIVE_EGRESS_CLIENT_ID) {
      expect(liveEgressStatus().reason).toMatch(/seven days/i);
    }
  });
});
