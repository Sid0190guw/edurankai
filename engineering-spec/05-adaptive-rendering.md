# Engineering Block 05 — Adaptive Rendering Engine

| Field | Value |
|---|---|
| **Spec source** | Vol 1-7 pp 24–40 — "Educational Intelligence Runtime", "Live Educational Compilation", "Offline Learning Package", "AR · VR · XR high-fidelity rendering"; related infra Vol 1-7 p 235 ch 5 — "Memory Architecture, Cache Systems, High-Bandwidth Memory" |
| **Repo target** | `src/lib/render-profile.ts` (new), `src/pages/api/render/negotiate.ts` (new), `public/aquin-capability-probe.js` (new); extend `src/components/SceneGL.astro`, `public/aquin-scene-engine.js`, `src/lib/edu-runtime.ts`, `src/pages/admin/render-policy.astro` |
| **Status** | partial |
| **Depends on** | Block 04 — Educational Runtime (`edu-runtime.ts`: `RenderTier`, `estimateDevice`, `estimateNetwork`, `signalsFromHeaders`, `combinePlan`); Block 01 — Kernel object store (object `type` keys the render matrix). Feeds Block 06 — Offline Learning Package (`offlineEligible`). |

## 1. Purpose
Given per-device telemetry (storage headroom, battery, screen, bandwidth, compute, graphics capability), deterministically select a **render profile** — the concrete set of dials the client honours when drawing a lesson: `2d` vs `webgl` (vs `xr`-capable), dynamic-shadow quality, animation complexity, physics level, adaptive audio, asset-compression variant, pixel-ratio cap, and offline eligibility. The server already picks a conservative *tier* from Client-Hint headers during SSR (zero client JS); this block adds the client-side probe + a stateless capability-negotiation endpoint that refines that tier into a full `RenderProfile` once JavaScript can read signals headers cannot carry (Battery API, Storage estimate, WebXR support). The profile is the single input the three.js adapter and asset loader read.

## 2. Repo mapping — exists vs. build

**Already exists (reuse, do not duplicate):**
- `src/lib/edu-runtime.ts` — `RenderTier = 'lite'|'standard'|'rich'`, `DeviceSignals`, `estimateDevice()`, `estimateNetwork()` (heuristics on `deviceMemory`/`effectiveType`/`downlink`/`saveData`/`viewportWidth`), `combinePlan()`, `RenderPlan`, and `signalsFromHeaders(Headers)` which reads Client Hints (`sec-ch-device-memory`, `ect`, `downlink`, `save-data`, `sec-ch-viewport-width`) server-side with no client JS.
- `src/lib/render-policy.ts` — `RenderDirective`, the `(object type × tier)` `RENDER_MATRIX`, `resolveDirective()`, `assetVariantUrl()`, `rewriteMedia()`, and per-object overrides in `edu_render_overrides` (self-bootstrapping).
- `public/aquin-scene-engine.js` — pure dispatch: `rendererFor(tier)` (`svg2d` for lite, `webgl` otherwise), `usesWebGL(tier)`, `effectiveTier(tier, reduceMotion)`, `tierQuality(tier)` → `{ bloom, shadows, envMap, maxLights, particleCap }`, and the LITE 2D SVG fallback so lite never loads three.js.
- `src/components/SceneGL.astro` — `window.AquinSceneGL.render(container, model, { tier, quality, palette })`: three.js loaded via dynamic `import()` (its own lazy chunk), consumes `quality.{bloom,shadows,envMap}`, PCFSoft shadows, PMREM env map, optional UnrealBloom. (Its light rig is a fixed hemisphere+key+warm+cool set today — `quality.maxLights`/`particleCap`/`pixelRatioCap` are carried in the quality object but not yet read here; honouring them is part of this block — see §5.5.)
- `src/pages/admin/render-policy.astro` + `src/pages/api/admin/render-policy.ts` — admin matrix inspector + per-object override writer (RBAC-gated `can(configure, rendering)`).
- Offline substrate: `src/pages/api/offline/sync.ts` + `mine.ts` + `offline_work` table (idempotent on `client_id`).

