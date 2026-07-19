// src/lib/vsm/manager.ts — Block 12: the Virtual Storage Manager. Stateless read-through cache
// (request memo -> KV -> Postgres) with content-addressed keys (id+version) so a version bump
// self-invalidates, plus the Zero-Trust read gate. Large binaries stay in storage.ts (blob tier).
import type { KernelRepository, KernelObject } from '@/lib/kernel';
import type { KvStore } from './kv';
import type { CacheView, StorageTier, VsmConfig } from './tiers';
import { DEFAULT_VSM_CONFIG } from './tiers';
import {
  type Principal, objectCacheKey, objectHeadKey, objectEtag, scopeHash,
  canReadObject, resolvePolicy,
} from './access';
import { cacheControlFor } from './http';

export interface CachedRead {
  object: KernelObject | null;
  etag: string;
  hit: StorageTier | 'miss';
  cacheControl: string;
}

export class VsmForbiddenError extends Error {
  constructor(public objectId: string) { super(`read denied for object ${objectId}`); this.name = 'VsmForbiddenError'; }
}

export class VirtualStorageManager {
  constructor(
    private kernel: KernelRepository,
    private kv: KvStore,
    private memo: Map<string, unknown> = new Map(),
    private cfg: VsmConfig = DEFAULT_VSM_CONFIG,
  ) {}

  private key(id: string, version: number, view: CacheView, scope: string): string {
    return objectCacheKey({ id, version, view, scope, schema: this.cfg.keySchema });
  }

  async readObject(id: string, view: CacheView, principal: Principal): Promise<CachedRead> {
    const memoKey = `${id}:${view}:${principal.userId ?? 'anon'}`;
    if (this.memo.has(memoKey)) return this.memo.get(memoKey) as CachedRead;

    // ---- KV tier: head pointer -> try public scope, then this principal's private scope ----
    if (this.kv.enabled) {
      const version = await this.kv.get<number>(objectHeadKey(id, this.cfg.keySchema));
      if (version != null) {
        for (const scope of ['pub', scopeHash(principal, false)]) {
          const cached = await this.kv.get<KernelObject>(this.key(id, version, view, scope));
          if (cached) {
            const policy = resolvePolicy(cached.securityLabels || [], cached.lifecycleState, this.cfg);
            const res: CachedRead = { object: cached, etag: objectEtag(id, version), hit: 'kv', cacheControl: cacheControlFor(policy) };
            this.memo.set(memoKey, res);
            return res;
          }
        }
      }
    }

    // ---- system of record ----
    const raw = await this.kernel.getObject(id);
    if (!raw) return { object: null, etag: '"0.0"', hit: 'miss', cacheControl: 'no-store' };
    if (!canReadObject(raw, principal)) throw new VsmForbiddenError(id);

    const policy = resolvePolicy(raw.securityLabels || [], raw.lifecycleState, this.cfg);
    const scope = scopeHash(principal, policy.shareable);
    if (this.kv.enabled && policy.kvSeconds > 0) {
      await this.kv.set(this.key(id, raw.version, view, scope), raw, policy.kvSeconds);
      await this.kv.set(objectHeadKey(id, this.cfg.keySchema), raw.version, Math.min(policy.kvSeconds, 60));
    }
    const res: CachedRead = { object: raw, etag: objectEtag(id, raw.version), hit: 'db', cacheControl: cacheControlFor(policy) };
    this.memo.set(memoKey, res);
    return res;
  }

  /** Bust the head pointer; version-addressed content keys orphan and age out by TTL. */
  async invalidate(id: string): Promise<void> {
    if (this.kv.enabled) await this.kv.del(objectHeadKey(id, this.cfg.keySchema));
  }
}
