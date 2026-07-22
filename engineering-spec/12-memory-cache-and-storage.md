# Engineering Block 12 — Memory, Cache & Storage Architecture

| Field | Value |
|---|---|
| **Spec source** | Vol VII Part I pp 234–275 — "Memory Architecture, Cache Systems, Persistent Memory, HBM, Memory Virtualization, Unified Memory Systems, Memory Coherency" (Ch. 5 preview) + pp 259–274 "Cloud Security, Zero Trust Architecture, Confidential Computing, IAM, Secrets Management" (Ch. 19) |
| **Repo target** | `src/lib/vsm/` (new: `tiers.ts`, `keys.ts`, `kv.ts`, `memo.ts`, `access.ts`, `http.ts`, `manager.ts`, `index.ts`); `src/pages/api/kernel/objects/[id].json.ts` (new); `src/pages/api/kernel/cache/purge.ts` (new); extend `src/lib/kernel/repository.ts` (invalidation hook). Reuses `src/lib/storage.ts`, `src/lib/db`, `settings`, `auditLog`. |
| **Status** | partial — persistence tier (`kernel_objects`), blob tier (`storage.ts`), and ad-hoc `Cache-Control` headers already exist; the unified cache/tier layer (VSM) and Zero-Trust read gate are new. |
| **Depends on** | Block 01 — Kernel Object Store (`kernel_objects.version` is the invalidation key); RBAC/Auth block (`src/lib/rbac`, `src/lib/auth`) for the `Principal` used by the Zero-Trust read gate. |

## 1. Purpose
The Virtual Storage Manager (VSM) is a stateless read-through cache and storage-tier router in front of the kernel object store. It resolves reads across four real tiers — per-request memoization, optional external KV, edge/CDN via HTTP cache headers, and Postgres as the system of record — using content-addressed cache keys derived from `kernel_objects.id` + `version`, so a version bump automatically invalidates stale entries. It also applies a default-deny "Zero Trust" read gate that decides cacheability and shareability from each object's `security_labels` and the caller's RBAC principal. Large binary assets continue to be stored through the existing `@vercel/blob` adapter (`src/lib/storage.ts`); VSM only governs the metadata/JSON object reads.

## 2. Repo mapping — exists vs. build

**Already exists (reuse, do not duplicate):**
- `src/lib/kernel/*` — the object store. `kernel_objects.version` (integer, bumped in `repository.ts` `updateObject` via `o.version += 1` inside the `'updated'` transition) is the invalidation primitive. `security_labels text[]`, `owner`, and `lifecycle_state` are the fields the Zero-Trust access gate reads (`permissions jsonb` and `synchronization_state` stay available on the envelope for future policy but are not consulted by the current gate).
- `src/lib/storage.ts` — the blob tier. `BlobStore` interface, `getStore()`, `vercelBlobStore()` (needs `BLOB_READ_WRITE_TOKEN`), `memoryStore()` dev fallback, `storageKey()`. VSM does **not** re-implement blob storage; it references this as tier `blob`.
- `src/lib/db/index.ts` — the `postgres-js`/Drizzle client (`db`, `execute` typed `any`). Postgres/Neon is tier `db` (persistent memory analog).
- `settings` table (`key varchar pk`, `value jsonb`) — stores the tunable TTL policy under key `vsm.ttl` (optional; falls back to code defaults).
- `auditLog` table — records cache purges (`action='cache.purge'`), so no new audit table is needed.
- Existing `Cache-Control` usage (`src/pages/api/labs/catalog.json.ts`: `public, max-age=600, s-maxage=3600`; `src/pages/api/fx/rates.ts`) — VSM centralizes and standardizes this pattern into `http.ts`.
- `src/pages/api/cron/*` — Vercel Cron endpoints; the serverless replacement for a resident "scheduler" (used for optional cache warm-up).