**To build / extend:**
- **`src/lib/render-profile.ts` (new)** — `DeviceTelemetry` (extends `DeviceSignals` with storage/battery/screen/compute/graphics/prefs), the `RenderProfile` type, the deterministic `selectRenderProfile(telemetry)`, `profileToSceneQuality()`, a zod validator, `mergeTelemetry()`, and a self-bootstrapping `edu_device_profile` store.
- **`src/pages/api/render/negotiate.ts` (new)** — `POST` capability negotiation (validate client telemetry → merge with header Client Hints → `selectRenderProfile` → best-effort persist → return profile); `GET` last profile.
- **`public/aquin-capability-probe.js` (new)** — dependency-free client probe (Network Information, `deviceMemory`, `hardwareConcurrency`, `screen`, `devicePixelRatio`, `getBattery()`, `storage.estimate()`, WebGL/WebGPU detect, `navigator.xr.isSessionSupported`) → `POST /api/render/negotiate` → caches on `sessionStorage`, exposes `window.AquinRenderProfile`.
- **Extend `public/aquin-scene-engine.js`** — `render()` accepts an explicit `opts.quality` / `opts.mode` (from a negotiated profile) instead of always deriving `tierQuality(tier)`; allow a battery/reduced-data downgrade to force `2d` even on a WebGL-capable device.
- **Extend `src/components/SceneGL.astro`** — honour `quality.pixelRatioCap` and `quality.shadowQuality`; guard an `xr` mode entry (report-only until an XR renderer ships — see §7).
- **Extend `src/lib/edu-runtime.ts`** — `combinePlan()` unchanged; document that the header-only pipeline tier is the SSR *floor* the client probe refines.

## 3. Data model

### 3.1 Device telemetry (untrusted client input, superset of `DeviceSignals`)
```ts
// src/lib/render-profile.ts
import type { DeviceSignals, RenderTier } from '@/lib/edu-runtime';

export interface DeviceTelemetry extends DeviceSignals {
  // storage (navigator.storage.estimate)
  storageQuotaMB?: number;
  storageUsageMB?: number;
  // battery (navigator.getBattery — deprecated in some browsers, optional)
  batteryLevel?: number;        // 0..1
  batteryCharging?: boolean;
  // screen
  screenWidth?: number;         // CSS px (screen.width)
  screenHeight?: number;
  devicePixelRatio?: number;
  // compute
  hardwareConcurrency?: number; // logical cores
  // graphics capability
  webglVersion?: 0 | 1 | 2;     // 0 = no WebGL context obtainable
  webgpu?: boolean;
  xrImmersive?: boolean;        // navigator.xr immersive-vr OR immersive-ar supported
  // OS / user preferences
  prefersReducedMotion?: boolean;
  prefersReducedData?: boolean;
}
```

### 3.2 The render profile (the deterministic output)
```ts
export type RenderMode = '2d' | 'webgl' | 'xr';
export type ShadowQuality = 'off' | 'basic' | 'soft';
export type AnimationLevel = 'none' | 'simplified' | 'full';
export type PhysicsLevel = 'none' | 'lightweight' | 'full';
export type AudioMode = 'off' | 'ondemand' | 'adaptive';
export type AssetVariant = 'small' | 'medium' | 'large';

export interface RenderProfile {
  tier: RenderTier;             // shared with the SSR RenderPlan
  mode: RenderMode;             // 2d fallback | webgl | (xr = capability-gated, opt-in)
  shadows: ShadowQuality;       // dynamic shadows on/off + quality
  bloom: boolean;
  envMap: boolean;              // PBR reflections (PMREM)
  maxLights: number;
  particleCap: number;
  pixelRatioCap: number;        // clamp renderer.setPixelRatio
  animation: AnimationLevel;    // simplified vs full animation
  physics: PhysicsLevel;        // lightweight vs full physics
  audio: AudioMode;             // adaptive audio
  assetVariant: AssetVariant;   // compressed-asset selection (small/medium/large)
  textureBudgetMB: number;
  xrCapable: boolean;           // device COULD do XR even if mode stays webgl
  offlineEligible: boolean;     // enough free storage to cache an offline package
  reasons: string[];            // ordered, deterministic explanation of each gate
}
```

