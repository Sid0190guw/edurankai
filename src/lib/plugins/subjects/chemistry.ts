// src/lib/plugins/subjects/chemistry.ts — Block 09: first-party Chemistry plugin manifest.
import { z } from 'zod';
import type { SubjectPlugin, AssessmentGenerator } from '../types';
import { rng } from '../types';
import type { Item } from '@/lib/assessment';

const ELEMENTS: [string, number][] = [['H', 1], ['He', 2], ['C', 6], ['N', 7], ['O', 8], ['Na', 11], ['Cl', 17], ['Fe', 26]];

const atomicNumberQuiz: AssessmentGenerator = (concept, { count, seed = 1 }) => {
  const r = rng(seed);
  const items: Item[] = [];
  for (let i = 0; i < count; i++) {
    const [sym, z] = ELEMENTS[Math.floor(r() * ELEMENTS.length)];
    const options = [z, z + 1, z - 1, z + 2].map(String);
    // deterministic shuffle by seed so the correct index varies but is reproducible
    const correctIndex = Math.floor(r() * 4);
    [options[0], options[correctIndex]] = [options[correctIndex], options[0]];
    items.push({
      id: `chem-${concept.domain}-${i}`, type: 'mcq', points: 1,
      prompt: `What is the atomic number of ${sym}?`, options, answer: { correctIndex },
    });
  }
  return items;
};

export const chemistryPlugin: SubjectPlugin = {
  id: 'chemistry', subject: 'Chemistry', version: '1.0.0', namespace: 'chem',
  conceptDomains: ['chemistry'],
  objectSubtypes: [
    { kernelType: 'SimulationObject', subtype: 'reaction',
      schema: z.object({ title: z.string().min(1), engine: z.string().optional() }) },
  ],
  renderers: [
    { objectType: 'SimulationObject', hydrate: { rich: ['chem-reaction'] }, scenePack: 'chemistry' },
  ],
  assessmentGenerators: [{ conceptDomain: 'chemistry', generate: atomicNumberQuiz }],
  requiredCapabilities: ['read', 'create', 'execute'],
  scenePacks: [{ id: 'chemistry', primitiveTypes: ['atom', 'bond', 'beaker'] }],
};