**Build (new):**
- `src/lib/vsm/` — the tier router, key/etag builders, optional KV adapter (swap-ready like `storage.ts`), per-request memo, Zero-Trust read gate, HTTP cache-header derivation, and the `VirtualStorageManager` read-through/invalidate service.
- `src/pages/api/kernel/objects/[id].json.ts` — cached, conditional-GET (ETag/304) read endpoint that emits the correct `Cache-Control` per security label.
- `src/pages/api/kernel/cache/purge.ts` — admin-only explicit purge (by object id / tag).
- A one-line invalidation hook wired into `KernelRepository.updateObject` (or its calling endpoints).

**No new tables required.** Invalidation is content-addressed off the existing `version` column; explicit purge reuses `auditLog`; TTL config reuses `settings`.

## 3. Data model

No new SQL tables. VSM adds a typed cache-envelope, a TTL policy (configurable via the existing `settings` table), and a purge-request contract.

```ts
// src/lib/vsm/tiers.ts
import { z } from 'zod';

/** Storage tiers VSM is aware of: four in the object read-path (request → kv → edge → db,
 *  the spec's L1/L2/L3/HBM/persistent-memory hierarchy mapped to serverless) plus `blob` for
 *  large immutable assets (governed by src/lib/storage.ts, not the read-through). */
export type StorageTier =
  | 'request' // per-invocation memoization (module/locals Map) — L1 analog; NOT shared across invocations
  | 'kv'      // optional external KV (Vercel KV / Upstash) — L2/L3/RAM analog; shared, TTL'd
  | 'edge'    // CDN / edge cache via HTTP Cache-Control — shared read cache for public GETs
  | 'db'      // Postgres kernel_objects — system of record / "persistent memory"
  | 'blob';   // @vercel/blob + CDN — large immutable assets (via src/lib/storage.ts)

export type CacheView = 'envelope' | 'graph' | 'rendered';

/** Resolved caching policy for one (view, securityLabel, lifecycleState) tuple. */
export interface TtlPolicy {
  kvSeconds: number;    // TTL in the shared KV tier; 0 = do not write to KV
  edgeSeconds: number;  // s-maxage for CDN; 0 = not edge-cacheable
  swrSeconds: number;   // stale-while-revalidate window for the CDN
  shareable: boolean;   // may a SHARED cache (CDN) store it? false => private/no-store
}

export const ttlPolicySchema = z.object({
  kvSeconds: z.number().int().min(0),
  edgeSeconds: z.number().int().min(0),
  swrSeconds: z.number().int().min(0),
  shareable: z.boolean(),
});

/** Config blob persisted in settings(key='vsm.ttl'); optional — code defaults below are used if absent. */
export const vsmConfigSchema = z.object({
  keySchema: z.string().default('v1'), // bump to hard-invalidate the entire namespace
  defaultKvSeconds: z.number().int().min(0).default(300),
  defaultEdgeSeconds: z.number().int().min(0).default(3600),
  defaultSwrSeconds: z.number().int().min(0).default(86400),
});
export type VsmConfig = z.infer<typeof vsmConfigSchema>;
```

```ts
// src/lib/vsm/access.ts — Zero-Trust read gate contract (default deny).
import type { KernelObject } from '@/lib/kernel';

export interface Principal {
  userId: string | null;
  roles: string[];               // from src/lib/rbac (e.g. 'admin', 'faculty', 'student')
  enrolledCourseIds?: string[];  // for 'enrolled-only' objects
  isAdmin?: boolean;
}
```

```ts
// src/lib/vsm/kv.ts — swap-ready KV interface (mirrors the storage.ts BlobStore pattern).
export interface KvStore {
  kind: string;
  enabled: boolean;
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}
```

```ts
// src/lib/vsm/manager.ts — the value returned to endpoints.
import type { KernelObject } from '@/lib/kernel';
import type { StorageTier } from './tiers';

export interface CachedRead {
  object: KernelObject | null;
  etag: string;                 // '"{id}.{version}"'
  hit: StorageTier | 'miss';    // which tier served it
  cacheControl: string;         // ready-to-set Cache-Control header
}
```

## 4. Interfaces & API contracts

