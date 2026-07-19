// src/lib/offline/manifest-schema.ts — Block 06: zod schema for the Offline Learning Package
// manifest (the 9 compilation categories from AES Vol 1 pp 36–37). Gives the package runtime
// validation it lacked (it was a bare TS interface). Mirrors src/lib/kernel/validation.ts.
import { z } from 'zod';

export const SYNC_STATE = z.enum(['synced', 'dirty', 'pending', 'conflict']);
export const RENDER_TIER = z.enum(['lite', 'standard', 'rich']);

// One packaged object. `version` + `syncState` are the delta-sync keys (from kernel_objects).
export const assetRef = z.object({
  id: z.string().uuid(),
  type: z.string(),
  version: z.number().int().nonnegative(),
  syncState: SYNC_STATE.default('synced'),
  bytes: z.number().int().nonnegative(),
  checksum: z.string().optional(),
  blobUrl: z.string().url().optional(),
  contentType: z.string().optional(),
  inline: z.unknown().optional(),
});
export type AssetRef = z.infer<typeof assetRef>;

export const graphEdge = z.object({
  from: z.string().uuid(),
  to: z.string().uuid(),
  type: z.string(),
});

export const dictionaryTerm = z.object({
  term: z.string(),
  definition: z.string(),
  conceptId: z.string().uuid().optional(),
  lang: z.string().default('en'),
});

// Maps from edu_progress: koId<-ko_id, completed, timeSpentSec<-seconds, updatedAt<-updated_at.
export const progressEntry = z.object({
  koId: z.string().uuid(),
  completed: z.boolean().default(false),
  score: z.number().optional(),
  timeSpentSec: z.number().int().nonnegative().default(0),
  updatedAt: z.string(),   // ISO — the LWW clock for merge
});
export type ProgressEntry = z.infer<typeof progressEntry>;

export const offlinePackageManifest = z.object({
  schemaVersion: z.literal(1),
  packageId: z.string().uuid(),
  userId: z.string().uuid().nullable(),
  tier: RENDER_TIER,
  createdAt: z.string(),
  baseVersion: z.number().int().nonnegative(),   // delta cursor seed = max kernel version at pack time
  budget: z.object({ maxBytes: z.number().int().positive(), maxUnits: z.number().int().positive().optional() }),
  totalBytes: z.number().int().nonnegative(),
  droppedIds: z.array(z.string()),

  categories: z.object({
    videos: z.array(assetRef).default([]),
    voice: z.array(assetRef).default([]),
    assessment: z.array(assetRef).default([]),
    virtualLab: z.array(assetRef).default([]),
    notes: z.array(assetRef).default([]),
    knowledgeGraph: z.array(graphEdge).default([]),
    dictionary: z.array(dictionaryTerm).default([]),
    translation: z.array(assetRef).default([]),
    studentProgress: z.array(progressEntry).default([]),
  }),
});
export type OfflinePackageManifest = z.infer<typeof offlinePackageManifest>;

/** Parse + validate a raw manifest. Throws ZodError on a malformed package. */
export function parseManifest(raw: unknown): OfflinePackageManifest {
  return offlinePackageManifest.parse(raw);
}

/** Safe variant: returns null instead of throwing. */
export function safeParseManifest(raw: unknown): OfflinePackageManifest | null {
  const r = offlinePackageManifest.safeParse(raw);
  return r.success ? r.data : null;
}
