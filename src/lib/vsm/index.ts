// src/lib/vsm/index.ts — Block 12 public surface.
export * from './tiers';
export {
  type Principal, objectCacheKey, objectHeadKey, objectEtag, scopeHash,
  canReadObject, isShareable, resolvePolicy,
} from './access';
export { cacheControlFor } from './http';
export { type KvStore, memoryKv, vercelKv, getKv } from './kv';
export { getRequestMemo } from './memo';
export { VirtualStorageManager, VsmForbiddenError, type CachedRead } from './manager';
