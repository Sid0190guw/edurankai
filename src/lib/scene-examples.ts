// src/lib/scene-examples.ts — a few AUTHORED scene specs (Prompt A3a) that prove the engine renders
// real teaching visuals, plus the A1 templates re-expressed as scene specs (so the new engine
// subsumes the old ones). These are hand-authored here; the LLM composing specs from speech is A3b.
import type { SceneSpec } from '@/lib/scene-spec';
import { normalizeScene } from '@/lib/scene-spec';

const RAW: Record<string, any> = {
  'solar-system': {
    title: 'Solar system', subtitle: 'Orbits + scale', palette: 'space',
    objects: [
      { id: 'sun', type: 'sphere', position: [0, 1, 0], size: 1.8, color: '#ffcc55', material: { emissive: 1.2, roughness: 0.4, metalness: 0 }, motion: { type: 'spin', speed: 0.3 } },
      { id: 'mercury', type: 'sphere', position: [3.2, 1, 0], size: 0.28, color: '#b7a08a', orbitCenter: [0, 1, 0], motion: { type: 'orbit', speed: 0.9 } },
      { id: 'earth', type: 'sphere', position: [5, 1, 0], size: 0.5, color: '#5c9dff', orbitCenter: [0, 1, 0], motion: { type: 'orbit', speed: 0.55 } },
      { id: 'mars', type: 'sphere', position: [6.8, 1, 0], size: 0.42, color: '#d1573a', orbitCenter: [0, 1, 0], motion: { type: 'orbit', speed: 0.4 } },
      { id: 'label-sun', type: 'label', position: [0, 3.4, 0], text: 'Sun', color: '#ffe1a3' },
    ],
    camera: { autoRotate: true, distance: 16, target: [0, 1, 0] },
  },
  'atom': {
    title: 'Carbon atom', subtitle: 'Nucleus + electron shells', palette: 'studio',
    objects: [
      { id: 'nucleus', type: 'sphere', position: [0, 1, 0], size: 0.8, color: '#d1573a', material: { emissive: 0.5, metalness: 0.2, roughness: 0.4 }, motion: { type: 'pulse', speed: 2 } },
      { id: 'e1', type: 'sphere', position: [2.4, 1, 0], size: 0.22, color: '#5c9dff', orbitCenter: [0, 1, 0], motion: { type: 'orbit', speed: 1.6 } },
      { id: 'e2', type: 'sphere', position: [-2.4, 1, 0], size: 0.22, color: '#5c9dff', orbitCenter: [0, 1, 0], motion: { type: 'orbit', speed: 1.6, params: {} } },
      { id: 'e3', type: 'sphere', position: [0, 1, 3], size: 0.22, color: '#7db1ff', orbitCenter: [0, 1, 0], motion: { type: 'orbit', speed: 1.2 } },
    ],
    camera: { autoRotate: true, distance: 12, target: [0, 1, 0] },
  },
  // A1 template 'projectile' re-expressed as a scene spec (physics pack)
  'projectile': {
    title: 'Projectile motion', subtitle: 'v0 = 22 m/s, 50 degrees', palette: 'studio',
    objects: [
      { id: 'ball', type: 'projectile', position: [0, 0, 0], size: 0.5, color: '#ffcc55', material: { emissive: 0.4, metalness: 0.1, roughness: 0.5 }, motion: { type: 'flow', speed: 1, params: { angle: 50, v0: 22, gravity: 9.8 } } },
      { id: 'ground', type: 'plane', position: [4, -0.05, 0], size: [8, 4, 1], color: '#2f7d5b', material: { roughness: 0.9, metalness: 0 } },
      { id: 'origin', type: 'label', position: [0, -0.6, 0], text: 'launch', color: '#8a8378' },
    ],
    camera: { autoRotate: false, distance: 18, target: [6, 3, 0] },
  },
  // A1 template 'sine' re-expressed: a sampled curve + a body riding it
  'sine-wave': {
    title: 'Sine wave', subtitle: 'y = A sin(x)', palette: 'studio',
    objects: [
      { id: 'curve', type: 'line', color: '#5c9dff', points: Array.from({ length: 60 }, (_, i) => { const x = (i / 59) * 12 - 6; return [x, 2 * Math.sin(x), 0]; }) },
      { id: 'marker', type: 'sphere', position: [-6, 0, 0], size: 0.35, color: '#d1573a', material: { emissive: 0.5 }, motion: { type: 'oscillate', speed: 1.5, params: { amplitude: 2 } } },
    ],
    camera: { autoRotate: false, distance: 16, target: [0, 0, 0] },
  },
  'pendulum': {
    title: 'Simple pendulum', subtitle: 'theta = A cos(sqrt(g/L) t)', palette: 'studio',
    objects: [
      { id: 'pivot', type: 'sphere', position: [0, 5, 0], size: 0.2, color: '#8a8378' },
      { id: 'bob', type: 'pendulum', position: [0, 1, 0], size: 0.6, color: '#7db1ff', material: { metalness: 0.6, roughness: 0.25 }, motion: { type: 'flow', speed: 1, params: { length: 4, gravity: 9.8, amplitude: 0.6 } } },
    ],
    camera: { autoRotate: false, distance: 14, target: [0, 3, 0] },
  },
};

export const SCENE_EXAMPLE_IDS = Object.keys(RAW);
export function exampleScene(id: string): SceneSpec | null { return RAW[id] ? normalizeScene(RAW[id]).spec : null; }
export function exampleList(): { id: string; title: string; subtitle: string; objects: number }[] {
  return SCENE_EXAMPLE_IDS.map((id) => { const s = normalizeScene(RAW[id]).spec; return { id, title: s.title, subtitle: s.subtitle, objects: s.objects.length }; });
}