### 3.3 zod validator (endpoint boundary)
```ts
import { z } from 'zod';

export const deviceTelemetryZ = z.object({
  ua: z.string().max(512).optional(),
  deviceMemory: z.number().min(0).max(1024).optional(),
  effectiveType: z.enum(['slow-2g', '2g', '3g', '4g']).optional(),
  saveData: z.boolean().optional(),
  downlink: z.number().min(0).max(10000).optional(),
  viewportWidth: z.number().min(0).max(100000).optional(),
  storageQuotaMB: z.number().min(0).optional(),
  storageUsageMB: z.number().min(0).optional(),
  batteryLevel: z.number().min(0).max(1).optional(),
  batteryCharging: z.boolean().optional(),
  screenWidth: z.number().min(0).max(100000).optional(),
  screenHeight: z.number().min(0).max(100000).optional(),
  devicePixelRatio: z.number().min(0).max(8).optional(),
  hardwareConcurrency: z.number().min(0).max(1024).optional(),
  webglVersion: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  webgpu: z.boolean().optional(),
  xrImmersive: z.boolean().optional(),
  prefersReducedMotion: z.boolean().optional(),
  prefersReducedData: z.boolean().optional(),
}).strict();

export type DeviceTelemetryInput = z.infer<typeof deviceTelemetryZ>;
```

### 3.4 Persistence (additive, self-bootstrapping — repo's dominant pattern)
Device state is ephemeral and per-user, so it lives in its own small table, **not** as a `kernel_objects` extension. Best-effort: a signed-out visitor still gets a profile in the response; only signed-in users persist a row (for the admin inspector and cross-request continuity).
```ts
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
let booted = false;
async function ctx() { const { db } = await import('@/lib/db'); const { sql } = await import('drizzle-orm'); return { db, sql }; }

export async function ensureProfileSchema(): Promise<void> {
  if (booted) return; const { db, sql } = await ctx();
  await db.execute(sql.raw(
    `CREATE TABLE IF NOT EXISTS edu_device_profile (
       user_id UUID PRIMARY KEY,
       telemetry JSONB NOT NULL DEFAULT '{}'::jsonb,
       profile   JSONB NOT NULL DEFAULT '{}'::jsonb,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`));
  booted = true;
}

export async function saveDeviceProfile(userId: string, telemetry: DeviceTelemetry, profile: RenderProfile): Promise<void> {
  await ensureProfileSchema(); const { db, sql } = await ctx();
  await db.execute(sql`INSERT INTO edu_device_profile (user_id, telemetry, profile)
    VALUES (${userId}, ${JSON.stringify(telemetry)}::jsonb, ${JSON.stringify(profile)}::jsonb)
    ON CONFLICT (user_id) DO UPDATE SET telemetry = EXCLUDED.telemetry, profile = EXCLUDED.profile, updated_at = NOW()`);
}

export async function getDeviceProfile(userId: string): Promise<RenderProfile | null> {
  try { await ensureProfileSchema(); const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT profile FROM edu_device_profile WHERE user_id = ${userId} LIMIT 1`))[0];
    return r?.profile && Object.keys(r.profile).length ? (r.profile as RenderProfile) : null;
  } catch { return null; }
}
```

## 4. Interfaces & API contracts

### 4.1 Library functions (`src/lib/render-profile.ts`)
```ts
export function selectRenderProfile(t: DeviceTelemetry): RenderProfile;      // pure, deterministic
export function profileToSceneQuality(p: RenderProfile): SceneQuality;       // shape AquinSceneGL consumes
export function mergeTelemetry(header: DeviceSignals, client: DeviceTelemetryInput): DeviceTelemetry;