```ts
// src/lib/vsm/keys.ts
import type { CacheView } from './tiers';
import type { Principal } from './access';

/** Content-addressed key. A version bump changes the key => old value is orphaned (ages out by TTL). */
export function objectCacheKey(
  p: { id: string; version: number; view: CacheView; scope: string; schema?: string },
): string {
  return ['ko', p.schema ?? 'v1', p.id, String(p.version), p.view, p.scope].join(':');
}

/** Head pointer: id -> current version. Lets a reader build the content key without hitting the DB. */
export function objectHeadKey(id: string, schema = 'v1'): string {
  return `ko:${schema}:head:${id}`;
}

/** ETag for conditional GET; identical shape to the content key's identity part. */
export function objectEtag(id: string, version: number): string {
  return `"${id}.${version}"`;
}

/** Stable, non-crypto scope token for private views ('pub' for shareable/public reads). */
export function scopeHash(principal: Principal, shareable: boolean): string {
  if (shareable) return 'pub';
  const basis = [
    principal.isAdmin ? 'admin' : '',
    ...[...principal.roles].sort(),
    ...[...(principal.enrolledCourseIds ?? [])].sort(),
  ].join('|');
  let h = 5381;                         // djb2
  for (let i = 0; i < basis.length; i++) h = ((h << 5) + h + basis.charCodeAt(i)) | 0;
  return 'u' + (h >>> 0).toString(36);
}
```

```ts
// src/lib/vsm/access.ts
import type { KernelObject } from '@/lib/kernel';
import type { Principal } from './access';

/** Default-deny read gate. Returns whether the principal may read the object. */
export function canReadObject(
  o: Pick<KernelObject, 'securityLabels' | 'owner' | 'lifecycleState'>,
  principal: Principal,
): boolean;

/** Whether this object may be stored in a SHARED cache (CDN/edge). */
export function isShareable(
  o: Pick<KernelObject, 'securityLabels' | 'lifecycleState'>,
): boolean;
```

```ts
// src/lib/vsm/http.ts
import type { TtlPolicy } from './tiers';
export function cacheControlFor(policy: TtlPolicy): string;
```

```ts
// src/lib/vsm/manager.ts
import { KernelRepository } from '@/lib/kernel';
import type { KvStore } from './kv';
import type { Principal } from './access';
import type { CacheView } from './tiers';
import type { CachedRead } from './manager';

export class VirtualStorageManager {
  constructor(
    private kernel: KernelRepository,
    private kv: KvStore,
    private memo: Map<string, unknown>, // per-request; from context.locals
  ) {}

  /** Read-through: request memo -> KV -> Postgres. Applies the Zero-Trust gate. */
  readObject(id: string, view: CacheView, principal: Principal): Promise<CachedRead>;

  /** Invalidate all cached views of an object (called after a version bump / publish / archive). */
  invalidate(id: string): Promise<void>;
}
```

**Astro endpoints:**

| Method + Path | Request | Response |
|---|---|---|
| `GET /api/kernel/objects/[id].json?view=envelope\|graph\|rendered` | query `view` (default `envelope`); `If-None-Match` header; principal from session/RBAC | `200` `KernelObject` (or `ObjectGraph`) JSON with `ETag` + `Cache-Control`; `304` if ETag matches; `403` if read denied; `404` if missing |
| `POST /api/kernel/cache/purge` | JSON `{ objectId?: string; all?: boolean }`; admin session required | `200 { purged: number }`; `403` if not admin |

```ts
// Purge request contract
import { z } from 'zod';
export const purgeRequestSchema = z.object({
  objectId: z.string().uuid().optional(),
  all: z.boolean().optional(),
}).refine((v) => v.objectId || v.all, { message: 'objectId or all required' });
```

## 5. Core logic / algorithms

