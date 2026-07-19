// src/lib/plugins/subjects/physics.ts — Block 09: first-party Physics plugin manifest.
// Formalizes the existing scene-spec.ts PHYSICS_TYPES pack. Generator is deterministic/seedable.
import { z } from 'zod';
import type { SubjectPlugin, AssessmentGenerator } from '../types';
import { rng } from '../types';
import type { Item } from '@/lib/assessment';

const bernoulliQuiz: AssessmentGenerator = (concept, { count, seed = 1 }) => {
  const r = rng(seed);
  const items: Item[] = [];
  for (let i = 0; i < count; i++) {
    const v1 = Math.round(2 + r() * 6), a1 = 4, a2 = 2;   // continuity: A1 v1 = A2 v2
    const v2 = Math.round((a1 * v1) / a2);
    items.push({
      id: `phys-${concept.domain}-${i}`, type: 'numeric', points: 1,
      prompt: `Pipe narrows from area ${a1} to ${a2} cm². Inlet speed ${v1} m/s. Outlet speed (m/s)?`,
      answer: { value: v2, tolerance: 0.5 },
    });
  }
  return items;
};

export const physicsPlugin: SubjectPlugin = {
  id: 'physics', subject: 'Physics', version: '1.0.0', namespace: 'phys',
  conceptDomains: ['physics'],
  objectSubtypes: [
    { kernelType: 'SimulationObject', subtype: 'fluid-flow',
      schema: z.object({ title: z.string().min(1), engine: z.string().optional(), viscosity: z.number().optional() }) },
    { kernelType: 'AnimationObject', subtype: 'bernoulli',
      schema: z.object({ title: z.string().min(1), scene: z.string().optional() }) },
  ],
  renderers: [
    { objectType: 'SimulationObject', hydrate: { rich: ['phys-fluid-sim'] }, scenePack: 'physics' },
    { objectType: 'AnimationObject', hydrate: { standard: ['phys-anim'], rich: ['phys-anim'] }, scenePack: 'physics' },
  ],
  assessmentGenerators: [{ conceptDomain: 'physics', generate: bernoulliQuiz }],
  requiredCapabilities: ['read', 'create', 'write', 'execute'],
  scenePacks: [{ id: 'physics', primitiveTypes: ['projectile', 'pendulum', 'spring'] }],
};
