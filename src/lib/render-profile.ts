// src/lib/render-profile.ts — Block 05: deterministic device→render-profile selection.
// The SSR pipeline (edu-runtime) already picks a conservative *tier* from Client-Hint headers.
// This module refines that tier into a full RenderProfile once the client can read signals
// headers cannot carry (Battery/Storage/WebXR). selectRenderProfile is pure and deterministic
// (no clock, no randomness) — same telemetry in => identical profile out.
import { z } from 'zod';
import { estimateDevice, estimateNetwork, type DeviceSignals, type RenderTier } from '@/lib/edu-runtime';

// ---- telemetry (untrusted client input; superset of DeviceSignals) ----
export interface DeviceTelemetry extends DeviceSignals {
  storageQuotaMB?: number;
  storageUsageMB?: number;
  batteryLevel?: number;        // 0..1
  batteryCharging?: boolean;
  screenWidth?: number;
  screenHeight?: number;
  devicePixelRatio?: number;
  hardwareConcurrency?: number;
  webglVersion?: 0 | 1 | 2;
  webgpu?: boolean;
  xrImmersive?: boolean;
  prefersReducedMotion?: boolean;
  prefersReducedData?: boolean;
}

export type RenderMode = '2d' | 'webgl' | 'xr';
export type ShadowQuality = 'off' | 'basic' | 'soft';
export type AnimationLevel = 'none' | 'simplified' | 'full';
export type PhysicsLevel = 'none' | 'lightweight' | 'full';
export type AudioMode = 'off' | 'ondemand' | 'adaptive';
export type AssetVariant = 'small' | 'medium' | 'large';

export interface RenderProfile {
  tier: RenderTier;
  mode: RenderMode;
  shadows: ShadowQuality;
  bloom: boolean;
  envMap: boolean;
  maxLights: number;
  particleCap: number;
  pixelRatioCap: number;
  animation: AnimationLevel;
  physics: PhysicsLevel;
  audio: AudioMode;
  assetVariant: AssetVariant;
  textureBudgetMB: number;
  xrCapable: boolean;
  offlineEligible: boolean;
  reasons: string[];
}

export interface SceneQuality {
  bloom: boolean; shadows: boolean; shadowQuality: ShadowQuality; envMap: boolean;
  maxLights: number; particleCap: number; pixelRatioCap: number; mode: RenderMode;
}

export const OFFLINE_MIN_FREE_MB = 250;
export const LOW_BATTERY = 0.15;

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

const RANK: Record<RenderTier, number> = { lite: 0, standard: 1, rich: 2 };
const minTier = (a: RenderTier, b: RenderTier): RenderTier => (RANK[a] <= RANK[b] ? a : b);
const clampTier = (t: RenderTier, cap: RenderTier): RenderTier => (RANK[t] <= RANK[cap] ? t : cap);

/** Deterministic device→profile mapping. Gates apply in a fixed order and only clamp downward
 *  (except the graphics/mode branch). See spec §5.2 — the numbered steps are the contract. */
