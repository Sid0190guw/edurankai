// src/lib/plugins/subjects/programming.ts — Block 09: first-party Programming plugin manifest.
// No scene pack (text-first subject); an mcq generator over Big-O basics.
import { z } from 'zod';
import type { SubjectPlugin, AssessmentGenerator } from '../types';
import { rng } from '../types';
import type { Item } from '@/lib/assessment';

const COMPLEXITIES = ['O(1)', 'O(log n)', 'O(n)', 'O(n log n)', 'O(n^2)'];
const QUESTIONS: [string, string][] = [
  ['binary search on a sorted array', 'O(log n)'],
  ['iterating once over n items', 'O(n)'],
  ['a nested loop over n items', 'O(n^2)'],
  ['array index access', 'O(1)'],
  ['comparison-based sorting', 'O(n log n)'],
];

const bigOQuiz: AssessmentGenerator = (concept, { count, seed = 1 }) => {
  const r = rng(seed);
  const items: Item[] = [];
  for (let i = 0; i < count; i++) {
    const [q, correct] = QUESTIONS[Math.floor(r() * QUESTIONS.length)];
    const options = [...COMPLEXITIES];
    const correctIndex = options.indexOf(correct);
    items.push({
      id: `prog-${concept.domain}-${i}`, type: 'mcq', points: 1,
      prompt: `Worst-case time complexity of ${q}?`, options, answer: { correctIndex },
    });
  }
  return items;
};

export const programmingPlugin: SubjectPlugin = {
  id: 'programming', subject: 'Programming', version: '1.0.0', namespace: 'prog',
  conceptDomains: ['programming', 'computer-science'],
  objectSubtypes: [
    { kernelType: 'LaboratoryObject', subtype: 'code-runner',
      schema: z.object({ title: z.string().min(1), kind: z.string().optional(), entryUrl: z.string().nullable().optional() }) },
  ],
  renderers: [
    { objectType: 'LaboratoryObject', hydrate: { standard: ['code-editor'], rich: ['code-editor'] } },
  ],
  assessmentGenerators: [{ conceptDomain: 'programming', generate: bigOQuiz }],
  requiredCapabilities: ['read', 'create', 'execute'],
};