export interface SceneQuality {
  bloom: boolean; shadows: boolean; shadowQuality: ShadowQuality; envMap: boolean;
  maxLights: number; particleCap: number; pixelRatioCap: number; mode: RenderMode;
}

export const OFFLINE_MIN_FREE_MB = 250;   // storage headroom required to cache an offline package
export const LOW_BATTERY = 0.15;          // discharging below this clamps to lite
```

### 4.2 Endpoint — capability negotiation
```
POST /api/render/negotiate
  Request  (application/json): DeviceTelemetryInput   // partial; any subset the browser could read
  Response 200: { ok: true, profile: RenderProfile, source: 'client+headers' }
  Response 400: { ok: false, error: string }          // invalid JSON / failed zod

GET /api/render/negotiate
  Response 200: { ok: true, profile: RenderProfile | null }   // last persisted profile (signed-in), else null
```
```ts
// src/pages/api/render/negotiate.ts
import type { APIRoute } from 'astro';
import { signalsFromHeaders } from '@/lib/edu-runtime';
import { deviceTelemetryZ, mergeTelemetry, selectRenderProfile, saveDeviceProfile, getDeviceProfile } from '@/lib/render-profile';

function j(d: any, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } }); }

export const POST: APIRoute = async ({ request, locals }) => {
  let body: unknown = {};
  try { body = await request.json(); } catch { return j({ ok: false, error: 'bad json' }, 400); }
  const parsed = deviceTelemetryZ.safeParse(body);
  if (!parsed.success) return j({ ok: false, error: 'invalid telemetry' }, 400);

  // Header Client Hints are the base (available even before JS); client-JS values win where present,
  // because JS can read battery/storage/XR that headers cannot carry.
  const telemetry = mergeTelemetry(signalsFromHeaders(request.headers), parsed.data);
  const profile = selectRenderProfile(telemetry);

  const user = (locals as any)?.user;
  if (user?.id) { try { await saveDeviceProfile(user.id, telemetry, profile); } catch { /* best-effort */ } }
  return j({ ok: true, profile, source: 'client+headers' });
};

export const GET: APIRoute = async ({ locals }) => {
  const user = (locals as any)?.user;
  const profile = user?.id ? await getDeviceProfile(user.id).catch(() => null) : null;
  return j({ ok: true, profile });
};
```

### 4.3 Client global (`public/aquin-capability-probe.js`)
```
window.AquinCapabilities.negotiate(force?: boolean): Promise<RenderProfile | null>
window.AquinCapabilities.probe(): Promise<DeviceTelemetry>
window.AquinRenderProfile: RenderProfile | null   // set after first negotiate(), cached in sessionStorage
```

## 5. Core logic / algorithms

### 5.1 Two-phase selection (architecture)
1. **SSR floor (already implemented, zero client JS).** `signalsFromHeaders()` reads Client Hints → `estimateDevice`/`estimateNetwork` → `combinePlan()` → tier. This is a *conservative floor*: headers cannot report battery, storage, or WebXR, so the server can only downgrade, never over-commit.
2. **Client refinement (this block).** After hydration `aquin-capability-probe.js` reads the full telemetry and `POST`s it to `/api/render/negotiate`, which re-runs the deterministic selector over the merged signals and returns the authoritative `RenderProfile`. The scene engine reads `window.AquinRenderProfile`.

### 5.2 `selectRenderProfile` — deterministic, no randomness, no clock
Same telemetry in ⇒ identical profile out (unit-testable without a DB, mirroring `edu-runtime`'s pure core).
```ts
import { estimateDevice, estimateNetwork } from '@/lib/edu-runtime';

const RANK: Record<RenderTier, number> = { lite: 0, standard: 1, rich: 2 };
const minTier   = (a: RenderTier, b: RenderTier): RenderTier => (RANK[a] <= RANK[b] ? a : b);
const clampTier = (t: RenderTier, cap: RenderTier): RenderTier => (RANK[t] <= RANK[cap] ? t : cap);