export function selectRenderProfile(t: DeviceTelemetry): RenderProfile {
  const reasons: string[] = [];

  const dev = estimateDevice(t);
  const net = estimateNetwork(t);
  let tier = minTier(dev.tier, net.tier);
  reasons.push(`device=${dev.tier} (${dev.detail})`, `network=${net.tier} (${net.detail})`, `base=min -> ${tier}`);

  if (typeof t.hardwareConcurrency === 'number' && t.hardwareConcurrency > 0 && t.hardwareConcurrency <= 2) {
    tier = clampTier(tier, 'standard'); reasons.push(`cores=${t.hardwareConcurrency} -> cap standard`);
  }
  if (typeof t.batteryLevel === 'number' && t.batteryLevel <= LOW_BATTERY && t.batteryCharging === false) {
    tier = 'lite'; reasons.push(`battery=${Math.round(t.batteryLevel * 100)}% discharging -> lite`);
  }
  const cssW = typeof t.screenWidth === 'number' ? t.screenWidth : t.viewportWidth;
  if (typeof cssW === 'number' && cssW < 360) { tier = clampTier(tier, 'lite'); reasons.push(`screen ${cssW}px -> lite`); }
  if (t.prefersReducedData || t.saveData) { tier = clampTier(tier, 'lite'); reasons.push('reduced-data -> lite'); }

  const webgl = typeof t.webglVersion === 'number' ? t.webglVersion : (tier === 'lite' ? 0 : 1);
  const xrCapable = !!t.xrImmersive && webgl >= 2 && tier === 'rich';
  let mode: RenderMode = '2d';
  if (webgl >= 1 && RANK[tier] >= RANK.standard) mode = 'webgl';
  reasons.push(`webgl=${webgl} -> mode ${mode}${xrCapable ? ' (xr-capable)' : ''}`);

  const animation: AnimationLevel = t.prefersReducedMotion
    ? 'none'
    : tier === 'rich' ? 'full' : tier === 'standard' ? 'simplified' : 'none';
  if (t.prefersReducedMotion) reasons.push('reduced-motion -> animation none');

  const shadows: ShadowQuality = mode === '2d' ? 'off' : tier === 'rich' ? 'soft' : tier === 'standard' ? 'basic' : 'off';
  const physics: PhysicsLevel = tier === 'rich' ? 'full' : tier === 'standard' ? 'lightweight' : 'none';
  const audio: AudioMode = tier === 'rich' ? 'adaptive' : tier === 'standard' ? 'ondemand' : 'off';
  const assetVariant: AssetVariant = tier === 'rich' ? 'large' : tier === 'standard' ? 'medium' : 'small';

  const freeMB = (typeof t.storageQuotaMB === 'number' && typeof t.storageUsageMB === 'number')
    ? Math.max(0, t.storageQuotaMB - t.storageUsageMB) : undefined;
  const offlineEligible = typeof freeMB === 'number' ? freeMB >= OFFLINE_MIN_FREE_MB : false;
  reasons.push(freeMB === undefined ? 'storage unknown -> offline off' : `free=${Math.round(freeMB)}MB -> offline ${offlineEligible ? 'on' : 'off'}`);

  const dpr = typeof t.devicePixelRatio === 'number' && t.devicePixelRatio > 0 ? t.devicePixelRatio : 1;
  const pixelRatioCap = Math.min(dpr, tier === 'rich' ? 2 : tier === 'standard' ? 1.5 : 1);

  return {
    tier, mode, shadows,
    bloom: tier === 'rich' && mode !== '2d',
    envMap: tier === 'rich' && mode !== '2d',
    maxLights: tier === 'rich' ? 4 : 2,
    particleCap: tier === 'rich' ? 2000 : tier === 'standard' ? 400 : 60,
    pixelRatioCap,
    animation, physics, audio, assetVariant,
    textureBudgetMB: tier === 'rich' ? 128 : tier === 'standard' ? 48 : 12,
    xrCapable, offlineEligible, reasons,
  };
}

export function mergeTelemetry(header: DeviceSignals, client: DeviceTelemetryInput): DeviceTelemetry {
  return { ...header, ...client };   // zod strips undefined keys, so header values survive gaps
}

export function profileToSceneQuality(p: RenderProfile): SceneQuality {
  return {
    bloom: p.bloom, shadows: p.shadows !== 'off', shadowQuality: p.shadows, envMap: p.envMap,
    maxLights: p.maxLights, particleCap: p.particleCap, pixelRatioCap: p.pixelRatioCap, mode: p.mode,
  };
}

// ---- persistence (best-effort, self-bootstrapping — repo pattern) ----
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
  try {
    await ensureProfileSchema(); const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT profile FROM edu_device_profile WHERE user_id = ${userId} LIMIT 1`))[0];
    return r?.profile && Object.keys(r.profile).length ? (r.profile as RenderProfile) : null;
  } catch { return null; }
}
