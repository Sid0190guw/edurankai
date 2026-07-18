// src/lib/render-policy.ts — Adaptive Rendering policy (AES Vol 1). Maps (object type × render
// tier) -> concrete render directives: which interactive enhancements hydrate (empty = pure
// server HTML), image size/format, animation complexity, physics, audio, asset variant. Prompt 4
// decides the TIER (lite|standard|rich); this module turns "same content, different pipeline"
// into real behaviour the views honour. Per-object overrides persist in edu_render_overrides.
import type { RenderTier } from '@/lib/edu-runtime';

export interface RenderDirective {
  hydrate: string[];                                   // named client enhancements to load (lite = [])
  image: { maxWidth: number; format: 'avif' | 'webp' | 'jpeg'; lazy: boolean };
  animation: 'none' | 'basic' | 'full';
  physics: boolean;
  audio: 'none' | 'ondemand' | 'auto';
  assetVariant: 'small' | 'medium' | 'large';
}
export type ObjectRenderType = 'KnowledgeObject' | 'AnimationObject' | 'SimulationObject' | 'LaboratoryObject' | 'default';

// The tier x type matrix. lite = smallest/compressed + zero client JS; rich = full assets +
// the designated interactive enhancement hydrates.
export const RENDER_MATRIX: Record<ObjectRenderType, Record<RenderTier, RenderDirective>> = {
  KnowledgeObject: {
    lite:     { hydrate: [], image: { maxWidth: 320, format: 'webp', lazy: true }, animation: 'none', physics: false, audio: 'none', assetVariant: 'small' },
    standard: { hydrate: [], image: { maxWidth: 720, format: 'webp', lazy: true }, animation: 'basic', physics: false, audio: 'ondemand', assetVariant: 'medium' },
    rich:     { hydrate: ['equation-explorer'], image: { maxWidth: 1280, format: 'avif', lazy: false }, animation: 'full', physics: false, audio: 'auto', assetVariant: 'large' },
  },
  AnimationObject: {
    lite:     { hydrate: [], image: { maxWidth: 320, format: 'webp', lazy: true }, animation: 'none', physics: false, audio: 'none', assetVariant: 'small' },
    standard: { hydrate: ['animation-lite'], image: { maxWidth: 720, format: 'webp', lazy: true }, animation: 'basic', physics: false, audio: 'ondemand', assetVariant: 'medium' },
    rich:     { hydrate: ['animation-player'], image: { maxWidth: 1280, format: 'avif', lazy: false }, animation: 'full', physics: true, audio: 'auto', assetVariant: 'large' },
  },
  SimulationObject: {
    lite:     { hydrate: [], image: { maxWidth: 320, format: 'webp', lazy: true }, animation: 'none', physics: false, audio: 'none', assetVariant: 'small' },
    standard: { hydrate: ['sim-static'], image: { maxWidth: 720, format: 'webp', lazy: true }, animation: 'basic', physics: false, audio: 'none', assetVariant: 'medium' },
    rich:     { hydrate: ['sim-interactive'], image: { maxWidth: 1280, format: 'avif', lazy: false }, animation: 'full', physics: true, audio: 'auto', assetVariant: 'large' },
  },
  LaboratoryObject: {
    lite:     { hydrate: [], image: { maxWidth: 320, format: 'webp', lazy: true }, animation: 'none', physics: false, audio: 'none', assetVariant: 'small' },
    standard: { hydrate: ['lab-guided'], image: { maxWidth: 720, format: 'webp', lazy: true }, animation: 'basic', physics: false, audio: 'ondemand', assetVariant: 'medium' },
    rich:     { hydrate: ['lab-interactive'], image: { maxWidth: 1280, format: 'avif', lazy: false }, animation: 'full', physics: true, audio: 'auto', assetVariant: 'large' },
  },
  default: {
    lite:     { hydrate: [], image: { maxWidth: 320, format: 'webp', lazy: true }, animation: 'none', physics: false, audio: 'none', assetVariant: 'small' },
    standard: { hydrate: [], image: { maxWidth: 720, format: 'webp', lazy: true }, animation: 'basic', physics: false, audio: 'ondemand', assetVariant: 'medium' },
    rich:     { hydrate: [], image: { maxWidth: 1280, format: 'avif', lazy: false }, animation: 'full', physics: false, audio: 'auto', assetVariant: 'large' },
  },
};

/** Resolve the directive for (type, tier), applying an optional per-object override (partial). */
export function resolveDirective(type: string, tier: RenderTier, override?: Partial<RenderDirective> | null): RenderDirective {
  const base = (RENDER_MATRIX as any)[type]?.[tier] || RENDER_MATRIX.default[tier];
  if (!override) return { ...base, image: { ...base.image } };
  return {
    ...base,
    ...override,
    image: { ...base.image, ...(override.image || {}) },
    hydrate: override.hydrate ?? base.hydrate,
  };
}

/** Produce a tier-appropriate asset URL for an existing media URL (width + format hints). */
export function assetVariantUrl(url: string, directive: RenderDirective): string {
  if (!url || /^data:/i.test(url)) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}w=${directive.image.maxWidth}&fmt=${directive.image.format}`;
}

/** Rewrite <img> tags in server-rendered HTML to honour the directive (size, format, lazy). */
export function rewriteMedia(html: string, directive: RenderDirective): string {
  if (!html) return html;
  return html.replace(/<img\b([^>]*?)\ssrc="([^"]+)"([^>]*)>/gi, (_m, pre, src, post) => {
    const url = assetVariantUrl(src, directive);
    const lazy = directive.image.lazy ? ' loading="lazy" decoding="async"' : '';
    return `<img${pre} src="${url}" width="${directive.image.maxWidth}"${lazy}${post}>`;
  });
}

// ---- per-object overrides (additive, self-bootstrapping) ----
const rows = (r: any): any[] => (Array.isArray(r) ? r : (r?.rows || []));
let booted = false;
async function ctx() { const { db } = await import('@/lib/db'); const { sql } = await import('drizzle-orm'); return { db, sql }; }
export async function ensureRenderSchema(): Promise<void> {
  if (booted) return; const { db, sql } = await ctx();
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS edu_render_overrides (object_id UUID PRIMARY KEY, directives JSONB NOT NULL DEFAULT '{}'::jsonb, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`));
  booted = true;
}
export async function getOverride(objectId: string): Promise<Partial<RenderDirective> | null> {
  try { await ensureRenderSchema(); const { db, sql } = await ctx();
    const r = rows(await db.execute(sql`SELECT directives FROM edu_render_overrides WHERE object_id = ${objectId} LIMIT 1`))[0];
    return r?.directives && Object.keys(r.directives).length ? r.directives : null;
  } catch { return null; }
}
export async function setOverride(objectId: string, directives: Partial<RenderDirective>): Promise<void> {
  await ensureRenderSchema(); const { db, sql } = await ctx();
  await db.execute(sql`INSERT INTO edu_render_overrides (object_id, directives) VALUES (${objectId}, ${JSON.stringify(directives)}::jsonb)
    ON CONFLICT (object_id) DO UPDATE SET directives = ${JSON.stringify(directives)}::jsonb, updated_at = NOW()`);
}
export async function clearOverride(objectId: string): Promise<void> {
  await ensureRenderSchema(); const { db, sql } = await ctx();
  await db.execute(sql`DELETE FROM edu_render_overrides WHERE object_id = ${objectId}`);
}
