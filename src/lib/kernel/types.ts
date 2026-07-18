// src/lib/kernel/types.ts — AquinTutor Educational Operating Kernel: the uniform object
// model. Per the spec, everything in AquinTutor is an OBJECT (not a page/PDF/video):
// one shared envelope, per-type payloads, typed relationship edges, and a lifecycle every
// object obeys. This file is the type layer only — pure, no I/O.

// ---- the twelve object types ----
export const OBJECT_TYPES = [
  'KnowledgeObject', 'StudentObject', 'FacultyObject', 'CourseObject', 'ConceptObject',
  'LaboratoryObject', 'SimulationObject', 'AnimationObject', 'AssessmentObject',
  'UniversityObject', 'PlacementObject', 'ResearchObject',
] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];

// ---- lifecycle states (exact order enforced in lifecycle.ts) ----
export const LIFECYCLE_STATES = [
  'created', 'validated', 'indexed', 'published', 'referenced', 'updated', 'archived', 'deleted',
] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export const SYNC_STATES = ['synced', 'dirty', 'pending', 'conflict'] as const;
export type SynchronizationState = (typeof SYNC_STATES)[number];

// ---- typed relationship edges between objects ----
export const RELATIONSHIP_TYPES = [
  'prerequisite_of', 'part_of', 'assesses', 'references', 'translation_of', 'variant_of',
] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

export type PermissionRole = 'read' | 'write' | 'publish';
export interface Permission {
  subject: string;               // an object id (Student/Faculty/University) or role token
  roles: PermissionRole[];
}

export type SecurityLabel = 'public' | 'enrolled-only' | 'exam-secure' | (string & {});

export interface LearningMetadata {
  difficulty?: number;                 // 0..1 or a scale the caller chooses
  estimatedMinutes?: number;
  languages?: string[];                // BCP-47 tags
  accessibilityVariants?: string[];    // e.g. 'audio', 'high-contrast', 'text-only'
}

// ---- the base envelope every object carries ----
export interface KernelEnvelope {
  id: string;                          // UUID
  type: ObjectType;
  version: number;                     // ++ on update
  owner: string | null;               // id of a Student/Faculty/University object
  permissions: Permission[];
  metadata: Record<string, unknown>;
  learningMetadata: LearningMetadata;
  securityLabels: SecurityLabel[];
  synchronizationState: SynchronizationState;
  lifecycleState: LifecycleState;
  createdAt: string;                   // ISO
  updatedAt: string;                   // ISO
  archivedAt: string | null;
}

// A stored/returned object = envelope + its type-specific payload.
export interface KernelObject<D = Record<string, unknown>> extends KernelEnvelope {
  data: D;
}

// A relationship edge (persisted in a separate edges table).
export interface RelationshipEdge {
  id: string;
  fromId: string;
  toId: string;
  type: RelationshipType;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

// ==========================================================================
// Per-type payloads (the `data` of each object type). Kept intentionally
// light here; later prompts (adapters/AI/rendering) extend these.
// ==========================================================================
export interface StudentObjectData { displayName: string; userId?: string | null; cohort?: string | null; }
export interface FacultyObjectData { displayName: string; userId?: string | null; partnerUniversityId?: string | null; }
export interface UniversityObjectData { name: string; country?: string | null; partner?: boolean; }
export interface CourseObjectData { title: string; summary?: string; trainingCourseId?: string | null; }  // maps to training_courses via adapter
export interface ConceptObjectData { name: string; description?: string; }
export interface LaboratoryObjectData { title: string; kind?: string; entryUrl?: string | null; }
export interface SimulationObjectData { title: string; engine?: string; }
export interface AnimationObjectData { title: string; scene?: string; }
export interface AssessmentObjectData { title: string; kind?: 'quiz' | 'exam' | 'olympiad' | string; questionCount?: number; }
export interface PlacementObjectData { role: string; org?: string; }
export interface ResearchObjectData { title: string; abstract?: string; authors?: string[]; }

// A KnowledgeObject is the unit of TEACHING (it replaces "a video/page"). Inline scholarly
// content lives in `data`; links to other objects (prerequisites, animations, labs,
// research, assessments, translations, accessibility variants) are RELATIONSHIP EDGES.
export interface Equation { latex: string; caption?: string; }
export interface WorkedExample { prompt: string; solution: string; }
export interface KnowledgeObjectData {
  conceptId?: string | null;           // -> a ConceptObject (also mirrored as a `part_of`/`references` edge)
  title: string;
  body?: string;                       // the teaching content
  equations?: Equation[];              // inline
  examples?: WorkedExample[];          // inline
  industry?: string[];                 // inline real-world links
}

// Map each ObjectType to its payload type (for typed create()).
export interface ObjectDataMap {
  KnowledgeObject: KnowledgeObjectData;
  StudentObject: StudentObjectData;
  FacultyObject: FacultyObjectData;
  CourseObject: CourseObjectData;
  ConceptObject: ConceptObjectData;
  LaboratoryObject: LaboratoryObjectData;
  SimulationObject: SimulationObjectData;
  AnimationObject: AnimationObjectData;
  AssessmentObject: AssessmentObjectData;
  UniversityObject: UniversityObjectData;
  PlacementObject: PlacementObjectData;
  ResearchObject: ResearchObjectData;
}

export function isObjectType(v: unknown): v is ObjectType {
  return typeof v === 'string' && (OBJECT_TYPES as readonly string[]).includes(v);
}