**5.1 Read-through resolution (`VirtualStorageManager.readObject`)**
```
readObject(id, view, principal):
  memoKey = `${id}:${view}:${principal.userId ?? 'anon'}`
  1. if memo.has(memoKey): return memo.get(memoKey)           # tier = request (L1)
  2. version = null
     if kv.enabled: version = await kv.get(objectHeadKey(id)) # cheap pointer read
  3. if version != null:
        # build content key WITHOUT a DB hit
        obj = await kv.get(objectCacheKey({id, version, view, scope}))   # scope resolved below
        if obj != null:
           result = finalize(obj); memo.set(memoKey, result); return result   # tier = kv (L2/L3)
  4. # miss -> system of record
     raw = await kernel.getObject(id)                          # tier = db (persistent memory)
     if raw == null: return { object:null, etag:'"0.0"', hit:'miss', cacheControl:'no-store' }
     if not canReadObject(raw, principal): throw Forbidden     # Zero-Trust default deny
     view-projected = project(raw, view)                       # 'graph' also loads edges
     policy = resolvePolicy(view, raw.securityLabels, raw.lifecycleState)
     scope = scopeHash(principal, policy.shareable)
     if kv.enabled and policy.kvSeconds > 0:
        await kv.set(objectCacheKey({id, version:raw.version, view, scope}), view-projected, policy.kvSeconds)
        await kv.set(objectHeadKey(id), raw.version, min(policy.kvSeconds, 60))   # short-lived head
     result = { object:view-projected, etag:objectEtag(id, raw.version),
                hit:'db', cacheControl: cacheControlFor(policy) }
     memo.set(memoKey, result)
     return result
```
Correctness note: content keys are **immutable** for a given `(id, version)`. The only mutable key is the head pointer, which is short-TTL and busted on write, so a stale version can never be served past the head TTL even if `invalidate()` is missed.

**5.2 Invalidation on version bump (coherency, serverless equivalent of a cache-coherency protocol)**
```
invalidate(id):
  1. await kv.del(objectHeadKey(id))     # force next reader to re-derive head from DB
  2. # content keys are version-addressed; the previous version's keys are now orphaned
  #    and age out via TTL. No enumerate-and-delete needed.
  3. (optional) trigger CDN purge for public objects — see 5.6
```
Wire it after every `version += 1`. Minimal hook in `KernelRepository.updateObject` (or in the mutating endpoint):
```ts
// repository.ts — add an optional callback, default no-op (keeps the kernel dependency-free)
constructor(private store: KernelStore = new InMemoryKernelStore(),
            private onVersionBump: (id: string) => void = () => {}) {}

// updateObject() already delegates to transition('updated', o => { o.version += 1; ... }),
// and transition() is what calls store.updateObject(o). So fire the hook once the transition
// resolves — the object is persisted with its new version by then:
async updateObject(id: string, patch: UpdatePatch = {}): Promise<KernelObject> {
  const o = await this.transition(id, 'updated', (o) => { o.version += 1; /* ...apply patch... */ });
  this.onVersionBump(o.id);
  return o;
}
```
The endpoint constructs `new KernelRepository(new PgKernelStore(), (id) => vsm.invalidate(id))`. `archiveObject`/`deleteObject`/`publishObject` also transition lifecycle → call `invalidate(id)` in those endpoints too (they change readability/shareability without a `version` bump).

**5.3 Zero-Trust read gate (`canReadObject`) — default deny**
```
canReadObject(o, principal):
  if principal.isAdmin: return true
  if o.lifecycleState in {'archived','deleted'}: return principal.isAdmin   # only admins
  labels = o.securityLabels
  if 'exam-secure' in labels:
     return o.owner === principal.userId          # exam material: owner-only unless admin
  if 'enrolled-only' in labels:
     return principal.enrolledCourseIds?.length > 0   # (endpoint narrows to the specific course)
  if 'public' in labels:
     return o.lifecycleState === 'published' || o.owner === principal.userId
  return o.owner === principal.userId             # unknown/no label => private to owner
```