export function selectRenderProfile(t: DeviceTelemetry): RenderProfile {
  const reasons: string[] = [];

  // 1. base tier = min(device, network) — reuse the runtime's estimators
  const dev = estimateDevice(t);
  const net = estimateNetwork(t);
  let tier = minTier(dev.tier, net.tier);
  reasons.push(`device=${dev.tier} (${dev.detail})`, `network=${net.tier} (${net.detail})`, `base=min -> ${tier}`);

  // 2. compute gate — <=2 logical cores caps at standard
  if (typeof t.hardwareConcurrency === 'number' && t.hardwareConcurrency > 0 && t.hardwareConcurrency <= 2) {
    tier = clampTier(tier, 'standard'); reasons.push(`cores=${t.hardwareConcurrency} -> cap standard`);
  }

  // 3. battery gate — low AND discharging clamps to lite (power saving)
  if (typeof t.batteryLevel === 'number' && t.batteryLevel <= LOW_BATTERY && t.batteryCharging === false) {
    tier = 'lite'; reasons.push(`battery=${Math.round(t.batteryLevel * 100)}% discharging -> lite`);
  }

  // 4. screen gate — a physically small screen clamps heavy render
  const cssW = typeof t.screenWidth === 'number' ? t.screenWidth : t.viewportWidth;
  if (typeof cssW === 'number' && cssW < 360) { tier = clampTier(tier, 'lite'); reasons.push(`screen ${cssW}px -> lite`); }

  // 5. explicit preferences
  if (t.prefersReducedData || t.saveData) { tier = clampTier(tier, 'lite'); reasons.push('reduced-data -> lite'); }

  // 6. graphics capability -> render mode
  const webgl = typeof t.webglVersion === 'number' ? t.webglVersion : (tier === 'lite' ? 0 : 1);
  const xrCapable = !!t.xrImmersive && webgl >= 2 && tier === 'rich';
  let mode: RenderMode = '2d';
  if (webgl >= 1 && RANK[tier] >= RANK.standard) mode = 'webgl';
  // XR is capability-gated AND opt-in: negotiation REPORTS xrCapable, but delivered mode stays
  // 'webgl' unless the caller explicitly requests an XR entry (no XR renderer ships yet — see §7).
  reasons.push(`webgl=${webgl} -> mode ${mode}${xrCapable ? ' (xr-capable)' : ''}`);

  // 7. animation respects reduced-motion regardless of tier
  const animation: AnimationLevel = t.prefersReducedMotion
    ? 'none'
    : tier === 'rich' ? 'full' : tier === 'standard' ? 'simplified' : 'none';
  if (t.prefersReducedMotion) reasons.push('reduced-motion -> animation none');

  // 8. derive the remaining dials from the final tier
  const shadows: ShadowQuality = mode === '2d' ? 'off' : tier === 'rich' ? 'soft' : tier === 'standard' ? 'basic' : 'off';
  const physics: PhysicsLevel  = tier === 'rich' ? 'full' : tier === 'standard' ? 'lightweight' : 'none';
  const audio: AudioMode       = tier === 'rich' ? 'adaptive' : tier === 'standard' ? 'ondemand' : 'off';
  const assetVariant: AssetVariant = tier === 'rich' ? 'large' : tier === 'standard' ? 'medium' : 'small';

  // 9. offline eligibility from storage headroom
  const freeMB = (typeof t.storageQuotaMB === 'number' && typeof t.storageUsageMB === 'number')
    ? Math.max(0, t.storageQuotaMB - t.storageUsageMB) : undefined;
  const offlineEligible = typeof freeMB === 'number' ? freeMB >= OFFLINE_MIN_FREE_MB : false;
  reasons.push(freeMB === undefined
    ? 'storage unknown -> offline off'
    : `free=${Math.round(freeMB)}MB -> offline ${offlineEligible ? 'on' : 'off'}`);

  // 10. pixel-ratio cap (retina DPR on lite wastes fill-rate)
  const dpr = typeof t.devicePixelRatio === 'number' && t.devicePixelRatio > 0 ? t.devicePixelRatio : 1;
  const pixelRatioCap = Math.min(dpr, tier === 'rich' ? 2 : tier === 'standard' ? 1.5 : 1);

  return {
    tier, mode,
    shadows,
    bloom:  tier === 'rich' && mode !== '2d',
    envMap: tier === 'rich' && mode !== '2d',
    maxLights:   tier === 'rich' ? 4 : 2,
    particleCap: tier === 'rich' ? 2000 : tier === 'standard' ? 400 : 60,
    pixelRatioCap,
    animation, physics, audio, assetVariant,
    textureBudgetMB: tier === 'rich' ? 128 : tier === 'standard' ? 48 : 12,
    xrCapable, offlineEligible, reasons,
  };
}
```

### 5.3 `mergeTelemetry` and `profileToSceneQuality`
```ts
export function mergeTelemetry(header: DeviceSignals, client: DeviceTelemetryInput): DeviceTelemetry {
  return { ...header, ...client };  // zod strips undefined keys, so header values survive gaps
}

