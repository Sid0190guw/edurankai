// src/lib/kernel/validation.ts — Zod schemas for each object type's payload, plus the
// envelope-shape guard. validateObjectData() is invoked at the Created -> Validated step
// (see repository.validateObject); a payload that does not match its type is rejected
// before the object can advance.
import { z } from 'zod';
import { OBJECT_TYPES, type ObjectType } from './types';

const equation = z.object({ latex: z.string().min(1), caption: z.string().optional() });
const example = z.object({ prompt: z.string().min(1), solution: z.string().min(1) });

export const DATA_SCHEMAS = {
  KnowledgeObject: z.object({
    conceptId: z.string().nullable().optional(),
    title: z.string().min(1),
    body: z.string().optional(),
    equations: z.array(equation).optional(),
    examples: z.array(example).optional(),
    industry: z.array(z.string()).optional(),
  }),
  StudentObject: z.object({ displayName: z.string().min(1), userId: z.string().nullable().optional(), cohort: z.string().nullable().optional() }),
  FacultyObject: z.object({ displayName: z.string().min(1), userId: z.string().nullable().optional(), partnerUniversityId: z.string().nullable().optional() }),
  CourseObject: z.object({ title: z.string().min(1), summary: z.string().optional(), trainingCourseId: z.string().nullable().optional() }),
  ConceptObject: z.object({ name: z.string().min(1), description: z.string().optional() }),
  LaboratoryObject: z.object({ title: z.string().min(1), kind: z.string().optional(), entryUrl: z.string().nullable().optional() }),
  SimulationObject: z.object({ title: z.string().min(1), engine: z.string().optional() }),
  AnimationObject: z.object({ title: z.string().min(1), scene: z.string().optional() }),
  AssessmentObject: z.object({ title: z.string().min(1), kind: z.string().optional(), questionCount: z.number().int().nonnegative().optional() }),
  UniversityObject: z.object({ name: z.string().min(1), country: z.string().nullable().optional(), partner: z.boolean().optional() }),
  PlacementObject: z.object({ role: z.string().min(1), org: z.string().optional() }),
  ResearchObject: z.object({ title: z.string().min(1), abstract: z.string().optional(), authors: z.array(z.string()).optional() }),
} satisfies Record<ObjectType, z.ZodTypeAny>;

export class ValidationError extends Error {
  constructor(public type: ObjectType, public issues: string[]) {
    super(`validation failed for ${type}: ${issues.join('; ')}`);
    this.name = 'ValidationError';
  }
}

/** Parse + validate a payload for its type. Throws ValidationError on failure. */
export function validateObjectData(type: ObjectType, data: unknown): unknown {
  if (!(OBJECT_TYPES as readonly string[]).includes(type)) {
    throw new ValidationError(type, [`unknown object type "${type}"`]);
  }
  const schema = DATA_SCHEMAS[type];
  const res = schema.safeParse(data);
  if (!res.success) {
    throw new ValidationError(type, res.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  return res.data;
}