**5.4 Shareability + TTL resolution (`isShareable` / `resolvePolicy`)**
```
isShareable(o):
  return o.lifecycleState === 'published'
     and 'public' in o.securityLabels
     and not ('exam-secure' in o.securityLabels or 'enrolled-only' in o.securityLabels)

resolvePolicy(view, labels, lifecycleState):
  if 'exam-secure' in labels:                          # never cached anywhere shared
     return { kvSeconds:0, edgeSeconds:0, swrSeconds:0, shareable:false }
  if not published(lifecycleState):                     # drafts: request-memo only
     return { kvSeconds:0, edgeSeconds:0, swrSeconds:0, shareable:false }
  if isShareable(o):                                    # public + published
     return { kvSeconds:cfg.defaultKvSeconds, edgeSeconds:cfg.defaultEdgeSeconds,
              swrSeconds:cfg.defaultSwrSeconds, shareable:true }
  # enrolled-only / owner-private: KV-cacheable (scoped by scopeHash) but NOT shareable
  return { kvSeconds:60, edgeSeconds:0, swrSeconds:0, shareable:false }
```

**5.5 HTTP header derivation (`cacheControlFor`) + conditional GET**
```
cacheControlFor(policy):
  if policy.shareable and policy.edgeSeconds > 0:
     return `public, max-age=60, s-maxage=${policy.edgeSeconds}, stale-while-revalidate=${policy.swrSeconds}`
  if policy.kvSeconds > 0:            # private: cacheable for the browser only, never a shared cache
     return `private, max-age=${policy.kvSeconds}`
  return 'no-store'
```
Endpoint conditional-GET:
```
GET handler:
  read = await vsm.readObject(id, view, principal)   # throws Forbidden -> 403
  if read.object == null: return 404
  if request.headers['if-none-match'] === read.etag:
     return 304 { ETag: read.etag, 'Cache-Control': read.cacheControl }
  return 200 json(read.object) with { ETag: read.etag, 'Cache-Control': read.cacheControl }
```

