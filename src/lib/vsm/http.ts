// src/lib/vsm/http.ts — Block 12: derive the Cache-Control header from a resolved TtlPolicy.
import type { TtlPolicy } from './tiers';

export function cacheControlFor(policy: TtlPolicy): string {
  if (policy.shareable && policy.edgeSeconds > 0) {
    return `public, max-age=60, s-maxage=${policy.edgeSeconds}, stale-while-revalidate=${policy.swrSeconds}`;
  }
  if (policy.kvSeconds > 0) return `private, max-age=${policy.kvSeconds}`;   // browser only, never a shared cache
  return 'no-store';
}
