// GET /api/id-card/keys - THE PUBLIC KEYS AN ID CARD CAN BE CHECKED AGAINST, AS A JWK SET.
//
// Anybody may verify an EduRankAI ID card without asking us: decode the QR, split the token on '.',
// and check the Ed25519 signature over "EID1.<payload>" with the key whose `kid` the payload names.
// Only PUBLIC keys are here. They are derived (see src/lib/hr/id-card-crypto.ts), so publishing them
// reveals nothing about the keys they came from.
import type { APIRoute } from 'astro';
import { verifiableKeys } from '@/lib/hr/id-card';
import { publicJwk } from '@/lib/hr/id-card-crypto';

export const prerender = false;

export const GET: APIRoute = async () => {
  let keys: Record<string, string>[] = [];
  try {
    keys = verifiableKeys().map(publicJwk);
  } catch (e: any) {
    console.error('[api/id-card/keys]', e?.cause?.message || e?.message);
  }
  return new Response(JSON.stringify({
    keys,
    format: 'EID1.<base64url(JSON)>.<base64url(Ed25519 signature over "EID1.<payload>")>',
  }, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/jwk-set+json; charset=utf-8',
      'cache-control': 'public, max-age=3600',
      'access-control-allow-origin': '*',
    },
  });
};
