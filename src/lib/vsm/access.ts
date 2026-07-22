// src/lib/vsm/access.ts — Block 12: keys, the Zero-Trust read gate, and TTL/shareability policy.
// All pure. The gate defaults to deny; policy decides where an object may be cached.
import type { KernelObject } from '@/lib/kernel';
import { type CacheView, type TtlPolicy, type VsmConfig, DEFAULT_VSM_CONFIG } from './tiers';

export interface Principal {
  userId: string | null;
  roles: string[];
  enrolledCourseIds?: string[];
  isAdmin?: boolean;
}

// ---- content-addressed keys ----
export function objectCacheKey(p: { id: string; version: number; view: CacheView; scope: string; schema?: string }): string {
  return ['ko', p.schema ?? 'v1', p.id, String(p.version), p.view, p.scope].join(':');
}
export function objectHeadKey(id: string, schema = 'v1'): string { return `ko:${schema}:head:${id}`; }
export function objectEtag(id: string, version: number): string { return `"${id}.${version}"`; }

/** Stable, non-crypto scope token. 'pub' for shareable reads; otherwise per-principal.
 *  NOTE (deviation from the draft spec): the private basis INCLUDES userId — the draft omitted it,
 *  which would let owner-private objects be served cross-user from a shared scope (a cache leak). */
export function scopeHash(principal: Principal, shareable: boolean): string {
  if (shareable) return 'pub';
  const basis = [
    principal.isAdmin ? 'admin' : '',
    principal.userId ?? 'anon',
    ...[...principal.roles].sort(),
    ...[...(principal.enrolledCourseIds ?? [])].sort(),
  ].join('|');
  let h = 5381;                          // djb2
  for (let i = 0; i < basis.length; i++) h = ((h << 5) + h + basis.charCodeAt(i)) | 0;
  return 'u' + (h >>> 0).toString(36);
}

// ---- Zero-Trust read gate (default deny) ----
type GateObj = Pick<KernelObject, 'securityLabels' | 'owner' | 'lifecycleState'>;

export function canReadObject(o: GateObj, principal: Principal): boolean {
  if (principal.isAdmin) return true;
  if (o.lifecycleState === 'archived' || o.lifecycleState === 'deleted') return false;   // admin already returned
  const labels = o.securityLabels || [];
  if (labels.includes('exam-secure')) return o.owner === principal.userId;
  if (labels.includes('enrolled-only')) return (principal.enrolledCourseIds?.length ?? 0) > 0 || o.owner === principal.userId;
  if (labels.includes('public')) return o.lifecycleState === 'published' || o.owner === principal.userId;
  return o.owner != null && o.owner === principal.userId;   // unknown/no label => private to owner
}

export function isShareable(o: Pick<KernelObject, 'securityLabels' | 'lifecycleState'>): boolean {
  const labels = o.securityLabels || [];
  return o.lifecycleState === 'published'
    && labels.includes('public')
    && !labels.includes('exam-secure')
    && !labels.includes('enrolled-only');
}

/** Where an object may be cached, by label + lifecycle. */
export function resolvePolicy(labels: string[], lifecycleState: string, cfg: VsmConfig = DEFAULT_VSM_CONFIG): TtlPolicy {
  if ((labels || []).includes('exam-secure')) return { kvSeconds: 0, edgeSeconds: 0, swrSeconds: 0, shareable: false };
  if (lifecycleState !== 'published') return { kvSeconds: 0, edgeSeconds: 0, swrSeconds: 0, shareable: false };
  if (isShareable({ securityLabels: labels as any, lifecycleState: lifecycleState as any })) {
    return { kvSeconds: cfg.defaultKvSeconds, edgeSeconds: cfg.defaultEdgeSeconds, swrSeconds: cfg.defaultSwrSeconds, shareable: true };
  }
  return { kvSeconds: 60, edgeSeconds: 0, swrSeconds: 0, shareable: false };   // enrolled-only / private: KV-scoped, not shared
}