**5.6 Optional CDN purge (out-of-band):** on publish/version-bump of a `public` object, POST the object URL to the CDN purge API (Vercel's cache invalidation). Flagged in §7 — not required for correctness because shareable responses are version-addressed and short `s-maxage` + `stale-while-revalidate` bounds staleness.

## 6. Execution plan

> **Status: IMPLEMENTED** (2026-07-20) — the full VSM layer, both endpoints, and the kernel hook landed with tests; `vsm.test.ts` **27/27**, kernel regression **65/65**, `astro check` **zero errors** in touched files (repo total unchanged at 184). **Security fix vs. the draft:** `scopeHash`'s private basis now INCLUDES `userId` — the draft omitted it, which would let an owner-private object be served cross-user from a shared scope (a cache leak); the test proves the intruder path stays denied. Deferred: T11 (migrate 2 ad-hoc Cache-Control sites) + T12 (cron warm-up / CDN purge) — optional cleanup/ops.

- [x] **T1** `tiers.ts` — `StorageTier`, `CacheView`, `TtlPolicy`, zod, `DEFAULT_VSM_CONFIG`.
- [x] **T2** keys (in `access.ts`) — `objectCacheKey`, `objectHeadKey`, `objectEtag`, `scopeHash` (djb2, +userId fix).
- [x] **T3** `access.ts` — `Principal`, `canReadObject` (default-deny), `isShareable`, `resolvePolicy`. Deny matrix unit-tested.
- [x] **T4** `http.ts` — `cacheControlFor`.
- [x] **T5** `kv.ts` — `KvStore` + `memoryKv()` + `vercelKv()` (lazy `@vercel/kv`, `enabled` on `KV_REST_API_URL`) + `getKv()`.
- [x] **T6** `memo.ts` — `getRequestMemo(locals)`.
- [x] **T7** `manager.ts` + `index.ts` — `VirtualStorageManager` (read-through request→kv→db + `invalidate`), `VsmForbiddenError`.
- [x] **T8** `repository.ts` — optional `onVersionBump` callback fired after `updateObject`/`rollbackObject` bumps (no-op default; no behavior change).
- [x] **T9** `api/kernel/objects/[id].json.ts` — Principal from RBAC, VSM read, ETag/304/403/404 + Cache-Control.
- [x] **T10** `api/kernel/cache/purge.ts` — `manage:cache`-gated, `purgeRequestSchema`, `vsm.invalidate` + `auditLog('cache.purge')`.
- [ ] **T11 Deferred** — migrate `labs/catalog.json.ts` / `fx/rates.ts` to `cacheControlFor`.
- [ ] **T12 Deferred** — cron cache-warmup / CDN purge-on-publish.
- [x] **T13** Tests: version-bump-changes-key, exam-secure never shareable, KV hit vs DB, default-deny unknown label, cross-user isolation, etag/policy. 27/27.

## 7. Reality checks & risks

**Where the OS/kernel metaphor breaks on serverless (flagged, with the equivalent):**
- **Resident kernel managing RAM/cache tiers** → there is no long-lived process. Every request is a fresh (or warm) stateless Vercel function. Replaced by: stateless request handlers + Postgres state + edge/CDN + optional external KV + per-request memo.
- **L1/L2/L3 CPU cache & HBM / "unified memory across CPU/GPU/accelerators"** → no shared process RAM. Mapped to: `request` memo (per-invocation, not shared) → optional `kv` (shared, TTL'd) → `edge`/CDN (HTTP `Cache-Control`). Cross-invocation in-instance module memory is only safe because keys are **content-addressed by `version`**; it is never a source of truth.
- **Memory coherency protocols (MESI-style)** → replaced by content-addressed keys (`objectCacheKey` embeds `kernel_objects.version`) plus a short-TTL head pointer busted on write. A `version` bump is the coherency event.
- **Persistent memory / NVDIMM** → Postgres/Neon (system of record) for objects; `@vercel/blob`+CDN for large immutable assets (existing `src/lib/storage.ts`). No byte-addressable persistent memory exists or is needed.
- **Memory virtualization / protection rings** → the Zero-Trust read gate (`canReadObject`) over `security_labels` + RBAC principal. This is authorization, not hardware isolation.

**Out of scope (spec asks for it; not buildable on this stack — do not attempt):**
- **Confidential computing / TEEs / secure enclaves / encrypted memory (Ch. 19 §10)** → not available on Vercel functions. We rely on the providers' encryption-at-rest (Neon/Vercel Blob) and TLS in transit. Do not claim enclave-grade confidentiality.
- **Hardware Security Modules / key management / secret rotation with HSM (Ch. 19 §11)** → secrets are plain environment variables (`DATABASE_URL`, `BLOB_READ_WRITE_TOKEN`, `KV_REST_API_*`) managed by Vercel. HSM-backed rotation is out of scope.
- **Post-quantum cryptography** → not implemented; session tokens/hashing use the existing `@oslojs/crypto`. Out of scope.
- **Autonomous cyber defense / self-defending platforms / threat-detection Digital Twins (Ch. 19 §14, §16)** → replaced by pragmatic controls only: the default-deny read gate, `auditLog` records, and standard rate limiting. No autonomous/AI threat response.
- **"Continuous background optimization" / a resident scheduler** → replaced by Vercel Cron (`src/pages/api/cron/*`) for periodic warm-up/purge. No always-on loop.

**External services required (only if the shared cache tier is enabled):**
- `@vercel/kv` **or** `@upstash/redis` for the `kv` tier — NOT currently in `package.json`. Without it, VSM degrades gracefully to `request` memo + `edge`/CDN only (all logic still correct; just no cross-request shared object cache). Decision needed from a human: provision KV vs. rely on CDN + short TTLs.

**Decisions needing a human:**
1. Enable the KV tier now, or ship edge/CDN-only first? (Cost vs. hit-rate.)
2. Default TTLs — the code defaults (KV 300s, edge `s-maxage` 3600s, SWR 86400s) are a **minimal reasonable version**; the spec gives no numbers. Tune per traffic; overridable via `settings(key='vsm.ttl')`.
3. Whether to add explicit CDN purge-on-publish (§5.6) or accept bounded staleness from `s-maxage`+`stale-while-revalidate`.
4. Confirm `enrolled-only` enforcement granularity: the gate checks "is enrolled in *something*"; the endpoint must narrow to the specific course id — requires an enrollment lookup source (RBAC/`userRoleAssignments` or a course-enrollment table) that this block assumes but does not define.
