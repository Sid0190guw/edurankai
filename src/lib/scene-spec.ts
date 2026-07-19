// src/lib/scene-spec.ts — the canonical, versioned SCENE SPEC (Prompt A3a). A declarative JSON scene
// the WebGL engine (public/aquin-scene-engine.js) renders at any Prompt-5 tier, and that A3b's LLM
// will COMPOSE next prompt. Every spec is validated + REPAIRED (out-of-range clamped, unknown types
// coerced, object count capped) so a bad/hallucinated spec can never crash a render. A spec persists
// as a kernel AnimationObject linkable to a KnowledgeObject (AES Vol 1), exactly like A1 instances.
import { z } from 'zod';
import { KernelRepository, createPgKernel } from '@/lib/kernel';

export const SCENE_VERSION = 1;
export const MAX_OBJECTS = 200;

// primitive library (base) + one domain pack (physics) — mirrors the engine's builder registry
export const BASE_TYPES = ['sphere', 'box', 'cylinder', 'cone', 'torus', 'ring', 'plane', 'line', 'arrow', 'particles', 'label'] as const;
export const PHYSICS_TYPES = ['projectile', 'pendulum', 'spring'] as const;
export const OBJECT_TYPES = [...BASE_TYPES, ...PHYSICS_TYPES] as const;
export const MOTION_TYPES = ['none', 'spin', 'orbit', 'oscillate', 'float', 'pulse', 'grow', 'flow', 'fall'] as const;

export type Vec3 = [number, number, number];
export interface Material { metalness: number; roughness: number; emissive: number; opacity: number }
export interface Motion { type: string; axis: Vec3; speed: number; params: Record<string, number> }
export interface SceneObject {
  id: string; type: string; position: Vec3; rotation: Vec3; size: number | Vec3; color: string;
  material: Material; motion: Motion; orbitCenter?: Vec3; points?: Vec3[]; parent?: string; text?: string; count?: number;
}
export interface Camera { autoRotate: boolean; distance: number; target: Vec3 }
export interface SceneSpec { version: number; title: string; subtitle: string; notes: string; palette: string; objects: SceneObject[]; camera: Camera; timeline?: any }

// ---- zod schema of record (the shape a valid spec MUST have after repair) ----
const Vec3Z = z.tuple([z.number(), z.number(), z.number()]);
const SceneSpecZ = z.object({
  version: z.number(), title: z.string(), subtitle: z.string(), notes: z.string(), palette: z.string(),
  objects: z.array(z.object({
    id: z.string(), type: z.enum(OBJECT_TYPES), position: Vec3Z, rotation: Vec3Z,
    size: z.union([z.number(), Vec3Z]), color: z.string(),
    material: z.object({ metalness: z.number(), roughness: z.number(), emissive: z.number(), opacity: z.number() }),
    motion: z.object({ type: z.enum(MOTION_TYPES), axis: Vec3Z, speed: z.number(), params: z.record(z.number()) }),
    orbitCenter: Vec3Z.optional(), points: z.array(Vec3Z).optional(), parent: z.string().optional(), text: z.string().optional(), count: z.number().optional(),
  })),
  camera: z.object({ autoRotate: z.boolean(), distance: z.number(), target: Vec3Z }),
  timeline: z.any().optional(),
});

