// src/lib/kernel/validation.ts — Zod schemas for each object type's payload, plus the
// envelope-shape guard. validateObjectData() is invoked at the Created -> Validated step
// (see repository.validateObject); a payload that does not match its type is rejected
// before the object can advance.
import { z } from 'zod';
import { OBJECT_TYPES, LIFECYCLE_STATES, SYNC_STATES, type ObjectType, type RelationshipType } from './types';

const equation = z.object({ latex: z.string().min(1), caption: z.string().optional() });
const example = z.object({ prompt: z.string().min(1), solution: z.string().min(1) });

export const DATA_SCHEMAS = {
  KnowledgeObject: z.object({
    conceptId: z.string().nullable().optional(),
    title: z.string().min(1),
    body: z.string().optional(),
    objectives: z.array(z.string()).optional(),   // Block 02
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

// ==========================================================================
// Block 01 — envelope-level validation (the whole object shell, not just its
// `data` payload). Used when accepting an object over the wire or reading a row
// from an untrusted store; NOT on the hot create/lifecycle path.
// ==========================================================================
export const PERMISSION_SCHEMA = z.object({
  subject: z.string().min(1),                        // an object id OR a role token (see access.ts)
  roles: z.array(z.enum(['read', 'write', 'publish'])),
});

export const LEARNING_METADATA_SCHEMA = z.object({
  difficulty: z.number().min(0).max(1).optional(),
  estimatedMinutes: z.number().nonnegative().optional(),
  languages: z.array(z.string()).optional(),         // BCP-47
  accessibilityVariants: z.array(z.string()).optional(),
}).strict();

/** Validates the whole envelope shape. */
export const ENVELOPE_SCHEMA = z.object({
  id: z.string().uuid(),
  type: z.enum(OBJECT_TYPES),
  version: z.number().int().positive(),
  owner: z.string().uuid().nullable(),
  permissions: z.array(PERMISSION_SCHEMA),
  metadata: z.record(z.unknown()),
  learningMetadata: LEARNING_METADATA_SCHEMA,
  securityLabels: z.array(z.string()),
  synchronizationState: z.enum(SYNC_STATES),
  lifecycleState: z.enum(LIFECYCLE_STATES),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});

/** Throws ValidationError if `env` is not a well-formed envelope. */
export function validateEnvelope(env: unknown): void {
  const res = ENVELOPE_SCHEMA.safeParse(env);
  if (!res.success) {
    throw new ValidationError(
      ((env as { type?: string })?.type as ObjectType) ?? ('KnowledgeObject' as ObjectType),
      res.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
}

/** Thrown when an edge violates the (fromType)-[rel]->(toType) grammar (see types.EDGE_GRAMMAR). */
export class EdgeGrammarError extends Error {
  constructor(public fromType: ObjectType, public rel: RelationshipType, public toType: ObjectType) {
    super(`illegal edge: ${fromType} -[${rel}]-> ${toType} is not permitted by the edge grammar`);
    this.name = 'EdgeGrammarError';
  }
}