export function profileToSceneQuality(p: RenderProfile): SceneQuality {
  return {
    bloom: p.bloom, shadows: p.shadows !== 'off', shadowQuality: p.shadows, envMap: p.envMap,
    maxLights: p.maxLights, particleCap: p.particleCap, pixelRatioCap: p.pixelRatioCap, mode: p.mode,
  };
}
```

### 5.4 Client probe (`public/aquin-capability-probe.js`, dependency-free, all DOM/API access guarded)
```js
(function () {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return;

  function detectWebGL() {
    try { var c = document.createElement('canvas');
      if (c.getContext('webgl2')) return 2;
      if (c.getContext('webgl') || c.getContext('experimental-webgl')) return 1;
    } catch (e) {} return 0;
  }

  async function probe() {
    var t = {};
    var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn) {
      if (conn.effectiveType) t.effectiveType = conn.effectiveType;
      if (typeof conn.downlink === 'number') t.downlink = conn.downlink;
      if (typeof conn.saveData === 'boolean') t.saveData = conn.saveData;
    }
    if (typeof navigator.deviceMemory === 'number') t.deviceMemory = navigator.deviceMemory;
    if (typeof navigator.hardwareConcurrency === 'number') t.hardwareConcurrency = navigator.hardwareConcurrency;
    t.screenWidth = screen.width; t.screenHeight = screen.height;
    t.devicePixelRatio = window.devicePixelRatio || 1;
    t.viewportWidth = window.innerWidth;
    t.prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    t.prefersReducedData  = window.matchMedia('(prefers-reduced-data: reduce)').matches;
    t.webglVersion = detectWebGL();
    t.webgpu = !!navigator.gpu;

    try { if (navigator.getBattery) { var b = await navigator.getBattery(); t.batteryLevel = b.level; t.batteryCharging = b.charging; } } catch (e) {}
    try { if (navigator.storage && navigator.storage.estimate) {
      var s = await navigator.storage.estimate();
      if (typeof s.quota === 'number') t.storageQuotaMB = Math.round(s.quota / 1048576);
      if (typeof s.usage === 'number') t.storageUsageMB = Math.round(s.usage / 1048576);
    } } catch (e) {}
    try {
      if (navigator.xr && navigator.xr.isSessionSupported) {
        var vr = await navigator.xr.isSessionSupported('immersive-vr').catch(function () { return false; });
        var ar = await navigator.xr.isSessionSupported('immersive-ar').catch(function () { return false; });
        t.xrImmersive = !!(vr || ar);
      }
    } catch (e) { t.xrImmersive = false; }
    return t;
  }

  function cached() { try { var v = sessionStorage.getItem('aquinRenderProfile'); return v ? JSON.parse(v) : null; } catch (e) { return null; } }

  window.AquinCapabilities = {
    probe: probe,
    async negotiate(force) {
      var c = cached();
      if (c && !force) { window.AquinRenderProfile = c; return c; }
      var t = await probe();
      var res = await fetch('/api/render/negotiate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(t),
      }).then(function (r) { return r.json(); }).catch(function () { return null; });
      var p = res && res.ok ? res.profile : null;
      if (p) { try { sessionStorage.setItem('aquinRenderProfile', JSON.stringify(p)); } catch (e) {} window.AquinRenderProfile = p; }
      return p;
    },
  };
})();
```

### 5.5 Wiring the profile into the existing scene engine
`public/aquin-scene-engine.js` `render(container, spec, tier, opts)` currently always derives `tierQuality(tier)`. Extend it to prefer an explicit negotiated quality and to allow a hard `2d` downgrade:
```js
// inside render(container, spec, tier, opts):
tier = effectiveTier(tier, opts && opts.reduceMotion);
var quality = (opts && opts.quality) || tierQuality(tier);       // negotiated profile wins
var mode = (opts && opts.mode) || rendererFor(tier);             // profile mode '2d'|'webgl'|'xr', else rendererFor(tier) -> 'svg2d'|'webgl'
if (mode !== '2d' && usesWebGL(tier) && typeof window !== 'undefined'
    && window.AquinSceneGL && typeof document !== 'undefined' && container) {
  window.AquinSceneGL.render(container, model, { tier: tier, quality: quality, palette: model.palette });
  return { renderer: 'webgl', nodes: model.nodes.length };
}
// ...existing 2D SVG fallback...
```
`SceneGL.astro` reads two new `quality` keys (backward-compatible defaults): `quality.pixelRatioCap` → `renderer.setPixelRatio(Math.min(quality.pixelRatioCap || 2, window.devicePixelRatio || 1))`, and `quality.shadowQuality` → `'soft'` = `PCFSoftShadowMap`, `'basic'` = `PCFShadowMap`, `'off'` = shadows disabled. Call site (a lab/lesson view):
```js
var profile = await window.AquinCapabilities.negotiate();
window.AquinScene.render(stage, spec, profile ? profile.tier : 'standard',
  { quality: window.AquinScene.profileQuality ? window.AquinScene.profileQuality(profile) : undefined,
    mode: profile ? profile.mode : undefined, reduceMotion: profile ? profile.animation === 'none' : false });