// ---- repair helpers (clamp instead of throw; collect what changed for the inspector) ----
const num = (v: any, min: number, max: number, def: number): number => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
const str = (v: any, def: string): string => (typeof v === 'string' && v.length ? v.slice(0, 400) : def);
const vec3 = (v: any, def: Vec3 = [0, 0, 0]): Vec3 => Array.isArray(v) ? [num(v[0], -1e4, 1e4, def[0]), num(v[1], -1e4, 1e4, def[1]), num(v[2], -1e4, 1e4, def[2])] : def;
const hex = (v: any, def: string): string => (typeof v === 'string' && /^#?[0-9a-fA-F]{3,8}$/.test(v.trim())) ? (v.trim()[0] === '#' ? v.trim() : '#' + v.trim()) : def;

function normObject(o: any, i: number, issues: string[]): SceneObject {
  const src = o && typeof o === 'object' ? o : {};
  let type = String(src.type || 'box').toLowerCase();
  if (!(OBJECT_TYPES as readonly string[]).includes(type)) { issues.push(`object ${i}: unknown type "${type}" -> box`); type = 'box'; }
  let motionType = String(src.motion?.type || 'none').toLowerCase();
  if (!(MOTION_TYPES as readonly string[]).includes(motionType)) { issues.push(`object ${i}: unknown motion "${motionType}" -> none`); motionType = 'none'; }
  const sizeIn = src.size;
  const size: number | Vec3 = Array.isArray(sizeIn) ? vec3(sizeIn, [1, 1, 1]) : num(sizeIn, 0.01, 1000, 1);
  const obj: SceneObject = {
    id: str(src.id, 'o' + i), type, position: vec3(src.position), rotation: vec3(src.rotation),
    size, color: hex(src.color, '#7db1ff'),
    material: {
      metalness: num(src.material?.metalness, 0, 1, 0.1), roughness: num(src.material?.roughness, 0, 1, 0.6),
      emissive: num(src.material?.emissive, 0, 5, 0), opacity: num(src.material?.opacity, 0, 1, 1),
    },
    motion: { type: motionType, axis: vec3(src.motion?.axis, [0, 1, 0]), speed: num(src.motion?.speed, -20, 20, 1), params: normParams(src.motion?.params) },
  };
  if (src.orbitCenter != null) obj.orbitCenter = vec3(src.orbitCenter);
  if (Array.isArray(src.points)) obj.points = src.points.slice(0, 512).map((p: any) => vec3(p));
  if (src.parent != null) obj.parent = str(src.parent, '');
  if (src.text != null) obj.text = str(src.text, '');
  if (src.count != null) obj.count = Math.round(num(src.count, 1, 2000, 100));
  return obj;
}
function normParams(p: any): Record<string, number> { const out: Record<string, number> = {}; if (p && typeof p === 'object') for (const k of Object.keys(p).slice(0, 24)) { const n = Number(p[k]); if (Number.isFinite(n)) out[k] = n; } return out; }
function normCamera(c: any): Camera { return { autoRotate: c?.autoRotate !== false, distance: num(c?.distance, 1, 500, 12), target: vec3(c?.target) }; }

/** Validate + REPAIR any input into a guaranteed-valid SceneSpec. Never throws. */
export function normalizeScene(input: any): { spec: SceneSpec; issues: string[] } {
  const issues: string[] = [];
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : (issues.push('spec was not an object; used a blank scene'), {} as any);
  const objsIn = Array.isArray(src.objects) ? src.objects : (src.objects != null ? (issues.push('objects was not an array; dropped'), []) : []);
  if (objsIn.length > MAX_OBJECTS) issues.push(`object count ${objsIn.length} exceeded cap; kept first ${MAX_OBJECTS}`);
  const objects = objsIn.slice(0, MAX_OBJECTS).map((o: any, i: number) => normObject(o, i, issues));
  const spec: SceneSpec = {
    version: SCENE_VERSION, title: str(src.title, 'Untitled scene'), subtitle: str(src.subtitle, ''), notes: str(src.notes, ''),
    palette: str(src.palette, 'studio'), objects, camera: normCamera(src.camera),
  };
  if (src.timeline && typeof src.timeline === 'object') spec.timeline = src.timeline;
  return { spec: SceneSpecZ.parse(spec) as SceneSpec, issues };   // parse guarantees the shape post-repair
}

/** A minimal valid scene. */
export function blankScene(title = 'Untitled scene'): SceneSpec { return normalizeScene({ title }).spec; }

// ---- persistence: a spec is a kernel AnimationObject, optionally linked to a KnowledgeObject ----
export class SceneService {
  constructor(private repo: KernelRepository = createPgKernel()) {}
  async saveScene(spec: SceneSpec, koId: string | null, owner: string | null): Promise<string> {
    const { spec: norm } = normalizeScene(spec);
    const o = await this.repo.createObject({ type: 'AnimationObject', data: { title: norm.title || 'Scene', scene: JSON.stringify(norm).slice(0, 60000) } as any, owner: owner ?? null, metadata: { sceneSpec: true, version: norm.version, objectCount: norm.objects.length } });
    const id = (o as any).id;
    if (koId) await this.repo.addRelationship(koId, 'references', id).catch(() => {});   // KO -references-> scene
    return id;
  }
  async listScenes(): Promise<any[]> { return (await this.repo.listByType('AnimationObject').catch(() => [])).filter((o: any) => (o.metadata as any)?.sceneSpec); }
  async getScene(id: string): Promise<SceneSpec | null> { const o = await this.repo.getObject(id); if (!o) return null; try { return normalizeScene(JSON.parse((o.data as any).scene)).spec; } catch { return null; } }
}
let _svc: SceneService | null = null;
export function sceneService(): SceneService { if (!_svc) _svc = new SceneService(createPgKernel()); return _svc; }
