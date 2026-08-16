// src/lib/mailapi/webhooks.secret-hint.test.ts — the hint must identify a secret without spending it.
//
// This suite exists because of a real disclosure: `secretHint` was built as
// `secret.slice(0, 11) + '...' + secret.slice(-4)`, and it was returned by the events.read list and
// get calls — so every routine read of GET /api/v1/webhooks handed back five characters of the head
// and four of the tail of a live `whsec_` signing secret. The assertions below are all REFUSALS:
// they check what must never appear in the hint, because a future "make the hint more helpful"
// change is precisely how this regresses.
//
// It is a separate file from webhooks.test.ts on purpose — another session owns that suite and this
// one must not collide with it.
import { describe, it, expect } from 'vitest';
import { webhookSecretHint, mintWebhookSecret } from './webhooks';

const SECRET = 'whsec_' + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde';
const BODY = SECRET.slice('whsec_'.length);

describe('webhookSecretHint refuses to disclose the secret', () => {
  it('never returns the suffix — the old hint ended in the last four characters', () => {
    const hint = webhookSecretHint(SECRET)!;
    expect(hint).not.toContain(SECRET.slice(-4));
    expect(hint).not.toContain(SECRET.slice(-8));
    expect(hint.endsWith(SECRET.slice(-4))).toBe(false);
  });

  it('never returns any run of the random body, head included', () => {
    const hint = webhookSecretHint(SECRET)!;
    // The old hint leaked BODY.slice(0, 5); check every 4-character window, not just that one, so a
    // hint that moved the disclosure somewhere else still fails.
    for (let i = 0; i + 4 <= BODY.length; i++) {
      expect(hint).not.toContain(BODY.slice(i, i + 4));
    }
    expect(hint).not.toContain(BODY.slice(0, 4));
  });

  it('leaks nothing across a hundred freshly minted secrets', () => {
    for (let n = 0; n < 100; n++) {
      const secret = mintWebhookSecret();
      const body = secret.slice('whsec_'.length);
      const hint = webhookSecretHint(secret)!;
      let leaked = '';
      for (let i = 0; i + 4 <= body.length; i++) {
        if (hint.includes(body.slice(i, i + 4))) { leaked = body.slice(i, i + 4); break; }
      }
      // Report WHICH window leaked rather than a bare false: a failure here has to be diagnosable.
      expect(leaked).toBe('');
      expect(hint).not.toContain(secret.slice(-4));
    }
  });

  it('echoes only the scheme marker, and only when we minted it', () => {
    expect(webhookSecretHint(SECRET)!.startsWith('whsec_...')).toBe(true);
    // An unrecognised value gets no prefix echoed back at all — printing the head of something we did
    // not generate is how the leak starts again with a different shape.
    const foreign = 'sk_live_9f8e7d6c5b4a39281706';
    const hint = webhookSecretHint(foreign)!;
    expect(hint.startsWith('...')).toBe(true);
    expect(hint).not.toContain('sk_live');
    expect(hint).not.toContain(foreign.slice(-4));
  });

  it('is bounded in length however long the secret is', () => {
    const long = 'whsec_' + 'x'.repeat(4096);
    expect(webhookSecretHint(long)!.length).toBe('whsec_...'.length + 8);
  });
});

describe('webhookSecretHint stays useful', () => {
  it('is stable across reads, so an operator can match the value they hold', () => {
    expect(webhookSecretHint(SECRET)).toBe(webhookSecretHint(SECRET));
  });

  it('changes when the secret changes, so a rotation is visible', () => {
    const a = webhookSecretHint(mintWebhookSecret());
    const b = webhookSecretHint(mintWebhookSecret());
    expect(a).not.toBe(b);
    const hints = new Set(Array.from({ length: 200 }, () => webhookSecretHint(mintWebhookSecret())));
    // 32 bits of fingerprint over 200 draws: a collision here would be a bug, not bad luck.
    expect(hints.size).toBe(200);
  });

  it('distinguishes "no secret on this row" from a hint, instead of inventing one', () => {
    // A placeholder string here would tell an operator the endpoint is signed when we cannot show
    // that it is. Absent has to read as absent.
    expect(webhookSecretHint(null)).toBeUndefined();
    expect(webhookSecretHint(undefined)).toBeUndefined();
    expect(webhookSecretHint('')).toBeUndefined();
  });
});
