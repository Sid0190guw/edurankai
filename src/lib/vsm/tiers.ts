// src/lib/vsm/tiers.ts — Block 12: storage-tier vocabulary + TTL policy types.
// The spec's L1/L2/L3/HBM/persistent-memory hierarchy mapped to the four real serverless tiers
// (request → kv → edge → db) plus `blob` for large immutable assets.
import { z } from 'zod';

export type StorageTier = 'request' | 'kv' | 'edge' | 'db' | 'blob';
export type CacheView = 'envelope' | 'graph' | 'rendered';

export interface TtlPolicy {
  kvSeconds: number;    // TTL in the shared KV tier; 0 = do not write to KV
  edgeSeconds: number;  // s-maxage for CDN; 0 = not edge-cacheable
  swrSeconds: number;   // stale-while-revalidate window for the CDN
  shareable: boolean;   // may a SHARED cache (CDN) store it?
}

export const ttlPolicySchema = z.object({
  kvSeconds: z.number().int().min(0),
  edgeSeconds: z.number().int().min(0),
  swrSeconds: z.number().int().min(0),
  shareable: z.boolean(),
});

export const vsmConfigSchema = z.object({
  keySchema: z.string().default('v1'),
  defaultKvSeconds: z.number().int().min(0).default(300),
  defaultEdgeSeconds: z.number().int().min(0).default(3600),
  defaultSwrSeconds: z.number().int().min(0).default(86400),
});
export type VsmConfig = z.infer<typeof vsmConfigSchema>;

export const DEFAULT_VSM_CONFIG: VsmConfig = vsmConfigSchema.parse({});
