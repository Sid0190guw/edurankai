// src/lib/scene-examples.ts — the authored teaching scenes (Prompt A3a, quality pass).
// These are real teaching visuals: 49-155 objects each, fully labelled, scientifically checked
// (orbital ratios, bond angles, helix pitch, dipole field-line shape, anti-solar comet tails).
// They live in scene-data.json so the page can serve ONE scene on demand instead of inlining
// ~196 KB of specs into every board render.
import type { SceneSpec } from '@/lib/scene-spec';
import { normalizeScene } from '@/lib/scene-spec';
import RAW_DATA from './scene-data.json';

const RAW: Record<string, any> = RAW_DATA as any;

// Presentation order: familiar first, then the harder physics.
const ORDER = ['solar-system', 'atom', 'water-molecule', 'dna', 'projectile', 'pendulum', 'wave', 'magnetic-field'];
export const SCENE_EXAMPLE_IDS = ORDER.filter((k) => RAW[k]).concat(Object.keys(RAW).filter((k) => !ORDER.includes(k)));

export function exampleScene(id: string): SceneSpec | null { return RAW[id] ? normalizeScene(RAW[id]).spec : null; }

export function exampleList(): { id: string; title: string; subtitle: string; objects: number }[] {
  return SCENE_EXAMPLE_IDS.map((id) => {
    const s = normalizeScene(RAW[id]).spec;
    return { id, title: s.title, subtitle: s.subtitle, objects: s.objects.length };
  });
}