```

## 6. Execution plan

> **Status: IMPLEMENTED** (2026-07-20). The deterministic engine + endpoint + client probe + tests done; `render-profile.test.ts` **19/19**, `astro check` **zero errors** in touched files (repo total unchanged at 184). The remaining items are three.js/CSS/admin-UI polish and cross-block wiring, deferred and flagged (they change rendering internals and other blocks' surfaces, not this engine's logic). Tests need `DATABASE_URL` set (any dummy — the selector is pure, but importing `edu-runtime` loads the db module).

- [x] **`src/lib/render-profile.ts`** — `DeviceTelemetry`, `RenderProfile` + union types, `selectRenderProfile()` (10 ordered gates), `mergeTelemetry()`, `profileToSceneQuality()`, `deviceTelemetryZ`, `OFFLINE_MIN_FREE_MB`, `LOW_BATTERY`. Reuses `estimateDevice`/`estimateNetwork` from edu-runtime.
- [x] **Unit tests** — determinism (deep-equal), every gate (battery/webgl0/tiny-screen/cores/reduced-data/reduced-motion), xr report-only, storage→offlineEligible, pixel-ratio cap, merge + scene-quality. 19/19.
- [x] **`edu_device_profile` store** — `ensureProfileSchema`/`saveDeviceProfile`/`getDeviceProfile` (self-bootstrapping, best-effort).
- [x] **`src/pages/api/render/negotiate.ts`** — `POST` (validate→merge→select→persist→return) + `GET` (last profile).
- [x] **`public/aquin-capability-probe.js`** — guarded probe + `window.AquinCapabilities` + sessionStorage cache.
- [ ] **Deferred** — extend `public/aquin-scene-engine.js` (`opts.quality`/`opts.mode` + `profileQuality`).
- [ ] **Deferred** — `SceneGL.astro` honour `pixelRatioCap`/`shadowQuality` (three.js internals).
- [ ] **Deferred** — admin "negotiated profile" panel.
- [ ] **Deferred** — `assetVariantUrl()` keyed off `profile.assetVariant`.
- [ ] **Deferred** — wire `offlineEligible` into Block 06's offline gate.

## 7. Reality checks & risks

- **"Kernel checks Storage/Battery/Screen/Bandwidth" is not a resident OS kernel.** On Vercel serverless there is no long-running process polling device sensors. This is implemented as: (a) SSR reads Client-Hint *headers* (no battery/storage/XR available there), (b) a **client** probe reads the Web APIs and (c) a **stateless** endpoint recomputes the profile per request. No in-process scheduler, no kernel-managed RAM — flag the spec's "Memory Architecture / High-Bandwidth Memory / cache systems" language (Vol 1-7 p 235) as metaphor: the real levers are the browser's WebGL memory (bounded by `textureBudgetMB`/`particleCap`/`pixelRatioCap`) and the CDN, not a kernel RAM allocator.
- **The source's "high-definition fidelity" / "meta-level AR·VR·XR" aspiration (pp 39–40) has no hardware-RT web equivalent.** WebGL/WebGPU do not expose hardware ray tracing. That "we have minimum at this level of AR/VR/XR … high[-]definition fidelity" language is mapped to the achievable web analogues on the `rich` tier: soft (PCFSoft) dynamic shadows + PMREM environment reflections + UnrealBloom + higher pixel-ratio. Real-time path tracing is **out of scope**; the source's fidelity wording is aspirational, not an implementable spec constant (the source does not name a specific renderer such as "RTX").
- **XR is capability-gated and report-only for now.** `selectRenderProfile` detects `xrImmersive` and sets `xrCapable`, but the delivered `mode` never auto-escalates to `'xr'` — the repo has no WebXR renderer yet (`SceneGL.astro` is a `WebGLRenderer`; `classroom/live.astro` and lab pages already state AR/VR/XR is "next phase, shown honestly rather than faked"). Building an `immersive-vr`/`immersive-ar` session + XR controllers is a **separate future block**; this block only decides whether to *offer* an XR entry point. **Decision for a human:** whether to ship an opt-in "Enter XR" button gated on `xrCapable`, or defer entirely.
- **Battery Status API is deprecated / unavailable in several browsers** (notably desktop Firefox and Safari). The battery gate is therefore best-effort: when `batteryLevel` is absent, no downgrade is applied. Do not make battery the *only* thing standing between a device and a heavy render.
- **Client telemetry is untrusted.** `deviceTelemetryZ.strict()` bounds every field; the server always re-merges with header Client Hints so a spoofed payload can, at worst, request a *lighter* experience for that user's own session. Nothing security-sensitive keys off it.
- **`prefers-reduced-motion` already downgrades server-side** (`combinePlan` moves `rich`→`standard`, `effectiveTier` moves to `lite`). The profile makes this explicit as `animation:'none'`; keep both consistent so SSR and the client agree.
- **Deterministic ordering matters.** Gates are applied in a fixed order and only ever *clamp downward* (except the graphics/mode branch), so telemetry maps to exactly one profile. Reordering gates changes outcomes — treat the numbered steps in §5.2 as the contract and lock them with the determinism test.
- **Two-phase flicker.** SSR renders at the header floor tier, then the client may upgrade after `negotiate()`. Mitigate by only *upgrading* to WebGL after negotiation (never render heavy first and tear down), and cache the profile in `sessionStorage` so subsequent navigations skip the round-trip.
- **The spec source (pp 24–40) is about live lecture compilation, not device negotiation per se.** The device/storage/battery/screen/bandwidth dials named in the FOCUS are a minimal, reasonable engineering interpretation grounded in the AR/VR/XR-fidelity and "Offline Learning Package" mentions plus the repo's existing tier system — not a verbatim spec algorithm. Thresholds (`OFFLINE_MIN_FREE_MB = 250`, `LOW_BATTERY = 0.15`, `<360px`, `<=2 cores`) are engineering defaults to tune against real device analytics, not spec constants.
