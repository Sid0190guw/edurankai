// docker/mailops/sign.mjs — the sender half of the webhook signature.
//
// THIS IS A SECOND IMPLEMENTATION OF src/lib/mailops/webhook.ts, AND THAT IS A RISK, so it is
// stated openly here rather than discovered later. The verifier is TypeScript inside the Astro app;
// the signer is plain ESM inside a container that has no build step and no access to the app's
// module graph. Sharing one file across that boundary would mean either compiling TypeScript in the
// mail image or shipping the app's node_modules into it — both heavier than 20 lines of HMAC.
//
// THE DRIFT IS GUARDED BY A TEST, NOT BY HOPE. src/lib/mailops/signer-parity.test.ts imports both
// this file and webhook.ts and asserts they produce byte-identical signatures for the same inputs.
// If someone changes the signing string on one side, CI fails on the other. Without that test this
// file would be the classic "worked when written, silently rejected every message six months later".
//
// If you change ANYTHING below — the version prefix, the separator, the field order — change
// src/lib/mailops/webhook.ts in the same commit and let the parity test prove it.
import { createHmac, randomUUID } from 'node:crypto';

export const SIG_VERSION = 'v1';
export const SIGNATURE_HEADER = 'x-era-signature';
export const TIMESTAMP_HEADER = 'x-era-timestamp';
export const ID_HEADER = 'x-era-delivery-id';

export function signingString(version, timestamp, body) {
  return `${version}.${timestamp}.${body}`;
}

export function sign(secret, body, timestamp) {
  const mac = createHmac('sha256', secret).update(signingString(SIG_VERSION, timestamp, body)).digest('hex');
  return `${SIG_VERSION}=${mac}`;
}

export function signedHeaders(secret, body, opts = {}) {
  const ts = Math.floor((opts.now ?? Date.now()) / 1000);
  return {
    'Content-Type': 'application/json',
    [TIMESTAMP_HEADER]: String(ts),
    [SIGNATURE_HEADER]: sign(secret, body, ts),
    [ID_HEADER]: opts.deliveryId || randomUUID(),
  };
}
